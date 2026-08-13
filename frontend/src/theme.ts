/**
 * SPILOVEURE — Design tokens (v2, "Premium Fintech")
 *
 * Refonte design 2026-08-13 inspirée des bonnes pratiques modernes
 * (action.diokoma.sn, plateformes fintech premium) — **couleurs SPILOVEURE
 * conservées à l'identique**, seul le layout est modernisé :
 *
 *  • Arrondis plus généreux (16 → 20-28)
 *  • Padding intérieur des cartes plus aéré (16 → 20)
 *  • Ombres beaucoup plus douces et diffuses (0,08 → 0,05 opacité)
 *  • Bordures plus légères (#E2E8F0 → #EEF2F7)
 *  • Typographie : line-height et letter-spacing homogènes
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
    background: "#F6F8FB",           // Fond légèrement plus doux qu'avant
    surface: "#FFFFFF",
    surfaceSecondary: "#F1F5F9",
    surfaceMuted: "#F8FAFC",         // Nouveau — fond hover / sous-bloc
    textPrimary: "#0B2D6F",
    textSecondary: "#64748B",
    textMuted: "#94A3B8",             // Nouveau — labels, timestamps
    textInverse: "#FFFFFF",
    success: "#10B981",
    successBg: "#D1FAE5",
    danger: "#EF4444",
    dangerBg: "#FEE2E2",
    warning: "#F59E0B",
    warningBg: "#FEF3C7",
    info: "#0EA5E9",
    infoBg: "#E0F2FE",
    // Bordure ultra-légère façon "premium fintech".
    border: "#EEF2F7",
    borderStrong: "#E2E8F0",         // Ancienne bordure — pour dividers marqués
  },
  spacing: { xs: 4, sm: 8, md: 14, lg: 20, xl: 28, xxl: 40, xxxl: 56 },
  // Arrondis plus généreux pour un rendu premium (radiuses de "action.diokoma.sn").
  radius: { sm: 10, md: 14, lg: 20, xl: 28, xxl: 36, round: 9999 },
  font: {
    // Hiérarchie typographique claire (mobile-first, avec bump desktop géré par chaque écran).
    h1: 30, h2: 22, h3: 19, h4: 17,
    bodyLg: 16, body: 14, bodySm: 12, caption: 11,
    // Weights
    bold: "800" as const,      // titres — bolder pour un rendu premium
    semibold: "700" as const,  // sous-titres, boutons
    medium: "600" as const,    // labels, chips
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
