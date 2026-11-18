const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const detection = read("src/utils/isAndroidApkWebView.ts");
const dashboard = read("app/(app)/dashboard.tsx");
const marketplace = read("app/(app)/marketplace.tsx");
const webView = read("src/components/AndroidWebApp.android.tsx");

function detectApkWebView(userAgent, bridge = false) {
  const compiled = ts.transpileModule(detection, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    window: bridge ? { ReactNativeWebView: { postMessage() {} } } : {},
    document: {},
    navigator: { userAgent },
  });
  return module.exports.isAndroidApkWebView();
}

test("APK is detected by its bridge or Android WebView signature, not Chrome", () => {
  assert.equal(detectApkWebView("Android 15 Chrome/131.0 Mobile Safari/537.36", true), true);
  assert.equal(detectApkWebView("Android 15; wv) Version/4.0 Chrome/131.0 Mobile Safari/537.36"), true);
  assert.equal(detectApkWebView("Android 15 Chrome/131.0 Mobile Safari/537.36"), false);
  assert.match(webView, /onMessage=\{onWebMessage\}/);
});

test("dashboard removes its duplicate top inset and uses a smaller APK header", () => {
  assert.match(dashboard, /edges=\{isApkWebView \? \[\] : \["top"\]\}/);
  assert.match(dashboard, /isApkWebView && styles\.apkHeader/);
  assert.match(dashboard, /apkBrandLogo: \{ width: 34, height: 34/);
});

test("Marketplace keeps the browser safe area and skips it only inside the APK", () => {
  assert.match(marketplace, /const ScreenContainer = isApkWebView \? View : SafeAreaView/);
  assert.match(marketplace, /<ScreenContainer style=\{\{ flex: 1, backgroundColor: theme\.colors\.background \}\}>/);
});
