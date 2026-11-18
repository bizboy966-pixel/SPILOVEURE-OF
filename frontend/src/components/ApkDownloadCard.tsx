import React, { useEffect, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { Card } from "./Card";
import { api, resolveMediaUrl } from "../api";
import { theme } from "../theme";

type ApkRelease = {
  apk_url?: string;
  apk_version?: string;
  apk_size_mb?: number | null;
};

function isAndroidBrowser(): boolean {
  return Platform.OS === "web"
    && typeof navigator !== "undefined"
    && /android/i.test(navigator.userAgent);
}

export function ApkDownloadCard() {
  const [release, setRelease] = useState<ApkRelease | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  if (!isAndroidBrowser()) return null;

  const apkUrl = release?.apk_url ? resolveMediaUrl(release.apk_url) : "";
  const ready = Boolean(apkUrl && release?.apk_version);

  const download = () => {
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

    // Chrome handles the download progress and installation confirmation
    // for users opening the website outside the installed Android app.
    const link = document.createElement("a");
    link.href = apkUrl;
    link.download = `spiloveure-${release.apk_version}.apk`;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
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
        Dans l’application SPILOVEURE, le téléchargement affiche sa progression puis propose « Installer ».
        Android demandera de confirmer l’installation et peut afficher son avertissement de sécurité habituel.
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
    </Card>
  );
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
});
