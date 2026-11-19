import { Stack, useRouter } from "expo-router";
import { useEffect } from "react";
import { useAuth } from "@/src/auth";
import { getAdminStepUpToken, setAdminStepUpRequiredHandler } from "@/src/api";

export default function AdminLayout() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const hasStepUp = !!getAdminStepUpToken();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/(auth)/login");
    else if (user.role !== "admin") router.replace("/(app)/services");
    else if (!hasStepUp) router.replace("/(app)/dashboard");
  }, [user, loading, router, hasStepUp]);

  useEffect(() => {
    setAdminStepUpRequiredHandler(() => router.replace("/(app)/dashboard"));
    return () => setAdminStepUpRequiredHandler(null);
  }, [router]);
  if (loading || !user || user.role !== "admin" || !hasStepUp) return null;
  return <Stack screenOptions={{ headerShown: false }} />;
}
