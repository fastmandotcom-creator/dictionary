package com.dict.learn.tts;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;

import com.dict.learn.tts.AudioLearningService.AudioSnapshot;
import com.dict.learn.tts.AudioQueueModels.AudioConfig;
import com.dict.learn.tts.AudioQueueModels.AudioDrill;
import com.dict.learn.tts.AudioQueueModels.AudioTrackItem;
import com.dict.learn.tts.AudioQueueModels.UtteranceStep;
import com.dict.learn.tts.TtsSynthesizer.CallToken;
import com.dict.learn.tts.TtsSynthesizer.DiagnoseInfo;
import com.dict.learn.tts.TtsSynthesizer.SpeakOutcome;
import com.dict.learn.tts.TtsSynthesizer.SynthResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native TTS & Passive Audio Learning Capacitor bridge.
 *
 * Surface (Capacitor.Plugins.DictTTS):
 *   Interactive: speak({text, lang, speed?}), cancel(), diagnose(), openSettings()
 *   Background Audio: requestNotificationPermission(), startAudioQueue({tracks, startIndex, config, sleepMinutes}),
 *     pauseAudio(), resumeAudio(), nextAudio(), prevAudio(), seekAudio({index}), stopAudio(),
 *     updateAudioConfig({...}), getAudioState(), prefetchAudio({tracks, config}), cancelPrefetch()
 *   Events: "audioState", "audioPrefetch"
 */
