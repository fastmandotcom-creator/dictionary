package com.dict.learn.tts;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

import com.dict.learn.tts.AudioQueueModels.AudioConfig;
import com.dict.learn.tts.AudioQueueModels.AudioTrackItem;
import com.dict.learn.tts.AudioQueueModels.UtteranceStep;
import com.dict.learn.tts.TtsSynthesizer.CallToken;
import com.dict.learn.tts.TtsSynthesizer.SpeakOutcome;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Foreground MediaPlayback service driving background passive audio learning.
 * Owns MediaSessionCompat (lock screen & Bluetooth controls), AudioFocus,
 * noisy-disconnect auto-pause, Sleep Timer, look-ahead prefetching, and the
 * cognitive cadence loop (independent of WebView throttling when screen locks).
 */
public final class AudioLearningService extends Service {

    public static final String ACTION_START_PENDING = "com.dict.learn.tts.ACTION_START_PENDING";
    public static final String ACTION_ENSURE_FG = "com.dict.learn.tts.ACTION_ENSURE_FG";
    public static final String ACTION_PLAY_PAUSE = "com.dict.learn.tts.ACTION_PLAY_PAUSE";
    public static final String ACTION_NEXT = "com.dict.learn.tts.ACTION_NEXT";
    public static final String ACTION_PREV = "com.dict.learn.tts.ACTION_PREV";
    public static final String ACTION_STOP = "com.dict.learn.tts.ACTION_STOP";
    public static final String ACTION_OPEN_AUDIO = "com.dict.learn.tts.OPEN_AUDIO";
    public static final String EXTRA_OPEN_AUDIO = "open_audio";

    private static final String CHANNEL_ID = "dictlearn_audio_playback";
    private static final int NOTIFICATION_ID = 4108;
    private static final int MAX_CONSECUTIVE_TRACK_FAILURES = 3;
    private static final long WAKELOCK_TIMEOUT_MS = 3L * 60L * 60L * 1000L;

    public static final String STATE_IDLE = "idle";
    public static final String STATE_PLAYING = "playing";
    public static final String STATE_PAUSED = "paused";

    public static final class AudioSnapshot {
        public final String status;
        public final int index;
        public final int total;
        public final String conceptId;
        public final String word;
        public final String meaning;
        public final String romaji;
        public final String ipa;
        public final String exTarget;
        public final String exBase;
        public final String stepRole;
        public final String stepText;
        public final String stepLang;
        public final String preset;
        public final String order;
        public final int targetRepeat;
        public final float speed;
        public final String repeatMode;
        public final boolean includeDrills;
        public final boolean preferOffline;
        public final long sleepRemainingMs;
        public final int heardCount;
        public final long completedSeq;
        public final String lastCompletedConceptId;
        public final String error;

        AudioSnapshot(
            String status, int index, int total, String conceptId, String word, String meaning,
            String romaji, String ipa, String exTarget, String exBase,
            String stepRole, String stepText, String stepLang,
            String preset, String order, int targetRepeat, float speed, String repeatMode, boolean includeDrills, boolean preferOffline,
            long sleepRemainingMs, int heardCount, long completedSeq, String lastCompletedConceptId, String error
        ) {
            this.status = status;
            this.index = index;
            this.total = total;
            this.conceptId = conceptId;
            this.word = word;
            this.meaning = meaning;
            this.romaji = romaji == null ? "" : romaji;
            this.ipa = ipa == null ? "" : ipa;
            this.exTarget = exTarget == null ? "" : exTarget;
            this.exBase = exBase == null ? "" : exBase;
            this.stepRole = stepRole;
            this.stepText = stepText;
            this.stepLang = stepLang;
            this.preset = preset;
            this.order = order;
            this.targetRepeat = targetRepeat;
            this.speed = speed;
            this.repeatMode = repeatMode;
            this.includeDrills = includeDrills;
            this.preferOffline = preferOffline;
            this.sleepRemainingMs = sleepRemainingMs;
            this.heardCount = heardCount;
            this.completedSeq = completedSeq;
            this.lastCompletedConceptId = lastCompletedConceptId;
            this.error = error;
        }
    }

    public interface Listener {
        void onAudioState(AudioSnapshot snapshot);
    }

    public static final class PendingStart {
        final List<AudioTrackItem> tracks;
        final int startIndex;
        final AudioConfig config;
        final int sleepMinutes;

