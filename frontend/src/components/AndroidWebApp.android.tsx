import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import WebView, { type WebViewNavigation } from "react-native-webview";

const SITE_URL = "https://spiloveure.org/";
const APP_VERSION = String(Constants.expoConfig?.version || "0.0.0");
const APP_PACKAGE = String(Constants.expoConfig?.android?.package || "com.spilivere.app");

type ApkRelease = {
  apk_url?: string;
  apk_version?: string;
  apk_mandatory?: boolean;
  apk_minimum_supported_version?: string;
};

type ApkDownloadPhase = "idle" | "downloading" | "ready" | "error";

function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.split("-")[0].split(".").map((part) => Number(part) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function publicApkUrl(value: string): string {
  const url = new URL(value, SITE_URL);
  if (url.protocol !== "https:" || url.origin !== new URL(SITE_URL).origin) {
    throw new Error("Le lien APK doit provenir du domaine sécurisé de SPILOVEURE.");
  }
  if (!url.pathname.toLowerCase().endsWith(".apk")) {
    throw new Error("Le lien ne pointe pas vers un fichier APK.");
  }
  return url.toString();
}

export default function AndroidWebApp() {
  const webView = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const initialPageLoaded = useRef(false);
  const downloadTask = useRef<any>(null);
  const apkFlowActive = useRef(false);
  const [webViewKey, setWebViewKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [apkRelease, setApkRelease] = useState<ApkRelease | null>(null);
  const [apkModalVisible, setApkModalVisible] = useState(false);
  const [apkMandatory, setApkMandatory] = useState(false);
  const [apkPhase, setApkPhase] = useState<ApkDownloadPhase>("idle");
  const [apkDownloadUrl, setApkDownloadUrl] = useState("");
  const [apkDownloadVersion, setApkDownloadVersion] = useState("");
  const [apkDownloadUri, setApkDownloadUri] = useState<string | null>(null);
  const [apkProgress, setApkProgress] = useState(0);
  const [apkError, setApkError] = useState("");
  const [installPermissionNeeded, setInstallPermissionNeeded] = useState(false);

  const checkApkRelease = useCallback(async () => {
    try {
      const response = await fetch(`${SITE_URL}api/app/version?check=${Date.now()}`);
      if (!response.ok) return;
      const release = await response.json() as ApkRelease;
      setApkRelease(release);
      const minimum = release.apk_minimum_supported_version || release.apk_version || "";
      const required = Boolean(
        release.apk_mandatory
        && release.apk_url
        && release.apk_version
        && minimum
        && compareVersions(APP_VERSION, minimum) < 0,
      );
      if (required) {
        if (apkFlowActive.current) {
          setApkRelease(release);
          return;
        }
        setApkMandatory(true);
        setApkDownloadUrl(publicApkUrl(release.apk_url!));
        setApkDownloadVersion(release.apk_version!);
        setApkDownloadUri(null);
        setApkError("");
        setApkPhase("idle");
        setApkModalVisible(true);
      }
    } catch {
      // An unavailable release check must not prevent the site from opening.
    }
  }, []);

  const retry = useCallback(() => {
    canGoBack.current = false;
    initialPageLoaded.current = false;
    setLoadError(false);
    setLoading(true);
    setWebViewKey(key => key + 1);
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!canGoBack.current || !webView.current) return false;
      webView.current.goBack();
      return true;
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    void checkApkRelease();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void checkApkRelease();
    });
    return () => subscription.remove();
  }, [checkApkRelease]);

  const startApkDownload = useCallback(async (rawUrl: string, version: string, mandatory: boolean) => {
    apkFlowActive.current = true;
    setApkMandatory(mandatory);
    setApkModalVisible(true);
    setApkPhase("downloading");
    setApkProgress(0);
    setApkDownloadUri(null);
    setApkError("");
    setInstallPermissionNeeded(false);
    try {
      const url = publicApkUrl(rawUrl);
      const safeVersion = (version || "latest").replace(/[^A-Za-z0-9.-]/g, "_");
      const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      if (!baseDir) throw new Error("Espace de stockage temporaire indisponible.");
      const fileUri = `${baseDir}spiloveure-${safeVersion}.apk`;
      const previous = await FileSystem.getInfoAsync(fileUri);
      if (previous.exists) await FileSystem.deleteAsync(fileUri, { idempotent: true });
      const task = FileSystem.createDownloadResumable(url, fileUri, {}, (progress) => {
        const total = progress.totalBytesExpectedToWrite;
        if (total > 0) {
          setApkProgress(Math.min(1, progress.totalBytesWritten / total));
        }
      });
      downloadTask.current = task;
      const result = await task.downloadAsync();
      downloadTask.current = null;
      if (!result?.uri) throw new Error("Le téléchargement n’a pas abouti.");
      setApkDownloadUrl(url);
      setApkDownloadVersion(version);
      setApkDownloadUri(result.uri);
      setApkProgress(1);
      setApkPhase("ready");
    } catch (error: any) {
      downloadTask.current = null;
      setApkError(String(error?.message || "Téléchargement impossible. Vérifie ta connexion puis réessaie."));
      setApkPhase("error");
    }
  }, []);

  const onWebMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      if (message?.type !== "SPV_DOWNLOAD_APK" || typeof message.url !== "string") return;
      const url = publicApkUrl(message.url);
      void startApkDownload(url, String(message.version || apkRelease?.apk_version || "latest"), false);
    } catch {
      setApkError("Le lien APK reçu n’est pas valide.");
      setApkPhase("error");
      setApkModalVisible(true);
    }
  }, [apkRelease?.apk_version, startApkDownload]);

  const cancelApkDownload = useCallback(async () => {
    try { await downloadTask.current?.cancelAsync(); } catch {}
    downloadTask.current = null;
    apkFlowActive.current = false;
    setApkPhase("idle");
    setApkModalVisible(false);
  }, []);

  const installDownloadedApk = useCallback(async () => {
    if (!apkDownloadUri) return;
    setApkError("");
    setInstallPermissionNeeded(false);
    try {
      const contentUri = await FileSystem.getContentUriAsync(apkDownloadUri);
      await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
        data: contentUri,
        type: "application/vnd.android.package-archive",
        flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
      });
    } catch {
      setInstallPermissionNeeded(true);
      setApkError("Autorise SPILOVEURE à installer cette mise à jour depuis Android, puis réessaie.");
    }
  }, [apkDownloadUri]);

  const openInstallPermissionSettings = useCallback(async () => {
    try {
      await IntentLauncher.startActivityAsync("android.settings.MANAGE_UNKNOWN_APP_SOURCES", {
        data: `package:${APP_PACKAGE}`,
      });
    } catch {
      setApkError("Ouvre les paramètres Android de SPILOVEURE et autorise « Installer des applis inconnues ».");
    }
  }, []);

  const onNavigationStateChange = useCallback((navigation: WebViewNavigation) => {
    canGoBack.current = navigation.canGoBack;
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]} testID="android-web-app">
      <StatusBar style="light" backgroundColor="#0B2D6F" />
      <WebView
        key={webViewKey}
        ref={webView}
        source={{ uri: SITE_URL }}
        style={styles.webView}
        originWhitelist={["https://*"]}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled
        thirdPartyCookiesEnabled
        allowsFullscreenVideo
        mediaPlaybackRequiresUserAction
        setSupportMultipleWindows={false}
        startInLoadingState={false}
        onLoadStart={() => {
          setLoadError(false);
          // Keep the full-screen loader for the first page only. Android
          // WebView may report later in-app route changes as document loads;
          // covering the whole page then can leave the APK looking stuck.
          if (!initialPageLoaded.current) {
            setLoading(true);
          }
        }}
        onLoadEnd={() => {
          initialPageLoaded.current = true;
          setLoading(false);
        }}
        onError={() => {
          setLoading(false);
          setLoadError(true);
        }}
        onRenderProcessGone={() => {
          initialPageLoaded.current = false;
          setLoading(false);
          setLoadError(true);
        }}
        onNavigationStateChange={onNavigationStateChange}
        onMessage={onWebMessage}
        pullToRefreshEnabled
        testID="spiloveure-site-webview"
      />

      {loading && !loadError && (
        <View style={styles.loading} pointerEvents="none" testID="webview-loading">
          <ActivityIndicator size="large" color="#1B5BFF" />
        </View>
      )}

      {loadError && (
        <View style={styles.errorOverlay} testID="webview-error">
          <Text style={styles.errorTitle}>Connexion impossible</Text>
          <Text style={styles.errorMessage}>
            Vérifie ta connexion Internet, puis réessaie d’ouvrir SPILOVEURE.
          </Text>
          <TouchableOpacity style={styles.retryButton} onPress={retry} accessibilityRole="button">
            <Text style={styles.retryLabel}>Réessayer</Text>
          </TouchableOpacity>
        </View>
      )}

      <Modal
        visible={apkModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!apkMandatory) void cancelApkDownload();
        }}
        testID="apk-download-modal"
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.updateCard}>
            {!apkMandatory && (
              <Pressable
                onPress={() => void cancelApkDownload()}
                style={styles.closeButton}
                accessibilityRole="button"
                accessibilityLabel="Fermer"
              >
                <Text style={styles.closeLabel}>×</Text>
              </Pressable>
            )}
            <View style={styles.updateIcon}>
              <Text style={styles.updateIconText}>↓</Text>
            </View>
            <Text style={styles.updateTitle}>
              {apkMandatory ? "Nouvelle mise à jour disponible" : "Télécharger l’application"}
            </Text>
            <Text style={styles.updateDescription}>
              {apkMandatory
                ? "Mettez votre application à jour pour continuer."
                : `Version Android ${apkDownloadVersion || apkRelease?.apk_version || ""}`}
            </Text>

            {apkPhase === "downloading" ? (
              <View style={styles.progressSection} testID="apk-download-progress">
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${Math.round(apkProgress * 100)}%` }]} />
                </View>
                <Text style={styles.progressLabel}>{Math.round(apkProgress * 100)} % téléchargé</Text>
              </View>
            ) : null}

            {apkPhase === "ready" ? (
              <Text style={styles.successMessage}>Téléchargement terminé. Appuie sur Installer et confirme dans Android.</Text>
            ) : null}
            {apkError ? <Text style={styles.apkErrorMessage}>{apkError}</Text> : null}

            {apkPhase === "ready" ? (
              <TouchableOpacity style={styles.actionButton} onPress={installDownloadedApk} accessibilityRole="button">
                <Text style={styles.actionButtonText}>Installer</Text>
              </TouchableOpacity>
            ) : apkPhase === "downloading" ? (
              !apkMandatory ? (
                <TouchableOpacity style={styles.cancelButton} onPress={() => void cancelApkDownload()}>
                  <Text style={styles.cancelLabel}>Annuler</Text>
                </TouchableOpacity>
              ) : null
            ) : (
              <TouchableOpacity
                style={styles.actionButton}
                onPress={() => void startApkDownload(apkDownloadUrl || apkRelease?.apk_url || "", apkDownloadVersion || apkRelease?.apk_version || "", apkMandatory)}
                accessibilityRole="button"
                testID="apk-download-start"
              >
                <Text style={styles.actionButtonText}>{apkMandatory ? "Mettre à jour" : "Télécharger"}</Text>
              </TouchableOpacity>
            )}

            {installPermissionNeeded && apkDownloadUri ? (
              <TouchableOpacity style={styles.settingsButton} onPress={openInstallPermissionSettings}>
                <Text style={styles.settingsLabel}>Ouvrir les paramètres d’installation</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0B2D6F" },
  webView: { flex: 1, backgroundColor: "#F6F8FB" },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F6F8FB",
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 30,
    backgroundColor: "#F6F8FB",
  },
  errorTitle: { color: "#17345D", fontSize: 20, fontWeight: "800", textAlign: "center" },
  errorMessage: { color: "#66758A", fontSize: 14, lineHeight: 21, textAlign: "center", marginTop: 10 },
  retryButton: {
    minWidth: 150,
    marginTop: 22,
    borderRadius: 14,
    backgroundColor: "#1B5BFF",
    paddingHorizontal: 24,
    paddingVertical: 13,
    alignItems: "center",
  },
  retryLabel: { color: "#fff", fontSize: 15, fontWeight: "800" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(8, 20, 40, 0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 22,
  },
  updateCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 24,
    backgroundColor: "#fff",
    padding: 24,
    alignItems: "center",
  },
  closeButton: {
    position: "absolute",
    right: 12,
    top: 8,
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  closeLabel: { color: "#718096", fontSize: 28, lineHeight: 30 },
  updateIcon: {
    width: 60,
    height: 60,
    borderRadius: 20,
    backgroundColor: "#DCFCE7",
    alignItems: "center",
    justifyContent: "center",
  },
  updateIconText: { color: "#159447", fontSize: 36, fontWeight: "900", lineHeight: 42 },
  updateTitle: { color: "#162A47", fontSize: 20, fontWeight: "900", textAlign: "center", marginTop: 16 },
  updateDescription: { color: "#5A6B80", fontSize: 14, lineHeight: 20, textAlign: "center", marginTop: 8 },
  progressSection: { width: "100%", marginTop: 22 },
  progressTrack: { height: 10, borderRadius: 99, backgroundColor: "#E6EDF5", overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 99, backgroundColor: "#1B5BFF" },
  progressLabel: { color: "#506078", fontSize: 12, fontWeight: "700", textAlign: "center", marginTop: 8 },
  successMessage: { color: "#16774B", fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 18 },
  apkErrorMessage: { color: "#B42318", fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 14 },
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
  cancelButton: { paddingVertical: 13, paddingHorizontal: 18, marginTop: 6 },
  cancelLabel: { color: "#5A6B80", fontSize: 14, fontWeight: "700" },
  settingsButton: { marginTop: 12, padding: 9 },
  settingsLabel: { color: "#1B5BFF", fontSize: 12, fontWeight: "800", textAlign: "center" },
});
