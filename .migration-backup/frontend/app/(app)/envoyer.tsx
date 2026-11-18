import React from "react";
import ComingSoonScreen from "@/src/components/ComingSoonScreen";

export default function EnvoyerScreen() {
  return (
    <ComingSoonScreen
      title="Envoyer"
      icon="paper-plane"
      iconColor="#1B5BFF"
      iconBg="#DBEAFE"
      testID="envoyer-soon"
      description="La fonctionnalité Envoyer est actuellement en cours de développement. Vous pourrez bientôt transférer des fonds à d'autres utilisateurs."
    />
  );
}
