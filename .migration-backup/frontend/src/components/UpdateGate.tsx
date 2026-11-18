import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, Modal, ActivityIndicator, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CLIENT_VERSION } from "../version";
import { api } from "../api";
import { theme } from "../theme";
import { triggerUpdate, installApp, getPlatform, getInstallState } from "../pwaInstall";

type Check = {
  client_version: string | null;
  current_version: string;
  minimum_supported_version: string;
  update_available: boolean;
  update_required: boolean;
};

// SPILOVEURE — v27an (2026-03-04)
//
// Blocking update modal reworked with the full « Mettre à jour → progression
// réelle → Installer maintenant » flow the user asked for. When the backend
// says the client's version is below `minimum_supported_version` AND
// `mandatory=true`, the overlay appears and cannot be dismissed. The user
// clicks « Mettre à jour » which re-caches every asset of the new release
// through the service worker, reports true byte progress 0→100, then
// shows « Installer maintenant » that activates the new SW and reloads.
type Phase = "idle" | "downloading" | "ready" | "installing";

export function UpdateGate({ children }: { children: React.ReactNode }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [percent, setPercent] = useState(0);
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<any>(null);

  const fetchCheck = useCallback(async () => {
    try {
      const r = await api.get<Check>(`/app/version/check?client_version=${encodeURIComponent(CLIENT_VERSION)}`);
      setCheck(r);
    } catch {
      /* ne bloque pas l'app sur un échec transitoire */
    }
  }, []);

  useEffect(() => {
    fetchCheck();
    timerRef.current = setInterval(fetchCheck, 60000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchCheck]);

  const blocking = !!(check?.update_required);
  const nextVersion = check?.current_version || "—";

  const startDownload = useCallback(async () => {
    setError(null);
    setPhase("downloading");
    setPercent(0);
    setLoadedBytes(0);
    setTotalBytes(0);
    try {
      await triggerUpdateDownload(({ loaded, total, percent }) => {
        setLoadedBytes(loaded);
        setTotalBytes(total);
        setPercent(percent);
      }, nextVersion);
      setPercent(100);
      setPhase("ready");
    } catch (err: any) {
      setError(String(err?.message || err || "Erreur de téléchargement"));
      setPhase("idle");
    }
  }, [nextVersion]);

  const applyAndRestart = useCallback(async () => {
    setPhase("installing");
    try {
      // Trigger native install prompt only if the app isn't already installed.
      // Otherwise the SW swap + reload is enough.
      if (!getInstallState().isStandalone) {
        try { await installApp(); } catch { /* non-fatal */ }
      }
      await activateNewSw();
      // activateNewSw triggers reload. If it doesn't within 1.5 s, force it.
      setTimeout(() => {
        if (typeof window !== "undefined") window.location.reload();
      }, 1500);
    } catch (err: any) {
      setError(String(err?.message || err || "Erreur d'installation"));
      setPhase("ready");
    }
  }, []);

  const platform = getPlatform();
  const sizeMb = totalBytes > 0 ? (totalBytes / (1024 * 1024)) : 0;
  const loadedMb = loadedBytes > 0 ? (loadedBytes / (1024 * 1024)) : 0;

  return (
    <>
      {children}
      <Modal
        visible={blocking}
        transparent
        animationType="fade"
        onRequestClose={() => { /* non-dismissible */ }}
      >
        <View style={styles.overlay} testID="update-gate-overlay">
          <View style={styles.card}>
            <View style={styles.head}>
              <View style={styles.badge}>
                <Ionicons name="rocket" size={32} color="#1E40AF" />
              </View>
              <Text style={styles.title}>🚀 Nouvelle mise à jour disponible</Text>
            </View>

            <Text style={styles.body}>
              Une nouvelle version de SPILOVEURE est disponible. Veuillez mettre à jour votre application pour continuer à utiliser SPILOVEURE.
            </Text>

            <View style={styles.versionBox}>
              <View style={styles.vRow}>
                <Text style={styles.vLbl}>Version actuelle</Text>
                <Text style={styles.vVal}>{check?.client_version || CLIENT_VERSION}</Text>
              </View>
              <View style={styles.vRow}>
                <Text style={styles.vLbl}>Nouvelle version</Text>
                <Text style={[styles.vVal, { color: "#059669" }]}>{nextVersion}</Text>
              </View>
            </View>

            {phase === "idle" && (
              <TouchableOpacity
                onPress={startDownload}
                testID="update-gate-start"
                style={styles.primaryBtn}
                activeOpacity={0.85}
              >
                <Ionicons name="download" size={18} color="#fff" />
                <Text style={styles.primaryTxt}>Mettre à jour</Text>
              </TouchableOpacity>
            )}

            {phase === "downloading" && (
              <View style={styles.progressBox} testID="update-gate-progress">
                <View style={styles.progressHeader}>
                  <Text style={styles.progressTitle}>Téléchargement en cours…</Text>
                  <Text style={styles.progressPct} testID="update-gate-percent">{percent}%</Text>
                </View>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${percent}%` }]} />
                </View>
                <Text style={styles.progressSub}>
                  {totalBytes > 0
                    ? `${loadedMb.toFixed(1)} Mo / ${sizeMb.toFixed(1)} Mo`
                    : "Préparation du package…"}
                </Text>
              </View>
            )}

            {phase === "ready" && (
              <>
                <View style={styles.doneBox}>
                  <Ionicons name="checkmark-circle" size={18} color="#059669" />
                  <Text style={styles.doneTxt}>✅ Mise à jour téléchargée</Text>
                </View>
                <TouchableOpacity
                  onPress={applyAndRestart}
                  testID="update-gate-install"
                  style={[styles.primaryBtn, { backgroundColor: "#059669", marginTop: 10 }]}
                  activeOpacity={0.85}
                >
                  <Ionicons name="rocket" size={18} color="#fff" />
                  <Text style={styles.primaryTxt}>Installer maintenant</Text>
                </TouchableOpacity>
              </>
            )}

            {phase === "installing" && (
              <View style={[styles.progressBox, { alignItems: "center" }]}>
                <ActivityIndicator color={theme.colors.primary} />
                <Text style={styles.progressSub}>Installation en cours…</Text>
              </View>
            )}

            {error && (
              <Text style={styles.errTxt} testID="update-gate-error">⚠️ {error}</Text>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

// --- helpers isolated to keep the component body compact ---------------------

type ProgressFn = (p: { loaded: number; total: number; percent: number }) => void;

async function triggerUpdateDownload(onProgress: ProgressFn, version: string): Promise<void> {
  const { downloadApp } = await import("../pwaInstall");
  await downloadApp(onProgress, version);
}

async function activateNewSw(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    try { await reg.update(); } catch {}
    if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
    else if (reg.active) reg.active.postMessage({ type: "SKIP_WAITING" });
  } catch { /* ignore */ }
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 20,
    padding: 24,
    maxWidth: 440,
    width: "100%",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 20,
  },
  head: { alignItems: "center", marginBottom: 14 },
  badge: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: "#DBEAFE",
    alignItems: "center", justifyContent: "center", marginBottom: 12,
  },
  title: {
    fontSize: 20, fontWeight: "800", color: theme.colors.textPrimary, textAlign: "center",
  },
  body: {
    fontSize: 14, color: theme.colors.textSecondary, textAlign: "center",
    marginBottom: 14, lineHeight: 20,
  },
  versionBox: {
    backgroundColor: theme.colors.surfaceSecondary,
    borderRadius: 12, padding: 14, marginBottom: 14,
  },
  vRow: { flexDirection: "row", justifyContent: "space-between", marginVertical: 3 },
  vLbl: { color: theme.colors.textSecondary, fontSize: 13 },
  vVal: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "700" },
  primaryBtn: {
    backgroundColor: "#1E40AF",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
  },
  primaryTxt: { color: "#fff", fontSize: 15, fontWeight: "800" },
  progressBox: {
    backgroundColor: theme.colors.surfaceSecondary,
    borderRadius: 12,
    padding: 14,
    marginTop: 4,
  },
  progressHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  progressTitle: { color: theme.colors.textPrimary, fontWeight: "700" },
  progressPct: { color: theme.colors.primary, fontWeight: "800" },
  progressTrack: { height: 10, backgroundColor: theme.colors.border, borderRadius: 6, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: theme.colors.primary, borderRadius: 6 },
  progressSub: { marginTop: 8, color: theme.colors.textSecondary, fontSize: 11, textAlign: "center" },
  doneBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#ECFDF5", borderRadius: 10, padding: 10,
  },
  doneTxt: { color: "#065F46", fontWeight: "800" },
  errTxt: { color: theme.colors.error, fontSize: 12, marginTop: 10, textAlign: "center" },
});
