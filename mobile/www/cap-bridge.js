/* dict-learn Capacitor bridge adapter — Single Source of Truth.
 *
 * Capacitor Android without a JS bundler loads native-bridge.js + JSExport,
 * which populates `window.Capacitor.Plugins[name]` directly and defines
 * `Capacitor.isPluginAvailable(name)`, WITHOUT defining `Capacitor.registerPlugin`
 * (which only exists in bundled `@capacitor/core`). Calling `registerPlugin`
 * directly therefore returned null on Android APK builds, leaving native
 * plugins unreachable.
 *
 * This module checks `Capacitor.Plugins[name]` first, falls back to
 * `Capacitor.registerPlugin(name)` only when needed, normalizes Capacitor 8's
 * `Plugins.App`, and registers Android backbutton handlers on `document`
 * (matching native-bridge.js and AppPlugin.java).
 */
(function () {
  if (typeof window === "undefined") return;

  function capacitor() {
    return (typeof window.Capacitor !== "undefined" && window.Capacitor) ? window.Capacitor : null;
  }

  function getPlugin(name) {
    var cap = capacitor();
    if (!cap || !name) return null;
    if (cap.Plugins && cap.Plugins[name]) return cap.Plugins[name];
    if (typeof cap.registerPlugin === "function") {
      try { return cap.registerPlugin(name) || null; } catch (e) { return null; }
    }
    return null;
  }

  function isAvailable(name) {
    var cap = capacitor();
    if (!cap || !name) return false;
    var hasInPlugins = !!(cap.Plugins && Object.prototype.hasOwnProperty.call(cap.Plugins, name) && cap.Plugins[name]);
    if (hasInPlugins) {
      return typeof cap.isPluginAvailable === "function" ? !!cap.isPluginAvailable(name) : true;
    }
    var plugin = getPlugin(name);
    return !!(plugin && typeof cap.isPluginAvailable === "function" && cap.isPluginAvailable(name));
  }

  function resolve(name) {
    var cap = capacitor();
    var plugin = getPlugin(name);
    var available = !!(plugin && isAvailable(name));
    return { cap: cap, plugin: available ? plugin : null, available: available };
  }

  function getApp() {
    if (isAvailable("App")) return getPlugin("App");
    var cap = capacitor();
    return (cap && cap.App) ? cap.App : null;
  }

  function onBackButton(handler) {
    if (typeof handler !== "function") return;
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("backbutton", handler);
    }
  }

  window.CapBridge = {
    capacitor: capacitor,
    hasCapacitor: function () { return !!capacitor(); },
    getPlugin: getPlugin,
    isAvailable: isAvailable,
    resolve: resolve,
    getApp: getApp,
    onBackButton: onBackButton
  };
})();
