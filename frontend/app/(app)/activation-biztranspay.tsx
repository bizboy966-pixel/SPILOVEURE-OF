/**
 * BizTransPay v2 activation — 2 canaux : Mobile Money + Crypto USDT.BEP20.
 *
 * Flow :
 *   1. Choix du canal (Mobile Money OU Crypto).
 *   2. Mobile Money : pays + opérateur + numéro → POST /payments/biztranspay/mobile/initiate.
 *      L'utilisateur reçoit une invite USSD/opérateur pour valider le paiement.
 *   3. Crypto : POST /payments/biztranspay/crypto/initiate renvoie
 *      { deposit_address, qr_data } → affichage adresse + QR + bouton copier.
 *   4. Polling automatique toutes les 15 s sur /status/{reference}.
 *   5. À la confirmation (via webhook ou polling), le backend active l'utilisateur
 *      et envoie une notif push. La page redirige vers /dashboard.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, SafeAreaView, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";

type PublicStatus = {
  enabled: boolean;
  activation_amount_xof: number;
  activation_amount_usdt: number;
  network: string;
};

type CountryOp = { label: string; code: string };
type Country = { code: string; name: string; currency: string; dial_code: string; operators: CountryOp[] };

type MobileCharge = {
  reference: string; provider_intent_id?: string; status: string;
  amount: number; currency: string; country: string; operator: string; phone: string;
};

type CryptoCharge = {
  reference: string; provider_intent_id?: string;
  deposit_address: string; qr_data?: string | null;
  amount: number; asset_code: string; network: string;
};

const QR = (data: string) =>
  `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(data)}`;

const copy = (t: string) => {
  if (typeof navigator !== "undefined" && (navigator as any).clipboard) {
    (navigator as any).clipboard.writeText(t);
    if (typeof window !== "undefined") window.alert(`✅ Copié : ${t}`);
  }
};

const FLAGS: Record<string, string> = {
  TG: "🇹🇬", BJ: "🇧🇯", BF: "🇧🇫", CI: "🇨🇮", ML: "🇲🇱",
  SN: "🇸🇳", NE: "🇳🇪", CM: "🇨🇲", GA: "🇬🇦", CD: "🇨🇩",
};

export default function BizTransPayActivation() {
  const router = useRouter();
  const { user, refresh } = useAuth() as any;
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [countries, setCountries] = useState<Country[]>([]);
  const [channel, setChannel] = useState<"choose" | "mobile" | "crypto">("choose");

  // Mobile flow
  const [countryCode, setCountryCode] = useState<string>("");
  const [operatorCode, setOperatorCode] = useState<string>("");
  const [phone, setPhone] = useState("");
  const [mobileCharge, setMobileCharge] = useState<MobileCharge | null>(null);

  // Crypto flow
  const [cryptoCharge, setCryptoCharge] = useState<CryptoCharge | null>(null);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const pollTimer = useRef<any>(null);

  const currentCountry = countries.find((c) => c.code === countryCode) || null;

  useEffect(() => {
    (async () => {
      try {
        const s = await api.get<PublicStatus>("/payments/biztranspay/public/status");
        setStatus(s);
        const c = await api.get<{ countries: Country[] }>("/payments/biztranspay/catalog");
        setCountries(c.countries || []);
      } catch (e: any) {
        setErr(e?.detail || "Impossible de charger la passerelle BizTransPay.");
      }
    })();
  }, []);

  // Polling
  const activeReference = mobileCharge?.reference || cryptoCharge?.reference;
  useEffect(() => {
    if (!activeReference || done) return;
    const tick = async () => {
      try {
        const r = await api.get<any>(`/payments/biztranspay/status/${activeReference}`);
        if (r?.deposit_address && cryptoCharge && !cryptoCharge.deposit_address) {
          setCryptoCharge({ ...cryptoCharge, deposit_address: r.deposit_address, qr_data: r.qr_data });
        }
        if (r?.activated) {
          setDone(true);
          setStatusMsg(r.message || "Compte activé.");
          if (pollTimer.current) clearInterval(pollTimer.current);
          try { if (typeof refresh === "function") await refresh(); } catch {}
          if (typeof window !== "undefined") window.alert("🎉 Paiement confirmé — votre compte SPILOVEURE est activé !");
          // Small delay so refresh() finishes propagating before the guard evaluates max_level.
          setTimeout(() => router.replace("/(app)/dashboard" as any), 400);
          return;
        }
        if (r?.status && r.status !== "pending") setStatusMsg(r.message || `Statut : ${r.status}`);
      } catch { /* keep polling */ }
    };
    tick();
    pollTimer.current = setInterval(tick, 15_000);
    return () => clearInterval(pollTimer.current);
  }, [activeReference, done, router, cryptoCharge]);

  const startMobile = async () => {
    if (!countryCode || !operatorCode || phone.trim().length < 6) {
      setErr("Merci de sélectionner un pays, un opérateur et de saisir un numéro valide."); return;
    }
    setLoading(true); setErr(null);
    try {
      const r = await api.post<MobileCharge>("/payments/biztranspay/mobile/initiate", {
        country: countryCode, operator_code: operatorCode, phone: phone.trim(),
      });
      setMobileCharge(r);
      setStatusMsg("📱 Consultez votre téléphone : validez la demande de paiement mobile money.");
    } catch (e: any) {
      setErr(e?.detail || "Impossible de démarrer le paiement Mobile Money.");
    } finally { setLoading(false); }
  };

  const startCrypto = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await api.post<CryptoCharge>("/payments/biztranspay/crypto/initiate", {});
      setCryptoCharge(r);
    } catch (e: any) {
      setErr(e?.detail || "Impossible de générer l'adresse de dépôt.");
    } finally { setLoading(false); }
  };

  if (!status) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={theme.colors.primary} />
          <Text style={{ marginTop: 8, color: theme.colors.textSecondary }}>Chargement…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!status.enabled) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>💎 BizTransPay</Text>
        </View>
        <View style={{ padding: 16 }}>
          <View style={styles.card}>
            <Text style={{ color: "#92400E", fontWeight: "800" }}>⚠️ Passerelle non configurée</Text>
            <Text style={styles.p}>BizTransPay est désactivé côté administration. Veuillez utiliser une autre méthode de paiement.</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>💎 Auto-activation BizTransPay</Text>
        <Text style={styles.sub}>Mobile Money · Crypto USDT.{status.network}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {/* User identity — always shown */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>👤 Vos informations</Text>
          <View style={styles.kv}><Text style={styles.kvK}>Nom d'utilisateur</Text><Text style={styles.kvV}>{user?.username || "—"}</Text></View>
          <View style={styles.kv}><Text style={styles.kvK}>Nom complet</Text><Text style={styles.kvV}>{(user as any)?.full_name || user?.username || "—"}</Text></View>
          <View style={styles.kv}><Text style={styles.kvK}>E-mail</Text><Text style={styles.kvV}>{user?.email || "—"}</Text></View>
        </View>

        {err ? (
          <View style={[styles.card, { backgroundColor: theme.colors.dangerBg, borderColor: theme.colors.danger }]}>
            <Text style={{ color: theme.colors.danger, fontWeight: "700" }} testID="btp-error">❌ {err}</Text>
          </View>
        ) : null}

        {channel === "choose" && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Choisissez votre moyen de paiement</Text>
            <TouchableOpacity style={styles.choiceBtn} onPress={() => setChannel("mobile")} testID="btp-choose-mobile">
              <View style={styles.choiceIcon}><Ionicons name="phone-portrait" size={20} color="#0EA5E9" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.choiceT}>📱 Mobile Money</Text>
                <Text style={styles.choiceS}>{Number(status.activation_amount_xof).toLocaleString("fr-FR")} XOF — Frais à la charge du marchand</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.choiceBtn} onPress={() => setChannel("crypto")} testID="btp-choose-crypto">
              <View style={styles.choiceIcon}><Ionicons name="logo-bitcoin" size={20} color="#F59E0B" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.choiceT}>₿ Crypto USDT.{status.network}</Text>
                <Text style={styles.choiceS}>{status.activation_amount_usdt} USDT — Frais à la charge du marchand</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </View>
        )}

        {/* ────────── Mobile Money flow ────────── */}
        {channel === "mobile" && !mobileCharge && (
          <View style={styles.card}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <TouchableOpacity onPress={() => setChannel("choose")}><Ionicons name="chevron-back" size={18} color={theme.colors.textSecondary} /></TouchableOpacity>
              <Text style={styles.cardTitle}>📱 Paiement Mobile Money</Text>
            </View>
            <Text style={styles.p}>Montant : <Text style={{ fontWeight: "800" }}>{Number(status.activation_amount_xof).toLocaleString("fr-FR")} XOF</Text> (non modifiable, frais marchand).</Text>

            <Text style={styles.lbl}>Pays</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {countries.map((c) => (
                <TouchableOpacity key={c.code} onPress={() => { setCountryCode(c.code); setOperatorCode(""); }} testID={`btp-country-${c.code}`}
                  style={[styles.pill, countryCode === c.code && styles.pillActive]}>
                  <Text style={[styles.pillT, countryCode === c.code && { color: "#fff" }]}>{FLAGS[c.code] || ""} {c.code}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {currentCountry && (
              <>
                <Text style={styles.lbl}>Opérateur</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                  {currentCountry.operators.map((op) => (
                    <TouchableOpacity key={op.code} onPress={() => setOperatorCode(op.code)} testID={`btp-op-${op.code}`}
                      style={[styles.pill, operatorCode === op.code && styles.pillActive]}>
                      <Text style={[styles.pillT, operatorCode === op.code && { color: "#fff" }]}>{op.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.lbl}>Numéro Mobile Money ({currentCountry.dial_code ? `+${currentCountry.dial_code}` : ""})</Text>
                <TextInput style={styles.input} value={phone} onChangeText={setPhone}
                  placeholder="Ex: 91234567" placeholderTextColor={theme.colors.textSecondary}
                  keyboardType="phone-pad" testID="btp-phone" />
              </>
            )}

            <TouchableOpacity style={[styles.primaryBtn, loading && { opacity: 0.5 }]} onPress={startMobile} disabled={loading} testID="btp-mobile-pay">
              {loading ? <ActivityIndicator color="#fff" /> :
                <><Ionicons name="rocket" size={16} color="#fff" /><Text style={styles.primaryBtnT}>PAYER MAINTENANT</Text></>}
            </TouchableOpacity>
          </View>
        )}

        {channel === "mobile" && mobileCharge && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>📱 Paiement en cours</Text>
            <View style={{ padding: 12, backgroundColor: theme.colors.warningBg, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.warning }}>
              <Text style={{ color: "#92400E", fontWeight: "800", fontSize: 13 }}>⏳ Validez le paiement sur votre téléphone</Text>
              <Text style={{ color: "#78350F", fontSize: 12, marginTop: 4 }}>
                Une requête a été envoyée à votre opérateur. Suivez les instructions pour confirmer le débit de <Text style={{ fontWeight: "800" }}>{mobileCharge.amount} {mobileCharge.currency}</Text>.
              </Text>
            </View>
            <View style={styles.kv}><Text style={styles.kvK}>Numéro</Text><Text style={styles.kvV}>{mobileCharge.phone}</Text></View>
            <View style={styles.kv}><Text style={styles.kvK}>Référence</Text><Text style={styles.kvV}>{mobileCharge.reference}</Text></View>
            {statusMsg ? (
              <View style={styles.statusBox}>
                <Text style={{ color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 }}>ℹ️ {statusMsg}</Text>
              </View>
            ) : null}
            <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 8, textAlign: "center" }}>
              Cette page se met à jour automatiquement toutes les 15 secondes.
            </Text>
          </View>
        )}

        {/* ────────── Crypto flow ────────── */}
        {channel === "crypto" && !cryptoCharge && (
          <View style={styles.card}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <TouchableOpacity onPress={() => setChannel("choose")}><Ionicons name="chevron-back" size={18} color={theme.colors.textSecondary} /></TouchableOpacity>
              <Text style={styles.cardTitle}>₿ Paiement Crypto USDT.{status.network}</Text>
            </View>
            <Text style={styles.p}>Montant fixe : <Text style={{ fontWeight: "800" }}>{status.activation_amount_usdt} USDT</Text> (frais marchand, réseau {status.network} uniquement).</Text>
            <TouchableOpacity style={[styles.primaryBtn, loading && { opacity: 0.5 }]} onPress={startCrypto} disabled={loading} testID="btp-crypto-start">
              {loading ? <ActivityIndicator color="#fff" /> :
                <><Ionicons name="rocket" size={16} color="#fff" /><Text style={styles.primaryBtnT}>Générer mon adresse de dépôt</Text></>}
            </TouchableOpacity>
          </View>
        )}

        {channel === "crypto" && cryptoCharge && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>💳 Envoyez votre paiement crypto</Text>
            <View style={styles.warnBox}>
              <Ionicons name="warning" size={16} color="#92400E" />
              <Text style={styles.warnT}>
                Envoyez exactement <Text style={{ fontWeight: "800" }}>{cryptoCharge.amount} USDT</Text> sur le réseau <Text style={{ fontWeight: "800" }}>{cryptoCharge.network} uniquement</Text>. Tout autre réseau entraînera une perte de fonds.
              </Text>
            </View>
            <Text style={styles.lbl}>Adresse de dépôt</Text>
            <TouchableOpacity style={styles.addrBox} onPress={() => copy(cryptoCharge.deposit_address)} testID="btp-crypto-copy-address">
              <Text style={styles.addr} numberOfLines={2}>{cryptoCharge.deposit_address}</Text>
              <View style={styles.copyPill}>
                <Ionicons name="copy-outline" size={13} color={theme.colors.primary} />
                <Text style={{ color: theme.colors.primary, fontSize: 10, fontWeight: "800", letterSpacing: 0.3 }}>COPIER</Text>
              </View>
            </TouchableOpacity>
            <View style={styles.qrWrap}>
              {/* @ts-ignore RN Web accepts <img> */}
              <img src={QR(cryptoCharge.qr_data || cryptoCharge.deposit_address)} alt="QR" style={{ width: 220, height: 220, borderRadius: 12, background: "#fff" }} data-testid="btp-crypto-qr" />
            </View>
            <View style={styles.kv}><Text style={styles.kvK}>Montant</Text><Text style={styles.kvV}>{cryptoCharge.amount} USDT</Text></View>
            <View style={styles.kv}><Text style={styles.kvK}>Réseau</Text><Text style={styles.kvV}>{cryptoCharge.network}</Text></View>
            <View style={styles.kv}><Text style={styles.kvK}>Référence</Text><Text style={styles.kvV}>{cryptoCharge.reference}</Text></View>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 8, textAlign: "center" }}>
              La confirmation est automatique — cette page se met à jour toutes les 15 secondes.
            </Text>
            {statusMsg ? (
              <View style={styles.statusBox}>
                <Text style={{ color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 }}>ℹ️ {statusMsg}</Text>
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { backgroundColor: theme.colors.primaryDark, padding: 16, paddingTop: 24 },
  backBtn: { width: 36, height: 36, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.16)", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  title: { color: "#fff", fontSize: 20, fontWeight: "800", letterSpacing: -0.4 },
  sub: { color: "#C7D9FF", fontSize: 12, marginTop: 4 },
  card: {
    backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg,
    padding: theme.spacing.lg, borderWidth: 1, borderColor: theme.colors.border,
    marginBottom: 14, ...theme.shadow.card,
  },
  cardTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 16, letterSpacing: -0.3, marginBottom: 6 },
  p: { color: theme.colors.textPrimary, fontSize: 13, marginTop: 6, lineHeight: 18 },
  choiceBtn: {
    flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: theme.radius.md,
    borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceMuted, marginTop: 8,
  },
  choiceIcon: { width: 40, height: 40, borderRadius: 22, backgroundColor: "#EFF6FF", alignItems: "center", justifyContent: "center" },
  choiceT: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 14 },
  choiceS: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  lbl: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.3, marginTop: 8, marginBottom: 4, textTransform: "uppercase" },
  pill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceMuted },
  pillActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  pillT: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "700" },
  input: {
    padding: 12, borderRadius: theme.radius.md, borderWidth: 1,
    borderColor: theme.colors.border, backgroundColor: "#fff",
    color: theme.colors.textPrimary, fontSize: 13,
  },
  primaryBtn: {
    marginTop: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.colors.primary, paddingVertical: 14, borderRadius: theme.radius.lg,
    ...theme.shadow.button,
  },
  primaryBtnT: { color: "#fff", fontWeight: "800", letterSpacing: 0.2 },
  warnBox: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 12, borderRadius: theme.radius.md, backgroundColor: theme.colors.warningBg, borderWidth: 1, borderColor: theme.colors.warning, marginBottom: 12 },
  warnT: { flex: 1, color: "#92400E", fontSize: 12, lineHeight: 17 },
  addrBox: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    padding: 12, borderRadius: theme.radius.md, backgroundColor: theme.colors.surfaceMuted,
    borderWidth: 1, borderColor: theme.colors.border, gap: 8,
  },
  addr: { flex: 1, color: theme.colors.primary, fontFamily: "monospace", fontSize: 12 },
  copyPill: {
    flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 8, backgroundColor: theme.colors.primary + "18",
  },
  qrWrap: { alignItems: "center", marginTop: 12, padding: 12, backgroundColor: "#fff", borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.border },
  kv: { flexDirection: "row", justifyContent: "space-between", marginTop: 10 },
  kvK: { color: theme.colors.textSecondary, fontSize: 12 },
  kvV: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13 },
  statusBox: {
    marginTop: 12, padding: 12, borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceMuted, borderWidth: 1, borderColor: theme.colors.border,
  },
});
