import React, { useEffect, useRef, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Button } from "@/src/components/Button";
import { Input } from "@/src/components/Input";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type ResetRequestResponse = { challenge_id: string; expires_in: number; resend_after: number };
type ResetConfirmResponse = { ok: boolean };
type Stage = "request" | "confirm" | "success";

const GENERIC_SENT_COPY = "Si un compte correspond à cette adresse, un code a été envoyé.";

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function safeError(error: unknown, fallback: string): string {
  const detail = (error as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" && detail.trim()
    ? detail.trim().slice(0, 200)
    : fallback;
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

export default function ForgotPassword() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("request");
  const [email, setEmail] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [requestSent, setRequestSent] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!challengeId) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challengeId]);

  const expirySeconds = expiresAt === null ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const resendSeconds = resendAt === null ? 0 : Math.max(0, Math.ceil((resendAt - now) / 1000));
  const challengeExpired = !!challengeId && expirySeconds === 0;

  const beginBusy = (): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    return true;
  };

  const endBusy = () => {
    busyRef.current = false;
    setBusy(false);
  };

  const requestCode = async () => {
    if (!beginBusy()) return;
    const address = email.trim();
    if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setError("Saisissez une adresse e-mail valide.");
      endBusy();
      return;
    }
    try {
      const result = await api.post<ResetRequestResponse>(
        "/identity/password-reset/request",
        { email: address },
        { auth: false, credentials: "include" },
      );
      if (!result || typeof result.challenge_id !== "string" || !result.challenge_id) {
        throw new Error("Réponse de réinitialisation invalide.");
      }
      const requestedAt = Date.now();
      const expiry = Number.isFinite(result.expires_in) && result.expires_in > 0 ? result.expires_in : 600;
      const resend = Number.isFinite(result.resend_after) && result.resend_after > 0 ? result.resend_after : 60;
      setEmail(address);
      setChallengeId(result.challenge_id);
      setExpiresAt(requestedAt + expiry * 1000);
      setResendAt(requestedAt + resend * 1000);
      setNow(requestedAt);
      setCode("");
      setPassword("");
      setPasswordConfirm("");
      setRequestSent(true);
      setStage("confirm");
    } catch (e) {
      setError(safeError(e, "Impossible d’envoyer le code. Réessayez dans un instant."));
    } finally {
      endBusy();
    }
  };

  const changeAddress = () => {
    setStage("request");
    setChallengeId(null);
    setExpiresAt(null);
    setResendAt(null);
    setCode("");
    setPassword("");
    setPasswordConfirm("");
    setRequestSent(false);
    setError("");
  };

  const resendCode = async () => {
    if (!challengeId || resendSeconds > 0 || !beginBusy()) return;
    const address = email.trim();
    try {
      const result = await api.post<ResetRequestResponse>(
        "/identity/password-reset/request",
        { email: address },
        { auth: false, credentials: "include" },
      );
      if (!result || typeof result.challenge_id !== "string" || !result.challenge_id) {
        throw new Error("Réponse de réinitialisation invalide.");
      }
      const requestedAt = Date.now();
      const expiry = Number.isFinite(result.expires_in) && result.expires_in > 0 ? result.expires_in : 600;
      const resend = Number.isFinite(result.resend_after) && result.resend_after > 0 ? result.resend_after : 60;
      setChallengeId(result.challenge_id);
      setExpiresAt(requestedAt + expiry * 1000);
      setResendAt(requestedAt + resend * 1000);
      setNow(requestedAt);
      setCode("");
      setPassword("");
      setPasswordConfirm("");
      setRequestSent(true);
    } catch (e) {
      setError(safeError(e, "Impossible de renvoyer le code. Réessayez."));
    } finally {
      endBusy();
    }
  };

  const confirmReset = async () => {
    if (!beginBusy()) return;
    if (!challengeId || challengeExpired) {
      setError("Le code a expiré. Demandez-en un nouveau.");
      endBusy();
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError("Saisissez le code à six chiffres.");
      endBusy();
      return;
    }
    if (Array.from(password).length < 8) {
      setError("Le nouveau mot de passe doit contenir au moins 8 caractères.");
      endBusy();
      return;
    }
    if (utf8ByteLength(password) > 72) {
      setError("Le nouveau mot de passe ne peut pas dépasser 72 octets en UTF-8.");
      endBusy();
      return;
    }
    if (password !== passwordConfirm) {
      setError("Les deux mots de passe ne correspondent pas.");
      endBusy();
      return;
    }
    try {
      const result = await api.post<ResetConfirmResponse>(
        "/identity/password-reset/confirm",
        { challenge_id: challengeId, code, password, password_confirm: passwordConfirm },
        { auth: false, credentials: "include" },
      );
      if (result?.ok !== true) throw new Error("La réinitialisation n’a pas pu être confirmée.");
      setStage("success");
      setChallengeId(null);
      setExpiresAt(null);
      setResendAt(null);
      setCode("");
      setPassword("");
      setPasswordConfirm("");
      setError("");
    } catch (e) {
      setError(safeError(e, "Impossible de réinitialiser le mot de passe. Vérifiez le code et réessayez."));
    } finally {
      endBusy();
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
            <View style={styles.logoBox}>
              <Image
                source={require("@/assets/images/spiloveure-logo.png")}
                style={styles.logo}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.welcome}>Récupérer votre compte</Text>
            <Text style={styles.welcomeSub}>Un nouveau départ, en toute sécurité.</Text>
          </LinearGradient>

          <View style={styles.card}>
            {stage === "success" ? (
              <View style={styles.successContent} testID="reset-success">
                <View style={styles.successIcon}>
                  <Ionicons name="checkmark" size={25} color={theme.colors.success} />
                </View>
                <Text style={styles.title}>Mot de passe modifié</Text>
                <Text style={styles.subtitle}>
                  Votre nouveau mot de passe est prêt. Connectez-vous avec vos nouvelles informations.
                </Text>
                <Button
                  title="Retour à la connexion"
                  onPress={() => router.replace("/(auth)/login" as any)}
                  icon={<Ionicons name="arrow-back-outline" size={18} color="#fff" />}
                  testID="reset-back-login"
                />
              </View>
            ) : (
              <>
                <Text style={styles.title}>Mot de passe oublié</Text>
                <Text style={styles.subtitle}>
                  {stage === "request"
                    ? "Recevez un code pour choisir un nouveau mot de passe."
                    : "Saisissez le code reçu puis choisissez un nouveau mot de passe."}
                </Text>

                {error ? (
                  <View style={styles.errBox} testID="reset-error" accessibilityRole="alert">
                    <Ionicons name="alert-circle" size={18} color={theme.colors.danger} />
                    <Text style={styles.errText}>{error}</Text>
                  </View>
                ) : null}

                {stage === "request" ? (
                  <>
                    <Input
                      label="E-mail"
                      icon="mail-outline"
                      placeholder="Entrez votre adresse e-mail"
                      value={email}
                      onChangeText={setEmail}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="email-address"
                      editable={!busy}
                      testID="reset-email"
                    />
                    <Button
                      title="ENVOYER LE CODE"
                      onPress={requestCode}
                      loading={busy}
                      icon={<Ionicons name="mail-outline" size={18} color="#fff" />}
                      testID="reset-request"
                    />
                  </>
                ) : (
                  <>
                    <View style={styles.addressRow}>
                      <View style={styles.addressCopy}>
                        <Text style={styles.addressLabel}>Code demandé pour</Text>
                        <Text style={styles.addressText} numberOfLines={2}>{email}</Text>
                      </View>
                      <TouchableOpacity
                        onPress={changeAddress}
                        disabled={busy}
                        accessibilityRole="button"
                        testID="reset-change-address"
                        style={styles.changeAddress}
                      >
                        <Text style={styles.link}>Changer d’adresse</Text>
                      </TouchableOpacity>
                    </View>

                    {requestSent ? <Text style={styles.neutralNote}>{GENERIC_SENT_COPY}</Text> : null}
                    <Input
                      label="Code à six chiffres"
                      icon="keypad-outline"
                      placeholder="000000"
                      value={code}
                      onChangeText={value => setCode(value.replace(/\D/g, "").slice(0, 6))}
                      keyboardType="number-pad"
                      autoCapitalize="none"
                      editable={!busy && !challengeExpired}
                      maxLength={6}
                      testID="reset-code"
                    />
                    <Input
                      label="Nouveau mot de passe"
                      icon="lock-closed-outline"
                      placeholder="8 caractères minimum"
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry={!showPassword}
                      rightIcon={showPassword ? "eye-off-outline" : "eye-outline"}
                      onRightIconPress={() => setShowPassword(value => !value)}
                      editable={!busy && !challengeExpired}
                      autoCapitalize="none"
                      autoCorrect={false}
                      testID="reset-password"
                    />
                    <Input
                      label="Confirmer le mot de passe"
                      icon="lock-closed-outline"
                      placeholder="Répétez le nouveau mot de passe"
                      value={passwordConfirm}
                      onChangeText={setPasswordConfirm}
                      secureTextEntry={!showPasswordConfirm}
                      rightIcon={showPasswordConfirm ? "eye-off-outline" : "eye-outline"}
                      onRightIconPress={() => setShowPasswordConfirm(value => !value)}
                      editable={!busy && !challengeExpired}
                      autoCapitalize="none"
                      autoCorrect={false}
                      testID="reset-password-confirm"
                    />
                    <Text style={styles.passwordHint}>8 caractères minimum · 72 octets UTF-8 maximum</Text>

                    {challengeExpired ? (
                      <Text style={styles.expiredNote} testID="reset-expired">
                        Ce code a expiré. Demandez-en un nouveau pour continuer.
                      </Text>
                    ) : (
                      <Text style={styles.timerNote}>Ce code expire dans {formatTime(expirySeconds)}.</Text>
                    )}

                    <Button
                      title="RÉINITIALISER LE MOT DE PASSE"
                      onPress={confirmReset}
                      loading={busy}
                      disabled={challengeExpired}
                      icon={<Ionicons name="lock-open-outline" size={18} color="#fff" />}
                      testID="reset-confirm"
                    />

                    <TouchableOpacity
                      onPress={resendCode}
                      disabled={busy || resendSeconds > 0}
                      accessibilityRole="button"
                      testID="reset-resend"
                      style={[styles.resendButton, (busy || resendSeconds > 0) && styles.resendDisabled]}
                    >
                      <Ionicons name="refresh-outline" size={16} color={theme.colors.primary} />
                      <Text style={styles.resendText}>
                        {resendSeconds > 0 ? `Renvoyer le code dans ${formatTime(resendSeconds)}` : "Renvoyer le code"}
                      </Text>
                    </TouchableOpacity>
                  </>
                )}
              </>
            )}
          </View>
          <Text style={styles.footer}>SPILOVEURE · Un réseau qui vous ressemble</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0, backgroundColor: theme.colors.background },
  flex: { flex: 1, minWidth: 0 },
  scrollContent: { flexGrow: 1, paddingBottom: 24 },
  header: { paddingTop: 30, paddingBottom: 32, paddingHorizontal: 24, alignItems: "center" },
  logoBox: { alignItems: "center", marginBottom: 12 },
  logo: { width: 84, height: 84 },
  welcome: { color: "#fff", fontSize: 20, fontWeight: "700", textAlign: "center", letterSpacing: -0.2 },
  welcomeSub: { color: "#C7D9FF", fontSize: 13, lineHeight: 18, textAlign: "center", marginTop: 4 },
  card: {
    minWidth: 0,
    backgroundColor: "#fff",
    marginTop: -20,
    marginHorizontal: 16,
    borderRadius: 24,
    padding: 22,
    ...theme.shadow.card,
  },
  title: { fontSize: 17, fontWeight: "700", color: theme.colors.textPrimary, textAlign: "center", letterSpacing: -0.2 },
  subtitle: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, textAlign: "center", marginTop: 5, marginBottom: 20 },
  link: { color: theme.colors.primary, fontWeight: "600", fontSize: 12, textAlign: "right" },
  errBox: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.colors.dangerBg, padding: 12, borderRadius: 14, marginBottom: 12 },
  errText: { color: theme.colors.danger, flex: 1, minWidth: 0, fontWeight: "600", fontSize: 12, lineHeight: 17 },
  neutralNote: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, marginTop: -7, marginBottom: 14, textAlign: "center" },
  addressRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14, padding: 11, borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary },
  addressCopy: { flex: 1, minWidth: 0 },
  addressLabel: { color: theme.colors.textSecondary, fontSize: 11 },
  addressText: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "700", marginTop: 2 },
  changeAddress: { maxWidth: 112, paddingVertical: 5, paddingHorizontal: 4 },
  passwordHint: { color: theme.colors.textSecondary, fontSize: 11, marginTop: -8, marginBottom: 12, lineHeight: 16 },
  timerNote: { color: theme.colors.textSecondary, fontSize: 12, marginTop: -6, marginBottom: 12 },
  expiredNote: { color: theme.colors.danger, fontSize: 12, lineHeight: 17, marginTop: -6, marginBottom: 12 },
  resendButton: { minHeight: 42, alignSelf: "center", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 10, marginTop: 5 },
  resendDisabled: { opacity: 0.55 },
  resendText: { color: theme.colors.primary, fontSize: 12, fontWeight: "700", textAlign: "center" },
  successContent: { alignItems: "center" },
  successIcon: { width: 50, height: 50, borderRadius: 25, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.successBg, marginBottom: 12 },
  footer: { color: theme.colors.textSecondary, fontSize: 11, textAlign: "center", marginTop: 20, paddingHorizontal: 16 },
});
