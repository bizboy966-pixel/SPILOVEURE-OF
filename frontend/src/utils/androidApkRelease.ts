export type ApkRelease = {
  apk_url?: string;
  apk_version?: string;
  apk_mandatory?: boolean;
  apk_minimum_supported_version?: string;
};

export function resolveAndroidAppVersion(capacitorVersion?: string, expoVersion?: string): string {
  return capacitorVersion?.trim() || expoVersion?.trim() || "0.0.0";
}

export function compareAppVersions(left: string, right: string): number {
  const parts = (value: string) => value.split("-")[0].split(".").map((part) => Number(part) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function requiresMandatoryApkUpdate(appVersion: string, release: ApkRelease): boolean {
  const minimum = release.apk_minimum_supported_version || release.apk_version || "";
  return Boolean(
    release.apk_mandatory
    && release.apk_url
    && release.apk_version
    && minimum
    && compareAppVersions(appVersion, minimum) < 0,
  );
}

export function validateApkUrl(rawUrl: string, apiBaseUrl: string): string {
  let base: URL;
  let url: URL;
  try {
    base = new URL(apiBaseUrl);
    url = new URL(rawUrl, `${base.origin}/`);
  } catch {
    throw new Error("L’adresse du fichier APK n’est pas valide.");
  }
  if (base.protocol !== "https:" || url.protocol !== "https:" || url.origin !== base.origin) {
    throw new Error("Le lien APK doit provenir du domaine HTTPS de SPILOVEURE.");
  }
  if (!url.pathname.toLowerCase().endsWith(".apk")) {
    throw new Error("Le lien ne pointe pas vers un fichier APK.");
  }
  return url.toString();
}
