import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import WebView, { type WebViewNavigation } from "react-native-webview";

const SITE_URL = "https://spiloveure.org/";

export default function AndroidWebApp() {
  const webView = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const initialPageLoaded = useRef(false);
  const [webViewKey, setWebViewKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

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
});
