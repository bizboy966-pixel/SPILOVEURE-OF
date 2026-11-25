import React, { useCallback, useState } from "react";
import { Alert, FlatList, ScrollView, StyleSheet, Text, View, TouchableOpacity, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { Input } from "@/src/components/Input";
import { Button } from "@/src/components/Button";
import { PasswordConfirmModal } from "@/src/components/PasswordConfirmModal";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { formatFCFA, formatDateTime } from "@/src/utils/format";
import { useI18n } from "@/src/i18n";

export default function Withdrawal() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const { t, lang } = useI18n();
  const [wallet, setWallet] = useState<any>(null);
  const [selectedMethod, setSelectedMethod] = useState<"mobile" | "crypto">("mobile");
  const [cryptoWithdrawalBalance, setCryptoWithdrawalBalance] = useState(0);
  const [amount, setAmount] = useState("");
  const [history, setHistory] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [wdSettings, setWdSettings] = useState<{ fee_percent: number; fee_flat: number; min_amount: number; max_amount: number | null; enabled: boolean; allowed_days?: number[]; open_time?: string; close_time?: string; timezone?: string; crypto_fee_percent?: number; crypto_fee_flat?: number; crypto_min_amount?: number; crypto_payout_available?: boolean; crypto_payout_unavailable_reason?: string }>({
    fee_percent: 0, fee_flat: 0, min_amount: 0, max_amount: null, enabled: true,
    crypto_fee_percent: 0, crypto_fee_flat: 0, crypto_min_amount: 0,
    crypto_payout_available: false,
    crypto_payout_unavailable_reason: "Le contrat officiel de retrait crypto Biz-transPay n’est pas vérifié.",
    allowed_days: [0,1,2,3,4,5,6], open_time: "07:00", close_time: "20:00", timezone: "Africa/Lome",
  });

  const load = useCallback(async () => {
    try {
      const w = await api.get<any>("/wallet");
      setWallet(w);
      setSelectedMethod(w?.method === "crypto" ? "crypto" : "mobile");
      const h = await api.get<any[]>("/withdrawals/mine");
      setHistory(h);
      const s = await api.get<any>("/settings/withdrawal", { auth: false });
      setWdSettings(s);
      try {
        const exchange = await api.get<{ crypto_balance?: number }>("/wallet-exchange/catalog");
        setCryptoWithdrawalBalance(Number(exchange?.crypto_balance || 0));
      } catch {
        setCryptoWithdrawalBalance(0);
      }
    } catch {}
  }, []);
  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const walletProfiles = wallet?.profiles || {};
  const activeWallet = walletProfiles[selectedMethod]
    || (wallet?.method === selectedMethod ? wallet : null);
  const cryptoAsset = "USDT.BEP20";
  const cryptoBalance = cryptoWithdrawalBalance;
  const amt = selectedMethod === "crypto"
    ? Number(String(amount).replace(",", ".")) || 0
    : parseInt(amount, 10) || 0;
  const feePercent = selectedMethod === "crypto"
    ? Number(wdSettings.crypto_fee_percent || 0)
    : Number(wdSettings.fee_percent || 0);
  const feeFlat = selectedMethod === "crypto"
    ? Number(wdSettings.crypto_fee_flat || 0)
    : Number(wdSettings.fee_flat || 0);
  const feePreviewRaw = Math.min(amt, amt * feePercent / 100 + feeFlat);
  const feePreview = selectedMethod === "crypto"
    ? Number(feePreviewRaw.toFixed(6))
    : Math.round(feePreviewRaw);
  const netPreview = Math.max(0, selectedMethod === "crypto"
    ? Number((amt - feePreview).toFixed(6))
    : amt - feePreview);
  const minimumAmount = selectedMethod === "crypto"
    ? Number(wdSettings.crypto_min_amount || 0)
    : Number(wdSettings.min_amount || 0);
  const cryptoUnavailable = selectedMethod === "crypto" && !wdSettings.crypto_payout_available;

  const formatWalletAmount = (value: number, asset: string) => {
    const formatted = new Intl.NumberFormat("fr-FR", {
      maximumFractionDigits: asset === "XOF" ? 0 : 6,
    }).format(value || 0);
    return `${formatted} ${asset}`;
  };

  // Withdrawal window helpers (Africa/Lome — UTC+0)
  const DAY_NAMES_FULL = lang === "en"
    ? ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]
    : ["Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"];
  const allowedDays = wdSettings.allowed_days || [0,1,2,3,4,5,6];
  const openTime = wdSettings.open_time || "07:00";
  const closeTime = wdSettings.close_time || "20:00";
  const prettyDays = (() => {
    if (allowedDays.length === 7) return t("withdrawal.open_days_all");
    return [...allowedDays].sort().map((i) => DAY_NAMES_FULL[i]).join(", ");
  })();
  const now = new Date();
  const lomeNow = new Date(now.getTime() + now.getTimezoneOffset() * 60000); // shift to UTC (Lome = UTC+0)
  const weekday = (lomeNow.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  const curMin = lomeNow.getUTCHours() * 60 + lomeNow.getUTCMinutes();
  const parseHM = (s: string) => {
    const [h, m] = s.split(":").map((x) => parseInt(x, 10) || 0);
    return h * 60 + m;
  };
  const openMin = parseHM(openTime);
  const closeMin = parseHM(closeTime);
  const dayOk = allowedDays.includes(weekday);
  const timeOk = openMin <= closeMin ? (curMin >= openMin && curMin < closeMin) : (curMin >= openMin || curMin < closeMin);
  const windowOpen = wdSettings.enabled !== false && dayOk && timeOk;

  const submit = async (token: string) => {
    if (selectedMethod === "crypto") {
      Alert.alert("Retrait crypto indisponible", wdSettings.crypto_payout_unavailable_reason || "Aucun retrait crypto n’a été envoyé.");
      return;
    }
    if (!amt || amt <= 0) return Alert.alert(t("common.error"), t("withdrawal.invalid_amount"));
    try {
      const result = await api.post<any>("/withdrawals", { amount: amt, method: selectedMethod }, { pwdConfirm: token });
      if (result?.status === "rejected") {
        Alert.alert(
          t("common.error"),
          result.message || "Le retrait n’a pas pu être envoyé. Le montant a été recrédité sur votre solde.",
        );
      } else {
        Alert.alert("✅", t("withdrawal.request_saved", { amount: formatFCFA(netPreview) }));
      }
      setAmount("");
      await refresh();
      await load();
    } catch (e: any) {
      Alert.alert(t("common.error"), e?.detail || t("common.error"));
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>{t("withdrawal.title")}</Text>
        <Text style={styles.sub}>
          {t("withdrawal.available")} {selectedMethod === "crypto"
            ? formatWalletAmount(cryptoBalance, cryptoAsset || "crypto")
            : formatFCFA(user?.balance_profit)}
        </Text>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refresh(); await load(); setRefreshing(false); }} />}
      >
        <Card>
          <Text style={styles.section}>{t("withdrawal.wallet")}</Text>
          <View style={styles.methodRow}>
            {([
              ["mobile", "Portefeuille CFA", "phone-portrait-outline"],
              ["crypto", "Portefeuille crypto", "logo-bitcoin"],
            ] as const).map(([method, label, icon]) => {
              const active = selectedMethod === method;
              return (
                <TouchableOpacity
                  key={method}
                  style={[styles.methodChoice, active && styles.methodChoiceActive]}
                  onPress={() => {
                    setSelectedMethod(method);
                    setAmount("");
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  testID={`withdrawal-method-${method}`}
                >
                  <Ionicons name={icon} size={18} color={active ? "#fff" : theme.colors.primary} />
                  <Text style={[styles.methodChoiceText, active && styles.methodChoiceTextActive]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Card>

        {!activeWallet ? (
          <Card>
            <View style={{ alignItems: "center", padding: 16 }}>
              <Ionicons name="alert-circle" size={40} color={theme.colors.warning} />
              <Text style={{ marginTop: 8, fontWeight: "700", color: theme.colors.textPrimary }}>
                {selectedMethod === "crypto" ? "Aucun portefeuille crypto enregistré" : t("withdrawal.no_wallet")}
              </Text>
              <Text style={{ color: theme.colors.textSecondary, textAlign: "center", marginTop: 4 }}>
                {selectedMethod === "crypto"
                  ? "Enregistrez d’abord l’adresse et le réseau crypto de retrait."
                  : t("withdrawal.wallet_required")}
              </Text>
              <Button title={t("withdrawal.setup_wallet")} onPress={() => router.push("/(app)/wallet")} style={{ marginTop: 12 }} testID="wd-config-wallet" />
            </View>
          </Card>
        ) : (
          <>
            <Card>
              <Text style={styles.section}>{selectedMethod === "crypto" ? "Portefeuille crypto enregistré" : t("withdrawal.wallet")}</Text>
              <Row label={t("withdrawal.country")} value={activeWallet.country || "—"} />
              {selectedMethod === "mobile" ? (
                <>
                  <Row label={t("withdrawal.operator")} value={activeWallet.operator || "—"} />
                  <Row label={t("withdrawal.phone")} value={activeWallet.phone || "—"} />
                </>
              ) : (
                <>
                  <Row label="Actif / réseau" value={activeWallet.asset_code || activeWallet.network || "—"} />
                  <Row label="Adresse" value={activeWallet.wallet_address || "—"} />
                </>
              )}
              <Row label={t("withdrawal.full_name")} value={activeWallet.full_name || "—"} />
              <TouchableOpacity onPress={() => router.push("/(app)/wallet")} style={{ alignSelf: "flex-end" }}>
                <Text style={{ color: theme.colors.primary, fontWeight: "700" }}>{t("common.edit")}</Text>
              </TouchableOpacity>
            </Card>

            {selectedMethod === "crypto" ? (
              <View style={styles.cryptoUnavailableBanner} testID="wd-crypto-unavailable">
                <Ionicons name="lock-closed-outline" size={18} color={theme.colors.warning} />
                <Text style={styles.cryptoUnavailableText}>
                  {wdSettings.crypto_payout_unavailable_reason || "Le retrait crypto est indisponible. Aucun montant ne sera débité."}
                </Text>
              </View>
            ) : null}

            <Card style={{ marginTop: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <Ionicons name="time-outline" size={18} color={theme.colors.primary} />
                <Text style={styles.section}>{t("withdrawal.schedule")}</Text>
              </View>
              <View style={styles.scheduleRow}>
                <Ionicons name="calendar-outline" size={14} color={theme.colors.textSecondary} />
                <Text style={styles.scheduleTxt}>📅 {prettyDays}</Text>
              </View>
              <View style={styles.scheduleRow}>
                <Ionicons name="time-outline" size={14} color={theme.colors.textSecondary} />
                <Text style={styles.scheduleTxt}>🕒 {openTime} - {closeTime} (Africa/Lomé)</Text>
              </View>
              <View style={[styles.statusPill, windowOpen ? styles.statusOpen : styles.statusClosed]} testID="wd-window-status">
                <Ionicons
                  name={windowOpen ? "checkmark-circle" : "lock-closed"}
                  size={14}
                  color={windowOpen ? "#10B981" : theme.colors.danger}
                />
                <Text style={[styles.statusTxt, { color: windowOpen ? "#10B981" : theme.colors.danger }]}>
                  {windowOpen ? t("withdrawal.open_now") : t("withdrawal.closed_now")}
                </Text>
              </View>
            </Card>

            <Card style={{ marginTop: 12 }}>
              <Text style={styles.section}>
                {selectedMethod === "crypto" ? `Montant à retirer (${cryptoAsset || "crypto"})` : t("withdrawal.amount_fcfa")}
              </Text>
              <Input
                icon="cash-outline"
                placeholder={selectedMethod === "crypto" ? "Ex. 12,50" : "Ex: 50000"}
                value={amount}
                onChangeText={setAmount}
                keyboardType={selectedMethod === "crypto" ? "decimal-pad" : "numeric"}
                testID="wd-amount"
              />
              <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginBottom: 8 }}>
                {selectedMethod === "crypto"
                  ? `Solde disponible : ${formatWalletAmount(cryptoBalance, cryptoAsset || "crypto")}`
                  : t("withdrawal.profit_only")}
              </Text>

              {(feePercent > 0 || feeFlat > 0 || minimumAmount > 0) && (
                <View style={styles.feeBox}>
                  <View style={styles.feeRow}>
                    <Text style={styles.feeLbl}>{t("withdrawal.fee")}</Text>
                    <Text style={styles.feeVal}>
                      {feePercent > 0 ? `${feePercent}% ` : ""}
                      {feeFlat > 0 ? `+ ${formatWalletAmount(feeFlat, selectedMethod === "crypto" ? cryptoAsset || "crypto" : "XOF")}` : ""}
                    </Text>
                  </View>
                  {minimumAmount > 0 && (
                    <View style={styles.feeRow}>
                      <Text style={styles.feeLbl}>{t("withdrawal.minimum")}</Text>
                      <Text style={styles.feeVal}>
                        {formatWalletAmount(minimumAmount, selectedMethod === "crypto" ? cryptoAsset || "crypto" : "XOF")}
                      </Text>
                    </View>
                  )}
                  {amt > 0 && (
                    <>
                      <View style={[styles.feeRow, { marginTop: 6 }]}>
                        <Text style={styles.feeLbl}>{t("withdrawal.fee_this")}</Text>
                        <Text style={[styles.feeVal, { color: theme.colors.danger }]}>− {formatWalletAmount(feePreview, selectedMethod === "crypto" ? cryptoAsset || "crypto" : "XOF")}</Text>
                      </View>
                      <View style={[styles.feeRow, styles.feeTotal]}>
                        <Text style={[styles.feeLbl, { color: theme.colors.textPrimary, fontWeight: "800" }]}>{t("withdrawal.you_receive")}</Text>
                        <Text style={{ color: theme.colors.success, fontWeight: "800", fontSize: 16 }}>
                          {formatWalletAmount(netPreview, selectedMethod === "crypto" ? cryptoAsset || "crypto" : "XOF")}
                        </Text>
                      </View>
                    </>
                  )}
                </View>
              )}

              {!windowOpen && (
                <View style={styles.closedBanner} testID="wd-closed-banner">
                  <Text style={styles.closedTitle}>{t("withdrawal.closed_title")}</Text>
                  <Text style={styles.closedBody}>{t("withdrawal.allowed")}</Text>
                  <Text style={styles.closedBody}>📅 {prettyDays}</Text>
                  <Text style={styles.closedBody}>🕒 De {openTime} à {closeTime}</Text>
                  <Text style={[styles.closedBody, { marginTop: 6, fontStyle: "italic" }]}>
                    {t("withdrawal.closed_note")}
                  </Text>
                </View>
              )}

              <Button
                title={selectedMethod === "crypto"
                  ? "RETRAIT CRYPTO INDISPONIBLE"
                  : windowOpen ? t("withdrawal.submit_button") : t("withdrawal.closed_button")}
                icon={<Ionicons name={selectedMethod === "crypto" || !windowOpen ? "lock-closed" : "arrow-up-circle"} size={18} color="#fff" />}
                onPress={() => {
                  if (selectedMethod === "crypto") {
                    Alert.alert("Retrait crypto indisponible", wdSettings.crypto_payout_unavailable_reason || "Aucun montant n’a été débité.");
                    return;
                  }
                  if (!windowOpen) {
                    if (typeof window !== "undefined") window.alert(`${t("withdrawal.closed_title")}\n\n${t("withdrawal.allowed")}\n📅 ${prettyDays}\n🕒 ${t("withdrawal.open_time", { open: openTime, close: closeTime })}\n\n${t("withdrawal.closed_note")}`);
                    else Alert.alert(t("withdrawal.closed_alert_title"), t("withdrawal.closed_alert", { days: prettyDays, open: openTime, close: closeTime }));
                    return;
                  }
                  setShowPwd(true);
                }}
                disabled={!windowOpen || cryptoUnavailable}
                testID="wd-submit"
              />
            </Card>
          </>
        )}

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>{t("withdrawal.history")}</Text>
          {history.length === 0 ? (
            <Text style={{ color: theme.colors.textSecondary, textAlign: "center", padding: 16 }}>
              {t("withdrawal.empty")}
            </Text>
          ) : (
            history.map((h) => (
              <View key={h.id} style={styles.hist}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "700", color: theme.colors.textPrimary }}>{formatFCFA(h.amount)}</Text>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{h.operator} • {h.phone}</Text>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>{formatDateTime(h.created_at)}</Text>
                </View>
                <StatusBadge status={h.status} />
              </View>
            ))
          )}
        </Card>
      </ScrollView>

      <PasswordConfirmModal visible={showPwd} onClose={() => setShowPwd(false)} onConfirm={submit} title={t("withdrawal.confirm")} />
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12, paddingVertical: 6 }}>
      <Text style={{ color: theme.colors.textSecondary }}>{label}</Text>
      <Text style={{ flex: 1, textAlign: "right", color: theme.colors.textPrimary, fontWeight: "600" }} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const cfg: any = {
    pending: { bg: theme.colors.warningBg, color: theme.colors.warning, label: t("status.pending") },
    validated: { bg: theme.colors.successBg, color: theme.colors.success, label: t("status.validated") },
    rejected: { bg: theme.colors.dangerBg, color: theme.colors.danger, label: t("status.rejected") },
  }[status] || { bg: "#eee", color: "#666", label: status };
  return (
    <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: cfg.bg }}>
      <Text style={{ color: cfg.color, fontWeight: "700", fontSize: 11 }}>{cfg.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, paddingBottom: 20 },
  back: { width: 36, height: 36, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  title: { color: "#fff", fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
  sub: { color: "#C7D9FF" },
  section: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 8 },
  methodRow: { flexDirection: "row", gap: 8 },
  methodChoice: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 7, minHeight: 44, paddingHorizontal: 8, borderRadius: 12,
    borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface,
  },
  methodChoiceActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  methodChoiceText: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 11 },
  methodChoiceTextActive: { color: "#fff" },
  cryptoUnavailableBanner: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    marginTop: 12, padding: 12, borderRadius: 12,
    backgroundColor: theme.colors.warningBg,
  },
  cryptoUnavailableText: { flex: 1, color: theme.colors.textPrimary, fontSize: 12, lineHeight: 17 },
  hist: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  feeBox: { padding: 12, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary, marginBottom: 12, borderWidth: 1, borderColor: theme.colors.border },
  feeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 2 },
  feeLbl: { color: theme.colors.textSecondary, fontSize: 12 },
  feeVal: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },
  feeTotal: { borderTopWidth: 1, borderTopColor: theme.colors.border, marginTop: 6, paddingTop: 8 },
  scheduleRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 },
  scheduleTxt: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "600" },
  statusPill: { marginTop: 8, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, borderWidth: 1 },
  statusOpen: { backgroundColor: "#ECFDF5", borderColor: "#10B981" },
  statusClosed: { backgroundColor: "#FEF2F2", borderColor: theme.colors.danger },
  statusTxt: { fontWeight: "700", fontSize: 12 },
  closedBanner: { padding: 12, borderRadius: 14, backgroundColor: "#FEF2F2", borderWidth: 1, borderColor: theme.colors.danger, marginBottom: 12 },
  closedTitle: { color: theme.colors.danger, fontWeight: "800", fontSize: 14, marginBottom: 4 },
  closedBody: { color: theme.colors.textPrimary, fontSize: 12, marginTop: 2 },
});
