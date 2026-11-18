import React, { useEffect, useRef, useState } from "react";
import {
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

function isAndroidBrowser(): boolean {
  return Platform.OS === "web"
    && typeof navigator !== "undefined"
    && /android/i.test(navigator.userAgent);
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

  if (!isAndroidBrowser()) return null;

  const apkUrl = release?.apk_url ? resolveMediaUrl(release.apk_url) : "";
  const ready = Boolean(apkUrl && release?.apk_version);

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

    setDownloadPhase("downloading");
    setDownloadProgress(0);
    setDownloadedBytes(0);
    const configuredSize = Number(release.apk_size_mb || 0) * 1024 * 1024;
    setExpectedBytes(configuredSize);

    try {
      const response = await fetch(apkUrl, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(`Le serveur a refusé le téléchargement (${response.status}).`);

      const contentLength = Number(response.headers.get("content-length") || 0);
      const total = contentLength || configuredSize;
      if (total > 0) setExpectedBytes(total);
      if (!response.body?.getReader) {
        throw new Error("Ce navigateur ne permet pas de suivre le téléchargement. Mets Chrome à jour et réessaie.");
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let lastProgressUpdate = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        received += value.byteLength;
        const now = Date.now();
        if (now - lastProgressUpdate >= 100) {
          setDownloadedBytes(received);
          if (total > 0) setDownloadProgress(Math.min(1, received / total));
          lastProgressUpdate = now;
        }
      }

      if (received === 0) throw new Error("Le fichier APK reçu est vide.");
      if (contentLength > 0 && received !== contentLength) {
        throw new Error("Le téléchargement est incomplet. Vérifie ta connexion puis réessaie.");
      }

      const blob = new Blob(chunks as BlobPart[], { type: "application/vnd.android.package-archive" });
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      const objectUrl = URL.createObjectURL(blob);
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
          style={styles.button}
          activeOpacity={0.85}
          accessibilityRole="button"
          testID="profile-apk-download-button"
        >
          <Ionicons name="download" size={18} color="#fff" />
          <Text style={styles.buttonText}>Télécharger l’APK</Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.status} testID="profile-apk-unavailable">
          {error || "La nouvelle version Android n’est pas encore publiée."}
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
                  <View style={[styles.progressFill, { width: `${Math.round(downloadProgress * 100)}%` }]} />
                </View>
                <Text style={styles.progressLabel}>
                  {expectedBytes > 0
                    ? `${Math.round(downloadProgress * 100)} % · ${formatBytes(downloadedBytes)} / ${formatBytes(expectedBytes)}`
                    : `${formatBytes(downloadedBytes)} téléchargés`}
                </Text>
                {expectedBytes <= 0 ? <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 10 }} /> : null}
              </>
            ) : downloadPhase === "complete" ? (
              <Text style={styles.modalDescription}>
                Dans Chrome, ouvre « Téléchargements » et touche le fichier SPILOVEURE pour lancer l’installation. Android te demandera de confirmer.
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
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
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
