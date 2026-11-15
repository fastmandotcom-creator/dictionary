package com.dict.learn.tts;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.audiofx.LoudnessEnhancer;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Native TTS for dict-learn — duosub-study's WordPronouncer +
 * AndroidPronunciationEngine + GoogleWebSpeech design, hardened for Capacitor 8:
 *  1. Playback cache (SHA-256 keyed WAV / MP3 in cacheDir/tts);
 *  2. Google web voice first when online and healthy (~1s MP3);
 *  3. On-device Android TTS engines (user's default first, then every installed
 *     service), persisted across calls for low latency, checking init status,
 *     choosing best installed voice, synthesizing to temp WAV + RIFF-safe
 *     normalization;
 *  4. Last-resort direct utterance that awaits completion before cleanup.
 *
 * Surface (Capacitor.Plugins.DictTTS):
 *   speak({text, lang}) -> {result, engine, detail}
 *     result: "spoken" | "cancelled" | "no-voice" | "unavailable" | "playback-failed"
 *   cancel()
 *   diagnose() -> {engineCount, engineNames, networkOnline, googleResting, cacheCount}
 *   openSettings()
 */
@CapacitorPlugin(name = "DictTTS")
public class DictTTSPlugin extends Plugin {

    private static final String[][] GOOGLE_ENDPOINTS = {
        {"https://translate.googleapis.com/translate_tts", "gtx"},
        {"https://translate.google.com/translate_tts", "tw-ob"},
        {"https://clients5.google.com/translate_tts", "gtx"},
    };
    private static final int MAX_GOOGLE_CHARS = 200;
    private static final int MAX_GOOGLE_BYTES = 512 * 1024;
    private static final long GOOGLE_CONNECT_TIMEOUT_MS = 3000;
    private static final long GOOGLE_READ_TIMEOUT_MS = 8000;
    private static final long GOOGLE_REST_MS = 60_000;

    private static final long ENGINE_INIT_TIMEOUT_MS = 4000;
    private static final long RENDER_TIMEOUT_MS = 10_000;
    private static final long SPOKEN_FILE_TIMEOUT_MS = 15_000;
    private static final int MIN_WAV_BYTES = 45; // 44-byte RIFF/WAVE header + >=1 byte PCM
    private static final int LOUDNESS_GAIN_MB = 300; // +3 dB headroom

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newFixedThreadPool(2);
    private final AtomicLong activeSeq = new AtomicLong(0);
    private final Object audioLock = new Object();
    private final Object engineLock = new Object();
    private final Map<String, TextToSpeech> enginePool = new HashMap<>();

    private volatile long googleRestingUntil = 0;
    private ActivePlayback activePlayback = null;
    private HttpURLConnection activeConn = null;
    private TextToSpeech activeSynthTts = null;
    private CountDownLatch activeSynthLatch = null;

    private enum PlayOutcome { PLAYED, CANCELLED, FAILED }

    private static final class ActivePlayback {
        final MediaPlayer player;
        final LoudnessEnhancer booster;
        final CountDownLatch latch;
        boolean released = false;

        ActivePlayback(MediaPlayer p, LoudnessEnhancer b, CountDownLatch l) {
            this.player = p;
            this.booster = b;
            this.latch = l;
        }
    }

    private static final class GoogleResult {
        final byte[] mp3;
        final boolean noVoiceForText;
        final boolean cancelled;

        GoogleResult(byte[] mp3, boolean noVoiceForText, boolean cancelled) {
            this.mp3 = mp3;
            this.noVoiceForText = noVoiceForText;
            this.cancelled = cancelled;
        }

        static GoogleResult cancelled() { return new GoogleResult(null, false, true); }
        static GoogleResult success(byte[] mp3) { return new GoogleResult(mp3, false, false); }
    }

    @Override
    public void load() {
        // Engines bind lazily on demand to avoid slowing app launch.
    }

