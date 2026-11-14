import { useLocalSearchParams } from "expo-router";
import LandingPage from "@/src/components/LandingPage";

export default function Index() {
  const params = useLocalSearchParams<{ ref?: string }>();
  const refCode = typeof params.ref === "string" ? params.ref : "";
  return <LandingPage refCode={refCode} />;
}
