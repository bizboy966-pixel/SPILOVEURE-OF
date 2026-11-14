import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { useChat } from "@/src/chat/ChatContext";
import { theme } from "@/src/theme";

type Country = { code: string; name: string; dial: string; flag: string };
type IdentityState = { user: any; email_verified: boolean; activated: boolean; password_created: boolean; chat_authenticated: boolean; main_authenticated: boolean };
const logo = require("@/assets/images/spiloveure-logo.png");

function Page({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  const entrance = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(entrance, { toValue: 1, duration: 520, useNativeDriver: true }).start(); }, [entrance]);
  return <ScrollView contentContainerStyle={s.page}><View style={s.card}>
    <Animated.Image source={logo} style={[s.logo, { opacity: entrance, transform: [{ scale: entrance.interpolate({ inputRange: [0, 1], outputRange: [.86, 1] }) }] }]} resizeMode="contain" />
    <Text style={s.brand}>SPILOVEURE</Text><Text style={s.title}>{title}</Text><Text style={s.subtitle}>{subtitle}</Text>{children}
  </View></ScrollView>;
}
function Action({ label, onPress, testID, disabled = false }: { label: string; onPress: () => void; testID?: string; disabled?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} testID={testID} disabled={disabled} onPress={onPress} style={[s.button, disabled && { opacity: .55 }]}><Text style={s.buttonText}>{label}</Text></TouchableOpacity>;
}
function ErrorText({ children }: { children: string }) { return children ? <Text accessibilityRole="alert" style={s.error}>{children}</Text> : null; }
function paramsQuery(params: Record<string, any>) {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v != null && String(v)) p.set(k, String(v)); });
  return p.toString();
}
function safeVerificationReturn(target: unknown): string {
  if (target === "/messenger" || target === "/account-access" || target === "/account-access?source=chat") return target;
  return "/messenger";
}

export function WelcomePage() {
  const router = useRouter(); const p = useLocalSearchParams<{ ref?: string }>();
  return <Page title="Bienvenue sur SPILOVEURE" subtitle="Entrez dans votre communauté avant de choisir votre formule.">
    <View style={s.intro}><Ionicons name="people-outline" size={24} color={theme.colors.primary} /><Text style={s.introText}>Votre espace communautaire commence ici. Le paiement d’activation viendra plus tard.</Text></View>
    <Action label="Accepter et continuer" testID="onboarding-welcome-continue" onPress={() => router.push(`/choose-country?${paramsQuery({ ref: p.ref })}` as any)} />
  </Page>;
}

export function CountryPage() {
  const router = useRouter(); const p = useLocalSearchParams<{ ref?: string; country?: string }>();
  const [countries, setCountries] = useState<Country[]>([]); const [selected, setSelected] = useState(String(p.country || ""));
  const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  useEffect(() => { api.get<{ countries: Country[] }>("/config", { auth: false }).then(r => { setCountries(r.countries || []); setSelected(old => old || r.countries?.[0]?.code || ""); }).catch(() => setError("Impossible de charger la liste des pays. Réessayez.")).finally(() => setLoading(false)); }, []);
  return <Page title="Votre pays" subtitle="Choisissez votre pays de résidence.">
    {loading ? <View style={s.countrySkeleton}>{[1, 2, 3, 4, 5].map(n => <View key={n} style={s.countrySkeletonRow} />)}</View> : <View style={s.countryList}>{countries.map(c => <TouchableOpacity key={c.code} onPress={() => setSelected(c.code)} accessibilityRole="radio" accessibilityState={{ selected: selected === c.code }} style={[s.country, selected === c.code && s.countryOn]}><Text style={s.flag}>{c.flag}</Text><Text style={s.countryName}>{c.name}</Text><Ionicons name={selected === c.code ? "radio-button-on" : "radio-button-off"} color={theme.colors.primary} size={20} /></TouchableOpacity>)}</View>}
    <ErrorText>{error}</ErrorText><Action label="Continuer" testID="onboarding-country-continue" disabled={!selected || loading} onPress={() => router.push(`/registration-email?${paramsQuery({ ref: p.ref, country: selected })}` as any)} />
  </Page>;
}

