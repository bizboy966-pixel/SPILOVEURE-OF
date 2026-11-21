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
import { armWelcomeSplash } from "@/src/components/WelcomeSplash";
import { useFeature, useFeatures } from "@/src/features";
import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { countryDisplayName } from "@/src/identity/countrySearch";
import { registrationPasswordError } from "@/src/identity/passwordValidation";
import { useI18n } from "@/src/i18n";

type Country = { code: string; name: string; dial: string; flag: string };

export default function Register() {
  const router = useRouter();
  const params = useLocalSearchParams<{ ref?: string; via?: string; flow?: string; country?: string; email?: string }>();
  const { signUp } = useAuth();
  const { t, lang } = useI18n();
  const landingEnabled = useFeature("landing_page");
  const { loading: featLoading } = useFeatures();

  // Referral-first UX: whenever the URL carries a ?ref=… AND the user did NOT
  // arrive via the "Commencer maintenant" CTA on the landing page, bounce
  // them to the landing page carrying the ref along. This forces every
  // referral visitor to discover the platform first. The `via=landing` marker
  // set by the landing CTA breaks the loop.
  useEffect(() => {
    if (featLoading) return;
    const hasRef = !!(params.ref && String(params.ref).trim());
    if (hasRef && params.via !== "landing") {
      router.replace(`/?showLanding=1&ref=${encodeURIComponent(String(params.ref))}` as any);
      return;
    }
    // Fallback for when landing_page flag is enabled but the visitor came
    // without any ref (direct /register URL) — still send them via the
    // marketing page first.
    if (!hasRef && landingEnabled && params.via !== "landing") {
      router.replace("/" as any);
    }
  }, [featLoading, landingEnabled, params.via, params.ref, router]);

  const [countries, setCountries] = useState<Country[]>([]);
  const [showCountryPicker, setShowCountryPicker] = useState(false);

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
  const [country, setCountry] = useState<Country | null>(null);
  const [phone, setPhone] = useState("");
  // Resolve missing invitations from the server's official administrator config.
  const [sponsor, setSponsor] = useState<string>((params.ref as string) || "");
  const [sponsorValid, setSponsorValid] = useState<boolean | null>(null);
  const [sponsorChecking, setSponsorChecking] = useState<boolean>(true);
  const [sponsorError, setSponsorError] = useState("");
  const [accept, setAccept] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.get<{ countries: Country[] }>("/config", { auth: false });
        setCountries(cfg.countries);
        if (!country) setCountry(cfg.countries.find((c) => c.code === String(params.country || "")) || cfg.countries.find((c) => c.code === "TG") || cfg.countries[0]);
      } catch {}
    })();
  }, []);
  useEffect(() => {
    if (params.email) setEmail(String(params.email));
    if (params.country && countries.length) setCountry(countries.find(c => c.code === String(params.country)) || null);
  }, [params.email, params.country, countries]);

  // A supplied invitation remains authoritative, including explicit errors.
  useEffect(() => {
    const ref = (params.ref as string) || "";
    let live = true;
    setSponsorChecking(true);
    setSponsorValid(null);
    setSponsorError("");
    (async () => {
      try {
        const result = await api.get<{ username: string }>(`/identity/registration-sponsor${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, { auth: false });
        if (!live) return;
        setSponsor(result.username);
        setSponsorValid(true);
      } catch (error: any) {
        if (!live) return;
        setSponsorValid(false);
        setSponsor("");
        setSponsorError(error?.detail || t("auth.sponsor_check_failed"));
      } finally {
        if (live) setSponsorChecking(false);
      }
    })();
    return () => { live = false; };
  }, [params.ref]);

  const submit = async () => {
    setErr(null);
    if (!sponsorValid) {
      setErr(sponsorError || t("auth.sponsor_wait"));
      return;
    }
    if (!username || !email || !phone || !sponsor || !country) {
      setErr(t("auth.fill_required"));
      return;
    }
    if (!accept) {
      setErr(t("auth.accept_terms_error"));
      return;
    }
    const passwordError = registrationPasswordError(password, passwordConfirm);
    if (passwordError) {
      setErr(passwordError === "Le mot de passe doit contenir au moins 8 caractères."
        ? t("auth.password_too_short")
        : passwordError === "Le mot de passe ne doit pas dépasser 72 octets."
          ? t("auth.password_too_long")
          : t("profile.password_mismatch"));
      return;
    }
    setLoading(true);
    try {
      await signUp({
        username, email, country: country?.code,
        phone: `${country?.dial || ""}${phone}`,
        sponsor_username: sponsor, accept_terms: accept,
        password, password_confirm: passwordConfirm,
      });
      armWelcomeSplash();
      router.replace("/(app)/pay");
    } catch (e: any) {
      setErr(e?.detail || t("auth.register_error"));
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
            <Text style={styles.h1}>{t("auth.register_welcome")}</Text>
            <Text style={styles.sub}>{t("auth.register_welcome_desc")}</Text>
          </LinearGradient>

          <View style={styles.card}>
            <Text style={styles.title}>{t("auth.register_title")}</Text>
            <Text style={styles.subtitle}>{t("auth.register_desc")}</Text>

            {/* Bandeau de blocage si le lien de parrainage est invalide ou absent */}
            {sponsorValid === false && !sponsorChecking ? (
              <View style={styles.refBlockBox} testID="register-ref-invalid">
                <Ionicons name="warning" size={20} color="#92400E" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.refBlockTitle}>{t("auth.sponsor_invalid")}</Text>
                  <Text style={styles.refBlockText}>
                    {sponsorError}
                  </Text>
                </View>
              </View>
            ) : null}
            {sponsorChecking ? (
              <View style={styles.refCheckBox}>
                <Text style={styles.refCheckText}>{t("auth.sponsor_checking")}</Text>
              </View>
            ) : null}

            {err ? (
              <View style={styles.errBox} testID="register-error">
                <Ionicons name="alert-circle" size={18} color={theme.colors.danger} />
                <Text style={styles.errText}>{err}</Text>
              </View>
            ) : null}

            <Input
              label={t("auth.username")}
              icon="person-outline"
              placeholder="kossi123"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              testID="register-username"
            />
            <Input
              label={t("auth.email")}
              icon="mail-outline"
              placeholder="kossi@gmail.com"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              testID="register-email"
              editable={!params.email}
            />

            <Text style={styles.lbl}>{params.country ? t("auth.country") : t("auth.choose_country")}</Text>
            <TouchableOpacity style={styles.countryBtn} disabled={!!params.country} accessibilityState={{ disabled: !!params.country }} onPress={() => setShowCountryPicker(true)} testID="register-country">
              <Ionicons name="globe-outline" size={18} color={theme.colors.textSecondary} />
              <Text style={styles.countryText}>
                {country ? `${country.flag}  ${countryDisplayName(country, lang)}` : t("auth.select_country")}
              </Text>
              <Ionicons name={params.country ? "lock-closed-outline" : "chevron-down"} size={18} color={theme.colors.textSecondary} />
            </TouchableOpacity>

            <Input
              label={t("auth.create_password")}
              icon="lock-closed-outline"
              placeholder={t("auth.password_minimum")}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="new-password"
              rightIcon={showPassword ? "eye-off-outline" : "eye-outline"}
              onRightIconPress={() => setShowPassword(value => !value)}
              testID="register-password"
            />
            <Input
              label={t("auth.confirm_password")}
              icon="lock-closed-outline"
              placeholder={t("auth.repeat_password")}
              value={passwordConfirm}
              onChangeText={setPasswordConfirm}
              secureTextEntry={!showPasswordConfirm}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="new-password"
              rightIcon={showPasswordConfirm ? "eye-off-outline" : "eye-outline"}
              onRightIconPress={() => setShowPasswordConfirm(value => !value)}
              testID="register-password-confirm"
            />
            <Text style={styles.lbl}>{t("auth.phone_number")}</Text>
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
              label="Parrain"
              icon="lock-closed"
              placeholder={t("auth.sponsor_check_placeholder")}
              value={sponsorValid ? sponsor : ""}
              onChangeText={() => {}}
              autoCapitalize="none"
              editable={false}
              testID="register-sponsor"
            />
            <Text style={styles.sponsorHint}>
              {sponsorValid && sponsor
                ? params.ref ? t("auth.sponsor_invited", { sponsor }) : t("auth.sponsor_official", { sponsor })
                : t("auth.sponsor_auto")}
            </Text>

            <TouchableOpacity style={styles.checkRow} onPress={() => setAccept((v) => !v)} testID="register-accept">
              <View style={[styles.check, accept && styles.checkOn]}>
                {accept && <Ionicons name="checkmark" size={14} color="#fff" />}
              </View>
              <Text style={styles.checkLabel}>
                {t("auth.accept_terms")}
              </Text>
            </TouchableOpacity>

            <Button
              title={t("auth.signup").toUpperCase()}
              onPress={submit}
              loading={loading}
              disabled={!sponsorValid || sponsorChecking}
              icon={<Ionicons name="person-add" size={18} color="#fff" />}
              testID="register-submit"
            />

            <View style={styles.bottomRow}>
              <Text style={styles.bottomText}>{t("auth.already_account")}</Text>
              <TouchableOpacity onPress={() => router.push("/(auth)/login")} testID="goto-login">
                <Text style={styles.link}> {t("auth.login_link")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={showCountryPicker} transparent animationType="slide" onRequestClose={() => setShowCountryPicker(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowCountryPicker(false)}>
          <Pressable style={styles.countrySheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>{t("auth.choose_country")}</Text>
            <ScrollView>
              {countries.map((c) => (
                <TouchableOpacity
                  key={c.code} style={styles.countryItem}
                  onPress={() => { setCountry(c); setShowCountryPicker(false); }}
                  testID={`country-${c.code}`}
                >
                  <Text style={{ fontSize: 20 }}>{c.flag}</Text>
                   <Text style={styles.countryItemText}>{countryDisplayName(c, lang)}</Text>
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
  logo: { width: 96, height: 96 },
  h1: {
    color: "#fff", fontSize: 20, fontWeight: "700",
    textAlign: "center", marginTop: 12, letterSpacing: -0.2,
  },
  sub: { color: "#C7D9FF", textAlign: "center", marginTop: 6 },
  card: {
    backgroundColor: "#fff",
    marginTop: -20, marginHorizontal: 16,
    borderRadius: 28, padding: 20,
    ...theme.shadow.card,
  },
  title: {
    fontSize: 17, fontWeight: "700",
    color: theme.colors.textPrimary,
    textAlign: "center", letterSpacing: -0.2,
  },
  subtitle: {
    color: theme.colors.textSecondary,
    fontSize: 13, lineHeight: 18,
    textAlign: "center",
    marginTop: 4, marginBottom: 18,
  },
  lbl: { fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary, marginBottom: 6 },
  countryBtn: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "#fff", borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: 14, paddingHorizontal: 12, paddingVertical: 14, marginBottom: 16,
  },
  countryText: { flex: 1, color: theme.colors.textPrimary, fontSize: theme.font.bodyLg },
  phoneRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  dialBox: {
    backgroundColor: "#fff", borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: 14, paddingHorizontal: 12, paddingVertical: 14,
    height: 50, justifyContent: "center",
  },
  dialText: { color: theme.colors.textPrimary, fontWeight: "600" },
  checkRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 12, marginTop: 4 },
  check: {
    width: 22, height: 22, borderRadius: 8,
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
    backgroundColor: theme.colors.dangerBg, padding: 12, borderRadius: 14, marginBottom: 12,
  },
  errText: { color: theme.colors.danger, flex: 1, fontWeight: "600" },
  refBlockBox: {
    flexDirection: "row", alignItems: "flex-start", gap: 10,
    backgroundColor: "#FEF3C7", borderColor: "#F59E0B", borderWidth: 1,
    padding: 12, borderRadius: 14, marginBottom: 14,
  },
  refBlockTitle: { color: "#92400E", fontWeight: "800", fontSize: 14, marginBottom: 2 },
  refBlockText: { color: "#92400E", fontSize: 12, lineHeight: 16 },
  refCheckBox: {
    backgroundColor: theme.colors.surfaceSecondary, padding: 10,
    borderRadius: 12, marginBottom: 10, alignItems: "center",
  },
  refCheckText: { color: theme.colors.textSecondary, fontStyle: "italic", fontSize: 12 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  countrySheet: { backgroundColor: "#fff", maxHeight: "70%", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16 },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary, marginBottom: 12 },
  countryItem: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 10 },
  countryItemText: { flex: 1, fontSize: 16, color: theme.colors.textPrimary, fontWeight: "500" },
  countryItemDial: { color: theme.colors.textSecondary },
});
