import React from "react";
import ComingSoonScreen from "@/src/components/ComingSoonScreen";

export default function SpviaScreen() {
  return (
    <ComingSoonScreen
      title="IA SPV"
      icon="sparkles"
      iconColor="#7B61FF"
      iconBg="#EDE9FE"
      testID="spvia-soon"
      description="Votre assistant IA SPV est actuellement en cours de développement. Il pourra bientôt analyser votre matrice et vous conseiller."
    />
  );
}
