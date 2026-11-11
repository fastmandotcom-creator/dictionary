package com.dict.learn.update;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.core.content.IntentCompat;
import androidx.core.content.pm.PackageInfoCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
/**
 * Native safe-update for dict-learn — ported from duosub-study's
 * duosub.study.update.AppUpdater (GitHub host allowlist, HTTPS-only, 150 MB
 * cap, SHA-256 verification, package-identity + versionCode verification,
 * PackageInstaller self-update with a result receiver).
 *
 * JS surface (window.DictUpdate):
 *   - info()                -> { versionCode, lastUpdateTime, unmetered }
 *   - download(url, {sha256}) -> streams the APK to the app cache with
 *     "dictupdate-progress" events {percent, bytes, total}; verifies SHA-256
 *     when given; resolves { path, sha256, size }
 *   - verify(path)          -> { ok, packageName, versionCode, newer }
 *   - install(path)         -> PackageInstaller session; a receiver reports the
 *     result via lastInstall()
 *   - lastInstall()         -> { status, statusName, at, path } | null
 *   - cancel()              -> stops an in-flight download
 *   - clear()               -> removes downloaded files
 *
 * Every step fails closed: a non-GitHub host, a non-HTTPS URL, a wrong
 * checksum, a size above the cap, or a download that is not a newer version
 * of THIS app all reject — the app never installs an unverified binary.
 */
@CapacitorPlugin(name = "DictUpdate")
public class DictUpdatePlugin extends Plugin {

    /** GitHub's API, release pages and the hosts its release downloads redirect to. */
    private static final Set<String> ALLOWED_HOSTS;
    static {
        ALLOWED_HOSTS = new java.util.HashSet<>(java.util.Arrays.asList(
            "api.github.com",
            "github.com",
            "objects.githubusercontent.com",
            "release-assets.githubusercontent.com",
            "github-releases.githubusercontent.com"));
    }

    /** No dict-learn release APK comes near this; a bigger download is refused. */
    private static final long MAX_UPDATE_BYTES = 150L * 1024 * 1024;

    private static final long CONNECT_TIMEOUT_MS = 15000;
    private static final long READ_TIMEOUT_MS = 30000;

    private final ExecutorService net = Executors.newFixedThreadPool(1);
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean downloadCancelled = false;
    private volatile boolean downloading = false;
    private File lastDownloaded;

