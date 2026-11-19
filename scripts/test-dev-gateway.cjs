const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const WebSocketServer = WebSocket.Server;
const {
  CAPACITOR_APK_PATH,
  createGateway,
  isBackendPath,
  parsePreviewApiUpstream,
  resolvePreviewApiUpstream,
} = require("./dev_gateway.cjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
  });
}

async function main() {
  assert.equal(parsePreviewApiUpstream(""), null);
  assert.equal(parsePreviewApiUpstream("https://spiloveure.org/"), "https://spiloveure.org");
  assert.throws(() => parsePreviewApiUpstream("http://spiloveure.org"));
  assert.throws(() => parsePreviewApiUpstream("https://spiloveure.org.evil.test"));
  assert.throws(() => parsePreviewApiUpstream("https://spiloveure.org:8443"));
  assert.throws(() => parsePreviewApiUpstream("https://spiloveure.org/api"));
  assert.equal(resolvePreviewApiUpstream("isolated", "https://spiloveure.org"), null);
  assert.equal(resolvePreviewApiUpstream("vps", "https://spiloveure.org"), "https://spiloveure.org");
  assert.throws(() => resolvePreviewApiUpstream("vps", ""));
  assert.throws(() => resolvePreviewApiUpstream("unknown", ""));
  assert.equal(isBackendPath("/api/messenger/ws?ticket=one"), true);
  assert.equal(isBackendPath("/"), false);

  const apkFile = path.join(os.tmpdir(), `spiloveure-release-${process.pid}.apk`);
  const apkBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x41, 0x50, 0x4b]);
  fs.writeFileSync(apkFile, apkBytes);
  const apkGateway = createGateway({ allowedHosts: new Set(), capacitorApkFile: apkFile });
  const apkGatewayPort = await listen(apkGateway);
  try {
    const download = await new Promise((resolve, reject) => {
      http.get({
        hostname: "127.0.0.1", port: apkGatewayPort, path: CAPACITOR_APK_PATH,
      }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks),
        }));
      }).once("error", reject);
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers["content-type"], "application/vnd.android.package-archive");
    assert.match(download.headers["content-disposition"], /filename="SPILOVEURE-1\.1\.14\.apk"/);
    assert.equal(download.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(download.body, apkBytes);
    const partial = await get(apkGatewayPort, CAPACITOR_APK_PATH, { range: "bytes=2-5" });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers["content-range"], `bytes 2-5/${apkBytes.length}`);
    assert.equal(partial.headers["content-type"], "application/vnd.android.package-archive");
  } finally {
    await close(apkGateway);
    fs.rmSync(apkFile, { force: true });
  }

  const localApi = http.createServer((_request, response) => response.end("isolated local API"));
  const localApiPort = await listen(localApi);
  const localGateway = createGateway({
    localApi: `http://127.0.0.1:${localApiPort}`,
    allowedHosts: new Set(),
  });
  const localGatewayPort = await listen(localGateway);
  try {
    const localResult = await get(localGatewayPort, "/api/health");
    assert.equal(localResult.status, 200);
    assert.equal(localResult.body, "isolated local API");
  } finally {
    await close(localGateway);
    await close(localApi);
  }

  let upstreamHttpRequests = 0;
  const upstream = http.createServer((request, response) => {
    upstreamHttpRequests += 1;
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Set-Cookie", "spv_chat_session=preview-test; Path=/api/; HttpOnly; SameSite=Lax; Secure");
    response.end(JSON.stringify({
      host: request.headers.host,
      origin: request.headers.origin,
      fetchSite: request.headers["sec-fetch-site"],
      cookie: request.headers.cookie,
    }));
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  upstream.on("upgrade", (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, ws => {
      ws.send(JSON.stringify({
        host: request.headers.host,
        origin: request.headers.origin,
        fetchSite: request.headers["sec-fetch-site"],
        cookie: request.headers.cookie,
      }));
    });
  });

  const upstreamPort = await listen(upstream);
  const allowedHosts = new Set();
  const gateway = createGateway({
    apiUpstream: `http://127.0.0.1:${upstreamPort}`,
    allowedHosts,
  });
  const gatewayPort = await listen(gateway);
  allowedHosts.add(`127.0.0.1:${gatewayPort}`);

  try {
    const result = await get(gatewayPort, "/api/messenger/session", {
      origin: "https://preview.replit.dev",
      "sec-fetch-site": "cross-site",
      cookie: "spv_chat_session=browser-session",
    });
    assert.equal(result.status, 200);
    assert.match(result.headers["set-cookie"][0], /spv_chat_session=preview-test/);
    const forwarded = JSON.parse(result.body);
    assert.equal(forwarded.host, `127.0.0.1:${upstreamPort}`);
    assert.equal(forwarded.origin, `http://127.0.0.1:${upstreamPort}`);
    assert.equal(forwarded.fetchSite, "same-origin");
    assert.equal(forwarded.cookie, "spv_chat_session=browser-session");

    const beforeRejectedRequest = upstreamHttpRequests;
    const rejected = await get(gatewayPort, "/api/private", { host: "untrusted.example" });
    assert.equal(rejected.status, 421);
    assert.equal(upstreamHttpRequests, beforeRejectedRequest);

    const message = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/messenger/ws?ticket=one`, {
        headers: {
          Origin: "https://preview.replit.dev",
          "Sec-Fetch-Site": "cross-site",
          Cookie: "spv_chat_session=websocket-session",
        },
      });
      const timeout = setTimeout(() => reject(new Error("WebSocket proxy timed out")), 5000);
      socket.once("message", data => {
        clearTimeout(timeout);
        resolve(JSON.parse(data.toString()));
        socket.close();
      });
      socket.once("error", error => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    assert.equal(message.host, `127.0.0.1:${upstreamPort}`);
    assert.equal(message.origin, `http://127.0.0.1:${upstreamPort}`);
    assert.equal(message.fetchSite, "same-origin");
    assert.equal(message.cookie, "spv_chat_session=websocket-session");
  } finally {
    webSocketServer.close();
    await close(gateway);
    await close(upstream);
  }
}

main().then(() => {
  console.log("Development gateway proxy checks passed.");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
