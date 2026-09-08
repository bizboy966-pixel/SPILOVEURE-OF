import { useEffect } from "react";
import { Platform, Text, TextInput } from "react-native";

/**
 * GlobalFonts — applique la typographie SPILOVEURE (v11) à TOUTE la plateforme.
 *
 * Choix : **Nunito** (400/500/600/700/800/900) — famille sans-serif ronde,
 * moderne, professionnelle, très lisible sur mobile. Correspond à l'image de
 * référence fournie par l'utilisateur (bords doux, terminaisons rondes,
 * chiffres tabulaires clairs). Elle devient la police par défaut de :
 *   • toutes les balises `<Text>` React Native (via defaultProps)
 *   • toutes les balises `<TextInput>` (idem)
 *   • tout le DOM web (via injection d'un `<link>` Google Fonts + une règle
 *     CSS `body, * { font-family: 'Nunito' … }` — !important pour couvrir
 *     les styles inline générés par React Native Web).
 *
 * Aucun autre changement design : couleurs, layouts, icônes, arrondis
 * restent identiques (charte SPILOVEURE conservée).
 */

const FAMILY = "'Nunito', 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// Set the default font family on React Native Text/TextInput. This survives
// hot-reloads and applies to every screen without touching each StyleSheet.
function applyDefaultProps() {
  const applyTo = (Component: any) => {
    if (!Component) return;
    const previous = Component.defaultProps ?? {};
    Component.defaultProps = {
      ...previous,
      style: [{ fontFamily: FAMILY }, previous.style].filter(Boolean),
    };
  };
  applyTo(Text);
  applyTo(TextInput);
}

// Inject the Google Fonts `<link>` and a `!important` CSS rule so that even
// styles inline'd by React Native Web (which set fontFamily to "System" by
// default) inherit Nunito on web.
function injectWebFonts() {
  if (Platform.OS !== "web" || typeof document === "undefined") return;

  // Purge any stale font-injection from a previous hot-reload — this
  // ensures the CSS rule below is always the latest version and NEVER
  // contains an outdated `*` selector that would overwrite icon fonts.
  document.getElementById("spiloveure-fonts-link")?.remove();
  document.getElementById("spiloveure-fonts-style")?.remove();
  document.getElementById("spiloveure-fonts-preconnect-1")?.remove();
  document.getElementById("spiloveure-fonts-preconnect-2")?.remove();

  const preconnect1 = document.createElement("link");
  preconnect1.id = "spiloveure-fonts-preconnect-1";
  preconnect1.rel = "preconnect";
  preconnect1.href = "https://fonts.googleapis.com";
  document.head.appendChild(preconnect1);

  const preconnect2 = document.createElement("link");
  preconnect2.id = "spiloveure-fonts-preconnect-2";
  preconnect2.rel = "preconnect";
  preconnect2.href = "https://fonts.gstatic.com";
  preconnect2.crossOrigin = "anonymous";
  document.head.appendChild(preconnect2);

  const link = document.createElement("link");
  link.id = "spiloveure-fonts-link";
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800;900&display=swap";
  document.head.appendChild(link);

  const style = document.createElement("style");
  style.id = "spiloveure-fonts-style";
  // Surgical rules — override ONLY the "System" font-family that RN Web
  // ships as inline style on every Text/View node. Icon fonts
  // (Ionicons, MaterialCommunityIcons, FontAwesome, …) are shipped as
  // inline `font-family: ionicons` (lowercase) and are NEVER matched by
  // the `System` selector below, so they render correctly.
  //
  // The `i` flag makes the attribute matcher case-insensitive so that
  // both `font-family: System` and `font-family: "System"` are covered
  // regardless of quotes / casing.
  style.textContent = `
    :root { --spilo-font: ${FAMILY}; }
    html, body, #root, #__next, [id^="root"] {
      font-family: var(--spilo-font);
      font-feature-settings: "cv11", "ss01", "ss03";
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
    }
    [style*='font-family: System' i],
    [style*='font-family:System' i] {
      font-family: var(--spilo-font) !important;
    }
    code, kbd, pre, samp, [data-mono="true"] {
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace !important;
    }
  `;
  document.head.appendChild(style);
}
  `;
  document.head.appendChild(style);
}

export function GlobalFonts() {
  useEffect(() => {
    applyDefaultProps();
    injectWebFonts();
  }, []);
  return null;
}

export default GlobalFonts;
