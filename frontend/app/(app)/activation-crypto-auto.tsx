import React, { useEffect, useState } from "react";
import { ActivityIndicator, Image, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { FeatureGuard } from "@/src/components/FeatureGuard";

type Charge = {
  reference: string;
  deposit_address: string;
  amount_to_send: number | string;
  coin: string;
  network: string;
  memo?: string | null;
  expires_at?: string;
};

function CryptoAutoInner() {
  const router = useRouter();
  const { user } = useAuth();
  const [charge, setCharge] = useState<Charge | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);

  const startPayment = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await api.post<Charge>("/activations/crypto-auto/create", { level: 1 });
      setCharge(r);
    } catch (e: any) {
      setErr(e?.detail || "Impossible de démarrer le paiement.");
    } finally { setLoading(false); }
  };

  const verifyPayment = async () => {
    if (!charge) return;
    const t = txHash.trim();
    if (t.length < 10) {
      setVerifyErr("Veuillez coller un hash de transaction valide.");
      return;
    }
    setVerifying(true); setVerifyErr(null); setVerifyMsg(null);
    try {
      const r = await api.post<{ ok: boolean; activated?: boolean; message?: string; status?: string }>(
        "/activations/crypto-auto/verify",
        { reference: charge.reference, tx_hash: t },
      );
      if (r.ok && r.activated) {
        setVerifyMsg(r.message || "Compte activé.");
        if (typeof window !== "undefined") window.alert("✅ " + (r.message || "Compte activé au Niveau 1 !"));
        setTimeout(() => router.replace("/(app)/dashboard" as any), 1200);
      } else {
        setVerifyMsg(r.message || "Vérification en cours…");
      }
    } catch (e: any) {
      setVerifyErr(e?.detail || "Impossible de vérifier le paiement. Réessayez.");
    } finally { setVerifying(false); }
  };

  // Poll payment status while a charge is pending — the webhook is the real
  // trigger but polling gives a nicer UX ("your account was activated!").
  useEffect(() => {
    if (!charge) return;
    setChecking(true);
    const id = setInterval(async () => {
      try {
        const me = await api.get<any>("/auth/me");
        if (me?.max_level >= 1 && me?.status === "active") {
          clearInterval(id);
          setChecking(false);
          if (typeof window !== "undefined") window.alert("✅ Paiement confirmé. Votre compte est activé au Niveau 1 !");
          router.replace("/(app)/dashboard" as any);
        }
      } catch {}
    }, 6000);
    return () => { clearInterval(id); setChecking(false); };
  }, [charge, router]);

  const copyAddr = async () => {
    if (!charge?.deposit_address) {
      if (typeof window !== "undefined") window.alert("Adresse indisponible. Veuillez relancer le paiement.");
      return;
    }
    const value = charge.deposit_address;
    try {
      if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
      } else if (Platform.OS === "web" && typeof document !== "undefined") {
        // Fallback for older browsers / non-secure contexts.
        const ta = document.createElement("textarea");
        ta.value = value; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
      }
      if (typeof window !== "undefined") window.alert("Adresse copiée dans le presse-papiers.");
    } catch {
      if (typeof window !== "undefined") window.alert("Copie impossible. Sélectionnez et copiez l'adresse manuellement.");
    }
  };

  const qrUri = charge?.deposit_address
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(charge.deposit_address)}`
    : "";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="cauto-back">
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>⚡ Activation automatique — Crypto</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {!charge ? (
          <View style={styles.card}>
            <Text style={styles.section}>Informations d'activation</Text>
            <View style={styles.kv}><Text style={styles.k}>Email</Text><Text style={styles.v}>{user?.email}</Text></View>
            <View style={styles.kv}><Text style={styles.k}>Nom d'utilisateur</Text><Text style={styles.v}>@{user?.username}</Text></View>
            <View style={styles.kv}><Text style={styles.k}>Montant</Text><Text style={[styles.v, { fontWeight: "900", color: theme.colors.primary }]}>5 USDT 🔒</Text></View>
            <View style={styles.kv}><Text style={styles.k}>Cryptomonnaie</Text><Text style={styles.v}>USDT BEP20 🔒</Text></View>
            <Text style={styles.hint}>Le montant et le réseau sont verrouillés. Après clic sur « Payer maintenant », vous recevrez l'adresse de dépôt et un QR code.</Text>

            {err ? <Text style={styles.err}>{err}</Text> : null}
            <TouchableOpacity style={styles.payBtn} onPress={startPayment} disabled={loading} testID="cauto-pay">
              {loading ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Ionicons name="flash" size={18} color="#fff" />
                  <Text style={styles.payTxt}>Payer maintenant</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.section}>Envoyez exactement {String(charge.amount_to_send)} USDT (BEP20)</Text>
            <Text style={styles.hint}>Utilisez UNIQUEMENT le réseau BEP20 (Binance Smart Chain). Tout autre réseau entraînera une perte.</Text>

            <View style={{ alignItems: "center", marginVertical: 12 }}>
              {Platform.OS === "web" && qrUri ? (
                <Image source={{ uri: qrUri }} style={{ width: 240, height: 240, backgroundColor: "#fff" }} testID="cauto-qr" />
              ) : (
                <View style={{ width: 240, height: 240, backgroundColor: "#F1F5F9", alignItems: "center", justifyContent: "center", borderRadius: 8 }}>
                  <Ionicons name="qr-code" size={64} color={theme.colors.primary} />
                  <Text style={{ marginTop: 8, fontSize: 12, color: theme.colors.textSecondary }}>Adresse ci-dessous</Text>
                </View>
              )}
            </View>

            <View style={styles.addrBox}>
              <Text style={styles.addrLabel}>Adresse USDT BEP20</Text>
              <Text style={styles.addrValue} selectable testID="cauto-address">
                {charge.deposit_address}
              </Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                <TouchableOpacity
                  style={styles.copyBtn}
                  onPress={copyAddr}
                  testID="cauto-copy"
                >
                  <Ionicons name="copy" size={14} color="#fff" />
                  <Text style={styles.copyTxt}>Copier l'adresse</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.kv}><Text style={styles.k}>Montant à envoyer</Text><Text style={[styles.v, { fontWeight: "900", color: theme.colors.primary }]}>{String(charge.amount_to_send)} USDT</Text></View>
            <View style={styles.kv}><Text style={styles.k}>Réseau</Text><Text style={styles.v}>{charge.network}</Text></View>
            <View style={styles.kv}><Text style={styles.k}>Référence</Text><Text style={styles.v} selectable testID="cauto-reference">{charge.reference}</Text></View>

            <View style={styles.waitBox}>
              {checking ? <ActivityIndicator size="small" color={theme.colors.primary} /> : null}
              <Text style={styles.waitTxt} testID="cauto-status">
                {checking ? " En attente de la confirmation du paiement…" : "Envoi confirmé — patientez"}
              </Text>
            </View>

            {/* ── Section « Hash de transaction » — vérification manuelle ── */}
            <View style={styles.hashBox}>
              <Text style={styles.section}>Hash de transaction (Tx Hash)</Text>
              <Text style={styles.hint}>
                Après avoir envoyé les {String(charge.amount_to_send)} USDT depuis votre portefeuille,
                collez ci-dessous le hash de transaction pour vérifier et activer votre compte
                immédiatement.
              </Text>
              <TextInput
                style={styles.hashInput}
                placeholder="0x…"
                placeholderTextColor={theme.colors.textSecondary}
                value={txHash}
                onChangeText={setTxHash}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!verifying}
                testID="cauto-tx-hash"
              />
              {verifyErr ? <Text style={styles.err} testID="cauto-verify-error">{verifyErr}</Text> : null}
              {verifyMsg ? <Text style={styles.okMsg} testID="cauto-verify-msg">{verifyMsg}</Text> : null}
              <TouchableOpacity
                style={[styles.payBtn, { backgroundColor: theme.colors.success, opacity: verifying ? 0.6 : 1 }]}
                onPress={verifyPayment}
                disabled={verifying}
                testID="cauto-verify"
              >
                {verifying ? <ActivityIndicator color="#fff" /> : <Ionicons name="checkmark-circle" size={18} color="#fff" />}
                <Text style={styles.payTxt}>{verifying ? "Vérification…" : "Vérifier le paiement"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, backgroundColor: theme.colors.primary },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  title: { color: "#fff", fontWeight: "900", fontSize: 16 },
  card: { backgroundColor: theme.colors.surface, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border },
  section: { fontSize: 15, fontWeight: "900", color: theme.colors.textPrimary, marginBottom: 8 },
  kv: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderTopWidth: 1, borderColor: theme.colors.border },
  k: { fontSize: 12, color: theme.colors.textSecondary, fontWeight: "600" },
  v: { fontSize: 13, color: theme.colors.textPrimary, fontWeight: "700" },
  hint: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 8, lineHeight: 18 },
  err: { color: theme.colors.danger, marginTop: 8, fontWeight: "600" },
  payBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#7B61FF", padding: 14, borderRadius: 12, marginTop: 12 },
  payTxt: { color: "#fff", fontWeight: "900" },
  addrBox: { backgroundColor: theme.colors.background, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 8 },
  addrLabel: { fontSize: 11, color: theme.colors.textSecondary, fontWeight: "700", marginBottom: 4 },
  addrValue: { fontSize: 12, color: theme.colors.textPrimary, fontFamily: Platform.select({ web: "monospace", default: undefined }) },
  copyBtn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: theme.colors.success, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  copyTxt: { color: "#fff", fontWeight: "800", fontSize: 11 },
  waitBox: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12, padding: 10, backgroundColor: "#EFEAFF", borderRadius: 8 },
  hashBox: { marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderColor: theme.colors.border },
  hashInput: {
    marginTop: 8, padding: 12, borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: 10, color: theme.colors.textPrimary, backgroundColor: theme.colors.background,
    fontSize: 13, fontFamily: Platform.select({ web: "monospace", default: undefined }),
  },
  okMsg: { color: theme.colors.success, marginTop: 8, fontWeight: "700" },
  waitTxt: { color: "#7B61FF", fontSize: 12, fontWeight: "700" },
});

export default function CryptoAutoActivation() {
  return (
    <FeatureGuard featureKey="crypto_auto" title="Activation automatique (Crypto) désactivée">
      <CryptoAutoInner />
    </FeatureGuard>
  );
}
