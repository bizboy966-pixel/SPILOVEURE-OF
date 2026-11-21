import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";

import { api, resolveMediaUrl } from "@/src/api";
import {
  ApkRelease,
  requiresMandatoryApkUpdate,
  resolveAndroidAppVersion,
  validateApkUrl,
} from "@/src/utils/androidApkRelease";

const API_BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL || "https://spiloveure.org";
const APP_VERSION = resolveAndroidAppVersion(
  process.env.EXPO_PUBLIC_CAPACITOR_VERSION,
  String(Constants.expoConfig?.version || ""),
);
const APP_PACKAGE = String(Constants.expoConfig?.android?.package || "com.spilivere.app");

type DownloadPhase = "idle" | "downloading" | "ready";

export default function AndroidApkUpdateManager() {
  const updateFlowActive = useRef(false);
  const [release, setRelease] = useState<ApkRelease | null>(null);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<DownloadPhase>("idle");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadVersion, setDownloadVersion] = useState("");
  const [downloadUri, setDownloadUri] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [installPermissionNeeded, setInstallPermissionNeeded] = useState(false);

  const checkRelease = useCallback(async () => {
    if (updateFlowActive.current) return;
    try {
      const current = await api.get<ApkRelease>("/app/version", { auth: false });
      setRelease(current);
      if (!requiresMandatoryApkUpdate(APP_VERSION, current)) return;
      const url = validateApkUrl(resolveMediaUrl(current.apk_url), API_BASE_URL);
      setDownloadUrl(url);
      setDownloadVersion(current.apk_version || "");
      setDownloadUri(null);
      setProgress(0);
      setError("");
      setPhase("idle");
      setInstallPermissionNeeded(false);
      setVisible(true);
    } catch {
      // A version-service outage must not prevent the native app from opening.
    }
  }, []);

  useEffect(() => {
    void checkRelease();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void checkRelease();
    });
    return () => subscription.remove();
  }, [checkRelease]);

  const startDownload = useCallback(async () => {
    if (!downloadUrl || !downloadVersion) return;
    updateFlowActive.current = true;
    setPhase("downloading");
    setProgress(0);
    setDownloadUri(null);
    setError("");
    setInstallPermissionNeeded(false);
    try {
      const safeVersion = downloadVersion.replace(/[^A-Za-z0-9.-]/g, "_");
      const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      if (!baseDir) throw new Error("Espace de stockage temporaire indisponible.");
      const fileUri = `${baseDir}spiloveure-${safeVersion}.apk`;
      const previous = await FileSystem.getInfoAsync(fileUri);
      if (previous.exists) await FileSystem.deleteAsync(fileUri, { idempotent: true });
      const task = FileSystem.createDownloadResumable(downloadUrl, fileUri, {}, (result) => {
        const total = result.totalBytesExpectedToWrite;
        if (total > 0) setProgress(Math.min(1, result.totalBytesWritten / total));
      });
      const result = await task.downloadAsync();
      if (!result?.uri || result.status < 200 || result.status >= 300) {
        throw new Error("Le téléchargement de la mise à jour n’a pas abouti.");
      }
      const info = await FileSystem.getInfoAsync(result.uri);
      if (!info.exists || ("size" in info && typeof info.size === "number" && info.size <= 0)) {
        throw new Error("Le fichier téléchargé est vide. Réessaie avec une meilleure connexion.");
      }
      setDownloadUri(result.uri);
      setProgress(1);
      setPhase("ready");
    } catch (downloadError: any) {
      updateFlowActive.current = false;
      setError(String(downloadError?.message || "Téléchargement impossible. Vérifie ta connexion puis réessaie."));
      setPhase("idle");
    }
  }, [downloadUrl, downloadVersion]);

  const installDownloadedApk = useCallback(async () => {
    if (!downloadUri) return;
    setError("");
    setInstallPermissionNeeded(false);
    try {
      const contentUri = await FileSystem.getContentUriAsync(downloadUri);
      await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
        data: contentUri,
        type: "application/vnd.android.package-archive",
        flags: 1,
      });
    } catch {
      setInstallPermissionNeeded(true);
      setError("Autorise SPILOVEURE à installer cette mise à jour depuis Android, puis réessaie.");
    }
  }, [downloadUri]);

  const openInstallPermissionSettings = useCallback(async () => {
    try {
      await IntentLauncher.startActivityAsync("android.settings.MANAGE_UNKNOWN_APP_SOURCES", {
        data: `package:${APP_PACKAGE}`,
      });
    } catch {
      setError("Ouvre les paramètres Android de SPILOVEURE et autorise « Installer des applis inconnues ».");
    }
  }, []);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        // Required updates cannot be dismissed with Android's system Back button.
      }}
      testID="android-apk-update-modal"
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.icon}>
            <Text style={styles.iconText}>↓</Text>
          </View>
          <Text style={styles.title}>Nouvelle mise à jour disponible</Text>
          <Text style={styles.description}>
            Mettez votre application à jour pour continuer. Version Android {downloadVersion || release?.apk_version || ""}.
          </Text>

          {phase === "downloading" ? (
            <View style={styles.progressSection} testID="android-apk-update-progress">
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
              </View>
              <Text style={styles.progressLabel}>{Math.round(progress * 100)} % téléchargé</Text>
            </View>
          ) : null}

          {phase === "ready" ? (
            <Text style={styles.successMessage}>
              Téléchargement terminé. Appuie sur Installer et confirme dans Android.
            </Text>
          ) : null}
          {error ? <Text style={styles.errorMessage}>{error}</Text> : null}

          {phase === "ready" ? (
            <TouchableOpacity style={styles.actionButton} onPress={() => void installDownloadedApk()} accessibilityRole="button">
              <Text style={styles.actionButtonText}>Installer</Text>
            </TouchableOpacity>
          ) : phase === "downloading" ? (
            <View style={styles.downloadingRow}>
              <ActivityIndicator color="#1B5BFF" />
              <Text style={styles.progressLabel}>Téléchargement en cours…</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => void startDownload()}
              accessibilityRole="button"
              testID="android-apk-update-start"
            >
              <Text style={styles.actionButtonText}>Mettre à jour</Text>
            </TouchableOpacity>
          )}

          {installPermissionNeeded ? (
            <Pressable style={styles.settingsButton} onPress={() => void openInstallPermissionSettings()}>
              <Text style={styles.settingsLabel}>Ouvrir les paramètres d’installation</Text>
            </Pressable>
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
    backgroundColor: "#fff",
    padding: 24,
    alignItems: "center",
  },
  icon: {
    width: 60,
    height: 60,
    borderRadius: 20,
    backgroundColor: "#DCFCE7",
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: { color: "#159447", fontSize: 36, fontWeight: "900", lineHeight: 42 },
  title: { color: "#162A47", fontSize: 20, fontWeight: "900", textAlign: "center", marginTop: 16 },
  description: { color: "#5A6B80", fontSize: 14, lineHeight: 20, textAlign: "center", marginTop: 8 },
  progressSection: { width: "100%", marginTop: 22 },
  progressTrack: { height: 10, borderRadius: 99, backgroundColor: "#E6EDF5", overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 99, backgroundColor: "#1B5BFF" },
  progressLabel: { color: "#506078", fontSize: 12, fontWeight: "700", textAlign: "center", marginTop: 8 },
  downloadingRow: { marginTop: 18, alignItems: "center" },
  successMessage: { color: "#16774B", fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 18 },
  errorMessage: { color: "#B42318", fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 14 },
  actionButton: {
    width: "100%",
    marginTop: 20,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: "#1B5BFF",
    alignItems: "center",
    justifyContent: "center",
  },
  actionButtonText: { color: "#fff", fontSize: 15, fontWeight: "900" },
  settingsButton: { marginTop: 12, padding: 9 },
  settingsLabel: { color: "#1B5BFF", fontSize: 12, fontWeight: "800", textAlign: "center" },
});
