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
  await audio.playNotificationSound("test", "global", { ...base, sound: "marimba" });
  assert.equal(audio.oscillatorCount(), 6);
  assert.deepEqual(Array.from(audio.BUILT_IN_NOTIFICATION_SOUNDS), [
    "default", "chime", "bell", "soft", "bright", "bubble", "pulse", "marimba",
  ]);
});

test("notification settings offer tap-to-preview and persist the selected built-in tone", () => {
  const panel = fs.readFileSync(path.join(root, "src/messenger/NotificationSettingsPanel.tsx"), "utf8");
  assert.match(panel, /onPress=\{\(\) => void chooseSound\(sound\)\}/);
  assert.match(panel, /await playNotificationSound\(userId, scope, \{\s*\.\.\.effectiveSettings, sound, enabled: true, sound_enabled: true,/);
  assert.match(panel, /api\.patch<Settings>\(endpoint, \{ sound \}\)/);
  assert.match(panel, /radio-button-on/);
});

test("conversation header follows the rounded Telegram-style back, identity and actions layout", () => {
  const thread = fs.readFileSync(path.join(root, "src/messenger/ConversationThread.tsx"), "utf8");
  assert.match(thread, /styles\.backButton/);
  assert.match(thread, /styles\.identityPill/);
  assert.match(thread, /styles\.headerActionPill/);
  assert.match(thread, /const chatSurface = darkMode \? "#111827" : "#b9e3d9";/);
  assert.match(thread, /styles\.thread,\s*\{\s*backgroundColor: chatSurface\s*\}/);
  assert.match(thread, /styles\.history,\s*\{\s*backgroundColor: chatSurface\s*\}/);
  assert.match(thread, /styles\.historyContent,\s*\{\s*backgroundColor: chatSurface\s*\}/);
  assert.match(thread, /conversation\.is_saved \? <Ionicons name="bookmark"/);
  assert.match(thread, /messenger-header-more/);
  assert.match(thread, /testID="messenger-scheduled-open"/);
});

test("missing custom sounds report an error instead of silently replacing them", async () => {
  const audio = soundModule();
  await assert.rejects(audio.playNotificationSound("test", "global", {
    enabled: true, sound_enabled: true, preview: true, sound: "custom",
  }), /stockage audio/);
  assert.equal(audio.oscillatorCount(), 0);
});

test("oversized audio is cropped as a valid WAV, never by truncating compressed bytes", async () => {
  const audio = soundModule();
  const sampleRate = 48000;
  const samples = new Float32Array(1_200_000).fill(0.25);
  const result = audio.encodeNotificationExcerpt({
    sampleRate, length: samples.length, numberOfChannels: 2,
    getChannelData: () => samples,
  });
  assert.ok(result.blob.size <= 4 * 1024 * 1024);
  assert.equal(result.blob.type, "audio/wav");
  assert.ok(result.duration > 20 && result.duration < 22);
  const bytes = await result.blob.arrayBuffer();
  const view = new DataView(bytes);
  assert.equal(Buffer.from(bytes, 0, 4).toString(), "RIFF");
  assert.equal(Buffer.from(bytes, 8, 4).toString(), "WAVE");
  assert.equal(view.getUint32(4, true), result.blob.size - 8);
  assert.equal(view.getUint32(40, true), result.blob.size - 44);
  assert.equal(view.getInt16(result.blob.size - 2, true), 0);
});

test("small audio remains intact; large audio is decoded before cropping", async () => {
  const decoded = {
    length: 5000, numberOfChannels: 1, sampleRate: 44100, duration: 5000 / 44100,
    getChannelData: () => new Float32Array(5000),
  };
  class Context {
    state = "running";
    decodeAudioData = async () => decoded;
  }
  const audio = soundModule({ window: { AudioContext: Context } });
  const small = new Blob(["audio"], { type: "audio/mpeg" });
  const smallResult = await audio.prepareNotificationSound(small);
  assert.equal(smallResult.blob, small);
  assert.equal(smallResult.trimmed, false);
  const large = new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]);
  const largeResult = await audio.prepareNotificationSound(large);
  assert.equal(largeResult.trimmed, true);
  assert.equal(largeResult.blob.type, "audio/wav");
  assert.ok(largeResult.blob.size <= 4 * 1024 * 1024);
  await assert.rejects(audio.prepareNotificationSound(new Blob([])), /vide/);
});

