import React from "react";
import ComingSoonScreen from "@/src/components/ComingSoonScreen";

export default function DepotScreen() {
  return (
    <ComingSoonScreen
      title="Dépôt"
      icon="arrow-down-circle"
      iconColor="#10B981"
      iconBg="#D1FAE5"
      testID="depot-soon"
      description="La fonctionnalité de Dépôt est actuellement en cours de développement. Vous pourrez bientôt recharger votre portefeuille."
    />
  );
}
