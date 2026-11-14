const fs = require("node:fs");
const path = require("node:path");

const INTERNAL_PREFIX = "http://package-firewall.replit.internal/npm/";
const PUBLIC_PREFIX = "https://registry.yarnpkg.com/";

function externalizeReplitUrls(lockfile) {
  return lockfile.replaceAll(INTERNAL_PREFIX, PUBLIC_PREFIX);
}

function prepareTestBuildLockfile() {
  if (process.env.EAS_BUILD_PROFILE !== "test-apk" ||
      process.env.EAS_BUILD_PLATFORM !== "android") {
    console.log("Skipping isolated APK lockfile preparation outside Android test-apk.");
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
    throw new Error("No Replit-only dependency URLs were found; refusing an unexplained retry.");
  }

  fs.writeFileSync(lockPath, updated);
  console.log(
    `Prepared the temporary EAS test-build lockfile (${original.split(INTERNAL_PREFIX).length - 1} package URLs now use the public Yarn registry).`
  );
}

if (require.main === module) prepareTestBuildLockfile();

module.exports = { externalizeReplitUrls };
