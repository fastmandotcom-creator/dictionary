package com.dict.learn.tts;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.media.audiofx.LoudnessEnhancer;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

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
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Shared thread-safe TTS synthesis, SHA-256 disk cache (with LRU cap),
 * Google Web TTS + Android engine pool, and MediaPlayer playback engine.
 * Used by both DictTTSPlugin (interactive study) and AudioLearningService
 * (background passive listening & look-ahead prefetch).
 */
public final class TtsSynthesizer {

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

    private static final long MAX_CACHE_BYTES = 150L * 1024L * 1024L;
    private static final long TRIM_TO_BYTES = 120L * 1024L * 1024L;
    private static final int TRIM_CHECK_INTERVAL = 25;

    private static TtsSynthesizer instance;

    private final Context appContext;
    private final Object audioLock = new Object();
    private final Object engineLock = new Object();
    private final Object cacheWriteLock = new Object();
    private final Map<String, TextToSpeech> enginePool = new HashMap<>();
    private final AtomicInteger writesSinceTrim = new AtomicInteger(0);

    private volatile long googleRestingUntil = 0;
    private ActivePlayback activePlayback = null;
    private TextToSpeech activeSynthTts = null;
    private CountDownLatch activeSynthLatch = null;
    private CallToken activePlaybackToken = null;

    public enum PlayOutcome { PLAYED, CANCELLED, FAILED }

    /** Per-request cancellation handle so prefetch and foreground playback never race. */
    public static final class CallToken {
        private final AtomicBoolean cancelled = new AtomicBoolean(false);
        private volatile HttpURLConnection conn;

        public boolean isCancelled() {
            return cancelled.get();
        }

        public void cancel() {
            cancelled.set(true);
            HttpURLConnection c = conn;
            if (c != null) {
                try { c.disconnect(); } catch (Throwable ignored) {}
            }
        }

        void attachConn(HttpURLConnection c) {
            this.conn = c;
            if (cancelled.get() && c != null) {
                try { c.disconnect(); } catch (Throwable ignored) {}
            }
        }

        void detachConn(HttpURLConnection c) {
            if (this.conn == c) this.conn = null;
        }
    }

    public static final class SynthResult {
        public final File file;
        public final String status; // "ready" | "cancelled" | "no-voice" | "unavailable" | "playback-failed"
        public final String engine; // "cache" | "google-web" | "native" | "none"
        public final String detail;
        public final boolean usedDirectFallback;

        SynthResult(File file, String status, String engine, String detail, boolean usedDirectFallback) {
            this.file = file;
            this.status = status;
            this.engine = engine;
            this.detail = detail;
            this.usedDirectFallback = usedDirectFallback;
        }
    }

    public static final class SpeakOutcome {
        public final String result; // "spoken" | "cancelled" | "no-voice" | "unavailable" | "playback-failed"
        public final String engine;
        public final String detail;

        SpeakOutcome(String result, String engine, String detail) {
            this.result = result;
            this.engine = engine;
            this.detail = detail;
        }
    }

    public static final class DiagnoseInfo {
        public final int engineCount;
        public final String engineNames;
        public final boolean networkOnline;
        public final boolean googleResting;
        public final int cacheCount;

        DiagnoseInfo(int engineCount, String engineNames, boolean networkOnline, boolean googleResting, int cacheCount) {
            this.engineCount = engineCount;
            this.engineNames = engineNames;
            this.networkOnline = networkOnline;
            this.googleResting = googleResting;
            this.cacheCount = cacheCount;
        }
    }

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

