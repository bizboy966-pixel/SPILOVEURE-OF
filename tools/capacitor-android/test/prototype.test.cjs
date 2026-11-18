const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const root = path.resolve(__dirname, "../../..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const local = p => read(`tools/capacitor-android/${p}`);

function transport(nativeHttp, fallback = async () => new Response("local")) {
  const box = { exports: {} };
  vm.runInNewContext(transformSync(local("transport.js"), { format: "cjs" }).code, {
    module: box, exports: box.exports,
    Request, Response, Headers, URL, Blob, FormData, DOMException,
    FileReader: class {
      async readAsDataURL(blob) {
        this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`;
        this.onload();
      }
    },
  });
  const target = { fetch: fallback };
  box.exports.installApiTransport(target, nativeHttp);
  return target.fetch;
}

test("test identity coexists with Expo and routes are bundled, not server.url", () => {
  const config = JSON.parse(local("capacitor.config.json"));
  const expo = JSON.parse(read("frontend/app.json"));
  assert.notEqual(config.appId, expo.expo.android.package);
  assert.equal(config.appName, "SPILOVEURE Test Capacitor");
  assert.equal(config.webDir, "www");
  assert.equal(config.server.url, undefined);
  assert.equal(config.server.hostname, "spiloveure.org");
  assert.equal(config.server.androidScheme, "https");
  assert.equal(config.server.cleartext, false);
  assert.equal(config.android.allowMixedContent, false);
  assert.equal(config.plugins.CapacitorHttp.enabled, true);
  const gradle = local("android/app/build.gradle");
  assert.ok(gradle.includes(`applicationId "${config.appId}"`));
});

test("login and Chat calls explicitly use native HTTP, preserving errors", async () => {
  const requests = [];
  const fetch = transport({ request: async options => {
    requests.push(options);
    return { status: requests.length === 1 ? 200 : 401,
      data: requests.length === 1 ? '{"user":{"id":"test"}}' : '{"detail":"Session expirée."}',
      headers: { "content-type": "application/json" } };
  } });
  const login = await fetch("https://spiloveure.org/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test", password: "test-only" }), credentials: "include",
  });
  assert.equal((await login.json()).user.id, "test");
  assert.equal(requests[0].data.username, "test");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].disableRedirects, true);
  const session = await fetch("https://spiloveure.org/api/identity/chat/session", { credentials: "include" });
  assert.equal(session.status, 401);
  assert.equal((await session.json()).detail, "Session expirée.");
});

test("bearer and multipart file/audio bytes survive native serialization", async () => {
  let options;
  const fetch = transport({ request: async value => {
    options = value;
    return { status: 200, data: '{"ok":true}', headers: {} };
  } });
  const data = new FormData();
  data.append("file", new Blob([new Uint8Array([0, 1, 128, 255])], { type: "audio/webm" }), "voice.webm");
  data.append("caption", "essai");
  await fetch("https://spiloveure.org/api/messenger/upload", {
    method: "POST", headers: { Authorization: "Bearer test-token" }, body: data,
  });
  assert.equal(options.headers.authorization, "Bearer test-token");
  assert.equal(options.headers["content-type"], "multipart/form-data");
  assert.equal(options.dataType, "formData");
  assert.equal(options.data[0].fileName, "voice.webm");
  assert.equal(options.data[0].contentType, "audio/webm");
  assert.deepEqual(Buffer.from(options.data[0].value, "base64"), Buffer.from([0, 1, 128, 255]));
  assert.equal(options.data[1].value, "essai");
});

test("local assets and untrusted origins never use the privileged API transport", async () => {
  let localCount = 0;
  const fetch = transport({ request() { throw Error("Unexpected native request"); } },
    async () => { localCount++; return new Response("asset"); });
  await fetch("https://spiloveure.org/_expo/static/js/web/entry.js");
  await fetch("https://spiloveure.org.evil.invalid/api/auth/login");
  assert.equal(localCount, 2);
});

test("empty responses, aborted requests and network failures are not converted to success", async () => {
  const empty = transport({ request: async () => ({ status: 204, data: "", headers: {} }) });
  assert.equal((await empty("https://spiloveure.org/api/identity/chat/logout", { method: "POST" })).status, 204);
  const broken = transport({ request: async () => { throw new Error("offline"); } });
  await assert.rejects(broken("https://spiloveure.org/api/auth/me"), /offline/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(empty("https://spiloveure.org/api/auth/me", { signal: controller.signal }), { name: "AbortError" });
});

test("back closes the conversation before navigating and asks before exiting", async () => {
  let listener, closed = 0;
  let handled = true;
  let modal = true, dismissed = 0;
  const code = transformSync(local("runtime.js").replace(/^import .*;\n/gm, ""), { format: "cjs" }).code;
  vm.runInNewContext(code, {
    Capacitor: { isNativePlatform: () => true }, CapacitorHttp: {},
    installApiTransport() {},
    App: {
      addListener: async (name, callback) => { assert.equal(name, "backButton"); listener = callback; },
      exitApp() { closed++; },
    },
    Event, KeyboardEvent: class { constructor(type, init) { this.type = type; this.key = init.key; } },
    navigator: {}, console,
    document: {
      querySelector: () => modal,
      dispatchEvent: event => { assert.equal(event.key, "Escape"); dismissed++; },
    },
    window: { dispatchEvent: event => { if (handled) event.preventDefault(); }, confirm: () => true },
  });
  listener();
  assert.equal(dismissed, 1);
  assert.equal(closed, 0);
  modal = false;
  listener();
  assert.equal(closed, 0);
  handled = false;
  listener();
  assert.equal(closed, 1);
  const messenger = read("frontend/src/messenger/MessengerScreen.tsx");
  assert.match(messenger, /addEventListener\("spv-capacitor-back", onBack, true\)/);
  assert.match(read("frontend/app/_layout.tsx"), /event\.defaultPrevented \|\| !router\.canGoBack\(\)/);
});

test("native capabilities are minimal and media uses VPS cookies and Range", () => {
  const manifest = local("android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  for (const forbidden of ["REQUEST_INSTALL_PACKAGES", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "CAMERA"]) {
    assert.ok(!manifest.includes(forbidden), forbidden);
  }
  assert.match(manifest, /android:allowBackup="false"/);
  const media = local("android/app/src/main/java/com/spiloveure/capacitor/test/VpsMediaClient.java");
  assert.match(media, /getCookie\(uri\.toString\(\)\)/);
  assert.match(media, /"range"\.equalsIgnoreCase/);
  assert.match(media, /setInstanceFollowRedirects\(false\)/);
  const activity = local("android/app/src/main/java/com/spiloveure/capacitor/test/MainActivity.java");
  assert.match(activity, /controller\.show\(WindowInsetsCompat\.Type\.systemBars\(\)\)/);
  assert.match(activity, /WindowInsetsCompat\.Type\.ime\(\)/);
});
