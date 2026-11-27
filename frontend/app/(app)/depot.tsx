import React from "react";
import { ComingSoonScreen } from "@/src/components/ComingSoonScreen";
import WalletOperationScreen from "@/src/components/WalletOperationScreen";
import { useFeature } from "@/src/features";

export default function DepotScreen() {
  const enabled = useFeature("wallet_deposit");
  return enabled
    ? <WalletOperationScreen direction="deposit" />
    : <ComingSoonScreen title="Dépôt" testID="wallet-deposit-disabled" />;
}
