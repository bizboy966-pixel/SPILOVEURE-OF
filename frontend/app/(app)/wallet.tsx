import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { Input } from "@/src/components/Input";
import { Button } from "@/src/components/Button";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { useI18n } from "@/src/i18n";
import { localizedCountryName } from "@/src/identity/countrySearch";

type Country = { code: string; name: string; flag?: string };
type PayoutOperator = { code: string; name: string };
type PayoutCountry = { code: string; name: string; currency: string; operators: PayoutOperator[] };
type OperatorOption = { value: string; label: string };
type Method = "mobile" | "crypto";
const CRYPTO_ASSET_CODE = "USDT.BEP20";

function availableOperators(countries: PayoutCountry[], code: string): PayoutOperator[] {
  return countries.find((item) => item.code === code)?.operators || [];
}

export default function Wallet() {
  const router = useRouter();
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const [country, setCountry] = useState(user?.country || "TG");
  const [baseCountries, setBaseCountries] = useState<Country[]>([]);
  const [payoutCountries, setPayoutCountries] = useState<PayoutCountry[]>([]);
  const [payoutCatalogLoaded, setPayoutCatalogLoaded] = useState(false);
  const [payoutCatalogError, setPayoutCatalogError] = useState("");
  const [showCP, setShowCP] = useState(false);

  const [method, setMethod] = useState<Method>("mobile");
  const [profilesDraft, setProfilesDraft] = useState<Record<string, any>>({});
  const [operator, setOperator] = useState<string>("");
  const [phone, setPhone] = useState(user?.phone || "");
  const [fullName, setFullName] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.get<{ countries: Country[] }>("/config", { auth: false });
        setBaseCountries(cfg.countries);
      } catch {}
      try {
        const w = await api.get<any>("/wallet");
        if (w) {
          setCountry(w.country || country);
          setFullName(w.full_name || "");
          const savedProfiles = w.profiles && typeof w.profiles === "object" ? w.profiles : {};
          setProfilesDraft(savedProfiles);
          const m: Method = (w.method as Method) || (w.wallet_address ? "crypto" : "mobile");
          setMethod(m);
          if (m === "mobile") {
            setOperator(w.operator || "");
            setPhone(w.phone || "");
          } else {
            setWalletAddress(w.wallet_address || "");
          }
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    api.get<any>("/wallet/profile-catalog")
      .then((response) => {
        if (!active) return;
        setPayoutCountries(Array.isArray(response?.countries) ? response.countries : []);
        setPayoutCatalogError("");
      })
      .catch(() => {
        if (active) {
          setPayoutCountries([]);
          setPayoutCatalogError("Impossible de vérifier les moyens de retrait pour le moment.");
        }
      })
      .finally(() => {
        if (active) setPayoutCatalogLoaded(true);
      });
    return () => { active = false; };
  }, []);

  const countries = useMemo(() => {
    const merged = [...baseCountries];
    for (const item of payoutCountries) {
      if (!merged.some((existing) => existing.code === item.code)) {
        merged.push({ code: item.code, name: item.name || item.code });
      }
    }
    return merged;
  }, [baseCountries, payoutCountries]);

  const operators = useMemo<OperatorOption[]>(() => {
    return availableOperators(payoutCountries, country).map((item) => ({
      value: item.code,
      label: item.name || item.code,
    }));
  }, [payoutCountries, country]);

  const currentDraft = () => ({
    country, full_name: fullName, method,
    operator: method === "mobile" ? operator : "",
    phone: method === "mobile" ? phone : "",
    wallet_address: method === "crypto" ? walletAddress : "",
    asset_code: method === "crypto" ? CRYPTO_ASSET_CODE : "",
    network: method === "crypto" ? CRYPTO_ASSET_CODE : "",
  });

  const switchMethod = useCallback((next: Method) => {
    if (next === method) return;
    if (next === "mobile" && operators.length === 0) return;
    const nextProfiles = {
      ...profilesDraft,
      [method]: {
        country, full_name: fullName, method,
        operator: method === "mobile" ? operator : "",
        phone: method === "mobile" ? phone : "",
        wallet_address: method === "crypto" ? walletAddress : "",
        asset_code: method === "crypto" ? CRYPTO_ASSET_CODE : "",
        network: method === "crypto" ? CRYPTO_ASSET_CODE : "",
      },
    };
    setProfilesDraft(nextProfiles);
    const target = nextProfiles[next] || {};
    setMethod(next);
    setFullName(target.full_name || "");
    setOperator(next === "mobile" && !operators.some((item) => item.value === target.operator)
      ? operators[0]?.value || ""
      : target.operator || "");
    setPhone(target.phone || user?.phone || "");
    setWalletAddress(target.wallet_address || "");
  }, [country, fullName, method, operator, operators, phone, profilesDraft, user?.phone, walletAddress]);

  useEffect(() => {
    if (payoutCatalogLoaded && method === "mobile" && operators.length === 0) {
      switchMethod("crypto");
    }
  }, [method, operators.length, payoutCatalogLoaded, switchMethod]);

  const save = async () => {
    if (!country || !fullName.trim()) {
      Alert.alert(t("wallet.required_title"), t("wallet.required_error"));
      return;
    }
    if (method === "mobile" && (!operator || phone.trim().length < 8)) {
      Alert.alert(t("wallet.mobile_error_title"), t("wallet.mobile_error"));
      return;
    }
    if (method === "crypto" && walletAddress.trim().length < 12) {
      Alert.alert(t("wallet.crypto_error_title"), t("wallet.crypto_error"));
      return;
    }
    setLoading(true);
    try {
      await api.post("/wallet", {
        country,
        full_name: fullName,
        method,
        operator: method === "mobile" ? operator : "",
        phone: method === "mobile" ? phone : "",
        network: method === "crypto" ? CRYPTO_ASSET_CODE : "",
        asset_code: method === "crypto" ? CRYPTO_ASSET_CODE : "",
        wallet_address: method === "crypto" ? walletAddress.trim() : "",
      });
      setProfilesDraft((current) => ({ ...current, [method]: currentDraft() }));
    } catch (e: any) {
      Alert.alert(t("common.error"), e?.detail || t("wallet.save_error"));
      return;
    } finally { setLoading(false); }
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.alert(`✅ ${t("wallet.saved")}`);
    } else {
      Alert.alert("Portefeuille enregistré", t("wallet.saved"));
    }
  };

  const selectedCountry = countries.find((c) => c.code === country);

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}><Ionicons name="chevron-back" size={22} color="#fff" /></TouchableOpacity>
        <Text style={styles.title}>{t("wallet.title")}</Text>
        <Text style={styles.sub}>{t("wallet.subtitle")}</Text>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          <Text style={styles.step}>{t("wallet.step_country")}</Text>
          <TouchableOpacity style={styles.field} onPress={() => setShowCP(true)} testID="wallet-country-btn">
            <Text style={styles.fieldTxt}>
              {selectedCountry ? `${selectedCountry.flag ? `${selectedCountry.flag} ` : ""}${localizedCountryName(selectedCountry.code, selectedCountry.name, lang)}` : t("common.select")}
            </Text>
            <Ionicons name="chevron-down" size={18} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.step}>{t("wallet.step_method")}</Text>
          {!payoutCatalogLoaded ? (
            <Text style={styles.hint}>Vérification des modes de retrait disponibles…</Text>
          ) : null}
          <View style={styles.methodRow}>
            {operators.length > 0 ? (
              <TouchableOpacity
                style={[styles.methodBox, method === "mobile" && styles.methodBoxOn]}
                onPress={() => switchMethod("mobile")}
                testID="wallet-method-mobile"
              >
                <Ionicons name="phone-portrait" size={26} color={method === "mobile" ? "#fff" : theme.colors.primary} />
                <Text style={[styles.methodTxt, method === "mobile" && { color: "#fff" }]}>Mobile Money</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.methodBox, method === "crypto" && styles.methodBoxOn]}
              onPress={() => switchMethod("crypto")}
              testID="wallet-method-crypto"
            >
              <Ionicons name="logo-bitcoin" size={26} color={method === "crypto" ? "#fff" : "#F59E0B"} />
              <Text style={[styles.methodTxt, method === "crypto" && { color: "#fff" }]}>Crypto</Text>
            </TouchableOpacity>
          </View>
          {payoutCatalogError ? <Text style={styles.hint}>{payoutCatalogError}</Text> : null}
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.step}>{t("wallet.step_details")}</Text>

          <Input label={t("wallet.holder_name")} value={fullName} onChangeText={setFullName} placeholder={t("wallet.full_name_placeholder")} testID="wallet-fullname" />

          {method === "mobile" ? (
            <>
              <Text style={styles.lbl}>{t("wallet.operator")}</Text>
              <View style={styles.opRow}>
                {operators.map((op) => (
                  <TouchableOpacity
                    key={op.value}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: operator === op.value }}
                    style={[styles.opChip, operator === op.value && styles.opChipOn]}
                    onPress={() => setOperator(op.value)}
                    testID={`wallet-operator-${op.value}`}
                  >
                    <Text style={[styles.opTxt, operator === op.value && { color: "#fff" }]}>{op.label}</Text>
                  </TouchableOpacity>
                ))}
                {!payoutCatalogLoaded && operators.length === 0 && (
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                    Vérification des opérateurs disponibles…
                  </Text>
                )}
              </View>
              <Input label={t("wallet.phone")} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Ex: +22890000000" testID="wallet-phone" />
            </>
          ) : (
            <>
              <Input
                label="Adresse de retrait USDT BEP20"
                value={walletAddress}
                onChangeText={setWalletAddress}
                placeholder="0x..."
                autoCapitalize="none"
                autoCorrect={false}
                testID="wallet-address"
              />
              <Text style={styles.hint}>
                {t("wallet.address_warning")}
              </Text>
            </>
          )}
        </Card>

        <View style={{ marginTop: 16 }}>
          <Button
            title={t("wallet.save")}
            icon={<Ionicons name="save" size={18} color="#fff" />}
            onPress={save}
            loading={loading}
            disabled={loading}
            testID="wallet-save-btn"
          />
        </View>
      </ScrollView>

      {/* Country picker */}
      <Modal visible={showCP} transparent animationType="fade" onRequestClose={() => setShowCP(false)}>
        <Pressable style={styles.modalBg} onPress={() => setShowCP(false)}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t("wallet.select_country")}</Text>
            <ScrollView>
              {countries.map((c) => (
                <TouchableOpacity
                  key={c.code}
                  style={styles.countryRow}
                  onPress={() => {
                    if (c.code !== country) {
                      if (payoutCatalogLoaded && method === "mobile"
                        && availableOperators(payoutCountries, c.code).length === 0) {
                        switchMethod("crypto");
                      } else {
                        setOperator("");
                      }
                    }
                    setCountry(c.code);
                    setShowCP(false);
                  }}
                  testID={`wallet-country-${c.code}`}
                >
                  <Text style={styles.countryRowTxt}>{c.flag ? `${c.flag} ` : ""}{localizedCountryName(c.code, c.name, lang)}</Text>
                  {country === c.code ? <Ionicons name="checkmark" size={18} color={theme.colors.success} /> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 22, paddingBottom: 18 },
  back: { width: 36, height: 36, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 6 },
  title: { color: "#fff", fontSize: 22, fontWeight: "800" },
  sub: { color: "#C7D9FF", marginTop: 2, fontSize: 12 },
  step: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 14, marginBottom: 8 },
  field: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  fieldTxt: { color: theme.colors.textPrimary, fontWeight: "600" },
  methodRow: { flexDirection: "row", gap: 10 },
  methodBox: { flex: 1, alignItems: "center", padding: 16, borderRadius: 16, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 2, borderColor: "transparent" },
  methodBoxOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  methodTxt: { marginTop: 6, fontWeight: "700", color: theme.colors.textPrimary, fontSize: 13 },
  lbl: { fontWeight: "700", color: theme.colors.textPrimary, fontSize: 12, marginTop: 8, marginBottom: 4 },
  opRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  opChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 22, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  opChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  opTxt: { color: theme.colors.textPrimary, fontWeight: "600", fontSize: 12 },
  networkChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#FEF3C7", padding: 8, borderRadius: 12, marginBottom: 4 },
  networkTxt: { color: "#92400E", fontWeight: "700", fontSize: 12 },
  hint: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 6, fontStyle: "italic" },

  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", padding: 20 },
  modalCard: { backgroundColor: theme.colors.surface, borderRadius: 20, padding: 16, width: "100%", maxWidth: 400, maxHeight: "80%" },
  modalTitle: { fontWeight: "800", fontSize: 16, color: theme.colors.textPrimary, marginBottom: 12 },
  countryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  countryRowTxt: { color: theme.colors.textPrimary, fontSize: 14 },
});
