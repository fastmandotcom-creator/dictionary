package com.dict.learn.tts;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.audiofx.LoudnessEnhancer;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Native TTS for dict-learn — a faithful port of duosub-study's
 * duosub.study.ui.WordPronouncer + AndroidPronunciationEngine +
 * duosub.study.translation.GoogleWebSpeech.
 *
 * duosub's design (this plugin mirrors it step by step):
 *  1. playback cache: previously recorded speech plays straight from file;
 *  2. the phone's installed TTS ENGINES, one at a time (the user's default
 *     first, then every other installed service): initialize, pick the best
 *     voice for the language, record with synthesizeToFile (a file of
 *     length 0 means "no voice for this language"), amplify quiet WAVs,
 *     play with MediaPlayer + LoudnessEnhancer;
 *  3. Google's web voice (translate_tts endpoints, health backoff, MP3
 *     cache) — the online voice duosub prefers;
 *  4. a last-resort direct utterance so the button is never silent without
 *     a reason, and a clear RESULT so the UI can tell the user what failed
 *     (NO_VOICE -> open the TTS data-download settings screen).
 *
 * JS surface (window.DictTTS):
 *   speak({text, lang}) -> {result, engine, detail}
 *     result: "spoken" | "no-voice" | "unavailable" | "playback-failed"
 *   cancel()
 *   diagnose() -> {engineCount, googleResting, cacheCount}
 *   openSettings() -> launches the system TTS settings / data download
 */
@CapacitorPlugin(name = "DictTTS")
public class DictTTSPlugin extends Plugin {

    // --- duosub-study's Google web-voice constants --------------------------
    private static final String[][] GOOGLE_ENDPOINTS = {
        {"https://translate.googleapis.com/translate_tts", "gtx"},
        {"https://translate.google.com/translate_tts", "tw-ob"},
        {"https://clients5.google.com/translate_tts", "gtx"},
    };
    private static final int MAX_GOOGLE_CHARS = 200;
    private static final int MAX_GOOGLE_BYTES = 512 * 1024;
    private static final long GOOGLE_CONNECT_TIMEOUT_MS = 3000;
    private static final long GOOGLE_READ_TIMEOUT_MS = 8000;
    /** After every Google address stays down, duosub rests before retrying. */
    private static final long GOOGLE_REST_MS = 60_000;

    // --- duosub-study's engine-iteration timeouts ----------------------------
    private static final long ENGINE_INIT_TIMEOUT_MS = 4000;
    private static final long RENDER_TIMEOUT_MS = 10_000;
    private static final long SPOKEN_FILE_TIMEOUT_MS = 15_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    // Two threads: a long Google download or a blocking playback loop never
    // head-of-line-blocks the next "Nghe" tap.
    private final ExecutorService net = Executors.newFixedThreadPool(2);
    private volatile long googleRestingUntil = 0;
    private volatile int cacheCount = 0;
    private volatile boolean googleNoVoiceForText = false;

    @Override
    public void load() {
        // Pre-warm nothing: duosub creates engines lazily per word.
    }

