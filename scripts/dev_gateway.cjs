// Development-only same-origin gateway for Expo, the API, and WebSockets.
// Setting SPV_PREVIEW_API_UPSTREAM opts the Replit preview into using the VPS
// API without exposing MongoDB or relying on third-party browser cookies.
const http = require("http");
const httpProxy = require("http-proxy");
const fs = require("fs");
const path = require("path");

const LOCAL_API = "http://127.0.0.1:8000";
const LOCAL_WEB = `http://127.0.0.1:${process.env.SPV_METRO_PORT || 8080}`;
const APPROVED_API_HOSTS = new Set(["spiloveure.org", "test.spiloveure.org"]);
const BACKEND_PATHS = new Set([
  "/telecharger",
  "/telecharger/",
  "/sitemap-android.xml",
  "/robots.txt",
]);
const CAPACITOR_APK_PATH = "/downloads/spiloveure.apk";
const DEFAULT_CAPACITOR_APK = path.join(
  __dirname, "../generated-artifacts/spiloveure/SPILOVEURE-1.1.13.apk",
);

function serveCapacitorApk(request, response, apkFile) {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" });
    response.end();
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(apkFile);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("APK officielle SPILOVEURE indisponible.");
    return true;
  }
  const headers = {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": 'attachment; filename="SPILOVEURE-1.1.13.apk"',
    "Content-Length": String(stat.size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  let start = 0;
  let end = stat.size - 1;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      response.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Cache-Control": "no-store" });
      response.end();
      return true;
    }
    if (!match[1]) {
      const suffix = Number(match[2]);
      start = Math.max(0, stat.size - suffix);
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
    }
    if (start >= stat.size || start > end) {
      response.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Cache-Control": "no-store" });
      response.end();
      return true;
    }
    headers["Content-Length"] = String(end - start + 1);
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    response.writeHead(206, headers);
  } else {
    response.writeHead(200, headers);
  }
  if (request.method === "HEAD") {
    response.end();
  } else {
    const stream = fs.createReadStream(apkFile, { start, end });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }
  return true;
}

function parsePreviewApiUpstream(raw) {
  if (!raw || !raw.trim()) return null;

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("SPV_PREVIEW_API_UPSTREAM must be a valid HTTPS origin.");
  }

  if (
    url.protocol !== "https:" ||
    url.port ||
    !APPROVED_API_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "SPV_PREVIEW_API_UPSTREAM must be the HTTPS origin https://spiloveure.org or https://test.spiloveure.org.",
    );
  }
  return url.origin;
}

function resolvePreviewApiUpstream(mode, raw) {
  if (mode === "isolated") return null;
  if (mode !== "vps") {
    throw new Error("SPV_PREVIEW_MODE must be explicitly set to isolated or vps.");
  }
  const upstream = parsePreviewApiUpstream(raw);
  if (!upstream) {
    throw new Error("SPV_PREVIEW_API_UPSTREAM is required in VPS preview mode.");
  }
  return upstream;
}

function isBackendPath(requestUrl) {
  let pathname;
  try {
    pathname = new URL(requestUrl, "http://gateway.invalid").pathname;
  } catch {
    return false;
  }
  return pathname === "/api" || pathname.startsWith("/api/") || BACKEND_PATHS.has(pathname);
}

function configuredGatewayHosts() {
  const port = process.env.PORT || 5000;
  return new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
    "localhost",
    "127.0.0.1",
    ...(process.env.REPLIT_DEV_DOMAIN || "").split(","),
    ...(process.env.REPLIT_DOMAINS || "").split(","),
  ].map(value => value.trim().toLowerCase()).filter(Boolean));
}

function createGateway({
  apiUpstream = null,
  allowedHosts = configuredGatewayHosts(),
  localApi = LOCAL_API,
  localWeb = LOCAL_WEB,
  capacitorApkFile = DEFAULT_CAPACITOR_APK,
} = {}) {
  const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: false });
  const isRemoteApiRequest = request => Boolean(apiUpstream && isBackendPath(request.url));
  const target = request => {
    if (isRemoteApiRequest(request)) return apiUpstream;
    return isBackendPath(request.url) ? localApi : localWeb;
  };

  const normalizeRemoteOrigin = (proxyRequest, request) => {
    if (!isRemoteApiRequest(request)) return;
    const upstream = new URL(apiUpstream);
    // The browser calls this gateway on its own origin. Preserve that same-origin
    // property when the VPS checks the Chat cookie and WebSocket handshake.
    if (request.headers.origin) proxyRequest.setHeader("origin", upstream.origin);
    if (request.headers["sec-fetch-site"]) {
      proxyRequest.setHeader("sec-fetch-site", "same-origin");
    }
  };
  proxy.on("proxyReq", normalizeRemoteOrigin);
  proxy.on("proxyReqWs", normalizeRemoteOrigin);
  proxy.on("error", (_error, _request, response) => {
    if (response && response.writeHead && !response.headersSent) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Le serveur démarre. Réessayez dans quelques secondes.");
    } else if (response?.destroy) {
      response.destroy();
    }
  });

  const hasAllowedGatewayHost = request => {
    if (!isRemoteApiRequest(request)) return true;
    const host = String(request.headers.host || "").toLowerCase();
    return allowedHosts.has(host);
  };
  const rejectHttpHost = (request, response) => {
    if (hasAllowedGatewayHost(request)) return false;
    response.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Origine du preview non autorisée.");
    return true;
  };

  const server = http.createServer((request, response) => {
    if (new URL(request.url, "http://gateway.invalid").pathname === CAPACITOR_APK_PATH) {
      serveCapacitorApk(request, response, capacitorApkFile);
      return;
    }
    if (rejectHttpHost(request, response)) return;
    const remote = isRemoteApiRequest(request);
    proxy.web(request, response, {
      target: target(request),
      changeOrigin: remote,
      secure: true,
    });
  });
  server.on("upgrade", (request, socket, head) => {
    if (!hasAllowedGatewayHost(request)) {
      socket.end("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const remote = isRemoteApiRequest(request);
    proxy.ws(request, socket, head, {
      target: target(request),
      changeOrigin: remote,
      secure: true,
    });
  });
  return server;
}

if (require.main === module) {
  const mode = process.env.SPV_PREVIEW_MODE;
  const apiUpstream = resolvePreviewApiUpstream(mode, process.env.SPV_PREVIEW_API_UPSTREAM);
  if (mode === "isolated") {
    console.log("Isolated local preview enabled; VPS API is not used.");
  } else {
    console.log(`Preview API proxy enabled for ${apiUpstream}`);
  }
  const port = Number(process.env.PORT || 5000);
  createGateway({ apiUpstream }).listen(port, "0.0.0.0", () => {
    console.log(`SPILOVEURE development gateway listening on port ${port}`);
  });
}

module.exports = {
  CAPACITOR_APK_PATH, createGateway, isBackendPath, parsePreviewApiUpstream,
  resolvePreviewApiUpstream, serveCapacitorApk,
};
