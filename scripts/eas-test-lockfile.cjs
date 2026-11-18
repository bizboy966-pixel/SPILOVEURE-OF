const fs = require("node:fs");
const path = require("node:path");

const INTERNAL_PREFIX = "http://package-firewall.replit.internal/npm/";
const PUBLIC_PREFIX = "https://registry.yarnpkg.com/";

function externalizeReplitUrls(lockfile) {
  return lockfile.replaceAll(INTERNAL_PREFIX, PUBLIC_PREFIX);
}

function prepareAndroidBuildLockfile() {
  if (!["test-apk", "production-apk"].includes(process.env.EAS_BUILD_PROFILE) ||
      process.env.EAS_BUILD_PLATFORM !== "android") {
    console.log("Skipping APK lockfile preparation outside Android APK profiles.");
    return;
  }

  const root = path.resolve(__dirname, "..");
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (!pkg.packageManager?.startsWith("pnpm@") ||
        !fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8").includes("\n  frontend:")) {
      throw new Error("EAS requires the committed pnpm workspace and frontend lock entry.");
    }
    console.log("EAS Android uses the committed pnpm lockfile; legacy Yarn lockfiles remain unchanged.");
    return;
  }

  const lockPath = path.resolve(__dirname, "..", "yarn.lock");
  const original = fs.readFileSync(lockPath, "utf8");
  const updated = externalizeReplitUrls(original);
  const remaining = updated.split(INTERNAL_PREFIX).length - 1;
  if (remaining) {
    throw new Error(`Could not prepare Expo dependency URLs (${remaining} remain).`);
  }
  if (updated === original) {
    throw new Error("No Replit-only dependency URLs were found; refusing an unexplained rewrite.");
  }

  fs.writeFileSync(lockPath, updated);
  console.log(
    `Prepared the temporary EAS Android lockfile (${original.split(INTERNAL_PREFIX).length - 1} package URLs now use the public Yarn registry).`
  );
}

if (require.main === module) prepareAndroidBuildLockfile();

module.exports = { externalizeReplitUrls };
