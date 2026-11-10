package com.dict.learn.tts;

import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.audiofx.LoudnessEnhancer;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import android.speech.tts.TextToSpeech;

/**
 * Native TTS for dict-learn — ported from duosub-study's Android TTS + Google web-TTS design.
 *
 * Why this exists: the Android WebView ships no working Web Speech voice, so
 * window.speechSynthesis stays silent there. This plugin speaks from Java with
 * the phone's on-device TextToSpeech (primary, offline), and falls back to
 * Google's web TTS MP3 (duosub-study's online path) when no on-device voice is
 * available for the language.
 *
 * JS surface (registered in MainActivity):  window.DictTTS = { speak, cancel, getInfo }
 *  - speak({ text, lang })  -> { engine, status }   engine: "native"|"google-web"|"none"
 *  - cancel()               -> stops current playback
 *  - getInfo()              -> { engine } of last successful speak
 *
 * Native speak() is a non-blocking queue (returns immediately after the
 * utterance is queued). The Google web path downloads an MP3 on a background
 * thread and starts it without blocking the tap.
 */
@CapacitorPlugin(name = "DictTTS")
public class DictTTSPlugin extends Plugin {

    private static final int MAX_GOOGLE_CHARS = 200;
    private static final int MAX_GOOGLE_BYTES = 512 * 1024;
    private static final long CONNECT_TIMEOUT_MS = 3000;
    private static final long READ_TIMEOUT_MS = 8000;

    /** Endpoints mirroring duosub-study's GoogleSpeechEndpoint. */
    private static final String[][] GOOGLE_ENDPOINTS = {
        {"https://translate.googleapis.com/translate_tts", "gtx"},
        {"https://translate.google.com/translate_tts", "tw-ob"},
        {"https://clients5.google.com/translate_tts", "gtx"},
    };

    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private volatile boolean ttsInitializing = false;
    private volatile String lastEngine = "none";
    private volatile MediaPlayer player;
    private volatile boolean googleBusy = false;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newFixedThreadPool(2);

    @Override
    public void load() {
        initTts();
    }

    /** Construct the on-device TTS engine on the main thread; it is ready in a few hundred ms. */
    private synchronized void initTts() {
        if (tts != null || ttsInitializing) return;
        ttsInitializing = true;
        try {
            tts = new TextToSpeech(
                getContext().getApplicationContext(),
                status -> {
                    ttsReady = (status == TextToSpeech.SUCCESS);
                    ttsInitializing = false;
                });
            if (tts != null) {
                tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            }
        } catch (Throwable t) {
            tts = null;
            ttsReady = false;
            ttsInitializing = false;
        }
    }

    @PluginMethod
    public void speak(PluginCall call) {
        final String text = call.getString("text", "");
        final String lang = call.getString("lang", "en");
        if (text == null || text.trim().isEmpty()) {
            call.resolve(result("none", "empty text", "none"));
            return;
        }
        stopPlayback();
        // Primary: on-device TTS, but only when the phone actually has an
        // available voice for this language (duosub-study: phone voices are the
        // fallback, the online voice is preferred when the phone can't read it).
        if (tryNative(text, lang)) {
            call.resolve(result("native", "ok", "native"));
            return;
        }
        // Fallback: Google web TTS (online MP3) on a background thread.
        net.execute(() -> {
            boolean ok = downloadAndPlayGoogle(text.trim(), lang);
            if (ok) {
                lastEngine = "google-web";
                main.post(() -> call.resolve(result("google-web", "ok", "google-web")));
                return;
            }
            // Last resort (offline / Google has no voice): speak with the default
            // voice anyway, so the button is never completely silent on devices
            // that do have on-device TTS.
            boolean lastTry = bestEffortNative(text, lang);
            lastEngine = lastTry ? "native-fallback" : "none";
            main.post(() -> call.resolve(result(lastTry ? "native-fallback" : "none",
                lastTry ? "ok" : "unavailable", lastTry ? "native-fallback" : "none")));
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
    public void getInfo(PluginCall call) {
        main.post(() -> call.resolve(result(lastEngine, "ok", lastEngine)));
    }

    // ------------------------------------------------------------------
    // Path 1: on-device TextToSpeech (offline, phone voice).
    // ------------------------------------------------------------------
    private boolean tryNative(String text, String lang) {
        initTts();
        if (tts == null || !ttsReady) return false;
        try {
            int rc = tts.setLanguage(Locale.forLanguageTag(nativeLocale(lang)));
            // duosub-study: only trust the phone voice when it truly has a voice
            // for this language; otherwise fall through to the online voice.
            if (rc < TextToSpeech.LANG_AVAILABLE) {
                // LANG_MISSING (-2) / LANG_NOT_SUPPORTED (-1): no on-device voice.
                // Revert to default so a later bestEffortNative() isn't stranded.
                tts.setLanguage(Locale.US);
                return false;
            }
            Bundle params = new Bundle();
            params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
            int started = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, "dict-" + System.nanoTime());
            return started == TextToSpeech.SUCCESS;
        } catch (Throwable t) {
            return false;
        }
    }

    /** Offline last resort: speak with the default voice even if it can't read this language well. */
    private boolean bestEffortNative(String text, String lang) {
        initTts();
        if (tts == null || !ttsReady) return false;
        try {
            tts.setLanguage(Locale.US);
            Bundle params = new Bundle();
            params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
            int started = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, "dict-" + System.nanoTime());
            return started == TextToSpeech.SUCCESS;
        } catch (Throwable t) {
            return false;
        }
    }

    /** Map app language codes to BCP-47 tags the TTS engine understands. */
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

    // ------------------------------------------------------------------
    // Path 2: Google web TTS (duosub-study's online fallback), MP3 → MediaPlayer.
    // Runs on a background thread; non-blocking w.r.t. playback.
    // ------------------------------------------------------------------
    private boolean downloadAndPlayGoogle(String text, String lang) {
        if (googleBusy) return false; // a download is already in flight
        googleBusy = true;
        try {
            String googleLang = googleLanguage(lang);
            if (googleLang == null || text.length() > MAX_GOOGLE_CHARS) return false;

            File cached = cacheFile(googleLang, text);
            if (cached.isFile() && cached.length() > 0 && looksLikeMp3(cached)) {
                return startMp3(cached, 1.0f);
            }
            byte[] bytes = downloadFirstWorking(googleLang, text);
            if (bytes == null) return false;
            try {
                File dir = cached.getParentFile();
                if (!dir.exists()) dir.mkdirs();
                FileOutputStream out = new FileOutputStream(cached);
                out.write(bytes);
                out.close();
            } catch (Throwable ignored) {
                // fall through to in-memory playback below
            }
            if (cached.isFile() && cached.length() > 0) {
                return startMp3(cached, 1.0f);
            }
            return false;
        } finally {
            googleBusy = false;
        }
    }

    private byte[] downloadFirstWorking(String googleLang, String text) {
        for (String[] ep : GOOGLE_ENDPOINTS) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(ep[0] + "?ie=UTF-8&client=" + ep[1]
                    + "&tl=" + enc(googleLang) + "&q=" + enc(text));
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout((int) CONNECT_TIMEOUT_MS);
                conn.setReadTimeout((int) READ_TIMEOUT_MS);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13)");
                int code = conn.getResponseCode();
                if (code == 200) {
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
                    if (total <= MAX_GOOGLE_BYTES && body.length > 0 && looksLikeMp3(body)) {
                        return body;
                    }
                }
            } catch (Throwable ignored) {
                // try the next endpoint
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        return null;
    }

