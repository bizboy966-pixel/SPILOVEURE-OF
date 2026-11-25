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

type Direction = "xof_to_crypto" | "crypto_to_xof" | "crypto_to_crypto";
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

const DIRECTIONS: Array<{ value: Direction; label: string; icon: any }> = [
  { value: "xof_to_crypto", label: "FCFA → crypto", icon: "arrow-forward" },
  { value: "crypto_to_xof", label: "Crypto → FCFA", icon: "arrow-back" },
  { value: "crypto_to_crypto", label: "Crypto → crypto", icon: "swap-horizontal" },
];

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
  const [sourceCode, setSourceCode] = useState("");
  const [destinationCode, setDestinationCode] = useState("");
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
      setSourceCode((current) => assets.some((asset) =>
        asset.asset_code === current && asset.can_sell && asset.balance > 0)
        ? current : assets.find((asset) => asset.can_sell && asset.balance > 0)?.asset_code || "");
      setDestinationCode((current) => assets.some((asset) =>
        asset.asset_code === current && asset.can_buy)
        ? current : assets.find((asset) => asset.can_buy)?.asset_code || "");
    } catch (e: any) {
      setError(e?.detail || e?.message || "Impossible de charger les soldes et taux.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const assets = catalog?.assets || [];
  const sourceAsset = direction === "xof_to_crypto"
    ? undefined
    : assets.find((asset) => asset.asset_code === sourceCode);
  const effectiveDestinationCode = direction === "crypto_to_crypto" && destinationCode === sourceAsset?.asset_code
    ? assets.find((asset) => asset.can_buy && asset.asset_code !== sourceAsset?.asset_code)?.asset_code || ""
    : destinationCode;
  const destinationAsset = direction === "crypto_to_xof"
    ? undefined
    : assets.find((asset) => asset.asset_code === effectiveDestinationCode);
  const sourceCodeShown = direction === "xof_to_crypto" ? "XOF" : (sourceAsset?.asset_code || "");
  const destinationCodeShown = direction === "crypto_to_xof" ? "XOF" : (destinationAsset?.asset_code || "");
  const availableBalance = direction === "xof_to_crypto"
    ? Number(catalog?.xof_balance || 0)
    : Number(sourceAsset?.balance || 0);
  const entered = parseAmount(amount);

  const preview = useMemo(() => {
    if (!Number.isFinite(entered) || entered <= 0) return 0;
    let result = 0;
    if (direction === "xof_to_crypto" && destinationAsset?.can_buy && destinationAsset.xof_per_unit_buy > 0) {
      result = entered / destinationAsset.xof_per_unit_buy;
    } else if (direction === "crypto_to_xof" && sourceAsset?.can_sell && sourceAsset.xof_per_unit_sell > 0) {
      result = entered * sourceAsset.xof_per_unit_sell;
    } else if (
      direction === "crypto_to_crypto"
      && sourceAsset?.can_sell && destinationAsset?.can_buy
      && sourceAsset.asset_code !== destinationAsset.asset_code
      && sourceAsset.xof_per_unit_sell > 0 && destinationAsset.xof_per_unit_buy > 0
    ) {
      result = entered * sourceAsset.xof_per_unit_sell / destinationAsset.xof_per_unit_buy;
    }
    return result > 0 && Number.isFinite(result)
      ? roundForAsset(result, destinationCodeShown)
      : 0;
  }, [direction, destinationAsset, destinationCodeShown, entered, sourceAsset]);

  const canExchange = direction === "xof_to_crypto"
    ? !!destinationAsset?.can_buy
    : direction === "crypto_to_xof"
      ? !!sourceAsset?.can_sell
      : !!sourceAsset?.can_sell
        && !!destinationAsset?.can_buy
        && sourceAsset?.asset_code !== destinationAsset?.asset_code;
  const hasEnough = entered > 0 && entered <= availableBalance;
  const canSubmit = !loading && !executing && canExchange && hasEnough && preview > 0;

  const selectSource = (asset: Asset) => {
    setSourceCode(asset.asset_code);
    if (asset.asset_code === destinationCode) {
      setDestinationCode(assets.find((candidate) => candidate.can_buy && candidate.asset_code !== asset.asset_code)?.asset_code || "");
    }
    setAmount("");
    setError("");
  };

  const execute = async () => {
    if (!canSubmit || executing) return;
    setExecuting(true);
    setError("");
    try {
      const assetCode = direction === "crypto_to_xof"
        ? sourceCodeShown
        : destinationCodeShown;
      const quote = await api.post<{ quote_id: string; amount_in: number; amount_out: number; source_code: string; destination_code: string }>(
        "/wallet-exchange/quote",
        {
          direction,
          asset_code: assetCode,
          ...(direction === "crypto_to_crypto" ? { source_asset_code: sourceCodeShown } : {}),
          amount: entered,
        },
      );
      await api.post("/wallet-exchange/execute", { quote_id: quote.quote_id });
      setAmount("");
      await refresh();
      await load(true);
      Alert.alert(
        "Échange effectué",
        `${formatAmount(quote.amount_in, quote.source_code)} convertis en ${formatAmount(quote.amount_out, quote.destination_code)}.`,
      );
    } catch (e: any) {
      setError(e?.detail || e?.message || "L’échange n’a pas pu être effectué.");
    } finally {
      setExecuting(false);
    }
  };

  const sourceOptions = assets.filter((asset) => asset.can_sell && asset.balance > 0);
  const destinationOptions = assets.filter((asset) =>
    asset.can_buy && (direction !== "crypto_to_crypto" || asset.asset_code !== sourceAsset?.asset_code)
  );

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
            <Text style={styles.title}>Échange du portefeuille</Text>
            <Text style={styles.subtitle}>Convertissez le solde disponible entre le franc CFA et les cryptos.</Text>
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
              return (
                <TouchableOpacity
                  key={item.value}
                  style={[styles.directionCard, active && styles.directionCardActive]}
                  onPress={() => {
                    setDirection(item.value);
                    setAmount("");
                    setError("");
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  testID={`wallet-exchange-direction-${item.value}`}
                >
                  <Ionicons name={item.icon} size={16} color={active ? "#fff" : theme.colors.primary} />
                  <Text style={[styles.directionLabel, active && styles.directionLabelActive]}>{item.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Card>

        <Card style={{ marginTop: 12 }}>
          {loading ? <Text style={styles.body}>Chargement des soldes et taux…</Text> : null}
          {!loading && !assets.length ? (
            <Text style={styles.body}>Aucun actif crypto n’est configuré pour l’échange.</Text>
          ) : null}

          {direction === "xof_to_crypto" ? (
            <>
              <Text style={styles.sectionTitle}>Solde disponible à convertir</Text>
              <View style={styles.fixedAsset}>
                <View style={styles.assetIcon}><Ionicons name="cash-outline" size={18} color={theme.colors.primary} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.assetName}>Franc CFA disponible</Text>
                  <Text style={styles.assetMeta}>Ce solde n’inclut pas le portefeuille de dépôt.</Text>
                </View>
                <Text style={styles.balanceValue}>{formatAmount(catalog?.xof_balance || 0, "XOF")}</Text>
              </View>
              <Text style={[styles.sectionTitle, styles.selectorTitle]}>Crypto à recevoir</Text>
              <AssetChoices
                options={destinationOptions}
                selectedCode={destinationCode}
                onSelect={(asset) => { setDestinationCode(asset.asset_code); setAmount(""); }}
                testPrefix="wallet-exchange-destination"
                emptyText="Aucune crypto activée pour l’achat."
              />
            </>
          ) : (
            <>
              <Text style={styles.sectionTitle}>Crypto à convertir</Text>
              <AssetChoices
                options={sourceOptions}
                selectedCode={sourceCode}
                onSelect={selectSource}
                testPrefix="wallet-exchange-source"
                emptyText="Aucun solde crypto n’est disponible à la vente."
                showBalance
              />
              {direction === "crypto_to_crypto" ? (
                <>
                  <Text style={[styles.sectionTitle, styles.selectorTitle]}>Crypto à recevoir</Text>
                  <AssetChoices
                    options={destinationOptions}
                    selectedCode={effectiveDestinationCode}
                    onSelect={(asset) => { setDestinationCode(asset.asset_code); setAmount(""); }}
                    testPrefix="wallet-exchange-destination"
                    emptyText="Aucune crypto activée pour l’achat."
                  />
                </>
              ) : (
                <View style={[styles.fixedAsset, styles.fixedAssetMargin]}>
                  <View style={styles.assetIcon}><Ionicons name="cash-outline" size={18} color={theme.colors.primary} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.assetName}>Franc CFA reçu</Text>
                    <Text style={styles.assetMeta}>Crédité sur le solde disponible.</Text>
                  </View>
                  <Text style={styles.assetCode}>XOF</Text>
                </View>
              )}
            </>
          )}
        </Card>

        {sourceCodeShown && destinationCodeShown ? (
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
              title={executing ? "ÉCHANGE EN COURS…" : "ÉCHANGER"}
              icon={<Ionicons name="swap-horizontal" size={18} color="#fff" />}
              onPress={() => void execute()}
              loading={executing}
              disabled={!canSubmit}
              testID="wallet-exchange-submit"
            />
          </Card>
        ) : null}
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

function AssetChoices({
  options, selectedCode, onSelect, testPrefix, emptyText, showBalance = false,
}: {
  options: Asset[];
  selectedCode: string;
  onSelect: (asset: Asset) => void;
  testPrefix: string;
  emptyText: string;
  showBalance?: boolean;
}) {
  if (!options.length) return <Text style={styles.body}>{emptyText}</Text>;
  return (
    <View style={styles.assetList}>
      {options.map((asset) => {
        const active = asset.asset_code === selectedCode;
        return (
          <TouchableOpacity
            key={asset.asset_code}
            style={[styles.assetChoice, active && styles.assetChoiceActive]}
            onPress={() => onSelect(asset)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            testID={`${testPrefix}-${asset.asset_code}`}
          >
            <View style={[styles.assetIcon, active && styles.assetIconActive]}>
              <Ionicons name="logo-bitcoin" size={17} color={active ? "#fff" : theme.colors.warning} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.assetName}>{asset.label || asset.asset_code}</Text>
              <Text style={styles.assetMeta}>
                {showBalance ? `Solde : ${formatAmount(asset.balance, asset.asset_code)}` : asset.asset_code}
                {asset.network ? ` · ${asset.network}` : ""}
              </Text>
            </View>
            {active ? <Ionicons name="checkmark-circle" size={21} color={theme.colors.primary} /> : null}
          </TouchableOpacity>
        );
      })}
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
  directionLabel: { color: theme.colors.textPrimary, fontSize: 9, fontWeight: "700", textAlign: "center" },
  directionLabelActive: { color: "#fff" },
  body: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 },
  assetList: { gap: 8 },
  assetChoice: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceMuted, borderWidth: 1, borderColor: theme.colors.border,
  },
  assetChoiceActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryBg },
  assetIcon: {
    width: 34, height: 34, borderRadius: theme.radius.round,
    backgroundColor: theme.colors.warningBg, alignItems: "center", justifyContent: "center",
  },
  assetIconActive: { backgroundColor: theme.colors.primary },
  assetName: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "800" },
  assetMeta: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 3 },
  fixedAsset: {
    flexDirection: "row", alignItems: "center", gap: 10, padding: 10,
    backgroundColor: theme.colors.primaryBg, borderRadius: theme.radius.md,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  fixedAssetMargin: { marginTop: 12 },
  balanceValue: { color: theme.colors.primary, fontSize: 12, fontWeight: "800" },
  assetCode: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "800" },
  balanceHint: { color: theme.colors.textSecondary, fontSize: 11, marginTop: -6, marginBottom: 12 },
  insufficient: { color: theme.colors.danger, fontSize: 12, fontWeight: "700", marginTop: -6, marginBottom: 10 },
  errorBanner: {
    flexDirection: "row", gap: 8, alignItems: "center", margin: 16, marginBottom: 0,
    padding: 12, borderRadius: theme.radius.md, backgroundColor: theme.colors.dangerBg,
  },
  errorText: { flex: 1, color: theme.colors.danger, fontSize: 12, fontWeight: "600" },
});
