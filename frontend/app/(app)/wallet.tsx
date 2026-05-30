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

export default function Wallet() {
  const router = useRouter();
  const { user } = useAuth();
  const [country, setCountry] = useState(user?.country || "TG");
  const [countries, setCountries] = useState<Country[]>([]);
  const [showCP, setShowCP] = useState(false);
  const [operators, setOperators] = useState<string[]>([]);
  const [operator, setOperator] = useState<string>("");
  const [phone, setPhone] = useState(user?.phone || "");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const cfg = await api.get<{ countries: Country[]; operators_by_country: any }>("/config", { auth: false });
      setCountries(cfg.countries);
      const ops = cfg.operators_by_country[country] || [];
      setOperators(ops);
      if (ops.length) setOperator((o) => o || ops[0]);
      try {
        const w = await api.get<any>("/wallet");
        if (w) {
          setCountry(w.country); setOperator(w.operator); setPhone(w.phone); setFullName(w.full_name);
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    api.get<{ operators_by_country: any }>("/config", { auth: false }).then((cfg) => {
      const ops = cfg.operators_by_country[country] || [];
      setOperators(ops);
      if (!ops.includes(operator)) setOperator(ops[0] || "");
    }).catch(() => {});
  }, [country]);

  const save = async () => {
    if (!operator || !phone || !fullName) return Alert.alert("Erreur", "Veuillez remplir tous les champs.");
    setLoading(true);
    try {
      await api.post("/wallet", { country, operator, phone, full_name: fullName });
      Alert.alert("✅", "Portefeuille enregistré.");
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Erreur");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Portefeuille de retrait</Text>
        <Text style={styles.sub}>Le compte Mobile Money sur lequel vous recevrez vos retraits.</Text>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Card>
          <Text style={styles.section}>Informations du portefeuille</Text>
          <Text style={styles.lbl}>Pays</Text>
          <TouchableOpacity style={styles.select} onPress={() => setShowCP(true)} testID="wallet-country">
            <Ionicons name="globe-outline" size={16} color={theme.colors.textSecondary} />
            <Text style={styles.selectT}>{countries.find((c) => c.code === country)?.name || country}</Text>
            <Ionicons name="chevron-down" size={16} color={theme.colors.textSecondary} />
          </TouchableOpacity>

          <Text style={styles.lbl}>Opérateur</Text>
          <View style={styles.opGrid}>
            {operators.map((op) => (
              <TouchableOpacity
                key={op} style={[styles.opChip, operator === op && styles.opChipOn]}
                onPress={() => setOperator(op)} testID={`wallet-op-${op}`}
              >
                <Text style={[styles.opT, operator === op && { color: "#fff" }]}>{op}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Input label="Numéro de téléphone" icon="call-outline" value={phone} onChangeText={setPhone} keyboardType="phone-pad" testID="wallet-phone" />
          <Input label="Nom complet" icon="person-outline" value={fullName} onChangeText={setFullName} testID="wallet-name" />

          <Button title="Enregistrer" onPress={save} loading={loading} testID="wallet-save" />
        </Card>
      </ScrollView>

      <Modal visible={showCP} transparent animationType="slide" onRequestClose={() => setShowCP(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowCP(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>Choisir un pays</Text>
            <ScrollView>
              {countries.map((c) => (
                <TouchableOpacity key={c.code} style={styles.cItem} onPress={() => { setCountry(c.code); setShowCP(false); }}>
                  <Text style={{ fontSize: 20 }}>{c.flag}</Text>
                  <Text style={{ flex: 1, color: theme.colors.textPrimary, fontWeight: "600" }}>{c.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, paddingBottom: 20 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  title: { color: "#fff", fontSize: 24, fontWeight: "800" },
  sub: { color: "#C7D9FF" },
  section: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 12 },
  lbl: { color: theme.colors.textPrimary, fontWeight: "600", marginBottom: 6 },
  select: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#fff", borderWidth: 1, borderColor: theme.colors.border, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 12, marginBottom: 12 },
  selectT: { flex: 1, color: theme.colors.textPrimary, fontWeight: "600" },
  opGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  opChip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  opChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  opT: { color: theme.colors.textPrimary, fontWeight: "600", fontSize: 12 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#fff", maxHeight: "70%", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16 },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary, marginBottom: 12 },
  cItem: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 8 },
});
