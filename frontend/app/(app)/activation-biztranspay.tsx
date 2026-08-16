/**
 * BizTransPay auto-activation screen — USDT.BEP20, 5 USDT fixed.
 *
 * Flow:
 *   1. User lands here after signup or from the activation list.
 *   2. Click "Activer mon compte" → POST /payments/biztranspay/activation/initiate
 *      returns { reference, deposit_address, amount_to_send, network, payment_url }.
 *   3. UI shows: deposit address (Copier), local QR (api.qrserver.com), amount, network warning.
 *   4. Server polls BizTransPay on every /status hit — the client polls that endpoint every 15s.
 *   5. On confirmation, backend credits + fires an FCM push; screen shows a success card
 *      and redirects to /dashboard after 1.5s.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Platform, SafeAreaView, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View, Linking,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type Charge = {
  reference: string;
  provider_intent_id?: string | null;
  deposit_address?: string | null;
  amount_to_send?: number | string;
  coin?: string;
  network?: string;
  payment_url?: string | null;
  expires_at?: string;
};

const QR = (addr: string) =>
  `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(addr)}`;

const copy = (t: string) => {
  if (typeof navigator !== "undefined" && (navigator as any).clipboard) {
    (navigator as any).clipboard.writeText(t);
    if (typeof window !== "undefined") window.alert(`✅ Copié : ${t}`);
  }
};

export default function BizTransPayActivation() {
  const router = useRouter();
  const [charge, setCharge] = useState<Charge | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [txHash, setTxHash] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const pollTimer = useRef<any>(null);

  const startPayment = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await api.post<Charge>("/payments/biztranspay/activation/initiate", { level: 1 });
      setCharge(r);
    } catch (e: any) {
      setErr(e?.detail || "Impossible de démarrer le paiement.");
    } finally { setLoading(false); }
  };

  // Auto-poll status every 15s once a charge exists — server-side check.
  // ALSO refreshes the deposit_address if it arrived late (async wallet gen).
  useEffect(() => {
    if (!charge?.reference || done) return;
    const tick = async () => {
      try {
        const r = await api.get<any>(`/payments/biztranspay/activation/status/${charge.reference}`);
        // Fill in the address the moment the gateway generates it.
        if (r?.deposit_address && !charge.deposit_address) {
          setCharge((c) => c ? { ...c, deposit_address: r.deposit_address, amount_to_send: r.amount_to_send ?? c.amount_to_send, network: r.network ?? c.network } : c);
        }
        if (r?.activated) {
          setDone(true);
          setStatusMsg(r.message || "Compte activé.");
          if (typeof window !== "undefined")
            window.alert("🎉 Paiement confirmé — votre compte SPILOVEURE est maintenant activé !");
          setTimeout(() => router.replace("/(app)/dashboard" as any), 1500);
          return;
        }
        if (r?.status && r.status !== "pending") setStatusMsg(r.message || "Vérification en cours…");
      } catch { /* keep polling */ }
    };
    tick();
    pollTimer.current = setInterval(tick, 15_000);
    return () => clearInterval(pollTimer.current);
  }, [charge?.reference, done, router]);

  const verifyPayment = async () => {
    if (!charge) return;
    setVerifying(true); setStatusMsg("⏳ Vérification en cours…");
    try {
      const r = await api.post<any>("/payments/biztranspay/activation/verify", {
        reference: charge.reference,
        tx_hash: txHash.trim() || undefined,
      });
      if (r?.activated) {
        setDone(true);
        setStatusMsg(r.message || "Compte activé.");
        if (typeof window !== "undefined")
          window.alert("🎉 Paiement confirmé — votre compte SPILOVEURE est maintenant activé !");
        setTimeout(() => router.replace("/(app)/dashboard" as any), 1500);
      } else {
        setStatusMsg(r?.message || "Paiement pas encore confirmé. Le système continuera de vérifier automatiquement.");
      }
    } catch (e: any) {
      setStatusMsg(e?.detail || "Vérification impossible pour l'instant.");
    } finally { setVerifying(false); }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>💎 Auto-activation Crypto</Text>
        <Text style={styles.sub}>USDT — Réseau BEP20 — via BizTransPay</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {!charge ? (
          <View style={styles.card}>
            <View style={styles.headRow}>
              <View style={styles.iconBox}><Ionicons name="logo-bitcoin" size={22} color="#F59E0B" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>Activation par crypto (5 USDT)</Text>
                <Text style={styles.cardSub}>Réseau : BEP20 · Devise : USDT · Statut : En attente d'activation</Text>
              </View>
            </View>
            <Text style={styles.p}>
              Cliquez ci-dessous pour générer votre adresse de paiement dédiée. Le montant est fixe :
              <Text style={{ fontWeight: "800" }}> 5 USDT</Text>. Toute autre valeur sera rejetée.
            </Text>
            {err ? <Text style={styles.err} testID="btp-init-error">❌ {err}</Text> : null}
            <TouchableOpacity
              style={[styles.primaryBtn, loading && { opacity: 0.5 }]}
              onPress={startPayment}
              disabled={loading}
              testID="btp-start"
            >
              {loading
                ? <ActivityIndicator color="#fff" />
                : <><Ionicons name="rocket" size={16} color="#fff" /><Text style={styles.primaryBtnT}>Activer mon compte</Text></>}
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>💳 Envoyez le paiement</Text>
              <View style={styles.warnBox}>
                <Ionicons name="warning" size={16} color="#92400E" />
                <Text style={styles.warnT}>
                  Envoyez exactement <Text style={{ fontWeight: "800" }}>5 USDT</Text> sur le réseau <Text style={{ fontWeight: "800" }}>BEP20 uniquement</Text>. Tout autre réseau entraînera une perte de fonds.
                </Text>
              </View>

              {charge.deposit_address ? (
                <>
                  <Text style={styles.lbl}>Adresse de dépôt</Text>
                  <TouchableOpacity style={styles.addrBox} onPress={() => copy(charge.deposit_address!)} testID="btp-copy-address">
                    <Text style={styles.addr} numberOfLines={2}>{charge.deposit_address}</Text>
                    <View style={styles.copyPill}>
                      <Ionicons name="copy-outline" size={13} color={theme.colors.primary} />
                      <Text style={{ color: theme.colors.primary, fontSize: 10, fontWeight: "800", letterSpacing: 0.3 }}>COPIER</Text>
                    </View>
                  </TouchableOpacity>
                  <View style={styles.qrWrap}>
                    {/* @ts-ignore RN Web accepts <img> */}
                    <img
                      src={QR(charge.deposit_address!)}
                      alt="QR Code de paiement"
                      style={{ width: 220, height: 220, borderRadius: 12, background: "#fff" }}
                      data-testid="btp-qr"
                    />
                  </View>
                </>
              ) : (
                <View style={{ padding: 16, borderRadius: theme.radius.md, backgroundColor: theme.colors.warningBg, borderWidth: 1, borderColor: theme.colors.warning, alignItems: "center", gap: 8 }} testID="btp-address-loading">
                  <ActivityIndicator color={theme.colors.warning} />
                  <Text style={{ color: "#92400E", fontSize: 13, fontWeight: "700", textAlign: "center" }}>
                    Génération de votre adresse de dépôt…
                  </Text>
                  <Text style={{ color: "#78350F", fontSize: 11, textAlign: "center" }}>
                    Le système attend la réponse de BizTransPay. Cette page se met à jour automatiquement toutes les 15 secondes.
                  </Text>
                </View>
              )}

              <View style={styles.kv}>
                <Text style={styles.kvK}>Montant à envoyer</Text>
                <Text style={styles.kvV}>{Number(charge.amount_to_send ?? 5)} {charge.coin || "USDT"}</Text>
              </View>
              <View style={styles.kv}>
                <Text style={styles.kvK}>Réseau</Text>
                <Text style={styles.kvV}>{charge.network || "BEP20"}</Text>
              </View>
              <View style={styles.kv}>
                <Text style={styles.kvK}>Référence</Text>
                <Text style={styles.kvV}>{charge.reference}</Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>🔍 Vérifier le paiement</Text>
              <Text style={styles.p}>
                Après avoir envoyé les fonds, collez ici le <Text style={{ fontWeight: "800" }}>hash de transaction</Text> (facultatif). Le système vérifie aussi automatiquement toutes les 15 secondes.
              </Text>
              <TextInput
                style={styles.input}
                value={txHash}
                onChangeText={setTxHash}
                placeholder="Collez ici votre hash de transaction"
                placeholderTextColor={theme.colors.textSecondary}
                editable={!done}
                testID="btp-tx-hash"
              />
              <TouchableOpacity
                style={[styles.primaryBtn, (verifying || done) && { opacity: 0.5 }]}
                onPress={verifyPayment}
                disabled={verifying || done}
                testID="btp-verify"
              >
                {verifying
                  ? <ActivityIndicator color="#fff" />
                  : <><Ionicons name="shield-checkmark" size={16} color="#fff" /><Text style={styles.primaryBtnT}>Vérifier le paiement</Text></>}
              </TouchableOpacity>
              {statusMsg ? (
                <View style={[styles.statusBox, done && { backgroundColor: theme.colors.successBg, borderColor: theme.colors.success }]}>
                  <Text style={{ color: done ? theme.colors.success : theme.colors.textPrimary, fontWeight: "700", fontSize: 12 }}>
                    {done ? "🎉 " : "ℹ️ "}{statusMsg}
                  </Text>
                </View>
              ) : null}
            </View>
          </>
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
  headRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  iconBox: { width: 40, height: 40, borderRadius: 22, backgroundColor: "#FEF3C7", alignItems: "center", justifyContent: "center" },
  cardTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 16, letterSpacing: -0.3 },
  cardSub: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  p: { color: theme.colors.textPrimary, fontSize: 13, marginTop: 6, lineHeight: 18 },
  err: { color: theme.colors.danger, fontSize: 12, marginTop: 6 },
  primaryBtn: {
    marginTop: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.colors.primary, paddingVertical: 14, borderRadius: theme.radius.lg,
    ...theme.shadow.button,
  },
  primaryBtnT: { color: "#fff", fontWeight: "800", letterSpacing: 0.2 },
  warnBox: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 12, borderRadius: theme.radius.md, backgroundColor: theme.colors.warningBg, borderWidth: 1, borderColor: theme.colors.warning, marginBottom: 12 },
  warnT: { flex: 1, color: "#92400E", fontSize: 12, lineHeight: 17 },
  lbl: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.3, marginTop: 6, marginBottom: 4, textTransform: "uppercase" },
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
  input: {
    marginTop: 12, padding: 12, borderRadius: theme.radius.md, borderWidth: 1,
    borderColor: theme.colors.border, backgroundColor: "#fff",
    color: theme.colors.textPrimary, fontSize: 13,
  },
  statusBox: {
    marginTop: 12, padding: 12, borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceMuted, borderWidth: 1, borderColor: theme.colors.border,
  },
});