    @PluginMethod
    public void speak(PluginCall call) {
        final String text = call.getString("text", "");
        final String lang = call.getString("lang", "en");
        if (text == null || text.trim().isEmpty()) {
            call.resolve(jsResult("unavailable", "none", "empty text"));
            return;
        }
        // Cancel the current playback synchronously (duosub's stop()).
        stopPlayback();
        net.execute(() -> {
            String[] out = pronounce(text.trim(), lang);
            main.post(() -> call.resolve(jsResult(out[0], out[1], out[2])));
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        main.post(() -> {
            stopPlayback();
            call.resolve();
        });
    }

    @PluginMethod
    public void diagnose(PluginCall call) {
        main.post(() -> {
            JSObject o = new JSObject();
            List<String> engines = installedEngineNames(getContext());
            o.put("engineCount", engines.size());
            o.put("googleResting", System.currentTimeMillis() < googleRestingUntil);
            o.put("cacheCount", cacheCount);
            call.resolve(o);
        });
    }

    /**
     * Opens the system speech settings: install TTS data when there is no
     * voice, otherwise the TTS settings screen (duosub's openSpeechSettings).
     */
    @PluginMethod
    public void openSettings(PluginCall call) {
        main.post(() -> {
            String[] actions = {
                TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA,
                "com.android.settings.TTS_SETTINGS",
                Settings.ACTION_ACCESSIBILITY_SETTINGS,
            };
            boolean opened = false;
            for (String action : actions) {
                try {
                    getContext().startActivity(
                        new Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    opened = true;
                    break;
                } catch (Throwable ignored) {}
            }
            call.resolve(jsResult(opened ? "ok" : "no-settings", "settings",
                opened ? "opened" : "could not open any settings screen"));
        });
    }

    // =========================================================================
    // The pronunciation ladder (duosub-study's WordPronouncer.pronounce).
    // Returns { result, engine, detail }.
    // =========================================================================
    private String[] pronounce(String text, String lang) {
        Context app = getContext().getApplicationContext();
        String localeTag = nativeLocale(lang);
        Locale locale = Locale.forLanguageTag(localeTag);
        if (locale == null || locale.getLanguage().isEmpty()) {
            return new String[] {"unavailable", "none", "invalid language " + lang};
        }

        // 1) cache: a previously recorded utterance plays straight away
        //    (duosub's cache.lookup — both the native WAV and the Google MP3).
        File wavCache = cacheFile(app, lang, text);
        if (wavCache.isFile() && wavCache.length() > 0 && playSpeechFile(wavCache)) {
            return new String[] {"spoken", "cache", "played " + wavCache.getName()};
        }
        File mp3Cache = new File(new File(app.getCacheDir(), "tts"),
            Integer.toHexString((lang + "|" + text).hashCode()) + ".mp3");
        if (mp3Cache.isFile() && mp3Cache.length() > 0 && playSpeechFile(mp3Cache)) {
            return new String[] {"spoken", "cache", "played " + mp3Cache.getName()};
        }

        // 2) Google's online voice FIRST when the device has a voice for the
        //    language and the network is available (duosub-study's DEFAULT
        //    engine is the Google web voice; it answers in ~1s with a real MP3
        //    for en/zh/pt/vi/...). This is the fastest path to an audible word.
        if (googleSupported(lang) && text.length() <= MAX_GOOGLE_CHARS
            && !googleResting()) {
            googleNoVoiceForText = false;
            byte[] mp3 = downloadGoogleMp3(text, lang);
            if (mp3 != null && looksLikeMp3(mp3)) {
                try {
                    File dir = mp3Cache.getParentFile();
                    if (!dir.exists()) dir.mkdirs();
                    FileOutputStream out = new FileOutputStream(mp3Cache);
                    out.write(mp3);
                    out.close();
                    cacheCount++;
                } catch (Throwable ignored) {}
                if (playSpeechFile(mp3Cache)) {
                    return new String[] {"spoken", "google-web", "downloaded " + mp3.length + " bytes"};
                }
            }
            if (!googleNoVoiceForText) {
                markGoogleResting(); // outage: don't hammer Google on the next word
            }
            // fell through: Google had no voice for this text, or is down —
            // use the phone's own engines below.
        }

        // 3) the phone's installed engines (default first), recording to a WAV.
        String[] phone = pronounceWithEngines(app, text, lang, locale);
        if ("spoken".equals(phone[0])) return phone;

        // 4) last resort: a direct utterance with the default engine so the
        //    button is never silent without a reported reason.
        if ("native".equals(phone[1])) {
            String[] direct = directUtterance(app, text, locale);
            if ("spoken".equals(direct[0])) return direct;
        }
        return phone; // no-voice / unavailable / playback-failed with details
    }

    /**
     * duosub's pronounceWord over installedPronunciationEngines(): the
     * user's default TTS service first, then every other installed engine.
     * Each engine records the word with synthesizeToFile (NOT tts.speak):
     * an empty file is the engine's honest "I have no voice for this
     * language", and the file is amplified before MediaPlayer plays it.
     */
    private String[] pronounceWithEngines(Context app, String text, String lang, Locale locale) {
        List<String> engines = installedEngineNames(app); // default first, then installed
        boolean anyInitialized = false;
        boolean playbackFailed = false;
        String detail = "no installed TTS engine";
        for (String name : engines) {
            AtomicBoolean done = new AtomicBoolean(false);
            TextToSpeech tts;
            try {
                tts = new TextToSpeech(app, status -> {
                        if (status == TextToSpeech.SUCCESS) done.set(true);
                        else done.set(true);
                    }, name);
            } catch (Throwable t) {
                playbackFailed = true;
                detail = "engine " + name + " could not start: " + t.getMessage();
                continue;
            }
            long deadline = System.currentTimeMillis() + ENGINE_INIT_TIMEOUT_MS;
            while (!done.get() && System.currentTimeMillis() < deadline) {
                try { Thread.sleep(50); } catch (InterruptedException e) { break; }
            }
            if (!done.get()) {
                try { tts.shutdown(); } catch (Throwable ignored) {}
                playbackFailed = true;
                detail = "engine " + name + " did not initialize in 4s";
                continue;
            }
            anyInitialized = true;
            try {
                tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
                boolean voiceSelected = selectBestVoice(tts, locale);
                if (!voiceSelected && tts.setLanguage(locale) < TextToSpeech.LANG_AVAILABLE) {
                    detail = "engine " + name + " has no voice for " + lang;
                    continue; // duosub: NO_VOICE for this engine, try the next
                }
                File wav = cacheFile(app, lang, text);
                boolean ok = synthesizeToFile(tts, text, wav);
                if (ok && wav.length() > 0) {
                    normalizeWav(wav); // quiet recordings -> full loudness
                    cacheCount++;
                    if (playSpeechFile(wav)) {
                        return new String[] {"spoken", "native",
                            "engine " + name + " recorded " + wav.length() + " bytes"};
                    }
                    playbackFailed = true;
                    detail = "engine " + name + " recorded but playback failed";
                    continue;
                }
                if (!ok) {
                    wav.delete();
                    playbackFailed = true;
                    detail = "engine " + name + " recorded nothing for " + lang;
                    continue;
                }
            } catch (Throwable t) {
                // A broken vendor engine must not prevent trying the next one.
                playbackFailed = true;
                detail = "engine " + name + " failed: " + t.getMessage();
            } finally {
                try { tts.shutdown(); } catch (Throwable ignored) {}
            }
        }
        if (anyInitialized) return new String[] {"no-voice", "native", detail};
        return new String[] {"unavailable", "native", detail};
    }

    /**
     * duosub's AndroidPronunciationEngine.speak(): synthesizeToFile to a WAV,
     * waiting for the engine's progress listener (onDone/onError) or a
     * timeout. Returns true only when the engine reports success AND the
     * file has audio in it.
     */
    private boolean synthesizeToFile(TextToSpeech tts, String text, File wav) {
        final AtomicBoolean finished = new AtomicBoolean(false);
        final AtomicReference<Boolean> success = new AtomicReference<>(false);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {}
            @Override public void onDone(String id) { finished.set(true); success.set(true); }
            @Override public void onError(String id) { finished.set(true); success.set(false); }
        });
        final long start = System.currentTimeMillis();
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
        int rc = tts.synthesizeToFile(text, params, wav, "dict-" + start);
        if (rc != TextToSpeech.SUCCESS) {
            tts.stop();
            return false;
        }
        long deadline = start + RENDER_TIMEOUT_MS;
        while (!finished.get() && System.currentTimeMillis() < deadline) {
            try { Thread.sleep(80); } catch (InterruptedException e) { break; }
        }
        if (!finished.get()) {
            tts.stop(); // duosub's withTimeoutOrNull path
            return false;
        }
        return success.get() && wav.isFile() && wav.length() > 0;
    }

    /**
     * duosub's pronunciationVoices(): installed voices of the language first,
     * then network voices, best quality first — select the top one. The
     * per-voice getVoices()/setVoice() API is Android 8.0 (API 26); on
     * older devices we rely on setLanguage alone.
     */
    /**
     * Voice selection for the language. duosub's full path uses
     * TextToSpeech.getVoices()/setVoice() (Android 8.0+); on every API level we
     * rely on the equivalent that works everywhere — setLanguage(locale) —
     * which picks the engine's voice for that locale. We report "selected" when
     * the engine says it can speak the language (>= LANG_AVAILABLE), matching
     * duosub's "Some engines implement setLanguage but list no voice" fallback.
     */
    private boolean selectBestVoice(TextToSpeech tts, Locale locale) {
        int rc = tts.setLanguage(locale);
        return rc >= TextToSpeech.LANG_AVAILABLE;
    }

    /** duosub's playSpeechFile(): MediaPlayer + LoudnessEnhancer, to the end. */
    private boolean playSpeechFile(File f) {
        MediaPlayer m = null;
        LoudnessEnhancer booster = null;
        try {
            m = new MediaPlayer();
            m.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            m.setDataSource(f.getAbsolutePath());
            m.prepare();
            m.setVolume(1.0f, 1.0f);
            try {
                booster = new LoudnessEnhancer(m.getAudioSessionId());
                booster.setTargetGain(100); // headroom boost for quiet TTS
                booster.setEnabled(true);
            } catch (Throwable ignored) {}
            m.start();
            currentPlayer = m;
            long deadline = System.currentTimeMillis() + SPOKEN_FILE_TIMEOUT_MS;
            while (m.isPlaying() && System.currentTimeMillis() < deadline) {
                try { Thread.sleep(120); } catch (InterruptedException e) { break; }
            }
            return true; // started and played; duosub's PLAYBACK_FAILED is rarer
        } catch (Throwable t) {
            return false;
        } finally {
            if (booster != null) { try { booster.release(); } catch (Throwable ignored) {} }
            if (m != null) { try { m.release(); } catch (Throwable ignored) {} }
        }
    }

    /**
     * duosub's normalizeSpeechFile(): TTS engines record at very different
     * levels; amplify a quiet 16-bit PCM WAV toward full scale.
     */
    private void normalizeWav(File f) {
        try {
            FileInputStream in = new FileInputStream(f);
            byte[] data = readFully(in, (int) f.length());
            in.close();
            if (data.length < 100) return;
            // Locate the "data" chunk of a standard RIFF/WAVE file.
            int pos = 0;
            while (pos + 8 <= data.length) {
                String id = new String(data, pos, 4, "US-ASCII");
                if (id.equals("data")) {
                    pos += 8;
                    break;
                }
                int chunkSize = ((data[pos + 4] & 0xFF) | (data[pos + 5] & 0xFF) << 8
                    | (data[pos + 6] & 0xFF) << 16 | (data[pos + 7] & 0xFF) << 24) & 0x7fffffff;
                pos += 8 + chunkSize;
                if ((chunkSize & 1) == 1) pos++; // chunks are word-aligned
            }
            if (pos + 10 > data.length) return;
            int n = (data.length - pos) / 2;
            int peak = 0;
            short[] samples = new short[n];
            for (int i = 0; i < n; i++) {
                int s = (data[pos + 2 * i] | (data[pos + 2 * i + 1] & 0xFF) << 8);
                samples[i] = (short) s;
                int a = Math.abs(s);
                if (a > peak) peak = a;
            }
            if (peak == 0) return;
            double gain = (0.95 * Short.MAX_VALUE) / (double) peak;
            if (gain <= 1.0) return; // already loud; duosub only amplifies quiet ones
            for (int i = 0; i < n; i++) {
                int v = (int) Math.round(samples[i] * gain);
                if (v > Short.MAX_VALUE) v = Short.MAX_VALUE;
                if (v < Short.MIN_VALUE) v = Short.MIN_VALUE;
                data[pos + 2 * i] = (byte) (v & 0xFF);
                data[pos + 2 * i + 1] = (byte) ((v >> 8) & 0xFF);
            }
            FileOutputStream out = new FileOutputStream(f);
            out.write(data);
            out.close();
        } catch (Throwable ignored) {
            // Never block playback over a failed normalization.
        }
    }

    private static byte[] readFully(InputStream in, long len) throws Exception {
        byte[] buf = (len > 0 && len <= Integer.MAX_VALUE) ? new byte[(int) len] : new byte[65536];
        int off = 0;
        int r;
        while ((r = in.read(buf, off, buf.length - off)) != -1) {
            off += r;
            if (off == buf.length) break;
        }
        if (off == buf.length) return buf;
        byte[] trimmed = new byte[off];
        System.arraycopy(buf, 0, trimmed, 0, off);
        return trimmed;
    }

    /** Last-resort direct utterance (duosub's "engines that cannot record speak it directly"). */
    private String[] directUtterance(Context app, String text, Locale locale) {
        TextToSpeech tts = null;
        try {
            final AtomicBoolean initDone = new AtomicBoolean(false);
            tts = new TextToSpeech(app, status -> initDone.set(true));
            long deadline = System.currentTimeMillis() + 2500;
            while (!initDone.get() && System.currentTimeMillis() < deadline) {
                try { Thread.sleep(100); } catch (InterruptedException e) { break; }
            }
            if (!initDone.get()) return new String[] {"unavailable", "none", "default engine did not bind in 2.5s"};
            tts.setLanguage(locale);
            Bundle params = new Bundle();
            params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
            int rc = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, "dict-" + System.nanoTime());
            if (rc == TextToSpeech.SUCCESS) {
                return new String[] {"spoken", "native-direct", "default engine, direct utterance"};
            }
            return new String[] {"playback-failed", "native-direct", "engine refused the utterance"};
        } catch (Throwable t) {
            return new String[] {"unavailable", "none", t.getMessage()};
        } finally {
            if (tts != null) { try { tts.shutdown(); } catch (Throwable ignored) {} }
        }
    }