        public PendingStart(List<AudioTrackItem> tracks, int startIndex, AudioConfig config, int sleepMinutes) {
            this.tracks = tracks;
            this.startIndex = startIndex;
            this.config = config;
            this.sleepMinutes = sleepMinutes;
        }
    }

    private static final AtomicReference<PendingStart> PENDING_START = new AtomicReference<>(null);
    private static volatile AudioLearningService activeInstance = null;
    private static volatile Listener externalListener = null;
    private static volatile AudioSnapshot lastSnapshot = new AudioSnapshot(
        STATE_IDLE, 0, 0, "", "", "", "", "", "", "", "", "", "", AudioConfig.defaults().preset,
        AudioConfig.defaults().order, AudioConfig.defaults().targetRepeat,
        1.0f, AudioConfig.defaults().repeatMode, false, false, 0L, 0, 0L, "", ""
    );

    public final class LocalBinder extends Binder {
        public AudioLearningService getService() {
            return AudioLearningService.this;
        }
    }

    private final IBinder binder = new LocalBinder();
    private final Object stateLock = new Object();

    private TtsSynthesizer synthesizer;
    private AudioManager audioManager;
    private NotificationManager notificationManager;
    private MediaSessionCompat mediaSession;
    private PowerManager.WakeLock wakeLock;
    private AudioFocusRequest focusRequest;

    private final ExecutorService playbackExec = Executors.newSingleThreadExecutor();
    private final ExecutorService prefetchExec = Executors.newSingleThreadExecutor();

    private List<AudioTrackItem> tracks = Collections.emptyList();
    private AudioConfig config = AudioConfig.defaults();
    private String playState = STATE_IDLE;
    private int currentIndex = 0;
    private int currentStepIndex = 0;
    private String activeStepRole = "";
    private String activeStepText = "";
    private String activeStepLang = "";
    private String activePairTarget = "";
    private String activePairBase = "";
    private long sleepDeadlineMs = 0L;
    private int heardCount = 0;
    private long completedSeq = 0L;
    private String lastCompletedConceptId = "";
    private String errorCode = "";
    private long epoch = 0L;
    private boolean serviceStopped = false;
    private boolean workerStarted = false;
    private boolean foregroundEntered = false;
    private boolean resumeAfterTransientFocusLoss = false;
    private boolean noisyRegistered = false;
    private volatile String lastNotifKey = "";

