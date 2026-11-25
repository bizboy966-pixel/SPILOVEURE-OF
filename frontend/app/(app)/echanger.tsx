import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, RefreshControl, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Input } from "@/src/components/Input";
import { KeyboardAwareScrollView } from "@/src/components/KeyboardAwareScrollView";
import { theme } from "@/src/theme";

type Direction = "xof_to_crypto" | "crypto_to_xof";
type Asset = {
  asset_code: string;
  label: string;
  coin: string;
  network: string;
  balance: number;
  can_buy: boolean;
  can_sell: boolean;
  xof_per_unit_buy: number;
  xof_per_unit_sell: number;
};
type Quote = {
  quote_id: string;
  direction: Direction;
  asset_code: string;
  source_code: string;
  destination_code: string;
  amount_in: number;
  amount_out: number;
  rate: number;
  expires_at: string;
};

function formatAmount(value: number, asset: string) {
  const decimals = asset === "XOF" ? 0 : 6;
  return `${new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0,
  }).format(value || 0)} ${asset}`;
}

export default function ExchangeScreen() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [direction, setDirection] = useState<Direction>("xof_to_crypto");
  const [amount, setAmount] = useState("");
  const [catalog, setCatalog] = useState<{ xof_balance: number; assets: Asset[] } | null>(null);
  const [assetCode, setAssetCode] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const response = await api.get<{ xof_balance: number; assets: Asset[] }>("/wallet-exchange/catalog");
      const assets = Array.isArray(response?.assets) ? response.assets : [];
      setCatalog({ xof_balance: Number(response?.xof_balance || 0), assets });
      setAssetCode((current) => assets.some((item) => item.asset_code === current)
        ? current : assets[0]?.asset_code || "");
    } catch (e: any) {
      setError(e?.detail || e?.message || "Impossible de charger les taux d’échange.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(
    () => catalog?.assets.find((asset) => asset.asset_code === assetCode),
    [catalog, assetCode],
  );
  const sourceAsset = direction === "xof_to_crypto" ? "XOF" : (selected?.asset_code || "");
  const destinationAsset = direction === "xof_to_crypto" ? (selected?.asset_code || "") : "XOF";
  const selectedRate = direction === "xof_to_crypto"
    ? selected?.xof_per_unit_buy || 0
    : selected?.xof_per_unit_sell || 0;
  const directionEnabled = !!selected && (direction === "xof_to_crypto" ? selected.can_buy : selected.can_sell);
  const entered = Number(String(amount).replace(",", "."));

  const createQuote = async () => {
    if (!selected || !directionEnabled || !Number.isFinite(entered) || entered <= 0) {
      setError("Choisissez un sens configuré et saisissez un montant valide.");
      return;
    }
    setQuoting(true);
    setError("");
    setQuote(null);
    try {
      const result = await api.post<Quote>("/wallet-exchange/quote", {
        direction, asset_code: selected.asset_code, amount: entered,
      });
      setQuote(result);
    } catch (e: any) {
      setError(e?.detail || e?.message || "Impossible de calculer l’échange.");
    } finally {
      setQuoting(false);
    }
  };

  const execute = async () => {
    if (!quote || executing) return;
    setExecuting(true);
    setError("");
    try {
      await api.post("/wallet-exchange/execute", { quote_id: quote.quote_id });
      setQuote(null);
      setAmount("");
      await refresh();
      await load(true);
      Alert.alert("Échange effectué", `${formatAmount(quote.amount_in, quote.source_code)} convertis en ${formatAmount(quote.amount_out, quote.destination_code)}.`);
    } catch (e: any) {
      setError(e?.detail || e?.message || "L’échange n’a pas pu être effectué.");
      setQuote(null);
    } finally {
      setExecuting(false);
    }
  };

  const directions: Array<{ value: Direction; label: string; icon: any }> = [
    { value: "xof_to_crypto", label: "FCFA vers crypto", icon: "arrow-forward" },
    { value: "crypto_to_xof", label: "Crypto vers FCFA", icon: "arrow-back" },
  ];

  return (
    <SafeAreaView style={styles.screen}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back} accessibilityRole="button" accessibilityLabel="Retour">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Échanger</Text>
            <Text style={styles.subtitle}>Solde disponible : {formatAmount(catalog?.xof_balance || 0, "XOF")}</Text>
          </View>
          <View style={styles.headerMark}>
            <Ionicons name="swap-horizontal" size={24} color={theme.colors.primary} />
          </View>
        </View>
      </LinearGradient>

      {error ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Ionicons name="alert-circle-outline" size={19} color={theme.colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <KeyboardAwareScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={theme.colors.primary} />}
      >
        <Card>
          <Text style={styles.sectionTitle}>Choisir le sens</Text>
          <View style={styles.directionRow}>
            {directions.map((item) => {
              const active = direction === item.value;
              return (
                <TouchableOpacity
                  key={item.value}
                  style={[styles.directionCard, active && styles.directionCardActive]}
                  onPress={() => {
                    setDirection(item.value);
                    setQuote(null);
                    setError("");
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  testID={`exchange-direction-${item.value}`}
                >
                  <Ionicons name={item.icon} size={18} color={active ? "#fff" : theme.colors.primary} />
                  <Text style={[styles.directionLabel, active && styles.directionLabelActive]}>{item.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.sectionTitle}>Actif crypto</Text>
          {loading ? <Text style={styles.body}>Chargement du catalogue…</Text> : null}
          {!loading && (!catalog?.assets.length) ? (
            <Text style={styles.body}>Aucun actif avec un taux enregistré n’est disponible. Demandez à l’administration de configurer les taux.</Text>
          ) : null}
          <View style={styles.assetList}>
            {(catalog?.assets || []).map((asset) => {
              const active = asset.asset_code === assetCode;
              const enabled = direction === "xof_to_crypto" ? asset.can_buy : asset.can_sell;
              return (
                <TouchableOpacity
                  key={asset.asset_code}
                  style={[styles.assetChoice, active && styles.assetChoiceActive, !enabled && styles.assetChoiceDisabled]}
                  onPress={() => {
                    setAssetCode(asset.asset_code);
                    setQuote(null);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  testID={`exchange-asset-${asset.asset_code}`}
                >
                  <View style={[styles.assetIcon, active && styles.assetIconActive]}>
                    <Ionicons name="logo-bitcoin" size={17} color={active ? "#fff" : theme.colors.warning} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.assetName}>{asset.label || asset.asset_code}</Text>
                    <Text style={styles.assetMeta}>
                      Solde : {formatAmount(asset.balance, asset.asset_code)}
                      {asset.network ? ` · ${asset.network}` : ""}
                    </Text>
                  </View>
                  <View style={[styles.rateStatus, enabled ? styles.rateStatusOn : styles.rateStatusOff]}>
                    <Text style={[styles.rateStatusText, { color: enabled ? theme.colors.success : theme.colors.textSecondary }]}>
                      {enabled ? "Disponible" : "Non configuré"}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </Card>

        {selected ? (
          <Card style={{ marginTop: 12 }}>
            <Text style={styles.sectionTitle}>Montant à convertir</Text>
            <Input
              icon="cash-outline"
              label={`Montant en ${sourceAsset}`}
              value={amount}
              onChangeText={(value) => {
                setAmount(value);
                setQuote(null);
              }}
              keyboardType={sourceAsset === "XOF" ? "numeric" : "decimal-pad"}
              placeholder={sourceAsset === "XOF" ? "Ex. 10 000" : "Ex. 12,50"}
              testID="exchange-amount"
            />
            <View style={styles.rateHint}>
              <Ionicons name="information-circle-outline" size={18} color={theme.colors.primary} />
              <Text style={styles.rateHintText}>
                1 {selected.coin} = {formatAmount(selectedRate, "XOF")} pour ce sens.
              </Text>
            </View>
            {direction === "xof_to_crypto" && entered > 0 && selectedRate > 0 ? (
              <Text style={styles.balanceHint}>
                Solde FCFA : {formatAmount(catalog?.xof_balance || 0, "XOF")}
              </Text>
            ) : null}
            <Button
              title={quoting ? "CALCUL…" : "CALCULER LE RÉSUMÉ"}
              icon={<Ionicons name="calculator-outline" size={18} color="#fff" />}
              onPress={() => void createQuote()}
              loading={quoting}
              disabled={!directionEnabled || quoting || !amount}
              testID="exchange-quote"
            />
          </Card>
        ) : null}

        {quote ? (
          <Card style={styles.summaryCard}>
            <View style={styles.summaryHead}>
              <Ionicons name="receipt-outline" size={20} color={theme.colors.primary} />
              <Text style={styles.sectionTitle}>Résumé avant validation</Text>
            </View>
            <SummaryRow label="Vous échangez" value={formatAmount(quote.amount_in, quote.source_code)} />
            <SummaryRow label="Taux appliqué" value={`1 ${selected?.coin || quote.asset_code} = ${formatAmount(quote.rate, "XOF")}`} />
            <SummaryRow label="Frais" value="0" />
            <View style={styles.summaryTotal}>
              <Text style={styles.summaryTotalLabel}>Vous recevez</Text>
              <Text style={styles.summaryTotalValue}>{formatAmount(quote.amount_out, quote.destination_code)}</Text>
            </View>
            <Text style={styles.expiryNote}>Le devis expire après deux minutes.</Text>
            <Button
              title={executing ? "VALIDATION…" : "CONFIRMER L’ÉCHANGE"}
              icon={<Ionicons name="checkmark-circle-outline" size={18} color="#fff" />}
              onPress={() => void execute()}
              loading={executing}
              disabled={executing}
              testID="exchange-confirm"
            />
          </Card>
        ) : null}
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 10, paddingBottom: 20 },
  back: {
    width: 36, height: 36, borderRadius: theme.radius.round,
    backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center",
    justifyContent: "center", marginBottom: 10,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { color: "#fff", fontSize: 22, fontWeight: "800" },
  subtitle: { color: "#D8E4FF", fontSize: 12, marginTop: 3 },
  headerMark: {
    width: 46, height: 46, borderRadius: theme.radius.round,
    backgroundColor: "#fff", alignItems: "center", justifyContent: "center",
  },
  content: { padding: 16, paddingBottom: 48, width: "100%", maxWidth: 760, alignSelf: "center" },
  sectionTitle: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: "800", marginBottom: 10 },
  directionRow: { flexDirection: "row", gap: 10 },
  directionCard: {
    flex: 1, minHeight: 48, borderRadius: theme.radius.md,
    borderWidth: 1, borderColor: theme.colors.borderStrong,
    backgroundColor: theme.colors.surface, flexDirection: "row",
    gap: 7, alignItems: "center", justifyContent: "center", padding: 8,
  },
  directionCardActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  directionLabel: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "700" },
  directionLabelActive: { color: "#fff" },
  body: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 },
  assetList: { gap: 8 },
  assetChoice: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceMuted, borderWidth: 1, borderColor: theme.colors.border,
  },
  assetChoiceActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryBg },
  assetChoiceDisabled: { opacity: 0.66 },
  assetIcon: { width: 34, height: 34, borderRadius: theme.radius.round, backgroundColor: theme.colors.warningBg, alignItems: "center", justifyContent: "center" },
  assetIconActive: { backgroundColor: theme.colors.primary },
  assetName: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "800" },
  assetMeta: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 3 },
  rateStatus: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: theme.radius.round },
  rateStatusOn: { backgroundColor: theme.colors.successBg },
  rateStatusOff: { backgroundColor: theme.colors.surfaceSecondary },
  rateStatusText: { fontSize: 10, fontWeight: "700" },
  rateHint: { flexDirection: "row", gap: 8, alignItems: "center", padding: 10, marginTop: 2, marginBottom: 10, borderRadius: theme.radius.md, backgroundColor: theme.colors.primaryBg },
  rateHintText: { flex: 1, color: theme.colors.textPrimary, fontSize: 12, fontWeight: "600" },
  balanceHint: { color: theme.colors.textSecondary, fontSize: 12, marginBottom: 10 },
  summaryCard: { marginTop: 12, borderColor: theme.colors.primary, borderWidth: 1 },
  summaryHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  summaryLabel: { color: theme.colors.textSecondary, fontSize: 12 },
  summaryValue: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "700", textAlign: "right" },
  summaryTotal: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, paddingVertical: 12 },
  summaryTotalLabel: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13 },
  summaryTotalValue: { color: theme.colors.success, fontWeight: "900", fontSize: 16, textAlign: "right" },
  expiryNote: { color: theme.colors.textSecondary, fontSize: 11, marginBottom: 12 },
  errorBanner: {
    flexDirection: "row", gap: 8, alignItems: "center", margin: 16, marginBottom: 0,
    padding: 12, borderRadius: theme.radius.md, backgroundColor: theme.colors.dangerBg,
  },
  errorText: { flex: 1, color: theme.colors.danger, fontSize: 12, fontWeight: "600" },
});
