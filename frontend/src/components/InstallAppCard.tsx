import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Modal, Platform, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { Card } from "./Card";
import { theme } from "../theme";
import { CLIENT_VERSION } from "../version";
import { api } from "../api";
import {
  downloadApp,
  installApp,
  getInstallState,
  onInstallChange,
  getPlatform,
  type InstallState,
  type PwaPlatform,
} from "../pwaInstall";

// SPILOVEURE — v27an (2026-03-04)
//
// InstallAppCard : la section « 📱 Application SPILOVEURE » affichée dans
// la page Profil. L'utilisateur appuie sur « Télécharger », une
// progression RÉELLE (0 → 100 %) s'affiche pendant que le service worker
// télécharge et met en cache tous les assets de l'application. À 100 %, le
// bouton « Installer maintenant » apparaît et déclenche :
//   • Android/Chrome/Edge : prompt natif beforeinstallprompt → l'app est
//     installée comme une vraie app (icône dans le launcher, WebAPK).
//   • iPhone/iPad : affichage des instructions officielles iOS (le
//     mécanisme Apple est manuel, on ne peut pas prompt).
//   • PC : prompt natif Chrome/Edge → installée comme app desktop.
//
// Zéro intervention admin, zéro upload d'APK, aucune URL à saisir.

type Phase = "idle" | "downloading" | "ready" | "installing" | "installed";

