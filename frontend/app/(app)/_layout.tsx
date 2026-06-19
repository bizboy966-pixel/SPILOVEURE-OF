import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { useAuth } from "@/src/auth";
import { CommunityPopup } from "@/src/components/CommunityPopup";
import { SupportFab } from "@/src/components/SupportFab";
import { LotteryFab } from "@/src/components/LotteryFab";

// Routes accessible to non-activated users — they can ONLY see /activation.
const ALLOWED_FOR_PENDING = new Set(["activation", "profile", "settings"]);

export default function AppLayout() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const segments = useSegments() as string[];

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/(auth)/login");
      return;
    }
    // Non-activated users (status=pending OR max_level=0) cannot access the
    // services / dashboard / wallet / team. They are forced back to /activation.
    const isPending = user.status === "pending" || (user.max_level || 0) === 0;
    if (!isPending) return;

    // segments looks like ["(app)", "dashboard"] or ["(app)", "services"]
    const current = segments[1] || "";
    if (!ALLOWED_FOR_PENDING.has(current)) {
      router.replace("/(app)/activation");
    }
  }, [user, loading, router, segments]);

  // A user is "activated" once they have successfully unlocked at least one
  // matrix level. Until then, no floating widgets, no community popup, and no
  // access to lottery/services/missions/etc.
  const isPending = !user || user.status === "pending" || (user.max_level || 0) === 0;

  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }} />
      {user && !isPending && (
        <>
          <CommunityPopup userId={user.id} />
          <SupportFab />
          <LotteryFab />
        </>
      )}
    </View>
  );
}