test("custom sound unlocks audio before asynchronous local storage access", async () => {
  const order = [];
  class Context {
    state = "suspended";
    destination = {};
    resume() { order.push("resume"); this.state = "running"; return Promise.resolve(); }
    decodeAudioData() { order.push("decode"); return Promise.resolve({ duration: 10 }); }
    createBufferSource() {
      const source = {
        connect() {}, disconnect() {},
        start(when, offset, duration) {
          assert.equal(duration, 6);
          order.push("play");
          queueMicrotask(() => source.onended());
        },
      };
      return source;
    }
  }
  const indexedDB = {
    open() {
      order.push("storage");
      const request = {};
      request.result = {
        close() {},
        transaction() {
          return { objectStore: () => ({ get() {
            const read = { result: { file: new Blob(["audio"]), name: "test.mp3" } };
            queueMicrotask(() => read.onsuccess());
            return read;
          } }) };
        },
      };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  };
  const audio = soundModule({ window: { AudioContext: Context }, indexedDB });
  await audio.playNotificationSound("test", "global", {
    enabled: true, sound_enabled: true, preview: true, sound: "custom",
  });
  assert.equal(order.join(","), "resume,storage,decode,play");
});

function permissionModule(windowOverrides = {}, notification = { permission: "default", requestPermission: () => Promise.resolve("granted") }) {
  const exports = {};
  const top = {};
  const source = fs.readFileSync(path.join(root, "src/messenger/browserNotificationPermission.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, window: { self: top, top, isSecureContext: true, ...windowOverrides },
    ...(notification === null ? {} : { Notification: notification }),
  });
  return exports;
}

test("permission is requested synchronously in the click, before any SDK await", async () => {
  let requested = false;
  const permission = permissionModule({}, {
    permission: "default",
    requestPermission: () => { requested = true; return Promise.resolve("granted"); },
  });
  const result = permission.requestChatNotificationPermission();
  assert.equal(requested, true);
  assert.equal(await result, "granted");
});

test("blocked permissions and embedded previews explain the real restriction", async () => {
  await assert.rejects(permissionModule({}, { permission: "denied" }).requestChatNotificationPermission(), /paramètres du navigateur/);
  await assert.rejects(permissionModule({ self: {}, top: {} }).requestChatNotificationPermission(), /nouvel onglet/);
  await assert.rejects(permissionModule({ isSecureContext: false }).requestChatNotificationPermission(), /HTTPS/);
});

test("availability prevents impossible permission prompts and allows granted access", () => {
  assert.equal(permissionModule({}, null).chatNotificationAvailability().canRequest, false);
  assert.match(permissionModule({}, null).chatNotificationAvailability().message, /écran d’accueil/);
  assert.equal(permissionModule({}, { permission: "denied" }).chatNotificationAvailability().canRequest, false);
  assert.equal(permissionModule({ self: {}, top: {} }).chatNotificationAvailability().canRequest, false);
  assert.equal(permissionModule({ self: {}, top: {} }, { permission: "granted" }).chatNotificationAvailability().canRequest, true);
  assert.equal(permissionModule().chatNotificationAvailability().canRequest, true);
});

test("floating support is limited to the principal dashboard", () => {
  const source = fs.readFileSync(path.join(root, "app/(app)/_layout.tsx"), "utf8");
  assert.match(source, /const isDashboard = inAppGroup && currentSeg === "dashboard"/);
  assert.match(source, /isDashboard && isActivated && <TelegramFab/);
  assert.doesNotMatch(source, /!isMessenger && isActivated && <TelegramFab/);
});

test("status reply input yields space to the like, microphone and send buttons", () => {
  const text = fs.readFileSync(path.join(root, "src/messenger/StatusStories.tsx"), "utf8");
  const parsed = ts.createSourceFile("StatusStories.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  const walk = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "styles") declaration = node;
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  assert.ok(declaration);
  const exported = {};
  const compiled = ts.transpileModule(`exports.styles = ${declaration.initializer.getText(parsed)};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports: exported,
    StyleSheet: { create: value => value, absoluteFillObject: {} },
    blue: "#1769e8", ink: "#102042", muted: "#7d879a",
  });
  const styles = exported.styles;
  assert.equal(styles.replyInput.minWidth, 0, "Avoid the browser's intrinsic input width");
  assert.equal(styles.replyInput.flexBasis, 0);
  assert.equal(styles.replyInput.flexShrink, 1);
  for (const control of ["likeButton", "replySecondaryButton", "replySend"]) {
    assert.equal(styles[control].flexShrink, 0, `${control} must retain its visible width`);
  }
  assert.equal(styles.replyActions.flexWrap, "nowrap");
  for (const width of [280, 320, 360, 390, 430, 720]) {
    const padding = styles.replyActions.paddingHorizontal;
    const gap = styles.replyActions.gap;
    const input = width - 2 * padding - 3 * gap
      - styles.likeButton.width - styles.replySecondaryButton.width - styles.replySend.width;
    assert.ok(input >= 80, `A readable input must fit at ${width}px`);
    const sendEdge = padding + styles.likeButton.width + gap + input + gap
      + styles.replySecondaryButton.width + gap + styles.replySend.width;
    assert.ok(sendEdge <= width - padding, `The entire send button must fit at ${width}px`);
  }
});

test("emoji keyboard is below the composer and outside hidden modals", () => {
  const file = ts.createSourceFile("ConversationThread.tsx",
    fs.readFileSync(path.join(root, "src/messenger/ConversationThread.tsx"), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let composer, picker;
  const walk = node => {
    if (ts.isJsxElement(node)) {
      for (const attribute of node.openingElement.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        if (attribute.name.getText(file) === "testID" && attribute.initializer?.text === "messenger-emoji-picker") picker = node;
        if (attribute.name.getText(file) === "style" && attribute.initializer?.expression?.getText(file).includes("styles.composer")) composer = node;
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  assert.ok(composer && picker);
  assert.ok(composer.end < picker.pos, "The composer must be above the emoji keyboard");
  for (let parent = picker.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent)) assert.notEqual(parent.openingElement.tagName.getText(file), "Modal");
  }
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
