export const theme = {
  colors: {
    primary: "#1B5BFF",
    primaryDark: "#0B2D6F",
    primaryGradient: ["#0B2D6F", "#1B5BFF"] as const,
    secondary: "#7B61FF",
    secondaryGradient: ["#7B61FF", "#5B43E8"] as const,
    background: "#F8FAFC",
    surface: "#FFFFFF",
    surfaceSecondary: "#F1F5F9",
    textPrimary: "#0B2D6F",
    textSecondary: "#64748B",
    textInverse: "#FFFFFF",
    success: "#10B981",
    successBg: "#D1FAE5",
    danger: "#EF4444",
    dangerBg: "#FEE2E2",
    warning: "#F59E0B",
    warningBg: "#FEF3C7",
    border: "#E2E8F0",
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
  radius: { sm: 8, md: 12, lg: 16, xl: 24, round: 9999 },
  font: {
    h1: 32, h2: 24, h3: 20, h4: 18,
    bodyLg: 16, body: 14, bodySm: 12, caption: 10,
    bold: "700" as const, semibold: "600" as const, medium: "500" as const, regular: "400" as const,
  },
  shadow: {
    card: {
      shadowColor: "#0B2D6F",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 12,
      elevation: 3,
    },
    button: {
      shadowColor: "#1B5BFF",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.25,
      shadowRadius: 8,
      elevation: 5,
    },
  },
};

export type Theme = typeof theme;