    @PluginMethod
    public void speak(PluginCall call) {
        final String rawText = call.getString("text", "");
        final String text = rawText == null ? "" : rawText.trim();
        final String lang = call.getString("lang", "en");
        if (text.isEmpty()) {
            call.resolve(jsResult("unavailable", "none", "empty text"));
            return;
        }
        final long seq = activeSeq.incrementAndGet();
        stopPlayback();
        net.execute(() -> {
            String[] out = pronounce(text, lang, seq);
            main.post(() -> call.resolve(jsResult(out[0], out[1], out[2])));
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        activeSeq.incrementAndGet();
        stopPlayback();
        call.resolve();
    }

    @PluginMethod
    public void diagnose(PluginCall call) {
        net.execute(() -> {
            Context app = getContext().getApplicationContext();
            List<String> engines = installedEngineNames(app);
            int namedCount = 0;
            StringBuilder names = new StringBuilder();
            for (String e : engines) {
                if (e != null && !e.isEmpty()) {
                    if (namedCount > 0) names.append(", ");
                    names.append(e);
                    namedCount++;
                }
            }
            final int engineCount = namedCount > 0 ? namedCount : engines.size();
            final String engineNames = names.length() > 0 ? names.toString() : "default";
            final int files = countCacheFiles(app);
            final boolean online = isNetworkAvailable(app);
            main.post(() -> {
                JSObject o = new JSObject();
                o.put("engineCount", engineCount);
                o.put("engineNames", engineNames);
                o.put("networkOnline", online);
                o.put("googleResting", googleResting());
                o.put("cacheCount", files);
                call.resolve(o);
            });
        });
    }

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

    private boolean isCancelled(long seq) {
        return activeSeq.get() != seq;
    }

    private String[] pronounce(String text, String lang, long seq) {
        if (isCancelled(seq)) return new String[] {"cancelled", "none", "superseded"};
        Context app = getContext().getApplicationContext();
        String localeTag = nativeLocale(lang);
        Locale locale = Locale.forLanguageTag(localeTag);
        if (locale == null || locale.getLanguage().isEmpty()) {
            return new String[] {"unavailable", "none", "invalid language " + lang};
        }

        // 1) Cache first (WAV from phone engine or MP3 from Google).
        File wavCache = cacheFile(app, lang, text, ".wav");
        if (wavCache.isFile() && wavCache.length() >= MIN_WAV_BYTES) {
            PlayOutcome po = playSpeechFile(wavCache, seq);
            if (po == PlayOutcome.PLAYED) return new String[] {"spoken", "cache", "played " + wavCache.getName()};
            if (po == PlayOutcome.CANCELLED) return new String[] {"cancelled", "none", "superseded"};
        }
        File mp3Cache = cacheFile(app, lang, text, ".mp3");
        if (mp3Cache.isFile() && mp3Cache.length() > 0) {
            PlayOutcome po = playSpeechFile(mp3Cache, seq);
            if (po == PlayOutcome.PLAYED) return new String[] {"spoken", "cache", "played " + mp3Cache.getName()};
            if (po == PlayOutcome.CANCELLED) return new String[] {"cancelled", "none", "superseded"};
        }

        // 2) Google web voice first when online & healthy. Skip zero-delay if offline.
        if (googleSupported(lang) && text.length() <= MAX_GOOGLE_CHARS
            && !googleResting() && isNetworkAvailable(app)) {
            GoogleResult gr = downloadGoogleMp3(text, lang, seq);
            if (gr.cancelled || isCancelled(seq)) {
                return new String[] {"cancelled", "none", "superseded"};
            }
            if (gr.mp3 != null && looksLikeMp3(gr.mp3)) {
                if (writeAtomic(mp3Cache, gr.mp3)) {
                    PlayOutcome po = playSpeechFile(mp3Cache, seq);
                    if (po == PlayOutcome.PLAYED) {
                        return new String[] {"spoken", "google-web", "downloaded " + gr.mp3.length + " bytes"};
                    }
                    if (po == PlayOutcome.CANCELLED) {
                        return new String[] {"cancelled", "none", "superseded"};
                    }
                    // Playback failure on a valid MP3 shouldn't trigger Google outage cooldown.
                }
            } else if (!gr.noVoiceForText) {
                markGoogleResting();
            }
        }

        if (isCancelled(seq)) return new String[] {"cancelled", "none", "superseded"};

        // 3) Installed on-device TTS engines (default first).
        String[] phone = pronounceWithEngines(app, text, lang, locale, seq);
        if ("spoken".equals(phone[0]) || "cancelled".equals(phone[0])) return phone;

        // 4) Last resort: direct utterance only when an engine bound cleanly.
        if ("native".equals(phone[1]) && !"unavailable".equals(phone[0]) && !isCancelled(seq)) {
            String[] direct = directUtterance(app, text, locale, seq);
            if ("spoken".equals(direct[0]) || "cancelled".equals(direct[0])) return direct;
        }
        return phone;
    }

    private String[] pronounceWithEngines(Context app, String text, String lang, Locale locale, long seq) {
        List<String> engines = installedEngineNames(app);
        boolean online = isNetworkAvailable(app);
        boolean anyInitialized = false;
        boolean playbackFailed = false;
        String detail = "no installed TTS engine";

        synchronized (engineLock) {
            for (String name : engines) {
                if (isCancelled(seq)) return new String[] {"cancelled", "none", "superseded"};
                String engineLabel = (name == null || name.isEmpty()) ? "default" : name;
                TextToSpeech tts = acquireEngineLocked(app, name);
                if (tts == null) {
                    detail = "engine " + engineLabel + " failed to initialize";
                    continue;
                }
                anyInitialized = true;
                try {
                    tts.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
                    if (!selectBestVoice(tts, locale, online)) {
                        detail = "engine " + engineLabel + " has no voice for " + lang;
                        continue;
                    }
                    File wav = cacheFile(app, lang, text, ".wav");
                    File wavTmp = new File(wav.getParentFile(), wav.getName() + ".tmp");
                    if (wavTmp.exists()) wavTmp.delete();
                    boolean ok = synthesizeToFileLocked(tts, text, wavTmp, seq);
                    if (isCancelled(seq)) {
                        wavTmp.delete();
                        return new String[] {"cancelled", "none", "superseded"};
                    }
                    if (ok && wavTmp.length() >= MIN_WAV_BYTES) {
                        normalizeWav(wavTmp);
                        if (wav.exists()) wav.delete();
                        File playable = wavTmp.renameTo(wav) ? wav : wavTmp;
                        PlayOutcome po = playSpeechFile(playable, seq);
                        if (po == PlayOutcome.PLAYED) {
                            return new String[] {"spoken", "native",
                                "engine " + engineLabel + " recorded " + playable.length() + " bytes"};
                        }
                        if (po == PlayOutcome.CANCELLED) {
                            return new String[] {"cancelled", "none", "superseded"};
                        }
                        playbackFailed = true;
                        detail = "engine " + engineLabel + " recorded but playback failed";
                        continue;
                    }
                    wavTmp.delete();
                    evictEngineLocked(name);
                    playbackFailed = true;
                    detail = "engine " + engineLabel + " recorded nothing for " + lang;
                } catch (Throwable t) {
                    evictEngineLocked(name);
                    playbackFailed = true;
                    detail = "engine " + engineLabel + " failed: " + t.getMessage();
                }
            }
        }

        if (!anyInitialized) return new String[] {"unavailable", "native", detail};
        if (playbackFailed && detail.contains("playback failed")) {
            return new String[] {"playback-failed", "native", detail};
        }
        return new String[] {"no-voice", "native", detail};
    }

    private TextToSpeech acquireEngineLocked(Context app, String pkg) {
        String key = (pkg == null) ? "" : pkg;
        TextToSpeech existing = enginePool.get(key);
        if (existing != null) return existing;

        CountDownLatch latch = new CountDownLatch(1);
        AtomicInteger initStatus = new AtomicInteger(TextToSpeech.ERROR);
        TextToSpeech.OnInitListener listener = status -> {
            initStatus.set(status);
            latch.countDown();
        };
        TextToSpeech tts;
        try {
            tts = key.isEmpty()
                ? new TextToSpeech(app, listener)
                : new TextToSpeech(app, listener, key);
        } catch (Throwable t) {
            return null;
        }
        try {
            if (!latch.await(ENGINE_INIT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                try { tts.shutdown(); } catch (Throwable ignored) {}
                return null;
            }
        } catch (InterruptedException e) {
            try { tts.shutdown(); } catch (Throwable ignored) {}
            return null;
        }
        if (initStatus.get() != TextToSpeech.SUCCESS) {
            try { tts.shutdown(); } catch (Throwable ignored) {}
            return null;
        }
        enginePool.put(key, tts);
        return tts;
    }

    private void evictEngineLocked(String pkg) {
        String key = (pkg == null) ? "" : pkg;
        TextToSpeech tts = enginePool.remove(key);
        if (tts != null) {
            try { tts.shutdown(); } catch (Throwable ignored) {}
        }
    }

    private boolean synthesizeToFileLocked(TextToSpeech tts, String text, File wavOut, long seq) {
        File parent = wavOut.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();

        final String uttId = "dict-synth-" + seq + "-" + System.nanoTime();
        final CountDownLatch done = new CountDownLatch(1);
        final AtomicReference<Boolean> success = new AtomicReference<>(false);

        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {}
            @Override public void onDone(String id) {
                if (uttId.equals(id)) {
                    success.set(true);
                    done.countDown();
                }
            }
            @SuppressWarnings("deprecation")
            @Override public void onError(String id) {
                if (uttId.equals(id)) {
                    success.set(false);
                    done.countDown();
                }
            }
            @Override public void onError(String id, int errorCode) {
                if (uttId.equals(id)) {
                    success.set(false);
                    done.countDown();
                }
            }
        });

        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
        synchronized (audioLock) {
            if (isCancelled(seq)) return false;
            activeSynthTts = tts;
            activeSynthLatch = done;
        }
        try {
            int rc = tts.synthesizeToFile(text, params, wavOut, uttId);
            if (rc != TextToSpeech.SUCCESS) {
                tts.stop();
                return false;
            }
            boolean finished = done.await(RENDER_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (!finished || isCancelled(seq)) {
                tts.stop();
                return false;
            }
            return Boolean.TRUE.equals(success.get()) && wavOut.isFile() && wavOut.length() >= MIN_WAV_BYTES;
        } catch (InterruptedException e) {
            try { tts.stop(); } catch (Throwable ignored) {}
            return false;
        } finally {
            synchronized (audioLock) {
                if (activeSynthLatch == done) activeSynthLatch = null;
                if (activeSynthTts == tts) activeSynthTts = null;
            }
        }
    }

    private boolean selectBestVoice(TextToSpeech tts, Locale locale, boolean networkOnline) {
        int rc = tts.setLanguage(locale);
        Voice best = null;
        int bestScore = Integer.MIN_VALUE;
        try {
            Set<Voice> voices = tts.getVoices();
            if (voices != null && !voices.isEmpty()) {
                String wantLang = locale.getLanguage();
                String wantCountry = locale.getCountry();
                for (Voice v : voices) {
                    if (v == null || v.getLocale() == null) continue;
                    Locale vl = v.getLocale();
                    if (!wantLang.equalsIgnoreCase(vl.getLanguage())) continue;
                    Set<String> features = v.getFeatures();
                    if (features != null && features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) {
                        continue;
                    }
                    if (!networkOnline && v.isNetworkConnectionRequired()) {
                        continue;
                    }
                    int score = 0;
                    if (!wantCountry.isEmpty() && wantCountry.equalsIgnoreCase(vl.getCountry())) score += 10;
                    if (!v.isNetworkConnectionRequired()) score += 4;
                    score += Math.max(0, v.getQuality() / 100);
                    if (score > bestScore) {
                        bestScore = score;
                        best = v;
                    }
                }
                if (best != null) {
                    return tts.setVoice(best) == TextToSpeech.SUCCESS || rc >= TextToSpeech.LANG_AVAILABLE;
                }
                // Engine reported voices explicitly, none usable for this language/connectivity.
                return false;
            }
        } catch (Throwable ignored) {
            // Some minimal OEM engines throw from getVoices(); fall back to setLanguage status.
        }
        return rc >= TextToSpeech.LANG_AVAILABLE;
    }

    private PlayOutcome playSpeechFile(File f, long seq) {
        if (isCancelled(seq)) return PlayOutcome.CANCELLED;
        MediaPlayer m = null;
        LoudnessEnhancer booster = null;
        CountDownLatch doneLatch = new CountDownLatch(1);
        AtomicReference<PlayOutcome> outcome = new AtomicReference<>(PlayOutcome.PLAYED);

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
                booster.setTargetGain(LOUDNESS_GAIN_MB);
                booster.setEnabled(true);
            } catch (Throwable ignored) {}

            m.setOnCompletionListener(mp -> doneLatch.countDown());
            m.setOnErrorListener((mp, what, extra) -> {
                outcome.set(PlayOutcome.FAILED);
                doneLatch.countDown();
                return true;
            });

            int durationMs = Math.max(0, m.getDuration());
            long waitMs = Math.max(SPOKEN_FILE_TIMEOUT_MS, Math.min(30_000L, durationMs + 2000L));

            ActivePlayback handle = new ActivePlayback(m, booster, doneLatch);
            synchronized (audioLock) {
                if (isCancelled(seq)) {
                    releaseResources(m, booster);
                    return PlayOutcome.CANCELLED;
                }
                activePlayback = handle;
                m.start();
            }

            boolean completed = doneLatch.await(waitMs, TimeUnit.MILLISECONDS);
            synchronized (audioLock) {
                if (activePlayback == handle) activePlayback = null;
                if (!handle.released) {
                    handle.released = true;
                    releaseResources(handle.player, handle.booster);
                }
            }
            if (isCancelled(seq)) return PlayOutcome.CANCELLED;
            if (!completed && outcome.get() == PlayOutcome.PLAYED) {
                // Timed out beyond duration + slack without completion callback; audio still played.
                return PlayOutcome.PLAYED;
            }
            return outcome.get();
        } catch (Throwable t) {
            synchronized (audioLock) {
                if (activePlayback != null && activePlayback.player == m) {
                    if (!activePlayback.released) {
                        activePlayback.released = true;
                        releaseResources(activePlayback.player, activePlayback.booster);
                    }
                    activePlayback = null;
                } else {
                    releaseResources(m, booster);
                }
            }
            return isCancelled(seq) ? PlayOutcome.CANCELLED : PlayOutcome.FAILED;
        }
    }