export function RegistrationEmailPage() {
  const router = useRouter(); const p = useLocalSearchParams<{ ref?: string; country?: string }>();
  const [email, setEmail] = useState(""); const [error, setError] = useState("");
  const submit = () => {
    const value = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { setError("Saisissez une adresse e-mail valide."); return; }
    router.push(`/register?${paramsQuery({ via: "landing", flow: "2", country: p.country, email: value, ref: p.ref })}` as any);
  };
  return <Page title="Votre adresse e-mail" subtitle="Elle servira à sécuriser votre accès à SPILOVEURE Chat.">
    <TextInput accessibilityLabel="Adresse e-mail" testID="onboarding-email" value={email} onChangeText={v => { setEmail(v); setError(""); }} keyboardType="email-address" autoCapitalize="none" autoComplete="email" placeholder="vous@exemple.com" style={s.input} />
    <ErrorText>{error}</ErrorText><Action label="Continuer" testID="onboarding-email-continue" onPress={submit} />
  </Page>;
}

export function VerifyEmailPage() {
  const router = useRouter(); const p = useLocalSearchParams<{ returnTo?: string; source?: string; expired?: string }>(); const { refresh: refreshChat } = useChat();
  const source = p.source === "chat" ? "?source=chat" : "";
  const [state, setState] = useState<IdentityState | null>(null); const [email, setEmail] = useState(""); const [challenge, setChallenge] = useState("");
  const [digits, setDigits] = useState(["", "", "", "", "", ""]); const inputs = useRef<Array<TextInput | null>>([]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [remaining, setRemaining] = useState(0); const [expires, setExpires] = useState(0); const [modal, setModal] = useState(false);
  useEffect(() => { api.get<IdentityState>(`/identity/state${source}`, { credentials: "include" }).then(v => { setState(v); setEmail(v.user?.email || ""); if (v.email_verified) setError(""); }).catch(() => setState(null)); }, [source]);
  useEffect(() => { if (!remaining && !expires) return; const t = setInterval(() => { setRemaining(v => Math.max(0, v - 1)); setExpires(v => Math.max(0, v - 1)); }, 1000); return () => clearInterval(t); }, [remaining > 0, expires > 0]);
  const canOpenChatWithoutCode = !!state?.email_verified && (!!state.main_authenticated || !!state.chat_authenticated);
  const requestCode = async () => { setBusy(true); setError(""); try { const r = await api.post<{ challenge_id: string; expires_in: number; resend_after: number }>(`/identity/email/request${source}`, { ...(state ? {} : { email: email.trim() }) }, { credentials: "include" }); setChallenge(r.challenge_id); setExpires(r.expires_in); setRemaining(r.resend_after); setDigits(["", "", "", "", "", ""]); setModal(true); setTimeout(() => inputs.current[0]?.focus(), 80); } catch (e: any) { setError(e?.detail || "Le code n’a pas pu être envoyé. Le service d’envoi est peut-être indisponible."); } finally { setBusy(false); } };
  const changeDigit = (index: number, value: string) => {
    const chars = value.replace(/\D/g, "");
    if (chars.length > 1) { const next = chars.slice(0, 6).split(""); setDigits([...next, ...Array(6 - next.length).fill("")]); inputs.current[Math.min(next.length, 5)]?.focus(); return; }
    const next = [...digits]; next[index] = chars.slice(-1); setDigits(next);
    if (chars && index < 5) inputs.current[index + 1]?.focus();
    if (!chars && index > 0) inputs.current[index - 1]?.focus();
  };
  const verify = async () => { const code = digits.join(""); if (!/^\d{6}$/.test(code)) { setError("Saisissez les six chiffres du code."); return; } setBusy(true); setError(""); try { const verified = await api.post<IdentityState>(`/identity/email/verify${source}`, { challenge_id: challenge, code }, { credentials: "include" }); const chatUser = await refreshChat(); if (!chatUser || chatUser.id !== verified.user?.id) throw { detail: "La session Chat ouverte ne correspond pas au compte vérifié. Déconnectez la session actuelle avant de continuer." }; setModal(false); router.replace(safeVerificationReturn(p.returnTo) as any); } catch (e: any) { setError(e?.detail || "Code incorrect ou expiré. Demandez un nouveau code si nécessaire."); } finally { setBusy(false); } };
  return <Page title="Vérifiez votre adresse e-mail" subtitle={email ? `Nous enverrons un code à ${email}.` : "Saisissez l’adresse associée à votre compte pour retrouver votre Chat."}>
    {!state && <TextInput accessibilityLabel="Adresse e-mail" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder="vous@exemple.com" style={s.input} />}
    {p.expired === "1" && <Text style={s.recoveryNotice}>Votre session Chat a expiré. Vérifiez à nouveau votre adresse pour retrouver le Chat.</Text>}
    {state?.email_verified && !canOpenChatWithoutCode && <Text style={s.recoveryNotice}>Cette adresse est déjà vérifiée, mais cet appareil n’a pas de session autorisée. Saisissez le code reçu par e-mail pour autoriser cet appareil.</Text>}
    <ErrorText>{error}</ErrorText>
    {canOpenChatWithoutCode ? <Action label="Ouvrir SPILOVEURE Chat" onPress={async () => { setBusy(true); try { await api.post(`/identity/chat/open${source}`, undefined, { credentials: "include" }); const chatUser = await refreshChat(); if (!chatUser || chatUser.id !== state?.user?.id) throw { detail: "La session Chat ouverte ne correspond pas au compte sélectionné. Déconnectez la session actuelle avant de continuer." }; router.replace(safeVerificationReturn(p.returnTo) as any); } catch (e: any) { setError(e?.detail || "Impossible d’ouvrir le Chat."); } finally { setBusy(false); } }} /> : <Action label={busy ? "Envoi en cours…" : "Envoyer le code"} testID="email-send-code" disabled={busy || (!state && !email.trim())} onPress={requestCode} />}
    {busy ? <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 12 }} /> : null}
    {modal && <View style={s.overlay}><View style={s.modal}><Text style={s.modalTitle}>Saisissez le code</Text><Text style={s.modalCopy}>Si un compte correspond à cette adresse, un code a été envoyé. Aucun compte ne sera créé ou associé à cette demande. Expiration dans {Math.floor(expires / 60)}:{String(expires % 60).padStart(2, "0")}.</Text><View style={s.codeRow}>{digits.map((v, i) => <TextInput key={i} ref={el => { inputs.current[i] = el; }} testID={`email-code-${i}`} accessibilityLabel={`Chiffre ${i + 1} du code`} value={v} onChangeText={text => changeDigit(i, text)} onKeyPress={({ nativeEvent }) => { if (nativeEvent.key === "Backspace" && !digits[i] && i > 0) inputs.current[i - 1]?.focus(); }} keyboardType="number-pad" maxLength={6} style={s.codeInput} />)}</View><ErrorText>{error}</ErrorText><Action label="Valider" testID="email-code-submit" disabled={busy} onPress={verify} /><TouchableOpacity testID="email-code-resend" accessibilityLabel="Renvoyer le code" disabled={remaining > 0 || busy} onPress={requestCode} style={s.resend}><Text style={[s.link, remaining > 0 && { opacity: .5 }]}>Renvoyer le code{remaining > 0 ? ` dans ${remaining}s` : ""}</Text></TouchableOpacity><TouchableOpacity onPress={() => setModal(false)} accessibilityLabel="Fermer"><Text style={s.cancel}>Fermer</Text></TouchableOpacity></View></View>}
  </Page>;
}

