import React, { useEffect, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View, TouchableOpacity } from "react-native";
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

type Country = { code: string; name: string; flag: string };
type Method = "mobile" | "crypto";

export default function Wallet() {
  const router = useRouter();
  const { user } = useAuth();
  const [country, setCountry] = useState(user?.country || "TG");
  const [countries, setCountries] = useState<Country[]>([]);
  const [showCP, setShowCP] = useState(false);

  const [method, setMethod] = useState<Method>("mobile");
  const [operators, setOperators] = useState<string[]>([]);
  const [operator, setOperator] = useState<string>("");
  const [phone, setPhone] = useState(user?.phone || "");
  const [fullName, setFullName] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.get<{ countries: Country[]; operators_by_country: Record<string, string[]> }>(
          "/config", { auth: false },
        );
        setCountries(cfg.countries);
        setOperators(cfg.operators_by_country[country] || []);
      } catch {}
      try {
        const w = await api.get<any>("/wallet");
        if (w) {
          setCountry(w.country || country);
          setFullName(w.full_name || "");
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
    api.get<{ operators_by_country: Record<string, string[]> }>("/config", { auth: false })
      .then((cfg) => setOperators(cfg.operators_by_country[country] || []))
      .catch(() => {});
  }, [country]);

  const save = async () => {
    if (!country || !fullName.trim()) {
      Alert.alert("Champs requis", "Pays et nom du titulaire sont obligatoires.");
      return;
    }
    if (method === "mobile" && (!operator || phone.trim().length < 8)) {
      Alert.alert("Mobile Money", "Opérateur et numéro de téléphone valide requis.");
      return;
    }
    if (method === "crypto" && walletAddress.trim().length < 12) {
      Alert.alert("Crypto", "Adresse wallet USDT BEP20 invalide.");
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
        network: method === "crypto" ? "USDT BEP20" : "",
        wallet_address: method === "crypto" ? walletAddress.trim() : "",
      });
      if (typeof window !== "undefined") window.alert("✅ Portefeuille enregistré");
      else Alert.alert("✅", "Portefeuille enregistré");
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Sauvegarde impossible.");
    } finally { setLoading(false); }
  };

  const selectedCountry = countries.find((c) => c.code === country);

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}><Ionicons name="chevron-back" size={22} color="#fff" /></TouchableOpacity>
        <Text style={styles.title}>Configurer mon portefeuille</Text>
        <Text style={styles.sub}>Suivez les étapes pour recevoir vos retraits.</Text>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Card>
          <Text style={styles.step}>Étape 1 — 🌍 Sélectionner le pays</Text>
          <TouchableOpacity style={styles.field} onPress={() => setShowCP(true)} testID="wallet-country-btn">
            <Text style={styles.fieldTxt}>
              {selectedCountry ? `${selectedCountry.flag} ${selectedCountry.name}` : "Sélectionner..."}
            </Text>
            <Ionicons name="chevron-down" size={18} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.step}>Étape 2 — 💰 Choisir le mode de retrait</Text>
          <View style={styles.methodRow}>
            <TouchableOpacity
              style={[styles.methodBox, method === "mobile" && styles.methodBoxOn]}
              onPress={() => setMethod("mobile")}
              testID="wallet-method-mobile"
            >
              <Ionicons name="phone-portrait" size={26} color={method === "mobile" ? "#fff" : theme.colors.primary} />
              <Text style={[styles.methodTxt, method === "mobile" && { color: "#fff" }]}>Mobile Money</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.methodBox, method === "crypto" && styles.methodBoxOn]}
              onPress={() => setMethod("crypto")}
              testID="wallet-method-crypto"
            >
              <Ionicons name="logo-bitcoin" size={26} color={method === "crypto" ? "#fff" : "#F59E0B"} />
              <Text style={[styles.methodTxt, method === "crypto" && { color: "#fff" }]}>Crypto (USDT BEP20)</Text>
            </TouchableOpacity>
          </View>
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.step}>Étape 3 — Informations</Text>

          <Input label="Nom du titulaire" value={fullName} onChangeText={setFullName} placeholder="Nom complet" testID="wallet-fullname" />

          {method === "mobile" ? (
            <>
              <Text style={styles.lbl}>📱 Opérateur Mobile Money</Text>
              <View style={styles.opRow}>
                {operators.map((op) => (
                  <TouchableOpacity
                    key={op}
                    style={[styles.opChip, operator === op && styles.opChipOn]}
                    onPress={() => setOperator(op)}
                    testID={`wallet-operator-${op}`}
                  >
                    <Text style={[styles.opTxt, operator === op && { color: "#fff" }]}>{op}</Text>
                  </TouchableOpacity>
                ))}
                {operators.length === 0 && (
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                    Aucun opérateur configuré pour ce pays.
                  </Text>
                )}
              </View>
              <Input label="☎️ Numéro de téléphone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Ex: +22890000000" testID="wallet-phone" />
            </>
          ) : (
            <>
              <View style={styles.networkChip}>
                <Ionicons name="logo-bitcoin" size={16} color="#F59E0B" />
                <Text style={styles.networkTxt}>Réseau : USDT BEP20</Text>
              </View>
              <Input
                label="📥 Adresse wallet USDT BEP20"
                value={walletAddress}
                onChangeText={setWalletAddress}
                placeholder="0x..."
                autoCapitalize="none"
                autoCorrect={false}
                testID="wallet-address"
              />
              <Text style={styles.hint}>
                ⚠️ Vérifiez attentivement votre adresse — toute erreur entraîne une perte définitive des fonds.
              </Text>
            </>
          )}
        </Card>

        <View style={{ marginTop: 16 }}>
          <Button
            title="ENREGISTRER"
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
            <Text style={styles.modalTitle}>Choisir le pays</Text>
            <ScrollView>
              {countries.map((c) => (
                <TouchableOpacity
                  key={c.code}
                  style={styles.countryRow}
                  onPress={() => { setCountry(c.code); setShowCP(false); }}
                  testID={`wallet-country-${c.code}`}
                >
                  <Text style={styles.countryRowTxt}>{c.flag} {c.name}</Text>
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
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 6 },
  title: { color: "#fff", fontSize: 22, fontWeight: "800" },
  sub: { color: "#C7D9FF", marginTop: 2, fontSize: 12 },
  step: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 14, marginBottom: 8 },
  field: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  fieldTxt: { color: theme.colors.textPrimary, fontWeight: "600" },
  methodRow: { flexDirection: "row", gap: 10 },
  methodBox: { flex: 1, alignItems: "center", padding: 16, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 2, borderColor: "transparent" },
  methodBoxOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  methodTxt: { marginTop: 6, fontWeight: "700", color: theme.colors.textPrimary, fontSize: 13 },
  lbl: { fontWeight: "700", color: theme.colors.textPrimary, fontSize: 12, marginTop: 8, marginBottom: 4 },
  opRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  opChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  opChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  opTxt: { color: theme.colors.textPrimary, fontWeight: "600", fontSize: 12 },
  networkChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#FEF3C7", padding: 8, borderRadius: 10, marginBottom: 4 },
  networkTxt: { color: "#92400E", fontWeight: "700", fontSize: 12 },
  hint: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 6, fontStyle: "italic" },

  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", padding: 20 },
  modalCard: { backgroundColor: theme.colors.surface, borderRadius: 16, padding: 16, width: "100%", maxWidth: 400, maxHeight: "80%" },
  modalTitle: { fontWeight: "800", fontSize: 16, color: theme.colors.textPrimary, marginBottom: 12 },
  countryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  countryRowTxt: { color: theme.colors.textPrimary, fontSize: 14 },
});
