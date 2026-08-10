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
import { armWelcomeSplash } from "@/src/components/WelcomeSplash";
import { theme } from "@/src/theme";

export default function Login() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setErr(null);
    setLoading(true);
    try {
      await signIn(email.trim(), password);
      armWelcomeSplash();
      router.replace("/");
    } catch (e: any) {
      setErr(e?.detail || "Identifiants invalides.");
    } finally {
      setLoading(false);
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
            <Text style={styles.welcome}>Bienvenue de retour !</Text>
            <Text style={styles.welcomeSub}>
              Connectez-vous pour continuer à développer votre réseau.
            </Text>
          </LinearGradient>

          <View style={styles.card}>
            <Text style={styles.title}>Connexion</Text>
            <Text style={styles.subtitle}>
              Veuillez entrer vos informations pour accéder à votre compte.
            </Text>

            {err ? (
              <View style={styles.errBox} testID="login-error">
                <Ionicons name="alert-circle" size={18} color={theme.colors.danger} />
                <Text style={styles.errText}>{err}</Text>
              </View>
            ) : null}

            <Input
              label="E-mail"
              icon="mail-outline"
              placeholder="Entrez votre adresse e-mail"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              testID="login-email"
            />
            <Input
              label="Mot de passe"
              icon="lock-closed-outline"
              placeholder="Entrez votre mot de passe"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!show}
              rightIcon={show ? "eye-off-outline" : "eye-outline"}
              onRightIconPress={() => setShow((s) => !s)}
              testID="login-password"
            />

            <TouchableOpacity style={{ alignSelf: "flex-end", marginBottom: 16 }}>
              <Text style={styles.link}>Mot de passe oublié ?</Text>
            </TouchableOpacity>

            <Button
              title="SE CONNECTER"
              onPress={submit}
              loading={loading}
              icon={<Ionicons name="log-in-outline" size={20} color="#fff" />}
              testID="login-submit"
            />

            <View style={styles.bottomRow}>
              <Text style={styles.bottomText}>Vous n'avez pas encore de compte ?</Text>
              <TouchableOpacity onPress={() => router.push("/(auth)/register")} testID="goto-register">
                <Text style={styles.link}> S'inscrire</Text>
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
    borderRadius: 20, padding: 22,
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
  bottomRow: { flexDirection: "row", justifyContent: "center", marginTop: 20, flexWrap: "wrap" },
  bottomText: { color: theme.colors.textSecondary, fontSize: 13 },
  errBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.colors.dangerBg, padding: 12, borderRadius: 12, marginBottom: 12,
  },
  errText: { color: theme.colors.danger, flex: 1, fontWeight: "600" },
});