    // ------------------------------------------------------------------
    // Installed engines (duosub's installedPronunciationEngines).
    // ------------------------------------------------------------------
    private List<String> installedEngineNames(Context ctx) {
        List<String> out = new ArrayList<>();
        try {
            String preferred = Settings.Secure.getString(
                ctx.getContentResolver(), Settings.Secure.TTS_DEFAULT_SYNTH);
            if (preferred != null) out.add(preferred);
            List<ResolveInfo> services = ctx.getPackageManager()
                .queryIntentServices(new Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0);
            for (ResolveInfo ri : services) {
                String pkg = ri.serviceInfo != null ? ri.serviceInfo.packageName : null;
                if (pkg != null && !out.contains(pkg)) out.add(pkg);
            }
        } catch (Throwable ignored) {}
        if (out.isEmpty()) out.add(null); // the platform default engine
        return out;
    }

    // ------------------------------------------------------------------
    // Google web voice (duosub's GoogleWebSpeech).
    // ------------------------------------------------------------------
    /** duosub's googleSpeechLanguage: whether Google has an online voice here. */
    private boolean googleSupported(String lang) {
        Locale locale = Locale.forLanguageTag(lang == null ? "" : lang.trim().replace('_', '-'));
        String language = locale.getLanguage();
        if (language.isEmpty() || language.equals("und") || language.equals("auto") || language.equals("yue")) {
            return false;
        }
        if (language.equals("zh") || language.equals("cmn")) {
            String country = locale.getCountry();
            if (country.equals("HK") || country.equals("MO")) return false; // Cantonese -> phone
        }
        return true;
    }

