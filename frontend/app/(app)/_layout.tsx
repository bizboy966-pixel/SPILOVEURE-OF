import { Stack, useRouter } from "expo-router";
import { useEffect } from "react";
import { useAuth } from "@/src/auth";

export default function AppLayout() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/(auth)/login");
  }, [user, loading, router]);

  return <Stack screenOptions={{ headerShown: false }} />;
}
