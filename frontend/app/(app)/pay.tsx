/**
 * pay.tsx — Simplified activation flow (list/selector).
 *
 * Guided flow: Mode → Country → Operator → Phone → Activate.
 * The user NEVER sees the underlying gateway name. The server decides
 * (SoleasPay / Ashtec / BizTransPay) via /api/payments/activate.
 *
 * Data source: GET /api/payments/catalog returns the unified catalog
 * (methods → available countries → available operators), pre-filtered
 * to what the current admin config actually supports.
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
import ActivationVideoList from "@/src/components/ActivationVideoList";

const FLAGS: Record<string, string> = {
  TG: "🇹🇬", BJ: "🇧🇯", BF: "🇧🇫", CI: "🇨🇮", ML: "🇲🇱",
  SN: "🇸🇳", NE: "🇳🇪", CM: "🇨🇲", GA: "🇬🇦", CD: "🇨🇩",
  CG: "🇨🇬", TD: "🇹🇩", CF: "🇨🇫",
};
const NAMES: Record<string, string> = {
  TG: "Togo", BJ: "Bénin", BF: "Burkina Faso", CI: "Côte d'Ivoire",
  ML: "Mali", SN: "Sénégal", NE: "Niger", CM: "Cameroun", GA: "Gabon",
  CD: "RD Congo", CG: "Congo Brazzaville", TD: "Tchad", CF: "Centrafrique",
};

type MethodRow = {
  code: "mobile" | "crypto";
  label: string;
  available: boolean;
  countries?: { code: string; operators: { code: string; label: string; currency: string }[] }[];
  info?: { amount_usdt?: number; network?: string };
};

export default function Pay() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [catalog, setCatalog] = useState<{ methods: MethodRow[] } | null>(null);
  const [method, setMethod] = useState<"mobile" | "crypto" | "">("");
  const [country, setCountry] = useState<string>("");
  const [operator, setOperator] = useState<string>("");
  const [phone, setPhone] = useState<string>("");
  const [pwd, setPwd] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "pending" | "success" | "failed">("idle");
  const [cryptoAddr, setCryptoAddr] = useState<{ address?: string; qr?: string; amount?: number; asset?: string; network?: string } | null>(null);
  const [txHash, setTxHash] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try { setCatalog(await api.get<any>("/payments/catalog")); }
      catch (e: any) { setErr(e?.detail || "Impossible de charger les moyens de paiement."); }
    })();
  }, []);

  const selectedMethod = useMemo(
    () => catalog?.methods.find((m) => m.code === method) || null,
    [catalog, method],
  );
  const countries = selectedMethod?.countries || [];
  const operators = useMemo(() => {
    if (!selectedMethod || method !== "mobile") return [];
    const c = countries.find((x) => x.code === country);
    return c ? c.operators : [];
  }, [selectedMethod, method, country, countries]);

  const activate = async () => {
    setErr(null); setLoading(true);
    try {
      // 1) Exchange typed password for a short-lived pwd_confirm JWT.
      const cx = await api.post<{ confirm_token: string }>(
        "/auth/confirm-password", { password: pwd },
      );
      const confirmToken = cx.confirm_token;
      if (!confirmToken) throw new Error("Confirmation impossible.");
      // 2) Then call /payments/activate with the JWT.
      const body: any = { method };
      if (method === "mobile") {
        body.country = country; body.operator = operator; body.phone = phone;
      }
      const r = await api.post<any>("/payments/activate", body, {
        headers: { "X-Password-Confirm": confirmToken },
      });
      setRef(r.reference);
      if (r.method === "crypto") {
        setCryptoAddr({
          address: r.deposit_address, qr: r.qr_data,
          amount: r.amount, asset: r.asset_code, network: r.network,
        });
      }
      setPhase("pending"); setStep(5);
    } catch (e: any) {
      const msg = e?.detail || e?.message || "Erreur lors du lancement du paiement.";
      setErr(msg.includes("Token de confirmation") ? "Mot de passe incorrect." : msg);
    } finally { setLoading(false); }
  };

  // Poll status while pending
  useEffect(() => {
    if (phase !== "pending" || !ref) return;
    let missed = 0;
    const t = setInterval(async () => {
      try {
        const r = await api.get<any>(`/payments/${ref}/status`);
        missed = 0;
        const s = String(r.status || "").toLowerCase();
        if (["paid", "success", "validated", "completed"].includes(s) || r.activation_done === true) {
          setPhase("success"); try { await refresh?.(); } catch {}
          // Hard reload to /dashboard so the auth guard sees max_level=1 fresh
          // (avoids the race where router.replace fires before state updates
          // and _layout.tsx bounces back to /pay).
          setTimeout(() => {
            if (typeof window !== "undefined") {
              window.location.href = "/dashboard";
            } else {
              router.replace("/(app)/dashboard" as any);
            }
          }, 1500);
        } else if (["failed", "rejected", "cancelled", "canceled", "expired"].includes(s)) {
          setPhase("failed");
        }
      } catch {
        missed += 1;
        if (missed >= 6) {
          setErr("Impossible de vérifier le paiement. Actualisez la page.");
        }
      }
    }, 3000);
    return () => clearInterval(t);
  }, [phase, ref, refresh, router]);

  const canGoStep2 = !!method && !!selectedMethod?.available;
  const canGoStep3 = method === "crypto" || !!country;
  const canGoStep4 = method === "crypto" || !!operator;
  const canActivate = pwd.length >= 4 && (
    method === "crypto" ||
    (!!operator && phone.replace(/\s/g, "").length >= 6)
  );

  const stepCount = method === "crypto" ? 2 : 5;
  const clampedStep = Math.min(step, stepCount);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => (step > 1 && phase !== "success" ? setStep((step - 1) as any) : router.back())}
          style={styles.iconBtn} testID="pay-back"
        >
          <Ionicons name="chevron-back" size={22} color={theme.colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Activer mon compte</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={styles.progressRow}>
        {Array.from({ length: stepCount }, (_, i) => i + 1).map((n) => (
          <View key={n} style={[styles.progressPill, clampedStep >= n && styles.progressPillActive]} />
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 140 }}>
        {!catalog && !err && (
          <View style={{ padding: 40, alignItems: "center" }}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        )}

        {/* ── STEP 1 — Method ─────────────────────────────────────────── */}
        {step === 1 && catalog && (
          <View testID="pay-step-method">
            <Text style={styles.sTitle}>Sélectionner le mode de paiement</Text>
            <Text style={styles.sSub}>Choisissez comment vous voulez activer votre compte.</Text>
            {catalog.methods.map((m) => (
              <TouchableOpacity
                key={m.code}
                disabled={!m.available}
                onPress={() => { if (m.available) { setMethod(m.code); setCountry(""); setOperator(""); } }}
                style={[styles.row, method === m.code && styles.rowActive, !m.available && styles.rowDisabled]}
                testID={`pay-method-${m.code}`}
              >
                <View style={styles.rowIcon}>
                  <Ionicons
                    name={m.code === "mobile" ? "phone-portrait" : "logo-bitcoin"}
                    size={20}
                    color={m.available ? theme.colors.primary : theme.colors.textSecondary}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowT, !m.available && { color: theme.colors.textSecondary }]}>
                    {m.code === "mobile" ? "📱 Paiement Mobile" : "₿ Crypto"}
                  </Text>
                  {!m.available && (
                    <Text style={styles.rowSub}>Non disponible actuellement.</Text>
                  )}
                </View>
                {method === m.code && (
                  <Ionicons name="checkmark-circle" size={22} color={theme.colors.primary} />
                )}
              </TouchableOpacity>
            ))}
            {catalog.methods.every((m) => !m.available) && (
              <Text style={styles.warn}>⚠ Aucun mode de paiement n'est actuellement disponible. Contactez le support.</Text>
            )}
          </View>
        )}

        {/* ── STEP 2 — Country ────────────────────────────────────────── */}
        {step === 2 && method === "mobile" && (
          <View testID="pay-step-country">
            <Text style={styles.sTitle}>Sélectionner votre pays</Text>
            <Text style={styles.sSub}>Seuls les pays où le paiement mobile est disponible sont affichés.</Text>
            {countries.map((c) => (
              <TouchableOpacity
                key={c.code}
                style={[styles.row, country === c.code && styles.rowActive]}
                onPress={() => { setCountry(c.code); setOperator(""); }}
                testID={`pay-country-${c.code}`}
              >
                <Text style={{ fontSize: 24 }}>{FLAGS[c.code] || "🌍"}</Text>
                <Text style={[styles.rowT, { marginLeft: 12, flex: 1 }]}>
                  {NAMES[c.code] || c.code}
                </Text>
                {country === c.code && (
                  <Ionicons name="checkmark-circle" size={22} color={theme.colors.primary} />
                )}
              </TouchableOpacity>
            ))}
            {countries.length === 0 && (
              <Text style={styles.warn}>⚠ Aucun pays n'est disponible pour ce mode.</Text>
            )}
          </View>
        )}

        {/* ── STEP 3 — Operator ───────────────────────────────────────── */}
        {step === 3 && method === "mobile" && (
          <View testID="pay-step-operator">
            <Text style={styles.sTitle}>Sélectionner votre opérateur</Text>
            <Text style={styles.sSub}>Choisissez votre opérateur Mobile Money.</Text>
            {operators.map((op) => (
              <TouchableOpacity
                key={op.code}
                style={[styles.row, operator === op.code && styles.rowActive]}
                onPress={() => setOperator(op.code)}
                testID={`pay-operator-${op.code}`}
              >
                <View style={styles.rowIcon}>
                  <Ionicons name="cellular" size={18} color={theme.colors.primary} />
                </View>
                <Text style={[styles.rowT, { flex: 1 }]}>{op.label}</Text>
                {operator === op.code && (
                  <Ionicons name="checkmark-circle" size={22} color={theme.colors.primary} />
                )}
              </TouchableOpacity>
            ))}
            {operators.length === 0 && (
              <Text style={styles.warn}>⚠ Aucun opérateur disponible pour ce pays.</Text>
            )}
          </View>
        )}

        {/* ── STEP 4 — Phone + Password ───────────────────────────────── */}
        {step === 4 && method === "mobile" && (
          <View testID="pay-step-phone">
            <Text style={styles.sTitle}>Votre numéro Mobile Money</Text>
            <Text style={styles.sSub}>Vous recevrez une demande de paiement à ce numéro.</Text>
            <Text style={styles.label}>Numéro de téléphone</Text>
            <TextInput
              style={styles.input}
              value={phone} onChangeText={setPhone}
              placeholder="ex : 90 00 00 00"
              keyboardType="phone-pad"
              placeholderTextColor={theme.colors.textSecondary}
              testID="pay-phone"
            />
            <Text style={[styles.label, { marginTop: 14 }]}>Mot de passe (confirmation)</Text>
            <TextInput
              style={styles.input}
              value={pwd} onChangeText={setPwd}
              placeholder="Votre mot de passe"
              secureTextEntry
              placeholderTextColor={theme.colors.textSecondary}
              testID="pay-password"
            />
            <Text style={styles.hint}>
              Résumé : {NAMES[country] || country} · {operators.find((o) => o.code === operator)?.label || operator}
            </Text>
          </View>
        )}

        {/* Crypto: single confirmation step */}
        {step === 2 && method === "crypto" && (
          <View testID="pay-step-crypto-confirm">
            <Text style={styles.sTitle}>Confirmer l'activation Crypto</Text>
            <Text style={styles.sSub}>
              Cliquez sur "Activer mon compte" pour obtenir l'adresse de dépôt.
            </Text>
            {selectedMethod?.info && (selectedMethod.info as any).keys_configured === false && (
              <Text style={styles.warn}>
                ⚠ La cryptomonnaie est activée mais les clés API du fournisseur n'ont pas encore été renseignées côté administrateur. Contactez le support si l'activation échoue.
              </Text>
            )}
            {selectedMethod?.info && (
              <View style={{ padding: 10, backgroundColor: theme.colors.surface, borderRadius: 10, marginTop: 8 }}>
                <Text style={styles.rowT}>
                  Montant : {(selectedMethod.info as any).amount_usdt || 5} USDT
                </Text>
                {(selectedMethod.info as any).network && (
                  <Text style={styles.rowSub}>
                    Réseau : {(selectedMethod.info as any).network}
                  </Text>
                )}
              </View>
            )}
            <Text style={[styles.label, { marginTop: 14 }]}>Mot de passe (confirmation)</Text>
            <TextInput
              style={styles.input}
              value={pwd} onChangeText={setPwd}
              placeholder="Votre mot de passe"
              secureTextEntry
              placeholderTextColor={theme.colors.textSecondary}
              testID="pay-password"
            />
          </View>
        )}

        {/* ── STEP 5 (or 3 crypto) — Result / Verify ────────────────── */}
        {step === 5 && (
          <View testID="pay-step-result" style={{ gap: 12 }}>
            <Text style={styles.sTitle}>
              {phase === "success" ? "✅ Compte activé" :
               phase === "failed" ? "❌ Paiement échoué" :
               "⏳ Paiement en cours"}
            </Text>
            {phase === "pending" && (
              <>
                <ActivityIndicator size="large" color={theme.colors.primary} />
                {method === "mobile" && (
                  <Text style={styles.sSub}>
                    Une demande de paiement a été envoyée sur votre téléphone.
                    Confirmez-la pour activer votre compte Niveau 1.
                  </Text>
                )}
                {method === "crypto" && cryptoAddr?.address && (
                  <View style={styles.cryptoBox}>
                    <Text style={styles.rowT}>
                      Envoyer {cryptoAddr.amount} {cryptoAddr.asset || "USDT"} ({cryptoAddr.network || "BEP20"}) à :
                    </Text>
                    <Text selectable style={styles.addr}>{cryptoAddr.address}</Text>
                    <TouchableOpacity
                      onPress={async () => {
                        try {
                          if (typeof navigator !== "undefined" && (navigator as any).clipboard) {
                            await (navigator as any).clipboard.writeText(cryptoAddr.address!);
                            if (typeof window !== "undefined") window.alert("✅ Adresse copiée dans le presse-papiers");
                          }
                        } catch { if (typeof window !== "undefined") window.alert("Sélectionnez l'adresse et copiez manuellement."); }
                      }}
                      style={{ marginTop: 10, padding: 12, borderRadius: 10, backgroundColor: theme.colors.primary, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 }}
                      testID="pay-copy-address"
                    >
                      <Ionicons name="copy-outline" size={16} color="#fff" />
                      <Text style={{ color: "#fff", fontWeight: "800" }}>📋 Copier l'adresse</Text>
                    </TouchableOpacity>
                    {cryptoAddr.qr && (
                      <Image
                        source={{ uri: `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(cryptoAddr.qr)}` }}
                        style={{ width: 200, height: 200, alignSelf: "center", marginTop: 12 }}
                      />
                    )}
                    <View style={{ marginTop: 16, padding: 12, borderRadius: 10, backgroundColor: theme.colors.surfaceMuted, borderWidth: 1, borderColor: theme.colors.border }}>
                      <Text style={[styles.label, { marginBottom: 6 }]}>🧾 ID / Hash de transaction</Text>
                      <TextInput
                        style={styles.input}
                        value={txHash}
                        onChangeText={setTxHash}
                        placeholder="Collez ici l'ID ou le hash de votre transaction"
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                        testID="pay-tx-hash"
                      />
                      {verifyMsg && (
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 6 }}>ℹ {verifyMsg}</Text>
                      )}
                      {verifyErr && (
                        <Text style={{ color: theme.colors.danger, fontSize: 12, marginTop: 6, fontWeight: "700" }}>❌ {verifyErr}</Text>
                      )}
                      <TouchableOpacity
                        onPress={async () => {
                          const t = txHash.trim();
                          if (t.length < 10) { setVerifyErr("Veuillez coller un hash valide."); return; }
                          setVerifying(true); setVerifyErr(null); setVerifyMsg(null);
                          try {
                            const r = await api.post<{ ok: boolean; activated?: boolean; message?: string }>(
                              "/activations/crypto-auto/verify",
                              { reference: ref, tx_hash: t },
                            );
                            if (r.ok && r.activated) {
                              setPhase("success"); setVerifyMsg(r.message || "Compte activé.");
                              if (typeof window !== "undefined") {
                                try {
                                  window.localStorage.setItem("just_activated", JSON.stringify({
                                    ts: Date.now(), reference: ref, level: 1,
                                  }));
                                } catch {}
                              }
                              await refresh?.();
                              setTimeout(() => {
                                if (typeof window !== "undefined") {
                                  window.location.href = "/dashboard";
                                } else {
                                  router.replace("/(app)/dashboard" as any);
                                }
                              }, 1500);
                            } else {
                              setVerifyMsg(r.message || "Vérification en cours…");
                            }
                          } catch (e: any) {
                            setVerifyErr(e?.detail || "Impossible de vérifier. Réessayez.");
                          } finally { setVerifying(false); }
                        }}
                        disabled={verifying || txHash.trim().length < 10}
                        style={{ marginTop: 10, padding: 14, borderRadius: 12, backgroundColor: (verifying || txHash.trim().length < 10) ? "#9CA3AF" : "#10B981", alignItems: "center" }}
                        testID="pay-verify-tx"
                      >
                        <Text style={{ color: "#fff", fontWeight: "900", fontSize: 14 }}>
                          {verifying ? "⏳ Vérification…" : "✅ Vérifier le paiement"}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </>
            )}
            {phase === "success" && (
              <Text style={styles.sSub}>🎉 Votre Niveau 1 est activé. Redirection vers votre tableau de bord…</Text>
            )}
            {phase === "failed" && (
              <TouchableOpacity
                onPress={() => { setPhase("idle"); setStep(1); setRef(null); setPwd(""); }}
                style={styles.retryBtn} testID="pay-retry"
              >
                <Text style={styles.retryT}>Réessayer</Text>
              </TouchableOpacity>
            )}
            {ref && <Text style={styles.refT}>Référence : {ref}</Text>}
          </View>
        )}

        {err && <Text style={styles.err}>❌ {err}</Text>}

        {/* v27f (2026-02-14) — admin-managed activation guide videos */}
        <ActivationVideoList />
      </ScrollView>

      {step < 5 && (
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.cta, ((step === 1 && !canGoStep2)
                                 || (step === 2 && method === "mobile" && !canGoStep3)
                                 || (step === 3 && !canGoStep4)
                                 || (step === 4 && !canActivate)
                                 || (step === 2 && method === "crypto" && !canActivate)
                                 || loading) && { opacity: 0.4 }]}
            disabled={loading
              || (step === 1 && !canGoStep2)
              || (step === 2 && method === "mobile" && !canGoStep3)
              || (step === 3 && !canGoStep4)
              || (step === 4 && !canActivate)
              || (step === 2 && method === "crypto" && !canActivate)}
            onPress={() => {
              if (step === 1) {
                if (method === "crypto") { /* stay on step 2 = confirm */ setStep(2); }
                else setStep(2);
              }
              else if (step === 2) {
                if (method === "crypto") activate();
                else setStep(3);
              }
              else if (step === 3) setStep(4);
              else if (step === 4) activate();
            }}
            testID="pay-next"
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.ctaT}>
                  {(step === 4 && method === "mobile") || (step === 2 && method === "crypto")
                    ? "ACTIVER MON COMPTE"
                    : "Continuer"}
                </Text>}
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
  sSub: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, marginBottom: 14 },
  warn: { color: "#B45309", fontWeight: "700", fontSize: 12, padding: 10, backgroundColor: "#FEF3C7", borderRadius: 8, marginTop: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 8 },
  rowActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary + "12" },
  rowDisabled: { opacity: 0.55 },
  rowIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.colors.primary + "18", alignItems: "center", justifyContent: "center" },
  rowT: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 14 },
  rowSub: { color: theme.colors.textSecondary, fontSize: 11.5, marginTop: 2 },
  label: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12, marginBottom: 6 },
  hint: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 14, fontStyle: "italic" },
  input: { padding: 12, borderRadius: 10, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, color: theme.colors.textPrimary, fontSize: 15 },
  footer: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 14, backgroundColor: theme.colors.surface, borderTopWidth: 1, borderTopColor: theme.colors.border },
  cta: { padding: 16, borderRadius: 14, backgroundColor: theme.colors.primary, alignItems: "center" },
  ctaT: { color: "#fff", fontWeight: "900", fontSize: 15 },
  err: { color: theme.colors.danger, fontWeight: "700", fontSize: 13, marginTop: 12, padding: 12, backgroundColor: "#FEE2E2", borderRadius: 8 },
  cryptoBox: { padding: 14, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, gap: 8 },
  addr: { fontFamily: "monospace", fontSize: 12, padding: 10, backgroundColor: theme.colors.surfaceMuted, borderRadius: 8, color: theme.colors.textPrimary },
  refT: { color: theme.colors.textSecondary, fontSize: 11, textAlign: "center", marginTop: 6 },
  retryBtn: { padding: 14, borderRadius: 12, backgroundColor: theme.colors.primary, alignItems: "center", marginTop: 8 },
  retryT: { color: "#fff", fontWeight: "800" },
});
