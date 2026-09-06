/**
 * Generic Ashtech Pay Mobile Money screen — reused by Ads + Special Tasks.
 *
 * Reads `kind`, `target_id`, `amount`, `title` from URL search params.
 * On success, redirects to `return_to` (or shows success card).
 * Same 4-step UI as activation-ashtec.tsx (Country → Operator → Phone → Countdown).
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  ScrollView, StyleSheet, Text, View, TouchableOpacity, TextInput, ActivityIndicator, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type Country = { code: string; name: string; currency: string; operators: string[] };
type Catalog = { amount: number; countdown_minutes: number; countries: Country[] };
type InitiateOut = {
  reference: string; transaction_id?: string;
  status: string; amount: number; currency: string;
  operator: string; country_code: string;
  expires_at: string; ussd_code?: string | null;
  flow?: string; wave_url?: string; message?: string;
};

const FLAG: Record<string, string> = {
  BJ: "🇧🇯", BF: "🇧🇫", CM: "🇨🇲", CF: "🇨🇫", CG: "🇨🇬", CI: "🇨🇮",
  GA: "🇬🇦", GQ: "🇬🇶", GW: "🇬🇼", ML: "🇲🇱", NE: "🇳🇪", SN: "🇸🇳",
  TD: "🇹🇩", TG: "🇹🇬",
};

function notify(title: string, msg?: string) {
  if (Platform.OS === "web") window.alert(msg ? `${title}\n\n${msg}` : title);
  else (require("react-native") as any).Alert.alert(title, msg);
}

export default function PayAshtec() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    kind?: string; target_id?: string; amount?: string;
    title?: string; return_to?: string;
  }>();
  const kind = String(params.kind || "ads");
  const targetId = String(params.target_id || "");
  const paramAmount = Number(params.amount || 0);
  // For recharge, the amount is always driven by the server — the URL
  // param is only a *display hint* until the live amount is fetched. This
  // way, when the admin changes the lottery `entry_amount`, the payment
  // screen automatically shows the new value on next open.
  const [liveAmount, setLiveAmount] = useState<number | null>(null);
  const amount = kind === "recharge"
    ? (liveAmount ?? paramAmount)
    : paramAmount;
  const title = kind === "recharge"
    ? `Recharge ${(liveAmount ?? paramAmount).toLocaleString("fr-FR")} FCFA — Jackpot`
    : String(params.title || (
        kind === "special_task" ? "Paiement Tâche" : "Paiement Publicité"
      ));
  const returnTo = String(params.return_to || "/(app)/dashboard");

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [step, setStep] = useState<"form" | "waiting" | "done" | "failed">("form");
  const [country, setCountry] = useState<string>("");
  const [operator, setOperator] = useState<string>("");
  const [phone, setPhone] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [session, setSession] = useState<InitiateOut | null>(null);
  const [otp, setOtp] = useState("");
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [remaining, setRemaining] = useState<number>(0);

  const selectedCountry = useMemo(
    () => catalog?.countries.find((c) => c.code === country) || null,
    [catalog, country],
  );

  useEffect(() => {
    (async () => {
      try {
        const c = await api.get<Catalog>("/payments/ashtec/catalog", { auth: false });
        if ((c as any).enabled === false) {
          notify("Indisponible", "AshtecPay est actuellement désactivé par l'administrateur.");
          router.back();
          return;
        }
        setCatalog(c);
        if (!country && c.countries.length) setCountry(c.countries[0].code);
      } catch (e: any) {
        notify("Erreur", e?.message || "Impossible de charger le catalogue.");
      }
    })();
  }, []);

  // For `kind=recharge`, pull the LIVE amount (= admin's current lottery
  // entry_amount) from the backend. This overrides any stale URL param
  // so the payment screen is always in sync with the admin config.
  useEffect(() => {
    if (kind !== "recharge") return;
    (async () => {
      try {
        const r = await api.get<{ amount: number }>("/payments/ashtec/recharge/amount");
        if (typeof r?.amount === "number" && r.amount > 0) setLiveAmount(r.amount);
      } catch {
        // Fall back to the URL param — better than blocking the flow.
      }
    })();
  }, [kind]);

  useEffect(() => {
    if (selectedCountry && !selectedCountry.operators.includes(operator)) {
      setOperator(selectedCountry.operators[0] || "");
    }
  }, [selectedCountry]);

  useEffect(() => {
    if (!session?.expires_at) return;
    const tick = () => {
      const ms = new Date(session.expires_at).getTime() - Date.now();
      setRemaining(Math.max(0, Math.ceil(ms / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [session?.expires_at]);

  useEffect(() => {
    if (step !== "waiting" || !session?.reference) return;
    let stopped = false;
    const poll = async () => {
      try {
        const r = await api.get<any>(
          `/payments/ashtec/status/${encodeURIComponent(session.reference)}`,
        );
        if (stopped) return;
        if (r.activation_done === true || r.status === "paid" || r.status === "validated") {
          setStep("done");
          setTimeout(() => router.replace(returnTo as any), 1200);
          return;
        }
        if (r.status === "failed" || r.status === "rejected" || r.status === "expired") {
          setErrMsg(r.error || "Paiement refusé");
          setStep("failed");
          return;
        }
        if (r.ussd_code) setStatusMsg(`Composez ce code USSD : ${r.ussd_code}`);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 6000);
    return () => { stopped = true; clearInterval(id); };
  }, [step, session?.reference]);

  useEffect(() => {
    if (step !== "waiting" || !session?.expires_at) return;
    if (remaining !== 0) return;
    const ms = new Date(session.expires_at).getTime() - Date.now();
    if (ms <= 0) {
      setErrMsg("Délai de 10 minutes dépassé — recommencez.");
      setStep("failed");
    }
  }, [remaining, step, session]);

  async function submit() {
    if (kind !== "recharge" && !targetId) { notify("Erreur", "target_id manquant."); return; }
    if (!country || !operator || !phone.trim()) {
      notify("Champs requis", "Sélectionnez pays, opérateur et téléphone."); return;
    }
    setSubmitting(true);
    try {
      const endpoint = kind === "special_task"
        ? `/special-tasks/${targetId}/pay`
        : kind === "recharge"
        ? `/payments/ashtec/recharge/initiate`
        : `/ads/${targetId}/pay`;
      const body: any = kind === "recharge"
        ? { country_code: country, operator, phone: phone.trim() }
        : {
            method: "mobile_money",
            country_code: country,
            operator,
            phone: phone.trim(),
          };
      const r = await api.post<InitiateOut>(endpoint, body);
      setSession(r);
      setStep("waiting");
      if (r.status === "otp_required" && r.ussd_code) {
        setStatusMsg(`Composez ce code USSD : ${r.ussd_code}`);
      }
    } catch (e: any) {
      notify("Échec", e?.message || "AshtecPay a refusé la requête.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitOtp() {
    if (!session || !otp.trim()) return;
    setOtpSubmitting(true);
    try {
      const r = await api.post<any>("/payments/ashtec/otp", {
        reference: session.reference, otp: otp.trim(),
      });
      if (r.status === "otp_error") notify("OTP invalide", r.message || "Code incorrect.");
      else { setSession({ ...session, status: "pending" }); setStatusMsg("Code accepté."); setOtp(""); }
    } catch (e: any) {
      notify("Erreur", e?.message || "Impossible de valider l'OTP.");
    } finally { setOtpSubmitting(false); }
  }

  function retry() {
    setSession(null); setOtp(""); setStatusMsg(""); setErrMsg(""); setStep("form");
  }

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const timeStr = `${mins}:${secs.toString().padStart(2, "0")}`;

  if (!catalog) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}><ActivityIndicator size="large" color="#F59E0B" /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient colors={["#0F172A", "#1E293B"]} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="payash-back">
          <Ionicons name="chevron-back" size={22} color="#fff" />
          <Text style={styles.backTxt}>Retour</Text>
        </TouchableOpacity>
        <View style={styles.headerRow}>
          <View style={styles.headerIcon}>
            <Ionicons name="phone-portrait" size={26} color="#0F172A" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>💳 {title}</Text>
            <Text style={styles.headerSub}>Mobile Money — Ashtech Pay</Text>
          </View>
        </View>
        <View style={styles.amountBlock}>
          <Text style={styles.amountLabel}>Montant à payer</Text>
          <Text style={styles.amountVal}>{amount.toLocaleString("fr-FR")} FCFA</Text>
          <Text style={styles.amountHint}>Chrono 10 min · non modifiable</Text>
        </View>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        {step === "form" && (
          <>
            <Card>
              <Text style={styles.section}>1️⃣ Choisissez votre pays</Text>
              <Text style={styles.hint}>Zones XOF/XAF uniquement (14 pays)</Text>
              <View style={styles.grid}>
                {catalog.countries.map((c) => (
                  <TouchableOpacity key={c.code}
                    style={[styles.chip, country === c.code && styles.chipOn]}
                    onPress={() => setCountry(c.code)}
                    testID={`payash-country-${c.code}`}>
                    <Text style={styles.chipFlag}>{FLAG[c.code] || "🌍"}</Text>
                    <Text style={[styles.chipText, country === c.code && styles.chipTextOn]}>{c.name}</Text>
                    <Text style={styles.chipCcy}>{c.currency}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Card>
            {selectedCountry && (
              <Card style={{ marginTop: 12 }}>
                <Text style={styles.section}>2️⃣ Opérateur Mobile Money</Text>
                <View style={styles.grid}>
                  {selectedCountry.operators.map((op) => (
                    <TouchableOpacity key={op}
                      style={[styles.opChip, operator === op && styles.opChipOn]}
                      onPress={() => setOperator(op)}
                      testID={`payash-op-${op}`}>
                      <Ionicons name={operator === op ? "checkmark-circle" : "ellipse-outline"}
                        size={16} color={operator === op ? "#10B981" : "#94A3B8"} />
                      <Text style={[styles.chipText, operator === op && styles.chipTextOn]}>{op}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </Card>
            )}
            <Card style={{ marginTop: 12 }}>
              <Text style={styles.section}>3️⃣ Numéro de téléphone</Text>
              <TextInput style={styles.input} placeholder="Ex : 70123456"
                keyboardType="phone-pad" value={phone} onChangeText={setPhone} testID="payash-phone" />
              <Text style={styles.hint}>Ce numéro doit être celui de votre compte Mobile Money.</Text>
            </Card>
            <View style={{ marginTop: 16 }}>
              <Button title={submitting ? "Envoi en cours…" : `🚀 PAYER ${amount.toLocaleString("fr-FR")} FCFA`}
                loading={submitting}
                disabled={submitting || !country || !operator || !phone.trim()}
                onPress={submit} testID="payash-submit" />
            </View>
          </>
        )}

        {step === "waiting" && session && (
          <Card>
            <View style={{ alignItems: "center" }}>
              <View style={styles.timerRing}>
                <Text style={styles.timerVal}>{timeStr}</Text>
                <Text style={styles.timerLabel}>restant</Text>
              </View>
              <Text style={[styles.section, { textAlign: "center", marginTop: 12 }]}>⏳ Paiement en cours…</Text>
              <Text style={[styles.hint, { textAlign: "center" }]}>
                Confirmez le paiement de <Text style={{ fontWeight: "900" }}>{session.amount.toLocaleString("fr-FR")} {session.currency}</Text>
                {"\n"}sur votre téléphone <Text style={{ fontWeight: "700" }}>{session.operator}</Text>
                {" · "}<Text style={{ fontWeight: "700" }}>{phone}</Text>
              </Text>
              {statusMsg && (
                <View style={styles.infoBox}>
                  <Ionicons name="information-circle" size={18} color="#0EA5E9" />
                  <Text style={styles.infoTxt}>{statusMsg}</Text>
                </View>
              )}
              {session.wave_url && (
                <TouchableOpacity style={styles.waveBtn}
                  onPress={() => {
                    if (Platform.OS === "web") window.open(session.wave_url!, "_blank");
                    else require("react-native").Linking.openURL(session.wave_url!);
                  }} testID="payash-wave">
                  <Text style={styles.waveBtnTxt}>🌊 Ouvrir Wave pour payer</Text>
                </TouchableOpacity>
              )}
              {session.status === "otp_required" && (
                <View style={{ width: "100%", marginTop: 16 }}>
                  <Text style={styles.section}>Saisissez le code OTP reçu</Text>
                  <TextInput style={styles.input} placeholder="Ex : 123456"
                    keyboardType="number-pad" value={otp} onChangeText={setOtp}
                    testID="payash-otp" />
                  <Button title={otpSubmitting ? "Validation…" : "Valider OTP"}
                    loading={otpSubmitting} disabled={otpSubmitting || !otp.trim()}
                    onPress={submitOtp} testID="payash-otp-submit" />
                </View>
              )}
              <Text style={[styles.hint, { textAlign: "center", marginTop: 16, fontStyle: "italic" }]}>
                Ne fermez pas cette page. Confirmation automatique dès réception du paiement.
              </Text>
              <TouchableOpacity onPress={retry} style={styles.cancelBtn} testID="payash-cancel">
                <Text style={styles.cancelTxt}>Annuler et recommencer</Text>
              </TouchableOpacity>
            </View>
          </Card>
        )}

        {step === "done" && (
          <Card style={{ borderWidth: 2, borderColor: "#10B981", backgroundColor: "#ECFDF5" }}>
            <View style={{ alignItems: "center", padding: 20 }} testID="payash-done">
              <Ionicons name="checkmark-circle" size={64} color="#10B981" />
              <Text style={[styles.section, { color: "#065F46", textAlign: "center", marginTop: 12 }]}>
                🎉 Paiement confirmé !
              </Text>
              <Text style={[styles.hint, { textAlign: "center", color: "#047857" }]}>Redirection…</Text>
            </View>
          </Card>
        )}

        {step === "failed" && (
          <Card style={{ borderWidth: 2, borderColor: "#EF4444", backgroundColor: "#FEF2F2" }}>
            <View style={{ alignItems: "center", padding: 20 }} testID="payash-failed">
              <Ionicons name="close-circle" size={64} color="#EF4444" />
              <Text style={[styles.section, { color: "#7F1D1D", textAlign: "center", marginTop: 12 }]}>
                ❌ Paiement non abouti
              </Text>
              <Text style={[styles.hint, { textAlign: "center", color: "#991B1B" }]}>
                {errMsg || "Le paiement n'a pas pu être finalisé."}
              </Text>
              <View style={{ marginTop: 16, width: "100%" }}>
                <Button title="Recommencer" onPress={retry} testID="payash-retry" />
              </View>
            </View>
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F1F5F9" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { padding: 18, paddingBottom: 22 },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 4,
    alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 24, backgroundColor: "rgba(255,255,255,0.12)" },
  backTxt: { color: "#fff", fontWeight: "700", fontSize: 13 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 14 },
  headerIcon: { width: 52, height: 52, borderRadius: 20, backgroundColor: "#FBBF24",
    alignItems: "center", justifyContent: "center" },
  headerTitle: { color: "#fff", fontWeight: "900", fontSize: 20, letterSpacing: 0.5 },
  headerSub: { color: "#CBD5E1", fontSize: 12, marginTop: 2 },
  amountBlock: { marginTop: 16, backgroundColor: "rgba(245, 158, 11, 0.15)",
    borderWidth: 1, borderColor: "rgba(245, 158, 11, 0.4)",
    padding: 12, borderRadius: 16, alignItems: "center" },
  amountLabel: { color: "#FDE68A", fontSize: 11, fontWeight: "700" },
  amountVal: { color: "#fff", fontSize: 26, fontWeight: "900", marginTop: 2 },
  amountHint: { color: "#CBD5E1", fontSize: 11, marginTop: 4 },
  section: { fontWeight: "800", fontSize: 15, color: theme.colors.textPrimary },
  hint: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 4, lineHeight: 17 },
  input: { marginTop: 10, borderWidth: 1, borderColor: "#E2E8F0",
    borderRadius: 12, padding: 12, fontSize: 15, backgroundColor: "#fff" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#fff", borderWidth: 1, borderColor: "#E2E8F0",
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 28 },
  chipOn: { backgroundColor: "#F59E0B", borderColor: "#F59E0B" },
  chipFlag: { fontSize: 16 },
  chipText: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "600" },
  chipTextOn: { color: "#fff" },
  chipCcy: { marginLeft: 4, backgroundColor: "#E2E8F0", color: "#475569",
    fontSize: 10, fontWeight: "700", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10 },
  opChip: { flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#fff", borderWidth: 1, borderColor: "#E2E8F0",
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14 },
  opChipOn: { backgroundColor: "#ECFDF5", borderColor: "#10B981" },
  timerRing: { width: 140, height: 140, borderRadius: 70, borderWidth: 6,
    borderColor: "#F59E0B", alignItems: "center", justifyContent: "center", marginTop: 8 },
  timerVal: { fontSize: 36, fontWeight: "900", color: "#0F172A", fontVariant: ["tabular-nums"] },
  timerLabel: { fontSize: 12, color: "#64748B", fontWeight: "700" },
  infoBox: { flexDirection: "row", alignItems: "center", gap: 8,
    marginTop: 14, padding: 10, borderRadius: 12,
    backgroundColor: "#E0F2FE", borderWidth: 1, borderColor: "#7DD3FC", width: "100%" },
  infoTxt: { flex: 1, color: "#0369A1", fontSize: 12, fontWeight: "600" },
  waveBtn: { marginTop: 14, backgroundColor: "#1D4ED8",
    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 28 },
  waveBtnTxt: { color: "#fff", fontWeight: "800", fontSize: 14 },
  cancelBtn: { marginTop: 20, paddingHorizontal: 20, paddingVertical: 10,
    borderRadius: 24, backgroundColor: "#F1F5F9" },
  cancelTxt: { color: "#64748B", fontWeight: "700", fontSize: 13 },
});
