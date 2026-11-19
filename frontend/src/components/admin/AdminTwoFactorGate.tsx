import React, { useEffect, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type Phase = "loading" | "error" | "setup" | "verify" | "backup";
type StepUpResult = { step_up_token: string; expires_in: number; backup_codes?: string[] };

export function AdminTwoFactorGate({
  visible, username: accountUsername, onClose, onSuccess,
}: {
  visible: boolean;
  username?: string;
  onClose: () => void;
  onSuccess: (token: string, expiresIn: number) => void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [stepUp, setStepUp] = useState<StepUpResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setPhase("loading");
    setUsername("");
    setCode("");
    setSecret("");
    setBackupCodes([]);
    setStepUp(null);
    setCopied(false);
    setError("");
    (async () => {
      try {
        const state = await api.get<{ enabled: boolean }>("/auth/admin-2fa/status");
        if (!active) return;
        if (state.enabled) {
          setPhase("verify");
        } else {
          const setup = await api.post<{ secret: string }>("/auth/admin-2fa/setup");
          if (!active) return;
          setSecret(setup.secret);
          setPhase("setup");
        }
      } catch (e: any) {
        if (active) {
          setError(e?.detail || "Impossible de charger la vérification.");
          setPhase("error");
        }
      }
    })();
    return () => { active = false; };
  }, [visible, accountUsername, retryCount]);

  const submitCode = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (phase === "setup") {
        const result = await api.post<StepUpResult>("/auth/admin-2fa/confirm", { username, code });
        setStepUp(result);
        setBackupCodes(result.backup_codes || []);
        setCode("");
        setCopied(false);
        setPhase("backup");
        return;
      }
      const result = await api.post<StepUpResult>("/auth/admin-2fa/verify", { username, code });
      onSuccess(result.step_up_token, result.expires_in);
    } catch (e: any) {
      setError(e?.detail || "Nom d’utilisateur ou code incorrect.");
    } finally {
      setBusy(false);
    }
  };

  const copyBackupCodes = async () => {
    try {
      await Clipboard.setStringAsync(backupCodes.join("\n"));
      setCopied(true);
      setError("");
    } catch {
      setError("Copie impossible. Notez les codes avant de continuer.");
    }
  };

  const continueToAdmin = () => {
    if (!stepUp) return;
    onSuccess(stepUp.step_up_token, stepUp.expires_in);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={styles.overlay} testID="admin-2fa-overlay">
        <KeyboardAvoidingView
          style={styles.center}
          behavior={Platform.OS === "web" ? undefined : Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={0}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.card} testID="admin-2fa-modal">
              <View style={styles.header}>
                <View style={styles.headerIcon}>
                  <Ionicons name="shield-checkmark" size={24} color={theme.colors.primary} />
                </View>
                <TouchableOpacity
                  onPress={onClose}
                  style={styles.close}
                  accessibilityRole="button"
                  accessibilityLabel="Fermer la vérification"
                  testID="admin-2fa-close"
                >
                  <Ionicons name="close" size={21} color={theme.colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <Text style={styles.title}>Vérification administrateur</Text>
              <Text style={styles.subtitle}>
                {phase === "setup"
                  ? "Activez l’application Authenticator avant d’ouvrir le panneau."
                  : phase === "backup"
                    ? "Enregistrez vos codes de secours, puis ouvrez le panneau."
                    : "Saisissez votre nom d’utilisateur et le code de votre application Authenticator."}
              </Text>

              {phase === "loading" ? (
                <View style={styles.loading}>
                  <ActivityIndicator color={theme.colors.primary} />
                  <Text style={styles.muted}>Préparation de la vérification…</Text>
                </View>
              ) : null}

              {phase === "error" ? (
                <View style={styles.form}>
                  <Text style={styles.error} accessibilityRole="alert">{error}</Text>
                  <TouchableOpacity
                    onPress={() => setRetryCount((value) => value + 1)}
                    style={styles.primaryButton}
                    accessibilityRole="button"
                    testID="admin-2fa-retry"
                  >
                    <Text style={styles.primaryText}>Réessayer</Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              {phase === "setup" ? (
                <View style={styles.setupBox}>
                  <Text style={styles.sectionTitle}>1. Ajoutez SPILOVEURE</Text>
                  <Text style={styles.instructions}>
                    Dans Google Authenticator ou Microsoft Authenticator, ajoutez un compte de type « basé sur l’heure » avec une clé de configuration. Le code change toutes les 30 secondes.
                  </Text>
                  <Text style={styles.secretLabel}>Clé de configuration</Text>
                  <Text selectable style={styles.secret} testID="admin-2fa-secret">{secret}</Text>
                  <TouchableOpacity
                    onPress={async () => {
                      try {
                        await Clipboard.setStringAsync(secret);
                        setCopied(true);
                        setError("");
                      } catch {
                        setError("Copie impossible. Vous pouvez sélectionner la clé ci-dessus.");
                      }
                    }}
                    style={styles.copyButton}
                    accessibilityRole="button"
                    testID="admin-2fa-copy-secret"
                  >
                    <Ionicons name="copy-outline" size={17} color={theme.colors.primary} />
                    <Text style={styles.copyText}>{copied ? "Clé copiée" : "Copier la clé"}</Text>
                  </TouchableOpacity>
                  <Text style={[styles.sectionTitle, { marginTop: 16 }]}>2. Confirmez votre compte</Text>
                </View>
              ) : null}

              {phase === "verify" || phase === "setup" ? (
                <View style={styles.form}>
                  <TextInput
                    value={username}
                    onChangeText={setUsername}
                    placeholder="Nom d’utilisateur"
                    autoCapitalize="none"
                    autoCorrect={false}
                    textContentType="username"
                    style={styles.input}
                    accessibilityLabel="Nom d’utilisateur administrateur"
                    testID="admin-2fa-username"
                  />
                  <TextInput
                    value={code}
                    onChangeText={(value) => setCode(value.replace(/\s/g, "").slice(0, 32))}
                    placeholder={phase === "setup" ? "Code à six chiffres" : "Code Authenticator ou secours"}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    keyboardType={phase === "setup" && Platform.OS !== "web" ? "number-pad" : "default"}
                    style={[styles.input, styles.codeInput]}
                    accessibilityLabel="Code de vérification"
                    testID="admin-2fa-code"
                  />
                  {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
                  <TouchableOpacity
                    onPress={submitCode}
                    disabled={busy || !username.trim() || !code.trim()}
                    style={[styles.primaryButton, (busy || !username.trim() || !code.trim()) && styles.disabled]}
                    accessibilityRole="button"
                    testID="admin-2fa-submit"
                  >
                    {busy ? <ActivityIndicator color={theme.colors.textInverse} /> : null}
                    <Text style={styles.primaryText}>{phase === "setup" ? "Activer et continuer" : "Valider le code"}</Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              {phase === "backup" ? (
                <View style={styles.backupBox}>
                  <Text style={styles.sectionTitle}>Codes de secours à usage unique</Text>
                  <Text style={styles.instructions}>
                    Gardez ces codes dans un endroit privé. Chacun ne peut être utilisé qu’une seule fois.
                  </Text>
                  <View style={styles.codes}>
                    {backupCodes.map((item) => <Text key={item} selectable style={styles.backupCode}>{item}</Text>)}
                  </View>
                  {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
                  <TouchableOpacity
                    onPress={copyBackupCodes}
                    style={styles.copyButton}
                    accessibilityRole="button"
                    testID="admin-2fa-copy-backup-codes"
                  >
                    <Ionicons name={copied ? "checkmark-circle-outline" : "copy-outline"} size={17} color={theme.colors.primary} />
                    <Text style={styles.copyText}>{copied ? "Codes copiés" : "Copier les codes"}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={continueToAdmin}
                    style={styles.primaryButton}
                    accessibilityRole="button"
                    testID="admin-2fa-continue"
                  >
                    <Text style={styles.primaryText}>J’ai sauvegardé les codes</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(10, 20, 40, 0.58)" },
  center: { flex: 1, justifyContent: "center" },
  scroll: { flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 18 },
  card: {
    width: "100%", maxWidth: 440, backgroundColor: theme.colors.surface,
    borderRadius: 22, padding: 22, borderWidth: 1, borderColor: theme.colors.border,
    ...theme.shadow.lifted,
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: theme.colors.primaryBg, alignItems: "center", justifyContent: "center" },
  close: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceSecondary },
  title: { color: theme.colors.textPrimary, fontSize: 20, fontWeight: "700", marginTop: 16 },
  subtitle: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 6, marginBottom: 16 },
  loading: { minHeight: 100, alignItems: "center", justifyContent: "center", gap: 10 },
  muted: { color: theme.colors.textSecondary, fontSize: 13 },
  setupBox: { borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceMuted, padding: 14 },
  sectionTitle: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "700" },
  instructions: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 6 },
  secretLabel: { color: theme.colors.textMuted, fontSize: 11, marginTop: 12, marginBottom: 5 },
  secret: { color: theme.colors.textPrimary, fontFamily: "monospace", fontSize: 13, lineHeight: 19, padding: 10, borderRadius: 10, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, letterSpacing: 0.8 },
  form: { marginTop: 14, gap: 10 },
  input: { minHeight: 50, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.borderStrong, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: theme.colors.textPrimary, backgroundColor: theme.colors.surface },
  codeInput: { letterSpacing: 2, fontVariant: ["tabular-nums"] },
  error: { color: theme.colors.danger, fontSize: 12, lineHeight: 17 },
  primaryButton: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 16, borderRadius: 12, backgroundColor: theme.colors.primary, marginTop: 12 },
  primaryText: { color: theme.colors.textInverse, fontSize: 14, fontWeight: "700", textAlign: "center" },
  disabled: { opacity: 0.55 },
  copyButton: { minHeight: 40, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, borderRadius: 10, backgroundColor: theme.colors.primaryBg, marginTop: 10 },
  copyText: { color: theme.colors.primaryDark, fontSize: 12, fontWeight: "600" },
  backupBox: { borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceMuted, padding: 14 },
  codes: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  backupCode: { width: "47%", padding: 8, textAlign: "center", borderRadius: 8, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, color: theme.colors.textPrimary, fontFamily: "monospace", fontSize: 12 },
});
