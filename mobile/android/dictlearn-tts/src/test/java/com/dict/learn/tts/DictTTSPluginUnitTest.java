package com.dict.learn.tts;

import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.file.Files;

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
}
