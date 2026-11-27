import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshControl, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View, useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { theme } from "@/src/theme";

type FeeRoute = {
  route_id: string;
  provider?: string;
  provider_name?: string;
  direction?: string;
  route_type?: "mobile" | "crypto";
  country_code?: string;
  country_name?: string;
  currency?: string;
  operator_code?: string;
  operator_name?: string;
  asset_code?: string;
  available?: boolean;
  unavailable_reason?: string;
  fee_percent?: number;
  rate_percent?: number;
  fixed_amount?: number;
  fixed_fee_amount?: number;
  enabled?: boolean;
};

type Draft = { enabled: boolean; rate: string; fixedAmount: string };
type DirectionFilter = "deposit" | "send";
type ProviderFilter = "all" | "moneyfusion" | "biztranspay";

function listFrom(payload: any): FeeRoute[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.routes)) return payload.routes;
  if (Array.isArray(payload?.fees)) return payload.fees;
  if (Array.isArray(payload?.wallet_fees)) return payload.wallet_fees;
  return [];
}

function catalogRoutes(payload: any): FeeRoute[] {
  const routes: FeeRoute[] = [...(Array.isArray(payload?.routes) ? payload.routes : [])];
  for (const country of payload?.countries || []) {
    routes.push(...(country?.operators || []).map((route: FeeRoute) => ({
      ...route,
      country_code: route.country_code || country.code,
      country_name: route.country_name || country.name,
      currency: route.currency || country.currency,
    })));
  }
  routes.push(...(payload?.crypto_assets || []));
  return routes;
}

function routeTitle(route: FeeRoute) {
  return route.route_type === "crypto"
    ? `${route.asset_code || "Crypto"} · ${route.provider_name || route.provider || "Prestataire"}`
    : `${route.operator_name || route.operator_code || "Opérateur"} · ${route.provider_name || route.provider || "Prestataire"}`;
}

