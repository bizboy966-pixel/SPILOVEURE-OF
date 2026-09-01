/**
 * pay.tsx — Simple, unified activation flow.
 *
 * A guided 4-step stepper wrapping ALL existing payment methods behind a
 * single clean UI, per the client's brief : Méthode → Pays → Opérateur →
 * Numéro → Confirmation. It calls the exact same backend endpoints the
 * legacy `activation.tsx` uses — no server-side change — so existing
 * flows (SoleasPay, BizTransPay MoMo, BizTransPay Crypto) stay intact.
 *
 * If the user prefers the previous longer page, `/(app)/activation`
 * remains reachable as a fallback.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator, Image, SafeAreaView, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";

const FLAGS: Record<string, string> = {
  TG: "🇹🇬", BJ: "🇧🇯", BF: "🇧🇫", CI: "🇨🇮", ML: "🇲🇱",
  SN: "🇸🇳", NE: "🇳🇪", CM: "🇨🇲", GA: "🇬🇦", CD: "🇨🇩",
  COG: "🇨🇬", GAB: "🇬🇦", UGA: "🇺🇬",
};
const NAMES: Record<string, string> = {
  TG: "Togo", BJ: "Bénin", BF: "Burkina Faso", CI: "Côte d'Ivoire",
  ML: "Mali", SN: "Sénégal", NE: "Niger", CM: "Cameroun", GA: "Gabon",
  CD: "RD Congo", COG: "Congo", GAB: "Gabon", UGA: "Ouganda",
};

type Method = "auto" | "bt-momo" | "bt-crypto";

export default function Pay() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [method, setMethod] = useState<Method | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [btStatus, setBtStatus] = useState<any>(null);
  const [country, setCountry] = useState<string>("");
  const [operator, setOperator] = useState<string>("");
  const [phone, setPhone] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const [cryptoAddr, setCryptoAddr] = useState<{ address: string; qr?: string; amount?: number; asset?: string } | null>(null);
  const [phase, setPhase] = useState<"idle" | "pending" | "success" | "failed">("idle");

  useEffect(() => {
    (async () => {
      try {
        const s = await api.get<any>("/settings/payments");
        setStatus(s);
      } catch {}
      try {
        const b = await api.get<any>("/payments/biztranspay/public-status");
        setBtStatus(b);
      } catch {}
    })();
  }, []);

  const methods = useMemo(() => {
    const list: { key: Method; label: string; sub: string; icon: any; available: boolean }[] = [];
    if (status?.auto_enabled) list.push({
      key: "auto", label: "Mobile Money automatique",
      sub: "SoleasPay / Ashtech · confirmation sur votre téléphone",
      icon: "flash", available: true,
    });
    if (btStatus?.enabled) {
      list.push({
        key: "bt-momo", label: "BizTransPay Mobile Money",
        sub: `${btStatus.activation_amount_xof ?? 2500} FCFA · invite USSD`,
        icon: "phone-portrait", available: true,
      });
      list.push({
        key: "bt-crypto", label: "Crypto USDT",
        sub: `${btStatus.activation_amount_usdt ?? 5} USDT · ${btStatus.network ?? "BEP20"}`,
        icon: "logo-bitcoin", available: true,
      });
    }
    return list;
  }, [status, btStatus]);

  const countries: [string, any][] = useMemo(() => {
    if (method === "auto" && status?.soleaspay_services_by_country) {
      return Object.entries(status.soleaspay_services_by_country) as any;
    }
    if (method === "bt-momo" && btStatus?.countries) {
      return (btStatus.countries as any[]).map((c) => [c.code, c]);
    }
    return [];
  }, [method, status, btStatus]);

  const operators = useMemo(() => {
    if (!country) return [];
    if (method === "auto" && status?.soleaspay_services_by_country?.[country]) {
      return (status.soleaspay_services_by_country[country] as any[]).map((s) => ({
        code: String(s.id), label: s.label,
      }));
    }
    if (method === "bt-momo" && btStatus?.countries) {
      const c = (btStatus.countries as any[]).find((x) => x.code === country);
      return c ? c.operators.map((o: any) => ({ code: o.code, label: o.label })) : [];
    }
    return [];
  }, [country, method, status, btStatus]);

  const goPay = async () => {
    setErr(null); setLoading(true);
    try {
      if (method === "auto") {
        const svc = (status.soleaspay_services_by_country[country] as any[]).find(
          (x) => String(x.id) === operator,
        );
        const r = await api.post<any>("/payments/soleaspay/initiate", {
          level: 1, country_code: country, service_id: parseInt(operator, 10),
          phone, currency: svc?.currency || "XOF",
        });
        setRef(r.reference || r.order_id);
        setPhase("pending"); setStep(4);
      } else if (method === "bt-momo") {
        const r = await api.post<any>("/payments/biztranspay/mobile/initiate", {
          country, operator_code: operator, phone,
        });
        setRef(r.reference);
        setPhase("pending"); setStep(4);
      } else if (method === "bt-crypto") {
        const r = await api.post<any>("/payments/biztranspay/crypto/initiate", {});
        setRef(r.reference);
        setCryptoAddr({ address: r.deposit_address, qr: r.qr_data,
                        amount: r.amount, asset: r.asset_code });
        setPhase("pending"); setStep(4);
      }
    } catch (e: any) {
      setErr(e?.detail || e?.message || "Erreur lors du lancement du paiement.");
    } finally { setLoading(false); }
  };

  // Poll status while pending
  useEffect(() => {
    if (phase !== "pending" || !ref) return;
    const t = setInterval(async () => {
      try {
        const r = await api.get<any>(`/payments/status/${ref}`);
        const s = String(r.status || "").toLowerCase();
        if (["paid", "success", "validated", "completed"].includes(s)) {
          setPhase("success"); await refresh?.();
          setTimeout(() => router.replace("/(app)/dashboard" as any), 2000);
        } else if (["failed", "rejected", "cancelled", "canceled", "expired"].includes(s)) {
          setPhase("failed");
        }
      } catch {}
    }, 5000);
    return () => clearInterval(t);
  }, [phase, ref, refresh, router]);

  const canNextFromMethod = !!method;
  const canNextFromCountry = !!country || method === "bt-crypto";
  const canNextFromOperator = !!operator || method === "bt-crypto";
  const canPay = method === "bt-crypto" || (phone.length >= 6 && !!operator);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => (step > 1 ? setStep((step - 1) as any) : router.back())} style={styles.iconBtn} testID="pay-back">
          <Ionicons name="chevron-back" size={22} color={theme.colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Activer mon compte</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={styles.progressRow}>
        {[1, 2, 3, 4].map((n) => (
          <View key={n} style={[styles.progressPill, step >= n && styles.progressPillActive]} />
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 120 }}>
        {step === 1 && (
          <View testID="pay-step-method">
            <Text style={styles.sTitle}>1. Méthode de paiement</Text>
            <Text style={styles.sSub}>Choisissez comment vous voulez activer votre compte.</Text>
            {methods.length === 0 && (
              <Text style={styles.warn}>⚠ Aucune méthode disponible pour l'instant. Contactez le support.</Text>
            )}
            {methods.map((m) => (
              <TouchableOpacity
                key={m.key}
                style={[styles.card, method === m.key && styles.cardActive]}
                onPress={() => { setMethod(m.key); setCountry(""); setOperator(""); }}
                testID={`pay-method-${m.key}`}
              >
                <View style={styles.cardIcon}>
                  <Ionicons name={m.icon} size={22} color={theme.colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardT}>{m.label}</Text>
                  <Text style={styles.cardS}>{m.sub}</Text>
                </View>
                {method === m.key ? (
                  <Ionicons name="checkmark-circle" size={22} color={theme.colors.primary} />
                ) : (
                  <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {step === 2 && method !== "bt-crypto" && (
          <View testID="pay-step-country">
            <Text style={styles.sTitle}>2. Sélectionnez votre pays</Text>
            <Text style={styles.sSub}>Seuls les pays pris en charge par la méthode sélectionnée sont affichés.</Text>
            {countries.map(([code]) => (
              <TouchableOpacity
                key={code}
                style={[styles.card, country === code && styles.cardActive]}
                onPress={() => { setCountry(code); setOperator(""); }}
                testID={`pay-country-${code}`}
              >
                <Text style={{ fontSize: 26 }}>{FLAGS[code] || "🌍"}</Text>
                <Text style={[styles.cardT, { marginLeft: 10, flex: 1 }]}>{NAMES[code] || code}</Text>
                {country === code ? (
                  <Ionicons name="checkmark-circle" size={22} color={theme.colors.primary} />
                ) : null}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {step === 3 && method !== "bt-crypto" && (
          <View testID="pay-step-operator">
            <Text style={styles.sTitle}>3. Opérateur et numéro</Text>
            <Text style={styles.sSub}>Sélectionnez votre opérateur Mobile Money puis saisissez votre numéro.</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
              {operators.map((op) => (
                <TouchableOpacity
                  key={op.code}
                  style={[styles.opChip, operator === op.code && styles.opChipActive]}
                  onPress={() => setOperator(op.code)}
                  testID={`pay-operator-${op.code}`}
                >
                  <Text style={[styles.opChipT, operator === op.code && { color: "#fff" }]}>{op.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={[styles.label, { marginTop: 18 }]}>Numéro Mobile Money</Text>
            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={setPhone}
              placeholder="ex : 90 00 00 00"
              keyboardType="phone-pad"
              placeholderTextColor={theme.colors.textSecondary}
              testID="pay-phone"
            />
          </View>
        )}

        {step === 4 && (
          <View testID="pay-step-confirm" style={{ gap: 12 }}>
            <Text style={styles.sTitle}>
              {phase === "success" ? "✅ Compte activé" : phase === "failed" ? "❌ Paiement échoué" : "⏳ Paiement en cours"}
            </Text>
            {phase === "pending" && <ActivityIndicator size="large" color={theme.colors.primary} />}
            {method !== "bt-crypto" && phase === "pending" && (
              <Text style={styles.sSub}>Une demande de paiement a été envoyée sur votre téléphone. Confirmez-la pour activer votre compte Niveau 1.</Text>
            )}
            {method === "bt-crypto" && cryptoAddr && phase === "pending" && (
              <View style={styles.cryptoBox}>
                <Text style={styles.cardT}>Envoyer {cryptoAddr.amount} {cryptoAddr.asset || "USDT"} ({btStatus?.network || "BEP20"}) à :</Text>
                <Text selectable style={styles.addr}>{cryptoAddr.address}</Text>
                {cryptoAddr.qr && (
                  <Image source={{ uri: `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(cryptoAddr.qr)}` }} style={{ width: 200, height: 200, alignSelf: "center", marginTop: 12 }} />
                )}
              </View>
            )}
            {phase === "success" && (
              <Text style={styles.sSub}>🎉 Votre Niveau 1 est maintenant actif. Redirection vers votre tableau de bord…</Text>
            )}
            {phase === "failed" && (
              <TouchableOpacity onPress={() => { setPhase("idle"); setStep(1); setRef(null); }} style={styles.retryBtn}>
                <Text style={styles.retryT}>Réessayer</Text>
              </TouchableOpacity>
            )}
            {ref && <Text style={styles.refT}>Référence : {ref}</Text>}
          </View>
        )}

        {err && <Text style={styles.err}>❌ {err}</Text>}
      </ScrollView>

      {step < 4 && (
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.cta, (loading || (step === 1 && !canNextFromMethod) || (step === 2 && !canNextFromCountry) || (step === 3 && !canPay)) && { opacity: 0.4 }]}
            disabled={loading || (step === 1 && !canNextFromMethod) || (step === 2 && !canNextFromCountry) || (step === 3 && !canPay)}
            onPress={() => {
              if (step === 1) {
                if (method === "bt-crypto") { goPay(); } else { setStep(2); }
              } else if (step === 2) { setStep(3); }
              else if (step === 3) { goPay(); }
            }}
            testID="pay-next"
          >
            {loading ? <ActivityIndicator color="#fff" /> :
              <Text style={styles.ctaT}>{step === 3 || (step === 1 && method === "bt-crypto") ? "Activer mon compte" : "Continuer"}</Text>}
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14 },
  title: { fontSize: 18, fontWeight: "900", color: theme.colors.textPrimary },
  iconBtn: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceMuted },
  progressRow: { flexDirection: "row", gap: 4, paddingHorizontal: 14, marginBottom: 8 },
  progressPill: { flex: 1, height: 4, borderRadius: 2, backgroundColor: theme.colors.border },
  progressPillActive: { backgroundColor: theme.colors.primary },
  sTitle: { fontSize: 20, fontWeight: "900", color: theme.colors.textPrimary, marginBottom: 6 },
  sSub: { color: theme.colors.textSecondary, fontSize: 12.5, lineHeight: 18, marginBottom: 12 },
  warn: { color: "#F97316", fontWeight: "700", fontSize: 12, padding: 10, backgroundColor: "#FEF3C7", borderRadius: 8 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 8 },
  cardActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary + "12" },
  cardIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.colors.primary + "18", alignItems: "center", justifyContent: "center" },
  cardT: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 14 },
  cardS: { color: theme.colors.textSecondary, fontSize: 11.5, marginTop: 2 },
  opChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
  opChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  opChipT: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },
  label: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12, marginBottom: 6 },
  input: { padding: 12, borderRadius: 10, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, color: theme.colors.textPrimary, fontSize: 15 },
  footer: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 14, backgroundColor: theme.colors.surface, borderTopWidth: 1, borderTopColor: theme.colors.border },
  cta: { padding: 16, borderRadius: 14, backgroundColor: theme.colors.primary, alignItems: "center" },
  ctaT: { color: "#fff", fontWeight: "900", fontSize: 15 },
  err: { color: theme.colors.danger, fontWeight: "700", fontSize: 12, marginTop: 12 },
  cryptoBox: { padding: 14, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, gap: 8 },
  addr: { fontFamily: "monospace", fontSize: 12, padding: 10, backgroundColor: theme.colors.surfaceMuted, borderRadius: 8, color: theme.colors.textPrimary },
  refT: { color: theme.colors.textSecondary, fontSize: 11, textAlign: "center", marginTop: 6 },
  retryBtn: { padding: 14, borderRadius: 12, backgroundColor: theme.colors.primary, alignItems: "center", marginTop: 8 },
  retryT: { color: "#fff", fontWeight: "800" },
});
