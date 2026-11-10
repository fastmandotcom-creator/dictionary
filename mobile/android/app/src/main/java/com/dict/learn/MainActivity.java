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

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        // Local native plugin (not part of the @capacitor/* npm modules, so it is not
        // in the generated capacitor.plugins.json registry). registerPlugin() adds it to
        // the same bridge that super.onCreate() builds, so JS reaches it as
        // window.DictTTS after Capacitor.Plugins registration.
        registerPlugin(com.dict.learn.tts.DictTTSPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
