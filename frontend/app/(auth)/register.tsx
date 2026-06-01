import React, { useEffect, useState } from "react";
import {
  KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View, TouchableOpacity, Modal, Pressable, Image,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { Button } from "@/src/components/Button";
import { Input } from "@/src/components/Input";
import { useAuth } from "@/src/auth";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type Country = { code: string; name: string; dial: string; flag: string };

export default function Register() {
  const router = useRouter();
  const params = useLocalSearchParams<{ ref?: string }>();
  const { signUp } = useAuth();

  const [countries, setCountries] = useState<Country[]>([]);
  const [showCountryPicker, setShowCountryPicker] = useState(false);

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [country, setCountry] = useState<Country | null>(null);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [sponsor, setSponsor] = useState((params.ref as string) || "admin");
  const [accept, setAccept] = useState(false);
  const [show, setShow] = useState(false);
  const [show2, setShow2] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.get<{ countries: Country[] }>("/config", { auth: false });
        setCountries(cfg.countries);
        if (!country) setCountry(cfg.countries.find((c) => c.code === "TG") || cfg.countries[0]);
      } catch {}
    })();
  }, []);

  const submit = async () => {
    setErr(null);
    if (!username || !email || !phone || !password || !sponsor) {
      setErr("Veuillez remplir tous les champs obligatoires.");
      return;
    }
    if (password !== passwordConfirm) {
      setErr("Les mots de passe ne correspondent pas.");
      return;
    }
    if (!accept) {
      setErr("Vous devez accepter les conditions d'utilisation.");
      return;
    }
    setLoading(true);
    try {
      await signUp({
        username, email, country: country?.code,
        phone: `${country?.dial || ""}${phone}`,
        password, password_confirm: passwordConfirm,
        sponsor_username: sponsor, accept_terms: accept,
      });
      router.replace("/(app)/activation");
    } catch (e: any) {
      setErr(e?.detail || "Erreur lors de l'inscription.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
          <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
            <Image
              source={require("@/assets/images/spiloveure-logo.png")}
              style={styles.logo} resizeMode="contain"
            />
            <Text style={styles.h1}>Rejoignez une <Text style={{ color: "#A5C2FF" }}>communauté</Text> qui gagne !</Text>
            <Text style={styles.sub}>Créez votre compte et commencez dès aujourd'hui.</Text>
          </LinearGradient>

          <View style={styles.card}>
            <Text style={styles.title}>Créer votre compte</Text>
            <Text style={styles.subtitle}>Veuillez remplir tous les champs pour vous inscrire.</Text>

            {err ? (
              <View style={styles.errBox} testID="register-error">
                <Ionicons name="alert-circle" size={18} color={theme.colors.danger} />
                <Text style={styles.errText}>{err}</Text>
              </View>
            ) : null}

            <Input
              label="Nom d'utilisateur"
              icon="person-outline"
              placeholder="kossi123"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              testID="register-username"
            />
            <Input
              label="E-mail"
              icon="mail-outline"
              placeholder="kossi@gmail.com"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              testID="register-email"
            />

            <Text style={styles.lbl}>Choisir le pays</Text>
            <TouchableOpacity style={styles.countryBtn} onPress={() => setShowCountryPicker(true)} testID="register-country">
              <Ionicons name="globe-outline" size={18} color={theme.colors.textSecondary} />
              <Text style={styles.countryText}>
                {country ? `${country.flag}  ${country.name}` : "Sélectionnez votre pays"}
              </Text>
              <Ionicons name="chevron-down" size={18} color={theme.colors.textSecondary} />
            </TouchableOpacity>

            <Text style={styles.lbl}>Numéro de téléphone</Text>
            <View style={styles.phoneRow}>
              <View style={styles.dialBox}>
                <Text style={styles.dialText}>{country?.flag} {country?.dial}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Input
                  placeholder="90 00 00 00"
                  value={phone}
                  onChangeText={setPhone}
                  keyboardType="phone-pad"
                  testID="register-phone"
                />
              </View>
            </View>

            <Input
              label="Mot de passe"
              icon="lock-closed-outline"
              placeholder="Entrez votre mot de passe"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!show}
              rightIcon={show ? "eye-off-outline" : "eye-outline"}
              onRightIconPress={() => setShow((s) => !s)}
              testID="register-password"
            />
            <Input
              label="Confirmer le mot de passe"
              icon="lock-closed-outline"
              placeholder="Confirmez votre mot de passe"
              value={passwordConfirm}
              onChangeText={setPasswordConfirm}
              secureTextEntry={!show2}
              rightIcon={show2 ? "eye-off-outline" : "eye-outline"}
              onRightIconPress={() => setShow2((s) => !s)}
              testID="register-password-confirm"
            />
            <Input
              label="Parrain"
              icon="people-outline"
              placeholder="Nom d'utilisateur du parrain"
              value={sponsor}
              onChangeText={setSponsor}
              autoCapitalize="none"
              editable={false}
              testID="register-sponsor"
            />
            <Text style={styles.sponsorHint}>
              Code parrain verrouillé{params.ref ? " (transmis via votre lien d'invitation)" : " (parrain par défaut)"}.
            </Text>

            <TouchableOpacity style={styles.checkRow} onPress={() => setAccept((v) => !v)} testID="register-accept">
              <View style={[styles.check, accept && styles.checkOn]}>
                {accept && <Ionicons name="checkmark" size={14} color="#fff" />}
              </View>
              <Text style={styles.checkLabel}>
                J'accepte les <Text style={styles.link}>conditions d'utilisation</Text>.
              </Text>
            </TouchableOpacity>

            <Button
              title="S'INSCRIRE"
              onPress={submit}
              loading={loading}
              icon={<Ionicons name="person-add" size={18} color="#fff" />}
              testID="register-submit"
            />

            <View style={styles.bottomRow}>
              <Text style={styles.bottomText}>Vous avez déjà un compte ?</Text>
              <TouchableOpacity onPress={() => router.push("/(auth)/login")} testID="goto-login">
                <Text style={styles.link}> Se connecter</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={showCountryPicker} transparent animationType="slide" onRequestClose={() => setShowCountryPicker(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowCountryPicker(false)}>
          <Pressable style={styles.countrySheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>Choisir un pays</Text>
            <ScrollView>
              {countries.map((c) => (
                <TouchableOpacity
                  key={c.code} style={styles.countryItem}
                  onPress={() => { setCountry(c); setShowCountryPicker(false); }}
                  testID={`country-${c.code}`}
                >
                  <Text style={{ fontSize: 20 }}>{c.flag}</Text>
                  <Text style={styles.countryItemText}>{c.name}</Text>
                  <Text style={styles.countryItemDial}>{c.dial}</Text>
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
  header: { paddingTop: 24, paddingBottom: 40, paddingHorizontal: 24, alignItems: "center" },
  logo: { width: 150, height: 150 },
  h1: { color: "#fff", fontSize: 22, fontWeight: "800", textAlign: "center", marginTop: 16 },
  sub: { color: "#C7D9FF", textAlign: "center", marginTop: 6 },
  card: {
    backgroundColor: "#fff",
    marginTop: -20, marginHorizontal: 16,
    borderRadius: 24, padding: 20,
    ...theme.shadow.card,
  },
  title: { fontSize: 22, fontWeight: "800", color: theme.colors.textPrimary, textAlign: "center" },
  subtitle: { color: theme.colors.textSecondary, textAlign: "center", marginVertical: 8, marginBottom: 16 },
  lbl: { fontSize: theme.font.body, fontWeight: "600", color: theme.colors.textPrimary, marginBottom: 6 },
  countryBtn: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "#fff", borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 14, marginBottom: 16,
  },
  countryText: { flex: 1, color: theme.colors.textPrimary, fontSize: theme.font.bodyLg },
  phoneRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  dialBox: {
    backgroundColor: "#fff", borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 14,
    height: 50, justifyContent: "center",
  },
  dialText: { color: theme.colors.textPrimary, fontWeight: "600" },
  checkRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 12, marginTop: 4 },
  check: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 1.5, borderColor: theme.colors.border,
    alignItems: "center", justifyContent: "center", marginTop: 2,
  },
  checkOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  checkLabel: { flex: 1, color: theme.colors.textSecondary },
  link: { color: theme.colors.primary, fontWeight: "700" },
  sponsorHint: { color: theme.colors.textSecondary, fontSize: 12, fontStyle: "italic", marginTop: -8, marginBottom: 12, marginLeft: 4 },
  bottomRow: { flexDirection: "row", justifyContent: "center", marginTop: 16, flexWrap: "wrap" },
  bottomText: { color: theme.colors.textSecondary },
  errBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.colors.dangerBg, padding: 12, borderRadius: 12, marginBottom: 12,
  },
  errText: { color: theme.colors.danger, flex: 1, fontWeight: "600" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  countrySheet: { backgroundColor: "#fff", maxHeight: "70%", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16 },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary, marginBottom: 12 },
  countryItem: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 8 },
  countryItemText: { flex: 1, fontSize: 16, color: theme.colors.textPrimary, fontWeight: "500" },
  countryItemDial: { color: theme.colors.textSecondary },
});
