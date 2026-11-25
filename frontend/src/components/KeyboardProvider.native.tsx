import React from "react";
import { KeyboardProvider as NativeKeyboardProvider } from "react-native-keyboard-controller";

export function KeyboardProvider({ children }: { children: React.ReactNode }) {
  return <NativeKeyboardProvider>{children}</NativeKeyboardProvider>;
}
