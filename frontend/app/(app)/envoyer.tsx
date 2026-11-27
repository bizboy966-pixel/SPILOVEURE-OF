import React from "react";
import { ComingSoonScreen } from "@/src/components/ComingSoonScreen";
import WalletOperationScreen from "@/src/components/WalletOperationScreen";
import { useFeature } from "@/src/features";

export default function EnvoyerScreen() {
  const enabled = useFeature("wallet_send");
  return enabled
    ? <WalletOperationScreen direction="send" />
    : <ComingSoonScreen title="Envoi" testID="wallet-send-disabled" />;
}
