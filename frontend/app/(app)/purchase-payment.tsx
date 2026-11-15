import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator, Linking, Platform, SafeAreaView, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";

type Operator = {
  code: string;
  label: string;
  gateway: string;
  amount?: number;
  amount_label?: string;
  currency?: string;
  requires_otp?: boolean;
  otp_ussd_template?: string;
  steps?: string[];
};
type Country = { code: string; name: string; operators: Operator[] };
type Catalog = { amount_fcfa: number; countries: Country[] };

const cryptoGateway = (gateway?: string) =>
  gateway === "izichange" || gateway === "biztranspay_crypto";

function showMessage(title: string, message: string) {
  if (Platform.OS === "web") window.alert(`${title}\n\n${message}`);
  else (require("react-native") as any).Alert.alert(title, message);
}

export default function PurchasePaymentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    kind?: string; target_id?: string; amount?: string; title?: string; return_to?: string;
    reference?: string;
  }>();
  const { refresh } = useAuth();
  const kind = String(params.kind || "");
  const targetId = String(params.target_id || "");
  const returnTo = String(params.return_to || "/(app)/dashboard");
  const title = String(params.title || (
    kind === "lottery_entry" ? "Ticket Jackpot" :
    kind === "special_task" ? "Paiement de la tâche" : "Paiement de la publicité"
  ));

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [operatorCode, setOperatorCode] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [ussdAccepted, setUssdAccepted] = useState(false);
  const [providerMessage, setProviderMessage] = useState("");
  const [session, setSession] = useState<any>(
    params.reference ? { reference: String(params.reference), status: "pending" } : null,
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"form" | "waiting" | "done" | "failed" | "refund">(
    params.reference ? "waiting" : "form",
  );

  useEffect(() => {
    if (!params.reference && (!["ads", "special_task", "lottery_entry"].includes(kind) || !targetId)) {
      setCatalogError("Informations de paiement manquantes.");
      return;
    }
    api.get<Catalog>("/payments/activation-catalog")
      .then((c) => {
        setCatalog(c);
        const first = c.countries?.[0];
        if (first) {
          setCountryCode(first.code);
          setOperatorCode(first.operators?.[0]?.code || "");
        }
      })
      .catch((e: any) => setCatalogError(e?.detail || "Impossible de charger les moyens de paiement."));
  }, [kind, targetId]);

  const country = useMemo(
    () => catalog?.countries.find((c) => c.code === countryCode) || null,
    [catalog, countryCode],
  );
  const operator = useMemo(
    () => country?.operators.find((o) => o.code === operatorCode) || null,
    [country, operatorCode],
  );
  const isCrypto = cryptoGateway(operator?.gateway);
  const ussdCode = (operator?.otp_ussd_template || "").replace(
    "{amount}", String(operator?.amount || Number(params.amount) || 0),
  );

  async function startPayment() {
    if (!operator || !country) {
      showMessage("Choix requis", "Sélectionnez un pays et un moyen de paiement.");
      return;
    }
    if (!isCrypto && !phone.trim()) {
      showMessage("Numéro requis", "Saisissez le numéro Mobile Money à débiter.");
      return;
    }
    setBusy(true);
    setProviderMessage("");
    try {
      const result = await api.post<any>("/payments/purchase", {
        kind, target_id: targetId,
        method: isCrypto ? "crypto" : "mobile_money",
        provider: isCrypto ? operator.gateway : undefined,
        country_code: country.code,
        operator: isCrypto ? undefined : operator.code,
        phone: isCrypto ? undefined : phone.trim(),
        otp: otp.trim() || undefined,
        ussd_authorized: ussdAccepted,
      });
      setSession(result);
      setStatus("waiting");
      if (result.message) setProviderMessage(result.message);
      const checkout = result.redirect_url || result.url;
      if (checkout) {
        if (Platform.OS === "web") {
          const opened = window.open(checkout, "_blank", "noopener,noreferrer");
          if (!opened) window.location.assign(checkout);
        } else {
          await Linking.openURL(checkout);
        }
      }
    } catch (e: any) {
      const detail = e?.detail;
      const message = typeof detail === "string" ? detail
        : detail?.message || e?.message || "Le paiement n'a pas pu démarrer.";
      if (detail?.code === "OTP_REQUIRED" || detail?.code === "OTP_SENT") {
        setProviderMessage(message);
        setStatus("form");
        showMessage("Code de confirmation", message);
      } else if (detail?.code === "USSD_AUTHORIZATION_REQUIRED") {
        setUssdAccepted(false);
        setProviderMessage(message);
        showMessage("Autorisation USSD", message);
      } else {
        showMessage("Paiement indisponible", message);
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (status !== "waiting" || !session?.reference) return;
    let stopped = false;
    const poll = async () => {
      try {
        const result = await api.get<any>(`/payments/${encodeURIComponent(session.reference)}/status`);
        if (stopped) return;
        if (result.status === "refund_required" || result.manual_refund_required) {
          setStatus("refund");
          return;
        }
        if (result.status === "pending_admin_review" ||
            result.registered === true || result.already_registered === true ||
            (result.status === "paid" && result.activation_done === true)) {
          setStatus("done");
          try { await refresh(); } catch {}
          return;
        }
        if (["failed", "rejected", "expired", "underpaid"].includes(result.status)) {
          setProviderMessage(result.error || "Le prestataire a refusé le paiement.");
          setStatus("failed");
        }
      } catch {}
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [status, session?.reference, refresh]);

  function finish() {
    router.replace(returnTo as any);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={20} color="#fff" />
          <Text style={styles.backText}>Retour</Text>
        </TouchableOpacity>
        <View style={styles.heading}>
          <View style={styles.icon}><Ionicons name="card" size={24} color="#fff" /></View>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>
            Choisissez parmi les prestataires activés pour votre pays. Le paiement sera vérifié avant la confirmation.
          </Text>
          {params.amount ? <Text style={styles.amount}>{Number(params.amount).toLocaleString("fr-FR")} FCFA</Text> : null}
        </View>

        {status === "form" && (
          <View style={styles.card}>
            {catalogError ? <Text style={styles.error}>{catalogError}</Text> : null}
            {!catalog && !catalogError ? <ActivityIndicator color={theme.colors.primary} /> : null}
            {catalog && catalog.countries.length === 0 ? (
              <Text style={styles.error}>Aucun moyen de paiement n'est actuellement disponible.</Text>
            ) : null}
            {catalog && catalog.countries.length > 0 && (
              <>
                <Text style={styles.label}>Pays</Text>
                <View style={styles.options}>
                  {catalog.countries.map((c) => (
                    <TouchableOpacity key={c.code}
                      style={[styles.option, countryCode === c.code && styles.optionOn]}
                      onPress={() => { setCountryCode(c.code); setOperatorCode(c.operators?.[0]?.code || ""); }}>
                      <Text style={[styles.optionText, countryCode === c.code && styles.optionTextOn]}>{c.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.label}>Prestataire / opérateur</Text>
                <View style={styles.options}>
                  {(country?.operators || []).map((o) => (
                    <TouchableOpacity key={`${o.gateway}-${o.code}`}
                      style={[styles.option, operatorCode === o.code && styles.optionOn]}
                      onPress={() => { setOperatorCode(o.code); setOtp(""); setUssdAccepted(false); }}>
                      <Text style={[styles.optionText, operatorCode === o.code && styles.optionTextOn]}>
                        {o.label}{o.gateway === "biztranspay_crypto" ? " · Biz-transPay" :
                          o.gateway === "izichange" ? " · IziChange" : ` · ${o.gateway}`}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {operator && !isCrypto && (
                  <>
                    <Text style={styles.label}>Numéro Mobile Money</Text>
                    <TextInput style={styles.input} value={phone} onChangeText={setPhone}
                      keyboardType="phone-pad" placeholder="Votre numéro de téléphone" />
                    {operator.requires_otp && (
                      <>
                        <Text style={styles.label}>Code reçu par SMS</Text>
                        <TextInput style={styles.input} value={otp} onChangeText={setOtp}
                          keyboardType="number-pad" placeholder="Code OTP" />
                      </>
                    )}
                    {ussdCode ? (
                      <TouchableOpacity style={styles.checkRow} onPress={() => setUssdAccepted((v) => !v)}>
                        <Ionicons name={ussdAccepted ? "checkbox" : "square-outline"} size={22} color={theme.colors.primary} />
                        <Text style={styles.hint}>J'ai composé {ussdCode} et autorisé le paiement.</Text>
                      </TouchableOpacity>
                    ) : null}
                  </>
                )}
                {operator && isCrypto && (
                  <Text style={styles.hint}>Vous recevrez une adresse de dépôt USDT à utiliser sur le réseau BEP20.</Text>
                )}
                {providerMessage ? <Text style={styles.hint}>{providerMessage}</Text> : null}
                <TouchableOpacity style={[styles.primary, busy && { opacity: 0.6 }]}
                  disabled={busy || !operator} onPress={startPayment}>
                  {busy ? <ActivityIndicator color="#fff" /> :
                    <><Text style={styles.primaryText}>Continuer le paiement</Text><Ionicons name="arrow-forward" size={18} color="#fff" /></>}
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {status === "waiting" && (
          <View style={styles.card}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.waitTitle}>Vérification du paiement</Text>
            <Text style={styles.hint}>{providerMessage || "Validez la demande sur votre téléphone ou terminez le paiement sur la page du prestataire."}</Text>
            {session?.deposit_address ? (
              <>
                <Text style={styles.label}>Adresse de dépôt</Text>
                <Text selectable style={styles.address}>{session.deposit_address}</Text>
                <Text style={styles.hint}>
                  Montant : {session.amount_to_send || session.amount} {session.asset_code || "USDT"} · Réseau {session.network || "BEP20"}
                </Text>
              </>
            ) : null}
            <Text style={styles.hint}>Référence : {session?.reference}</Text>
            <TouchableOpacity style={styles.secondary} onPress={finish}>
              <Text style={styles.secondaryText}>Revenir plus tard</Text>
            </TouchableOpacity>
          </View>
        )}

        {status === "done" && (
          <View style={styles.card}>
            <Ionicons name="checkmark-circle" size={56} color="#16A34A" />
            <Text style={styles.waitTitle}>Paiement confirmé</Text>
            <Text style={styles.hint}>
              {kind === "lottery_entry"
                ? "Votre ticket Jackpot est confirmé."
                : "Votre publication a été envoyée pour validation."}
            </Text>
            <TouchableOpacity style={styles.primary} onPress={finish}>
              <Text style={styles.primaryText}>Continuer</Text>
            </TouchableOpacity>
          </View>
        )}

        {status === "refund" && (
          <View style={styles.card}>
            <Ionicons name="alert-circle" size={52} color="#D97706" />
            <Text style={styles.waitTitle}>Vérification nécessaire</Text>
            <Text style={styles.hint}>Le paiement a été reçu, mais le ticket n'a pas pu être confirmé. Un remboursement manuel doit être vérifié par l'équipe.</Text>
            <TouchableOpacity style={styles.primary} onPress={finish}>
              <Text style={styles.primaryText}>Fermer</Text>
            </TouchableOpacity>
          </View>
        )}

        {status === "failed" && (
          <View style={styles.card}>
            <Ionicons name="close-circle" size={52} color="#DC2626" />
            <Text style={styles.waitTitle}>Paiement non confirmé</Text>
            <Text style={styles.error}>{providerMessage || "Le paiement a échoué."}</Text>
            <TouchableOpacity style={styles.secondary} onPress={() => { setSession(null); setStatus("form"); }}>
              <Text style={styles.secondaryText}>Réessayer</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F4F7FB" },
  content: { padding: 18, gap: 14, maxWidth: 720, width: "100%", alignSelf: "center" },
  back: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#132A52", paddingHorizontal: 12, paddingVertical: 9, borderRadius: 20 },
  backText: { color: "#fff", fontWeight: "800" },
  heading: { alignItems: "center", gap: 8, paddingVertical: 10 },
  icon: { width: 52, height: 52, borderRadius: 18, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },
  title: { color: "#12284B", fontSize: 21, fontWeight: "900", textAlign: "center" },
  subtitle: { color: "#64748B", textAlign: "center", maxWidth: 480, lineHeight: 20 },
  amount: { color: "#0F2E5D", fontSize: 22, fontWeight: "900" },
  card: { backgroundColor: "#fff", borderRadius: 18, padding: 18, gap: 12, elevation: 2, shadowColor: "#0F172A", shadowOpacity: 0.06, shadowRadius: 12 },
  label: { color: "#1E293B", fontWeight: "800", marginTop: 4 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: { borderWidth: 1, borderColor: "#D7DFE9", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "#fff" },
  optionOn: { backgroundColor: "#1D4ED8", borderColor: "#1D4ED8" },
  optionText: { color: "#334155", fontWeight: "700", fontSize: 12 },
  optionTextOn: { color: "#fff" },
  input: { borderWidth: 1, borderColor: "#CBD5E1", borderRadius: 12, padding: 13, backgroundColor: "#fff", color: "#0F172A" },
  hint: { color: "#64748B", fontSize: 13, lineHeight: 19, textAlign: "center" },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  primary: { backgroundColor: "#1D4ED8", borderRadius: 13, padding: 14, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 4 },
  primaryText: { color: "#fff", fontWeight: "900" },
  secondary: { backgroundColor: "#EEF2F7", borderRadius: 13, padding: 13, alignItems: "center" },
  secondaryText: { color: "#334155", fontWeight: "800" },
  waitTitle: { color: "#132A52", fontWeight: "900", fontSize: 18, textAlign: "center" },
  address: { color: "#0F172A", backgroundColor: "#F1F5F9", borderRadius: 10, padding: 12, textAlign: "center", fontSize: 12 },
  error: { color: "#B91C1C", textAlign: "center", fontWeight: "700" },
});
