const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const config = require("../frontend/app.config.js");
const profiles = require("../frontend/eas.json").build;
const { externalizeReplitUrls } = require("./eas-test-lockfile.cjs");
const test = profiles["test-apk"].env;

// Only touch public build settings inside this short-lived test process.
for (const key of ["SPV_ANDROID_TEST", "SPV_ANDROID_RELEASE", "EXPO_PUBLIC_TEST_BUILD",
  "EXPO_PUBLIC_BACKEND_URL", "ANDROID_VERSION_CODE"]) delete process.env[key];
const live = config();
assert.equal(live.name, "SPILOVEURE");
assert.equal(live.android.package, "com.spilivere.app");
assert.equal(live.scheme, "spilivere");

Object.assign(process.env, test);
const preview = config();
assert.equal(preview.name, "SPILOVEURE TEST");
assert.equal(preview.android.package, "com.spilivere.app.preview");
assert.equal(preview.ios.bundleIdentifier, "com.spilivere.app.preview");
assert.equal(preview.scheme, "spiloveure-test");
assert.equal(preview.updates.enabled, false);
assert.equal(preview.extra.eas.projectId, live.extra.eas.projectId);
assert.equal(profiles["test-apk"].android.buildType, "apk");
assert.equal(profiles["test-apk"].developmentClient, false);
assert.match(fs.readFileSync("frontend/package.json", "utf8"), /eas-build-pre-install/);
assert.match(fs.readFileSync("package.json", "utf8"), /eas-build-pre-install/);
const originalUrl = "http://package-firewall.replit.internal/npm/@scope/pkg/-/pkg-1.2.3.tgz";
assert.equal(externalizeReplitUrls(originalUrl),
  "https://registry.yarnpkg.com/@scope/pkg/-/pkg-1.2.3.tgz");
const rootLock = fs.readFileSync("yarn.lock", "utf8");
const preparedLock = externalizeReplitUrls(rootLock);
assert.ok(preparedLock.length > 0 && !preparedLock.includes("package-firewall.replit.internal"));
assert.match(preparedLock, /https:\/\/registry\.yarnpkg\.com\//);
assert.equal(externalizeReplitUrls(fs.readFileSync("frontend/yarn.lock", "utf8")),
  fs.readFileSync("frontend/yarn.lock", "utf8"));

for (const origin of ["https://spiloveure.org", "http://localhost:8000",
  "https://example.replit.dev.attacker.invalid", "https://user:password@example.replit.dev"]) {
  process.env.EXPO_PUBLIC_BACKEND_URL = origin;
  assert.throws(config, /refused/);
}
process.env.EXPO_PUBLIC_BACKEND_URL = test.EXPO_PUBLIC_BACKEND_URL;
process.env.SPV_ANDROID_RELEASE = "1";
assert.throws(config, /both/);
delete process.env.SPV_ANDROID_RELEASE;
delete process.env.EXPO_PUBLIC_TEST_BUILD;
assert.throws(config, /safeguards/);
delete process.env.SPV_ANDROID_TEST;
process.env.SPV_ANDROID_RELEASE = "1";
assert.throws(config, /release refused/);
process.env.EXPO_PUBLIC_BACKEND_URL = "https://official.example";
assert.equal(config().android.package, live.android.package);
process.env.SPV_ANDROID_RELEASE = "1";
process.env.ANDROID_VERSION_CODE = profiles["production-apk"].env.ANDROID_VERSION_CODE;
const production = config();
assert.equal(production.version, "1.1.5");
assert.equal(production.android.versionCode, 6);
assert.equal(production.android.package, "com.spilivere.app");
assert.equal(profiles["production-apk"].credentialsSource, "remote");
assert.equal(profiles["production-apk"].android.buildType, "apk");
assert.equal(profiles["production-apk"].env.EXPO_PUBLIC_BACKEND_URL, "https://spiloveure.org");

const exported = {};
const compiled = ts.transpileModule(fs.readFileSync("frontend/src/testBuildSafety.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
vm.runInNewContext(compiled, { exports: exported, URL });
const guard = exported.assertIsolatedTestRequest;
const backend = test.EXPO_PUBLIC_BACKEND_URL;
for (const [path, method] of [
  ["/auth/login", "POST"], ["/auth/register", "POST"],
  ["/identity/email/verify", "POST"], ["/identity/chat/open", "POST"],
  ["/messenger/conversations", "POST"], ["/messenger/conversations/test/messages", "POST"],
  ["/messenger/conversations/test/files", "POST"], ["/messenger/profile", "PATCH"],
  ["/config", "GET"], ["/dashboard", "GET"],
]) assert.doesNotThrow(() => guard(backend, path, method));
for (const [path, method] of [
  ["/payments/init", "POST"], ["/activation/request", "POST"],
  ["/withdrawals", "POST"], ["/admin/users", "DELETE"], ["/wallet", "PUT"],
  ["/messenger/../payments/init", "POST"], ["/messenger/test%2fadmin", "POST"],
]) assert.throws(() => guard(backend, path, method), error => error.status === 403);
assert.throws(() => guard("https://spiloveure.org", "/auth/login", "POST"), error => error.status === 403);
console.log("PASS: distinct test app, Replit-only backend, production guards intact, financial/admin mutations refused.");
