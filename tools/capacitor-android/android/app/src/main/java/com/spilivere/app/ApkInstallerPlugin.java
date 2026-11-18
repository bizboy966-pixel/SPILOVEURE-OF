package com.spilivere.app;

import android.app.DownloadManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {
    @PluginMethod
    public void startDownload(PluginCall call) {
        String rawUrl = call.getString("url");
        String version = call.getString("version");
        String requestedName = call.getString("fileName");
        Uri uri = rawUrl == null ? null : Uri.parse(rawUrl);
        if (!isTrustedApkUrl(uri)) {
            call.reject("Le lien APK doit provenir du serveur officiel SPILOVEURE.");
            return;
        }

        String fileName = sanitizeFileName(requestedName, version);
        DownloadManager manager = downloadManager();
        if (manager == null) {
            call.reject("Le service de téléchargement Android est indisponible.");
            return;
        }

        try {
            DownloadManager.Request request = new DownloadManager.Request(uri)
                .setTitle("SPILOVEURE")
                .setDescription("Téléchargement de la version " + (version == null ? "" : version))
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(false)
                .setDestinationInExternalFilesDir(
                    getContext(), Environment.DIRECTORY_DOWNLOADS, fileName);
            long downloadId = manager.enqueue(request);
            JSObject result = new JSObject();
            result.put("downloadId", downloadId);
            call.resolve(result);
        } catch (Exception exception) {
            call.reject("Android n’a pas pu démarrer le téléchargement.", exception);
        }
    }

    @PluginMethod
    public void getDownloadStatus(PluginCall call) {
        long downloadId = call.getLong("downloadId", -1L);
        if (downloadId < 0) {
            call.reject("Identifiant de téléchargement invalide.");
            return;
        }
        DownloadManager manager = downloadManager();
        if (manager == null) {
            call.reject("Le service de téléchargement Android est indisponible.");
            return;
        }

        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
            if (cursor == null || !cursor.moveToFirst()) {
                call.reject("Téléchargement Android introuvable.");
                return;
            }

            int statusColumn = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS);
            int bytesColumn = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
            int totalColumn = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
            int statusCode = cursor.getInt(statusColumn);
            long bytes = Math.max(0, cursor.getLong(bytesColumn));
            long total = Math.max(0, cursor.getLong(totalColumn));

            JSObject result = new JSObject();
            result.put("status", statusName(statusCode));
            result.put("bytesDownloaded", bytes);
            result.put("totalBytes", total);
            if (statusCode == DownloadManager.STATUS_FAILED) {
                int reasonColumn = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON);
                result.put("error", "Android a interrompu le téléchargement (code "
                    + cursor.getInt(reasonColumn) + ").");
            }
            call.resolve(result);
        } catch (Exception exception) {
            call.reject("Impossible de lire la progression du téléchargement.", exception);
        }
    }

    private DownloadManager downloadManager() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    private boolean isTrustedApkUrl(Uri uri) {
        return uri != null
            && "https".equalsIgnoreCase(uri.getScheme())
            && "spiloveure.org".equalsIgnoreCase(uri.getHost())
            && uri.getUserInfo() == null
            && uri.getPort() == -1
            && uri.getPath() != null
            && uri.getPath().toLowerCase().endsWith(".apk");
    }

    private String sanitizeFileName(String requestedName, String version) {
        String fallback = "SPILOVEURE-" + (version == null ? "android" : version) + ".apk";
        String candidate = requestedName == null || requestedName.trim().isEmpty()
            ? fallback : requestedName;
        String sanitized = candidate.replaceAll("[^A-Za-z0-9._-]", "_");
        if (!sanitized.toLowerCase().endsWith(".apk")) sanitized += ".apk";
        return sanitized;
    }

    private String statusName(int status) {
        if (status == DownloadManager.STATUS_PENDING || status == DownloadManager.STATUS_PAUSED) {
            return "pending";
        }
        if (status == DownloadManager.STATUS_RUNNING) return "running";
        if (status == DownloadManager.STATUS_SUCCESSFUL) return "success";
        return "failed";
    }
}
