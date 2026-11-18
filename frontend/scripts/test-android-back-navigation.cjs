/* global __dirname */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const read = relative => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
const source = read("src/navigation/androidBack.ts");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleBox,
  exports: moduleBox.exports,
  require: name => {
    if (name === "react-native") return { Alert: { alert() {} }, BackHandler: { exitApp() {} } };
    throw new Error(`Unexpected dependency: ${name}`);
  },
});
const { resolveAndroidBackAction } = moduleBox.exports;

test("the messenger conversation closes before the route or app", () => {
  assert.equal(resolveAndroidBackAction({
    scope: "messenger", isMessengerRoute: true, hasOpenConversation: true, canGoBack: true,
  }), "close-conversation");
  assert.equal(resolveAndroidBackAction({
    scope: "messenger", isMessengerRoute: true, hasOpenConversation: true, canGoBack: false,
  }), "close-conversation");
});

test("a secondary route lets Expo navigate to the previous screen", () => {
  assert.equal(resolveAndroidBackAction({
    scope: "root", isMessengerRoute: false, hasOpenConversation: false, canGoBack: true,
  }), "navigate-back");
});

test("the root asks before exiting and messenger handles its own back priority", () => {
  assert.equal(resolveAndroidBackAction({
    scope: "root", isMessengerRoute: false, hasOpenConversation: false, canGoBack: false,
  }), "confirm-exit");
  assert.equal(resolveAndroidBackAction({
    scope: "root", isMessengerRoute: true, hasOpenConversation: false, canGoBack: false,
  }), "defer-to-messenger");
  assert.equal(resolveAndroidBackAction({
    scope: "messenger", isMessengerRoute: true, hasOpenConversation: false, canGoBack: false,
  }), "confirm-exit");
});

test("Android-only back handlers are connected at root and in the chat", () => {
  const root = read("app/_layout.tsx");
  const messenger = read("src/messenger/MessengerScreen.tsx");
  assert.match(root, /Platform\.OS !== "android"/);
  assert.match(root, /BackHandler\.addEventListener\("hardwareBackPress"/);
  assert.match(root, /confirmAndroidAppExit\(\)/);
  assert.match(messenger, /Platform\.OS !== "android"/);
  assert.match(messenger, /setSelected\(null\);[\s\S]*?setSelectedMessageId\(null\)/);
});

test("every React Native modal in the chat defines a hardware-back close action", () => {
  const directory = path.join(__dirname, "..", "src", "messenger");
  const files = fs.readdirSync(directory).filter(file => /\.(tsx|ts)$/.test(file));
  const modalFiles = files.filter(file => /<Modal\b/.test(fs.readFileSync(path.join(directory, file), "utf8")));
  assert.ok(modalFiles.length > 0);
  for (const file of modalFiles) {
    const text = fs.readFileSync(path.join(directory, file), "utf8");
    const openings = text.match(/<Modal\b[\s\S]*?>/g) || [];
    assert.ok(openings.length > 0, `${file} should contain a modal`);
    for (const opening of openings) {
      assert.match(opening, /onRequestClose=/, `${file} has a modal without an Android back action`);
    }
  }
});
