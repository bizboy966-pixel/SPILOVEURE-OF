import React from "react";
import ComingSoonScreen from "@/src/components/ComingSoonScreen";

// The large dashboard action remains the general exchange entry point.
// Wallet-balance conversion is a separate flow opened by the small wallet icon.
export default function EchangerScreen() {
  return (
    <ComingSoonScreen
      title="Échanger"
      icon="swap-horizontal"
      iconColor="#F59E0B"
      iconBg="#FEF3C7"
      testID="echanger-soon"
      description="La fonctionnalité Échange est actuellement en cours de développement. Vous pourrez bientôt convertir vos devises directement."
    />
  );
}
