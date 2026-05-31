import React, { useEffect, useMemo, useState } from "react";
import {
  ScrollView, StyleSheet, Text, View, TouchableOpacity, Alert, TextInput, Platform, Linking,
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

const OPERATORS_BY_COUNTRY: Record<string, string[]> = {
  TG: ["Flooz (Moov)", "T-Money"],
  BJ: ["Moov Money", "MTN Mobile Money"],
  BF: ["Orange Money", "Moov Money"],
  CI: ["MTN Mobile Money", "Moov Money", "Wave", "Orange Money"],
  ML: ["Wave", "Orange Money", "Moov Money"],
  SN: ["Orange Money", "Wave", "Free Money"],
  NE: ["Airtel Money"],
  CM: ["MTN Mobile Money", "Orange Money"],
  GA: ["Moov Money", "Airtel Money"],
  CG: ["Airtel Money", "MTN Mobile Money"],
  CF: ["Orange Money"],
  TD: ["Moov Money", "Airtel Money"],
  CD: ["Vodacom M-Pesa", "Afrimoney", "Orange Money", "Airtel Money"],
  GN: ["MTN Mobile Money", "Orange Money"],
  GQ: ["Orange Money"],
  GW: ["Orange Money"],
};

type ManualSettings = {
  enabled: boolean;
  payment_url: string;
  title: string;
  instructions: string;
  phone_to_pay: string;
  operator_name: string;
};

export default function Activation() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [level1, setLevel1] = useState<any>(null);
  const [payerName, setPayerName] = useState<string>("");
  const [payerPhone, setPayerPhone] = useState<string>("");
  const [country, setCountry] = useState<string>("TG");
  const [operator, setOperator] = useState<string>("");
  const [otp, setOtp] = useState<string>("");
  const [otpRequired, setOtpRequired] = useState<boolean>(false);
  const [ussdCode, setUssdCode] = useState<string>("");
  const [waveUrl, setWaveUrl] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualCfg, setManualCfg] = useState<ManualSettings | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.get<{ levels: any[] }>("/config", { auth: false });
        setLevel1(cfg.levels[0]);
      } catch {}
      try {
        const m = await api.get<ManualSettings>("/settings/manual-payment", { auth: false });
        setManualCfg(m);
      } catch {}
    })();
    setPayerName(user?.username || "");
    setPayerPhone(user?.phone || "");
    setCountry(user?.country || "TG");
  }, [user?.username, user?.phone, user?.country]);

  useEffect(() => {
    const ops = OPERATORS_BY_COUNTRY[country] || [];
    setOperator(ops[0] || "");
  }, [country]);

  const operators = useMemo(() => OPERATORS_BY_COUNTRY[country] || [], [country]);
  const amount = useMemo(() => level1?.price || 5000, [level1]);
  const canPay = payerPhone.trim().length >= 8 && payerName.trim().length >= 2 && operator.length > 0 && !submitting;

  const startPayment = async () => {
    if (!canPay) {
      Alert.alert("Champs requis", "Nom, opérateur et numéro Mobile Money sont obligatoires.");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await api.post<any>("/payments/secure/initiate", {
        level: 1,
        phone: payerPhone.trim(),
        operator,
        country_code: country,
        otp: otp.trim() || undefined,
      });

      // Persist token/reference so the success page can poll the right payment
      if (typeof window !== "undefined" && window.sessionStorage) {
        try {
          window.sessionStorage.setItem("pay_ref", resp.order_id);
        } catch {}
      }

      if (resp.status === "otp_required") {
        setOtpRequired(true);
        setUssdCode(resp.ussd_code || "");
        Alert.alert(
          "Code OTP requis",
          resp.ussd_code
            ? `Composez ${resp.ussd_code} sur votre téléphone pour recevoir votre code, puis saisissez-le ci-dessous.`
            : "Un SMS contenant un code OTP a été envoyé à votre numéro. Saisissez-le ci-dessous.",
        );
        return;
      }

      if (resp.flow === "wave" && resp.wave_url) {
        setWaveUrl(resp.wave_url);
        if (Platform.OS === "web" && typeof window !== "undefined") {
          window.open(resp.wave_url, "_blank");
        } else {
          Linking.openURL(resp.wave_url);
        }
        // Redirect to success page for polling
        router.replace({ pathname: "/payment/success", params: { ref: resp.order_id } });
        return;
      }

      // USSD push flow: ask the user to confirm on their phone and go to success page
      Alert.alert(
        "Confirmation requise",
        "Une demande de paiement a été envoyée sur votre téléphone. Confirmez-la pour finaliser l'activation.",
        [
          {
            text: "OK",
            onPress: () =>
              router.replace({ pathname: "/payment/success", params: { ref: resp.order_id } }),
          },
        ],
      );
    } catch (e: any) {
      Alert.alert(
        "Paiement impossible",
        e?.detail || "Le service de paiement n'a pas pu traiter votre demande.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const openManualLink = async () => {
    if (!manualCfg?.payment_url) return;
    try {
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.open(manualCfg.payment_url, "_blank");
      } else {
        await Linking.openURL(manualCfg.payment_url);
      }
    } catch {
      Alert.alert("Impossible d'ouvrir le lien", manualCfg.payment_url);
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
            <Text style={styles.section}>Paiement sécurisé Mobile Money</Text>
          </View>
          <Text style={styles.helper}>
            Plateforme d'affiliation sécurisée. Payez via votre opérateur Mobile Money et votre niveau sera activé automatiquement.
          </Text>

          <View style={{ marginTop: 14 }}>
            <Text style={styles.lblSmall}>Pays</Text>
            <View style={styles.opGrid}>
              {Object.keys(OPERATORS_BY_COUNTRY).map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[styles.opChip, country === c && styles.opChipOn]}
                  onPress={() => setCountry(c)}
                  testID={`country-${c}`}
                >
                  <Text style={[styles.opText, country === c && { color: "#fff" }]}>{c}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.lblSmall}>Opérateur Mobile Money</Text>
            <View style={styles.opGrid}>
              {operators.map((op) => (
                <TouchableOpacity
                  key={op}
                  style={[styles.opChip, operator === op && styles.opChipOn]}
                  onPress={() => setOperator(op)}
                  testID={`operator-${op}`}
                >
                  <Text style={[styles.opText, operator === op && { color: "#fff" }]}>{op}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.lblSmall}>Nom du payeur</Text>
            <TextInput
              style={styles.input}
              value={payerName}
              onChangeText={setPayerName}
              placeholder="Ex: Jean Kossi"
              placeholderTextColor={theme.colors.textSecondary}
              autoCapitalize="words"
              testID="pay-name"
            />
            <Text style={styles.lblSmall}>Numéro Mobile Money</Text>
            <TextInput
              style={styles.input}
              value={payerPhone}
              onChangeText={setPayerPhone}
              placeholder="Ex: 22890000000"
              placeholderTextColor={theme.colors.textSecondary}
              keyboardType="phone-pad"
              testID="pay-phone"
            />
            <Text style={styles.hint}>
              Le numéro qui recevra l'invite Mobile Money (USSD ou SMS) pour confirmer.
            </Text>

            {otpRequired && (
              <View style={styles.otpBox}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Ionicons name="key" size={16} color={theme.colors.primary} />
                  <Text style={styles.otpTitle}>Code OTP requis</Text>
                </View>
                {ussdCode ? (
                  <Text style={styles.otpHint}>Composez <Text style={{ fontWeight: "800" }}>{ussdCode}</Text> sur votre téléphone pour recevoir votre OTP.</Text>
                ) : (
                  <Text style={styles.otpHint}>Vous avez reçu un SMS contenant votre code OTP.</Text>
                )}
                <TextInput
                  style={styles.input}
                  value={otp}
                  onChangeText={setOtp}
                  placeholder="Ex: 123456"
                  placeholderTextColor={theme.colors.textSecondary}
                  keyboardType="number-pad"
                  maxLength={8}
                  testID="pay-otp"
                />
              </View>
            )}
          </View>

          <View style={{ marginTop: 16 }}>
            <Button
              title={otpRequired ? "CONFIRMER AVEC OTP" : `PAYER ${formatFCFA(amount)}`}
              icon={<Ionicons name={otpRequired ? "key" : "card"} size={18} color="#fff" />}
              onPress={startPayment}
              loading={submitting}
              disabled={!canPay}
              testID="pay-submit"
            />
            <Text style={styles.notice}>
              🔒 Paiement sécurisé. Plateforme d'affiliation Spiloveure.
            </Text>
          </View>
        </Card>

        {manualCfg?.enabled && (
          <>
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
                {showManual ? "Masquer" : `Autre méthode : ${manualCfg.title || "Paiement manuel"}`}
              </Text>
            </TouchableOpacity>

            {showManual && (
              <Card style={{ marginTop: 12 }}>
                <Text style={styles.section}>{manualCfg.title || "Paiement manuel"}</Text>
                {manualCfg.instructions ? (
                  <Text style={[styles.helper, { whiteSpace: "pre-wrap" as any }]}>
                    {manualCfg.instructions}
                  </Text>
                ) : null}

                {(manualCfg.phone_to_pay || manualCfg.operator_name) && (
                  <View style={styles.amountBox}>
                    {manualCfg.operator_name ? (
                      <Row label="Opérateur" value={manualCfg.operator_name} icon="phone-portrait" />
                    ) : null}
                    {manualCfg.phone_to_pay ? (
                      <Row label="Numéro à payer" value={manualCfg.phone_to_pay} icon="call" />
                    ) : null}
                  </View>
                )}

                {manualCfg.payment_url ? (
                  <View style={{ marginTop: 12 }}>
                    <Button
                      title="OUVRIR LE LIEN DE PAIEMENT"
                      icon={<Ionicons name="open" size={18} color="#fff" />}
                      onPress={openManualLink}
                      testID="manual-open-link"
                    />
                  </View>
                ) : null}

                <Text style={[styles.hint, { marginTop: 10 }]}>
                  Après votre paiement, contactez l'administrateur via le panel community pour validation.
                </Text>
              </Card>
            )}
          </>
        )}

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Comment ça fonctionne ?</Text>
          <Step n={1} label="Saisie" desc="Choisissez votre pays, opérateur et saisissez votre numéro." />
          <Step n={2} label="Paiement" desc="Confirmez l'invite USSD ou OTP sur votre téléphone." />
          <Step n={3} label="Activation" desc="Votre niveau est activé automatiquement dès confirmation." />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value, icon }: { label: string; value: string; icon: any }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}><Ionicons name={icon} size={16} color={theme.colors.primary} /></View>
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
  opGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4, marginBottom: 4 },
  opChip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  opChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  opText: { color: theme.colors.textPrimary, fontWeight: "600", fontSize: 12 },
  lblSmall: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 10, marginBottom: 4 },
  input: { backgroundColor: theme.colors.surfaceSecondary, padding: 12, borderRadius: 12, color: theme.colors.textPrimary, fontSize: 14 },
  hint: { color: theme.colors.textSecondary, fontSize: 11, fontStyle: "italic", marginTop: 4 },
  notice: { textAlign: "center", color: theme.colors.textSecondary, fontSize: 11, marginTop: 8 },
  otpBox: { marginTop: 14, padding: 12, backgroundColor: "#EFF6FF", borderRadius: 12, borderWidth: 1, borderColor: "#BFDBFE" },
  otpTitle: { color: theme.colors.primary, fontWeight: "800", fontSize: 13 },
  otpHint: { color: theme.colors.textPrimary, fontSize: 12, marginTop: 6, marginBottom: 8 },
  altLink: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 14, paddingVertical: 6 },
  altLinkText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: "600" },
  step: { flexDirection: "row", gap: 12, marginTop: 8, alignItems: "flex-start" },
  stepN: { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },
  stepNT: { color: "#fff", fontWeight: "800" },
  stepLbl: { fontWeight: "700", color: theme.colors.textPrimary },
  stepDesc: { color: theme.colors.textSecondary, fontSize: 12 },
});
