/* dict-learn auto-update (v1.1)
 *
 * In-app update channel for APK distribution via GitHub Releases.
 *  - ON by default: checks GitHub "latest release" daily (unauth API rate
 *    limit is 60 req/hour/IP — one check a day is far inside that).
 *  - When a newer version exists, Home shows a banner with a Download
 *    button that opens the release page in an in-app browser
 *    (Capacitor Browser when available, else a new tab). Android does not
 *    allow an app to silently replace itself, so "automatic" = automatic
 *    detection + one-tap install; SRS progress survives the overwrite.
 *  - The user can switch auto-check OFF in Settings (localStorage keeps
 *    the choice; the "checked" default applies only to first launch).
 *
 * This module is self-contained and defensive: if version.json, the
 * GitHub API, or any element is missing it degrades to a no-op, so the
 * app (and the DOM test harness) still boot cleanly.
 */
(function () {
  if (typeof window === "undefined") return;
  var REPO = "fastmandotcom-creator/dictionary";
  var DAILY = 24 * 60 * 60 * 1000;
  var LS_PREF = "dictlearn_autoupdate";      // "on" | "off" ; default ON
  var LS_LAST = "dictlearn_autoupdate_last"; // ms timestamp of last check
  var LS_DISMISS = "dictlearn_autoupd_dismiss"; // ms timestamp of banner dismiss

  var Api = {
    currentVersion: "0.0.0",
    channelURL: "https://github.com/" + REPO + "/releases",
    _prefEl: null, _bannerEl: null,

    pref: function () {
      try {
        var v = localStorage.getItem(LS_PREF);
        return v === "off" ? "off" : "on"; // default ON
      } catch (e) { return "on"; }
    },
    setPref: function (v) {
      try { localStorage.setItem(LS_PREF, v); } catch (e) {}
      this.renderBanner();
    },

    // Compare semver-style strings: 1.10.0 > 1.9.0 (numeric, not lex).
    isNewer: function (a, b) {
      var pa = String(a || "0").split(".").map(function (x) { return parseInt(x, 10) || 0; });
      var pb = String(b || "0").split(".").map(function (x) { return parseInt(x, 10) || 0; });
      for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
        var da = pa[i] || 0, db = pb[i] || 0;
        if (da > db) return true;
        if (da < db) return false;
      }
      return false;
    },

    due: function () {
      try {
        var last = parseInt(localStorage.getItem(LS_LAST) || "0", 10);
        return Date.now() - last >= DAILY;
      } catch (e) { return true; }
    },

    // Read the bundled version (version.json ships inside the APK), falling
    // back to the Capacitor App plugin, then to 0.0.0.
    loadMeta: function () {
      var self = this;
      return fetch("version.json").then(function (r) {
        if (!r.ok) throw new Error("no version.json");
        return r.json();
      }).then(function (v) {
        self.currentVersion = v.version || "0.0.0";
        if (v.channel) self.channelURL = v.channel;
        self._renderVersionLine();
      }, function () {
        if (typeof Capacitor !== "undefined" && Capacitor.App) {
          return Capacitor.App.getInfo().then(function (i) {
            self.currentVersion = i.version || "0.0.0";
            self._renderVersionLine();
          });
        }
        return null;
      });
    },

    _renderVersionLine: function () {
      var el = document.getElementById("verline");
      if (el) el.textContent = "v" + this.currentVersion + " · cập nhật tự động: " + (this.pref() === "on" ? "BẬT" : "TẮT");
    },

    // Ask GitHub for the latest release + its .apk asset.
    fetchLatest: function () {
      var self = this;
      return fetch("https://api.github.com/repos/" + REPO + "/releases/latest", {
        headers: { "User-Agent": "dict-learn-app" }
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (rel) {
        var tag = (rel.tag_name || "").replace(/^v/, "");
        var apk = null;
        (rel.assets || []).forEach(function (a) {
          if (/\.apk$/i.test(a.name)) apk = a.browser_download_url;
        });
        return { version: tag, notes: rel.name || "", url: rel.html_url || self.channelURL, apk: apk };
      });
    },

    check: function (force) {
      var self = this;
      if (!force && this.pref() !== "on") return Promise.resolve(null);
      return this.fetchLatest().then(function (rel) {
        try { if (!force) localStorage.setItem(LS_LAST, String(Date.now())); } catch (e) {}
        if (!rel.version || !self.isNewer(rel.version, self.currentVersion)) {
          self._toastOk();
          return null;
        }
        if (self.pref() === "on" || force) self._renderBanner(rel);
        else self._toastOk(); // never reachable: a newer version always shows the banner on manual check
        return rel;
      }, function () {
        // Offline / rate-limited: stay silent, retry tomorrow. No spam.
        return null;
      });
    },

    _toastOk: function () {
      var el = document.getElementById("toast");
      if (!el) return;
      el.textContent = "App đã là phiên bản mới nhất.";
      el.className = "ok";
      el.classList.remove("hidden");
      if (el._timer) clearTimeout(el._timer);
      el._timer = setTimeout(function () { el.classList.add("hidden"); }, 2200);
    },

    _renderBanner: function (rel) {
      var b = document.getElementById("update-banner");
      if (!b) return;
      b.innerHTML =
        '<div class="ub-title">🆕 Phiên bản mới v' + rel.version + "</div>" +
        '<div class="ub-notes">' + escapeHtml(rel.notes || "Cải tiến giao diện và dữ liệu từ vựng.") + "</div>" +
        '<div class="ub-row">' +
        '<button id="ub-dl" class="primary">⬇ Tải bản mới</button>' +
        '<button id="ub-dismiss" class="ghost">Để sau</button>' +
        "</div>";
      b.classList.remove("hidden");
      var dl = document.getElementById("ub-dl");
      var dis = document.getElementById("ub-dismiss");
      if (dl) dl.onclick = function () { self.openDownload(rel); };
      if (dis) dis.onclick = function () {
        try { localStorage.setItem(LS_DISMISS, String(Date.now())); } catch (e) {}
        b.classList.add("hidden");
      };
    },

    // Re-evaluate banner state (called on Home render): only show when
    // enabled, not dismissed today, and newer version known.
    renderBanner: function () {
      var b = document.getElementById("update-banner");
      if (!b) return;
      if (this.pref() === "off") { b.classList.add("hidden"); return; }
      var last = 0;
      try { last = parseInt(localStorage.getItem(LS_DISMISS) || "0", 10); } catch (e) {}
      if (Date.now() - last < DAILY && b.innerHTML) { b.classList.add("hidden"); return; }
    },

    openDownload: function (rel) {
      var url = (rel && rel.apk) ? rel.apk : ((rel && rel.url) || this.channelURL);
      if (typeof Capacitor !== "undefined" && Capacitor.Plugins && Capacitor.Plugins.Browser) {
        Capacitor.Plugins.Browser.open({ url: url, presentation: "fullscreen" });
        return;
      }
      if (typeof Capacitor !== "undefined" && Capacitor.App && Capacitor.App.openUrl) {
        Capacitor.App.openUrl({ url: url });
        return;
      }
      try { window.open(url, "_blank", "noopener"); }
      catch (e) {
        try { window.location.href = url; } catch (e2) {}
      }
    },

    mount: function () {
      var self = this;
      var p = document.getElementById("autoupd");
      if (p) {
        p.classList.add("switch");
        p.checked = this.pref() === "on";
        p.onchange = function () {
          self.setPref(p.checked ? "on" : "off");
          if (p.checked) self.check();
        };
      }
      var c = document.getElementById("checkupd");
      if (c) c.onclick = function () {
        c.disabled = true;
        c.textContent = "Đang kiểm tra…";
        self.check(true).then(function () { // forced manual check
          c.disabled = false;
          c.textContent = "Kiểm tra ngay";
        });
      };
      var s = document.getElementById("setbtn");
      if (s) s.onclick = function () {
        var card = document.querySelector(".settings-card");
        if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      this.loadMeta().then(function () {
        self._renderVersionLine();
        // Daily auto-check (ON by default).
        if (self.pref() === "on" && self.due()) self.check();
      });
    }
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }

  window.AppUpdate = Api;
  // Boot: if DOM is ready, mount now; otherwise wait for DOMContentLoaded.
  if (document.getElementById && document.getElementById("autoupd")) Api.mount();
  else if (document.addEventListener) document.addEventListener("DOMContentLoaded", function () { Api.mount(); });
})();
