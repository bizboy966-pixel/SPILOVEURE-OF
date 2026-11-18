/* global __dirname */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const read = relative => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
const userLinksSource = read("src/messenger/userLinks.ts");
const compiled = ts.transpileModule(userLinksSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleBox,
  exports: moduleBox.exports,
  URL,
  window: { location: { origin: "https://spiloveure.org" } },
});
const { messengerProfileRouteFromUrl, safeMessengerReturnTo } = moduleBox.exports;

test("personal SPILOVEURE links become safe in-app chat routes", () => {
  assert.equal(
    messengerProfileRouteFromUrl("https://spiloveure.org/messenger?username=SPV%40Support.Agent"),
    "/messenger?username=Support.Agent",
  );
  assert.equal(
    messengerProfileRouteFromUrl("/messenger?username=%40support"),
    "/messenger?username=support",
  );
  assert.equal(messengerProfileRouteFromUrl("https://t.me/support"), null);
  assert.equal(messengerProfileRouteFromUrl("https://example.com/messenger?username=support"), null);
  assert.equal(messengerProfileRouteFromUrl("/messenger?username=support&next=https://evil.test"), null);
});

test("email verification only returns to an approved destination and preserves the chat target", () => {
  assert.equal(safeMessengerReturnTo("/messenger?username=SPV%40support"), "/messenger?username=support");
  assert.equal(safeMessengerReturnTo("/account-access?source=chat"), "/account-access?source=chat");
  assert.equal(safeMessengerReturnTo("https://example.com/messenger?username=support"), "/messenger");
  assert.equal(safeMessengerReturnTo("/messenger?username=support&redirect=evil"), "/messenger");
});

test("support links route internally and still preserve external Telegram links", () => {
  const fab = read("src/components/TelegramFab.tsx");
  const settings = read("app/(app)/settings.tsx");
  assert.match(fab, /messengerProfileRouteFromUrl\(url\)/);
  assert.match(fab, /router\.push\(chatRoute as any\)/);
  assert.match(fab, /Linking\.openURL\(url\)/);
  assert.match(settings, /messengerProfileRouteFromUrl\(url\)/);
  assert.match(settings, /router\.push\(chatRoute as any\)/);
});

test("direct chat destinations survive expired or explicitly logged-out sessions", () => {
  const messenger = read("src/messenger/MessengerScreen.tsx");
  const identity = read("src/identity/IdentityPages.tsx");
  assert.match(messenger, /directUsernameParam[\s\S]*?\/verify-email\?source=chat&expired=1&returnTo=/);
  assert.match(messenger, /const returnTo = directUsernameParam[\s\S]*?username=\$\{encodeURIComponent\(directUsernameParam\)\}/);
  assert.match(identity, /safeMessengerReturnTo\(p\.returnTo\)/);
  assert.match(identity, /clearChatLogoutMarker\(\)/);
});
