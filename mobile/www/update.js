/* dict-learn auto-update (v1.5) — ported from duosub-study's update/AppUpdater
 * + data/AppUpdates.kt + data/UpdateReminders.kt.
 *
 * What duosub's design adds over the v1.1 banner:
 *  - update-info.json FIRST (GitHub's download hosts: no rate limit), with the
 *    api.github.com releases/latest as fallback;
 *  - GitHub host allowlist + HTTPS-only (never a non-GitHub address);
 *  - SHA-256 verification of the download + a size cap;
 *  - a security-critical floor (minimum_safe_version_code) that cannot be
 *    dismissed;
 *  - a weekly banner, not a daily one (releases can be daily); a per-version
 *    "Skip this version"; a 7-day quiet window after install/update;
 *  - on Android, a real in-app download → verify → PackageInstaller self-update
 *    (window.DictUpdate native plugin), Wi-Fi-only for automatic downloads.
 *  - The web/PWA build still degrades to the one-tap release-page download.
 *
 * The module is self-contained and defensive: with no native plugin, no
 * version.json, and no network it boots as a no-op (the DOM test harness).
 */
(function () {
  if (typeof window === "undefined") return;

  var REPO = "fastmandotcom-creator/dictionary";
  var DAILY = 24 * 60 * 60 * 1000;
  var WEEK = 7 * 24 * 60 * 60 * 1000;
  var SECURITY_DAILY_PERIOD = 3 * 24 * 60 * 60 * 1000; // 3 days
  var MAX_BYTES = 150 * 1024 * 1024; // duosub's cap

  var LS_PREF = "dictlearn_autoupdate";           // "on" | "off" ; default ON
  var LS_LAST = "dictlearn_autoupdate_last";      // ms of last GitHub check
  var LS_DISMISS = "dictlearn_autoupd_dismiss";   // ms of last banner dismiss
  // duosub reminder memory:
  var LS_REMVER = "dictlearn_upd_remver";         // version last shown
  var LS_REMOWN = "dictlearn_upd_remshown";       // ms it was shown
  var LS_SKIP = "dictlearn_upd_skip";            // version "Skip this version" hid
  var LS_SEC = "dictlearn_upd_secfix";           // security fix code first shown
  var LS_SECSINCE = "dictlearn_upd_secsince";     // ms that fix was first shown
  var LS_INSTALLED = "dictlearn_installed_at";    // when this app was installed/updated

  // GitHub's API, release pages and the hosts its release downloads redirect to.
  var ALLOWED_HOSTS = [
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com"
  ];

  var native = null;
  var nativeAvailable = false;

  var Api = {
    currentVersion: "0.0.0",
    currentVersionCode: 0,
    installedAtMs: 0,
    channelURL: "https://github.com/" + REPO + "/releases",
    updateInfoURL: "https://github.com/" + REPO + "/releases/latest/download/update-info.json",
    apiLatestURL: "https://api.github.com/repos/" + REPO + "/releases/latest",
    _native: null,
    _state: "idle",

    // --- preferences (unchanged surface) ------------------------------------
    pref: function () {
      try {
        var v = localStorage.getItem(LS_PREF);
        return v === "off" ? "off" : "on"; // default ON
      } catch (e) { return "on"; }
    },
    setPref: function (v) {
      try { localStorage.setItem(LS_PREF, v); } catch (e) {}
      this._renderVersionLine();
      // Turning auto-update off hides the banner (duosub: off sends nothing).
      this.renderBanner();
    },

    // Compare semver-style strings numerically: 1.10.0 > 1.9.0.
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
    isHostAllowed: function (urlStr) {
      try {
        var u = new URL(urlStr);
        var host = u.hostname.toLowerCase();
        return u.protocol === "https:" && ALLOWED_HOSTS.indexOf(host) >= 0;
      } catch (e) { return false; }
    },

    // The daily check may hit GitHub once a day; the banner is governed separately
    // by the reminder policy (weekly), so daily releases never bring a daily banner.
    due: function () {
      try {
        var last = parseInt(localStorage.getItem(LS_LAST) || "0", 10);
        return Date.now() - last >= DAILY;
      } catch (e) { return true; }
    },

    loadMeta: function () {
      var self = this;
      return fetch("version.json").then(function (r) {
        if (!r.ok) throw new Error("no version.json");
        return r.json();
      }).then(function (v) {
        self.currentVersion = v.version || "0.0.0";
        self.currentVersionCode = v.versionCode || 0;
        if (v.channel) self.channelURL = v.channel;
        self._rememberInstalled();
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

    // When this build first ran on this device (install/update quiet window).
    _rememberInstalled: function () {
      var self = this;
      var stored = 0;
      try { stored = parseInt(localStorage.getItem(LS_INSTALLED) || "0", 10); } catch (e) {}
      if (stored > 0) { self.installedAtMs = stored; return; }
      if (nativeAvailable && native && native.info) {
        native.info().then(function (i) {
          self.installedAtMs = i.lastUpdateTime || 0;
          try { localStorage.setItem(LS_INSTALLED, String(self.installedAtMs)); } catch (e) {}
        }).catch(function () {});
      }
    },

    _renderVersionLine: function () {
      var el = document.getElementById("verline");
      if (el) el.textContent = "v" + this.currentVersion + " · cập nhật tự động: " + (this.pref() === "on" ? "BẬT" : "TẮT");
    },

    // --- discovery: update-info.json first, then the API ---------------------
    fetchUpdateInfo: function () {
      var self = this;
      if (!self.isHostAllowed(self.updateInfoURL)) return Promise.resolve(null);
      return fetch(self.updateInfoURL, { headers: { "User-Agent": "dict-learn-app" } })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (info) {
          if (!info || info.schema !== 1) return null;
          var newerByCode = info.version_code > self.currentVersionCode;
          var newerByName = self.isNewer(info.version, self.currentVersion);
          if (!newerByCode && !newerByName) return null;
          var critical = self.currentVersionCode > 0 &&
            self.currentVersionCode < (info.minimum_safe_version_code || 0);
          return {
            version: info.version,
            versionCode: info.version_code,
            apkName: info.apk,
            // duosub's updateFromInfo download URL: the release's download host.
            apk: self.channelURL + "/download/v" + info.version + "/" + info.apk,
            sha256: info.sha256 || "",
            sizeBytes: info.size || 0,
            critical: critical,
            securityFixCode: critical ? info.minimum_safe_version_code : 0,
            viaInfo: true
          };
        }).catch(function () { return null; });
    },

    // The fallback path (unchanged behaviour, kept for harness + info-less releases).
    fetchLatest: function () {
      var self = this;
      return fetch(this.apiLatestURL, { headers: { "User-Agent": "dict-learn-app" } }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (rel) {
        var tag = (rel.tag_name || "").replace(/^v/, "");
        var apk = null, apkName = "";
        (rel.assets || []).forEach(function (a) {
          if (/\.apk$/i.test(a.name)) { apk = a.browser_download_url; apkName = a.name; }
        });
        return {
          version: tag, notes: rel.name || "", url: rel.html_url || self.channelURL,
          apk: apk, apkName: apkName, critical: false, securityFixCode: 0, viaInfo: false
        };
      });
    },

    // Check for a newer version. Tries update-info.json first (no rate limit),
    // then the API. Returns the release object or null (up-to-date / offline).
    check: function (force) {
      var self = this;
      if (!force && this.pref() !== "on") return Promise.resolve(null);
      var mark = function () { try { if (!force) localStorage.setItem(LS_LAST, String(Date.now())); } catch (e) {} };
      return this.fetchUpdateInfo().then(function (info) {
        if (info) { mark(); return self._finishCheck(info, force); }
        return self.fetchLatest().then(function (rel) {
          if (!rel || !rel.version) return null;
          if (!self.isNewer(rel.version, self.currentVersion)) {
            mark();
            if (rel.version === self.currentVersion) self._toastOk();
            return null;
          }
          mark();
          return self._finishCheck(rel, force);
        }, function () {
          // The info file answered already; a hard API failure is offline: silent.
          return null;
        });
      }).catch(function () { return null; });
    },

    _finishCheck: function (rel, force) {
      this._lastRel = rel;
      this._renderBanner(rel, force);
      // duosub: an automatic download only runs when it was NOT a manual tap
      // (manual just shows the banner/dialog for a one-tap install), auto-update
      // is ON, and the network is unmetered (~33 MB → Wi-Fi).
      if (!force && this.pref() === "on") {
        this._autoDownloadEligible(rel).then(function (ok) {
          if (ok) Api.download(rel);
        });
      }
      return rel;
    },

    _renderBannerHidden: function (rel) {
      var b = document.getElementById("update-banner");
      if (b) b.classList.add("hidden");
      this._lastBannerHidden = true;
    },

    _autoDownloadEligible: function (rel) {
      if (!nativeAvailable || !native || !native.info) return Promise.resolve(false);
      return native.info().then(function (i) { return i.unmetered === true; })
        .catch(function () { return false; });
    },

    // --- reminder policy (duosub's updateReminder) ---------------------------
    reminder: function (update) {
      if (!update) return "none";
      var now = Date.now();
      var shownAt = 0;
      var secFix = 0, secSince = 0, skipped = "";
      try {
        shownAt = parseInt(localStorage.getItem(LS_REMOWN) || "0", 10);
        secFix = parseInt(localStorage.getItem(LS_SEC) || "0", 10);
        secSince = parseInt(localStorage.getItem(LS_SECSINCE) || "0", 10);
        skipped = localStorage.getItem(LS_SKIP) || "";
      } catch (e) {}
      var elapsed = now - shownAt;

      if (update.critical) {
        if (secFix !== update.securityFixCode || secSince <= 0) return "security";
        var age = now - secSince;
        var again = age >= 0 && age < SECURITY_DAILY_PERIOD ? DAILY : WEEK;
        var due = elapsed >= again || elapsed < 0;
        return due ? "security" : "none";
      }
      if (skipped === update.version) return "none";
      var quietSince = Math.max(shownAt, this.installedAtMs || 0);
      var quiet = now - quietSince;
      var due2 = quietSince <= 0 || quiet >= WEEK || quiet < 0;
      return due2 ? "banner" : "none";
    },

    onReminderShown: function (update) {
      var now = Date.now();
      try {
        localStorage.setItem(LS_REMVER, update.version);
        localStorage.setItem(LS_REMOWN, String(now));
        if (update.critical && parseInt(localStorage.getItem(LS_SEC) || "0", 10) !== update.securityFixCode) {
          localStorage.setItem(LS_SEC, String(update.securityFixCode));
          localStorage.setItem(LS_SECSINCE, String(now));
        }
      } catch (e) {}
    },

    skipVersion: function (update) {
      if (update && !update.critical) {
        try { localStorage.setItem(LS_SKIP, update.version); } catch (e) {}
      }
      this._lastBannerHidden = true;
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

    // --- banner: shows when the reminder policy says so (auto) or always (manual)
    _renderBanner: function (rel, force) {
      var b = document.getElementById("update-banner");
      if (!b || !rel) return;
      // A manual "Check now" always surfaces a newer version (duosub's dialog
      // path). The weekly quiet-window + Skip-this-version gate applies only to
      // the automatic daily check, so auto-checks don't re-nag between releases.
      if (!force) {
        var mode = this.reminder(rel);
        if (mode === "none") {
          b.classList.add("hidden");
          this._lastBannerHidden = true;
          return;
        }
      }
      this.onReminderShown(rel);
      b.classList.toggle("is-security", !!rel.critical);
      b.innerHTML =
        '<div class="ub-title">' + (rel.critical ? "🔒 Bản an toàn quan trọng v" : "🆕 Phiên bản mới v") + rel.version + "</div>" +
        '<div class="ub-notes">' + escapeHtml(rel.notes || "Cải tiến giao diện và dữ liệu từ vựng.") + "</div>" +
        '<div class="ub-progress hidden" id="ub-progress"><div id="ub-progress-fill" style="width:0%"></div></div>' +
        '<div class="ub-row">' +
        '<button id="ub-dl" class="primary">' + (rel.critical ? "⬇ Cập nhật ngay" : "⬇ Tải bản mới") + "</button>" +
        (rel.critical
          ? '<button id="ub-later" class="ghost">Để sau</button>'
          : '<button id="ub-skip" class="ghost">Bỏ qua bản này</button>') +
        "</div>";
      b.classList.remove("hidden");
      var dl = document.getElementById("ub-dl");
      var skip = document.getElementById("ub-skip");
      var later = document.getElementById("ub-later");
      if (dl) dl.onclick = function () { Api.download(rel); };
      if (skip) skip.onclick = function () { Api.skipVersion(rel); b.classList.add("hidden"); };
      if (later) later.onclick = function () { b.classList.add("hidden"); }; // security: resurfaces next day
    },

    _renderProgress: function (percent) {
      var p = document.getElementById("ub-progress");
      var f = document.getElementById("ub-progress-fill");
      if (p) p.classList.remove("hidden");
      if (f) f.style.width = Math.max(0, Math.min(100, percent)) + "%";
    },

    _clearProgress: function () {
      var p = document.getElementById("ub-progress");
      if (p) p.classList.add("hidden");
      var f = document.getElementById("ub-progress-fill");
      if (f) f.style.width = "0%";
    },

    // --- download + install (native on Android, release-page on the web) -----
    download: function (rel) {
      var self = this;
      if (nativeAvailable && native && native.download) {
        this._state = "downloading";
        this._renderProgress(0);
        return native.download({ url: rel.apk, sha256: rel.sha256 || "" }).then(function (res) {
          self._renderProgress(100);
          if (res && res.sha256) self._showInstallStep(rel, res);
          else self.openDownload(rel);
        }, function (err) {
          // GitHub busy/rate-limited: surface a friendly message, keep the banner.
          self._state = "failed";
          self._toast("Không tải được bản mới: " + (err && err.message ? err.message : "mất mạng"));
        });
      }
      // Web fallback: one-tap install via the in-app browser / a new tab.
      this.openDownload(rel);
      return Promise.resolve();
    },

    _showInstallStep: function (rel, res) {
      var self = this;
      var dl = document.getElementById("ub-dl");
      this._state = "ready";
      if (dl) { dl.textContent = "✅ Cài đặt bản " + rel.version; }
      this._toast("Đã tải và kiểm tra bản " + rel.version + ". Bấm để cài.");
      // The button now installs the verified file.
      if (dl) dl.onclick = function () {
        if (native && native.install) native.install({ path: res.path }).then(function () {
          self._state = "installing";
          self._toast("Đang cài đặt bản " + rel.version + "…");
        }).catch(function (e) { self._toast("Không thể cài: " + (e.message || e)); });
      };
    },

    openDownload: function (rel) {
      var url = (rel && rel.apk) ? rel.apk : ((rel && rel.url) || this.channelURL);
      if (!this.isHostAllowed(url)) url = this.channelURL; // never a non-GitHub address
      if (typeof Capacitor !== "undefined" && Capacitor.Plugins && Capacitor.Plugins.Browser) {
        Capacitor.Plugins.Browser.open({ url: url, presentation: "fullscreen" });
        return;
      }
      if (typeof Capacitor !== "undefined" && Capacitor.App && Capacitor.App.openUrl) {
        Capacitor.App.openUrl({ url: url });
        return;
      }
      try { window.open(url, "_blank", "noopener"); }
      catch (e) { try { window.location.href = url; } catch (e2) {} }
    },

    _toast: function (msg) {
      var el = document.getElementById("toast");
      if (!el) return;
      el.textContent = msg;
      el.className = "info";
      el.classList.remove("hidden");
      if (el._timer) clearTimeout(el._timer);
      el._timer = setTimeout(function () { el.classList.add("hidden"); }, 3200);
    },

    // Re-evaluate banner state (called on Home render).
    renderBanner: function () {
      var b = document.getElementById("update-banner");
      if (!b) return;
      if (this.pref() === "off") { b.classList.add("hidden"); return; }
      if (!this._lastRel) { b.classList.add("hidden"); return; }
      // If the policy now says show (e.g. a new week), re-render; else keep it hidden.
      if (this.reminder(this._lastRel) !== "none") this._renderBanner(this._lastRel);
      else b.classList.add("hidden");
    },

    mount: function () {
      var self = this;
      this._bindNative();
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
        self.check(true).then(function () {
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
        if (self.pref() === "on" && self.due()) self.check();
      });
    },

    // Reach the native update plugin when present (Android only).
    _bindNative: function () {
      if (typeof Capacitor !== "undefined" && Capacitor.registerPlugin &&
          Capacitor.isPluginAvailable && Capacitor.isPluginAvailable("DictUpdate")) {
        native = Capacitor.registerPlugin("DictUpdate");
        nativeAvailable = true;
        var self = this;
        if (native.addListener) {
          try {
            var p = native.addListener("dictupdate-progress", function (d) {
              self._renderProgress((d && d.percent) || 0);
            });
            if (p && typeof p.catch === "function") p.catch(function () {});
          } catch (e) {}
        }
        if (native.info) native.info().then(function (i) {
          self.currentVersionCode = i.versionCode || self.currentVersionCode;
          self.installedAtMs = i.lastUpdateTime || 0;
          try { localStorage.setItem(LS_INSTALLED, String(self.installedAtMs)); } catch (e) {}
        }).catch(function () {});
      }
    }
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }

  window.AppUpdate = Api;
  if (document.getElementById && document.getElementById("autoupd")) Api.mount();
  else if (document.addEventListener) document.addEventListener("DOMContentLoaded", function () { Api.mount(); });
})();