@CapacitorPlugin(
    name = "DictTTS",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class DictTTSPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newFixedThreadPool(2);
    private final ExecutorService batchPrefetchExec = Executors.newSingleThreadExecutor();

    private TtsSynthesizer synthesizer;
    private CallToken activeSpeakToken = null;
    private CallToken activeBatchPrefetchToken = null;

    @Override
    public void load() {
        synthesizer = TtsSynthesizer.getInstance(getContext());
        AudioLearningService.setListener(snapshot ->
            main.post(() -> notifyListeners("audioState", snapshotToJS(snapshot)))
        );
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33) {
            JSObject r = new JSObject();
            r.put("granted", true);
            r.put("legacy", true);
            call.resolve(r);
            return;
        }
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias("notifications", call, "onNotificationPermResult");
    }

    @PermissionCallback
    private void onNotificationPermResult(PluginCall call) {
        boolean granted = getPermissionState("notifications") == PermissionState.GRANTED;
        JSObject r = new JSObject();
        r.put("granted", granted);
        call.resolve(r);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        final String rawText = call.getString("text", "");
        final String text = rawText == null ? "" : rawText.trim();
        final String lang = call.getString("lang", "en");
        final float speed = AudioQueueModels.clampSpeed(call.getFloat("speed", 1.0f));
        if (text.isEmpty()) {
            call.resolve(jsResult("unavailable", "none", "empty text"));
            return;
        }

        // Never overlap active card speech with background audio playback.
        AudioLearningService bg = AudioLearningService.getActiveInstance();
        if (bg != null) {
            bg.pausePlayback(false);
        }

        CallToken prev = activeSpeakToken;
        if (prev != null) prev.cancel();
        synthesizer.stopActivePlayback();
        final CallToken token = new CallToken();
        activeSpeakToken = token;

        net.execute(() -> {
            SpeakOutcome out = synthesizer.speakNow(text, lang, speed, false, token);
            main.post(() -> call.resolve(jsResult(out.result, out.engine, out.detail)));
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        CallToken prev = activeSpeakToken;
        if (prev != null) {
            prev.cancel();
            activeSpeakToken = null;
        }
        synthesizer.stopActivePlayback();
        call.resolve();
    }

    @PluginMethod
    public void diagnose(PluginCall call) {
        net.execute(() -> {
            DiagnoseInfo info = synthesizer.diagnose();
            main.post(() -> {
                JSObject o = new JSObject();
                o.put("engineCount", info.engineCount);
                o.put("engineNames", info.engineNames);
                o.put("networkOnline", info.networkOnline);
                o.put("googleResting", info.googleResting);
                o.put("cacheCount", info.cacheCount);
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

    @PluginMethod
    public void startAudioQueue(PluginCall call) {
        List<AudioTrackItem> tracks = parseTracks(call.getArray("tracks"));
        if (tracks.isEmpty()) {
            call.reject("empty audio playlist");
            return;
        }
        // Cancel any lingering interactive card utterance first
        CallToken prev = activeSpeakToken;
        if (prev != null) {
            prev.cancel();
            activeSpeakToken = null;
        }
        synthesizer.stopActivePlayback();

        int startIndex = Math.max(0, Math.min(call.getInt("startIndex", 0), tracks.size() - 1));
        JSObject cfgObj = call.getObject("config", new JSObject());
        AudioConfig config = parseConfig(cfgObj, AudioConfig.defaults());
        int sleepMinutes = Math.max(0, call.getInt("sleepMinutes", 0));

        AudioLearningService.startWithQueue(getContext(), tracks, startIndex, config, sleepMinutes);
        JSObject out = new JSObject();
        out.put("ok", true);
        out.put("total", tracks.size());
        call.resolve(out);
    }

    @PluginMethod
    public void pauseAudio(PluginCall call) {
        AudioLearningService svc = AudioLearningService.getActiveInstance();
        if (svc != null) svc.pausePlayback(false);
        call.resolve(snapshotToJS(AudioLearningService.getLatestSnapshot()));
    }

    @PluginMethod
    public void resumeAudio(PluginCall call) {
        AudioLearningService svc = AudioLearningService.getActiveInstance();
        if (svc != null) svc.resumePlayback();
        call.resolve(snapshotToJS(AudioLearningService.getLatestSnapshot()));
    }

    @PluginMethod
    public void nextAudio(PluginCall call) {
        AudioLearningService svc = AudioLearningService.getActiveInstance();
        if (svc != null) svc.nextTrack();
        call.resolve(snapshotToJS(AudioLearningService.getLatestSnapshot()));
    }

    @PluginMethod
    public void prevAudio(PluginCall call) {
        AudioLearningService svc = AudioLearningService.getActiveInstance();
        if (svc != null) svc.prevTrack();
        call.resolve(snapshotToJS(AudioLearningService.getLatestSnapshot()));
    }

    @PluginMethod
    public void seekAudio(PluginCall call) {
        int idx = call.getInt("index", 0);
        AudioLearningService svc = AudioLearningService.getActiveInstance();
        if (svc != null) svc.seekToIndex(idx);
        call.resolve(snapshotToJS(AudioLearningService.getLatestSnapshot()));
    }

    @PluginMethod
    public void stopAudio(PluginCall call) {
        AudioLearningService svc = AudioLearningService.getActiveInstance();
        if (svc != null) svc.stopSession();
        call.resolve(snapshotToJS(AudioLearningService.getLatestSnapshot()));
    }

    @PluginMethod
    public void updateAudioConfig(PluginCall call) {
        AudioSnapshot cur = AudioLearningService.getLatestSnapshot();
        AudioConfig baseCfg = new AudioConfig(
            cur.preset, cur.order, cur.targetRepeat, cur.speed, cur.repeatMode, cur.includeDrills, cur.preferOffline
        );
        JSObject raw = call.getData();
        AudioConfig nextCfg = parseConfig(raw, baseCfg);
        Integer sleepMinutes = raw != null && raw.has("sleepMinutes")
            ? Math.max(0, call.getInt("sleepMinutes", 0))
            : null;
        AudioLearningService svc = AudioLearningService.getActiveInstance();
        if (svc != null) {
            svc.updateConfig(nextCfg, sleepMinutes);
        }
        call.resolve(snapshotToJS(AudioLearningService.getLatestSnapshot()));
    }

    @PluginMethod
    public void getAudioState(PluginCall call) {
        call.resolve(snapshotToJS(AudioLearningService.getLatestSnapshot()));
    }

    @PluginMethod
    public void prefetchAudio(PluginCall call) {
        List<AudioTrackItem> tracks = parseTracks(call.getArray("tracks"));
        AudioConfig cfg = parseConfig(call.getObject("config", new JSObject()), AudioConfig.defaults());
        if (activeBatchPrefetchToken != null) activeBatchPrefetchToken.cancel();
        final CallToken token = new CallToken();
        activeBatchPrefetchToken = token;

        List<UtteranceStep> allSteps = new ArrayList<>();
        for (AudioTrackItem item : tracks) {
            allSteps.addAll(AudioQueueModels.buildSteps(item, cfg));
        }
        final int total = allSteps.size();

        batchPrefetchExec.execute(() -> {
            int done = 0;
            int cached = 0;
            for (UtteranceStep step : allSteps) {
                if (token.isCancelled()) break;
                SynthResult r = synthesizer.prefetch(step.text, step.lang, cfg.preferOffline, token);
                done++;
                if ("ready".equals(r.status)) cached++;
                if (done % 4 == 0 || done == total) {
                    JSObject ev = new JSObject();
                    ev.put("done", done);
                    ev.put("total", total);
                    ev.put("cached", cached);
                    ev.put("finished", done >= total || token.isCancelled());
                    ev.put("cancelled", token.isCancelled());
                    main.post(() -> notifyListeners("audioPrefetch", ev));
                }
            }
            if (total == 0) {
                JSObject ev = new JSObject();
                ev.put("done", 0);
                ev.put("total", 0);
                ev.put("cached", 0);
                ev.put("finished", true);
                ev.put("cancelled", false);
                main.post(() -> notifyListeners("audioPrefetch", ev));
            }
        });

        JSObject r = new JSObject();
        r.put("ok", true);
        r.put("total", total);
        call.resolve(r);
    }

    @PluginMethod
    public void cancelPrefetch(PluginCall call) {
        if (activeBatchPrefetchToken != null) {
            activeBatchPrefetchToken.cancel();
            activeBatchPrefetchToken = null;
        }
        call.resolve();
    }

    /** Preserved package-private entrypoint used by DictTTSPluginUnitTest. */
    static void normalizeWav(File f) {
        TtsSynthesizer.normalizeWav(f);
    }

    private List<AudioTrackItem> parseTracks(JSArray arr) {
        List<AudioTrackItem> out = new ArrayList<>();
        if (arr == null) return out;
        int len = arr.length();
        for (int i = 0; i < len; i++) {
            JSONObject obj = arr.optJSONObject(i);
            if (obj == null) continue;
            List<AudioDrill> drills = new ArrayList<>();
            org.json.JSONArray dArr = obj.optJSONArray("drills");
            if (dArr != null) {
                for (int j = 0; j < dArr.length(); j++) {
                    JSONObject d = dArr.optJSONObject(j);
                    if (d != null) {
                        drills.add(new AudioDrill(d.optString("s", ""), d.optString("h", "")));
                    }
                }
            }
            String word = obj.optString("word", "");
            if (word.trim().isEmpty()) continue;
            out.add(new AudioTrackItem(
                obj.optString("id", ""),
                word,
                obj.optString("meaning", ""),
                obj.optString("ro", ""),
                obj.optString("ipa", ""),
                obj.optString("exTarget", ""),
                obj.optString("exBase", ""),
                obj.optString("targetLang", "en"),
                obj.optString("baseLang", "vi"),
                drills
            ));
        }
        return out;
    }

    private AudioConfig parseConfig(JSObject raw, AudioConfig fallback) {
        if (raw == null) return fallback;
        String preset = raw.has("preset") ? raw.getString("preset", fallback.preset) : fallback.preset;
        String order = raw.has("order") ? raw.getString("order", fallback.order) : fallback.order;
        int targetRepeat = fallback.targetRepeat;
        if (raw.has("targetRepeat")) {
            try { targetRepeat = raw.getInt("targetRepeat"); } catch (Throwable ignored) {}
        }
        float speed = fallback.speed;
        if (raw.has("speed")) {
            try { speed = (float) raw.getDouble("speed"); } catch (Throwable ignored) {}
        }
        String repeatMode = raw.has("repeatMode") ? raw.getString("repeatMode", fallback.repeatMode) : fallback.repeatMode;
        boolean includeDrills = raw.has("includeDrills") ? raw.optBoolean("includeDrills", fallback.includeDrills) : fallback.includeDrills;
        boolean preferOffline = raw.has("preferOffline") ? raw.optBoolean("preferOffline", fallback.preferOffline) : fallback.preferOffline;
        return new AudioConfig(preset, order, targetRepeat, speed, repeatMode, includeDrills, preferOffline);
    }

    private JSObject snapshotToJS(AudioSnapshot s) {
        JSObject o = new JSObject();
        o.put("status", s.status);
        o.put("index", s.index);
        o.put("total", s.total);
        o.put("conceptId", s.conceptId);
        o.put("word", s.word);
        o.put("meaning", s.meaning);
        o.put("stepRole", s.stepRole);
        o.put("stepText", s.stepText);
        o.put("stepLang", s.stepLang);
        o.put("preset", s.preset);
        o.put("order", s.order);
        o.put("targetRepeat", s.targetRepeat);
        o.put("speed", s.speed);
        o.put("repeatMode", s.repeatMode);
        o.put("includeDrills", s.includeDrills);
        o.put("preferOffline", s.preferOffline);
        o.put("sleepRemainingMs", s.sleepRemainingMs);
        o.put("heardCount", s.heardCount);
        o.put("completedSeq", s.completedSeq);
        o.put("lastCompletedConceptId", s.lastCompletedConceptId);
        o.put("error", s.error);
        return o;
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
        AudioLearningService.setListener(null);
        if (activeSpeakToken != null) activeSpeakToken.cancel();
        if (activeBatchPrefetchToken != null) activeBatchPrefetchToken.cancel();
        if (AudioLearningService.getActiveInstance() == null && synthesizer != null) {
            synthesizer.shutdown();
        }
        net.shutdownNow();
        batchPrefetchExec.shutdownNow();
    }
}
