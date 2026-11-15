package com.dict.learn.tts;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * Pure domain models and cognitive cadence builder for passive audio learning.
 * Has zero Android framework dependencies so unit tests execute fast on JVM.
 */
public final class AudioQueueModels {

    public static final String PRESET_DEEP = "deep";
    public static final String PRESET_QUICK = "quick";
    public static final String PRESET_TARGET_ONLY = "target_only";

    public static final String ORDER_BASE_FIRST = "base_first";
    public static final String ORDER_TARGET_FIRST = "target_first";
    public static final int DEFAULT_TARGET_REPEAT = 2;

    public static final String REPEAT_NONE = "none";
    public static final String REPEAT_ONE = "one";
    public static final String REPEAT_ALL = "all";

    public static final int MAX_DRILLS_PER_TRACK = 2;

    private AudioQueueModels() {}

    public static final class AudioDrill {
        public final String target;
        public final String base;

        public AudioDrill(String target, String base) {
            this.target = safeTrim(target);
            this.base = safeTrim(base);
        }
    }

    public static final class AudioTrackItem {
        public final String conceptId;
        public final String word;
        public final String meaning;
        public final String romaji;
        public final String ipa;
        public final String exTarget;
        public final String exBase;
        public final String targetLang;
        public final String baseLang;
        public final List<AudioDrill> drills;

        public AudioTrackItem(
            String conceptId,
            String word,
            String meaning,
            String romaji,
            String ipa,
            String exTarget,
            String exBase,
            String targetLang,
            String baseLang,
            List<AudioDrill> drills
        ) {
            this.conceptId = safeTrim(conceptId);
            this.word = safeTrim(word);
            this.meaning = safeTrim(meaning);
            this.romaji = safeTrim(romaji);
            this.ipa = safeTrim(ipa);
            this.exTarget = safeTrim(exTarget);
            this.exBase = safeTrim(exBase);
            String tl = safeTrim(targetLang);
            String bl = safeTrim(baseLang);
            this.targetLang = tl.isEmpty() ? "en" : tl;
            this.baseLang = bl.isEmpty() ? "vi" : bl;
            this.drills = drills == null ? Collections.emptyList() : Collections.unmodifiableList(new ArrayList<>(drills));
        }
    }

    public static final class UtteranceStep {
        public final String role;
        public final String text;
        public final String lang;
        public final long pauseAfterMs;
        public final String pairTarget;
        public final String pairBase;

        public UtteranceStep(String role, String text, String lang, long pauseAfterMs) {
            this(role, text, lang, pauseAfterMs, "", "");
        }

        public UtteranceStep(
            String role,
            String text,
            String lang,
            long pauseAfterMs,
            String pairTarget,
            String pairBase
        ) {
            this.role = role;
            this.text = text;
            this.lang = lang;
            this.pauseAfterMs = Math.max(0L, Math.min(10_000L, pauseAfterMs));
            this.pairTarget = safeTrim(pairTarget);
            this.pairBase = safeTrim(pairBase);
        }
    }

    public static final class AudioConfig {
        public final String preset;
        public final String order;
        public final int targetRepeat;
        public final float speed;
        public final String repeatMode;
        public final boolean includeDrills;
        public final boolean preferOffline;

        public AudioConfig(
            String preset,
            float speed,
            String repeatMode,
            boolean includeDrills,
            boolean preferOffline
        ) {
            this(preset, ORDER_BASE_FIRST, DEFAULT_TARGET_REPEAT, speed, repeatMode, includeDrills, preferOffline);
        }

        public AudioConfig(
            String preset,
            String order,
            int targetRepeat,
            float speed,
            String repeatMode,
            boolean includeDrills,
            boolean preferOffline
        ) {
            this.preset = normalizePreset(preset);
            this.order = normalizeOrder(order);
            this.targetRepeat = clampTargetRepeat(targetRepeat);
            this.speed = clampSpeed(speed);
            this.repeatMode = normalizeRepeatMode(repeatMode);
            this.includeDrills = includeDrills;
            this.preferOffline = preferOffline;
        }

        public static AudioConfig defaults() {
            return new AudioConfig(
                PRESET_DEEP, ORDER_BASE_FIRST, DEFAULT_TARGET_REPEAT, 1.0f, REPEAT_NONE, false, false
            );
        }
    }

    public static String normalizePreset(String raw) {
        String p = safeTrim(raw).toLowerCase(Locale.US);
        if (PRESET_QUICK.equals(p)) return PRESET_QUICK;
        if (PRESET_TARGET_ONLY.equals(p)) return PRESET_TARGET_ONLY;
        return PRESET_DEEP;
    }

    public static String normalizeOrder(String raw) {
        String o = safeTrim(raw).toLowerCase(Locale.US);
        if (ORDER_TARGET_FIRST.equals(o)) return ORDER_TARGET_FIRST;
        return ORDER_BASE_FIRST;
    }

    public static int clampTargetRepeat(int raw) {
        if (raw < 1) return 1;
        if (raw > 3) return 3;
        return raw;
    }

    public static String normalizeRepeatMode(String raw) {
        String r = safeTrim(raw).toLowerCase(Locale.US);
        if (REPEAT_ONE.equals(r)) return REPEAT_ONE;
        if (REPEAT_ALL.equals(r)) return REPEAT_ALL;
        return REPEAT_NONE;
    }

    public static float clampSpeed(float raw) {
        if (Float.isNaN(raw) || Float.isInfinite(raw) || raw <= 0f) return 1.0f;
        return Math.max(0.65f, Math.min(1.50f, raw));
    }

