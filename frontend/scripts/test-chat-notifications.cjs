const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.join(__dirname, "..");
function soundModule(overrides = {}) {
  let oscillators = 0;
  class Context {
    state = "running";
    currentTime = 0;
    destination = {};
    createOscillator() {
      oscillators++;
      return { type: "", frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
  }
  const exports = {};
  const sandbox = {
    exports, Blob, console, setTimeout, clearTimeout,
    window: { AudioContext: Context, setTimeout: callback => { queueMicrotask(callback); return 1; } },
    ...overrides,
  };
  const source = fs.readFileSync(path.join(root, "src/messenger/notificationSound.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  return { ...exports, oscillatorCount: () => oscillators };
}

test("mute and sound-off never start audio; built-in tones are playable", async () => {
  const audio = soundModule();
  const base = { enabled: true, sound_enabled: true, preview: true, sound: "default" };
  await audio.playNotificationSound("test", "global", { ...base, enabled: false });
  await audio.playNotificationSound("test", "global", { ...base, sound_enabled: false });
  assert.equal(audio.oscillatorCount(), 0);
  await audio.playNotificationSound("test", "global", base);
  assert.equal(audio.oscillatorCount(), 1);
  await audio.playNotificationSound("test", "global", { ...base, sound: "bell" });
  assert.equal(audio.oscillatorCount(), 3);
});

test("missing custom sounds report an error instead of silently replacing them", async () => {
  const audio = soundModule();
  await assert.rejects(audio.playNotificationSound("test", "global", {
    enabled: true, sound_enabled: true, preview: true, sound: "custom",
  }), /stockage audio/);
  assert.equal(audio.oscillatorCount(), 0);
});

function worker({ preview, status = 200 } = {}) {
  let background;
  const events = {};
  const shown = [];
  const fetched = [];
  const opened = [];
  const context = {
    importScripts() {},
    URL, encodeURIComponent, console,
    firebase: { initializeApp() {}, messaging: () => ({ onBackgroundMessage(callback) { background = callback; } }) },
    clients: {
      matchAll: async () => [],
      openWindow: async url => opened.push(url),
    },
    fetch: async (url, options) => {
      fetched.push({ url, options });
      return { ok: status >= 200 && status < 300, json: async () => preview };
    },
    self: {
      location: { origin: "https://test.invalid" },
      registration: { showNotification: async (title, options) => shown.push({ title, options }) },
      addEventListener: (name, callback) => { events[name] = callback; },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "public/firebase-messaging-sw.js"), "utf8"), context);
  return { background: payload => background(payload), events, shown, fetched, opened };
}
const payload = { data: { kind: "chat", conversation_id: "test-chat", message_id: "test-message", title: "Stale preview", body: "Private data", link: "/messenger?conversation=test-chat" } };

test("background notification rechecks privacy and offers real actions", async () => {
  const sw = worker({ preview: {
    enabled: true, title: "SPILOVEURE Chat", body: "Nouveau message", avatar: null,
    settings: { sound_enabled: false },
  } });
  await sw.background(payload);
  assert.equal(sw.fetched[0].options.credentials, "include");
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "SPILOVEURE Chat");
  assert.equal(sw.shown[0].options.body, "Nouveau message");
  assert.equal(sw.shown[0].options.silent, true);
  assert.equal(sw.shown[0].options.actions.map(item => item.action).join(","), "reply,unread");
});

test("background notifications never expose revoked, muted or expired messages", async () => {
  for (const options of [{ status: 401 }, { status: 404 }, { preview: { enabled: false } }]) {
    const sw = worker(options);
    await sw.background(payload);
    assert.equal(sw.shown.length, 0);
  }
});

test("unread notification action calls the authenticated endpoint", async () => {
  const sw = worker();
  let work;
  sw.events.notificationclick({
    action: "unread",
    notification: { close() {}, data: { kind: "chat", conversation_id: "test-chat" } },
    waitUntil(promise) { work = promise; },
  });
  await work;
  assert.equal(sw.fetched[0].url, "/api/messenger/conversations/test-chat/unread");
  assert.equal(sw.fetched[0].options.method, "POST");
  assert.equal(sw.fetched[0].options.credentials, "include");
  assert.equal(sw.opened.length, 0);
});

test("reply opens the right discussion with composer intent, not another origin", async () => {
  const sw = worker();
  let work;
  sw.events.notificationclick({
    action: "reply",
    notification: { close() {}, data: { kind: "chat", conversation_id: "test-chat", url: "/messenger?conversation=test-chat" } },
    waitUntil(promise) { work = promise; },
  });
  await work;
  const url = new URL(sw.opened[0]);
  assert.equal(url.pathname, "/messenger");
  assert.equal(url.searchParams.get("conversation"), "test-chat");
  assert.equal(url.searchParams.get("notificationAction"), "reply");
  sw.events.notificationclick({
    action: "",
    notification: { close() {}, data: { url: "https://evil.invalid" } },
    waitUntil() { assert.fail("Must reject external notification redirects"); },
  });
  assert.equal(sw.opened.length, 1);
});
