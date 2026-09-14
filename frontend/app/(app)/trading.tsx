import React from "react";
import ComingSoonScreen from "@/src/components/ComingSoonScreen";

export default function TradingScreen() {
  return (
    <ComingSoonScreen
      title="Trading"
      icon="trending-up"
      iconColor="#0EA5E9"
      iconBg="#E0F2FE"
      testID="trading-soon"
      description="L'espace Trading est actuellement en cours de développement. Vous pourrez bientôt analyser et trader depuis SPILOVEURE."
    />
  );
}
