#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const ANDROID = path.join(__dirname, "android");
const APK_PATH = path.join(ANDROID, "app/build/outputs/apk/release/app-release.apk");
const OUTPUT_DIR = path.join(ROOT, "generated-artifacts/spiloveure");
const OFFICIAL_API = "https://spiloveure.org/api/app";
const PACKAGE_NAME = "com.spilivere.app";

function fail(message) {
  throw new Error(message);
}

function compareVersions(left, right) {
  const a = String(left || "").split(".").map(Number);
  const b = String(right || "").split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function assertReleaseMetadata(metadata, current = {}) {
  if (metadata.packageName !== PACKAGE_NAME) {
    fail("Identifiant Android invalide : l’APK n’est pas SPILOVEURE.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version || "")) {
    fail("Version officielle invalide : format stable X.Y.Z requis.");
  }
  if (!Number.isSafeInteger(metadata.versionCode) || metadata.versionCode < 1) {
    fail("Code de version Android invalide.");
  }
  if (metadata.debuggable === true || metadata.buildType === "debug") {
    fail("Une APK debug ne peut pas être publiée.");
  }
  if (current.apk_version && compareVersions(metadata.version, current.apk_version) <= 0) {
    fail(`La version ${metadata.version} doit dépasser la dernière APK publiée (${current.apk_version}).`);
  }
  const currentCode = Number(current.apk_version_code);
  if (Number.isSafeInteger(currentCode) && currentCode > 0 && metadata.versionCode <= currentCode) {
    fail(`Le code Android ${metadata.versionCode} doit dépasser le code déjà publié (${currentCode}).`);
  }
}

function locateAndroidTool(name) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const candidates = [];
  if (sdk) {
    const buildTools = path.join(sdk, "build-tools");
    if (fs.existsSync(buildTools)) {
      const versions = fs.readdirSync(buildTools).sort((a, b) =>
        compareVersions(b.replace(/-.*/, ""), a.replace(/-.*/, "")));
      for (const version of versions) candidates.push(path.join(buildTools, version, name));
    }
  }
  candidates.push(name);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
    if (!path.isAbsolute(candidate)) {
      const result = spawnSync("which", [candidate], { encoding: "utf8" });
      if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    }
  }
  fail(`Outil Android manquant : ${name}. Installez Android SDK Build Tools.`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const reason = (result.stderr || result.stdout || "").trim().slice(-1200);
    fail(`${command} a échoué${reason ? ` : ${reason}` : "."}`);
  }
  return result.stdout || "";
}

function inspectReleaseApk(apkPath, tools = {}) {
  if (!fs.existsSync(apkPath) || fs.statSync(apkPath).size === 0) {
    fail("La compilation n’a pas produit de fichier APK.");
  }
  const signature = run(tools.apksigner || locateAndroidTool("apksigner"), [
    "verify", "--verbose", "--print-certs", apkPath,
  ]);
  const badging = run(tools.aapt || locateAndroidTool("aapt"), ["dump", "badging", apkPath]);
  const packageMatch = badging.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
  const signerMatch = signature.match(/certificate SHA-256 digest:\s*([a-fA-F0-9:]+)/i);
  if (!packageMatch || !signerMatch) fail("Impossible de lire le package ou le certificat de l’APK.");
  const metadata = {
    packageName: packageMatch[1],
    versionCode: Number(packageMatch[2]),
    version: packageMatch[3],
    signerSha256: signerMatch[1].replace(/:/g, "").toLowerCase(),
    debuggable: badging.includes("application-debuggable"),
  };
  if (!/^[a-f0-9]{64}$/.test(metadata.signerSha256)) fail("Empreinte de signature invalide.");
  assertReleaseMetadata(metadata);
  return metadata;
}

async function fetchCurrentRelease(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${OFFICIAL_API}/version`, { cache: "no-store" });
  if (!response.ok) fail(`Impossible de vérifier la version publiée (HTTP ${response.status}).`);
  const release = await response.json();
  return {
    apk_version: release.apk_version || "",
    apk_version_code: release.apk_version_code,
  };
}

async function publishVerifiedApk({ apkPath, metadata, current = {}, env = process.env, fetchImpl = globalThis.fetch }) {
  // Validate the artifact before constructing a request. Debug builds can never reach the upload call.
  assertReleaseMetadata(metadata, current);
  const token = (env.ANDROID_RELEASE_TOKEN || "").trim();
  if (!token) fail("ANDROID_RELEASE_TOKEN manque dans les secrets Replit ; aucun APK n’a été publié.");
  if (!fs.existsSync(apkPath)) fail("Fichier APK introuvable.");

  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(apkPath)], {
    type: "application/vnd.android.package-archive",
  }), `SPILOVEURE-${metadata.version}.apk`);
  const response = await fetchImpl(`${OFFICIAL_API}/releases/publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 800);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.detail || detail;
    } catch {}
    fail(`Le VPS a refusé la publication (HTTP ${response.status}) : ${detail}`);
  }
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    fail("Le VPS a répondu avec un résultat de publication illisible.");
  }
  if (result.ok !== true || result.version !== metadata.version) {
    fail("Le VPS n’a pas confirmé la publication de la version compilée.");
  }
  return result;
}

async function runOfficialRelease() {
  if (!(process.env.ANDROID_RELEASE_TOKEN || "").trim()) {
    fail("ANDROID_RELEASE_TOKEN manque dans les secrets Replit ; aucun build officiel ne sera lancé.");
  }
  const current = await fetchCurrentRelease();
  const gradle = fs.readFileSync(path.join(ANDROID, "app/build.gradle"), "utf8");
  const configuredVersion = gradle.match(/versionName\s+"([^"]+)"/)?.[1] || "";
  const configuredCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
  if (!configuredVersion || !Number.isSafeInteger(configuredCode)) {
    fail("La versionName ou le versionCode de Gradle est manquant.");
  }
  assertReleaseMetadata({
    packageName: PACKAGE_NAME,
    version: configuredVersion,
    versionCode: configuredCode,
    debuggable: false,
  }, current);
  const destination = path.join(OUTPUT_DIR, `SPILOVEURE-${configuredVersion}.apk`);
  if (fs.existsSync(destination)) {
    fail(`Le fichier ${path.basename(destination)} existe déjà ; une version publiée ne doit pas être remplacée.`);
  }

  run("pnpm", ["run", "sync"], { cwd: __dirname, inherit: true });
  run(path.join(ANDROID, "gradlew"), [":app:assembleRelease"], { cwd: ANDROID, inherit: true });
  const metadata = inspectReleaseApk(APK_PATH);
  assertReleaseMetadata(metadata, current);
  if (metadata.version !== configuredVersion || metadata.versionCode !== configuredCode) {
    fail("La version intégrée au fichier APK ne correspond pas à la configuration Gradle.");
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.copyFileSync(APK_PATH, destination, fs.constants.COPYFILE_EXCL);
  const result = await publishVerifiedApk({ apkPath: destination, metadata, current });
  console.log(`APK officielle ${result.version} publiée automatiquement : ${result.url}`);
}

if (require.main === module) {
  runOfficialRelease().catch((error) => {
    console.error(`Release APK interrompue : ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertReleaseMetadata,
  inspectReleaseApk,
  publishVerifiedApk,
};
