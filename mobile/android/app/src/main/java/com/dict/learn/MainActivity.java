package com.dict.learn;

import com.getcapacitor.BridgeActivity;

/**
 * dict-learn MainActivity.
 *
 * Native plugins (@capacitor/app, @capacitor/browser) are auto-registered from
 * the generated capacitor.plugins.json registry that `cap sync` writes into the
 * assets; the JS layer feature-detects Capacitor.Plugins.* and falls back to
 * window.open on pure-web (PWA) installs. No manual registerPlugin needed.
 */
import com.dict.learn.tts.DictTTSPlugin;
import com.dict.learn.update.DictUpdatePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        // Local native plugins (not part of the @capacitor/* npm modules, so they are not in the
        // generated capacitor.plugins.json registry). registerPlugin() adds them to the same
        // bridge that super.onCreate() builds, so JS reaches them as window.DictTTS / window.DictUpdate.
        registerPlugin(com.dict.learn.tts.DictTTSPlugin.class);
        registerPlugin(com.dict.learn.update.DictUpdatePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
