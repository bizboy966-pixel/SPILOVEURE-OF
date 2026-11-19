#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { assertReleaseMetadata, inspectReleaseApk } = require("./release-official.cjs");

const ROOT = path.resolve(__dirname, "../..");
const ANDROID = path.join(__dirname, "android");
const APK_PATH = path.join(ANDROID, "app/build/outputs/apk/release/app-release.apk");
const OUTPUT_DIR = path.join(ROOT, "generated-artifacts/spiloveure");
const OFFICIAL_SIGNER_SHA256 = "18c1572225506ea0b3fa03cf43e91dc22d8b916209b5e0b697831d8923cade52";

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} a échoué avec le code ${result.status ?? "inconnu"}.`);
  }
}

function readConfiguredVersion() {
  const gradle = fs.readFileSync(path.join(ANDROID, "app/build.gradle"), "utf8");
  const version = gradle.match(/versionName\s+"([^"]+)"/)?.[1] || "";
  const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
  if (!/^\d+\.\d+\.\d+$/.test(version) || !Number.isSafeInteger(versionCode) || versionCode < 1) {
    fail("La version Android officielle est absente ou invalide.");
  }
  return { version, versionCode };
}

function buildOfficialApk() {
  const missing = ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD"]
    .filter(name => !(process.env[name] || "").trim());
  if (missing.length) {
    fail(`La signature release n’est pas configurée sur le VPS : ${missing.join(", ")}.`);
  }

  const configured = readConfiguredVersion();
  const destination = path.join(OUTPUT_DIR, `SPILOVEURE-${configured.version}.apk`);
  if (fs.existsSync(destination)) {
    fail(`Le fichier ${path.basename(destination)} existe déjà ; aucun fichier ne sera écrasé.`);
  }

  fs.rmSync(APK_PATH, { force: true });
  run("pnpm", ["run", "sync"], __dirname);
  run("./gradlew", [":app:assembleRelease"], ANDROID);

  const metadata = inspectReleaseApk(APK_PATH);
  assertReleaseMetadata(metadata);
  if (metadata.version !== configured.version || metadata.versionCode !== configured.versionCode) {
    fail("La version intégrée dans l’APK ne correspond pas à la configuration Gradle.");
  }
  if (metadata.signerSha256 !== OFFICIAL_SIGNER_SHA256) {
    fail("La clé de signature ne correspond pas au certificat officiel des versions déjà installées.");
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.copyFileSync(APK_PATH, destination, fs.constants.COPYFILE_EXCL);
  const sha256 = createHash("sha256").update(fs.readFileSync(destination)).digest("hex");
  console.log([
    `APK de test compilée et signée : ${destination}`,
    `Version : ${metadata.version} (code ${metadata.versionCode})`,
    `SHA-256 : ${sha256}`,
    "Cette commande n’envoie pas l’APK au VPS public et ne publie aucune mise à jour.",
  ].join("\n"));
  return { ...metadata, path: destination, sha256 };
}

if (require.main === module) {
  try {
    buildOfficialApk();
  } catch (error) {
    console.error(`Compilation APK interrompue : ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildOfficialApk, readConfiguredVersion };
