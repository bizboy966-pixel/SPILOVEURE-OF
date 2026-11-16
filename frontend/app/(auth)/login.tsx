import React, { useState } from "react";
import {
  KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View, TouchableOpacity, Image,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { Button } from "@/src/components/Button";
import { Input } from "@/src/components/Input";
import { useAuth } from "@/src/auth";
import { useChat } from "@/src/chat/ChatContext";
import { api } from "@/src/api";
import { armWelcomeSplash } from "@/src/components/WelcomeSplash";
import { theme } from "@/src/theme";
import { useI18n } from "@/src/i18n";
import { clearChatLogoutMarker } from "@/src/chat/chatLaunchState";

export default function Login() {
  const { t } = useI18n();
  const router = useRouter();
  const { signIn } = useAuth();
  const { refresh: refreshChat } = useChat();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState("");

  const submit = async () => {
    setErr(null);
    setLoading(true);
    try {
      await signIn(email.trim(), password);
      const account = await api.get<{ role: string }>("/auth/me");
      armWelcomeSplash();
      router.replace(account.role === "admin" ? "/(admin)" : "/(app)/dashboard");
    } catch (e: any) {
      setErr(e?.detail || t("auth.invalid_credentials"));
    } finally {
      setLoading(false);
    }
  };

  const openChat = async () => {
    if (chatLoading) return;
    setChatLoading(true);
    setChatError("");
    try {
      await api.get("/identity/chat/session", { auth: false, credentials: "include" });
      const chatUser = await refreshChat();
      if (!chatUser) throw { detail: "La session Chat n’a pas pu être reprise." };
      await clearChatLogoutMarker();
      router.push("/messenger" as any);
    } catch (e: any) {
      if (e?.status === 401) router.push("/verify-email?source=chat" as any);
      else setChatError(e?.detail || t("auth.chat_session_error"));
    } finally {
      setChatLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
            <View style={styles.logoBox}>
              <Image
                source={require("@/assets/images/spiloveure-logo.png")}
                style={styles.logo}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.welcome}>{t("auth.login_welcome")}</Text>
            <Text style={styles.welcomeSub}>
              {t("auth.login_welcome_desc")}
            </Text>
          </LinearGradient>

          <View style={styles.card}>
            <Text style={styles.title}>{t("auth.login_title")}</Text>
            <Text style={styles.subtitle}>
              {t("auth.login_desc")}
            </Text>

            {err ? (
              <View style={styles.errBox} testID="login-error">
                <Ionicons name="alert-circle" size={18} color={theme.colors.danger} />
                <Text style={styles.errText}>{err}</Text>
              </View>
            ) : null}

            <Input
              label={t("auth.login_identifier")}
              icon="person-outline"
              placeholder={t("auth.login_identifier_hint")}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              testID="login-email"
            />
            <Input
              label={t("auth.password")}
              icon="lock-closed-outline"
              placeholder={t("auth.enter_password")}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!show}
              rightIcon={show ? "eye-off-outline" : "eye-outline"}
              onRightIconPress={() => setShow((s) => !s)}
              testID="login-password"
            />

            <TouchableOpacity
              style={{ alignSelf: "flex-end", marginBottom: 16 }}
              onPress={() => router.push("/(auth)/forgot-password" as any)}
              accessibilityRole="button"
              testID="forgot-password-link"
            >
              <Text style={styles.link}>{t("auth.forgot_password")}</Text>
            </TouchableOpacity>

            <Button
              title={t("auth.login_button")}
              onPress={submit}
              loading={loading}
              icon={<Ionicons name="log-in-outline" size={20} color="#fff" />}
              testID="login-submit"
            />

            <TouchableOpacity
              onPress={openChat}
              disabled={chatLoading}
              accessibilityRole="button"
              accessibilityLabel={t("auth.open_chat")}
              testID="login-chat-button"
              style={styles.chatButton}
            >
              <Ionicons name="chatbubbles-outline" size={18} color={theme.colors.primary} />
              <Text style={styles.chatButtonText}>{chatLoading ? t("auth.checking_session") : t("auth.open_chat")}</Text>
            </TouchableOpacity>
            {chatError ? <Text accessibilityRole="alert" style={styles.chatError}>{chatError}</Text> : null}

            <View style={styles.bottomRow}>
              <Text style={styles.bottomText}>{t("auth.no_account_yet")}</Text>
              <TouchableOpacity onPress={() => router.push("/(auth)/register")} testID="goto-register">
                <Text style={styles.link}> {t("auth.signup_link")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { paddingTop: 32, paddingBottom: 32, paddingHorizontal: 24, alignItems: "center" },
  logoBox: { alignItems: "center", marginBottom: 12 },
  logo: { width: 96, height: 96 },
  welcome: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: -0.2,
  },
  welcomeSub: {
    color: "#C7D9FF",
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    marginTop: 4,
  },
  card: {
    backgroundColor: "#fff",
    marginTop: -20, marginHorizontal: 16,
    borderRadius: 24, padding: 22,
    ...theme.shadow.card,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: theme.colors.textPrimary,
    textAlign: "center",
    letterSpacing: -0.2,
  },
  subtitle: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    marginTop: 4,
    marginBottom: 20,
  },
  link: { color: theme.colors.primary, fontWeight: "600", fontSize: 13 },
  chatButton: { minHeight: 46, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.primary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, marginTop: 12, backgroundColor: theme.colors.primaryBg },
  chatButtonText: { color: theme.colors.primary, fontSize: 13, fontWeight: "800" },
  chatError: { color: theme.colors.danger, fontSize: 12, marginTop: 7, textAlign: "center" },
  bottomRow: { flexDirection: "row", justifyContent: "center", marginTop: 20, flexWrap: "wrap" },
  bottomText: { color: theme.colors.textSecondary, fontSize: 13 },
  errBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.colors.dangerBg, padding: 12, borderRadius: 14, marginBottom: 12,
  },
  errText: { color: theme.colors.danger, flex: 1, fontWeight: "600" },
});