    private TtsSynthesizer(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public static synchronized TtsSynthesizer getInstance(Context context) {
        if (instance == null) {
            instance = new TtsSynthesizer(context);
        }
        return instance;
    }

    /** Synthesize (or fetch from disk cache) and play immediately at given speed. */
    public SpeakOutcome speakNow(String text, String lang, float speed, boolean preferOffline, CallToken token) {
        if (token != null && token.isCancelled()) {
            return new SpeakOutcome("cancelled", "none", "superseded");
        }
        String cleanText = text == null ? "" : text.trim();
        if (cleanText.isEmpty()) {
            return new SpeakOutcome("unavailable", "none", "empty text");
        }

        Locale locale = Locale.forLanguageTag(nativeLocale(lang));
        if (locale == null || locale.getLanguage().isEmpty()) {
            return new SpeakOutcome("unavailable", "none", "invalid language " + lang);
        }

        synchronized (audioLock) {
            activePlaybackToken = token;
        }

        try {
            SynthResult sr = ensureSynthesized(cleanText, lang, preferOffline, token);
            if ("cancelled".equals(sr.status) || (token != null && token.isCancelled())) {
                return new SpeakOutcome("cancelled", "none", "superseded");
            }
            if (sr.file != null && "ready".equals(sr.status)) {
                PlayOutcome po = playSpeechFile(sr.file, speed, token);
                if (po == PlayOutcome.PLAYED) {
                    return new SpeakOutcome("spoken", sr.engine, sr.detail);
                }
                if (po == PlayOutcome.CANCELLED) {
                    return new SpeakOutcome("cancelled", "none", "superseded");
                }
                return new SpeakOutcome("playback-failed", sr.engine, "playback failed for " + sr.file.getName());
            }

            // Last resort: direct utterance only when an engine bound cleanly.
            if ("native".equals(sr.engine) && !"unavailable".equals(sr.status) && (token == null || !token.isCancelled())) {
                return directUtterance(cleanText, locale, speed, token);
            }
            return new SpeakOutcome(sr.status, sr.engine, sr.detail);
        } finally {
            synchronized (audioLock) {
                if (activePlaybackToken == token) activePlaybackToken = null;
            }
        }
    }

    /** Prefetch into cache without touching active playback. Safe from background worker. */
    public SynthResult prefetch(String text, String lang, boolean preferOffline, CallToken token) {
        if (token != null && token.isCancelled()) {
            return new SynthResult(null, "cancelled", "none", "superseded", false);
        }
        String cleanText = text == null ? "" : text.trim();
        if (cleanText.isEmpty()) {
            return new SynthResult(null, "unavailable", "none", "empty text", false);
        }
        return ensureSynthesized(cleanText, lang, preferOffline, token);
    }

    /** Ensure audio file is on disk (cache -> Google -> Android TTS). Never starts MediaPlayer. */
    public SynthResult ensureSynthesized(String text, String lang, boolean preferOffline, CallToken token) {
        if (token != null && token.isCancelled()) {
            return new SynthResult(null, "cancelled", "none", "superseded", false);
        }
        Locale locale = Locale.forLanguageTag(nativeLocale(lang));
        if (locale == null || locale.getLanguage().isEmpty()) {
            return new SynthResult(null, "unavailable", "none", "invalid language " + lang, false);
        }

        // 1) Cache first (WAV from phone engine or MP3 from Google).
        File wavCache = cacheFile(appContext, lang, text, ".wav");
        if (wavCache.isFile() && wavCache.length() >= MIN_WAV_BYTES) {
            wavCache.setLastModified(System.currentTimeMillis());
            return new SynthResult(wavCache, "ready", "cache", "cached " + wavCache.getName(), false);
        }
        File mp3Cache = cacheFile(appContext, lang, text, ".mp3");
        if (mp3Cache.isFile() && mp3Cache.length() > 0) {
            mp3Cache.setLastModified(System.currentTimeMillis());
            return new SynthResult(mp3Cache, "ready", "cache", "cached " + mp3Cache.getName(), false);
        }

        // 2) Google web voice first when online, healthy, and offline-priority is not forced.
        if (!preferOffline && googleSupported(lang) && text.length() <= MAX_GOOGLE_CHARS
            && !googleResting() && isNetworkAvailable(appContext)) {
            GoogleResult gr = downloadGoogleMp3(text, lang, token);
            if (gr.cancelled || (token != null && token.isCancelled())) {
                return new SynthResult(null, "cancelled", "none", "superseded", false);
            }
            if (gr.mp3 != null && looksLikeMp3(gr.mp3)) {
                if (writeAtomic(mp3Cache, gr.mp3)) {
                    recordCacheWrite();
                    return new SynthResult(mp3Cache, "ready", "google-web",
                        "downloaded " + gr.mp3.length + " bytes", false);
                }
            } else if (!gr.noVoiceForText) {
                markGoogleResting();
            }
        }

        if (token != null && token.isCancelled()) {
            return new SynthResult(null, "cancelled", "none", "superseded", false);
        }

        // 3) Installed on-device TTS engines (default first).
        SynthResult engineRes = synthesizeWithEngines(text, lang, locale, wavCache, token);
        if (engineRes != null) return engineRes;

        // 4) Offline priority fallback: if device has no offline voice for this language, try Google if online.
        if (preferOffline && googleSupported(lang) && text.length() <= MAX_GOOGLE_CHARS
            && !googleResting() && isNetworkAvailable(appContext)) {
            GoogleResult gr = downloadGoogleMp3(text, lang, token);
            if (gr.cancelled || (token != null && token.isCancelled())) {
                return new SynthResult(null, "cancelled", "none", "superseded", false);
            }
            if (gr.mp3 != null && looksLikeMp3(gr.mp3) && writeAtomic(mp3Cache, gr.mp3)) {
                recordCacheWrite();
                return new SynthResult(mp3Cache, "ready", "google-web",
                    "downloaded " + gr.mp3.length + " bytes", false);
            }
        }
        return new SynthResult(null, "no-voice", "native", "no voice available", false);
    }

    private SynthResult synthesizeWithEngines(
        String text,
        String lang,
        Locale locale,
        File wavTarget,
        CallToken token
    ) {
        List<String> engines = installedEngineNames(appContext);
        boolean online = isNetworkAvailable(appContext);
        boolean anyInitialized = false;
        String detail = "no installed TTS engine";

        synchronized (engineLock) {
            if (wavTarget.isFile() && wavTarget.length() >= MIN_WAV_BYTES) {
                return new SynthResult(wavTarget, "ready", "cache", "cached " + wavTarget.getName(), false);
            }
            for (String name : engines) {
                if (token != null && token.isCancelled()) {
                    return new SynthResult(null, "cancelled", "none", "superseded", false);
                }
                String engineLabel = (name == null || name.isEmpty()) ? "default" : name;
                TextToSpeech tts = acquireEngineLocked(appContext, name);
                if (tts == null) {
                    detail = "engine " + engineLabel + " failed to initialize";
                    continue;
                }
                anyInitialized = true;
                File wavTmp = new File(wavTarget.getParentFile(),
                    wavTarget.getName() + "." + Thread.currentThread().getId() + ".tmp");
                try {
                    tts.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
                    if (!selectBestVoice(tts, locale, online)) {
                        detail = "engine " + engineLabel + " has no voice for " + lang;
                        continue;
                    }
                    if (wavTmp.exists()) wavTmp.delete();
                    boolean ok = synthesizeToFileLocked(tts, text, wavTmp, token);
                    if (token != null && token.isCancelled()) {
                        wavTmp.delete();
                        return new SynthResult(null, "cancelled", "none", "superseded", false);
                    }
                    if (ok && wavTmp.length() >= MIN_WAV_BYTES) {
                        normalizeWav(wavTmp);
                        File playable = commitTempFile(wavTmp, wavTarget);
                        recordCacheWrite();
                        return new SynthResult(playable, "ready", "native",
                            "engine " + engineLabel + " recorded " + playable.length() + " bytes", false);
                    }
                    wavTmp.delete();
                    evictEngineLocked(name);
                    detail = "engine " + engineLabel + " recorded nothing for " + lang;
                } catch (Throwable t) {
                    wavTmp.delete();
                    evictEngineLocked(name);
                    detail = "engine " + engineLabel + " failed: " + t.getMessage();
                }
            }
        }

        if (!anyInitialized) {
            return new SynthResult(null, "unavailable", "native", detail, false);
        }
        return new SynthResult(null, "no-voice", "native", detail, false);
    }

    public void stopActivePlayback() {
        CallToken tok;
        synchronized (audioLock) {
            tok = activePlaybackToken;
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
        if (tok != null) tok.cancel();
    }

    public DiagnoseInfo diagnose() {
        List<String> engines = installedEngineNames(appContext);
        int namedCount = 0;
        StringBuilder names = new StringBuilder();
        for (String e : engines) {
            if (e != null && !e.isEmpty()) {
                if (namedCount > 0) names.append(", ");
                names.append(e);
                namedCount++;
            }
        }
        int engineCount = namedCount > 0 ? namedCount : engines.size();
        String engineNames = names.length() > 0 ? names.toString() : "default";
        int files = countCacheFiles(appContext);
        boolean online = isNetworkAvailable(appContext);
        return new DiagnoseInfo(engineCount, engineNames, online, googleResting(), files);
    }

    public void shutdown() {
        stopActivePlayback();
        synchronized (engineLock) {
            for (TextToSpeech tts : enginePool.values()) {
                try { tts.shutdown(); } catch (Throwable ignored) {}
            }
            enginePool.clear();
        }
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

    private boolean synthesizeToFileLocked(TextToSpeech tts, String text, File wavOut, CallToken token) {
        File parent = wavOut.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();

        final String uttId = "dict-synth-" + System.nanoTime();
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
            if (token != null && token.isCancelled()) return false;
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
            if (!finished || (token != null && token.isCancelled())) {
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
                return false;
            }
        } catch (Throwable ignored) {}
        return rc >= TextToSpeech.LANG_AVAILABLE;
    }

    public PlayOutcome playSpeechFile(File f, float speed, CallToken token) {
        if (token != null && token.isCancelled()) return PlayOutcome.CANCELLED;
        float clampedSpeed = AudioQueueModels.clampSpeed(speed);
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
            long expectedMs = Math.round(durationMs / Math.max(0.65f, clampedSpeed));
            long waitMs = Math.max(SPOKEN_FILE_TIMEOUT_MS, Math.min(45_000L, expectedMs + 2500L));

            ActivePlayback handle = new ActivePlayback(m, booster, doneLatch);
            synchronized (audioLock) {
                if (token != null && token.isCancelled()) {
                    releaseResources(m, booster);
                    return PlayOutcome.CANCELLED;
                }
                activePlayback = handle;
                m.start();
                if (Math.abs(clampedSpeed - 1.0f) > 0.01f) {
                    try {
                        PlaybackParams pp = m.getPlaybackParams();
                        pp.setSpeed(clampedSpeed);
                        m.setPlaybackParams(pp);
                    } catch (Throwable ignored) {}
                }
            }

            boolean completed = doneLatch.await(waitMs, TimeUnit.MILLISECONDS);
            synchronized (audioLock) {
                if (activePlayback == handle) activePlayback = null;
                if (!handle.released) {
                    handle.released = true;
                    releaseResources(handle.player, handle.booster);
                }
            }
            if (token != null && token.isCancelled()) return PlayOutcome.CANCELLED;
            if (!completed && outcome.get() == PlayOutcome.PLAYED) {
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
            return (token != null && token.isCancelled()) ? PlayOutcome.CANCELLED : PlayOutcome.FAILED;
        }
    }

    private SpeakOutcome directUtterance(String text, Locale locale, float speed, CallToken token) {
        synchronized (engineLock) {
            if (token != null && token.isCancelled()) return new SpeakOutcome("cancelled", "none", "superseded");
            TextToSpeech tts = acquireEngineLocked(appContext, null);
            if (tts == null) {
                return new SpeakOutcome("unavailable", "none", "default engine unavailable");
            }
            if (!selectBestVoice(tts, locale, isNetworkAvailable(appContext))) {
                return new SpeakOutcome("no-voice", "native-direct", "default engine has no voice");
            }
            try { tts.setSpeechRate(AudioQueueModels.clampSpeed(speed)); } catch (Throwable ignored) {}
            final String uttId = "dict-direct-" + System.nanoTime();
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
                if (token != null && token.isCancelled()) return new SpeakOutcome("cancelled", "none", "superseded");
                activeSynthTts = tts;
                activeSynthLatch = done;
            }
            try {
                int rc = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, uttId);
                if (rc != TextToSpeech.SUCCESS) {
                    return new SpeakOutcome("playback-failed", "native-direct", "engine refused utterance");
                }
                done.await(SPOKEN_FILE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                if (token != null && token.isCancelled()) {
                    tts.stop();
                    return new SpeakOutcome("cancelled", "none", "superseded");
                }
                if (Boolean.TRUE.equals(ok.get())) {
                    return new SpeakOutcome("spoken", "native-direct", "default engine direct utterance");
                }
                return new SpeakOutcome("playback-failed", "native-direct", "direct utterance did not complete");
            } catch (InterruptedException e) {
                try { tts.stop(); } catch (Throwable ignored) {}
                return new SpeakOutcome("cancelled", "none", "superseded");
            } finally {
                synchronized (audioLock) {
                    if (activeSynthLatch == done) activeSynthLatch = null;
                    if (activeSynthTts == tts) activeSynthTts = null;
                }
                try { tts.setSpeechRate(1.0f); } catch (Throwable ignored) {}
            }
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
    public static void normalizeWav(File f) {
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
        } catch (Throwable ignored) {}
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

    public boolean isNetworkAvailable(Context ctx) {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            Network n = cm.getActiveNetwork();
            if (n == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
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

    private GoogleResult downloadGoogleMp3(String text, String lang, CallToken token) {
        String googleLang = googleLanguage(lang);
        if (googleLang == null) return new GoogleResult(null, true, false);
        boolean sawNoVoice = false;
        for (String[] ep : GOOGLE_ENDPOINTS) {
            if (token != null && token.isCancelled()) return GoogleResult.cancelled();
            HttpURLConnection conn = null;
            try {
                URL url = new URL(ep[0] + "?ie=UTF-8&client=" + ep[1]
                    + "&tl=" + enc(googleLang) + "&q=" + enc(text));
                conn = (HttpURLConnection) url.openConnection();
                if (token != null) token.attachConn(conn);
                conn.setConnectTimeout((int) GOOGLE_CONNECT_TIMEOUT_MS);
                conn.setReadTimeout((int) GOOGLE_READ_TIMEOUT_MS);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13)");
                int code = conn.getResponseCode();
                if (token != null && token.isCancelled()) return GoogleResult.cancelled();
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
                    if (token != null && token.isCancelled()) {
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
                if (token != null && token.isCancelled()) return GoogleResult.cancelled();
            } finally {
                if (token != null) token.detachConn(conn);
                if (conn != null) conn.disconnect();
            }
        }
        return new GoogleResult(null, sawNoVoice, token != null && token.isCancelled());
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

    private File commitTempFile(File tmp, File target) {
        synchronized (cacheWriteLock) {
            if (target.isFile() && target.length() >= MIN_WAV_BYTES) {
                tmp.delete();
                return target;
            }
            if (target.exists()) target.delete();
            return tmp.renameTo(target) ? target : tmp;
        }
    }

    private boolean writeAtomic(File target, byte[] data) {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        File tmp = new File(parent, target.getName() + "." + Thread.currentThread().getId() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
        } catch (Throwable t) {
            tmp.delete();
            return false;
        }
        synchronized (cacheWriteLock) {
            if (target.exists()) target.delete();
            boolean ok = tmp.renameTo(target) || target.isFile();
            if (!ok) tmp.delete();
            return ok;
        }
    }

    private void recordCacheWrite() {
        if (writesSinceTrim.incrementAndGet() >= TRIM_CHECK_INTERVAL) {
            writesSinceTrim.set(0);
            trimCacheDir(ttsDir(appContext), MAX_CACHE_BYTES, TRIM_TO_BYTES);
        }
    }

    /** Trim oldest cached TTS clips when total cache exceeds maxBytes. Exposed package-private for JUnit. */
    static int trimCacheDir(File dir, long maxBytes, long trimToBytes) {
        if (dir == null || !dir.isDirectory()) return 0;
        File[] raw = dir.listFiles();
        if (raw == null || raw.length == 0) return 0;

        long now = System.currentTimeMillis();
        long total = 0L;
        List<File> cached = new ArrayList<>();
        for (File f : raw) {
            if (!f.isFile()) continue;
            if (f.getName().contains(".tmp")) {
                if (now - f.lastModified() > 120_000L) f.delete();
                continue;
            }
            total += f.length();
            cached.add(f);
        }
        if (total <= maxBytes) return 0;

        cached.sort(Comparator.comparingLong(File::lastModified));
        int deleted = 0;
        for (File f : cached) {
            if (total <= trimToBytes) break;
            long len = f.length();
            if (f.delete()) {
                total -= len;
                deleted++;
            }
        }
        return deleted;
    }

    private boolean looksLikeMp3(byte[] b) {
        if (b == null || b.length < 3) return false;
        boolean id3 = (b[0] == 'I' && b[1] == 'D' && b[2] == '3');
        boolean frame = (b[0] & 0xFF) == 0xFF && (b[1] & 0xE0) == 0xE0;
        return id3 || frame;
    }
}
