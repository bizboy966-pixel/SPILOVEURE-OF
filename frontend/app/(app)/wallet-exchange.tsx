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
  balance: number;
  can_buy: boolean;
  can_sell: boolean;
  xof_per_unit_buy: number;
  xof_per_unit_sell: number;
};

const DIRECTIONS: Array<{ value: Direction; label: string; icon: any }> = [
  { value: "xof_to_crypto", label: "XOF → USDT.BEP20", icon: "arrow-forward" },
  { value: "crypto_to_xof", label: "USDT.BEP20 → XOF", icon: "arrow-back" },
];

const EXCHANGE_ASSET = "USDT.BEP20";

function formatAmount(value: number, asset: string) {
  const decimals = asset === "XOF" ? 0 : 6;
  return `${new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0,
  }).format(value || 0)} ${asset}`;
}

function parseAmount(value: string) {
  const normalized = String(value || "").replace(/\s/g, "").replace(",", ".");
  return normalized ? Number(normalized) : 0;
}

function roundForAsset(value: number, asset: string) {
  const digits = asset === "XOF" ? 0 : 6;
  return Number(value.toFixed(digits));
}

export default function WalletExchangeScreen() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [direction, setDirection] = useState<Direction>("xof_to_crypto");
  const [amount, setAmount] = useState("");
  const [catalog, setCatalog] = useState<{ xof_balance: number; assets: Asset[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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
      const cryptoBalance = Number(assets.find((asset) => asset.asset_code === EXCHANGE_ASSET)?.balance || 0);
      if (cryptoBalance <= 0) {
        setDirection((current) => current === "crypto_to_xof" ? "xof_to_crypto" : current);
      }
    } catch (e: any) {
      setError(e?.detail || e?.message || "Impossible de charger les soldes et taux.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const exchangeAsset = catalog?.assets.find((asset) => asset.asset_code === EXCHANGE_ASSET);
  const sourceCodeShown = direction === "xof_to_crypto" ? "XOF" : EXCHANGE_ASSET;
  const destinationCodeShown = direction === "crypto_to_xof" ? "XOF" : EXCHANGE_ASSET;
  const availableBalance = direction === "xof_to_crypto"
    ? Number(catalog?.xof_balance || 0)
    : Number(exchangeAsset?.balance || 0);
  const entered = parseAmount(amount);

  const preview = useMemo(() => {
    if (!Number.isFinite(entered) || entered <= 0) return 0;
    if (direction === "xof_to_crypto" && exchangeAsset?.can_buy && exchangeAsset.xof_per_unit_buy > 0) {
      const result = entered / exchangeAsset.xof_per_unit_buy;
      return Number.isFinite(result) ? roundForAsset(result, EXCHANGE_ASSET) : 0;
    }
    if (direction === "crypto_to_xof" && exchangeAsset?.can_sell && exchangeAsset.xof_per_unit_sell > 0) {
      const result = entered * exchangeAsset.xof_per_unit_sell;
      return Number.isFinite(result) ? roundForAsset(result, "XOF") : 0;
    }
    return 0;
  }, [direction, exchangeAsset, entered]);

  const canExchange = direction === "xof_to_crypto"
    ? !!exchangeAsset?.can_buy
    : !!exchangeAsset?.can_sell;
  const hasEnough = entered > 0 && entered <= availableBalance;
  const canSubmit = !loading && !executing && canExchange && hasEnough && preview > 0;

  const execute = async () => {
    if (!canSubmit || executing) return;
    setExecuting(true);
    setError("");
    try {
      const quote = await api.post<{ quote_id: string; amount_in: number; amount_out: number; source_code: string; destination_code: string }>(
        "/wallet-exchange/quote",
        {
          direction,
          asset_code: EXCHANGE_ASSET,
          amount: entered,
        },
      );
      await api.post("/wallet-exchange/execute", { quote_id: quote.quote_id });
      setAmount("");
      await refresh();
      await load(true);
      Alert.alert(
        "Conversion effectuée",
        `${formatAmount(quote.amount_in, quote.source_code)} convertis en ${formatAmount(quote.amount_out, quote.destination_code)}.`,
      );
    } catch (e: any) {
      setError(e?.detail || e?.message || "La conversion n’a pas pu être effectuée.");
    } finally {
      setExecuting(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="Retour"
        >
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Conversion des soldes</Text>
            <Text style={styles.subtitle}>Convertissez le solde disponible XOF en USDT.BEP20, ou inversement.</Text>
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
          <Text style={styles.sectionTitle}>Choisissez l’échange</Text>
          <View style={styles.directionRow}>
            {DIRECTIONS.map((item) => {
              const active = direction === item.value;
              const disabled = item.value === "crypto_to_xof" && !(Number(exchangeAsset?.balance) > 0);
              return (
                <TouchableOpacity
                  key={item.value}
                  style={[styles.directionCard, active && styles.directionCardActive, disabled && styles.directionCardDisabled]}
                  onPress={() => {
                    setDirection(item.value);
                    setAmount("");
                    setError("");
                  }}
                  disabled={disabled}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active, disabled }}
                  testID={`wallet-exchange-direction-${item.value}`}
                >
                  <Ionicons name={item.icon} size={16} color={active ? "#fff" : disabled ? theme.colors.textMuted : theme.colors.primary} />
                  <Text style={[styles.directionLabel, active && styles.directionLabelActive]}>{item.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Card>

        <Card style={{ marginTop: 12 }}>
          {loading ? <Text style={styles.body}>Chargement des soldes et taux…</Text> : null}
          <Text style={styles.sectionTitle}>
            {direction === "xof_to_crypto" ? "Solde source : disponible XOF" : "Solde source : USDT.BEP20"}
          </Text>
          <View style={styles.fixedAsset}>
            <View style={styles.assetIcon}>
              <Ionicons
                name={direction === "xof_to_crypto" ? "cash-outline" : "logo-bitcoin"}
                size={18}
                color={theme.colors.primary}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.assetName}>
                {direction === "xof_to_crypto" ? "Solde disponible (commissions)" : "Solde crypto dédié aux retraits"}
              </Text>
              <Text style={styles.assetMeta}>
                {direction === "xof_to_crypto" ? "Le portefeuille de dépôt est exclu." : "Solde USDT.BEP20, distinct du portefeuille de dépôt."}
              </Text>
            </View>
            <Text style={styles.balanceValue}>{formatAmount(availableBalance, sourceCodeShown)}</Text>
          </View>

          <Text style={[styles.sectionTitle, styles.selectorTitle]}>
            {direction === "xof_to_crypto" ? "Vous recevrez sur USDT.BEP20" : "Vous recevrez sur le solde disponible XOF"}
          </Text>
          <View style={styles.fixedAsset}>
            <View style={styles.assetIcon}>
              <Ionicons
                name={direction === "xof_to_crypto" ? "logo-bitcoin" : "cash-outline"}
                size={18}
                color={theme.colors.primary}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.assetName}>{destinationCodeShown === "XOF" ? "Solde disponible" : "Solde crypto dédié aux retraits"}</Text>
              <Text style={styles.assetMeta}>{destinationCodeShown}</Text>
            </View>
          </View>
          {!canExchange && !loading ? (
            <Text style={styles.rateUnavailable}>
              Le taux {direction === "xof_to_crypto" ? "XOF vers USDT.BEP20" : "USDT.BEP20 vers XOF"} doit être activé dans l’administration.
            </Text>
          ) : null}
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.sectionTitle}>Montants</Text>
          <Input
            icon="cash-outline"
            label={`Montant à convertir (${sourceCodeShown})`}
            value={amount}
            onChangeText={(value) => { setAmount(value); setError(""); }}
            keyboardType={sourceCodeShown === "XOF" ? "numeric" : "decimal-pad"}
            placeholder={sourceCodeShown === "XOF" ? "Ex. 10 000" : "Ex. 12,50"}
            testID="wallet-exchange-amount-in"
          />
          <Input
            icon="wallet-outline"
            label={`Vous recevrez (${destinationCodeShown})`}
            value={preview > 0 ? formatAmount(preview, destinationCodeShown) : ""}
            editable={false}
            placeholder="Calculé automatiquement"
            testID="wallet-exchange-amount-out"
          />
          <Text style={styles.balanceHint}>
            Solde disponible à convertir : {formatAmount(availableBalance, sourceCodeShown)}
          </Text>
          {entered > availableBalance && entered > 0 ? (
            <Text style={styles.insufficient}>Le montant dépasse le solde disponible.</Text>
          ) : null}
          <Button
            title={executing ? "CONVERSION EN COURS…" : "CONVERTIR"}
            icon={<Ionicons name="swap-horizontal" size={18} color="#fff" />}
            onPress={() => void execute()}
            loading={executing}
            disabled={!canSubmit}
            testID="wallet-exchange-submit"
          />
        </Card>
      </KeyboardAwareScrollView>
    </SafeAreaView>
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
  title: { color: "#fff", fontSize: 20, fontWeight: "800" },
  subtitle: { color: "#D8E4FF", fontSize: 12, lineHeight: 17, marginTop: 4 },
  headerMark: {
    width: 46, height: 46, borderRadius: theme.radius.round,
    backgroundColor: "#fff", alignItems: "center", justifyContent: "center",
  },
  content: { padding: 16, paddingBottom: 48, width: "100%", maxWidth: 760, alignSelf: "center" },
  sectionTitle: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: "800", marginBottom: 10 },
  selectorTitle: { marginTop: 16 },
  directionRow: { flexDirection: "row", gap: 6 },
  directionCard: {
    flex: 1, minHeight: 48, borderRadius: theme.radius.md,
    borderWidth: 1, borderColor: theme.colors.borderStrong,
    backgroundColor: theme.colors.surface, flexDirection: "column",
    gap: 2, alignItems: "center", justifyContent: "center", padding: 5,
  },
  directionCardActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  directionCardDisabled: { opacity: 0.5 },
  directionLabel: { color: theme.colors.textPrimary, fontSize: 9, fontWeight: "700", textAlign: "center" },
  directionLabelActive: { color: "#fff" },
  body: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 },
  assetIcon: {
    width: 34, height: 34, borderRadius: theme.radius.round,
    backgroundColor: theme.colors.warningBg, alignItems: "center", justifyContent: "center",
  },
  assetName: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "800" },
  assetMeta: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 3 },
  fixedAsset: {
    flexDirection: "row", alignItems: "center", gap: 10, padding: 10,
    backgroundColor: theme.colors.primaryBg, borderRadius: theme.radius.md,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  balanceValue: { color: theme.colors.primary, fontSize: 12, fontWeight: "800" },
  balanceHint: { color: theme.colors.textSecondary, fontSize: 11, marginTop: -6, marginBottom: 12 },
  rateUnavailable: { color: theme.colors.warning, fontSize: 11, lineHeight: 16, marginTop: 10 },
  insufficient: { color: theme.colors.danger, fontSize: 12, fontWeight: "700", marginTop: -6, marginBottom: 10 },
  errorBanner: {
    flexDirection: "row", gap: 8, alignItems: "center", margin: 16, marginBottom: 0,
    padding: 12, borderRadius: theme.radius.md, backgroundColor: theme.colors.dangerBg,
  },
  errorText: { flex: 1, color: theme.colors.danger, fontSize: 12, fontWeight: "600" },
});