export default function AdminFeesScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [routes, setRoutes] = useState<FeeRoute[]>([]);
  const [catalog, setCatalog] = useState<FeeRoute[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("deposit");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const [feesResponse, catalogResponse] = await Promise.all([
        api.get<any>("/admin/wallet-fees"),
        api.get<any>("/admin/wallet-fees/catalog"),
      ]);
      const feeRows = listFrom(feesResponse);
      const catalogRows = catalogRoutes(catalogResponse);
      const joined = feeRows.map((fee) => {
        const route = catalogRows.find((item) => item.route_id === fee.route_id);
        return { ...route, ...fee } as FeeRoute;
      });
      setRoutes(joined);
      setCatalog(catalogRows);
      setDrafts(Object.fromEntries(joined.map((route) => [route.route_id, {
        enabled: route.enabled !== false,
        rate: String(route.rate_percent ?? route.fee_percent ?? 0),
        fixedAmount: String(route.fixed_amount ?? route.fixed_fee_amount ?? 0),
      }])));
    } catch (e: any) {
      setError(e?.detail || e?.message || "Impossible de charger les frais des routes.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sortedRoutes = useMemo(() => [...routes].sort((a, b) => {
    const countryCompare = (a.country_name || a.country_code || "").localeCompare(b.country_name || b.country_code || "", "fr");
    return countryCompare || routeTitle(a).localeCompare(routeTitle(b), "fr");
  }), [routes]);
  const filteredRoutes = useMemo(() => sortedRoutes.filter((route) =>
    route.direction === directionFilter
    && (providerFilter === "all" || route.provider === providerFilter),
  ), [sortedRoutes, directionFilter, providerFilter]);

  const setDraft = (routeId: string, patch: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [routeId]: { ...current[routeId], ...patch } }));
    setSavedId((current) => current === routeId ? null : current);
  };

  const save = async (route: FeeRoute) => {
    const draft = drafts[route.route_id];
    const rate = Number(String(draft?.rate ?? "").replace(",", "."));
    const fixedAmount = Number(String(draft?.fixedAmount ?? "0").replace(",", "."));
    if (!Number.isFinite(rate) || rate < 0 || !Number.isFinite(fixedAmount) || fixedAmount < 0) {
      setError("Saisissez des frais valides, égaux ou supérieurs à zéro.");
      return;
    }
    setSavingId(route.route_id);
    setError("");
    setSavedId(null);
    try {
      await api.put(`/admin/wallet-fees/${encodeURIComponent(route.route_id)}`, {
        enabled: draft.enabled,
        rate_percent: rate,
        fixed_amount: fixedAmount,
      });
      setSavedId(route.route_id);
      await load(true);
      setSavedId(route.route_id);
    } catch (e: any) {
      setError(e?.detail || e?.message || "La configuration n’a pas pu être enregistrée.");
    } finally {
      setSavingId(null);
    }
  };

  const catalogOnly = catalog.filter((item) => !routes.some((route) => route.route_id === item.route_id));

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerIcon}
          accessibilityRole="button" accessibilityLabel="Retour">
          <Ionicons name="chevron-back" size={21} color={theme.colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>ESPACE ADMINISTRATEUR</Text>
          <Text style={styles.title}>Frais de paiement</Text>
          <Text style={styles.subtitle}>Configuration par pays, opérateur et prestataire.</Text>
        </View>
        <TouchableOpacity onPress={() => void load(true)} style={styles.headerIcon}
          accessibilityRole="button" accessibilityLabel="Actualiser les frais">
          <Ionicons name="refresh-outline" size={20} color={theme.colors.primary} />
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Ionicons name="alert-circle-outline" size={19} color={theme.colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={[styles.content, { maxWidth: width >= 920 ? 1060 : 720 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={theme.colors.primary} />}
      >
        <View style={styles.intro}>
          <View style={styles.introMark}>
            <Ionicons name="options-outline" size={21} color={theme.colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.introTitle}>Règles de frais</Text>
            <Text style={styles.introText}>Les paramètres enregistrés sont appliqués aux nouveaux devis. L’état de disponibilité reste celui du catalogue serveur.</Text>
          </View>
          <View style={styles.countBadge}><Text style={styles.countText}>{filteredRoutes.length} routes</Text></View>
        </View>

        <View style={styles.filters}>
          {([
            ["deposit", "Pay-in · Dépôts"],
            ["send", "Pay-out · Envois"],
          ] as const).map(([key, label]) => (
            <TouchableOpacity
              key={key}
              style={[styles.filterChip, directionFilter === key && styles.filterChipActive]}
              onPress={() => setDirectionFilter(key)}
              accessibilityRole="button"
              accessibilityState={{ selected: directionFilter === key }}
              testID={`wallet-fees-direction-${key}`}
            >
              <Text style={[styles.filterText, directionFilter === key && styles.filterTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={styles.filters}>
          {([
            ["all", "Tous les prestataires"],
            ["moneyfusion", "MoneyFusion"],
            ["biztranspay", "Biz-transPay"],
          ] as const).map(([key, label]) => (
            <TouchableOpacity
              key={key}
              style={[styles.providerChip, providerFilter === key && styles.providerChipActive]}
              onPress={() => setProviderFilter(key)}
              accessibilityRole="button"
              accessibilityState={{ selected: providerFilter === key }}
              testID={`wallet-fees-provider-${key}`}
            >
              <Text style={[styles.providerText, providerFilter === key && styles.providerTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? (
          <View style={styles.loadingWrap} accessibilityRole="progressbar" accessibilityLabel="Chargement des frais">
            {[0, 1, 2].map((item) => (
              <View key={item} style={styles.loadingCard}>
                <View style={styles.skeletonTitle} />
                <View style={styles.skeletonField} />
                <View style={styles.skeletonField} />
              </View>
            ))}
          </View>
        ) : filteredRoutes.length ? (
          <View style={styles.routeList}>
            {filteredRoutes.map((route) => {
              const draft = drafts[route.route_id] || { enabled: true, rate: "0", fixedAmount: "0" };
              const available = route.available === true;
              return (
                <Card key={route.route_id} style={styles.routeCard}>
                  <View style={styles.routeTop}>
                    <View style={[styles.routeMark, !available && styles.routeMarkUnavailable]}>
                      <Ionicons name={route.route_type === "crypto" ? "logo-bitcoin" : "phone-portrait-outline"}
                        size={19} color={available ? theme.colors.primary : theme.colors.textMuted} />
                    </View>
                    <View style={styles.routeCopy}>
                      <Text style={styles.routeName}>{routeTitle(route)}</Text>
                      <Text style={styles.routeMeta}>
                        {[route.direction === "deposit" ? "Pay-in" : "Pay-out",
                          route.country_name || route.country_code, route.currency,
                          route.route_type === "crypto" ? "Crypto" : "Mobile Money"]
                          .filter(Boolean).join(" · ")}
                      </Text>
                    </View>
                    <View style={[styles.statusPill, available ? styles.availablePill : styles.unavailablePill]}>
                      <View style={[styles.statusDot, available ? styles.availableDot : styles.unavailableDot]} />
                      <Text style={[styles.statusText, !available && styles.unavailableText]}>
                        {available ? "Disponible" : "Indisponible"}
                      </Text>
                    </View>
                  </View>

                  {!available ? (
                    <View style={styles.unavailableReason}>
                      <Ionicons name="information-circle-outline" size={16} color={theme.colors.danger} />
                      <Text style={styles.reasonText}>{route.unavailable_reason || "Motif non communiqué par le catalogue."}</Text>
                    </View>
                  ) : null}

                  <View style={styles.configRow}>
                    {route.direction === "send" && route.route_type === "crypto" ? (
                      <View style={styles.rateField}>
                        <Text style={styles.fieldLabel}>Frais fixes ({route.currency || route.asset_code})</Text>
                        <View style={styles.rateInputWrap}>
                          <TextInput
                            value={draft.fixedAmount}
                            onChangeText={(value) => setDraft(route.route_id, { fixedAmount: value })}
                            keyboardType="decimal-pad"
                            accessibilityLabel={`Frais fixes pour ${routeTitle(route)}`}
                            style={styles.rateInput}
                            placeholder="0"
                            placeholderTextColor={theme.colors.textMuted}
                          />
                          <Text style={styles.percentSign}>{route.currency || route.asset_code}</Text>
                        </View>
                      </View>
                    ) : null}
                    <View style={styles.rateField}>
                      <Text style={styles.fieldLabel}>
                        {route.direction === "send" && route.route_type === "crypto"
                          ? "Frais en pourcentage" : "Taux de frais"}
                      </Text>
                      <View style={styles.rateInputWrap}>
                        <TextInput
                          value={draft.rate}
                          onChangeText={(value) => setDraft(route.route_id, { rate: value })}
                          keyboardType="decimal-pad"
                          accessibilityLabel={`Taux de frais pour ${routeTitle(route)}`}
                          style={styles.rateInput}
                          placeholder="0"
                          placeholderTextColor={theme.colors.textMuted}
                        />
                        <Text style={styles.percentSign}>%</Text>
                      </View>
                    </View>
                    <View style={styles.toggleGroup}>
                      <Text style={styles.fieldLabel}>Configuration active</Text>
                      <TouchableOpacity
                        style={[styles.toggle, draft.enabled && styles.toggleOn]}
                        onPress={() => setDraft(route.route_id, { enabled: !draft.enabled })}
                        accessibilityRole="switch"
                        accessibilityState={{ checked: draft.enabled }}
                        accessibilityLabel={`Activer les frais pour ${routeTitle(route)}`}
                      >
                        <View style={[styles.toggleThumb, draft.enabled && styles.toggleThumbOn]} />
                        <Text style={[styles.toggleLabel, draft.enabled && styles.toggleLabelOn]}>
                          {draft.enabled ? "Activée" : "Désactivée"}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    <Button
                      title={savedId === route.route_id ? "Enregistré" : "Enregistrer"}
                      onPress={() => void save(route)}
                      loading={savingId === route.route_id}
                      disabled={savingId !== null}
                      variant={savedId === route.route_id ? "secondary" : "primary"}
                      style={styles.saveButton}
                      testID={`wallet-fee-save-${route.route_id}`}
                    />
                  </View>
                </Card>
              );
            })}
          </View>
        ) : (
          <Card style={styles.emptyCard}>
            <View style={styles.emptyMark}><Ionicons name="receipt-outline" size={25} color={theme.colors.primary} /></View>
            <Text style={styles.emptyTitle}>Aucune configuration de frais</Text>
            <Text style={styles.emptyText}>
              {routes.length
                ? "Aucune route de frais pour ce sens et ce prestataire."
                : catalogOnly.length
                  ? "Le catalogue contient des routes, mais aucune règle de frais n’est renvoyée par le serveur."
                  : "Aucune route de frais n’est disponible dans le catalogue serveur."}
            </Text>
            <Button title="Actualiser" onPress={() => void load()} variant="outline" />
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  header: { flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, backgroundColor: theme.colors.surface, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  headerIcon: { width: 42, height: 42, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceMuted },
  headerCopy: { flex: 1 },
  eyebrow: { color: theme.colors.primary, fontSize: 10, fontWeight: "900", letterSpacing: 1.2, marginBottom: 3 },
  title: { color: theme.colors.textPrimary, fontSize: 21, fontWeight: "900", letterSpacing: -0.4 },
  subtitle: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 3 },
  content: { width: "100%", alignSelf: "center", paddingHorizontal: 16, paddingTop: 18, paddingBottom: 44 },
  intro: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderRadius: theme.radius.lg, backgroundColor: theme.colors.primaryBg, borderWidth: 1, borderColor: "#D8E3FF", marginBottom: 16 },
  introMark: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface },
  introTitle: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: "900" },
  introText: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 3 },
  countBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: theme.colors.surface },
  countText: { color: theme.colors.primary, fontSize: 11, fontWeight: "900" },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 9 },
  filterChip: { paddingVertical: 10, paddingHorizontal: 13, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
  filterChipActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  filterText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: "800" },
  filterTextActive: { color: "#fff" },
  providerChip: { paddingVertical: 8, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
  providerChipActive: { borderColor: "#8FB0FF", backgroundColor: theme.colors.primaryBg },
  providerText: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: "800" },
  providerTextActive: { color: theme.colors.primaryDark },
  routeList: { gap: 12 },
  routeCard: { padding: 17, borderColor: theme.colors.border, borderRadius: theme.radius.lg },
  routeTop: { flexDirection: "row", alignItems: "center", gap: 11 },
  routeMark: { width: 42, height: 42, borderRadius: 14, backgroundColor: theme.colors.primaryBg, alignItems: "center", justifyContent: "center" },
  routeMarkUnavailable: { backgroundColor: theme.colors.surfaceSecondary },
  routeCopy: { flex: 1, minWidth: 0 },
  routeName: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: "900" },
  routeMeta: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 4 },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 999 },
  availablePill: { backgroundColor: theme.colors.successBg },
  unavailablePill: { backgroundColor: theme.colors.dangerBg },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  availableDot: { backgroundColor: theme.colors.success },
  unavailableDot: { backgroundColor: theme.colors.danger },
  statusText: { color: "#13744F", fontSize: 10, fontWeight: "900" },
  unavailableText: { color: theme.colors.danger },
  unavailableReason: { flexDirection: "row", alignItems: "flex-start", gap: 7, marginTop: 13, padding: 10, borderRadius: theme.radius.md, backgroundColor: theme.colors.dangerBg },
  reasonText: { flex: 1, color: theme.colors.danger, fontSize: 12, lineHeight: 17, fontWeight: "700" },
  configRow: { flexDirection: "row", alignItems: "flex-end", gap: 12, marginTop: 16, flexWrap: "wrap" },
  rateField: { minWidth: 130, flex: 1 },
  toggleGroup: { minWidth: 150 },
  fieldLabel: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: "800", marginBottom: 7 },
  rateInputWrap: { height: 46, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: theme.colors.borderStrong, borderRadius: theme.radius.md, paddingHorizontal: 12, backgroundColor: theme.colors.surface },
  rateInput: { flex: 1, color: theme.colors.textPrimary, fontSize: 15, fontWeight: "800", paddingVertical: 8 },
  percentSign: { color: theme.colors.textSecondary, fontSize: 14, fontWeight: "800" },
  toggle: { height: 46, flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: theme.colors.borderStrong, borderRadius: theme.radius.md, paddingHorizontal: 11, backgroundColor: theme.colors.surfaceMuted },
  toggleOn: { borderColor: "#A8E2C9", backgroundColor: theme.colors.successBg },
  toggleThumb: { width: 12, height: 12, borderRadius: 6, backgroundColor: theme.colors.textMuted },
  toggleThumbOn: { backgroundColor: theme.colors.success },
  toggleLabel: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: "800" },
  toggleLabelOn: { color: "#13744F" },
  saveButton: { minWidth: 124, paddingHorizontal: 15, paddingVertical: 11 },
  loadingWrap: { gap: 12 },
  loadingCard: { padding: 17, borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface, gap: 12 },
  skeletonTitle: { width: "58%", height: 16, borderRadius: 8, backgroundColor: theme.colors.surfaceSecondary },
  skeletonField: { height: 42, borderRadius: 10, backgroundColor: theme.colors.surfaceSecondary },
  errorBanner: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: theme.radius.md, backgroundColor: theme.colors.dangerBg },
  errorText: { flex: 1, color: theme.colors.danger, fontSize: 12, lineHeight: 17, fontWeight: "700" },
  emptyCard: { alignItems: "center", padding: 26, marginTop: 6 },
  emptyMark: { width: 52, height: 52, alignItems: "center", justifyContent: "center", borderRadius: 18, backgroundColor: theme.colors.primaryBg, marginBottom: 13 },
  emptyTitle: { color: theme.colors.textPrimary, fontSize: 16, fontWeight: "900", textAlign: "center" },
  emptyText: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 7, marginBottom: 15 },
});
