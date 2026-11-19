// Isolated production export: never overwrite frontend/build or change Expo configuration.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "../..");
const output = path.join(__dirname, "www");
const config = require("./capacitor.config.json");
if (config.server.url || config.appId !== "com.spilivere.app") {
  throw new Error("L'application officielle doit embarquer le web avec son identifiant Android officiel.");
}
fs.rmSync(output, { recursive: true, force: true });
execFileSync("pnpm", ["--filter", "frontend", "exec", "expo", "export",
  "--platform", "web", "--output-dir", output], {
  cwd: root, stdio: "inherit",
  env: {
    ...process.env,
    CI: "1", EXPO_NO_TELEMETRY: "1", EXPO_NO_DOTENV: "1",
    EXPO_PUBLIC_BACKEND_URL: "https://spiloveure.org",
    EXPO_PUBLIC_CAPACITOR_NATIVE: "1",
    EXPO_PUBLIC_CAPACITOR_VERSION: "1.1.15",
    EXPO_PUBLIC_TEST_BUILD: "0",
  },
});
buildSync({
  entryPoints: [path.join(__dirname, "runtime.js")],
  outfile: path.join(output, "capacitor-runtime.js"),
  bundle: true, minify: true, platform: "browser", format: "iife",
});
const index = path.join(output, "index.html");
let html = fs.readFileSync(index, "utf8");
html = html.replace(/<title>[^<]*<\/title>/, "<title>SPILOVEURE</title>");
// Install native API/back-button behavior before the React bundle starts.
html = html.replace("<head>", '<head><script src="/capacitor-runtime.js"></script>');
fs.writeFileSync(index, html);
// A previous web service worker must never own this APK's bundled routes.
for (const name of ["sw.js", "firebase-messaging-sw.js", "manifest.webmanifest"]) {
  fs.rmSync(path.join(output, name), { force: true });
}
fs.writeFileSync(path.join(output, "capacitor-build.json"), JSON.stringify({
  name: config.appName, applicationId: config.appId, version: "1.1.15", versionCode: 16,
  backend: "https://spiloveure.org", bundledFrontend: true,
  builtAt: new Date().toISOString(), physicalDeviceValidated: false,
}, null, 2));
console.log("Front-end de l'APK officielle prêt ; signature et contrôle sur téléphone requis.");
