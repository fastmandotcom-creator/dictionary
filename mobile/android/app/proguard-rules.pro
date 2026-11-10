# M4: R8 rules for the dict-learn Capacitor APK.
#
# minifyEnabled + shrinkResources shrink the APK. Keep only what is resolved
# by name at runtime (reflection / JS bridge / WASM glue); let R8 drop the rest.

# --- Capacitor bridge: discovered by reflection, called from the WebView ---
-keep class com.getcapacitor.** { *; }
-keepclassmembers class com.getcapacitor.** { *; }
-keep class com.capacitorjs.** { *; }
# The methods the WebView invokes through the JavascriptInterface must survive.
-keepclassmembers class * implements android.webkit.JavascriptInterface { *; }
# Generated bridge plugins + their JS-facing methods.
-keepclassmembers class * extends com.getcapacitor.plugin.JSPlugin { *; }
-dontwarn com.getcapacitor.**
-dontwarn com.capacitorjs.**

# --- sql.js / Emscripten WASM glue (keeps native symbols it can't see) ----
-keep class org.sqljs.** { *; }
-keepclassmembers class org.sqljs.** { *; }
-dontwarn org.sqljs.**

# --- App's Manifest-declared components (system binds these by name) -------
-keep public class com.dict.learn.** { *; }

# Preserve annotation metadata R8 would otherwise strip.
-keepattributes *Annotation*