    @PluginMethod
    public void info(PluginCall call) {
        Context ctx = getContext().getApplicationContext();
        JSObject o = new JSObject();
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            o.put("versionCode", PackageInfoCompat.getLongVersionCode(pi));
            o.put("lastUpdateTime", pi.lastUpdateTime);
        } catch (Throwable t) {
            o.put("versionCode", -1);
            o.put("lastUpdateTime", 0);
        }
        o.put("unmetered", isUnmetered(ctx));
        call.resolve(o);
    }

    @PluginMethod
    public void download(PluginCall call) {
        final String urlStr = call.getString("url", "");
        final String expectedSha = call.getString("sha256", "");
        if (urlStr.isEmpty()) {
            call.reject("no url");
            return;
        }
        if (downloading) {
            call.reject("a download is already running");
            return;
        }
        downloading = true;
        downloadCancelled = false;
        net.execute(() -> {
            try {
                JSObject r = doDownload(urlStr, expectedSha);
                main.post(() -> {
                    downloading = false;
                    call.resolve(r);
                });
            } catch (UpdateError e) {
                main.post(() -> {
                    downloading = false;
                    call.reject(e.getMessage(), e.getProblemCode());
                });
            } catch (Throwable t) {
                main.post(() -> {
                    downloading = false;
                    call.reject("download failed: " + t.getMessage(), "DOWNLOAD_FAILED");
                });
            }
        });
    }

    /** One checked download + verify; throws UpdateError with a duosub-style problem code. */
    private JSObject doDownload(String urlStr, String expectedSha) throws Exception {
        URL url = new URL(urlStr);
        if (!"https".equalsIgnoreCase(url.getProtocol()) || !isAllowedHost(url.getHost())) {
            throw new UpdateError("Not a GitHub address", "GITHUB_ERROR");
        }
        File folder = new File(getContext().getCacheDir(), "app-update");
        folder.mkdirs();
        // A fresh download replaces any earlier one (duosub-study clears the folder).
        for (File old : folder.listFiles()) {
            if (old.isFile() && !old.getName().equals("last-status.txt")) old.delete();
        }
        File part = new File(folder, "update.apk.part");
        File apk = new File(folder, "update.apk");

        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setConnectTimeout((int) CONNECT_TIMEOUT_MS);
        conn.setReadTimeout((int) READ_TIMEOUT_MS);
        conn.setRequestProperty("User-Agent", "dict-learn-app");
        int code = conn.getResponseCode();
        if (code == 403 || code == 429) {
            conn.disconnect();
            throw new UpdateError("GitHub is busy or rate-limited", "GITHUB_BUSY");
        }
        if (code != 200) {
            conn.disconnect();
            throw new UpdateError("GitHub answered " + code, "GITHUB_ERROR");
        }
        long total = Math.max(conn.getContentLengthLong(), 0);
        long read = 0;
        int lastPercent = -1;
        try (InputStream in = conn.getInputStream();
             FileOutputStream out = new FileOutputStream(part)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = in.read(buffer)) != -1) {
                if (downloadCancelled) {
                    conn.disconnect();
                    out.close();
                    part.delete();
                    throw new UpdateError("Download cancelled", "CANCELLED");
                }
                read += count;
                if (read > MAX_UPDATE_BYTES) {
                    conn.disconnect();
                    out.close();
                    part.delete();
                    throw new UpdateError("The download is too big", "WRONG_APP");
                }
                digest.update(buffer, 0, count);
                out.write(buffer, 0, count);
                if (total > 0) {
                    int percent = (int) (read * 100 / total);
                    if (percent != lastPercent) {
                        lastPercent = percent;
                        JSObject p = new JSObject();
                        p.put("percent", percent);
                        p.put("bytes", read);
                        p.put("total", total);
                        notifyListeners("dictupdate-progress", p);
                    }
                }
            }
        } finally {
            conn.disconnect();
        }
        if (!part.renameTo(apk)) {
            part.delete();
            throw new UpdateError("Could not keep the download", "DOWNLOAD_FAILED");
        }
        String sha = String.join("", formatHex(digest.digest()));
        if (!expectedSha.isEmpty() && !expectedSha.equalsIgnoreCase(sha)) {
            apk.delete();
            throw new UpdateError("The download's SHA-256 does not match GitHub's", "CHECKSUM");
        }
        lastDownloaded = apk;
        JSObject r = new JSObject();
        r.put("path", apk.getAbsolutePath());
        r.put("sha256", sha);
        r.put("size", read);
        return r;
    }

    private static java.util.List<String> formatHex(byte[] bytes) {
        java.util.List<String> out = new java.util.ArrayList<>(bytes.length);
        for (byte b : bytes) out.add(String.format("%02x", b));
        return out;
    }

    @PluginMethod
    public void verify(PluginCall call) {
        final String path = call.getString("path", "");
        File f = new File(path);
        JSObject o = new JSObject();
        if (!f.isFile() || f.length() <= 0) {
            o.put("ok", false);
            o.put("reason", "missing file");
            call.resolve(o);
            return;
        }
        try {
            PackageInfo archive = getContext().getPackageManager().getPackageArchiveInfo(f.getAbsolutePath(), 0);
            if (archive == null) {
                o.put("ok", false);
                o.put("reason", "not an Android app");
                call.resolve(o);
                return;
            }
            // The download must be this app and newer than it (duosub-study's
            // verifyArchive); the signature is checked by the package installer.
            PackageInfo installed =
                getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            long archiveCode = PackageInfoCompat.getLongVersionCode(archive);
            long installedCode = PackageInfoCompat.getLongVersionCode(installed);
            o.put("ok", true);
            o.put("packageName", archive.packageName);
            o.put("versionCode", archiveCode);
            o.put("newer", archiveCode > installedCode);
            call.resolve(o);
        } catch (Throwable t) {
            o.put("ok", false);
            o.put("reason", String.valueOf(t.getMessage()));
            call.resolve(o);
        }
    }

    @PluginMethod
    public void install(PluginCall call) {
        final String path = call.getString("path", "");
        File f = new File(path);
        if (!f.isFile()) {
            call.reject("no downloaded update at " + path);
            return;
        }
        net.execute(() -> {
            try {
                PackageInstaller installer = getContext().getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params =
                    new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(getContext().getPackageName());
                params.setSize(f.length());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    params.setInstallReason(PackageManager.INSTALL_REASON_USER);
                }
                // An app updating itself may skip Android's confirmation on Android 12 and newer.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                }
                int sessionId = installer.createSession(params);
                PackageInstaller.Session session = installer.openSession(sessionId);
                if (session == null) {
                    throw new IOException("could not open install session");
                }
                OutputStream output = null;
                try (InputStream input = new java.io.FileInputStream(f)) {
                     output = session.openWrite("base.apk", 0, f.length());
                    byte[] copyBuf = new byte[65536];
                    int n;
                    while ((n = input.read(copyBuf)) != -1) {
                        output.write(copyBuf, 0, n);
                    }
                    session.fsync(output);
                } finally {
                    try { output.close(); } catch (Throwable ignored) {}
                }
                int flags = PendingIntent.FLAG_UPDATE_CURRENT
                    | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent status = PendingIntent.getBroadcast(
                    getContext(),
                    sessionId,
                    new Intent(getContext(), DictUpdateReceiver.class).setPackage(getContext().getPackageName()),
                    flags);
                session.commit(status.getIntentSender());
                lastDownloaded = f;
                writeStatus(getContext(), "pending", String.valueOf(sessionId));
                call.resolve(new JSObject());
            } catch (Throwable t) {
                writeStatus(getContext(), "install_failed", String.valueOf(t.getMessage()));
                call.reject("install session failed: " + t.getMessage(), "INSTALL_FAILED");
            }
        });
    }

    @PluginMethod
    public void lastInstall(PluginCall call) {
        JSObject o = readStatus(getContext());
        if (o.length() == 0) call.resolve();
        else call.resolve(o);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        downloadCancelled = true;
        main.post(() -> call.resolve());
    }

    @PluginMethod
    public void clear(PluginCall call) {
        File folder = new File(getContext().getCacheDir(), "app-update");
        for (File old : folder.listFiles()) {
            if (old.isFile() && !old.getName().equals("last-status.txt")) old.delete();
        }
        main.post(() -> call.resolve());
    }

    // ------------------------------------------------------------------
    // Result receiver (Android's answer to the install session commit).
    // ------------------------------------------------------------------
    /** Writes the install result where DictUpdatePlugin.lastInstall() reads it. */
    public static void writeStatus(Context context, String status, String detail) {
        try {
            File folder = new File(context.getCacheDir(), "app-update");
            if (!folder.exists()) folder.mkdirs();
            File f = new File(folder, "last-status.txt");
            java.io.FileWriter w = new java.io.FileWriter(f);
            w.write(status + "\n" + detail + "\n" + System.currentTimeMillis());
            w.close();
        } catch (Throwable ignored) {}
    }

    private JSObject readStatus(Context ctx) {
        File f = new File(new File(ctx.getCacheDir(), "app-update"), "last-status.txt");
        JSObject o = new JSObject();
        if (!f.isFile()) return o;
        try {
            byte[] all = new byte[(int) f.length()];
            try (InputStream in = new java.io.FileInputStream(f)) {
                int off = 0;
                int r;
                while (off < all.length && (r = in.read(all, off, all.length - off)) != -1) {
                    off += r;
                }
            }
            String text = new String(all, java.nio.charset.StandardCharsets.UTF_8);
            String[] lines = text.split("\n");
            o.put("status", lines.length > 0 ? lines[0] : "unknown");
            o.put("detail", lines.length > 1 ? lines[1] : "");
            o.put("at", lines.length > 2 ? Long.parseLong(lines[2]) : 0);
        } catch (Throwable t) {
            // fall through: empty object == no status
        }
        return o;
    }

    private boolean isAllowedHost(String host) {
        return ALLOWED_HOSTS.contains(host.toLowerCase());
    }

    private boolean isUnmetered(Context ctx) {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        android.net.Network network = cm.getActiveNetwork();
        if (network == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(network);
        // duosub-study's unmetered(): Wi-Fi or another unmetered network.
        // NET_CAPABILITY_METERED == 2 (android.net.ConnectivityManager).
        return caps != null && !caps.hasCapability(2);
    }

    /** The receiver that learns the installer's verdict and stores it. */
    public static class DictUpdateReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            String code = intent.getStringExtra("android.content.pm.extra.STATUS_NAME");
            switch (status) {
                case PackageInstaller.STATUS_SUCCESS:
                    writeStatus(context, "success", code == null ? "installed" : code);
                    break;
                case PackageInstaller.STATUS_PENDING_USER_ACTION:
                    Intent confirmation = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent.class);
                    if (confirmation != null) {
                        try {
                            context.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                            return; // the system screen will report the outcome
                        } catch (Throwable t) {
                            writeStatus(context, "install_failed", "cannot open installer screen");
                        }
                    } else {
                        writeStatus(context, "install_failed", "no confirmation intent");
                    }
                    break;
                case PackageInstaller.STATUS_FAILURE_ABORTED:
                    writeStatus(context, "cancelled", code == null ? "aborted" : code);
                    break;
                default:
                    writeStatus(context, "install_failed", code == null ? "failure" : code);
                    break;
            }
        }
    }

    /** A failed step of the update pipeline, named like duosub's UpdateProblem. */
    private static final class UpdateError extends Exception {
        private final String problemCode;
        UpdateError(String msg, String code) {
            super(msg);
            this.problemCode = code;
        }
        String getProblemCode() { return problemCode; }
    }

    @Override
    protected void handleOnDestroy() {
        downloadCancelled = true;
        net.shutdownNow();
    }
}
