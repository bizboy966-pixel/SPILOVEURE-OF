import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

export default function PaymentFailure() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token?: string }>();
  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <View style={styles.iconCircle}>
          <Ionicons name="close-circle" size={72} color="#FF4258" />
        </View>
        <Text style={styles.title}>Paiement annulé ou échoué</Text>
        <Text style={styles.sub}>
          Le paiement {token ? `(${token})` : ""} n'a pas pu être confirmé.
          Vérifiez votre solde Mobile Money ou réessayez avec un autre opérateur.
        </Text>
        <View style={{ height: 24 }} />
        <TouchableOpacity
          style={styles.btn}
          onPress={() => router.replace("/(app)/activation")}
          testID="payment-failure-retry"
        >
          <Text style={styles.btnText}>Réessayer le paiement</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: "transparent", marginTop: 10 }]}
          onPress={() => router.replace("/(app)/services")}
        >
          <Text style={[styles.btnText, { color: theme.colors.textSecondary }]}>Retour à l'accueil</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, alignItems: "center", justifyContent: "center", padding: 20 },
  card: { width: "100%", maxWidth: 460, backgroundColor: theme.colors.card, borderRadius: 18, padding: 24, alignItems: "center" },
  iconCircle: { width: 110, height: 110, borderRadius: 60, alignItems: "center", justifyContent: "center", marginBottom: 12, backgroundColor: "#FF425822" },
  title: { color: theme.colors.text, fontSize: 22, fontWeight: "800", marginTop: 12, textAlign: "center" },
  sub: { color: theme.colors.textSecondary, fontSize: 14, marginTop: 8, textAlign: "center", lineHeight: 20 },
  btn: { backgroundColor: theme.colors.primary, paddingVertical: 14, paddingHorizontal: 22, borderRadius: 12, width: "100%", alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
