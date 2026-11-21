import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { api, resolveMediaUrl } from "@/src/api";
import { theme } from "@/src/theme";
import {
  requiresMandatoryApkUpdate,
  resolveAndroidAppVersion,
  validateApkUrl,
} from "@/src/utils/androidApkRelease";
import type { ApkRelease } from "@/src/utils/androidApkRelease";
import {
  downloadApkWithProgress,
  requestApkInstall,
} from "@/src/utils/capacitorApkUpdate";
import type { ApkInstallerBridge } from "@/src/utils/capacitorApkUpdate";

const API_BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL || "https://spiloveure.org";
const APP_VERSION = resolveAndroidAppVersion(process.env.EXPO_PUBLIC_CAPACITOR_VERSION);

type Phase = "checking" | "idle" | "downloading" | "installing" | "permission";

declare global {
  interface Window {
    __SPV_APK_INSTALLER__?: ApkInstallerBridge;
  }
}

function getNativeInstaller(): ApkInstallerBridge | null {
  if (typeof window === "undefined") return null;
  // This bridge is registered only by the official Capacitor runtime. The
  // bundled web frontend must not rely on the Expo platform identifier.
  return window.__SPV_APK_INSTALLER__ || null;
}

export default function AndroidApkUpdateManager() {
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>("checking");
  const [downloadVersion, setDownloadVersion] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [progress, setProgress] = useState({ loaded: 0, total: 0, percent: 0 });
  const [error, setError] = useState("");
  const phaseRef = useRef<Phase>("checking");
  const downloadIdRef = useRef<number | null>(null);
  const checkingRef = useRef(false);
  const installingRef = useRef(false);

  const setCurrentPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const checkRelease = useCallback(async () => {
    if (!getNativeInstaller() || checkingRef.current
        || phaseRef.current === "downloading" || phaseRef.current === "installing"
        || phaseRef.current === "permission") return;
    checkingRef.current = true;
    try {
      const current = await api.get<ApkRelease>("/app/version", { auth: false });
      if (!requiresMandatoryApkUpdate(APP_VERSION, current)) {
        setVisible(false);
        setCurrentPhase("idle");
        return;
      }
      const url = validateApkUrl(resolveMediaUrl(current.apk_url || ""), API_BASE_URL);
      setDownloadVersion(current.apk_version || "");
      setDownloadUrl(url);
      setProgress({ loaded: 0, total: 0, percent: 0 });
      setError("");
      setVisible(true);
      setCurrentPhase("idle");
    } catch {
      // Keep launch available when the version service is temporarily offline.
      setCurrentPhase("idle");
    } finally {
      checkingRef.current = false;
    }
  }, [setCurrentPhase]);

  const installDownloadedApk = useCallback(async () => {
    const bridge = getNativeInstaller();
    const downloadId = downloadIdRef.current;
    if (!bridge || downloadId === null || installingRef.current) return;
    installingRef.current = true;
    setError("");
    setCurrentPhase("installing");
    try {
      const result = await requestApkInstall(bridge, downloadId);
      installingRef.current = result.status === "installing";
      setCurrentPhase(result.status === "permission_required" ? "permission" : "installing");
      if (result.status === "permission_required") {
        setError("Autorise SPILOVEURE à installer cette mise à jour dans les paramètres Android. L’installation reprendra à ton retour.");
      }
    } catch (installError: any) {
      installingRef.current = false;
      setCurrentPhase("idle");
      setError(String(installError?.message || "Android n’a pas pu lancer l’installation. Réessaie."));
    }
  }, [setCurrentPhase]);

  useEffect(() => {
    if (!getNativeInstaller()) return;
    void checkRelease();
    const onAppState = (event: Event) => {
      const isActive = (event as CustomEvent<{ isActive?: boolean }>).detail?.isActive;
      if (!isActive) return;
      if (phaseRef.current === "permission" && downloadIdRef.current !== null) {
        void installDownloadedApk();
      } else if (phaseRef.current === "installing") {
        // Returning from Android's installer without replacing the package means
        // the user cancelled. Keep the mandatory gate and allow another attempt.
        installingRef.current = false;
        setCurrentPhase("idle");
        setError("L’installation n’a pas été confirmée. Appuie de nouveau sur « Mise à jour » pour réessayer.");
      } else {
        void checkRelease();
      }
    };
    window.addEventListener("spv-capacitor-app-state", onAppState);
    return () => {
      window.removeEventListener("spv-capacitor-app-state", onAppState);
    };
  }, [checkRelease, installDownloadedApk, setCurrentPhase]);

  const startUpdate = useCallback(async () => {
    const bridge = getNativeInstaller();
    if (!bridge || !downloadUrl || !downloadVersion) {
      setError("Aucune version Android valide n’est disponible pour le moment.");
      return;
    }
    setError("");
    setProgress({ loaded: 0, total: 0, percent: 0 });
    setCurrentPhase("downloading");
    try {
      const downloadId = await downloadApkWithProgress(
        bridge,
        downloadUrl,
        downloadVersion,
        setProgress,
      );
      downloadIdRef.current = downloadId;
      await installDownloadedApk();
    } catch (downloadError: any) {
      setCurrentPhase("idle");
      setError(String(downloadError?.message || "Téléchargement impossible. Vérifie ta connexion puis réessaie."));
    }
  }, [downloadUrl, downloadVersion, installDownloadedApk, setCurrentPhase]);

  if (!getNativeInstaller()) return null;

  const loadedMb = progress.loaded / (1024 * 1024);
  const totalMb = progress.total / (1024 * 1024);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        // A published Android release is mandatory; this gate cannot be dismissed.
      }}
      testID="android-apk-update-modal"
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.icon}>
            <Text style={styles.iconText}>↻</Text>
          </View>
          <Text style={styles.title}>Mise à jour disponible</Text>
          <Text style={styles.description}>
            Une mise à jour est disponible. Veuillez mettre votre application à jour pour continuer.
          </Text>
          {downloadVersion ? <Text style={styles.version}>Version {downloadVersion}</Text> : null}

          {phase === "downloading" ? (
            <View style={styles.progressSection} testID="android-apk-update-progress">
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${progress.percent}%` }]} />
              </View>
              <Text style={styles.progressLabel} testID="android-apk-update-percent">
                {progress.percent}%{progress.total > 0 ? ` • ${loadedMb.toFixed(1)} / ${totalMb.toFixed(1)} Mo` : ""}
              </Text>
            </View>
          ) : null}
          {phase === "installing" ? (
            <View style={styles.installing}>
              <ActivityIndicator color={theme.colors.primary} />
              <Text style={styles.progressLabel}>Android ouvre l’installation. Confirme pour appliquer la mise à jour.</Text>
            </View>
          ) : null}
          {phase === "permission" ? (
            <Text style={styles.permissionMessage}>
              Autorise l’installation depuis SPILOVEURE dans Android. À ton retour, l’installation reprendra.
            </Text>
          ) : null}
          {error ? <Text style={styles.errorMessage} testID="android-apk-update-error">{error}</Text> : null}

          {phase === "idle" || phase === "checking" ? (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => void startUpdate()}
              accessibilityRole="button"
              testID="android-apk-update-start"
            >
              <Text style={styles.actionButtonText}>Mise à jour</Text>
            </TouchableOpacity>
          ) : null}
          {phase === "downloading" ? (
            <View style={styles.downloadingRow}>
              <ActivityIndicator color={theme.colors.primary} />
              <Text style={styles.progressLabel}>Téléchargement en cours…</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(8, 20, 40, 0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 22,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 24,
    backgroundColor: theme.colors.surface,
    padding: 24,
    alignItems: "center",
  },
  icon: {
    width: 60,
    height: 60,
    borderRadius: 20,
    backgroundColor: "#DBEAFE",
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: { color: theme.colors.primary, fontSize: 36, fontWeight: "900", lineHeight: 42 },
  title: { color: theme.colors.textPrimary, fontSize: 20, fontWeight: "900", textAlign: "center", marginTop: 16 },
  description: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20, textAlign: "center", marginTop: 8 },
  version: { color: theme.colors.primary, fontSize: 13, fontWeight: "800", marginTop: 8 },
  progressSection: { width: "100%", marginTop: 22 },
  progressTrack: { height: 10, borderRadius: 99, backgroundColor: theme.colors.border, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 99, backgroundColor: theme.colors.primary },
  progressLabel: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: "700", textAlign: "center", marginTop: 8 },
  installing: { marginTop: 18, alignItems: "center", gap: 8 },
  downloadingRow: { marginTop: 18, alignItems: "center" },
  permissionMessage: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 18 },
  errorMessage: { color: theme.colors.error, fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 14 },
  actionButton: {
    width: "100%",
    marginTop: 20,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  actionButtonText: { color: "#fff", fontSize: 15, fontWeight: "900" },
});