    private CallToken activeStepToken = null;
    private CallToken activePrefetchToken = null;

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent != null && AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                pausePlayback(false);
            }
        }
    };

    private final AudioManager.OnAudioFocusChangeListener focusListener = focusChange -> {
        if (focusChange == AudioManager.AUDIOFOCUS_LOSS) {
            pausePlayback(false);
        } else if (focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
            || focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
            synchronized (stateLock) {
                if (STATE_PLAYING.equals(playState)) {
                    resumeAfterTransientFocusLoss = true;
                }
            }
            pausePlayback(true);
        } else if (focusChange == AudioManager.AUDIOFOCUS_GAIN) {
            boolean shouldResume;
            synchronized (stateLock) {
                shouldResume = resumeAfterTransientFocusLoss && STATE_PAUSED.equals(playState);
                resumeAfterTransientFocusLoss = false;
            }
            if (shouldResume) {
                resumePlayback();
            }
        }
    };

    public static AudioLearningService getActiveInstance() {
        return activeInstance;
    }

    public static void setListener(Listener listener) {
        externalListener = listener;
        if (listener != null) {
            listener.onAudioState(getLatestSnapshot());
        }
    }

    public static AudioSnapshot getLatestSnapshot() {
        AudioLearningService svc = activeInstance;
        return svc != null ? svc.buildSnapshot() : lastSnapshot;
    }

    public static void startWithQueue(
        Context context,
        List<AudioTrackItem> tracks,
        int startIndex,
        AudioConfig config,
        int sleepMinutes
    ) {
        Context app = context.getApplicationContext();
        PENDING_START.set(new PendingStart(
            tracks == null ? Collections.emptyList() : new ArrayList<>(tracks),
            startIndex,
            config == null ? AudioConfig.defaults() : config,
            sleepMinutes
        ));
        Intent intent = new Intent(app, AudioLearningService.class).setAction(ACTION_START_PENDING);
        ContextCompat.startForegroundService(app, intent);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        activeInstance = this;
        synthesizer = TtsSynthesizer.getInstance(this);
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dictlearn:audio_learning");
            wakeLock.setReferenceCounted(false);
        }

        ensureNotificationChannel();
        setupMediaSession();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_ENSURE_FG;
        if (ACTION_START_PENDING.equals(action)) {
            enterForegroundNow();
            PendingStart req = PENDING_START.getAndSet(null);
            if (req != null) {
                startSession(req.tracks, req.startIndex, req.config, req.sleepMinutes);
            } else if (tracks.isEmpty()) {
                stopSession();
            }
            return START_NOT_STICKY;
        }
        if (ACTION_ENSURE_FG.equals(action)) {
            enterForegroundNow();
            return START_NOT_STICKY;
        }
        if (ACTION_PLAY_PAUSE.equals(action)) {
            if (!foregroundEntered) enterForegroundNow();
            togglePlayPause();
            return START_NOT_STICKY;
        }
        if (ACTION_NEXT.equals(action)) {
            if (!foregroundEntered) enterForegroundNow();
            nextTrack();
            return START_NOT_STICKY;
        }
        if (ACTION_PREV.equals(action)) {
            if (!foregroundEntered) enterForegroundNow();
            prevTrack();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            stopSession();
            return START_NOT_STICKY;
        }
        if (!foregroundEntered && !STATE_IDLE.equals(playState)) {
            enterForegroundNow();
        }
        return START_NOT_STICKY;
    }

    public void startSession(List<AudioTrackItem> newTracks, int startIndex, AudioConfig newConfig, int sleepMinutes) {
        if (newTracks == null || newTracks.isEmpty()) {
            stopSession();
            return;
        }
        synchronized (stateLock) {
            epoch++;
            cancelInFlightLocked();
            tracks = Collections.unmodifiableList(new ArrayList<>(newTracks));
            config = newConfig == null ? AudioConfig.defaults() : newConfig;
            currentIndex = Math.max(0, Math.min(startIndex, tracks.size() - 1));
            currentStepIndex = 0;
            clearActiveStepLocked();
            heardCount = 0;
            completedSeq = 0L;
            lastCompletedConceptId = "";
            errorCode = "";
            resumeAfterTransientFocusLoss = false;
            sleepDeadlineMs = sleepMinutes > 0 ? (System.currentTimeMillis() + sleepMinutes * 60_000L) : 0L;
            serviceStopped = false;

            if (requestFocusLocked()) {
                playState = STATE_PLAYING;
                acquireWakeLockLocked();
                registerNoisyReceiverSafe();
                mediaSession.setActive(true);
            } else {
                playState = STATE_PAUSED;
                errorCode = "audio-focus-denied";
            }

            if (!workerStarted) {
                workerStarted = true;
                playbackExec.execute(this::runPlaybackLoop);
            }
            stateLock.notifyAll();
        }
        enterForegroundNow();
        publishSnapshot();
    }

    public void togglePlayPause() {
        String stateNow;
        synchronized (stateLock) {
            stateNow = playState;
        }
        if (STATE_PLAYING.equals(stateNow)) {
            pausePlayback(false);
        } else if (STATE_PAUSED.equals(stateNow)) {
            resumePlayback();
        }
    }

    public void pausePlayback(boolean fromTransientFocusLoss) {
        synchronized (stateLock) {
            if (STATE_IDLE.equals(playState) || STATE_PAUSED.equals(playState)) {
                return;
            }
            if (!fromTransientFocusLoss) {
                resumeAfterTransientFocusLoss = false;
            }
            playState = STATE_PAUSED;
            epoch++;
            cancelInFlightLocked();
            releaseWakeLockLocked();
            unregisterNoisyReceiverSafe();
            if (!fromTransientFocusLoss) {
                abandonFocusLocked();
            }
            stateLock.notifyAll();
        }
        synthesizer.stopActivePlayback();
        publishSnapshot();
    }

    public void resumePlayback() {
        synchronized (stateLock) {
            if (tracks.isEmpty()) return;
            if (currentIndex >= tracks.size()) currentIndex = 0;
            if (!requestFocusLocked()) {
                errorCode = "audio-focus-denied";
                publishSnapshot();
                return;
            }
            resumeAfterTransientFocusLoss = false;
            errorCode = "";
            playState = STATE_PLAYING;
            epoch++;
            acquireWakeLockLocked();
            registerNoisyReceiverSafe();
            mediaSession.setActive(true);
            if (!workerStarted) {
                workerStarted = true;
                playbackExec.execute(this::runPlaybackLoop);
            }
            stateLock.notifyAll();
        }
        enterForegroundNow();
        publishSnapshot();
    }

    public void nextTrack() {
        seekTrackDelta(1);
    }

    public void prevTrack() {
        seekTrackDelta(-1);
    }

    public void seekToIndex(int index) {
        synchronized (stateLock) {
            if (tracks.isEmpty()) return;
            int clamped = Math.max(0, Math.min(index, tracks.size() - 1));
            epoch++;
            cancelInFlightLocked();
            currentIndex = clamped;
            currentStepIndex = 0;
            clearActiveStepLocked();
            errorCode = "";
            stateLock.notifyAll();
        }
        synthesizer.stopActivePlayback();
        publishSnapshot();
    }

    private void seekTrackDelta(int delta) {
        synchronized (stateLock) {
            if (tracks.isEmpty()) return;
            int next = currentIndex + delta;
            if (next < 0) next = 0;
            if (next >= tracks.size()) {
                next = AudioQueueModels.REPEAT_ALL.equals(config.repeatMode)
                    ? 0 : tracks.size() - 1;
            }
            epoch++;
            cancelInFlightLocked();
            currentIndex = next;
            currentStepIndex = 0;
            clearActiveStepLocked();
            errorCode = "";
            stateLock.notifyAll();
        }
        synthesizer.stopActivePlayback();
        publishSnapshot();
    }

    public void updateConfig(AudioConfig nextConfig, Integer sleepMinutes) {
        synchronized (stateLock) {
            if (nextConfig != null) {
                this.config = nextConfig;
            }
            if (sleepMinutes != null) {
                int mins = sleepMinutes;
                this.sleepDeadlineMs = mins > 0 ? (System.currentTimeMillis() + mins * 60_000L) : 0L;
            }
            stateLock.notifyAll();
        }
        publishSnapshot();
    }

    public void stopSession() {
        synchronized (stateLock) {
            serviceStopped = true;
            playState = STATE_IDLE;
            epoch++;
            cancelInFlightLocked();
            tracks = Collections.emptyList();
            currentIndex = 0;
            currentStepIndex = 0;
            clearActiveStepLocked();
            sleepDeadlineMs = 0L;
            resumeAfterTransientFocusLoss = false;
            releaseWakeLockLocked();
            unregisterNoisyReceiverSafe();
            abandonFocusLocked();
            if (mediaSession != null) {
                mediaSession.setActive(false);
            }
            stateLock.notifyAll();
        }
        synthesizer.stopActivePlayback();
        publishSnapshot();
        foregroundEntered = false;
        lastNotifKey = "";
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void clearActiveStepLocked() {
        activeStepRole = "";
        activeStepText = "";
        activeStepLang = "";
        activePairTarget = "";
        activePairBase = "";
    }

    private void runPlaybackLoop() {
        int consecutiveFailures = 0;
        int spokenStepsInTrack = 0;
        while (true) {
            final List<AudioTrackItem> curTracks;
            final AudioTrackItem item;
            final AudioConfig curConfig;
            final int trackIdx;
            final int stepIdx;
            final int totalSteps;
            final UtteranceStep step;
            final long startEpoch;
            final CallToken stepToken;

            synchronized (stateLock) {
                while (!serviceStopped && !STATE_PLAYING.equals(playState)) {
                    try { stateLock.wait(); } catch (InterruptedException ignored) {}
                }
                if (serviceStopped || STATE_IDLE.equals(playState)) {
                    workerStarted = false;
                    return;
                }
                curTracks = tracks;
                if (curTracks.isEmpty() || currentIndex < 0 || currentIndex >= curTracks.size()) {
                    playState = STATE_PAUSED;
                    clearActiveStepLocked();
                    releaseWakeLockLocked();
                    unregisterNoisyReceiverSafe();
                    publishSnapshot();
                    continue;
                }
                trackIdx = currentIndex;
                item = curTracks.get(trackIdx);
                curConfig = config;
                List<UtteranceStep> steps = AudioQueueModels.buildSteps(item, curConfig);
                if (steps.isEmpty()) {
                    advanceAfterTrackLocked();
                    continue;
                }
                if (currentStepIndex < 0 || currentStepIndex >= steps.size()) {
                    currentStepIndex = 0;
                }
                stepIdx = currentStepIndex;
                totalSteps = steps.size();
                if (stepIdx == 0) {
                    spokenStepsInTrack = 0;
                }
                startEpoch = epoch;
                step = steps.get(stepIdx);
                activeStepRole = step.role;
                activeStepText = step.text;
                activeStepLang = step.lang;
                activePairTarget = step.pairTarget;
                activePairBase = step.pairBase;

                stepToken = new CallToken();
                activeStepToken = stepToken;

                if (stepIdx == 0) {
                    schedulePrefetchForNext(curTracks, trackIdx, item, curConfig);
                }
            }

            publishSnapshot();

            SpeakOutcome outcome = synthesizer.speakNow(
                step.text, step.lang,
                step.speed > 0f ? step.speed : curConfig.speed,
                curConfig.preferOffline, stepToken
            );

            synchronized (stateLock) {
                if (activeStepToken == stepToken) activeStepToken = null;
                if (serviceStopped || !STATE_PLAYING.equals(playState) || epoch != startEpoch) {
                    continue;
                }
                if ("cancelled".equals(outcome.result)) {
                    continue;
                }
            }

            boolean stepSpoken = "spoken".equals(outcome.result);
            if (!stepSpoken) {
                synchronized (stateLock) {
                    errorCode = outcome.result;
                }
            } else {
                spokenStepsInTrack++;
                consecutiveFailures = 0;
                synchronized (stateLock) {
                    errorCode = "";
                }
            }

            // Hold pause interval cleanly on stateLock so pause/skip/stop wakes instantaneously
            if (step.pauseAfterMs > 0L) {
                long deadline = System.currentTimeMillis() + step.pauseAfterMs;
                synchronized (stateLock) {
                    while (!serviceStopped && STATE_PLAYING.equals(playState) && epoch == startEpoch) {
                        long remain = deadline - System.currentTimeMillis();
                        if (remain <= 0L) break;
                        try { stateLock.wait(remain); } catch (InterruptedException ignored) {}
                    }
                    if (serviceStopped || !STATE_PLAYING.equals(playState) || epoch != startEpoch) {
                        continue;
                    }
                }
            }

            boolean finishedTrack = false;
            boolean sleptOut = false;
            boolean finishedPlaylist = false;
            boolean abortForErrors = false;
            String errToReport = "";

            synchronized (stateLock) {
                if (serviceStopped || !STATE_PLAYING.equals(playState) || epoch != startEpoch) {
                    continue;
                }
                int nextStep = stepIdx + 1;
                if (nextStep < totalSteps) {
                    currentStepIndex = nextStep;
                    continue;
                }

                // Completed full track
                finishedTrack = true;
                if (spokenStepsInTrack > 0) {
                    consecutiveFailures = 0;
                    heardCount++;
                    completedSeq++;
                    lastCompletedConceptId = item.conceptId;
                } else {
                    consecutiveFailures++;
                    errToReport = outcome.result;
                }

                if (consecutiveFailures >= MAX_CONSECUTIVE_TRACK_FAILURES) {
                    abortForErrors = true;
                    errorCode = errToReport.isEmpty() ? "unavailable" : errToReport;
                    playState = STATE_PAUSED;
                    currentStepIndex = 0;
                    clearActiveStepLocked();
                    releaseWakeLockLocked();
                    unregisterNoisyReceiverSafe();
                    abandonFocusLocked();
                } else if (sleepDeadlineMs > 0L && System.currentTimeMillis() >= sleepDeadlineMs) {
                    sleptOut = true;
                    sleepDeadlineMs = 0L;
                    playState = STATE_PAUSED;
                    currentStepIndex = 0;
                    clearActiveStepLocked();
                    releaseWakeLockLocked();
                    unregisterNoisyReceiverSafe();
                    abandonFocusLocked();
                    advanceAfterTrackLocked();
                } else {
                    finishedPlaylist = !advanceAfterTrackLocked();
                }
            }

            if (abortForErrors || sleptOut || finishedPlaylist || finishedTrack) {
                publishSnapshot();
            }
        }
    }

    /** Advances currentIndex per repeatMode. Returns true if playback continues, false if playlist reached end. */
    private boolean advanceAfterTrackLocked() {
        currentStepIndex = 0;
        clearActiveStepLocked();
        if (tracks.isEmpty()) {
            playState = STATE_PAUSED;
            return false;
        }
        String repeat = config.repeatMode;
        if (AudioQueueModels.REPEAT_ONE.equals(repeat)) {
            return true;
        }
        int next = currentIndex + 1;
        if (next < tracks.size()) {
            currentIndex = next;
            return true;
        }
        if (AudioQueueModels.REPEAT_ALL.equals(repeat)) {
            currentIndex = 0;
            return true;
        }
        // Reached end of playlist cleanly -> reset cursor to 0 & pause
        currentIndex = 0;
        playState = STATE_PAUSED;
        releaseWakeLockLocked();
        unregisterNoisyReceiverSafe();
        abandonFocusLocked();
        return false;
    }

    private void schedulePrefetchForNext(
        List<AudioTrackItem> curTracks,
        int trackIdx,
        AudioTrackItem curItem,
        AudioConfig curConfig
    ) {
        if (activePrefetchToken != null) activePrefetchToken.cancel();
        final CallToken pToken = new CallToken();
        activePrefetchToken = pToken;

        final AudioTrackItem nextItem = (trackIdx + 1 < curTracks.size())
            ? curTracks.get(trackIdx + 1)
            : (AudioQueueModels.REPEAT_ALL.equals(curConfig.repeatMode) && !curTracks.isEmpty() ? curTracks.get(0) : null);

        prefetchExec.execute(() -> {
            // 1) Pre-warm remaining steps of the current track while step 0 plays
            List<UtteranceStep> curSteps = AudioQueueModels.buildSteps(curItem, curConfig);
            for (int i = 1; i < curSteps.size(); i++) {
                if (pToken.isCancelled()) return;
                UtteranceStep s = curSteps.get(i);
                synthesizer.prefetch(s.text, s.lang, curConfig.preferOffline, pToken);
            }
            // 2) Pre-warm steps of track K+1 for gapless transitions
            if (nextItem != null && !pToken.isCancelled()) {
                List<UtteranceStep> nextSteps = AudioQueueModels.buildSteps(nextItem, curConfig);
                for (UtteranceStep s : nextSteps) {
                    if (pToken.isCancelled()) return;
                    synthesizer.prefetch(s.text, s.lang, curConfig.preferOffline, pToken);
                }
            }
        });
    }

    private void cancelInFlightLocked() {
        if (activeStepToken != null) {
            activeStepToken.cancel();
            activeStepToken = null;
        }
        if (activePrefetchToken != null) {
            activePrefetchToken.cancel();
            activePrefetchToken = null;
        }
    }

    private boolean requestFocusLocked() {
        if (audioManager == null) return true;
        int rc;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                    .setOnAudioFocusChangeListener(focusListener)
                    .build();
            }
            rc = audioManager.requestAudioFocus(focusRequest);
        } else {
            rc = audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        return rc == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonFocusLocked() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
            try { audioManager.abandonAudioFocusRequest(focusRequest); } catch (Throwable ignored) {}
        } else {
            try { audioManager.abandonAudioFocus(focusListener); } catch (Throwable ignored) {}
        }
    }

    private void acquireWakeLockLocked() {
        if (wakeLock != null && !wakeLock.isHeld()) {
            try { wakeLock.acquire(WAKELOCK_TIMEOUT_MS); } catch (Throwable ignored) {}
        }
    }

    private void releaseWakeLockLocked() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Throwable ignored) {}
        }
    }

    private void registerNoisyReceiverSafe() {
        if (noisyRegistered) return;
        try {
            ContextCompat.registerReceiver(
                this,
                noisyReceiver,
                new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                ContextCompat.RECEIVER_NOT_EXPORTED
            );
            noisyRegistered = true;
        } catch (Throwable ignored) {}
    }

    private void unregisterNoisyReceiverSafe() {
        if (!noisyRegistered) return;
        noisyRegistered = false;
        try { unregisterReceiver(noisyReceiver); } catch (Throwable ignored) {}
    }

    private void setupMediaSession() {
        mediaSession = new MediaSessionCompat(this, "DictLearnAudio");
        PendingIntent sessionPi = buildOpenAudioPendingIntent();
        if (sessionPi != null) {
            mediaSession.setSessionActivity(sessionPi);
        }
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { resumePlayback(); }
            @Override public void onPause() { pausePlayback(false); }
            @Override public void onSkipToNext() { nextTrack(); }
            @Override public void onSkipToPrevious() { prevTrack(); }
            @Override public void onStop() { stopSession(); }
        });
    }

    private PendingIntent buildOpenAudioPendingIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) {
            launch = new Intent(Intent.ACTION_MAIN);
            launch.addCategory(Intent.CATEGORY_LAUNCHER);
            launch.setPackage(getPackageName());
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        launch.putExtra(EXTRA_OPEN_AUDIO, true);
        return PendingIntent.getActivity(
            this, 10, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    static String formatStepRoleLabel(String role) {
        if ("meaning".equals(role)) return "Nghĩa";
        if ("word".equals(role)) return "Từ mới";
        if ("repeat".equals(role)) return "Nhắc lại";
        if ("ex_base".equals(role)) return "Dịch VD";
        if ("ex_target".equals(role)) return "Ví dụ";
        if ("drill_base".equals(role)) return "Dịch câu";
        if ("drill_target".equals(role)) return "Công sở";
        return "";
    }

    static String formatNotifTitle(AudioSnapshot s) {
        if (s == null || s.word.isEmpty()) return "Nghe thụ động · dict-learn";
        StringBuilder sb = new StringBuilder(s.word);
        String phonetic = !s.romaji.isEmpty() ? s.romaji : s.ipa;
        if (!phonetic.isEmpty() && (s.word.length() + phonetic.length() + s.meaning.length() <= 46)) {
            sb.append(" (").append(phonetic).append(")");
        }
        if (!s.meaning.isEmpty()) {
            sb.append(" — ").append(s.meaning);
        }
        return sb.toString();
    }

    static String formatNotifBody(AudioSnapshot s) {
        if (s == null) return "Đang chuẩn bị danh sách phát";
        if (!s.exTarget.isEmpty() && !s.exBase.isEmpty()) {
            return s.exTarget + " — " + s.exBase;
        }
        if (!s.exTarget.isEmpty()) return s.exTarget;
        if (!s.exBase.isEmpty()) return s.exBase;
        if (!s.meaning.isEmpty() && s.total > 0) {
            return s.meaning + " · " + (s.index + 1) + "/" + s.total;
        }
        if (s.total > 0) return "Từ " + (s.index + 1) + "/" + s.total;
        return "Đang chuẩn bị danh sách phát";
    }

    static String formatNotifSubText(AudioSnapshot s) {
        if (s == null) return "Nghe thụ động";
        StringBuilder sb = new StringBuilder();
        if (s.total > 0) {
            sb.append(s.index + 1).append("/").append(s.total);
        }
        String role = formatStepRoleLabel(s.stepRole);
        if (!role.isEmpty()) {
            if (sb.length() > 0) sb.append(" · ");
            sb.append(role);
        }
        if (!s.romaji.isEmpty() || !s.ipa.isEmpty()) {
            String phonetic = !s.romaji.isEmpty() ? s.romaji : s.ipa;
            if (!formatNotifTitle(s).contains(phonetic)) {
                if (sb.length() > 0) sb.append(" · ");
                sb.append(phonetic);
            }
        }
        return sb.length() > 0 ? sb.toString() : "Nghe thụ động";
    }

    private static String notifKeyFor(AudioSnapshot s) {
        return s.status + "|" + s.index + "|" + s.total + "|" + s.conceptId
            + "|" + s.word + "|" + s.meaning + "|" + s.exTarget + "|" + s.exBase + "|" + s.stepRole;
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notificationManager != null) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID,
                "Nghe thụ động từ vựng",
                NotificationManager.IMPORTANCE_LOW
            );
            ch.setDescription("Điều khiển phát âm thanh từ vựng & ví dụ song ngữ chạy ngầm");
            ch.setShowBadge(false);
            ch.setSound(null, null);
            notificationManager.createNotificationChannel(ch);
        }
    }

    private void enterForegroundNow() {
        AudioSnapshot s = buildSnapshot();
        Notification n = buildNotification(s);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
        foregroundEntered = true;
        lastNotifKey = notifKeyFor(s);
    }

    private Notification buildNotification(AudioSnapshot s) {
        PendingIntent contentPi = buildOpenAudioPendingIntent();

        boolean isPlaying = STATE_PLAYING.equals(s.status);
        String title = formatNotifTitle(s);
        String body = formatNotifBody(s);
        String subText = formatNotifSubText(s);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_dict_audio)
            .setContentTitle(title)
            .setContentText(body)
            .setSubText(subText)
            .setContentIntent(contentPi)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(isPlaying)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .addAction(R.drawable.ic_media_prev, "Trước", serviceActionPi(ACTION_PREV, 1))
            .addAction(
                isPlaying ? R.drawable.ic_media_pause : R.drawable.ic_media_play,
                isPlaying ? "Tạm dừng" : "Phát",
                serviceActionPi(ACTION_PLAY_PAUSE, 2)
            )
            .addAction(R.drawable.ic_media_next, "Tiếp", serviceActionPi(ACTION_NEXT, 3))
            .addAction(R.drawable.ic_media_stop, "Dừng", serviceActionPi(ACTION_STOP, 4))
            .setStyle(new MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));

        return b.build();
    }

    private PendingIntent serviceActionPi(String action, int reqCode) {
        Intent intent = new Intent(this, AudioLearningService.class).setAction(action);
        return PendingIntent.getService(
            this, reqCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private void updateMediaSession(AudioSnapshot s) {
        if (mediaSession == null) return;
        boolean isPlaying = STATE_PLAYING.equals(s.status);
        int pbState = isPlaying ? PlaybackStateCompat.STATE_PLAYING
            : (STATE_PAUSED.equals(s.status) ? PlaybackStateCompat.STATE_PAUSED : PlaybackStateCompat.STATE_STOPPED);
        long actions = PlaybackStateCompat.ACTION_PLAY
            | PlaybackStateCompat.ACTION_PAUSE
            | PlaybackStateCompat.ACTION_PLAY_PAUSE
            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
            | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            | PlaybackStateCompat.ACTION_STOP;
        mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(pbState, s.index, isPlaying ? s.speed : 0f)
            .build());

        String title = formatNotifTitle(s);
        String body = formatNotifBody(s);
        String sub = formatNotifSubText(s);
        StringBuilder desc = new StringBuilder();
        if (!s.exTarget.isEmpty()) desc.append(s.exTarget);
        if (!s.exBase.isEmpty()) {
            if (desc.length() > 0) desc.append('\n');
            desc.append(s.exBase);
        }

        MediaMetadataCompat.Builder mb = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, body)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, body)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, sub)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_DESCRIPTION, desc.toString());
        mediaSession.setMetadata(mb.build());
    }

    private AudioSnapshot buildSnapshot() {
        synchronized (stateLock) {
            int total = tracks.size();
            int safeIdx = total > 0 ? Math.max(0, Math.min(currentIndex, total - 1)) : 0;
            AudioTrackItem cur = total > 0 ? tracks.get(safeIdx) : null;
            long sleepRem = sleepDeadlineMs > 0L ? Math.max(0L, sleepDeadlineMs - System.currentTimeMillis()) : 0L;
            String ro = cur != null ? cur.romaji : "";
            String ipa = cur != null ? cur.ipa : "";
            String exT = !activePairTarget.isEmpty() ? activePairTarget : (cur != null ? cur.exTarget : "");
            String exB = !activePairBase.isEmpty() ? activePairBase : (cur != null ? cur.exBase : "");
            return new AudioSnapshot(
                playState,
                safeIdx,
                total,
                cur != null ? cur.conceptId : "",
                cur != null ? cur.word : "",
                cur != null ? cur.meaning : "",
                ro,
                ipa,
                exT,
                exB,
                activeStepRole,
                activeStepText,
                activeStepLang,
                config.preset,
                config.order,
                config.targetRepeat,
                config.speed,
                config.repeatMode,
                config.includeDrills,
                config.preferOffline,
                sleepRem,
                heardCount,
                completedSeq,
                lastCompletedConceptId,
                errorCode
            );
        }
    }

    private void publishSnapshot() {
        AudioSnapshot s = buildSnapshot();
        lastSnapshot = s;
        updateMediaSession(s);
        String nKey = notifKeyFor(s);
        if (foregroundEntered && notificationManager != null && !STATE_IDLE.equals(s.status)
            && !nKey.equals(lastNotifKey)) {
            lastNotifKey = nKey;
            try {
                notificationManager.notify(NOTIFICATION_ID, buildNotification(s));
            } catch (Throwable ignored) {}
        }
        Listener l = externalListener;
        if (l != null) {
            l.onAudioState(s);
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        String st;
        synchronized (stateLock) { st = playState; }
        // Keep playing if actively listening like an audio app; clean up if already paused/idle.
        if (!STATE_PLAYING.equals(st)) {
            stopSession();
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (activeInstance == this) {
            activeInstance = null;
        }
        synchronized (stateLock) {
            serviceStopped = true;
            cancelInFlightLocked();
            releaseWakeLockLocked();
            unregisterNoisyReceiverSafe();
            abandonFocusLocked();
            stateLock.notifyAll();
        }
        if (mediaSession != null) {
            try { mediaSession.release(); } catch (Throwable ignored) {}
        }
        playbackExec.shutdownNow();
        prefetchExec.shutdownNow();
        super.onDestroy();
    }
}
