package com.dict.learn.asr;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Native Android Speech-to-Text Capacitor plugin (free OS / Google Speech Services).
 *
 * Implements Google's standard runtime permission lifecycle (check, rationale,
 * permanent-denial Settings redirect), transient AudioFocus isolation, and
 * free on-device speech recognition (API 31+) with graceful standard fallback.
 *
 * JS surface (Capacitor.Plugins.DictASR):
 *   - isAvailable()
 *   - checkMicPermission()
 *   - requestMicPermission()
 *   - openAppSettings()
 *   - startListening({ lang, preferOffline })
 *   - stopListening()
 *   - cancelListening()
 *   Events: "asrEvent" ({ type: "ready"|"partial"|"result"|"error"|"rms"|"state", ... })
 */
@CapacitorPlugin(
    name = "DictASR",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class DictASRPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());

    private SpeechRecognizer recognizer;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private boolean hasAudioFocus = false;

    private int sessionGen = 0;
    private long lastRmsMs = 0L;
    private boolean retriedCloudFallback = false;
    private boolean receivedAnyAudio = false;
    private String activeBcp47 = "en-US";
    private boolean activePreferOffline = true;

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        main.post(() -> {
            Context ctx = getContext();
            boolean standard = SpeechRecognizer.isRecognitionAvailable(ctx);
            boolean onDevice = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx);
            JSObject out = new JSObject();
            out.put("available", standard || onDevice);
            out.put("standardAvailable", standard);
            out.put("onDeviceAvailable", onDevice);
            out.put("engine", "android-speech");
            out.put("permission", computePermissionState());
            call.resolve(out);
        });
    }

    @PluginMethod
    public void checkMicPermission(PluginCall call) {
        String state = computePermissionState();
        JSObject out = new JSObject();
        out.put("state", state);
        out.put("granted", "granted".equals(state));
        call.resolve(out);
    }

    @PluginMethod
    public void requestMicPermission(PluginCall call) {
        String state = computePermissionState();
        if ("granted".equals(state)) {
            JSObject out = new JSObject();
            out.put("state", "granted");
            out.put("granted", true);
            call.resolve(out);
            return;
        }
        if ("denied".equals(state)) {
            JSObject out = new JSObject();
            out.put("state", "denied");
            out.put("granted", false);
            call.resolve(out);
            return;
        }
        requestPermissionForAlias("microphone", call, "onMicPermResult");
    }

    @PermissionCallback
    private void onMicPermResult(PluginCall call) {
        String state = computePermissionState();
        JSObject out = new JSObject();
        out.put("state", state);
        out.put("granted", "granted".equals(state));
        call.resolve(out);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        main.post(() -> {
            boolean opened = false;
            try {
                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                i.setData(Uri.fromParts("package", getContext().getPackageName(), null));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                opened = true;
            } catch (Throwable t) {
                try {
                    Intent fallback = new Intent(Settings.ACTION_MANAGE_APPLICATIONS_SETTINGS);
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(fallback);
                    opened = true;
                } catch (Throwable ignored) {}
            }
            JSObject out = new JSObject();
            out.put("opened", opened);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void startListening(PluginCall call) {
        final String lang = call.getString("lang", "en");
        final boolean preferOffline = call.getBoolean("preferOffline", true);

        main.post(() -> {
            String permState = computePermissionState();
            if (!"granted".equals(permState)) {
                JSObject out = new JSObject();
                out.put("started", false);
                out.put("errorCode", "not-allowed");
                out.put("permissionState", permState);
                out.put("error", "Cần cấp quyền Micro trước khi thu âm.");
                call.resolve(out);
                return;
            }

            Context ctx = getContext();
            boolean standard = SpeechRecognizer.isRecognitionAvailable(ctx);
            boolean onDevice = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx);
            if (!standard && !onDevice) {
                JSObject out = new JSObject();
                out.put("started", false);
                out.put("errorCode", "unavailable");
                out.put("error", "Thiết bị chưa cài dịch vụ nhận giọng nói (Speech Services by Google).");
                call.resolve(out);
                return;
            }

            cleanupRecognizerLocked(false);

            sessionGen++;
            final int gen = sessionGen;
            activeBcp47 = AsrSupport.toBcp47(lang);
            activePreferOffline = preferOffline;
            retriedCloudFallback = false;
            receivedAnyAudio = false;
            lastRmsMs = 0L;

            requestTransientFocus();
            boolean tryOnDevice = preferOffline && onDevice;
            boolean ok = beginRecognizerSession(gen, activeBcp47, tryOnDevice);
            JSObject out = new JSObject();
            out.put("started", ok);
            out.put("lang", activeBcp47);
            out.put("onDevice", tryOnDevice);
            if (!ok) {
                abandonTransientFocus();
                out.put("errorCode", "unavailable");
                out.put("error", "Không khởi chạy được bộ nhận giọng nói.");
            }
            call.resolve(out);
        });
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        main.post(() -> {
            if (recognizer != null) {
                try {
                    recognizer.stopListening();
                } catch (Throwable t) {
                    cleanupRecognizerLocked(true);
                }
            } else {
                abandonTransientFocus();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void cancelListening(PluginCall call) {
        main.post(() -> {
            cleanupRecognizerLocked(true);
            call.resolve();
        });
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        main.post(() -> cleanupRecognizerLocked(true));
    }

    @Override
    protected void handleOnDestroy() {
        main.post(() -> cleanupRecognizerLocked(false));
        super.handleOnDestroy();
    }

    private String computePermissionState() {
        Context ctx = getContext();
        boolean granted = ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
        Activity act = getActivity();
        boolean rationale = act != null && ActivityCompat.shouldShowRequestPermissionRationale(
            act, Manifest.permission.RECORD_AUDIO);
        PermissionState capState = getPermissionState("microphone");
        String capStr = capState != null ? capState.toString() : "prompt";
        return AsrSupport.resolvePermissionState(granted, rationale, capStr);
    }

    private boolean beginRecognizerSession(final int gen, final String bcp47, final boolean useOnDevice) {
        Context ctx = getContext();
        try {
            if (useOnDevice && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx);
            } else {
                recognizer = SpeechRecognizer.createSpeechRecognizer(ctx);
            }
        } catch (Throwable t) {
            recognizer = null;
        }
        if (recognizer == null) return false;

        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override
            public void onReadyForSpeech(Bundle params) {
                if (gen != sessionGen) return;
                JSObject ev = new JSObject();
                ev.put("type", "ready");
                notifyListeners("asrEvent", ev);
            }

            @Override
            public void onBeginningOfSpeech() {
                if (gen != sessionGen) return;
                receivedAnyAudio = true;
            }

            @Override
            public void onRmsChanged(float rmsdB) {
                if (gen != sessionGen) return;
                long now = System.currentTimeMillis();
                if (now - lastRmsMs < 120L) return;
                lastRmsMs = now;
                JSObject ev = new JSObject();
                ev.put("type", "rms");
                ev.put("rmsdB", rmsdB);
                notifyListeners("asrEvent", ev);
            }

            @Override
            public void onBufferReceived(byte[] buffer) {}

            @Override
            public void onEndOfSpeech() {}

            @Override
            public void onError(int error) {
                if (gen != sessionGen) return;
                AsrSupport.MappedError mapped = AsrSupport.mapSpeechError(error);
                if (useOnDevice
                    && !retriedCloudFallback
                    && !receivedAnyAudio
                    && mapped.retryableWithCloudFallback
                    && SpeechRecognizer.isRecognitionAvailable(getContext())) {
                    retriedCloudFallback = true;
                    destroyOnlyRecognizer();
                    if (beginRecognizerSession(gen, bcp47, false)) {
                        return;
                    }
                }
                cleanupRecognizerLocked(false);
                JSObject ev = new JSObject();
                ev.put("type", "error");
                ev.put("code", mapped.code);
                ev.put("nativeCode", error);
                ev.put("message", mapped.message);
                notifyListeners("asrEvent", ev);
            }

            @Override
            public void onResults(Bundle results) {
                if (gen != sessionGen) return;
                ArrayList<String> list = results != null
                    ? results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    : null;
                String best = (list != null && !list.isEmpty() && list.get(0) != null)
                    ? list.get(0).trim()
                    : "";
                JSArray matches = new JSArray();
                if (list != null) {
                    for (String item : list) {
                        if (item != null && !item.trim().isEmpty()) matches.put(item.trim());
                    }
                }
                cleanupRecognizerLocked(false);
                JSObject ev = new JSObject();
                ev.put("type", "result");
                ev.put("text", best);
                ev.put("matches", matches);
                notifyListeners("asrEvent", ev);
            }

            @Override
            public void onPartialResults(Bundle partialResults) {
                if (gen != sessionGen) return;
                ArrayList<String> list = partialResults != null
                    ? partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    : null;
                String partial = (list != null && !list.isEmpty() && list.get(0) != null)
                    ? list.get(0).trim()
                    : "";
                if (partial.isEmpty()) return;
                receivedAnyAudio = true;
                JSObject ev = new JSObject();
                ev.put("type", "partial");
                ev.put("text", partial);
                notifyListeners("asrEvent", ev);
            }

            @Override
            public void onEvent(int eventType, Bundle params) {}
        });

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, bcp47);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, bcp47);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
        if (!useOnDevice && activePreferOffline) {
            intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        }

        try {
            recognizer.startListening(intent);
            return true;
        } catch (Throwable t) {
            destroyOnlyRecognizer();
            return false;
        }
    }

    private void destroyOnlyRecognizer() {
        if (recognizer != null) {
            try { recognizer.cancel(); } catch (Throwable ignored) {}
            try { recognizer.destroy(); } catch (Throwable ignored) {}
            recognizer = null;
        }
    }

    private void cleanupRecognizerLocked(boolean emitStopped) {
        boolean wasActive = recognizer != null;
        sessionGen++;
        destroyOnlyRecognizer();
        abandonTransientFocus();
        if (emitStopped && wasActive) {
            JSObject ev = new JSObject();
            ev.put("type", "state");
            ev.put("state", "stopped");
            notifyListeners("asrEvent", ev);
        }
    }

    @SuppressWarnings("deprecation")
    private void requestTransientFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                    .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                    .build();
            }
            int rc = audioManager.requestAudioFocus(focusRequest);
            hasAudioFocus = (rc == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        } else {
            int rc = audioManager.requestAudioFocus(null, AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE);
            hasAudioFocus = (rc == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        }
    }

    @SuppressWarnings("deprecation")
    private void abandonTransientFocus() {
        if (audioManager == null || !hasAudioFocus) return;
        hasAudioFocus = false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
                audioManager.abandonAudioFocusRequest(focusRequest);
            } else {
                audioManager.abandonAudioFocus(null);
            }
        } catch (Throwable ignored) {}
    }
}