    public static long scalePause(long baseMs, float speed) {
        float divisor = Math.max(0.85f, Math.min(1.25f, clampSpeed(speed)));
        long scaled = Math.round(baseMs / divisor);
        return Math.max(300L, Math.min(2500L, scaled));
    }

    /**
     * Build ordered playback steps for one vocabulary item according to preset,
     * language order (`base_first` default vs `target_first`), and target repeat count
     * (default 2x so the learner absorbs meaning then shadows the foreign pronunciation).
     */
    public static List<UtteranceStep> buildSteps(AudioTrackItem item, AudioConfig config) {
        List<UtteranceStep> out = new ArrayList<>();
        if (item == null || item.word.isEmpty()) return out;

        AudioConfig cfg = config == null ? AudioConfig.defaults() : config;
        String preset = cfg.preset;
        String order = PRESET_TARGET_ONLY.equals(preset) ? ORDER_TARGET_FIRST : cfg.order;
        int repeatCount = cfg.targetRepeat;
        float speed = cfg.speed;
        boolean includePrimary = !PRESET_TARGET_ONLY.equals(preset);

        // 1) Core word <-> primary meaning
        appendPairSteps(
            out,
            includePrimary ? item.meaning : "",
            "meaning",
            item.baseLang,
            item.word,
            "word",
            "repeat",
            item.targetLang,
            order,
            repeatCount,
            speed,
            true,
            item.exTarget,
            item.exBase
        );

        if (PRESET_QUICK.equals(preset)) {
            return out;
        }

        // 2) Aligned bilingual example
        if (!item.exTarget.isEmpty()) {
            appendPairSteps(
                out,
                includePrimary ? item.exBase : "",
                "ex_base",
                item.baseLang,
                item.exTarget,
                "ex_target",
                "ex_target",
                item.targetLang,
                order,
                repeatCount,
                speed,
                false,
                item.exTarget,
                item.exBase
            );
        }

        // 3) Optional situational drills
        if (cfg.includeDrills) {
            int added = 0;
            for (AudioDrill d : item.drills) {
                if (added >= MAX_DRILLS_PER_TRACK) break;
                if (!d.target.isEmpty() && !d.target.equalsIgnoreCase(item.exTarget)) {
                    appendPairSteps(
                        out,
                        includePrimary ? d.base : "",
                        "drill_base",
                        item.baseLang,
                        d.target,
                        "drill_target",
                        "drill_target",
                        item.targetLang,
                        order,
                        repeatCount,
                        speed,
                        false,
                        "💼 " + d.target,
                        d.base
                    );
                    added++;
                }
            }
        }
        return out;
    }

    private static void appendPairSteps(
        List<UtteranceStep> out,
        String primaryText,
        String primaryRole,
        String primaryLang,
        String targetText,
        String targetFirstRole,
        String targetRepeatRole,
        String targetLang,
        String order,
        int repeatCount,
        float speed,
        boolean isWordBlock,
        String pairTarget,
        String pairBase
    ) {
        if (targetText.isEmpty()) return;
        boolean hasPrimary = !primaryText.isEmpty() && !primaryText.equalsIgnoreCase(targetText);
        long repeatGap = scalePause(isWordBlock ? 750L : 700L, speed);
        long blockEnd = scalePause(isWordBlock ? 1250L : 1100L, speed);
        long afterPrimaryCue = scalePause(isWordBlock ? 650L : 550L, speed);
        long recallBeforePrimary = scalePause(isWordBlock ? 1050L : 600L, speed);

        if (!hasPrimary) {
            for (int i = 0; i < repeatCount; i++) {
                String role = i == 0 ? targetFirstRole : targetRepeatRole;
                long pause = (i < repeatCount - 1) ? repeatGap : blockEnd;
                out.add(new UtteranceStep(role, targetText, targetLang, pause, pairTarget, pairBase));
            }
            return;
        }

        if (ORDER_BASE_FIRST.equals(order)) {
            out.add(new UtteranceStep(primaryRole, primaryText, primaryLang, afterPrimaryCue, pairTarget, pairBase));
            for (int i = 0; i < repeatCount; i++) {
                String role = i == 0 ? targetFirstRole : targetRepeatRole;
                long pause = (i < repeatCount - 1) ? repeatGap : blockEnd;
                out.add(new UtteranceStep(role, targetText, targetLang, pause, pairTarget, pairBase));
            }
            return;
        }

        // ORDER_TARGET_FIRST: test recognition/recall first, then anchor on remaining target repeats
        if (repeatCount <= 1) {
            out.add(new UtteranceStep(targetFirstRole, targetText, targetLang, recallBeforePrimary, pairTarget, pairBase));
            out.add(new UtteranceStep(primaryRole, primaryText, primaryLang, blockEnd, pairTarget, pairBase));
            return;
        }

        int preCount = repeatCount - 1;
        for (int i = 0; i < preCount; i++) {
            String role = i == 0 ? targetFirstRole : targetRepeatRole;
            long pause = (i < preCount - 1) ? repeatGap : recallBeforePrimary;
            out.add(new UtteranceStep(role, targetText, targetLang, pause, pairTarget, pairBase));
        }
        out.add(new UtteranceStep(primaryRole, primaryText, primaryLang, scalePause(550L, speed), pairTarget, pairBase));
        out.add(new UtteranceStep(targetRepeatRole, targetText, targetLang, blockEnd, pairTarget, pairBase));
    }

    private static String safeTrim(String s) {
        return s == null ? "" : s.trim();
    }
}
