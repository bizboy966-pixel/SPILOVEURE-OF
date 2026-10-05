import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Modal, StyleSheet } from "react-native";
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
  getInstalledVersion,
  setInstalledVersion,
  type InstallState,
  type PwaPlatform,
} from "../pwaInstall";

// SPILOVEURE — v27aq (2026-03-04)
//
// InstallAppCard : section « 📱 Application SPILOVEURE » du Profil. État
// machine explicite :
//
//  no-install              → bouton "Télécharger"
//  downloading             → progression réelle 0 → 100 %
//  ready                   → "✅ Mise à jour téléchargée" + "Installer
//                            maintenant"
//  installed-current       → "✅ Application installée" (verrouillé pour
//                            la version actuelle). Si une nouvelle version
//                            est publiée, repasse automatiquement à
//                            update-available.
//  update-available        → "🔄 Mettre à jour" (nouvelle version détectée)
//  install-failed          → message "Installation impossible" + bouton
//                            "Réessayer".
//
// La version installée est persistée dans localStorage via
// `setInstalledVersion`. Elle est lue au mount pour choisir la phase
// initiale correcte même après refresh / reconnexion / nouveau device.

type Phase =
  | "no-install"
  | "downloading"
  | "ready"
  | "installing"
  | "installed-current"
  | "update-available"
  | "install-failed";

