import { View } from "react-native";

// The Android build resolves AndroidWebApp.android.tsx instead. Keep the
// Expo web and iOS bundles free of a WebView wrapper.
export default function AndroidWebApp() {
  return <View />;
}
