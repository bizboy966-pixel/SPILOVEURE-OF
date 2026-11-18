import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import LandingPage from "@/src/components/LandingPage";
import { useFeatures } from "@/src/features";
import { theme } from "@/src/theme";

export default function LegacyLandingRoute() {
  const params = useLocalSearchParams<{ ref?: string }>();
  const refCode = typeof params.ref === "string" ? params.ref : "";
  const router = useRouter();
  const { features, loading } = useFeatures();
  const isEnabled = features.landing_page;
  const refQS = refCode ? `?ref=${encodeURIComponent(refCode)}` : "";

  useEffect(() => {
    if (!loading && !isEnabled) router.replace(`/${refQS}` as any);
  }, [isEnabled, loading, refQS, router]);

  if (loading || !isEnabled) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.background }}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  return <LandingPage refCode={refCode} hideEntryActions />;
}
