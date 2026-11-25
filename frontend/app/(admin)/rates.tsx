import React, { useCallback, useEffect, useState } from "react";
import {
  RefreshControl, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Input } from "@/src/components/Input";
import { KeyboardAwareScrollView } from "@/src/components/KeyboardAwareScrollView";
import { theme } from "@/src/theme";

type RateAsset = {
  asset_code: string;
  label: string;
  coin: string;
  network: string;
  buy_enabled: boolean;
  xof_per_unit_buy: number;
  sell_enabled: boolean;
  xof_per_unit_sell: number;
};
type Draft = {
  buy_enabled: boolean;
  buy_rate: string;
  sell_enabled: boolean;
  sell_rate: string;
};

export default function AdminRatesScreen() {
  const router = useRouter();
  const [assets, setAssets] = useState<RateAsset[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const response = await api.get<{ assets: RateAsset[] }>("/admin/wallet-exchange/rates");
      const rows = Array.isArray(response?.assets) ? response.assets : [];
      setAssets(rows);
      setDrafts(Object.fromEntries(rows.map((asset) => [asset.asset_code, {
        buy_enabled: asset.buy_enabled,
        buy_rate: asset.xof_per_unit_buy ? String(asset.xof_per_unit_buy) : "",
        sell_enabled: asset.sell_enabled,
        sell_rate: asset.xof_per_unit_sell ? String(asset.xof_per_unit_sell) : "",
      }])));
    } catch (e: any) {
      setError(e?.detail || e?.message || "Impossible de charger le taux USDT.BEP20.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const patchDraft = (code: string, patch: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [code]: { ...current[code], ...patch } }));
    setSaved("");
  };

  const save = async (asset: RateAsset) => {
    const draft = drafts[asset.asset_code];
    const buyRate = Number(String(draft?.buy_rate ?? "").replace(",", "."));
    const sellRate = Number(String(draft?.sell_rate ?? "").replace(",", "."));
    if (!Number.isFinite(buyRate) || buyRate < 0 || !Number.isFinite(sellRate) || sellRate < 0) {
      setError("Saisissez des taux numériques positifs ou laissez le sens désactivé.");
      return;
    }
    if (draft.buy_enabled && buyRate <= 0) {
      setError("Entrez le montant en FCFA nécessaire pour obtenir une unité crypto.");
      return;
    }
    if (draft.sell_enabled && sellRate <= 0) {
      setError("Entrez le montant en FCFA obtenu pour une unité crypto.");
      return;
    }
    setSaving(asset.asset_code);
    setError("");
    setSaved("");
    try {
      await api.put(`/admin/wallet-exchange/rates/${encodeURIComponent(asset.asset_code)}`, {
        buy_enabled: draft.buy_enabled,
        xof_per_unit_buy: buyRate,
        sell_enabled: draft.sell_enabled,
        xof_per_unit_sell: sellRate,
      });
      setSaved(asset.asset_code);
      await load(true);
      setSaved(asset.asset_code);
    } catch (e: any) {
      setError(e?.detail || e?.message || "Le taux n’a pas pu être enregistré.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Retour">
          <Ionicons name="chevron-back" size={21} color={theme.colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>ESPACE ADMINISTRATEUR</Text>
          <Text style={styles.title}>Taux d’échange</Text>
          <Text style={styles.subtitle}>Configure les deux sens entre XOF et USDT.BEP20.</Text>
        </View>
        <TouchableOpacity onPress={() => void load(true)} style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Actualiser les taux">
          <Ionicons name="refresh-outline" size={20} color={theme.colors.primary} />
        </TouchableOpacity>
      </View>

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
        <View style={styles.intro}>
          <View style={styles.introMark}>
            <Ionicons name="swap-horizontal" size={21} color={theme.colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.introTitle}>Taux définis par l’administration</Text>
            <Text style={styles.introText}>
              Ces conversions internes utilisent uniquement les taux enregistrés ici, sans appel à un prestataire.
            </Text>
          </View>
        </View>

        {loading ? (
          <Card><Text style={styles.body}>Chargement des taux USDT.BEP20…</Text></Card>
        ) : assets.length === 0 ? (
          <Card>
            <Text style={styles.emptyTitle}>Taux USDT.BEP20 indisponibles</Text>
            <Text style={styles.body}>Actualisez la page et réessayez.</Text>
          </Card>
        ) : assets.map((asset) => {
          const draft = drafts[asset.asset_code];
          return (
            <Card key={asset.asset_code} style={styles.assetCard}>
              <View style={styles.assetHeader}>
                <View style={styles.assetMark}>
                  <Ionicons name="logo-bitcoin" size={19} color={theme.colors.warning} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.assetName}>USDT BEP20</Text>
                  <Text style={styles.assetMeta}>USDT.BEP20 · taux interne</Text>
                </View>
              </View>

              <TouchableOpacity
                style={[styles.directionToggle, draft?.buy_enabled && styles.directionToggleOn]}
                onPress={() => patchDraft(asset.asset_code, { buy_enabled: !draft?.buy_enabled })}
                accessibilityRole="switch"
                accessibilityState={{ checked: !!draft?.buy_enabled }}
                testID={`rate-buy-toggle-${asset.asset_code}`}
              >
                <Ionicons name={draft?.buy_enabled ? "checkmark-circle" : "ellipse-outline"} size={19} color={draft?.buy_enabled ? theme.colors.success : theme.colors.textMuted} />
                <Text style={styles.directionText}>FCFA vers crypto</Text>
                <Text style={styles.directionHelp}>Prix d’achat</Text>
              </TouchableOpacity>
              <Input
                label="FCFA nécessaires pour obtenir 1 USDT"
                value={draft?.buy_rate || ""}
                onChangeText={(value) => patchDraft(asset.asset_code, { buy_rate: value })}
                keyboardType="decimal-pad"
                placeholder="Taux à saisir"
                testID={`rate-buy-${asset.asset_code}`}
              />

              <TouchableOpacity
                style={[styles.directionToggle, draft?.sell_enabled && styles.directionToggleOn]}
                onPress={() => patchDraft(asset.asset_code, { sell_enabled: !draft?.sell_enabled })}
                accessibilityRole="switch"
                accessibilityState={{ checked: !!draft?.sell_enabled }}
                testID={`rate-sell-toggle-${asset.asset_code}`}
              >
                <Ionicons name={draft?.sell_enabled ? "checkmark-circle" : "ellipse-outline"} size={19} color={draft?.sell_enabled ? theme.colors.success : theme.colors.textMuted} />
                <Text style={styles.directionText}>Crypto vers FCFA</Text>
                <Text style={styles.directionHelp}>Montant de vente</Text>
              </TouchableOpacity>
              <Input
                label="FCFA crédités pour 1 USDT"
                value={draft?.sell_rate || ""}
                onChangeText={(value) => patchDraft(asset.asset_code, { sell_rate: value })}
                keyboardType="decimal-pad"
                placeholder="Taux à saisir"
                testID={`rate-sell-${asset.asset_code}`}
              />

              <Button
                title={saving === asset.asset_code ? "ENREGISTREMENT…" : "ENREGISTRER LES TAUX"}
                icon={<Ionicons name="save-outline" size={18} color="#fff" />}
                loading={saving === asset.asset_code}
                disabled={saving !== null}
                onPress={() => void save(asset)}
                testID={`rate-save-${asset.asset_code}`}
              />
              {saved === asset.asset_code ? <Text style={styles.savedText}>Taux enregistrés.</Text> : null}
            </Card>
          );
        })}
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1, borderBottomColor: theme.colors.border,
  },
  iconButton: {
    width: 40, height: 40, alignItems: "center", justifyContent: "center",
    borderRadius: theme.radius.round, backgroundColor: theme.colors.surfaceSecondary,
  },
  headerCopy: { flex: 1 },
  eyebrow: { fontSize: 10, letterSpacing: 0.7, color: theme.colors.textSecondary, fontWeight: "700" },
  title: { color: theme.colors.textPrimary, fontSize: 20, fontWeight: "800" },
  subtitle: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 },
  content: { padding: 16, paddingBottom: 48, gap: 12, width: "100%", maxWidth: 760, alignSelf: "center" },
  intro: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: 16, borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primaryBg,
  },
  introMark: {
    width: 42, height: 42, borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface, alignItems: "center", justifyContent: "center",
  },
  introTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 14 },
  introText: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 3 },
  assetCard: { marginBottom: 4 },
  assetHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 },
  assetMark: {
    width: 38, height: 38, borderRadius: theme.radius.md,
    alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.warningBg,
  },
  assetName: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: "800" },
  assetMeta: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  directionToggle: {
    flexDirection: "row", alignItems: "center", gap: 7,
    paddingVertical: 10, paddingHorizontal: 11, marginBottom: 9,
    borderRadius: theme.radius.md, backgroundColor: theme.colors.surfaceSecondary,
  },
  directionToggleOn: { backgroundColor: theme.colors.successBg },
  directionText: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 12 },
  directionHelp: { flex: 1, textAlign: "right", color: theme.colors.textSecondary, fontSize: 10 },
  savedText: { color: theme.colors.success, fontWeight: "700", fontSize: 12, textAlign: "center", marginTop: 8 },
  errorBanner: {
    flexDirection: "row", gap: 9, alignItems: "center",
    marginHorizontal: 16, marginTop: 12, padding: 12,
    borderRadius: theme.radius.md, backgroundColor: theme.colors.dangerBg,
  },
  errorText: { flex: 1, color: theme.colors.danger, fontSize: 12, fontWeight: "600" },
  body: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 },
  emptyTitle: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: "800", marginBottom: 6 },
});