    private boolean startMp3(File f, float volume) {
        try {
            MediaPlayer m = new MediaPlayer();
            m.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
            m.setDataSource(f.getAbsolutePath());
            m.prepare();
            m.setVolume(volume, volume);
            try {
                LoudnessEnhancer booster = new LoudnessEnhancer(m.getAudioSessionId());
                booster.setTargetGain(100); // small headroom boost (duosub-study's trick)
                booster.setEnabled(true);
            } catch (Throwable ignored) {}
            m.start(); // non-blocking; user taps "Nghe" again to replay
            player = m;
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** duosub-study's googleSpeechLanguage: mainland/TW voice selection. */
    private String googleLanguage(String lang) {
        Locale locale = Locale.forLanguageTag((lang == null ? "" : lang.trim().replace('_', '-')));
        String language = locale.getLanguage();
        if (language.isEmpty() || language.equals("und") || language.equals("yue")) return null;
        if (!language.equals("zh") && !language.equals("cmn")) return language;
        String country = locale.getCountry();
        if (country.equals("HK") || country.equals("MO")) return null; // Cantonese → phone TTS
        if (locale.getScript().equals("Hant") || country.equals("TW")) return "zh-TW";
        return "zh-CN";
    }

    private String enc(String s) {
        try { return java.net.URLEncoder.encode(s, "UTF-8"); }
        catch (Exception e) { return s; }
    }

    private File cacheFile(String googleLang, String text) {
        File dir = new File(getContext().getCacheDir(), "tts");
        String name = Integer.toHexString((googleLang + "|" + text).hashCode()) + ".mp3";
        return new File(dir, name);
    }

    private boolean looksLikeMp3(File f) {
        byte[] head = new byte[4];
        try (InputStream in = new java.io.FileInputStream(f)) {
            int n = 0;
            int r;
            while (n < 3 && (r = in.read(head, n, head.length - n)) != -1) {
                n += r;
            }
            if (n < 3) return false;
        } catch (Throwable t) {
            return false;
        }
        return looksLikeMp3(head);
    }

    private boolean looksLikeMp3(byte[] bytes) {
        if (bytes == null || bytes.length < 3) return false;
        boolean id3 = (bytes[0] == 'I' && bytes[1] == 'D' && bytes[2] == '3');
        boolean frame = (bytes[0] & 0xFF) == 0xFF && (bytes[1] & 0xE0) == 0xE0;
        return id3 || frame;
    }

    private void stopPlayback() {
        if (player != null) {
            try { if (player.isPlaying()) player.stop(); } catch (Throwable ignored) {}
            try { player.release(); } catch (Throwable ignored) {}
            player = null;
        }
        if (tts != null) {
            try { tts.stop(); } catch (Throwable ignored) {}
        }
    }

    private JSObject result(String engine, String status, String extra) {
        JSObject o = new JSObject();
        o.put("engine", engine);
        o.put("status", status);
        o.put("extra", extra);
        lastEngine = engine;
        return o;
    }

    @Override
    protected void handleOnDestroy() {
        stopPlayback();
        if (tts != null) { try { tts.shutdown(); } catch (Throwable ignored) {} }
        net.shutdownNow();
    }
}
