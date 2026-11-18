import { Alert, BackHandler } from "react-native";

export type AndroidBackScope = "root" | "messenger";
export type AndroidBackAction = "defer-to-messenger" | "close-conversation" | "navigate-back" | "confirm-exit";

export function resolveAndroidBackAction({
  scope,
  isMessengerRoute,
  hasOpenConversation,
  canGoBack,
}: {
  scope: AndroidBackScope;
  isMessengerRoute: boolean;
  hasOpenConversation: boolean;
  canGoBack: boolean;
}): AndroidBackAction {
  if (scope === "root" && isMessengerRoute) return "defer-to-messenger";
  if (scope === "messenger" && hasOpenConversation) return "close-conversation";
  if (canGoBack) return "navigate-back";
  return "confirm-exit";
}

export function confirmAndroidAppExit() {
  Alert.alert(
    "Quitter SPILOVEURE ?",
    "Voulez-vous vraiment quitter l’application ?",
    [
      { text: "Rester", style: "cancel" },
      { text: "Quitter", style: "destructive", onPress: () => BackHandler.exitApp() },
    ],
    { cancelable: false },
  );
}
