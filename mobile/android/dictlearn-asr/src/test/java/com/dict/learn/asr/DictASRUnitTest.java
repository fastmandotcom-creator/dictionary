package com.dict.learn.asr;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class DictASRUnitTest {

    @Test
    public void toBcp47_coversAllProductLanguages() {
        String[] codes = {
            "en", "vi", "zh", "ja", "ko", "hi", "es", "fr", "de", "pt", "ru", "ar",
            "bn", "id", "ms", "th", "tr", "it", "nl", "pl", "uk", "el", "cs", "sv",
            "da", "fi", "no", "hu", "ro", "he", "fa", "ur", "ta", "te", "sw"
        };
        for (String c : codes) {
            String tag = AsrSupport.toBcp47(c);
            assertTrue("expected regional tag for " + c + ", got " + tag, tag.contains("-"));
        }
        assertEquals("en-US", AsrSupport.toBcp47("en"));
        assertEquals("zh-CN", AsrSupport.toBcp47("zh"));
        assertEquals("nb-NO", AsrSupport.toBcp47("no"));
        assertEquals("he-IL", AsrSupport.toBcp47("he"));
        assertEquals("pt-BR", AsrSupport.toBcp47("pt-BR"));
        assertEquals("en-US", AsrSupport.toBcp47(""));
    }

    @Test
    public void mapSpeechError_handlesOfflineLanguageFallbackAndStandardCodes() {
        AsrSupport.MappedError noMatch = AsrSupport.mapSpeechError(AsrSupport.ERR_NO_MATCH);
        assertEquals("no-speech", noMatch.code);
        assertFalse(noMatch.retryableWithCloudFallback);

        AsrSupport.MappedError perm = AsrSupport.mapSpeechError(AsrSupport.ERR_INSUFFICIENT_PERMISSIONS);
        assertEquals("not-allowed", perm.code);

        AsrSupport.MappedError langOff = AsrSupport.mapSpeechError(AsrSupport.ERR_LANGUAGE_UNAVAILABLE);
        assertEquals("language-not-supported", langOff.code);
        assertTrue(langOff.retryableWithCloudFallback);

        AsrSupport.MappedError net = AsrSupport.mapSpeechError(AsrSupport.ERR_NETWORK);
        assertEquals("network", net.code);
    }

    @Test
    public void resolvePermissionState_followsAndroidRuntimeLifecycle() {
        assertEquals("granted", AsrSupport.resolvePermissionState(true, false, "denied"));
        assertEquals("prompt-with-rationale", AsrSupport.resolvePermissionState(false, true, "prompt"));
        assertEquals("denied", AsrSupport.resolvePermissionState(false, false, "denied"));
        assertEquals("prompt", AsrSupport.resolvePermissionState(false, false, "prompt"));
    }
}
