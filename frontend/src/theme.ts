/**
 * SPILOVEURE — Design tokens
 *
 * Standard visuel professionnel basé sur la référence OpenAI fournie
 * (hiérarchie, espaces et finitions). **Les couleurs SPILOVEURE restent intactes.**
 *
 *  • Rayons plus sobres (12-22px) et espacements réguliers
 *  • Surfaces et bordures légères avec un contraste lisible
 *  • Typographie cohérente, sans modifier les couleurs de marque
 *
 * Tout module qui référence `theme.radius`, `theme.spacing`, `theme.shadow`
 * ou `theme.colors.border` héritera automatiquement de la refonte.
 */
export const theme = {
  colors: {
    // Couleurs SPILOVEURE — inchangées.
    primary: "#1B5BFF",
    primaryDark: "#0B2D6F",
    primaryGradient: ["#0B2D6F", "#1B5BFF"] as const,
    primaryBg: "#EBF1FF",            // Fond très pâle pour highlights
    secondary: "#7B61FF",
    secondaryGradient: ["#7B61FF", "#5B43E8"] as const,
    background: "#F7F9FC",
    surface: "#FFFFFF",
    card: "#FFFFFF", // alias compatible avec les écrans existants
    surfaceSecondary: "#F1F5F9",
    surfaceMuted: "#F8FAFC",
    textPrimary: "#0B2D6F",
    text: "#0B2D6F", // alias compatible avec les écrans existants
    textSecondary: "#64748B",
    textMuted: "#94A3B8",             // Nouveau — labels, timestamps
    textInverse: "#FFFFFF",
    success: "#10B981",
    successBg: "#D1FAE5",
    danger: "#EF4444",
    error: "#EF4444", // alias compatible avec les écrans existants
    dangerBg: "#FEE2E2",
    warning: "#F59E0B",
    warningBg: "#FEF3C7",
    info: "#0EA5E9",
    infoBg: "#E0F2FE",
    // Bordures discrètes avec un contraste lisible.
    border: "#E8EDF4",
    borderStrong: "#D9E1EB",
  },
  spacing: { xs: 4, sm: 8, md: 14, lg: 20, xl: 28, xxl: 40, xxxl: 56 },
  radius: { sm: 8, md: 12, lg: 16, xl: 22, xxl: 30, round: 9999 },
  font: {
    // ─── Familles typographiques (v11 — global Nunito) ────────────
    // Utilisée par les composants qui veulent explicitement injecter la
    // police (ex : chiffres tabulaires, boutons custom). Pour tout le
    // reste de la plateforme, `GlobalFonts` s'occupe de la définir via
    // defaultProps + une règle CSS globale — aucune StyleSheet à modifier.
    family: "'Nunito', 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    familyMono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    // Hiérarchie typographique claire (mobile-first, avec bump desktop géré par chaque écran).
    h1: 30, h2: 22, h3: 19, h4: 17,
    bodyLg: 16, body: 14, bodySm: 12, caption: 11,
    // Weights
    bold: "700" as const,
    semibold: "600" as const,
    medium: "500" as const,
    regular: "400" as const,
    // Letter-spacing — négatif sur les titres pour un look Apple/Stripe.
    tightTitle: -0.5,
    normal: 0,
    wideCaption: 0.4,          // boutons, badges MAJUSCULES
  },
  shadow: {
    // Ombre carte : très douce, façon flat + soft (inspiration Stripe/Linear).
    card: {
      shadowColor: "#0B2D6F",
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.05,
      shadowRadius: 18,
      elevation: 2,
    },
    // Ombre "haute" pour modales / éléments flottants.
    lifted: {
      shadowColor: "#0B2D6F",
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.10,
      shadowRadius: 28,
      elevation: 6,
    },
    // Ombre bouton primaire — plus subtile qu'avant.
    button: {
      shadowColor: "#1B5BFF",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.18,
      shadowRadius: 12,
      elevation: 4,
    },
  },
};

export type Theme = typeof theme;