export function AccountAccessPage() {
  const router = useRouter(); const p = useLocalSearchParams<{ source?: string }>(); const { refresh: refreshChat } = useChat(); const { adoptSession } = useAuth();
  const [state, setState] = useState<IdentityState | null>(null); const [password, setPassword] = useState(""); const [confirm, setConfirm] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const source = p.source === "chat" ? "?source=chat" : "";
  const sourceQuery = p.source === "chat" ? "&source=chat" : "";
  const mustCreatePassword = state?.user?.auth_flow_version === 2 && !state.password_created;
  const needsChatAuthorizationForSetup = state?.user?.auth_flow_version === 2 && !state.password_created && !state.chat_authenticated;
  useEffect(() => { api.get<IdentityState>(`/identity/state${source}`, { credentials: "include" }).then(setState).catch((e: any) => { if (e?.status === 401) setError("Votre session est introuvable. Connectez-vous ou vérifiez votre adresse e-mail."); else setError(e?.detail || "Impossible de vérifier l’état du compte."); }); }, [source]);
  useEffect(() => { if (!state) return; if (!state.activated) { (async () => { try { if (source) { const result = await api.post<{ access_token: string; user: any }>("/identity/onboarding-session?source=chat", undefined, { credentials: "include" }); await adoptSession(result.access_token, result.user); } router.replace("/(app)/pay" as any); } catch (e: any) { setError(e?.detail || "Impossible de reprendre la session de paiement."); } })(); return; } if (!state.email_verified || needsChatAuthorizationForSetup) router.replace(`/verify-email?returnTo=${encodeURIComponent(`/account-access${source}`)}${sourceQuery}` as any); }, [state, source, sourceQuery, needsChatAuthorizationForSetup, router, adoptSession]);
  const submit = async () => { setBusy(true); setError(""); try { let result: { access_token: string; user: any }; if (mustCreatePassword) { if (!password || password !== confirm) throw { detail: "Les deux mots de passe doivent être identiques." }; result = await api.post<{ access_token: string; user: any }>(`/identity/password${source}`, { password, password_confirm: confirm }, { credentials: "include" }); } else { result = await api.post<{ access_token: string; user: any }>(`/identity/unlock${source}`, { password }, { credentials: "include" }); } await adoptSession(result.access_token, result.user); await refreshChat(); router.replace("/(app)/dashboard" as any); } catch (e: any) { setError(e?.detail || "Impossible d’accéder au compte."); } finally { setBusy(false); } };
  if (state && !state.activated) return <Page title="Paiement requis" subtitle="Votre compte principal reste protégé jusqu’à son activation."><ErrorText>{error}</ErrorText><Action label="Continuer vers le paiement" onPress={() => router.replace("/(app)/pay" as any)} /></Page>;
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><Page title={mustCreatePassword ? "Créer mon mot de passe" : "Accéder à mon compte"} subtitle={mustCreatePassword ? "Choisissez un mot de passe pour votre compte activé." : "Saisissez votre mot de passe existant pour ouvrir votre espace principal."}>
    {!state && <><ErrorText>{error || "L’état de ce compte n’est pas disponible."}</ErrorText><Action label="Vérifier mon adresse e-mail" onPress={() => router.push(`/verify-email?source=${p.source === "chat" ? "chat&returnTo=%2Faccount-access%3Fsource%3Dchat" : ""}` as any)} /></>}
    {state && <>
    <TextInput testID="main-password" accessibilityLabel="Mot de passe" value={password} onChangeText={setPassword} secureTextEntry placeholder="Mot de passe" style={s.input} />
    {mustCreatePassword && <TextInput testID="main-password-confirm" accessibilityLabel="Confirmer le mot de passe" value={confirm} onChangeText={setConfirm} secureTextEntry placeholder="Confirmer le mot de passe" style={s.input} />}
    <ErrorText>{error}</ErrorText><Action label={busy ? "Patientez…" : "Accéder à mon compte"} testID="main-account-submit" disabled={busy || !state} onPress={submit} />
    </>}
  </Page></KeyboardAvoidingView>;
}

