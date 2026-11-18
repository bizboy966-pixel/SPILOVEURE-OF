import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { Card } from "./Card";
import { api, resolveMediaUrl } from "../api";
import { theme } from "../theme";

type ApkRelease = {
  apk_url?: string;
  apk_version?: string;
  apk_size_mb?: number | null;
};

type DownloadPhase = "idle" | "downloading" | "complete" | "error";
type NativeDownloadStatus = {
  status: "pending" | "running" | "success" | "failed";
  bytesDownloaded: number;
  totalBytes: number;
  error?: string;
};
type NativeApkBridge = {
  startDownload: (options: { url: string; fileName: string; version: string }) =>
    Promise<{ downloadId: number }>;
  getDownloadStatus: (options: { downloadId: number }) => Promise<NativeDownloadStatus>;
};

function isAndroidBrowser(): boolean {
  return Platform.OS === "web"
    && typeof navigator !== "undefined"
    && /android/i.test(navigator.userAgent);
}

function isCapacitorAndroid(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (window as any).Capacitor;
  return capacitor?.isNativePlatform?.() === true
    && capacitor?.getPlatform?.() === "android";
}

function getNativeApkBridge(): NativeApkBridge | null {
  if (typeof window === "undefined") return null;
  return (window as any).__SPV_APK_INSTALLER__ ?? null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(part => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map(part => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function downloadApkInBrowser(
  url: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<{ blob: Blob; totalBytes: number }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let totalBytes = 0;
    request.open("GET", url, true);
    request.responseType = "blob";
    request.timeout = 120_000;
    request.onprogress = event => {
      totalBytes = event.lengthComputable ? event.total : 0;
      onProgress(event.loaded, totalBytes);
    };
    request.onerror = () => reject(new Error("Connexion interrompue pendant le téléchargement."));
    request.ontimeout = () => reject(new Error("Le téléchargement a dépassé le délai prévu."));
    request.onabort = () => reject(new Error("Le téléchargement a été interrompu."));
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`Le serveur a refusé le téléchargement (${request.status}).`));
        return;
      }
      if (!(request.response instanceof Blob)) {
        reject(new Error("Le fichier APK reçu est illisible."));
        return;
      }
      resolve({ blob: request.response, totalBytes });
    };
    request.send();
  });
}

