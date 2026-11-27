const assert = require("node:assert/strict");
const fs = require("node:fs");

const login = fs.readFileSync("app/(auth)/login.tsx", "utf8");
const activation = fs.readFileSync("app/(app)/pay.tsx", "utf8");

assert.doesNotMatch(login, /login-chat-button|const openChat|useChat/);
assert.doesNotMatch(activation, /pay-chat-button|const openChat|useChat/);
assert.match(login, /testID="login-submit"/);
assert.match(activation, /testID="pay-activate"/);

console.log("Login and activation Chat entrypoint tests passed.");