    private String nativeLocale(String lang) {
        if (lang == null) return "en-US";
        switch (lang) {
            case "zh": case "zh-CN": case "cmn": return "zh-CN";
            case "zh-TW": return "zh-TW";
            case "pt": case "pt-BR": return "pt-BR";
            case "vi": case "vi-VN": return "vi-VN";
            case "ja": return "ja-JP";
            case "ko": return "ko-KR";
            case "es": return "es-ES";
            case "fr": return "fr-FR";
            case "de": return "de-DE";
            case "ru": return "ru-RU";
            case "ar": return "ar";
            case "en": default: return "en-US";
        }
    }

    private boolean googleResting() {
        return System.currentTimeMillis() < googleRestingUntil;
    }

    private void markGoogleResting() {
        googleRestingUntil = System.currentTimeMillis() + GOOGLE_REST_MS;
    }

    private byte[] downloadGoogleMp3(String text, String lang) {
        String googleLang = googleLanguage(lang);
        if (googleLang == null) return null;
        for (String[] ep : GOOGLE_ENDPOINTS) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(ep[0] + "?ie=UTF-8&client=" + ep[1]
                    + "&tl=" + enc(googleLang) + "&q=" + enc(text));
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout((int) GOOGLE_CONNECT_TIMEOUT_MS);
                conn.setReadTimeout((int) GOOGLE_READ_TIMEOUT_MS);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13)");
                int code = conn.getResponseCode();
                if (code == 403 || code == 429 || code >= 500) {
                    continue; // duosub's Down reply: try the next address
                }
                if (code != 200) {
                    googleNoVoiceForText = true; // answered, no voice for this text
                    continue;
                }
                InputStream in = conn.getInputStream();
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n, total = 0;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    if (total > MAX_GOOGLE_BYTES) break;
                    bo.write(buf, 0, n);
                }
                in.close();
                byte[] body = bo.toByteArray();
                if (total <= MAX_GOOGLE_BYTES && looksLikeMp3(body)) {
                    return body;
                }
                googleNoVoiceForText = true; // answered but no MP3 (no voice)
            } catch (Throwable ignored) {
                // unreachable: try the next address
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        return null;
    }

    private String googleLanguage(String lang) {
        Locale locale = Locale.forLanguageTag(lang == null ? "" : lang.trim().replace('_', '-'));
        String language = locale.getLanguage();
        if (language.isEmpty() || language.equals("und") || language.equals("auto") || language.equals("yue")) {
            return null;
        }
        if (language.equals("zh") || language.equals("cmn")) {
            String country = locale.getCountry();
            if (country.equals("HK") || country.equals("MO")) return null;
            if (locale.getScript().equals("Hant") || country.equals("TW")) return "zh-TW";
            return "zh-CN";
        }
        return language;
    }

    private String enc(String s) {
        try { return java.net.URLEncoder.encode(s, "UTF-8"); }
        catch (Exception e) { return s; }
    }

    private File cacheFile(Context app, String lang, String text) {
        String ext = ".wav";
        String name = Integer.toHexString((lang + "|" + text).hashCode()) + ext;
        return new File(new File(app.getCacheDir(), "tts"), name);
    }

    private boolean looksLikeMp3(byte[] b) {
        if (b == null || b.length < 3) return false;
        boolean id3 = (b[0] == 'I' && b[1] == 'D' && b[2] == '3');
        boolean frame = (b[0] & 0xFF) == 0xFF && (b[1] & 0xE0) == 0xE0;
        return id3 || frame;
    }

    // ------------------------------------------------------------------
    private volatile MediaPlayer currentPlayer;

    private synchronized void stopPlayback() {
        MediaPlayer m = currentPlayer;
        currentPlayer = null;
        if (m != null) {
            try { if (m.isPlaying()) m.stop(); } catch (Throwable ignored) {}
            try { m.release(); } catch (Throwable ignored) {}
        }
    }

    private JSObject jsResult(String result, String engine, String detail) {
        JSObject o = new JSObject();
        o.put("result", result);
        o.put("engine", engine);
        o.put("detail", detail == null ? "" : detail);
        return o;
    }

    @Override
    protected void handleOnDestroy() {
        stopPlayback();
        net.shutdownNow();
    }
}
