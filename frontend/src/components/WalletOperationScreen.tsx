import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, Linking, Modal, Platform, Pressable, RefreshControl,
  StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Input } from "@/src/components/Input";
import { KeyboardAwareScrollView } from "@/src/components/KeyboardAwareScrollView";
import { theme } from "@/src/theme";

type Direction = "deposit" | "send";
type Route = {
  route_id: string;
  provider: string;
  provider_name: string;
  country_code: string;
  country_name: string;
  operator_code?: string;
  operator_name?: string;
  currency: string;
  asset_code?: string;
  route_type: "mobile" | "crypto";
  available: boolean;
  unavailable_reason?: string;
  fee_percent: number;
};
type CatalogCountry = {
  code: string;
  name: string;
  currency: string;
  operators: Route[];
};
type Wallet = { asset_code: string; balance: number };
type Catalog = { countries: CatalogCountry[]; crypto_assets: Route[]; wallets: Wallet[] };

function notify(title: string, message: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.alert(`${title}\n\n${message}`);
  } else {
    Alert.alert(title, message);
  }
}

function fmt(value: number, currency: string) {
  const decimals = currency.includes(".") || /^(USDT|USDC|BTC|ETH)/i.test(currency) ? 6 : 0;
  return `${Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 0, maximumFractionDigits: decimals,
  })} ${currency}`;
}

