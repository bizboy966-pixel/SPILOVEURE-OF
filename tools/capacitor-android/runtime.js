import { App } from "@capacitor/app";
import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { installApiTransport } from "./transport";

if (Capacitor.isNativePlatform()) {
  installApiTransport(window, CapacitorHttp);
  window.__SPV_APK_INSTALLER__ = registerPlugin("ApkInstaller");
  App.addListener("appStateChange", state => {
    window.dispatchEvent(new CustomEvent("spv-capacitor-app-state", { detail: state }));
  }).catch(error => console.error("Suivi de l’état de l’application indisponible", error));
  App.addListener("backButton", () => {
    // React Native Web already wires Escape to the active Modal's
    // onRequestClose. Close that overlay before its underlying conversation.
    if (document.querySelector('[aria-modal="true"]')) {
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
      return;
    }
    const event = new Event("spv-capacitor-back", { cancelable: true });
    window.dispatchEvent(event);
    if (!event.defaultPrevented && window.confirm("Fermer SPILOVEURE ?")) {
      void App.exitApp();
    }
  }).catch(error => console.error("Gestion du bouton Retour indisponible", error));
  // This APK never registers a PWA/push worker and has its own WebView storage.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(entries => Promise.all(entries.map(entry => entry.unregister())))
      .catch(error => console.warn("Nettoyage des anciens workers impossible", error));
  }
}
