export type ApkDownloadStatus = {
  status: "pending" | "running" | "success" | "failed";
  bytesDownloaded: number;
  totalBytes: number;
  error?: string;
};

export type ApkInstallResult = { status: "installing" | "permission_required" };

export type ApkInstallerBridge = {
  startDownload(options: { url: string; fileName: string; version: string }): Promise<{ downloadId: number }>;
  getDownloadStatus(options: { downloadId: number }): Promise<ApkDownloadStatus>;
  installDownloadedApk(options: { downloadId: number }): Promise<ApkInstallResult>;
};

export type DownloadProgress = { loaded: number; total: number; percent: number };

const sleep = (duration: number) => new Promise<void>(resolve => setTimeout(resolve, duration));

export async function downloadApkWithProgress(
  bridge: ApkInstallerBridge,
  url: string,
  version: string,
  onProgress: (progress: DownloadProgress) => void,
  wait: (duration: number) => Promise<void> = sleep,
): Promise<number> {
  const { downloadId } = await bridge.startDownload({
    url,
    fileName: `SPILOVEURE-${version}.apk`,
    version,
  });
  if (!Number.isSafeInteger(downloadId) || downloadId < 0) {
    throw new Error("Android n’a pas retourné un identifiant de téléchargement valide.");
  }

  let attempts = 0;
  while (attempts < 2400) {
    const current = await bridge.getDownloadStatus({ downloadId });
    const loaded = Math.max(0, current.bytesDownloaded || 0);
    const total = Math.max(0, current.totalBytes || 0);
    const percent = total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
    onProgress({ loaded, total, percent });

    if (current.status === "success") {
      onProgress({ loaded: total || loaded, total, percent: 100 });
      return downloadId;
    }
    if (current.status === "failed") {
      throw new Error(current.error || "Le téléchargement de la mise à jour a échoué.");
    }
    if (current.status !== "pending" && current.status !== "running") {
      throw new Error("Android a retourné un état de téléchargement inconnu.");
    }
    attempts += 1;
    await wait(500);
  }
  throw new Error("Le téléchargement prend trop de temps. Vérifie ta connexion puis réessaie.");
}

export async function requestApkInstall(
  bridge: ApkInstallerBridge,
  downloadId: number,
): Promise<ApkInstallResult> {
  if (!Number.isSafeInteger(downloadId) || downloadId < 0) {
    throw new Error("Identifiant de téléchargement invalide.");
  }
  const result = await bridge.installDownloadedApk({ downloadId });
  if (result?.status !== "installing" && result?.status !== "permission_required") {
    throw new Error("Android n’a pas pu ouvrir l’installation de la mise à jour.");
  }
  return result;
}
