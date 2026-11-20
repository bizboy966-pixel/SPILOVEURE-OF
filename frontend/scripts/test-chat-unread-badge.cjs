const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const frontendRoot = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(frontendRoot, "src/messenger/unreadBadge.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const helperModule = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", compiled)(
  helperModule.exports,
  require,
  helperModule,
  "unreadBadge.js",
  frontendRoot,
);
const { sumUnreadMessages, unreadBadgeLabel } = helperModule.exports;
const nav = fs.readFileSync(path.join(frontendRoot, "src/components/BottomNav.tsx"), "utf8");

test("unread total sums valid conversation counts and ignores invalid values", () => {
  assert.equal(sumUnreadMessages([
    { unread: 2 },
    { unread: 0 },
    { unread: -4 },
    { unread: 1.9 },
    { unread: Number.NaN },
    { unread: "5" },
    {},
  ]), 3);
});

test("badge is hidden at zero and stays compact for large totals", () => {
  assert.equal(unreadBadgeLabel(0), null);
  assert.equal(unreadBadgeLabel(-1), null);
  assert.equal(unreadBadgeLabel(1), "1");
  assert.equal(unreadBadgeLabel(42), "42");
  assert.equal(unreadBadgeLabel(100), "99+");
});

test("navigation badge only loads for an existing Chat session and refreshes live", () => {
  assert.match(nav, /if \(!chatUser\?\.id\) \{\s*setUnreadMessages\(0\)/);
  assert.match(nav, /messengerApi\.conversations\(false\)/);
  assert.match(nav, /messengerApi\.conversations\(true\)/);
  assert.match(nav, /setInterval\(\(\) => \{ void refreshUnread\(\); \}, 30_000\)/);
  assert.match(nav, /state === "active"[\s\S]{0,100}refreshUnread/);
  assert.match(nav, /window\.addEventListener\("focus", handleFocus\)/);
  assert.match(nav, /\["message", "updated", "read", "delivered"\]\.includes\(data\.type\)/);
  assert.match(nav, /testID="bottom-nav-chat-badge"/);
  assert.match(nav, /setUnreadMessages\(sumUnreadMessages\(\[\.\.\.active, \.\.\.archived\]\)\)/);
});