function cmp(a: string, b: string): number {
  // Semver-ish comparator. Returns <0 if a<b, 0 if equal, >0 if a>b.
  const pa = (a || "0.0.0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = (b || "0.0.0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function InstallAppCard() {
  const [state, setState] = useState<InstallState>(getInstallState());
  const [publishedVersion, setPublishedVersion] = useState<string>(CLIENT_VERSION);
  const [installedVersion, setLocalInstalled] = useState<string | null>(getInstalledVersion());
  const [phase, setPhase] = useState<Phase>("no-install");
  const [percent, setPercent] = useState(0);
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState<null | "ios" | "manual">(null);
  const [helpAcked, setHelpAcked] = useState(false);
  const unsubRef = useRef<() => void>();

  const platform: PwaPlatform = state.platform || getPlatform();

  // ── React to beforeinstallprompt / appinstalled / standalone changes.
  useEffect(() => {
    unsubRef.current = onInstallChange((s) => {
      setState(s);
      // Running in standalone with no record yet → backfill.
      if (s.isStandalone && !getInstalledVersion()) {
        setInstalledVersion(CLIENT_VERSION);
        setLocalInstalled(CLIENT_VERSION);
      }
    });
    return () => { unsubRef.current && unsubRef.current(); };
  }, []);

  // ── Fetch the currently published version from the backend.
  useEffect(() => {
    api.get<any>("/app/version").then((r) => {
      const v = r?.current_version;
      if (v) setPublishedVersion(String(v));
    }).catch(() => {});
  }, []);

  // ── Resolve the active phase whenever versions change.
  useEffect(() => {
    // If we are in the middle of downloading / installing / failed, don't
    // override the user-driven state. Only recompute from idle states.
    if (phase === "downloading" || phase === "installing"
        || phase === "ready" || phase === "install-failed") {
      return;
    }
    if (!installedVersion) {
      setPhase("no-install");
      return;
    }
    if (cmp(installedVersion, publishedVersion) >= 0) {
      setPhase("installed-current");
    } else {
      setPhase("update-available");
    }
  }, [installedVersion, publishedVersion, phase]);

  const needsAction = phase === "no-install" || phase === "update-available" || phase === "install-failed";

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
      setPhase("no-install");
    }
  }, [publishedVersion]);

  const install = useCallback(async () => {
    setError(null);
    setPhase("installing");
    setHelpAcked(false);
    try {
      const result = await installApp();
      if (result === "installed") {
        setInstalledVersion(publishedVersion);
        setLocalInstalled(publishedVersion);
        setPhase("installed-current");
        return;
      }
      if (result === "dismissed") {
        // User refused the prompt — stay in ready so they can click again
        // or follow the manual instructions.
        setShowHelp("manual");
        setPhase("ready");
        return;
      }
      if (result === "ios-instructions") {
        setShowHelp("ios");
        setPhase("ready");
        return;
      }
      if (result === "manual-instructions") {
        // No prompt available (prompt was consumed, criteria not met, or
        // browser doesn't expose beforeinstallprompt). Show platform help.
        setShowHelp(platform === "ios" ? "ios" : "manual");
        setPhase("ready");
        return;
      }
      // "unsupported"
      setError("Votre navigateur ne permet pas l'installation PWA. Essayez Chrome, Edge ou Safari.");
      setPhase("install-failed");
    } catch (err: any) {
      setError(String(err?.message || err || "Installation impossible. Veuillez réessayer."));
      setPhase("install-failed");
    }
  }, [publishedVersion, platform]);

  // Mark as installed after the user confirms they followed the manual
  // instructions on iOS / Firefox / older browsers.
  const confirmManualInstalled = useCallback(() => {
    setInstalledVersion(publishedVersion);
    setLocalInstalled(publishedVersion);
    setShowHelp(null);
    setHelpAcked(true);
    setPhase("installed-current");
  }, [publishedVersion]);

  const platformLabel = useMemo(() => (
    platform === "android" ? "Android"
    : platform === "ios" ? "iPhone / iPad"
    : platform === "desktop" ? "PC"
    : "Appareil"
  ), [platform]);

  const sizeMb = totalBytes > 0 ? (totalBytes / (1024 * 1024)) : 0;
  const loadedMb = loadedBytes > 0 ? (loadedBytes / (1024 * 1024)) : 0;

  return (
    <Card style={{ marginTop: 12 }} testID="install-app-card">
      <View style={styles.headerRow}>
        <Ionicons name="phone-portrait" size={18} color={theme.colors.secondary} />
        <Text style={styles.title}>📱 Application SPILOVEURE</Text>
      </View>
      <Text style={styles.hint}>
        Installez SPILOVEURE sur votre {platformLabel}. Toutes les fonctionnalités (dashboard, marketplace, tâches, missions, publicités, formations, e-books, emploi, matrice, paiements, dépôts, retraits, notifications) seront disponibles directement.
      </Text>

      <View style={styles.statsRow}>
        <View style={styles.statCol}>
          <Text style={styles.statLbl}>Version publiée</Text>
          <Text style={styles.statVal} testID="install-current-version">{publishedVersion}</Text>
        </View>
        <View style={styles.statCol}>
          <Text style={styles.statLbl}>Votre version</Text>
          <Text style={styles.statVal} testID="install-installed-version">
            {installedVersion || "—"}
          </Text>
        </View>
        <View style={styles.statCol}>
          <Text style={styles.statLbl}>Appareil</Text>
          <Text style={styles.statVal}>{platformLabel}</Text>
        </View>
      </View>

      {/* Installed and up-to-date */}
      {phase === "installed-current" && (
        <View style={styles.installedBox} testID="install-state-installed">
          <Ionicons name="checkmark-circle" size={20} color="#059669" />
          <Text style={styles.installedTxt}>
            ✅ Application installée. Toute nouvelle version publiée vous sera proposée automatiquement ici.
          </Text>
        </View>
      )}

      {/* Idle (never installed) → Télécharger */}
      {phase === "no-install" && (
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

      {/* Update available */}
      {phase === "update-available" && (
        <TouchableOpacity
          onPress={start}
          testID="install-update-btn"
          style={[styles.primaryBtn, { backgroundColor: "#F59E0B" }]}
          activeOpacity={0.85}
        >
          <Ionicons name="refresh" size={18} color="#fff" />
          <Text style={styles.primaryTxt}>🔄 Mettre à jour vers {publishedVersion}</Text>
        </TouchableOpacity>
      )}

      {/* Downloading */}
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

      {/* Ready to install */}
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
        </>
      )}

      {phase === "installing" && (
        <View style={[styles.progressBox, { alignItems: "center" }]}>
          <ActivityIndicator color={theme.colors.primary} />
          <Text style={styles.progressSub}>Installation en cours…</Text>
        </View>
      )}

      {phase === "install-failed" && (
        <>
          <View style={styles.errBox} testID="install-state-failed">
            <Ionicons name="warning" size={18} color="#DC2626" />
            <Text style={styles.errTxt}>
              ⚠️ Installation impossible. {error || "Veuillez réessayer."}
            </Text>
          </View>
          <TouchableOpacity
            onPress={start}
            testID="install-retry-btn"
            style={[styles.primaryBtn, { backgroundColor: "#DC2626", marginTop: 10 }]}
            activeOpacity={0.85}
          >
            <Ionicons name="refresh" size={18} color="#fff" />
            <Text style={styles.primaryTxt}>Réessayer</Text>
          </TouchableOpacity>
        </>
      )}

      {error && phase !== "install-failed" && (
        <Text style={[styles.errTxt, { textAlign: "center", marginTop: 10 }]} testID="install-error">
          ⚠️ {error}
        </Text>
      )}

      <HelpModal
        kind={showHelp}
        onClose={() => setShowHelp(null)}
        onConfirmInstalled={confirmManualInstalled}
      />
    </Card>
  );
}

