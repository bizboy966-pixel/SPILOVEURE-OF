package com.spilivere.app;

import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Bundled routes stay local. Protected image/audio GETs go to the real VPS. */
public class VpsMediaClient extends BridgeWebViewClient {
    public VpsMediaClient(Bridge bridge) { super(bridge); }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        android.net.Uri uri = request.getUrl();
        if (!"https".equals(uri.getScheme()) || !"spiloveure.org".equals(uri.getHost())
            || !uri.getPath().startsWith("/api/")) {
            return super.shouldInterceptRequest(view, request);
        }
        if (!"GET".equals(request.getMethod()) && !"HEAD".equals(request.getMethod())) {
            return failure(405, "Method Not Allowed");
        }
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(uri.toString()).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(60000);
            connection.setRequestMethod(request.getMethod());
            for (Map.Entry<String, String> header : request.getRequestHeaders().entrySet()) {
                String key = header.getKey();
                if ("range".equalsIgnoreCase(key) || "authorization".equalsIgnoreCase(key)
                    || "accept".equalsIgnoreCase(key) || "user-agent".equalsIgnoreCase(key)) {
                    connection.setRequestProperty(key, header.getValue());
                }
            }
            String cookie = CookieManager.getInstance().getCookie(uri.toString());
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            int status = connection.getResponseCode();
            // Never turn a failed API request or redirect into the SPA index.
            if (status >= 300 && status < 400 && status != 304) {
                connection.disconnect();
                return failure(502, "API Redirect Refused");
            }
            Map<String, String> headers = new HashMap<>();
            for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
                if (entry.getKey() != null) headers.put(entry.getKey(), String.join(", ", entry.getValue()));
            }
            headers.put("Cache-Control", "no-store");
            String type = connection.getContentType();
            String mime = type == null ? "application/octet-stream" : type.split(";")[0];
            final HttpURLConnection active = connection;
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) stream = new ByteArrayInputStream(new byte[0]);
            InputStream body = new FilterInputStream(stream) {
                @Override public void close() throws IOException {
                    try { super.close(); } finally { active.disconnect(); }
                }
            };
            return new WebResourceResponse(mime, null, status,
                connection.getResponseMessage() == null ? "Response" : connection.getResponseMessage(), headers, body);
        } catch (Exception error) {
            if (connection != null) connection.disconnect();
            return failure(502, "VPS Unavailable");
        }
    }

    private static WebResourceResponse failure(int code, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", code, reason,
            java.util.Collections.singletonMap("Cache-Control", "no-store"),
            new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }
}
