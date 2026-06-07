import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { useAuth } from "@/src/auth";

const API = process.env.EXPO_PUBLIC_BACKEND_URL;

type Status = "checking" | "paid" | "pending" | "failed" | "unknown";

/**
 * Generic payment success / status-tracking page.
 * Reads the payment reference from URL `?ref=...` or from sessionStorage
 * (set by the activation screen before starting the payment).
 */
export default function PaymentSuccess() {
  const router = useRouter();
  const params = useLocalSearchParams<{ ref?: string; token?: string }>();
  const { token: authToken, user } = useAuth();
  const [status, setStatus] = useState<Status>("checking");
  const [amount, setAmount] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string>("");
  const [ref, setRef] = useState<string | undefined>(
    (params.ref || params.token) as string | undefined,
  );

  // Fallback: read ref from sessionStorage if not in URL
  useEffect(() => {
    if (ref) return;
    if (typeof window !== "undefined" && window.sessionStorage) {
      const fromStorage = window.sessionStorage.getItem("pay_ref");
      if (fromStorage) setRef(fromStorage);
    }
  }, [ref]);

  // Poll the status endpoint until we have a definitive result
  useEffect(() => {
    if (!ref || !authToken) {
      if (!ref) setStatus("unknown");
      return;
    }
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const r = await fetch(`${API}/api/payments/secure/status?ref=${encodeURIComponent(ref)}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!r.ok) {
          if (!cancelled && attempts < 20) setTimeout(poll, 4000);
          return;
        }
        const data = await r.json();
        if (cancelled) return;
        setAmount(data.amount ?? null);
        setCurrency(data.currency ?? "");
        if (data.status === "paid") {
          setStatus("paid");
          if (typeof window !== "undefined" && window.sessionStorage) {
            try { window.sessionStorage.removeItem("pay_ref"); } catch {}
          }
        } else if (data.status === "failed") {
          setStatus("failed");
        } else if (attempts < 40) {
          setTimeout(poll, 4000);
        } else {
          setStatus("pending");
        }
      } catch {
        if (!cancelled && attempts < 20) setTimeout(poll, 4000);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [ref, authToken]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        {status === "checking" || status === "pending" ? (
          <>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.title}>Vérification du paiement…</Text>
            <Text style={styles.sub}>
              Confirmez l'invite Mobile Money reçue sur votre téléphone. La validation est automatique.
            </Text>
          </>
        ) : status === "paid" ? (
          <>
            <View style={[styles.iconCircle, { backgroundColor: "#1B5BFF22" }]}>
              <Ionicons name="checkmark-circle" size={72} color="#1B5BFF" />
            </View>
            <Text style={styles.title}>Paiement réussi !</Text>
            <Text style={styles.sub}>
              {amount != null ? `Montant : ${amount} ${currency}` : "Votre activation est confirmée."}
            </Text>
            <Text style={[styles.sub, { marginTop: 6 }]}>
              Bienvenue {user?.username ? `@${user.username}` : ""} ! Votre niveau a été activé.
            </Text>
          </>
        ) : status === "failed" ? (
          <>
            <View style={[styles.iconCircle, { backgroundColor: "#FF425822" }]}>
              <Ionicons name="close-circle" size={72} color="#FF4258" />
            </View>
            <Text style={styles.title}>Paiement échoué</Text>
            <Text style={styles.sub}>
              Le paiement n'a pas pu être confirmé. Vérifiez votre solde ou réessayez avec un autre opérateur.
            </Text>
          </>
        ) : (
          <>
            <View style={[styles.iconCircle, { backgroundColor: "#FFC03022" }]}>
              <Ionicons name="alert-circle" size={72} color="#FFC030" />
            </View>
            <Text style={styles.title}>Paiement introuvable</Text>
            <Text style={styles.sub}>
              Nous n'avons pas pu retrouver ce paiement. Connectez-vous puis vérifiez votre tableau de bord.
            </Text>
          </>
        )}

        <View style={{ height: 24 }} />
        <TouchableOpacity
          style={styles.btn}
          onPress={() => router.replace("/(app)/services")}
          testID="payment-success-go-home"
        >
          <Text style={styles.btnText}>Accéder à mon espace</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: theme.colors.background, alignItems: "center", justifyContent: "center", padding: 20 },
  card: { width: "100%", maxWidth: 460, backgroundColor: theme.colors.card, borderRadius: 18, padding: 24, alignItems: "center" },
  iconCircle: { width: 110, height: 110, borderRadius: 60, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  title: { color: theme.colors.text, fontSize: 22, fontWeight: "800", marginTop: 12, textAlign: "center" },
  sub: { color: theme.colors.textSecondary, fontSize: 14, marginTop: 8, textAlign: "center", lineHeight: 20 },
  btn: { backgroundColor: theme.colors.primary, paddingVertical: 14, paddingHorizontal: 22, borderRadius: 12, width: "100%", alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
