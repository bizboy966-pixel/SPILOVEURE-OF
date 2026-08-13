import React, { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View, TouchableOpacity, Linking, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { Input } from "@/src/components/Input";
import { Button } from "@/src/components/Button";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { LANG_LABELS, useI18n, type Lang } from "@/src/i18n";

type SupportConfig = {
  telegram_url: string; whatsapp_url: string; facebook_url: string; youtube_url: string;
  instagram_url: string; twitter_url: string; discord_url: string;
  email: string; phone: string; website_url: string;
};

export default function Settings() {
  const router = useRouter();
  const { user, refresh, signOut } = useAuth();
  const { lang, setLang, t } = useI18n();
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [newPwd2, setNewPwd2] = useState("");
  const [phone, setPhone] = useState(user?.phone || "");
  const [email, setEmail] = useState(user?.email || "");
  const [loadingPwd, setLoadingPwd] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [support, setSupport] = useState<SupportConfig | null>(null);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [savingLang, setSavingLang] = useState(false);

  // Sync user's stored preference with the i18n context on login/refresh.
  useEffect(() => {
    const pref = user?.preferred_language;
    if ((pref === "fr" || pref === "en") && pref !== lang) {
      setLang(pref).catch(() => {});
    }
  }, [user?.preferred_language, lang, setLang]);

  const pickLanguage = async (next: Lang) => {
    if (next === lang) { setShowLangPicker(false); return; }
    setSavingLang(true);
    const previous = lang;
    try {
      await setLang(next);
      try {
        await api.put("/auth/language", { language: next });
        await refresh();
        setShowLangPicker(false);
        if (typeof window !== "undefined") window.alert(`✅ ${next === "fr" ? "Langue mise à jour avec succès." : "Language updated successfully."}`);
      } catch (e: any) {
        // Revert local language if the DB save failed.
        await setLang(previous);
        if (typeof window !== "undefined") window.alert(`❌ ${previous === "fr" ? "Échec de la mise à jour de la langue." : "Failed to update language."} ${e?.detail || ""}`);
      }
    } finally {
      setSavingLang(false);
    }
  };

  const isPending = !user || user.status === "pending" || (user.max_level || 0) === 0;

  useEffect(() => {
    if (isPending) return; // Le support est masqué tant que le compte n'est pas activé.
    (async () => {
      try {
        const s = await api.get<SupportConfig>("/settings/support", { auth: false });
        setSupport(s);
      } catch {}
    })();
  }, [isPending]);

  // Sync local form state with the loaded user (fixes "Enregistrer" doing nothing
  // when fields weren't pre-filled because user was still loading).
  useEffect(() => {
    if (user?.email) setEmail(user.email);
    if (user?.phone) setPhone(user.phone);
  }, [user?.email, user?.phone]);

  const changePwd = async () => {
    if (newPwd !== newPwd2) return Alert.alert("Erreur", "Les mots de passe ne correspondent pas.");
    setLoadingPwd(true);
    try {
      await api.post("/auth/change-password", { current_password: oldPwd, new_password: newPwd, new_password_confirm: newPwd2 });
      Alert.alert("✅", "Mot de passe modifié.");
      setOldPwd(""); setNewPwd(""); setNewPwd2("");
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Erreur");
    } finally {
      setLoadingPwd(false);
    }
  };

  const saveProfile = async () => {
    setLoadingProfile(true);
    try {
      await api.post("/auth/update-profile", { phone, email });
      Alert.alert("✅", "Profil mis à jour.");
      await refresh();
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Erreur");
    } finally {
      setLoadingProfile(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>{t("settings.title")}</Text>
      </LinearGradient>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Card>
          <Text style={styles.section}>{t("settings.personal_info")}</Text>
          <Input label={t("auth.email")} icon="mail-outline" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" testID="settings-email" />
          <Input label={t("auth.phone")} icon="call-outline" value={phone} onChangeText={setPhone} keyboardType="phone-pad" testID="settings-phone" />
          <Button title={t("common.save")} onPress={saveProfile} loading={loadingProfile} testID="settings-save-profile" />
        </Card>

        {/* LANGUE / LANGUAGE */}
        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>🌐 {t("settings.language")}</Text>
          <Text style={{ color: theme.colors.textSecondary, marginBottom: 8 }}>{t("settings.language_desc")}</Text>
          <TouchableOpacity
            style={styles.langRow}
            onPress={() => setShowLangPicker(true)}
            testID="settings-language-btn"
          >
            <Text style={styles.langRowFlag}>{LANG_LABELS[lang].flag}</Text>
            <Text style={styles.langRowName}>{LANG_LABELS[lang].native}</Text>
            <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>{t("settings.change_password")}</Text>
          <Input label={t("settings.current_password")} icon="lock-closed-outline" secureTextEntry value={oldPwd} onChangeText={setOldPwd} testID="settings-old-pwd" />
          <Input label={t("auth.new_password")} icon="lock-closed-outline" secureTextEntry value={newPwd} onChangeText={setNewPwd} testID="settings-new-pwd" />
          <Input label={t("auth.confirm_password")} icon="lock-closed-outline" secureTextEntry value={newPwd2} onChangeText={setNewPwd2} testID="settings-new-pwd-2" />
          <Button title={t("settings.change_password")} onPress={changePwd} loading={loadingPwd} testID="settings-change-pwd" />
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>{t("settings.wallet")}</Text>
          <Text style={{ color: theme.colors.textSecondary, marginBottom: 8 }}>
            {t("settings.wallet_desc")}
          </Text>
          <Button title={t("settings.manage_wallet")} variant="outline" onPress={() => router.push("/(app)/wallet")} testID="settings-wallet" />
        </Card>

        {!isPending && (
        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>{t("settings.support")}</Text>
          {!support || !(support.whatsapp_url || support.telegram_url || support.email || support.phone || support.facebook_url || support.youtube_url || support.instagram_url || support.twitter_url || support.discord_url || support.website_url) ? (
            <Text style={{ color: theme.colors.textSecondary, fontStyle: "italic", textAlign: "center", padding: 16 }}>
              {t("settings.no_support")}
            </Text>
          ) : (
            <>
              {!!support.whatsapp_url && <SupportRow icon="logo-whatsapp" label="WhatsApp" url={support.whatsapp_url} color="#25D366" />}
              {!!support.telegram_url && <SupportRow icon="paper-plane" label="Telegram" url={support.telegram_url} color="#26A5E4" />}
              {!!support.email && <SupportRow icon="mail" label="E-mail" url={`mailto:${support.email}`} color={theme.colors.primary} />}
              {!!support.phone && <SupportRow icon="call" label="Téléphone" url={`tel:${support.phone}`} color="#10B981" />}
              {!!support.facebook_url && <SupportRow icon="logo-facebook" label="Facebook" url={support.facebook_url} color="#1877F2" />}
              {!!support.youtube_url && <SupportRow icon="logo-youtube" label="YouTube" url={support.youtube_url} color="#FF0000" />}
              {!!support.instagram_url && <SupportRow icon="logo-instagram" label="Instagram" url={support.instagram_url} color="#E1306C" />}
              {!!support.twitter_url && <SupportRow icon="logo-twitter" label="Twitter / X" url={support.twitter_url} color="#000000" />}
              {!!support.discord_url && <SupportRow icon="logo-discord" label="Discord" url={support.discord_url} color="#5865F2" />}
              {!!support.website_url && <SupportRow icon="globe" label="Site web" url={support.website_url} color="#6366F1" />}
            </>
          )}
        </Card>
        )}

        <TouchableOpacity style={styles.dangerBtn} onPress={async () => { await signOut(); router.replace("/(auth)/login"); }} testID="settings-signout">
          <Ionicons name="log-out-outline" size={20} color={theme.colors.danger} />
          <Text style={styles.dangerBtnT}>{t("settings.signout")}</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* LANGUAGE PICKER MODAL */}
      <Modal visible={showLangPicker} transparent animationType="fade" onRequestClose={() => setShowLangPicker(false)}>
        <View style={styles.langModalBg} testID="language-picker-modal">
          <View style={styles.langModalCard}>
            <Text style={styles.langModalTitle}>🌐 {t("settings.language")}</Text>
            <Text style={styles.langModalSub}>{t("settings.language_desc")}</Text>
            {(["fr", "en"] as Lang[]).map((l) => {
              const on = l === lang;
              return (
                <TouchableOpacity
                  key={l}
                  style={[styles.langOpt, on && styles.langOptOn]}
                  onPress={() => pickLanguage(l)}
                  disabled={savingLang}
                  testID={`language-option-${l}`}
                >
                  <Text style={styles.langOptFlag}>{LANG_LABELS[l].flag}</Text>
                  <Text style={[styles.langOptName, on && { color: "#fff" }]}>{LANG_LABELS[l].native}</Text>
                  {on ? <Ionicons name="checkmark-circle" size={20} color="#fff" /> : null}
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity style={styles.langCancel} onPress={() => setShowLangPicker(false)} testID="language-picker-close">
              <Text style={styles.langCancelT}>{t("common.cancel")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function SupportRow({ icon, label, url, color }: { icon: any; label: string; url: string; color: string }) {
  return (
    <TouchableOpacity style={styles.supportRow} onPress={() => Linking.openURL(url)}>
      <View style={[styles.supportIcon, { backgroundColor: `${color}20` }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <Text style={styles.supportLbl}>{label}</Text>
      <Ionicons name="open-outline" size={18} color={theme.colors.textSecondary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, paddingBottom: 20 },
  back: { width: 36, height: 36, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  title: { color: "#fff", fontSize: 24, fontWeight: "800" },
  section: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 12 },
  supportRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  supportIcon: { width: 40, height: 40, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  supportLbl: { flex: 1, fontWeight: "600", color: theme.colors.textPrimary },
  dangerBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 24, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.danger },
  dangerBtnT: { color: theme.colors.danger, fontWeight: "800" },
  langRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  langRowFlag: { fontSize: 22 },
  langRowName: { flex: 1, fontWeight: "700", color: theme.colors.textPrimary, fontSize: 14 },
  langModalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.65)", justifyContent: "center", alignItems: "center", padding: 16 },
  langModalCard: { backgroundColor: theme.colors.surface, borderRadius: 16, padding: 18, width: "100%", maxWidth: 420 },
  langModalTitle: { fontSize: 18, fontWeight: "900", color: theme.colors.textPrimary, marginBottom: 4 },
  langModalSub: { fontSize: 12, color: theme.colors.textSecondary, marginBottom: 14 },
  langOpt: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 8 },
  langOptOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  langOptFlag: { fontSize: 22 },
  langOptName: { flex: 1, fontWeight: "700", color: theme.colors.textPrimary, fontSize: 14 },
  langCancel: { marginTop: 6, padding: 12, borderRadius: 12, alignItems: "center", backgroundColor: theme.colors.surfaceSecondary },
  langCancelT: { color: theme.colors.textPrimary, fontWeight: "700" },
});
