import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import NewLandingPage from "@/src/components/landing-redesign/NewLandingPage";
import { useAuth } from "@/src/auth";
import { useChat } from "@/src/chat/ChatContext";
import { wasChatExplicitlyLoggedOut } from "@/src/chat/chatLaunchState";
import { useFeatures } from "@/src/features";
import { theme } from "@/src/theme";

export default function Index() {
  return <ExpoIndex />;
}

function ExpoIndex() {
  const params = useLocalSearchParams<{ ref?: string; showLanding?: string }>();
  const refCode = typeof params.ref === "string" ? params.ref : "";
  const forceLanding = params.showLanding === "1";
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { user: chatUser, loading: chatLoading } = useChat();
  const { features, loading: featuresLoading } = useFeatures();
  const [showLanding, setShowLanding] = useState(false);
  const routed = useRef(false);

  useEffect(() => {
    if (forceLanding) {
      setShowLanding(true);
      return;
    }
    if (authLoading || chatLoading || routed.current) return;
    let active = true;
    void (async () => {
      const loggedOut = await wasChatExplicitlyLoggedOut();
      if (!active) return;
      if (loggedOut) {
        routed.current = true;
        router.replace("/(auth)/login" as any);
        return;
      }
      if (chatUser) {
        routed.current = true;
        router.replace(user && user.id !== chatUser.id ? "/(auth)/login" as any : "/messenger" as any);
        return;
      }
      if (user) {
        routed.current = true;
        if (user.role === "admin") router.replace("/(app)/dashboard" as any);
        else if (user.status === "active" && (user.max_level || 0) >= 1) {
          router.replace(user.email_verified ? "/(auth)/login" as any : "/(app)/dashboard" as any);
        } else router.replace("/(app)/pay" as any);
        return;
      }
      setShowLanding(true);
    })();
    return () => { active = false; };
  }, [authLoading, chatLoading, chatUser, user, router, forceLanding]);

  if (!showLanding) {
    return <View style={styles.loading}><ActivityIndicator color={theme.colors.primary} /></View>;
  }
  const refQS = refCode ? `?ref=${encodeURIComponent(refCode)}` : "";
  return (
    <NewLandingPage
      refCode={refCode}
      showPreview={!featuresLoading && features.landing_page}
      onPreview={() => router.push(`/legacy-landing${refQS}` as any)}
      onLogin={() => router.push(`/(auth)/login${refQS}` as any)}
      onRegister={() => router.push(`/welcome${refQS}` as any)}
    />
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.background },
});
