export function isAndroidApkWebView(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (typeof (window as any).ReactNativeWebView?.postMessage === "function") return true;

  // Older APKs may not expose the JavaScript bridge, but Android WebView
  // retains this UA signature; regular Chrome and other Android browsers do not.
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /android/i.test(userAgent) && (/;\s*wv\)/i.test(userAgent) || /Version\/4\.0/i.test(userAgent));
}