export function ApkDownloadCard() {
  const [release, setRelease] = useState<ApkRelease | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloadPhase, setDownloadPhase] = useState<DownloadPhase>("idle");
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [expectedBytes, setExpectedBytes] = useState(0);
  const downloadUrlRef = useRef<string | null>(null);
  const indeterminateOpacity = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    let active = true;
    api.get<ApkRelease>("/app/version", { auth: false })
      .then((value) => {
        if (active) setRelease(value);
      })
      .catch(() => {
        if (active) setError("Impossible de récupérer le lien de téléchargement.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
  }, []);

  useEffect(() => {
    if (downloadPhase !== "downloading" || expectedBytes > 0) return;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(indeterminateOpacity, { toValue: 1, duration: 500, useNativeDriver: false }),
        Animated.timing(indeterminateOpacity, { toValue: 0.45, duration: 500, useNativeDriver: false }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [downloadPhase, expectedBytes, indeterminateOpacity]);

  if (!isAndroidBrowser()) return null;

  const apkUrl = release?.apk_url ? resolveMediaUrl(release.apk_url) : "";
  const nativeBuildVersion = process.env.EXPO_PUBLIC_CAPACITOR_VERSION || "";
  const staleNativeRelease = isCapacitorAndroid()
    && Boolean(nativeBuildVersion && release?.apk_version
      && compareVersions(release.apk_version, nativeBuildVersion) <= 0);
  const ready = Boolean(apkUrl && release?.apk_version && !staleNativeRelease);

  const download = async () => {
    if (!apkUrl || !release?.apk_version || typeof window === "undefined") return;
    setError("");
    const bridge = (window as any).ReactNativeWebView;
    if (typeof bridge?.postMessage === "function") {
      bridge.postMessage(JSON.stringify({
        type: "SPV_DOWNLOAD_APK",
        url: apkUrl,
        version: release.apk_version,
      }));
      return;
    }

    const capacitorAndroid = isCapacitorAndroid();
    const nativeBridge = capacitorAndroid ? getNativeApkBridge() : null;
    setDownloadPhase("downloading");
    setDownloadProgress(0);
    setDownloadedBytes(0);
    const configuredSize = Number(release.apk_size_mb || 0) * 1024 * 1024;
    setExpectedBytes(configuredSize);

    try {
      if (capacitorAndroid) {
        if (!nativeBridge) {
          throw new Error("Le gestionnaire de téléchargement Android n’est pas disponible dans cette version.");
        }

        const fileName = `SPILOVEURE-${release.apk_version}.apk`;
        const { downloadId } = await nativeBridge.startDownload({
          url: apkUrl,
          fileName,
          version: release.apk_version,
        });
        if (!Number.isFinite(downloadId)) throw new Error("Android n’a pas démarré le téléchargement.");

        while (true) {
          await new Promise(resolve => window.setTimeout(resolve, 350));
          const status = await nativeBridge.getDownloadStatus({ downloadId });
          const received = Math.max(0, status.bytesDownloaded || 0);
          const total = status.totalBytes || configuredSize;
          setDownloadedBytes(received);
          if (total > 0) {
            setExpectedBytes(total);
            setDownloadProgress(Math.min(1, received / total));
          }
          if (status.status === "success") {
            const finalSize = status.totalBytes || received;
            setDownloadedBytes(received);
            setExpectedBytes(finalSize);
            setDownloadProgress(1);
            setDownloadPhase("complete");
            return;
          }
          if (status.status === "failed") {
            throw new Error(status.error || "Le téléchargement a été interrompu par Android.");
          }
        }
      }

      const { blob, totalBytes: responseTotal } = await downloadApkInBrowser(apkUrl, (received, total) => {
        setDownloadedBytes(received);
        const expected = total || configuredSize;
        if (expected > 0) {
          setExpectedBytes(expected);
          setDownloadProgress(Math.min(1, received / expected));
        }
      });
      if (blob.size === 0) throw new Error("Le fichier APK reçu est vide.");
      const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
        throw new Error("Le serveur n’a pas envoyé un fichier APK valide. La bonne APK doit être publiée.");
      }

      const received = blob.size;
      const total = responseTotal || received;
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      const objectUrl = URL.createObjectURL(new Blob([blob], { type: "application/vnd.android.package-archive" }));
      downloadUrlRef.current = objectUrl;
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `spiloveure-${release.apk_version}.apk`;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
        if (downloadUrlRef.current === objectUrl) downloadUrlRef.current = null;
      }, 60_000);

      setDownloadedBytes(received);
      setExpectedBytes(total || received);
      setDownloadProgress(1);
      setDownloadPhase("complete");
    } catch (downloadError: any) {
      setError(String(downloadError?.message || "Téléchargement impossible. Vérifie ta connexion puis réessaie."));
      setDownloadPhase("error");
    }
  };

  return (
    <Card style={styles.card} testID="profile-apk-download-card">
      <View style={styles.heading}>
        <View style={styles.icon}>
          <Ionicons name="logo-android" size={20} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Télécharger l’application</Text>
          <Text style={styles.subtitle}>
            Application Android • {release?.apk_version ? `version ${release.apk_version}` : "version à publier"}
          </Text>
        </View>
      </View>

      <Text style={styles.description}>
        Le téléchargement affiche sa progression. Une fois terminé, ouvre « Téléchargements » dans Chrome et touche le fichier pour lancer l’installation Android.
      </Text>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={styles.status}>Vérification de la version…</Text>
        </View>
      ) : ready ? (
        <TouchableOpacity
          onPress={download}
          style={[styles.button, downloadPhase === "downloading" && styles.buttonDisabled]}
          disabled={downloadPhase === "downloading"}
          activeOpacity={0.85}
          accessibilityRole="button"
          testID="profile-apk-download-button"
        >
          <Ionicons name="download" size={18} color="#fff" />
          <Text style={styles.buttonText}>Télécharger l’APK</Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.status} testID="profile-apk-unavailable">
          {error || (staleNativeRelease
            ? `Le serveur propose encore la version ${release?.apk_version}. Publie l’APK officielle ${nativeBuildVersion} pour activer le téléchargement.`
            : "La nouvelle version Android n’est pas encore publiée.")}
        </Text>
      )}
      <Modal
        visible={downloadPhase !== "idle"}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (downloadPhase !== "downloading") setDownloadPhase("idle");
        }}
        testID="profile-apk-download-modal"
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalIcon}>
              <Ionicons
                name={downloadPhase === "complete" ? "checkmark" : downloadPhase === "error" ? "alert" : "download"}
                size={24}
                color="#fff"
              />
            </View>
            <Text style={styles.modalTitle}>
              {downloadPhase === "downloading"
                ? "Téléchargement en cours"
                : downloadPhase === "complete"
                  ? "Téléchargement terminé"
                  : "Téléchargement interrompu"}
            </Text>

            {downloadPhase === "downloading" ? (
              <>
                <View style={styles.progressTrack} accessibilityRole="progressbar">
                  {expectedBytes > 0 ? (
                    <View style={[styles.progressFill, { width: `${Math.round(downloadProgress * 100)}%` }]} />
                  ) : (
                    <Animated.View style={[styles.progressFill, styles.indeterminateFill, { opacity: indeterminateOpacity }]} />
                  )}
                </View>
                <Text style={styles.progressLabel}>
                  {expectedBytes > 0
                    ? `${Math.round(downloadProgress * 100)} % · ${formatBytes(downloadedBytes)} / ${formatBytes(expectedBytes)}`
                    : downloadedBytes > 0
                      ? `${formatBytes(downloadedBytes)} reçus · taille totale inconnue`
                      : "Connexion au serveur…"}
                </Text>
              </>
            ) : downloadPhase === "complete" ? (
              <Text style={styles.modalDescription}>
                {isCapacitorAndroid()
                  ? "Le fichier APK est téléchargé. Touche la notification Android SPILOVEURE pour lancer l’installation."
                  : "Dans Chrome, ouvre « Téléchargements » et touche le fichier SPILOVEURE pour lancer l’installation. Android te demandera de confirmer."}
              </Text>
            ) : (
              <Text style={styles.modalError}>{error}</Text>
            )}

            {downloadPhase !== "downloading" ? (
              <View style={styles.modalActions}>
                {downloadPhase === "error" ? (
                  <TouchableOpacity style={styles.retryButton} onPress={() => void download()} accessibilityRole="button">
                    <Text style={styles.retryText}>Réessayer</Text>
                  </TouchableOpacity>
                ) : null}
                <Pressable style={styles.closeButton} onPress={() => setDownloadPhase("idle")} accessibilityRole="button">
                  <Text style={styles.closeText}>{downloadPhase === "complete" ? "Compris" : "Fermer"}</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>
    </Card>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} octet${bytes === 1 ? "" : "s"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

const styles = StyleSheet.create({
  card: { marginTop: 12, padding: 14 },
  heading: { flexDirection: "row", alignItems: "center", gap: 11 },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#16A34A",
  },
  title: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: "900" },
  subtitle: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 },
  description: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 10 },
  loading: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  status: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 10 },
  button: {
    marginTop: 13,
    borderRadius: 12,
    backgroundColor: theme.colors.primary,
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  buttonText: { color: "#fff", fontWeight: "900", fontSize: 14 },
  buttonDisabled: { opacity: 0.65 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(8, 20, 40, 0.68)",
    justifyContent: "center",
    alignItems: "center",
    padding: 22,
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 22,
    backgroundColor: "#fff",
    padding: 24,
    alignItems: "center",
  },
  modalIcon: {
    width: 54,
    height: 54,
    borderRadius: 18,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  modalTitle: {
    color: theme.colors.textPrimary,
    fontSize: 18,
    fontWeight: "900",
    textAlign: "center",
    marginTop: 14,
    marginBottom: 18,
  },
  progressTrack: {
    width: "100%",
    height: 11,
    borderRadius: 99,
    backgroundColor: "#E6EDF5",
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: 99, backgroundColor: theme.colors.primary },
  indeterminateFill: { width: "36%" },
  progressLabel: { color: theme.colors.textSecondary, fontSize: 13, fontWeight: "700", marginTop: 10, textAlign: "center" },
  modalDescription: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20, textAlign: "center" },
  modalError: { color: "#B42318", fontSize: 13, lineHeight: 19, textAlign: "center" },
  modalActions: { width: "100%", flexDirection: "row", gap: 10, marginTop: 20 },
  retryButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: { color: "#fff", fontSize: 14, fontWeight: "900" },
  closeButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: "#EDF2FA",
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: "900" },
});
