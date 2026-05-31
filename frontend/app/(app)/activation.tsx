import React, { useEffect, useMemo, useState } from "react";
import {
  ScrollView, StyleSheet, Text, View, TouchableOpacity, Alert, TextInput, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { formatFCFA } from "@/src/utils/format";

export default function Activation() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [level1, setLevel1] = useState<any>(null);
  const [payerName, setPayerName] = useState<string>("");
  const [payerPhone, setPayerPhone] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.get<{ levels: any[] }>("/config", { auth: false });
        setLevel1(cfg.levels[0]);
      } catch {}
    })();
    setPayerName(user?.username || "");
    setPayerPhone(user?.phone || "");
  }, [user?.username, user?.phone]);

  const amount = useMemo(() => level1?.price || 5000, [level1]);
  const canPay = payerPhone.trim().length >= 8 && payerName.trim().length >= 2 && !submitting;

  const payWithMoneyFusion = async () => {
    if (!canPay) {
      Alert.alert("Champs requis", "Veuillez saisir votre nom et un numéro de téléphone valide (au moins 8 chiffres).");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await api.post<{ url: string; token: string; order_id: string }>(
        "/payments/moneyfusion/initiate",
        { level: 1, name: payerName.trim(), phone: payerPhone.trim() },
      );
      // Store token so the success page can poll the right payment
      if (typeof window !== "undefined" && window.sessionStorage) {
        try {
          window.sessionStorage.setItem("mf_token", resp.token);
          window.sessionStorage.setItem("mf_order_id", resp.order_id);
        } catch {}
      }
      // Redirect to the Money Fusion hosted payment page
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.location.href = resp.url;
      } else {
        Alert.alert(
          "Redirection vers Money Fusion",
          `Ouvrez cette URL dans votre navigateur : ${resp.url}`,
        );
      }
    } catch (e: any) {
      Alert.alert(
        "Paiement impossible",
        e?.detail ||
          "Money Fusion a refusé la requête. Vérifiez que votre application est approuvée et que l'IP du serveur est whitelistée.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons name="shield-checkmark" size={28} color="#fff" />
          <View>
            <Text style={styles.brand}>Spiloveure</Text>
            <Text style={styles.brandSub}>AFFILIATE SYSTEM</Text>
          </View>
        </View>
        <Text style={styles.title}>Activation du compte</Text>
        <Text style={styles.sub}>Activez votre Niveau 1 et débloquez tout votre potentiel.</Text>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Card>
          <Text style={styles.section}>Informations utilisateur</Text>
          <Row label="Nom d'utilisateur" value={user?.username || "—"} icon="person" />
          <Row label="Téléphone" value={user?.phone || "—"} icon="call" />
          <Row label="E-mail" value={user?.email || "—"} icon="mail" />
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Détails du paiement</Text>
          <View style={styles.lvlBadge}>
            <Ionicons name="ribbon" size={16} color="#F59E0B" />
            <Text style={styles.lvlText}>Niveau à activer : {level1?.name || "Débutant"}</Text>
          </View>
          <View style={styles.amountBox}>
            <Text style={styles.amountLabel}>Montant d'activation</Text>
            <Text style={styles.amount}>{formatFCFA(amount)}</Text>
            <Text style={styles.amountHint}>Montant non modifiable</Text>
            <View style={{ marginTop: 8, gap: 4 }}>
              <Text style={styles.detail}>• {formatFCFA(amount - (level1?.platform_fee || 0))} → Commission</Text>
              <Text style={styles.detail}>• {formatFCFA(level1?.platform_fee || 0)} → Frais plateforme</Text>
            </View>
          </View>
        </Card>

        <Card style={{ marginTop: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={styles.mfBadge}>
              <Ionicons name="flash" size={14} color="#fff" />
              <Text style={styles.mfBadgeText}>RAPIDE</Text>
            </View>
            <Text style={styles.section}>Paiement Mobile Money via Money Fusion</Text>
          </View>
          <Text style={styles.helper}>
            Payez en un clic via T-Money, Mixx by Yas, Moov Money, Orange Money, Wave et plus.
            Votre niveau sera activé automatiquement dès confirmation du paiement.
          </Text>

          <View style={{ marginTop: 14 }}>
            <Text style={styles.lblSmall}>Nom du payeur</Text>
            <TextInput
              style={styles.input}
              value={payerName}
              onChangeText={setPayerName}
              placeholder="Ex: Jean Kossi"
              placeholderTextColor={theme.colors.textSecondary}
              autoCapitalize="words"
              testID="mf-payer-name"
            />
            <Text style={styles.lblSmall}>Numéro Mobile Money</Text>
            <TextInput
              style={styles.input}
              value={payerPhone}
              onChangeText={setPayerPhone}
              placeholder="Ex: 22890000000"
              placeholderTextColor={theme.colors.textSecondary}
              keyboardType="phone-pad"
              testID="mf-payer-phone"
            />
            <Text style={styles.hint}>
              Le numéro qui recevra l'invite Mobile Money pour confirmer le paiement.
            </Text>
          </View>

          <View style={{ marginTop: 16 }}>
            <Button
              title={`PAYER ${formatFCFA(amount)} VIA MONEY FUSION`}
              icon={<Ionicons name="card" size={18} color="#fff" />}
              onPress={payWithMoneyFusion}
              loading={submitting}
              disabled={!canPay}
              testID="mf-pay-button"
            />
            <Text style={styles.notice}>
              🔒 Paiement sécurisé hébergé par Money Fusion. Vous serez redirigé vers leur plateforme.
            </Text>
          </View>
        </Card>

        <TouchableOpacity
          style={styles.altLink}
          onPress={() => setShowManual((s) => !s)}
          testID="toggle-manual-flow"
        >
          <Ionicons
            name={showManual ? "chevron-up" : "chevron-down"}
            size={16}
            color={theme.colors.textSecondary}
          />
          <Text style={styles.altLinkText}>
            {showManual ? "Masquer" : "Autre méthode : demande manuelle (validation admin)"}
          </Text>
        </TouchableOpacity>

        {showManual && <ManualRequestCard onDone={async () => { await refresh(); router.replace("/(app)/dashboard"); }} />}

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Comment ça fonctionne ?</Text>
          <Step n={1} label="Saisie" desc="Entrez votre nom et numéro Mobile Money." />
          <Step n={2} label="Paiement" desc="Vous êtes redirigé vers la page sécurisée Money Fusion." />
          <Step n={3} label="Confirmation" desc="Vous confirmez l'invite USSD reçue sur votre téléphone." />
          <Step n={4} label="Activation" desc="Votre niveau est activé automatiquement." />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

// -----------------------------------------------------------------------------
// Manual fallback (existing admin-validation flow) — kept as a backup
// -----------------------------------------------------------------------------
function ManualRequestCard({ onDone }: { onDone: () => void }) {
  const [operator, setOperator] = useState<string>("");
  const [paymentPhone, setPaymentPhone] = useState("");
  const [txRef, setTxRef] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post("/activations/request", {
        level: 1,
        payment_method: "mobile_money",
        operator,
        payment_phone: paymentPhone,
        transaction_ref: txRef,
      });
      Alert.alert(
        "Demande envoyée ✅",
        "L'administrateur va valider votre paiement manuellement.",
        [{ text: "OK", onPress: onDone }],
      );
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Erreur d'envoi de la demande.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ marginTop: 12 }}>
      <Text style={styles.section}>Demande manuelle</Text>
      <Text style={styles.helper}>
        Utilisez ce formulaire si Money Fusion ne fonctionne pas. Vous payez en dehors de la plateforme et l'admin valide ensuite votre paiement.
      </Text>
      <Text style={styles.lblSmall}>Opérateur</Text>
      <TextInput
        style={styles.input}
        value={operator}
        onChangeText={setOperator}
        placeholder="T-Money, Mixx, Moov, Orange..."
        placeholderTextColor={theme.colors.textSecondary}
        testID="manual-operator"
      />
      <Text style={styles.lblSmall}>Numéro de paiement</Text>
      <TextInput
        style={styles.input}
        value={paymentPhone}
        onChangeText={setPaymentPhone}
        placeholder="22890000000"
        placeholderTextColor={theme.colors.textSecondary}
        keyboardType="phone-pad"
        testID="manual-phone"
      />
      <Text style={styles.lblSmall}>Référence de transaction</Text>
      <TextInput
        style={styles.input}
        value={txRef}
        onChangeText={setTxRef}
        placeholder="Ex: TX-12345"
        placeholderTextColor={theme.colors.textSecondary}
        testID="manual-txref"
      />
      <View style={{ marginTop: 14 }}>
        <Button
          title="ENVOYER LA DEMANDE"
          icon={<Ionicons name="paper-plane" size={18} color="#fff" />}
          onPress={submit}
          loading={busy}
          testID="manual-submit"
        />
      </View>
    </Card>
  );
}

function Row({ label, value, icon }: { label: string; value: string; icon: any }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={16} color={theme.colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLbl}>{label}</Text>
        <Text style={styles.rowVal}>{value}</Text>
      </View>
    </View>
  );
}

function Step({ n, label, desc }: { n: number; label: string; desc: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepN}><Text style={styles.stepNT}>{n}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepLbl}>{label}</Text>
        <Text style={styles.stepDesc}>{desc}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 20, paddingTop: 24 },
  brand: { color: "#fff", fontWeight: "800", letterSpacing: 2 },
  brandSub: { color: "#A5C2FF", fontSize: 9, letterSpacing: 2 },
  title: { color: "#fff", fontSize: 24, fontWeight: "800", marginTop: 16 },
  sub: { color: "#C7D9FF", marginTop: 4 },
  section: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 6, fontSize: 16 },
  helper: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 4, lineHeight: 18 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  rowIcon: { width: 32, height: 32, borderRadius: 8, backgroundColor: "#DBEAFE", alignItems: "center", justifyContent: "center" },
  rowLbl: { color: theme.colors.textSecondary, fontSize: 12 },
  rowVal: { color: theme.colors.textPrimary, fontWeight: "600" },
  lvlBadge: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#DBEAFE", paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, alignSelf: "flex-start",
  },
  lvlText: { color: theme.colors.primary, fontWeight: "700" },
  amountBox: { marginTop: 12, padding: 16, backgroundColor: theme.colors.surfaceSecondary, borderRadius: 16 },
  amountLabel: { color: theme.colors.textSecondary, fontSize: 12 },
  amount: { color: theme.colors.primary, fontSize: 32, fontWeight: "800" },
  amountHint: { color: theme.colors.textSecondary, fontSize: 11 },
  detail: { color: theme.colors.textSecondary, fontSize: 12 },
  mfBadge: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#10B981", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  mfBadgeText: { color: "#fff", fontWeight: "800", fontSize: 9, letterSpacing: 1 },
  lblSmall: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 10, marginBottom: 4 },
  input: { backgroundColor: theme.colors.surfaceSecondary, padding: 12, borderRadius: 12, color: theme.colors.textPrimary, fontSize: 14 },
  hint: { color: theme.colors.textSecondary, fontSize: 11, fontStyle: "italic", marginTop: 4 },
  notice: { textAlign: "center", color: theme.colors.textSecondary, fontSize: 11, marginTop: 8 },
  altLink: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 14, paddingVertical: 6 },
  altLinkText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: "600" },
  step: { flexDirection: "row", gap: 12, marginTop: 8, alignItems: "flex-start" },
  stepN: { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },
  stepNT: { color: "#fff", fontWeight: "800" },
  stepLbl: { fontWeight: "700", color: theme.colors.textPrimary },
  stepDesc: { color: theme.colors.textSecondary, fontSize: 12 },
});
