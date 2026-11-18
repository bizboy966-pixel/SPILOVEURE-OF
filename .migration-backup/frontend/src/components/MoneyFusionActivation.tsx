import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { Card } from "@/src/components/Card";
import { storage } from "@/src/utils/storage";

type Country = {
  country_code: string;
  country: string;
  currency: string;
  amount: number;
  operators: { code: string; label: string }[];
};
type Catalog = { enabled: boolean; countries: Country[] };
type PendingPayment = { reference: string; url: string; amount: number; currency: string };

const ink = "#183B43";
const teal = "#176B64";
const muted = "#60777A";
const line = "#D5E3DF";
const keyForUser = (id: string) => `moneyfusion_pending_activation_${id}`;

export default function MoneyFusionActivation({ pendingOnly = false }: { pendingOnly?: boolean }) {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [phone, setPhone] = useState(user?.phone || "");
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [status, setStatus] = useState("pending");
  const [statusMessage, setStatusMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false);

  const selectedCountry = useMemo(
    () => catalog?.countries.find((item) => item.country_code === countryCode) || catalog?.countries[0] || null,
    [catalog, countryCode],
  );

  const persist = useCallback(async (payment: PendingPayment | null) => {
    if (!user?.id) return;
    const key = keyForUser(user.id);
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (payment) window.localStorage.setItem(key, JSON.stringify(payment));
      else window.localStorage.removeItem(key);
    } else {
      const stored = payment
        ? await storage.setItem(key, JSON.stringify(payment))
        : await storage.removeItem(key);
      if (!stored) throw new Error("Impossible d’enregistrer la référence sur cet appareil.");
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    (async () => {
      try {
        let raw: string | null = null;
        if (Platform.OS === "web" && typeof window !== "undefined") {
          raw = window.localStorage.getItem(keyForUser(user.id));
        } else {
          raw = await storage.getItem(keyForUser(user.id), "");
        }
        if (active && raw) {
          const restored = JSON.parse(raw) as PendingPayment;
          if (restored?.reference && restored?.url) {
            setPending(restored);
            setStatus("pending");
            setStatusMessage("Paiement en attente de confirmation. Cette page vérifie son statut.");
          }
        }
      } catch {
        if (active) setStatusMessage("Le paiement en attente n’a pas pu être restauré depuis cet appareil.");
      } finally {
        if (active) setStorageReady(true);
      }
    })();
    return () => { active = false; };
  }, [user?.id]);

  useEffect(() => {
    if (!user?.phone) return;
    setPhone((current) => current || user.phone);
  }, [user?.phone]);

  useEffect(() => {
    let active = true;
    api.get<Catalog>("/payments/moneyfusion/catalog", { auth: false })
      .then((data) => {
        if (!active) return;
        const countries = Array.isArray(data?.countries) ? data.countries : [];
        setCatalog({ enabled: !!data?.enabled, countries });
        setCountryCode((current) => countries.some((c) => c.country_code === current) ? current : (countries[0]?.country_code || ""));
      })
      .catch((e: any) => {
        if (active) setCatalogError(e?.detail || "Impossible de charger les options MoneyFusion. Réessayez dans un instant.");
      })
      .finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, []);

  const clearPending = useCallback(async (nextMessage: string) => {
    setPending(null);
    try { await persist(null); } catch { /* Keep the terminal result visible even if local cleanup fails. */ }
    setStatusMessage(nextMessage);
  }, [persist]);

  const checkStatus = useCallback(async () => {
    if (!pending || statusBusy) return;
    setStatusBusy(true);
    try {
      const result = await api.get<{ status: string; activation_done?: boolean; message?: string }>(
        `/payments/moneyfusion/status/${encodeURIComponent(pending.reference)}`,
      );
      const next = String(result?.status || "pending").toLowerCase();
      setStatus(next);
      if (next === "paid" && result.activation_done === true) {
        await clearPending("Paiement confirmé. Votre compte est activé.");
        await refresh();
        const needsAccountAccess = user?.auth_flow_version === 2 && (
          user.session_scope === "onboarding" || user.main_password_created !== true || !user.email_verified
        );
        router.replace(needsAccountAccess ? "/account-access" : "/services");
        return;
      }
      if (next === "failed") {
        await clearPending("MoneyFusion indique que ce paiement n’a pas abouti. Aucun nouveau paiement n’a été lancé.");
      } else if (next === "review") {
        setStatusMessage("Le paiement nécessite une vérification par l’équipe. Sa référence reste enregistrée ; ne relancez pas le paiement avant d’avoir contacté le support.");
      } else if (next === "paid") {
        setStatusMessage("Paiement reçu, mais l’activation n’est pas encore finalisée. Le statut sera revérifié.");
      } else {
        setStatusMessage(result?.message || "Confirmation en attente auprès de MoneyFusion.");
      }
    } catch (e: any) {
      setStatusMessage(e?.detail || "Vérification momentanément indisponible. Votre référence reste enregistrée.");
    } finally {
      setStatusBusy(false);
    }
  }, [pending, statusBusy, clearPending, refresh, router, user?.auth_flow_version, user?.session_scope, user?.main_password_created, user?.email]);
  const checkStatusRef = useRef(checkStatus);
  checkStatusRef.current = checkStatus;

  useEffect(() => {
    if (!pending || !storageReady || status === "review") return;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      await checkStatusRef.current();
    };
    poll();
    const timer = setInterval(poll, 10000);
    return () => { stopped = true; clearInterval(timer); };
  }, [pending?.reference, storageReady, status]);

  const openCheckout = async () => {
    if (!pending) return;
    try {
      await persist(pending);
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.location.assign(pending.url);
      } else {
        await Linking.openURL(pending.url);
      }
    } catch {
      setStatusMessage("Impossible d’enregistrer ou d’ouvrir la page de paiement sur cet appareil. Votre référence reste affichée ici.");
    }
  };

  const startPayment = async () => {
    if (!selectedCountry || phone.trim().replace(/\D/g, "").length < 6 || busy || pending) return;
    setBusy(true);
    setStatusMessage("");
    try {
      const result = await api.post<PendingPayment & { status: string }>("/payments/moneyfusion/initiate", {
        level: 1,
        phone: phone.trim(),
        country_code: selectedCountry.country_code,
      });
      const payment = {
        reference: result.reference,
        url: result.url,
        amount: result.amount,
        currency: result.currency,
      };
      setPending(payment);
      setStatus("pending");
      setStatusMessage("Demande créée. Confirmez le paiement sur la page MoneyFusion ; nous vérifierons ensuite son statut.");
      try {
        await persist(payment);
      } catch {
        setStatusMessage(`Demande créée, mais la référence ${payment.reference} n’a pas pu être enregistrée sur cet appareil. Restez sur cette page et ne la fermez pas.`);
        return;
      }
      try {
        if (Platform.OS === "web" && typeof window !== "undefined") {
          window.location.assign(payment.url);
        } else {
          await Linking.openURL(payment.url);
        }
      } catch {
        setStatusMessage("La demande est créée et sa référence est enregistrée, mais la page MoneyFusion n’a pas pu s’ouvrir. Utilisez « Ouvrir le paiement ».");
      }
    } catch (e: any) {
      setStatusMessage(e?.detail || "Impossible de démarrer le paiement MoneyFusion.");
    } finally {
      setBusy(false);
    }
  };

  if (pendingOnly && !pending) return null;
  if (catalogLoading || !storageReady) {
    return <Card style={styles.card}><View style={styles.loading}><ActivityIndicator color={teal} /><Text style={styles.muted}>Chargement du paiement Mobile Money…</Text></View></Card>;
  }
  if (catalogError && !pending) {
    return (
      <Card style={styles.card}>
        <Header />
        <View style={styles.errorBox}><Ionicons name="cloud-offline-outline" size={20} color="#9A4F37" /><Text accessibilityRole="alert" style={styles.errorText}>{catalogError}</Text></View>
        <TouchableOpacity accessibilityRole="button" onPress={() => {
          setCatalogError("");
          setCatalogLoading(true);
          api.get<Catalog>("/payments/moneyfusion/catalog", { auth: false })
            .then((data) => { const countries = Array.isArray(data?.countries) ? data.countries : []; setCatalog({ enabled: !!data.enabled, countries }); setCountryCode(countries[0]?.country_code || ""); })
            .catch((e: any) => setCatalogError(e?.detail || "Impossible de charger les options MoneyFusion."))
            .finally(() => setCatalogLoading(false));
        }} style={styles.secondaryButton}>
          <Ionicons name="refresh-outline" size={16} color={teal} /><Text style={styles.secondaryText}>Réessayer</Text>
        </TouchableOpacity>
      </Card>
    );
  }
  if (!pending && (!catalog?.enabled || !catalog.countries.length)) return null;

  return (
    <Card style={styles.card} testID="moneyfusion-activation">
      <Header />
      {pending ? (
        <View>
          <View style={[styles.stateBanner, status === "review" ? styles.reviewBanner : status === "failed" ? styles.failedBanner : styles.pendingBanner]}>
            <Ionicons name={status === "review" ? "alert-circle-outline" : status === "failed" ? "close-circle-outline" : "time-outline"} size={20} color={status === "review" || status === "failed" ? "#9A4F37" : teal} />
            <View style={{ flex: 1 }}>
              <Text style={styles.stateTitle}>{status === "review" ? "Vérification requise" : status === "failed" ? "Paiement non abouti" : "Paiement en attente"}</Text>
              <Text style={styles.stateCopy}>{statusMessage || "Le résultat n’est pas encore confirmé."}</Text>
            </View>
          </View>
          <Text style={styles.reference}>Référence · {pending.reference}</Text>
          <Text style={styles.amountLine}>Montant à régler : <Text style={{ fontWeight: "900" }}>{pending.amount.toLocaleString("fr-FR")} {pending.currency}</Text></Text>
          <View style={styles.actionRow}>
            <TouchableOpacity accessibilityRole="button" onPress={openCheckout} disabled={status === "review"} style={[styles.primaryButton, status === "review" && styles.disabledButton]}>
              <Ionicons name="open-outline" size={17} color="#fff" /><Text style={styles.primaryText}>Ouvrir le paiement</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" onPress={checkStatus} disabled={statusBusy} style={styles.secondaryButton}>
              {statusBusy ? <ActivityIndicator color={teal} size="small" /> : <Ionicons name="refresh-outline" size={17} color={teal} />}
              <Text style={styles.secondaryText}>Vérifier</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <>
          <Text style={styles.body}>Activez le Niveau 1 avec Mobile Money. Le montant affiché est fourni par la configuration de paiement.</Text>
          <Text style={styles.label}>Pays</Text>
          <View style={styles.countryList}>
            {catalog?.countries.map((item) => (
              <TouchableOpacity
                key={item.country_code}
                accessibilityRole="radio"
                accessibilityState={{ selected: countryCode === item.country_code }}
                onPress={() => setCountryCode(item.country_code)}
                style={[styles.countryButton, countryCode === item.country_code && styles.countrySelected]}
              >
                <Text style={[styles.countryName, countryCode === item.country_code && styles.countryNameSelected]}>{item.country}</Text>
                <Text style={[styles.countryCode, countryCode === item.country_code && styles.countryNameSelected]}>{item.country_code} · {item.currency}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {selectedCountry ? (
            <View style={styles.amountBox}>
              <View>
                <Text style={styles.amountLabel}>Montant d’activation</Text>
                <Text style={styles.smallNote}>Niveau 1 · tarif fixe converti selon le taux configuré</Text>
              </View>
              <Text style={styles.amount}>{selectedCountry.amount.toLocaleString("fr-FR")} <Text style={styles.currency}>{selectedCountry.currency}</Text></Text>
            </View>
          ) : null}
          <Text style={styles.label}>Numéro Mobile Money</Text>
          <TextInput
            value={phone}
            onChangeText={setPhone}
            placeholder="Votre numéro de paiement"
            placeholderTextColor="#819592"
            keyboardType="phone-pad"
            style={styles.input}
            accessibilityLabel="Numéro Mobile Money"
          />
          <Text style={styles.smallNote}>MoneyFusion affichera les opérateurs proposés pour ce pays sur sa page de paiement.</Text>
          {statusMessage ? <Text accessibilityRole="alert" style={styles.statusMessage}>{statusMessage}</Text> : null}
          <TouchableOpacity accessibilityRole="button" onPress={startPayment} disabled={!selectedCountry || phone.trim().replace(/\D/g, "").length < 6 || busy || status === "review"} style={[styles.primaryButton, styles.startButton, (!selectedCountry || phone.trim().replace(/\D/g, "").length < 6 || busy || status === "review") && styles.disabledButton]}>
            {busy ? <ActivityIndicator color="#fff" /> : <Ionicons name="arrow-forward-circle-outline" size={19} color="#fff" />}
            <Text style={styles.primaryText}>{busy ? "Préparation du paiement…" : "Continuer avec MoneyFusion"}</Text>
          </TouchableOpacity>
        </>
      )}
    </Card>
  );
}

function Header() {
  return (
    <View style={styles.header}>
      <View style={styles.headerIcon}><Ionicons name="phone-portrait-outline" size={19} color={teal} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>Mobile Money · MoneyFusion</Text>
        <Text style={styles.subtitle}>Activation automatique du Niveau 1</Text>
      </View>
      <View style={styles.securePill}><Ionicons name="lock-closed-outline" size={12} color={teal} /><Text style={styles.secureText}>Paiement sécurisé</Text></View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 12, marginBottom: 12, padding: 16, borderRadius: 18, borderColor: line, backgroundColor: "#F8FBF8" },
  loading: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  muted: { color: muted, fontSize: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" },
  headerIcon: { width: 40, height: 40, borderRadius: 13, backgroundColor: "#EAF4EF", alignItems: "center", justifyContent: "center" },
  title: { color: ink, fontSize: 15, fontWeight: "900" },
  subtitle: { color: muted, fontSize: 11, marginTop: 3 },
  securePill: { flexDirection: "row", gap: 4, alignItems: "center", borderWidth: 1, borderColor: "#C9DDD6", borderRadius: 20, paddingHorizontal: 8, paddingVertical: 5 },
  secureText: { color: teal, fontSize: 9, fontWeight: "800" },
  body: { color: muted, fontSize: 12, lineHeight: 18, marginBottom: 14 },
  label: { color: ink, fontSize: 12, fontWeight: "800", marginBottom: 7, marginTop: 11 },
  countryList: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  countryButton: { borderWidth: 1, borderColor: line, borderRadius: 10, backgroundColor: "#fff", paddingHorizontal: 11, paddingVertical: 9, minWidth: 105 },
  countrySelected: { borderColor: teal, backgroundColor: "#EAF4EF" },
  countryName: { color: ink, fontSize: 12, fontWeight: "800" },
  countryCode: { color: muted, fontSize: 10, marginTop: 3 },
  countryNameSelected: { color: teal },
  amountBox: { backgroundColor: "#EDF5F1", borderRadius: 12, padding: 12, marginTop: 13, marginBottom: 4, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  amountLabel: { color: ink, fontSize: 11, fontWeight: "700" },
  smallNote: { color: muted, fontSize: 10, lineHeight: 15, marginTop: 4 },
  amount: { color: teal, fontSize: 19, fontWeight: "900", textAlign: "right" },
  currency: { fontSize: 12 },
  input: { minHeight: 46, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: line, backgroundColor: "#fff", color: ink, fontSize: 14 },
  primaryButton: { minHeight: 44, borderRadius: 11, paddingHorizontal: 13, backgroundColor: teal, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  startButton: { marginTop: 15 },
  primaryText: { color: "#fff", fontWeight: "900", fontSize: 12 },
  disabledButton: { opacity: 0.5 },
  secondaryButton: { minHeight: 42, borderRadius: 10, borderWidth: 1, borderColor: "#A7C9BF", paddingHorizontal: 12, backgroundColor: "#fff", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  secondaryText: { color: teal, fontWeight: "800", fontSize: 11 },
  statusMessage: { color: "#8B4B24", fontSize: 12, lineHeight: 18, marginTop: 12 },
  errorBox: { flexDirection: "row", alignItems: "flex-start", gap: 9, backgroundColor: "#FFF4E8", padding: 11, borderRadius: 10, marginBottom: 10 },
  errorText: { flex: 1, color: "#8B4B24", fontSize: 12, lineHeight: 18 },
  stateBanner: { flexDirection: "row", gap: 9, alignItems: "flex-start", padding: 11, borderRadius: 11 },
  pendingBanner: { backgroundColor: "#EAF4EF" },
  reviewBanner: { backgroundColor: "#FFF4E8" },
  failedBanner: { backgroundColor: "#FFF0EE" },
  stateTitle: { color: ink, fontSize: 12, fontWeight: "900" },
  stateCopy: { color: muted, fontSize: 11, lineHeight: 17, marginTop: 3 },
  reference: { color: muted, fontSize: 10, fontWeight: "800", marginTop: 12 },
  amountLine: { color: ink, fontSize: 12, marginTop: 7 },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 14, flexWrap: "wrap" },
});