export function InstallAppCard() {
  const [state, setState] = useState<InstallState>(getInstallState());
  const [phase, setPhase] = useState<Phase>(state.isStandalone ? "installed" : "idle");
  const [percent, setPercent] = useState(0);
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<string>("—");
  const [showIosHelp, setShowIosHelp] = useState(false);
  const unsubRef = useRef<() => void>();

  useEffect(() => {
    unsubRef.current = onInstallChange((s) => {
      setState(s);
      if (s.isStandalone) setPhase("installed");
    });
    return () => { unsubRef.current && unsubRef.current(); };
  }, []);

  useEffect(() => {
    api.get<any>("/app/version").then((r) => {
      setPublishedVersion(r?.current_version || "—");
    }).catch(() => {});
  }, []);

  const platform: PwaPlatform = state.platform || getPlatform();

  const start = useCallback(async () => {
    setError(null);
    setPhase("downloading");
    setPercent(0);
    setLoadedBytes(0);
    setTotalBytes(0);
    try {
      await downloadApp(({ loaded, total, percent }) => {
        setLoadedBytes(loaded);
        setTotalBytes(total);
        setPercent(percent);
      }, publishedVersion);
      setPercent(100);
      setPhase("ready");
    } catch (err: any) {
      setError(String(err?.message || err || "Erreur de téléchargement"));
      setPhase("idle");
    }
  }, [publishedVersion]);

  const install = useCallback(async () => {
    setError(null);
    setPhase("installing");
    try {
      const result = await installApp();
      if (result === "installed") {
        setPhase("installed");
      } else if (result === "ios-instructions") {
        setShowIosHelp(true);
        setPhase("ready");
      } else if (result === "dismissed") {
        setPhase("ready");
      } else {
        // Already installed / unsupported — treat as success if standalone.
        if (getInstallState().isStandalone) setPhase("installed");
        else {
          setShowIosHelp(platform === "ios");
          setPhase("ready");
        }
      }
    } catch (err: any) {
      setError(String(err?.message || err || "Erreur d'installation"));
      setPhase("ready");
    }
  }, [platform]);

  const platformLabel =
    platform === "android" ? "Android"
    : platform === "ios" ? "iPhone / iPad"
    : platform === "desktop" ? "PC"
    : "Appareil";

  const sizeMb = totalBytes > 0 ? (totalBytes / (1024 * 1024)) : 0;
  const loadedMb = loadedBytes > 0 ? (loadedBytes / (1024 * 1024)) : 0;

  return (
    <Card style={{ marginTop: 12 }} testID="install-app-card">
      <View style={styles.headerRow}>
        <Ionicons name="phone-portrait" size={18} color={theme.colors.secondary} />
        <Text style={styles.title}>📱 Application SPILOVEURE</Text>
      </View>
      <Text style={styles.hint}>
        Installez l'application complète SPILOVEURE sur votre {platformLabel}. Toutes les fonctionnalités (dashboard, marketplace, tâches, missions, publicités, formations, e-books, emploi, matrice, paiements, dépôts, retraits, notifications) seront disponibles directement.
      </Text>

      <View style={styles.statsRow}>
        <View style={styles.statCol}>
          <Text style={styles.statLbl}>Version publiée</Text>
          <Text style={styles.statVal} testID="install-current-version">{publishedVersion}</Text>
        </View>
        <View style={styles.statCol}>
          <Text style={styles.statLbl}>Votre version</Text>
          <Text style={styles.statVal} testID="install-installed-version">{CLIENT_VERSION}</Text>
        </View>
        <View style={styles.statCol}>
          <Text style={styles.statLbl}>Appareil</Text>
          <Text style={styles.statVal}>{platformLabel}</Text>
        </View>
      </View>

      {/* État installé */}
      {phase === "installed" && (
        <View style={styles.installedBox} testID="install-state-installed">
          <Ionicons name="checkmark-circle" size={20} color="#059669" />
          <Text style={styles.installedTxt}>
            SPILOVEURE est installée sur votre appareil. Les mises à jour s'appliquent automatiquement à chaque nouvelle version publiée.
          </Text>
        </View>
      )}

      {/* Idle : bouton Télécharger */}
      {phase === "idle" && (
        <TouchableOpacity
          onPress={start}
          testID="install-download-btn"
          style={styles.primaryBtn}
          activeOpacity={0.85}
        >
          <Ionicons name="download" size={18} color="#fff" />
          <Text style={styles.primaryTxt}>Télécharger</Text>
        </TouchableOpacity>
      )}

      {/* Téléchargement en cours */}
      {phase === "downloading" && (
        <View style={styles.progressBox} testID="install-progress-box">
          <View style={styles.progressHeader}>
            <Text style={styles.progressTitle}>Téléchargement en cours…</Text>
            <Text style={styles.progressPct} testID="install-progress-percent">{percent}%</Text>
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

      {/* Téléchargement terminé → Installer maintenant */}
      {phase === "ready" && (
        <>
          <View style={styles.doneBox} testID="install-state-ready">
            <Ionicons name="checkmark-circle" size={18} color="#059669" />
            <Text style={styles.doneTxt}>✅ Mise à jour téléchargée</Text>
          </View>
          <TouchableOpacity
            onPress={install}
            testID="install-now-btn"
            style={[styles.primaryBtn, { backgroundColor: "#059669", marginTop: 10 }]}
            activeOpacity={0.85}
          >
            <Ionicons name="rocket" size={18} color="#fff" />
            <Text style={styles.primaryTxt}>Installer maintenant</Text>
          </TouchableOpacity>
          {platform === "ios" && (
            <TouchableOpacity onPress={() => setShowIosHelp(true)} style={styles.helpLink}>
              <Text style={styles.helpTxt}>
                Sur iPhone/iPad, voir les instructions d'installation
              </Text>
            </TouchableOpacity>
          )}
        </>
      )}

      {phase === "installing" && (
        <View style={[styles.progressBox, { alignItems: "center" }]}>
          <ActivityIndicator color={theme.colors.primary} />
          <Text style={styles.progressSub}>Installation en cours…</Text>
        </View>
      )}

      {error && (
        <Text style={styles.errTxt} testID="install-error">⚠️ {error}</Text>
      )}

      <IosInstructionsModal visible={showIosHelp} onClose={() => setShowIosHelp(false)} />
    </Card>
  );
}

function IosInstructionsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBg}>
        <View style={styles.modalCard}>
          <View style={styles.modalHead}>
            <Ionicons name="logo-apple" size={20} color={theme.colors.textPrimary} />
            <Text style={styles.modalTitle}>Installer SPILOVEURE sur iPhone / iPad</Text>
          </View>
          <View style={{ gap: 8 }}>
            <IosStep n="1" t="Ouvrir dans Safari" d="Si vous êtes dans un autre navigateur, ouvrez cette page dans Safari." />
            <IosStep n="2" t="Appuyer sur Partager" d="En bas de Safari, touchez l'icône Partager (carré avec flèche vers le haut)." />
            <IosStep n="3" t={`Choisir "Sur l'écran d'accueil"`} d="Faites défiler et sélectionnez cette option." />
            <IosStep n="4" t="Appuyer sur Ajouter" d="SPILOVEURE apparaît alors comme une vraie app sur votre écran d'accueil." />
          </View>
          <TouchableOpacity onPress={onClose} style={[styles.primaryBtn, { marginTop: 14 }]}>
            <Text style={styles.primaryTxt}>Compris</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function IosStep({ n, t, d }: { n: string; t: string; d: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNum}><Text style={styles.stepNumT}>{n}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepT}>{t}</Text>
        <Text style={styles.stepD}>{d}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  title: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 15 },
  hint: { color: theme.colors.textSecondary, fontSize: 12, marginBottom: 12, lineHeight: 17 },
  statsRow: { flexDirection: "row", gap: 10, marginBottom: 12 },
  statCol: { flex: 1, backgroundColor: theme.colors.surfaceSecondary, borderRadius: 10, padding: 8 },
  statLbl: { color: theme.colors.textSecondary, fontSize: 10, marginBottom: 2 },
  statVal: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13 },
  primaryBtn: {
    backgroundColor: theme.colors.primary,
    paddingVertical: 14,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  primaryTxt: { color: "#fff", fontWeight: "800", fontSize: 15 },
  progressBox: {
    backgroundColor: theme.colors.surfaceSecondary,
    borderRadius: 12,
    padding: 14,
  },
  progressHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  progressTitle: { color: theme.colors.textPrimary, fontWeight: "700" },
  progressPct: { color: theme.colors.primary, fontWeight: "800" },
  progressTrack: { height: 10, backgroundColor: theme.colors.border, borderRadius: 6, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: theme.colors.primary, borderRadius: 6 },
  progressSub: { marginTop: 8, color: theme.colors.textSecondary, fontSize: 11, textAlign: "center" },
  doneBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#ECFDF5",
    borderRadius: 10,
    padding: 10,
  },
  doneTxt: { color: "#065F46", fontWeight: "800" },
  installedBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "#ECFDF5",
    borderRadius: 10,
    padding: 12,
  },
  installedTxt: { color: "#065F46", fontSize: 12, flex: 1, lineHeight: 17 },
  helpLink: { marginTop: 8, alignItems: "center" },
  helpTxt: { color: theme.colors.primary, fontSize: 11, textDecorationLine: "underline" },
  errTxt: { color: theme.colors.error, fontSize: 12, marginTop: 10, textAlign: "center" },
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 20 },
  modalCard: { backgroundColor: theme.colors.surface, borderRadius: 16, padding: 20, maxWidth: 420, width: "100%" },
  modalHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  modalTitle: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 15, flex: 1 },
  step: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },
  stepNumT: { color: "#fff", fontWeight: "800", fontSize: 12 },
  stepT: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13 },
  stepD: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 15 },
});