function HelpModal({
  kind, onClose, onConfirmInstalled,
}: {
  kind: null | "ios" | "manual";
  onClose: () => void;
  onConfirmInstalled: () => void;
}) {
  const visible = !!kind;
  const platform = getPlatform();
  const isIos = kind === "ios" || platform === "ios";
  const title = isIos ? "Installer sur iPhone / iPad" : "Installer sur votre appareil";
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBg}>
        <View style={styles.modalCard}>
          <View style={styles.modalHead}>
            <Ionicons
              name={isIos ? "logo-apple" : (platform === "android" ? "logo-android" : "desktop")}
              size={20} color={theme.colors.textPrimary}
            />
            <Text style={styles.modalTitle}>{title}</Text>
          </View>
          <View style={{ gap: 8 }}>
            {isIos ? (
              <>
                <HelpStep n="1" t="Ouvrir dans Safari" d="Si vous êtes dans un autre navigateur, ouvrez cette page dans Safari." />
                <HelpStep n="2" t="Appuyer sur Partager" d="En bas de Safari, touchez l'icône Partager (carré avec flèche vers le haut)." />
                <HelpStep n="3" t={`Choisir "Sur l'écran d'accueil"`} d="Faites défiler et sélectionnez cette option." />
                <HelpStep n="4" t="Appuyer sur Ajouter" d="SPILOVEURE apparaît alors comme une vraie app sur votre écran d'accueil." />
              </>
            ) : platform === "android" ? (
              <>
                <HelpStep n="1" t="Ouvrir le menu du navigateur" d="Dans Chrome, appuyez sur les 3 points en haut à droite." />
                <HelpStep n="2" t={`Choisir "Installer l'application"`} d={`Si vous ne voyez pas cette option, choisissez "Ajouter à l'écran d'accueil".`} />
                <HelpStep n="3" t="Confirmer l'installation" d="SPILOVEURE sera installée comme une vraie app Android avec son icône dans le launcher." />
              </>
            ) : (
              <>
                <HelpStep n="1" t="Ouvrir le menu du navigateur" d="Dans Chrome/Edge, cliquez sur l'icône d'installation à droite de la barre d'adresse (ou menu ⋮ → Installer SPILOVEURE)." />
                <HelpStep n="2" t="Confirmer l'installation" d="L'application s'ouvre dans une fenêtre dédiée avec une icône sur votre bureau." />
              </>
            )}
          </View>
          <View style={styles.modalFoot}>
            <TouchableOpacity onPress={onClose} style={styles.secondaryBtn} testID="help-close-btn">
              <Text style={styles.secondaryTxt}>Fermer</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onConfirmInstalled} style={[styles.primaryBtn, { flex: 1 }]} testID="help-confirm-installed-btn">
              <Ionicons name="checkmark" size={16} color="#fff" />
              <Text style={styles.primaryTxt}>C'est fait, j'ai installé</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function HelpStep({ n, t, d }: { n: string; t: string; d: string }) {
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
    paddingVertical: 14, borderRadius: 12,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
  },
  primaryTxt: { color: "#fff", fontWeight: "800", fontSize: 15 },
  secondaryBtn: {
    paddingHorizontal: 16, paddingVertical: 14, borderRadius: 12,
    backgroundColor: theme.colors.surfaceSecondary,
  },
  secondaryTxt: { color: theme.colors.textPrimary, fontWeight: "700" },
  progressBox: { backgroundColor: theme.colors.surfaceSecondary, borderRadius: 12, padding: 14 },
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
  installedBox: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    backgroundColor: "#ECFDF5", borderRadius: 10, padding: 12,
  },
  installedTxt: { color: "#065F46", fontSize: 12, flex: 1, lineHeight: 17 },
  errBox: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    backgroundColor: "#FEF2F2", borderRadius: 10, padding: 12,
  },
  errTxt: { color: theme.colors.error, fontSize: 12 },
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 20 },
  modalCard: { backgroundColor: theme.colors.surface, borderRadius: 16, padding: 20, maxWidth: 420, width: "100%" },
  modalHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  modalTitle: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 15, flex: 1 },
  modalFoot: { flexDirection: "row", gap: 8, marginTop: 14 },
  step: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },
  stepNumT: { color: "#fff", fontWeight: "800", fontSize: 12 },
  stepT: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13 },
  stepD: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 15 },
});