const s = StyleSheet.create({
  page: { flexGrow: 1, minHeight: "100%", justifyContent: "center", padding: 22, backgroundColor: theme.colors.background },
  card: { width: "100%", maxWidth: 480, alignSelf: "center", backgroundColor: "#fff", borderRadius: 26, padding: 26, alignItems: "center", borderWidth: 1, borderColor: theme.colors.border, ...theme.shadow.card },
  logo: { width: 84, height: 84 }, brand: { color: theme.colors.primaryDark, fontWeight: "800", letterSpacing: 1.2, marginTop: 5 },
  title: { fontSize: 25, lineHeight: 31, fontWeight: "800", color: theme.colors.textPrimary, textAlign: "center", marginTop: 22 },
  subtitle: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 21, textAlign: "center", marginTop: 8, marginBottom: 22 },
  intro: { width: "100%", flexDirection: "row", gap: 12, padding: 15, borderRadius: 16, backgroundColor: theme.colors.primaryBg, marginBottom: 18, alignItems: "center" },
  introText: { flex: 1, color: theme.colors.textPrimary, fontSize: 13, lineHeight: 19 },
  button: { width: "100%", minHeight: 50, borderRadius: 15, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center", marginTop: 8, paddingHorizontal: 16 },
  buttonText: { color: "#fff", fontWeight: "800", fontSize: 15 }, input: { width: "100%", minHeight: 50, borderWidth: 1, borderColor: theme.colors.borderStrong, borderRadius: 13, paddingHorizontal: 14, marginBottom: 11, color: theme.colors.textPrimary, backgroundColor: "#fff" },
  error: { color: theme.colors.danger, backgroundColor: theme.colors.dangerBg, padding: 10, borderRadius: 10, fontSize: 13, marginBottom: 10, width: "100%" },
  countryList: { width: "100%", maxHeight: 420 }, country: { width: "100%", flexDirection: "row", alignItems: "center", gap: 12, padding: 13, borderBottomWidth: 1, borderColor: theme.colors.border }, countryOn: { backgroundColor: theme.colors.primaryBg, borderRadius: 11 }, flag: { fontSize: 23 }, countryName: { flex: 1, color: theme.colors.textPrimary, fontSize: 15, fontWeight: "700" },
  countrySkeleton: { width: "100%", gap: 8 }, countrySkeletonRow: { height: 48, borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary },
  overlay: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "rgba(7,27,62,.52)", alignItems: "center", justifyContent: "center", padding: 15 },
  modal: { width: "100%", maxWidth: 390, borderRadius: 22, backgroundColor: "#fff", padding: 22, alignItems: "center" }, modalTitle: { fontSize: 20, fontWeight: "800", color: theme.colors.textPrimary }, modalCopy: { textAlign: "center", color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 7, marginBottom: 18 },
  codeRow: { flexDirection: "row", gap: 7, marginBottom: 12 }, codeInput: { width: 42, height: 50, borderWidth: 1, borderColor: theme.colors.borderStrong, borderRadius: 11, textAlign: "center", fontSize: 21, fontWeight: "800", color: theme.colors.textPrimary },
  resend: { padding: 12 }, link: { color: theme.colors.primary, fontWeight: "700" }, cancel: { color: theme.colors.textSecondary, padding: 8 },
  recoveryNotice: { width: "100%", color: theme.colors.textPrimary, backgroundColor: theme.colors.primaryBg, borderRadius: 12, padding: 12, marginBottom: 12, fontSize: 13, lineHeight: 19 },
});
