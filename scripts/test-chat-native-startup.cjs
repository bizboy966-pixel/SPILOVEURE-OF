const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

// Exercise mount/unmount effects with RN's real global shape: window exists
// on Android/iOS, but does not provide browser add/removeEventListener.
function harness(platform) {
  const effects = [];
  const listeners = new Map();
  const calls = { added: [], removed: [], appState: [], appStateRemoved: 0, conversations: 0 };
  const noop = () => {};
  const react = {
    createElement: () => null,
    useState: initial => [typeof initial === "function" ? initial() : initial, noop],
    useRef: current => ({ current }),
    useCallback: callback => callback,
    useMemo: callback => callback(),
    useEffect: effect => effects.push(effect),
  };
  const native = {
    BackHandler: { addEventListener: () => ({ remove: () => {} }) },
    Platform: { OS: platform },
    StyleSheet: { create: value => value, absoluteFillObject: {} },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    AppState: {
      addEventListener: (name, callback) => {
        calls.appState.push({ name, callback });
        return { remove: () => { calls.appStateRemoved++; } };
      },
    },
  };
  const api = {
    get: async () => ({}),
    post: async () => ({ ticket: "test-ticket" }),
  };
  const messengerApi = {
    conversations: async () => { calls.conversations++; return []; },
    capabilities: async () => ({}),
  };
  const router = { replace: noop, push: noop, setParams: noop };
  const stubs = {
    react,
    "react-native": native,
    "expo-router": { useRouter: () => router, useLocalSearchParams: () => ({}) },
    "@/src/chat/ChatContext": {
      useChat: () => ({ user: { id: "test-user" }, loading: false, refresh: async () => null }),
    },
    "@/src/api": { api, reportChatUnauthorized: noop },
    "@/src/utils/storage": { storage: { getItem: async (_key, fallback) => fallback, setItem: async () => true } },
    "./api": { messengerApi },
    "./useConversations": {
      useConversations: () => ({
        items: [], loading: false, refresh: noop, setArchived: noop,
        typingByConversation: {}, readReceipts: {},
      }),
    },
    "./NavigationTransition": { useNavigationTransition: () => ({ active: false }) },
    "./notificationRuntime": { setActiveNotificationConversation: noop },
    "@/src/chat/chatLaunchState": { wasChatExplicitlyLoggedOut: async () => false },
    "./chatVisualTokens": { chatVisual: {} },
  };
  const context = {
    console, process: { env: { EXPO_PUBLIC_BACKEND_URL: "https://backend.example" } },
    setTimeout, clearTimeout, requestAnimationFrame: noop,
    WebSocket: class { close() {} },
    require: name => stubs[name] || {},
  };
  // RN's setUpGlobals.js assigns global.window = global. Do the same here.
  context.window = context;
  if (platform === "web") {
    context.addEventListener = (name, callback) => {
      calls.added.push(name);
      listeners.set(name, callback);
    };
    context.removeEventListener = name => {
      calls.removed.push(name);
      listeners.delete(name);
    };
  }
  function load(path) {
    const exports = {};
    const compiled = ts.transpileModule(fs.readFileSync(path, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.React, esModuleInterop: true,
      },
      fileName: path,
    }).outputText;
    vm.runInNewContext(compiled, { ...context, exports }, { filename: path });
    return exports;
  }
  async function mount(render) {
    render();
    const cleanups = effects.map(effect => effect()).filter(value => typeof value === "function");
    // Let async ticket/storage callbacks settle before unmounting.
    await new Promise(resolve => setImmediate(resolve));
    return () => cleanups.reverse().forEach(cleanup => cleanup());
  }
  return { calls, listeners, load, mount };
}

for (const platform of ["android", "ios", "web"]) {
  test(`Chat screen mounts and unmounts on ${platform}`, async () => {
    const h = harness(platform);
    const screen = h.load("frontend/src/messenger/MessengerScreen.tsx").default;
    const unmount = await h.mount(screen);
    if (platform === "web") {
      assert.deepEqual(h.calls.added, ["spv-chat-mark-unread", "spv-chat-inbox-refresh"]);
      h.listeners.get("spv-chat-mark-unread")({ detail: { conversationId: "test-conversation" } });
      h.listeners.get("spv-chat-inbox-refresh")();
    } else {
      assert.deepEqual(h.calls.added, []);
    }
    unmount();
    assert.deepEqual([...h.calls.removed].sort(), [...h.calls.added].sort());
  });

  test(`Conversation lifecycle keeps native AppState and web focus on ${platform}`, async () => {
    const h = harness(platform);
    const hook = h.load("frontend/src/messenger/useConversations.ts").useConversations;
    const unmount = await h.mount(() => hook("test-user"));
    assert.equal(h.calls.appState[0].name, "change");
    const before = h.calls.conversations;
    h.calls.appState[0].callback("active");
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(h.calls.conversations > before, "returning to the app refreshes conversations");
    assert.deepEqual(h.calls.added, platform === "web" ? ["focus"] : []);
    if (platform === "web") h.listeners.get("focus")();
    unmount();
    assert.equal(h.calls.appStateRemoved, 1);
    assert.deepEqual(h.calls.removed, h.calls.added);
  });
}
