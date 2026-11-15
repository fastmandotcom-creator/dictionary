package com.dict.learn.tts;

import com.dict.learn.tts.AudioQueueModels.AudioConfig;
import com.dict.learn.tts.AudioQueueModels.AudioDrill;
import com.dict.learn.tts.AudioQueueModels.AudioTrackItem;
import com.dict.learn.tts.AudioQueueModels.UtteranceStep;

import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class DictTTSPluginUnitTest {

    private static void writeLe32(ByteArrayOutputStream out, int v) {
        out.write(v & 0xFF);
        out.write((v >> 8) & 0xFF);
        out.write((v >> 16) & 0xFF);
        out.write((v >> 24) & 0xFF);
    }

    private static void writeLe16(ByteArrayOutputStream out, int v) {
        out.write(v & 0xFF);
        out.write((v >> 8) & 0xFF);
    }

    @Test
    public void normalizeWav_parsesSubchunksAfterRiffHeader_andPreservesSignedSamples() throws Exception {
        // Construct a valid RIFF/WAVE with a JUNK chunk before data, and quiet
        // positive/negative samples whose low bytes have bit 7 set (>= 0x80).
        // Old bug #1: pos started at 0 ("RIFF") and skipped the entire file!
        // Old bug #2: low byte wasn't masked with & 0xFF, corrupting high bytes!
        short[] samples = new short[] { 0x0180, -0x0180, 0x0290, -0x0290, 0x03A0, -0x03A0 }; // max peak = 928
        byte[] junk = new byte[] { 1, 2, 3, 4 };

        ByteArrayOutputStream body = new ByteArrayOutputStream();
        // fmt chunk (16 bytes PCM 16-bit mono 16kHz)
        body.write("fmt ".getBytes("US-ASCII"));
        writeLe32(body, 16);
        writeLe16(body, 1);
        writeLe16(body, 1);
        writeLe32(body, 16000);
        writeLe32(body, 32000);
        writeLe16(body, 2);
        writeLe16(body, 16);
        // JUNK subchunk to ensure chunk walker advances past non-data chunks
        body.write("JUNK".getBytes("US-ASCII"));
        writeLe32(body, junk.length);
        body.write(junk);
        // data chunk
        body.write("data".getBytes("US-ASCII"));
        writeLe32(body, samples.length * 2);
        int dataOffset = 12 + body.size();
        for (short s : samples) writeLe16(body, s);

        ByteArrayOutputStream wav = new ByteArrayOutputStream();
        wav.write("RIFF".getBytes("US-ASCII"));
        writeLe32(wav, 4 + body.size());
        wav.write("WAVE".getBytes("US-ASCII"));
        wav.write(body.toByteArray());

        File f = Files.createTempFile("dicttts-test-", ".wav").toFile();
        try {
            Files.write(f.toPath(), wav.toByteArray());
            DictTTSPlugin.normalizeWav(f);
            byte[] out = Files.readAllBytes(f.toPath());
            int peak = 0;
            for (int i = 0; i < samples.length; i++) {
                int lo = out[dataOffset + 2 * i] & 0xFF;
                int hi = out[dataOffset + 2 * i + 1] & 0xFF;
                short v = (short) (lo | (hi << 8));
                // Sign must match original sample
                assertTrue("sign mismatch at " + i + ": got " + v, (samples[i] >= 0) ? v >= 0 : v < 0);
                peak = Math.max(peak, Math.abs((int) v));
            }
            // Expected peak ~ 0.92 * 32767 = 30145
            assertTrue("expected amplified peak > 25000, got " + peak, peak > 25000);
        } finally {
            f.delete();
        }
    }

    @Test
    public void buildSteps_presetsAndDrills_followCognitiveCadence() {
        AudioTrackItem track = new AudioTrackItem(
            "EXCUSE_ME",
            "excuse me",
            "xin lỗi",
            "",
            "",
            "Excuse me, can you show me the way?",
            "Xin lỗi, bạn có thể chỉ đường cho tôi được không?",
            "en",
            "vi",
            Arrays.asList(
                new AudioDrill("I will say excuse me first.", "Tôi sẽ nói xin lỗi trước."),
                new AudioDrill("Please say excuse me.", "Vui lòng nói xin lỗi."),
                new AudioDrill("Extra drill ignored.", "Bị bỏ qua vì giới hạn 2.")
            )
        );

        // Default (deep, base_first, targetRepeat=2): meaning -> word x2 -> ex_base -> ex_target x2
        List<UtteranceStep> deepDefault = AudioQueueModels.buildSteps(track, AudioConfig.defaults());
        assertEquals(6, deepDefault.size());
        assertEquals("meaning", deepDefault.get(0).role);
        assertEquals("vi", deepDefault.get(0).lang);
        assertEquals("word", deepDefault.get(1).role);
        assertEquals("en", deepDefault.get(1).lang);
        assertEquals("repeat", deepDefault.get(2).role);
        assertEquals("en", deepDefault.get(2).lang);
        assertEquals("ex_base", deepDefault.get(3).role);
        assertEquals("vi", deepDefault.get(3).lang);
        assertEquals("ex_target", deepDefault.get(4).role);
        assertEquals("en", deepDefault.get(4).lang);
        assertEquals("ex_target", deepDefault.get(5).role);
        assertEquals("en", deepDefault.get(5).lang);

        // Deep preset with drills (2 bilingual drills * 3 steps = +6 -> 12 steps total)
        List<UtteranceStep> deepDrills = AudioQueueModels.buildSteps(track, new AudioConfig("deep", 1.0f, "none", true, false));
        assertEquals(12, deepDrills.size());
        assertEquals("Excuse me, can you show me the way?", deepDrills.get(0).pairTarget);
        assertEquals("Xin lỗi, bạn có thể chỉ đường cho tôi được không?", deepDrills.get(0).pairBase);
        assertEquals("drill_base", deepDrills.get(6).role);
        assertEquals("💼 I will say excuse me first.", deepDrills.get(6).pairTarget);
        assertEquals("Tôi sẽ nói xin lỗi trước.", deepDrills.get(6).pairBase);
        assertEquals("drill_target", deepDrills.get(7).role);
        assertEquals("drill_target", deepDrills.get(8).role);
        assertEquals("drill_target", deepDrills.get(11).role);

        // Quick preset default (base_first, targetRepeat=2): meaning -> word -> repeat
        List<UtteranceStep> quickDefault = AudioQueueModels.buildSteps(track, new AudioConfig("quick", 1.0f, "none", true, false));
        assertEquals(3, quickDefault.size());
        assertEquals("meaning", quickDefault.get(0).role);
        assertEquals("word", quickDefault.get(1).role);
        assertEquals("repeat", quickDefault.get(2).role);
        assertEquals("Excuse me, can you show me the way?", quickDefault.get(0).pairTarget);
        assertEquals("Xin lỗi, bạn có thể chỉ đường cho tôi được không?", quickDefault.get(2).pairBase);

        // Configurable setting: base_first + targetRepeat=1
        List<UtteranceStep> quickSingle = AudioQueueModels.buildSteps(
            track, new AudioConfig("quick", "base_first", 1, 1.0f, "none", false, false)
        );
        assertEquals(2, quickSingle.size());
        assertEquals("meaning", quickSingle.get(0).role);
        assertEquals("word", quickSingle.get(1).role);

        // Configurable setting: target_first + targetRepeat=2 (word -> recall -> meaning -> repeat)
        List<UtteranceStep> targetFirst = AudioQueueModels.buildSteps(
            track, new AudioConfig("quick", "target_first", 2, 1.0f, "none", false, false)
        );
        assertEquals(3, targetFirst.size());
        assertEquals("word", targetFirst.get(0).role);
        assertEquals("meaning", targetFirst.get(1).role);
        assertEquals("repeat", targetFirst.get(2).role);

        // Target-only preset keeps only target-language items repeated 2x by default,
        // while visual pairTarget/pairBase stay bilingual for screen & notification display.
        List<UtteranceStep> targetOnly = AudioQueueModels.buildSteps(track, new AudioConfig("target_only", 1.0f, "none", true, false));
        for (UtteranceStep s : targetOnly) {
            assertEquals("en", s.lang);
        }
        assertEquals(8, targetOnly.size());
        assertEquals("word", targetOnly.get(0).role);
        assertEquals("repeat", targetOnly.get(1).role);
        assertEquals("ex_target", targetOnly.get(2).role);
        assertEquals("ex_target", targetOnly.get(3).role);
        assertEquals("Xin lỗi, bạn có thể chỉ đường cho tôi được không?", targetOnly.get(0).pairBase);
    }

    @Test
    public void notificationFormatting_includesWordMeaningAndBilingualExamples() {
        AudioLearningService.AudioSnapshot snap = new AudioLearningService.AudioSnapshot(
            AudioLearningService.STATE_PLAYING,
            0,
            30,
            "EXCUSE_ME",
            "excuse me",
            "xin lỗi",
            "",
            "/ɪkˈskjuːz miː/",
            "Excuse me, sir.",
            "Xin lỗi đã làm phiền.",
            "ex_target",
            "Excuse me, sir.",
            "en",
            "deep",
            "base_first",
            2,
            1.0f,
            "none",
            false,
            false,
            0L,
            0,
            0L,
            "",
            ""
        );
        String title = AudioLearningService.formatNotifTitle(snap);
        String body = AudioLearningService.formatNotifBody(snap);
        String sub = AudioLearningService.formatNotifSubText(snap);

        assertTrue("Title should include both word and meaning: " + title,
            title.contains("excuse me") && title.contains("xin lỗi"));
        assertTrue("Body should include both target example and base translation: " + body,
            body.contains("Excuse me, sir.") && body.contains("Xin lỗi đã làm phiền."));
        assertTrue("SubText should include queue progress and current step: " + sub,
            sub.contains("1/30") && sub.contains("Ví dụ"));
    }

    @Test
    public void trimCacheDir_evictsOldestFilesDownToLimit() throws Exception {
        File dir = Files.createTempDirectory("dicttts-lru-").toFile();
        try {
            File f1 = new File(dir, "old.mp3");
            File f2 = new File(dir, "mid.mp3");
            File f3 = new File(dir, "new.mp3");
            Files.write(f1.toPath(), new byte[100]);
            Files.write(f2.toPath(), new byte[100]);
            Files.write(f3.toPath(), new byte[100]);
            f1.setLastModified(1000L);
            f2.setLastModified(2000L);
            f3.setLastModified(3000L);

            int removed = TtsSynthesizer.trimCacheDir(dir, 250L, 200L);
            assertEquals(1, removed);
            assertFalse(f1.exists());
            assertTrue(f2.exists());
            assertTrue(f3.exists());
        } finally {
            File[] files = dir.listFiles();
            if (files != null) for (File f : files) f.delete();
            dir.delete();
        }
    }
}