    private static void releaseResources(MediaPlayer m, LoudnessEnhancer b) {
        if (b != null) { try { b.release(); } catch (Throwable ignored) {} }
        if (m != null) { try { m.release(); } catch (Throwable ignored) {} }
    }

    /**
     * Amplify a quiet 16-bit PCM WAV toward full scale.
     * Parses subchunks starting after the 12-byte RIFF/WAVE header and reads
     * 16-bit little-endian samples with unsigned low-byte masking.
     */
    static void normalizeWav(File f) {
        try {
            FileInputStream in = new FileInputStream(f);
            byte[] data = readFully(in, (int) f.length());
            in.close();
            if (data.length < 44) return;
            if (!"RIFF".equals(new String(data, 0, 4, StandardCharsets.US_ASCII))
                || !"WAVE".equals(new String(data, 8, 4, StandardCharsets.US_ASCII))) {
                return;
            }
            int dataStart = -1;
            int dataBytes = 0;
            int pos = 12;
            while (pos + 8 <= data.length) {
                String id = new String(data, pos, 4, StandardCharsets.US_ASCII);
                int chunkSize = (data[pos + 4] & 0xFF)
                    | ((data[pos + 5] & 0xFF) << 8)
                    | ((data[pos + 6] & 0xFF) << 16)
                    | ((data[pos + 7] & 0xFF) << 24);
                if (chunkSize < 0) break;
                if ("data".equals(id)) {
                    dataStart = pos + 8;
                    dataBytes = Math.min(chunkSize, data.length - dataStart);
                    break;
                }
                pos += 8 + chunkSize + (chunkSize & 1);
            }
            if (dataStart < 0 || dataBytes < 2) return;
            int n = dataBytes / 2;
            int peak = 0;
            short[] samples = new short[n];
            for (int i = 0; i < n; i++) {
                int lo = data[dataStart + 2 * i] & 0xFF;
                int hi = data[dataStart + 2 * i + 1] & 0xFF;
                short s = (short) (lo | (hi << 8));
                samples[i] = s;
                int a = Math.abs((int) s);
                if (a > peak) peak = a;
            }
            if (peak == 0) return;
            double gain = (0.92 * Short.MAX_VALUE) / (double) peak;
            if (gain <= 1.05) return;
            for (int i = 0; i < n; i++) {
                int v = (int) Math.round(samples[i] * gain);
                if (v > Short.MAX_VALUE) v = Short.MAX_VALUE;
                if (v < Short.MIN_VALUE) v = Short.MIN_VALUE;
                data[dataStart + 2 * i] = (byte) (v & 0xFF);
                data[dataStart + 2 * i + 1] = (byte) ((v >> 8) & 0xFF);
            }
            FileOutputStream out = new FileOutputStream(f);
            out.write(data);
            out.close();
        } catch (Throwable ignored) {
            // Never fail playback over normalization.
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

    /** Last-resort direct utterance that waits for completion before releasing/returning. */
    private String[] directUtterance(Context app, String text, Locale locale, long seq) {
        synchronized (engineLock) {
            if (isCancelled(seq)) return new String[] {"cancelled", "none", "superseded"};
            TextToSpeech tts = acquireEngineLocked(app, null);
            if (tts == null) {
                return new String[] {"unavailable", "none", "default engine unavailable"};
            }
            if (!selectBestVoice(tts, locale, isNetworkAvailable(app))) {
                return new String[] {"no-voice", "native-direct", "default engine has no voice"};
            }
            final String uttId = "dict-direct-" + seq + "-" + System.nanoTime();
            final CountDownLatch done = new CountDownLatch(1);
            final AtomicReference<Boolean> ok = new AtomicReference<>(false);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) {
                    if (uttId.equals(id)) { ok.set(true); done.countDown(); }
                }
                @SuppressWarnings("deprecation")
                @Override public void onError(String id) {
                    if (uttId.equals(id)) { ok.set(false); done.countDown(); }
                }
                @Override public void onError(String id, int errorCode) {
                    if (uttId.equals(id)) { ok.set(false); done.countDown(); }
                }
            });
            Bundle params = new Bundle();
            params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
            synchronized (audioLock) {
                if (isCancelled(seq)) return new String[] {"cancelled", "none", "superseded"};
                activeSynthTts = tts;
                activeSynthLatch = done;
            }
            try {
                int rc = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, uttId);
                if (rc != TextToSpeech.SUCCESS) {
                    return new String[] {"playback-failed", "native-direct", "engine refused utterance"};
                }
                done.await(SPOKEN_FILE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                if (isCancelled(seq)) {
                    tts.stop();
                    return new String[] {"cancelled", "none", "superseded"};
                }
                if (Boolean.TRUE.equals(ok.get())) {
                    return new String[] {"spoken", "native-direct", "default engine direct utterance"};
                }
                return new String[] {"playback-failed", "native-direct", "direct utterance did not complete"};
            } catch (InterruptedException e) {
                try { tts.stop(); } catch (Throwable ignored) {}
                return new String[] {"cancelled", "none", "superseded"};
            } finally {
                synchronized (audioLock) {
                    if (activeSynthLatch == done) activeSynthLatch = null;
                    if (activeSynthTts == tts) activeSynthTts = null;
                }
            }
        }
    }

    private List<String> installedEngineNames(Context ctx) {
        List<String> out = new ArrayList<>();
        try {
            String preferred = Settings.Secure.getString(
                ctx.getContentResolver(), Settings.Secure.TTS_DEFAULT_SYNTH);
            if (preferred != null && !preferred.trim().isEmpty()) out.add(preferred.trim());
            List<ResolveInfo> services = ctx.getPackageManager().queryIntentServices(
                new Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE),
                PackageManager.MATCH_DEFAULT_ONLY);
            for (ResolveInfo ri : services) {
                String pkg = ri.serviceInfo != null ? ri.serviceInfo.packageName : null;
                if (pkg != null && !pkg.isEmpty() && !out.contains(pkg)) out.add(pkg);
            }
        } catch (Throwable ignored) {}
        if (out.isEmpty()) out.add(null);
        return out;
    }

    private boolean isNetworkAvailable(Context ctx) {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            Network net = cm.getActiveNetwork();
            if (net == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(net);
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Throwable ignored) {
            return true;
        }
    }

    private boolean googleSupported(String lang) {
        Locale locale = Locale.forLanguageTag(lang == null ? "" : lang.trim().replace('_', '-'));
        String language = locale.getLanguage();
        if (language.isEmpty() || language.equals("und") || language.equals("auto") || language.equals("yue")) {
            return false;
        }
        if (language.equals("zh") || language.equals("cmn")) {
            String country = locale.getCountry();
            if (country.equals("HK") || country.equals("MO")) return false;
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

    private GoogleResult downloadGoogleMp3(String text, String lang, long seq) {
        String googleLang = googleLanguage(lang);
        if (googleLang == null) return new GoogleResult(null, true, false);
        boolean sawNoVoice = false;
        for (String[] ep : GOOGLE_ENDPOINTS) {
            if (isCancelled(seq)) return GoogleResult.cancelled();
            HttpURLConnection conn = null;
            try {
                URL url = new URL(ep[0] + "?ie=UTF-8&client=" + ep[1]
                    + "&tl=" + enc(googleLang) + "&q=" + enc(text));
                conn = (HttpURLConnection) url.openConnection();
                activeConn = conn;
                conn.setConnectTimeout((int) GOOGLE_CONNECT_TIMEOUT_MS);
                conn.setReadTimeout((int) GOOGLE_READ_TIMEOUT_MS);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13)");
                int code = conn.getResponseCode();
                if (isCancelled(seq)) return GoogleResult.cancelled();
                if (code == 403 || code == 429 || code >= 500) {
                    continue;
                }
                if (code != 200) {
                    sawNoVoice = true;
                    continue;
                }
                InputStream in = conn.getInputStream();
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n, total = 0;
                while ((n = in.read(buf)) != -1) {
                    if (isCancelled(seq)) {
                        in.close();
                        return GoogleResult.cancelled();
                    }
                    total += n;
                    if (total > MAX_GOOGLE_BYTES) break;
                    bo.write(buf, 0, n);
                }
                in.close();
                byte[] body = bo.toByteArray();
                if (total <= MAX_GOOGLE_BYTES && looksLikeMp3(body)) {
                    return GoogleResult.success(body);
                }
                sawNoVoice = true;
            } catch (Throwable ignored) {
                if (isCancelled(seq)) return GoogleResult.cancelled();
            } finally {
                if (activeConn == conn) activeConn = null;
                if (conn != null) conn.disconnect();
            }
        }
        return new GoogleResult(null, sawNoVoice, isCancelled(seq));
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

    private File ttsDir(Context app) {
        File dir = new File(app.getCacheDir(), "tts");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private File cacheFile(Context app, String lang, String text, String ext) {
        String key = sha256Hex(lang + "|" + text);
        return new File(ttsDir(app), key + ext);
    }

    private int countCacheFiles(Context app) {
        File dir = new File(app.getCacheDir(), "tts");
        File[] files = dir.listFiles();
        if (files == null) return 0;
        int count = 0;
        for (File f : files) {
            if (!f.isFile()) continue;
            String n = f.getName();
            if ((n.endsWith(".mp3") && f.length() > 0) || (n.endsWith(".wav") && f.length() >= MIN_WAV_BYTES)) {
                count++;
            }
        }
        return count;
    }

    private static String sha256Hex(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] dig = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(24);
            for (int i = 0; i < 12; i++) {
                sb.append(String.format("%02x", dig[i] & 0xFF));
            }
            return sb.toString();
        } catch (Throwable t) {
            return Integer.toHexString(input.hashCode());
        }
    }

    private boolean writeAtomic(File target, byte[] data) {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        File tmp = new File(parent, target.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
        } catch (Throwable t) {
            tmp.delete();
            return false;
        }
        if (target.exists()) target.delete();
        return tmp.renameTo(target) || target.isFile();
    }

    private boolean looksLikeMp3(byte[] b) {
        if (b == null || b.length < 3) return false;
        boolean id3 = (b[0] == 'I' && b[1] == 'D' && b[2] == '3');
        boolean frame = (b[0] & 0xFF) == 0xFF && (b[1] & 0xE0) == 0xE0;
        return id3 || frame;
    }

    private void stopPlayback() {
        HttpURLConnection conn = activeConn;
        if (conn != null) {
            try { conn.disconnect(); } catch (Throwable ignored) {}
        }
        synchronized (audioLock) {
            if (activeSynthLatch != null) activeSynthLatch.countDown();
            if (activeSynthTts != null) {
                try { activeSynthTts.stop(); } catch (Throwable ignored) {}
            }
            if (activePlayback != null && !activePlayback.released) {
                activePlayback.latch.countDown();
                try { activePlayback.player.stop(); } catch (Throwable ignored) {}
                activePlayback.released = true;
                releaseResources(activePlayback.player, activePlayback.booster);
                activePlayback = null;
            }
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
        activeSeq.incrementAndGet();
        stopPlayback();
        synchronized (engineLock) {
            for (TextToSpeech tts : enginePool.values()) {
                try { tts.shutdown(); } catch (Throwable ignored) {}
            }
            enginePool.clear();
        }
        net.shutdownNow();
    }
}