export default function WalletOperationScreen({ direction }: { direction: Direction }) {
  const router = useRouter();
  const isDeposit = direction === "deposit";
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [picker, setPicker] = useState<"country" | "operator" | "wallet" | null>(null);
  const [countryCode, setCountryCode] = useState("");
  const [routeId, setRouteId] = useState("");
  const [walletAsset, setWalletAsset] = useState("XOF");
  const [amount, setAmount] = useState("");
  const [feePayer, setFeePayer] = useState<"client" | "sender">("client");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [fullName, setFullName] = useState("");
  const [otp, setOtp] = useState("");
  const [ussdAuthorized, setUssdAuthorized] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");

  const loadCatalog = useCallback(async (refresh = false) => {
    if (!refresh) setLoading(true);
    try {
      const response = await api.get<Catalog>(`/wallet-operations/catalog?direction=${direction}`);
      setCatalog(response);
      setCountryCode((current) => current || response.countries?.[0]?.code || "");
      setWalletAsset((current) => response.wallets?.some((wallet) => wallet.asset_code === current)
        ? current : response.wallets?.[0]?.asset_code || "XOF");
      setError("");
    } catch (e: any) {
      setError(e?.detail || e?.message || "Impossible de charger les catalogues de paiement.");
    } finally {
      setLoading(false);
    }
  }, [direction]);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  const country = useMemo(
    () => catalog?.countries?.find((row) => row.code === countryCode) || null,
    [catalog, countryCode],
  );
  const mobileRoutes = useMemo(() => country?.operators || [], [country]);
  const cryptoRoutes = useMemo(() => catalog?.crypto_assets || [], [catalog]);
  const selectedRoute = useMemo(() => {
    const routes = [...mobileRoutes, ...cryptoRoutes];
    return routes.find((route) => route.route_id === routeId) || null;
  }, [mobileRoutes, cryptoRoutes, routeId]);
  const selectedWallet = catalog?.wallets?.find((wallet) => wallet.asset_code === walletAsset);
  const enteredAmount = Number(String(amount).replace(",", ".")) || 0;

  const selectRoute = (route: Route) => {
    if (!route.available) {
      notify("Route indisponible", route.unavailable_reason || "Cette route est désactivée.");
      return;
    }
    setRouteId(route.route_id);
    setQuote(null);
    setResult(null);
    setError("");
    setPicker(null);
  };

  const createQuote = async () => {
    setError("");
    setResult(null);
    if (!countryCode) return setError("Choisissez un pays.");
    if (!selectedRoute) return setError("Choisissez un opérateur ou un réseau crypto.");
    if (enteredAmount <= 0) return setError("Saisissez un montant supérieur à zéro.");
    setBusy(true);
    try {
      const response = await api.post<any>("/wallet-operations/quote", {
        direction, route_id: selectedRoute.route_id, amount: enteredAmount,
        fee_payer: feePayer, ...(isDeposit ? {} : { wallet_asset: walletAsset }),
      });
      setQuote(response);
    } catch (e: any) {
      setError(e?.detail || e?.message || "Impossible de calculer les frais.");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!quote?.quote_id) return;
    if (isDeposit && !email.trim()) return setError("Saisissez votre adresse e-mail.");
    if (selectedRoute?.route_type === "mobile" && !phone.trim()) return setError(
      isDeposit ? "Saisissez le numéro à débiter." : "Saisissez le numéro du bénéficiaire.",
    );
    if (!isDeposit && !fullName.trim()) return setError("Saisissez le nom complet du bénéficiaire.");
    setBusy(true);
    setError("");
    try {
      const response = await api.post<any>("/wallet-operations/submit", {
        quote_id: quote.quote_id, phone: phone.trim() || undefined,
        email: email.trim(), full_name: fullName.trim() || undefined,
        otp: otp.trim() || undefined, ussd_authorized: ussdAuthorized,
      });
      if (response.status === "ussd_authorization_required") {
        setResult(response);
        return;
      }
      if (response.status === "otp_sent" || response.status === "otp_required") {
        setResult(response);
        return;
      }
      setResult(response);
      if (response.redirect_url) {
        try { await Linking.openURL(response.redirect_url); }
        catch { setError("Paiement créé, mais le lien externe n’a pas pu s’ouvrir."); }
      }
    } catch (e: any) {
      setError(e?.detail || e?.message || "L’opération n’a pas pu être lancée.");
    } finally {
      setBusy(false);
    }
  };

  const refreshStatus = async () => {
    if (!result?.reference) return;
    setBusy(true);
    try {
      const response = await api.get<any>(
        `/wallet-operations/transactions/${encodeURIComponent(result.reference)}`,
      );
      setResult((current: any) => ({ ...current, ...response }));
    } catch (e: any) {
      setError(e?.detail || e?.message || "Impossible de vérifier le statut.");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setAmount(""); setPhone(""); setFullName(""); setEmail(""); setOtp("");
    setQuote(null); setResult(null); setUssdAuthorized(false); setRouteId("");
  };

  const routeLabel = (route: Route | null) => route
    ? route.route_type === "crypto"
      ? `${route.asset_code} · ${route.provider_name}`
      : `${route.operator_name} · ${route.provider_name}`
    : "Choisir";

  return (
    <SafeAreaView style={styles.screen}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back} accessibilityLabel="Retour">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{isDeposit ? "Dépôt" : "Envoyer"}</Text>
          <Text style={styles.headerSubtitle}>
            {isDeposit ? "Mobile Money ou crypto" : "Envoi Mobile Money par pays"}
          </Text>
        </View>
        <TouchableOpacity onPress={() => void loadCatalog(true)} style={styles.refresh} accessibilityLabel="Actualiser">
          <Ionicons name="refresh" size={19} color="#fff" />
        </TouchableOpacity>
      </LinearGradient>

      <KeyboardAwareScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadCatalog(true)} tintColor={theme.colors.primary} />}
      >
        {loading && !catalog ? (
          <View style={styles.loadingPanel} accessibilityRole="progressbar" accessibilityLabel="Chargement du catalogue">
            <View style={styles.skeletonHeading} />
            <View style={styles.skeletonLine} />
            <View style={styles.skeletonField} />
            <View style={styles.skeletonField} />
            <View style={styles.skeletonField} />
          </View>
        ) : error && !catalog ? (
          <Card style={styles.loadErrorCard}>
            <View style={styles.loadErrorIcon}>
              <Ionicons name="cloud-offline-outline" size={22} color={theme.colors.danger} />
            </View>
            <Text style={styles.sectionTitle}>Catalogue indisponible</Text>
            <Text style={styles.helper} accessibilityRole="alert">{error}</Text>
            <Button title="Réessayer" onPress={() => void loadCatalog()} loading={loading} />
          </Card>
        ) : (
          <>
            <Card>
              <Text style={styles.sectionTitle}>{isDeposit ? "Informations du dépôt" : "Informations de l’envoi"}</Text>
              <Text style={styles.helper}>
                Le pays, l’opérateur et le prestataire sont vérifiés ensemble. Les routes désactivées restent visibles avec leur motif.
              </Text>
              <Selector
                label="Pays"
                value={country?.name || ""}
                onPress={() => setPicker("country")}
                testID="wallet-country-picker"
              />
              <Selector
                label={isDeposit ? "Opérateur ou réseau" : "Opérateur"}
                value={routeLabel(selectedRoute)}
                onPress={() => setPicker("operator")}
                testID="wallet-route-picker"
              />
              {!isDeposit ? (
                <Selector
                  label="Portefeuille à débiter"
                  value={selectedWallet
                    ? `${selectedWallet.asset_code} · ${fmt(selectedWallet.balance, selectedWallet.asset_code)}`
                    : "Aucun solde disponible"}
                  onPress={() => setPicker("wallet")}
                  testID="wallet-source-picker"
                />
              ) : null}
              <Input
                label={`Montant (${selectedRoute?.currency || country?.currency || "devise"})`}
                placeholder="Saisir le montant"
                keyboardType="decimal-pad"
                value={amount}
                onChangeText={(value) => { setAmount(value); setQuote(null); setResult(null); }}
                testID="wallet-amount"
              />
              {isDeposit || selectedRoute?.route_type === "crypto" ? (
                <>
                  <Input label="E-mail" placeholder="nom@exemple.com" keyboardType="email-address"
                    autoCapitalize="none" value={email} onChangeText={setEmail} testID="wallet-email" />
                  <Input label="Nom complet" placeholder="Votre nom complet"
                    value={fullName} onChangeText={setFullName} testID="wallet-full-name" />
                </>
              ) : (
                <>
                  <Input label="Nom complet du bénéficiaire" placeholder="Nom complet"
                    value={fullName} onChangeText={setFullName} testID="wallet-recipient-name" />
                  <Input label="Numéro du bénéficiaire" placeholder="Numéro Mobile Money"
                    keyboardType="phone-pad" value={phone} onChangeText={setPhone}
                    testID="wallet-recipient-phone" />
                </>
              )}
              {isDeposit && selectedRoute?.route_type === "mobile" ? (
                <Input label="Numéro à débiter" placeholder="Numéro Mobile Money"
                  keyboardType="phone-pad" value={phone} onChangeText={setPhone}
                  testID="wallet-deposit-phone" />
              ) : null}
            </Card>

            <Card style={{ marginTop: 12 }}>
              <Text style={styles.sectionTitle}>Qui paie les frais ?</Text>
              <View style={styles.feeChoices}>
                {([
                  ["client", "Le client paie les frais"],
                  ["sender", "L’expéditeur paie les frais"],
                ] as const).map(([key, label]) => (
                  <TouchableOpacity
                    key={key}
                    style={[styles.feeChoice, feePayer === key && styles.feeChoiceSelected]}
                    onPress={() => { setFeePayer(key); setQuote(null); }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: feePayer === key }}
                    testID={`wallet-fee-payer-${key}`}
                  >
                    <Ionicons name={feePayer === key ? "radio-button-on" : "radio-button-off"}
                      size={18} color={feePayer === key ? theme.colors.primary : theme.colors.textSecondary} />
                    <Text style={[styles.feeChoiceText, feePayer === key && { color: theme.colors.primary }]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              {selectedRoute ? (
                <Text style={styles.feeRate}>
                  Frais configurés : {selectedRoute.fee_percent}% · {selectedRoute.provider_name}
                </Text>
              ) : null}
            </Card>

            {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}

            {quote ? (
              <Card style={styles.summary} testID="wallet-summary">
                <Text style={styles.sectionTitle}>Résumé avant validation</Text>
                <SummaryRow label="Montant" value={fmt(quote.amount, quote.currency)} />
                <SummaryRow label={`Frais (${quote.fee_percent}%)`} value={fmt(quote.fee_amount, quote.currency)} />
                <SummaryRow label="Montant payé" value={fmt(quote.total_amount, quote.currency)} strong />
                <SummaryRow
                  label={isDeposit ? "Crédit portefeuille" : "Débit portefeuille"}
                  value={fmt(isDeposit ? quote.wallet_credit : quote.wallet_debit, isDeposit ? quote.currency : walletAsset)}
                  strong
                />
                {!isDeposit ? <SummaryRow label="Montant envoyé" value={fmt(quote.provider_amount, quote.currency)} /> : null}
                <Text style={styles.helper}>Ce devis expire dans 10 minutes. Les frais sont recalculés et vérifiés côté serveur.</Text>
                <Button title={isDeposit ? "Déclarer le dépôt" : "Déclarer l’envoi"}
                  onPress={() => void submit()} loading={busy} disabled={!selectedRoute?.available}
                  testID="wallet-submit" style={{ marginTop: 8 }} />
              </Card>
            ) : (
              <Button
                title="Calculer les frais et voir le résumé"
                onPress={() => void createQuote()}
                loading={busy}
                disabled={!selectedRoute?.available || enteredAmount <= 0}
                testID="wallet-create-quote"
                style={{ marginTop: 12 }}
              />
            )}

            {result ? (
              <Card style={styles.resultCard} testID="wallet-operation-result">
                <View style={styles.resultHeading}>
                  <Ionicons
                    name={result.status === "paid" || result.status === "completed" ? "checkmark-circle" : "time"}
                    size={25} color={result.status === "paid" || result.status === "completed" ? theme.colors.success : theme.colors.primary}
                  />
                  <Text style={styles.sectionTitle}>{result.status === "paid" || result.status === "completed"
                    ? "Opération confirmée" : "Opération en cours"}</Text>
                </View>
                {result.message ? <Text style={styles.helper}>{result.message}</Text> : null}
                {result.steps?.map((step: string, index: number) => (
                  <Text key={`${index}-${step}`} style={styles.step}>{step}</Text>
                ))}
                {result.ussd ? <Text style={styles.ussd}>{result.ussd}</Text> : null}
                {result.status === "ussd_authorization_required" ? (
                  <Button title="J’ai autorisé le paiement" variant="outline"
                    onPress={() => { setUssdAuthorized(true); setResult(null); }}
                    testID="wallet-ussd-confirm" style={{ marginTop: 8 }} />
                ) : null}
                {result.status === "otp_sent" || result.status === "otp_required" ? (
                  <>
                    <Input label="Code OTP" value={otp} onChangeText={setOtp}
                      keyboardType="number-pad" testID="wallet-otp" />
                    <Button title="Continuer avec le code" onPress={() => void submit()}
                      loading={busy} testID="wallet-otp-submit" />
                  </>
                ) : null}
                {result.deposit_address ? (
                  <>
                    <Text style={styles.helper}>Adresse de dépôt · {result.asset_code || selectedRoute?.asset_code}</Text>
                    <Text selectable style={styles.address}>{result.deposit_address}</Text>
                    <Text style={styles.helper}>
                      Envoyez exactement {fmt(result.amount_to_send || quote?.provider_amount, result.asset_code || selectedRoute?.asset_code || "")}.
                      La mise à jour du solde intervient après confirmation du prestataire.
                    </Text>
                  </>
                ) : null}
                {result.redirect_url ? (
                  <Button title="Ouvrir la page de paiement" onPress={() => void Linking.openURL(result.redirect_url)}
                    variant="outline" style={{ marginTop: 8 }} />
                ) : null}
                {result.reference ? (
                  <>
                    <Text style={styles.reference}>Référence : {result.reference}</Text>
                    {!["paid", "completed", "rejected", "failed"].includes(result.status) ? (
                      <Button title="Actualiser le statut" onPress={() => void refreshStatus()}
                        loading={busy} variant="outline" testID="wallet-refresh-status"
                        style={{ marginTop: 8 }} />
                    ) : null}
                  </>
                ) : null}
                <Button title="Nouvelle opération" onPress={reset} variant="secondary"
                  style={{ marginTop: 10 }} testID="wallet-reset" />
              </Card>
            ) : null}
          </>
        )}
      </KeyboardAwareScrollView>

      <Modal visible={!!picker} transparent animationType="fade" onRequestClose={() => setPicker(null)} accessibilityViewIsModal>
        <Pressable style={styles.modalBackdrop} onPress={() => setPicker(null)}>
          <Pressable style={styles.modalPanel} onPress={(event) => event.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {picker === "country" ? "Choisir un pays" :
                  picker === "wallet" ? "Choisir un portefeuille" : "Choisir un opérateur ou un réseau"}
              </Text>
              <TouchableOpacity onPress={() => setPicker(null)} accessibilityLabel="Fermer">
                <Ionicons name="close" size={22} color={theme.colors.textPrimary} />
              </TouchableOpacity>
            </View>
            <KeyboardAwareScrollView style={{ maxHeight: "75%" }} keyboardShouldPersistTaps="handled">
              {picker === "country" ? (catalog?.countries || []).map((row) => (
                <TouchableOpacity key={row.code} style={styles.optionRow} onPress={() => {
                  setCountryCode(row.code); setRouteId(""); setQuote(null); setResult(null); setPicker(null);
                }}>
                  <Text style={styles.optionTitle}>{row.name}</Text>
                  <Text style={styles.optionSub}>{row.currency}</Text>
                </TouchableOpacity>
              )) : picker === "wallet" ? (catalog?.wallets || []).map((wallet) => (
                <TouchableOpacity key={wallet.asset_code} style={styles.optionRow} onPress={() => {
                  setWalletAsset(wallet.asset_code); setQuote(null); setPicker(null);
                }}>
                  <Text style={styles.optionTitle}>{wallet.asset_code}</Text>
                  <Text style={styles.optionSub}>{fmt(wallet.balance, wallet.asset_code)}</Text>
                </TouchableOpacity>
              )) : (
                <>
                  {mobileRoutes.map((route) => (
                    <RouteOption key={route.route_id} route={route}
                      selected={route.route_id === routeId} onPress={() => selectRoute(route)} />
                  ))}
                  {isDeposit && cryptoRoutes.length ? (
                    <>
                      <Text style={styles.optionGroup}>Crypto (disponible dans tous les pays)</Text>
                      {cryptoRoutes.map((route) => (
                        <RouteOption key={route.route_id} route={route}
                          selected={route.route_id === routeId} onPress={() => selectRoute(route)} />
                      ))}
                    </>
                  ) : null}
                  {!mobileRoutes.length && (!isDeposit || !cryptoRoutes.length) ? (
                    <Text style={styles.empty}>Aucune route trouvée dans le catalogue actuel.</Text>
                  ) : null}
                </>
              )}
            </KeyboardAwareScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function Selector({ label, value, onPress, testID }: {
  label: string; value: string; onPress: () => void; testID: string;
}) {
  return (
    <View style={{ marginBottom: theme.spacing.md }}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TouchableOpacity style={styles.selector} onPress={onPress} testID={testID}
        accessibilityRole="button" accessibilityLabel={`${label} : ${value || "Choisir"}`}>
        <Text style={styles.selectorValue} numberOfLines={1}>{value || "Choisir"}</Text>
        <Ionicons name="chevron-down" size={18} color={theme.colors.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}

function RouteOption({ route, selected, onPress }: {
  route: Route; selected: boolean; onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.optionRow, selected && styles.optionSelected, !route.available && styles.optionUnavailable]}
      onPress={onPress}
      disabled={!route.available}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: !route.available }}
      accessibilityLabel={`${route.route_type === "crypto" ? route.asset_code : route.operator_name} · ${route.provider_name}${route.available ? "" : ` · Indisponible : ${route.unavailable_reason || "Indisponible"}`}`}
      testID={`wallet-route-option-${route.route_id}`}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.optionTitle}>
          {route.route_type === "crypto" ? route.asset_code : `${route.operator_name} · ${route.currency}`}
        </Text>
        <Text style={styles.optionSub}>{route.provider_name} · {route.fee_percent}%</Text>
        {!route.available ? <Text style={styles.optionError}>{route.unavailable_reason || "Indisponible"}</Text> : null}
      </View>
      <Ionicons
        name={route.available ? selected ? "checkmark-circle" : "chevron-forward" : "close-circle"}
        size={20} color={route.available ? selected ? theme.colors.primary : theme.colors.textSecondary : theme.colors.danger}
      />
    </TouchableOpacity>
  );
}

function SummaryRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={[styles.summaryLabel, strong && styles.summaryStrong]}>{label}</Text>
      <Text style={[styles.summaryValue, strong && styles.summaryStrong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  header: { minHeight: 74, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10 },
  back: { width: 42, height: 42, alignItems: "center", justifyContent: "center", marginRight: 6 },
  refresh: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.16)" },
  headerTitle: { color: "#fff", fontSize: 19, fontWeight: "900" },
  headerSubtitle: { color: "#DBEAFE", fontSize: 12, marginTop: 2 },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 48, gap: 12 },
  loadingPanel: { marginTop: 18, padding: 18, borderRadius: theme.radius.lg, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, gap: 14 },
  skeletonHeading: { width: "54%", height: 19, borderRadius: 8, backgroundColor: theme.colors.surfaceSecondary },
  skeletonLine: { width: "88%", height: 11, borderRadius: 6, backgroundColor: theme.colors.surfaceSecondary },
  skeletonField: { height: 48, borderRadius: theme.radius.md, backgroundColor: theme.colors.surfaceSecondary },
  loadErrorCard: { marginTop: 18, alignItems: "flex-start", borderColor: theme.colors.dangerBg },
  loadErrorIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: theme.colors.dangerBg, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  sectionTitle: { color: theme.colors.textPrimary, fontSize: 17, fontWeight: "900", marginBottom: 6 },
  helper: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, marginBottom: 8 },
  inputLabel: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "700", marginBottom: 6 },
  selector: { minHeight: 50, borderWidth: 1, borderColor: theme.colors.borderStrong, borderRadius: theme.radius.md, backgroundColor: "#fff", paddingHorizontal: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  selectorValue: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: "700", flex: 1, marginRight: 8 },
  feeChoices: { gap: 8, marginTop: 5 },
  feeChoice: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 11, flexDirection: "row", alignItems: "center", gap: 8 },
  feeChoiceSelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryBg },
  feeChoiceText: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13, flex: 1 },
  feeRate: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 10 },
  summary: { borderColor: "#BFD2FF" },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  summaryLabel: { color: theme.colors.textSecondary, fontSize: 13, flex: 1 },
  summaryValue: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "700", textAlign: "right" },
  summaryStrong: { color: theme.colors.textPrimary, fontWeight: "900" },
  resultCard: { marginBottom: 18, borderColor: "#CFE0FF" },
  resultHeading: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  step: { color: theme.colors.textPrimary, fontSize: 13, lineHeight: 19, marginBottom: 5 },
  ussd: { color: theme.colors.primaryDark, fontSize: 16, fontWeight: "900", padding: 12, backgroundColor: theme.colors.primaryBg, borderRadius: 10, textAlign: "center" },
  address: { color: theme.colors.textPrimary, fontSize: 13, lineHeight: 19, padding: 12, backgroundColor: theme.colors.surfaceSecondary, borderRadius: 10, marginVertical: 8 },
  reference: { color: theme.colors.textMuted, fontSize: 11, marginTop: 10 },
  error: { color: theme.colors.danger, fontWeight: "700", marginHorizontal: 3, marginTop: 5 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(8,20,46,0.55)", justifyContent: "center", padding: 18 },
  modalPanel: { backgroundColor: "#fff", borderRadius: 20, padding: 16, maxHeight: "82%", ...theme.shadow.lifted },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border, marginBottom: 4 },
  modalTitle: { color: theme.colors.textPrimary, fontSize: 17, fontWeight: "900", flex: 1 },
  optionRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  optionSelected: { backgroundColor: theme.colors.primaryBg },
  optionUnavailable: { opacity: 0.75 },
  optionTitle: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: "800" },
  optionSub: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 3 },
  optionError: { color: theme.colors.danger, fontSize: 11, marginTop: 4 },
  optionGroup: { color: theme.colors.primaryDark, fontSize: 13, fontWeight: "900", padding: 12, backgroundColor: theme.colors.primaryBg },
  empty: { color: theme.colors.textSecondary, textAlign: "center", padding: 20 },
});
