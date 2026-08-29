/**
 * /support-desk — dedicated support agent entry point.
 *
 * Public URL. New visitors register (creates a `role:support, status:pending`
 * user). Existing authorized agents log in and see ONLY the chat interface
 * (no admin dashboard). Pending/revoked accounts get a clear message.
 *
 * Once logged in, the same AdminSupportTab component is reused because the
 * backend `/chat/admin/*` endpoints now accept EITHER admin OR authorized
 * support agents (see `require_admin_or_support`).
 */
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator, SafeAreaView, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api, setAuthToken } from "@/src/api";
import { theme } from "@/src/theme";
import AdminSupportTab from "@/src/components/AdminSupportTab";

const TOK = "spilv_support_token";

export default function SupportDesk() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [me, setMe] = useState<any>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = window.localStorage.getItem(TOK);
    if (t) {
      setAuthToken(t);
      setAuthed(true);
      try { setMe(JSON.parse(window.localStorage.getItem(TOK + "_user") || "{}")); } catch {}
    }
  }, []);

  // ── Auth guardian ────────────────────────────────────────────────
  // AuthProvider (from app/_layout.tsx) runs on every route and may hydrate
  // a DIFFERENT token from the main-app secure storage, overriding the
  // support token in the in-memory cache — causing every subsequent
  // /chat/admin/* call to fail with 403 "Accès réservé…". We defend against
  // that by re-applying the support token on an interval AND whenever the
  // page regains focus.
  useEffect(() => {
    if (!authed) return;
    if (typeof window === "undefined") return;
    const reapply = () => {
      const t = window.localStorage.getItem(TOK);
      if (t) setAuthToken(t);
    };
    // Immediate re-apply after AuthProvider's async hydration settles.
    const t0 = setTimeout(reapply, 200);
    const t1 = setTimeout(reapply, 1500);
    // Keep pinning while /support-desk is open — cheap sync writes.
    const id = setInterval(reapply, 2000);
    window.addEventListener("focus", reapply);
    window.addEventListener("visibilitychange", reapply);
    return () => {
      clearTimeout(t0); clearTimeout(t1); clearInterval(id);
      window.removeEventListener("focus", reapply);
      window.removeEventListener("visibilitychange", reapply);
    };
  }, [authed]);

  const submit = async () => {
    setErr(null); setOk(null); setLoading(true);
    try {
      if (mode === "register") {
        await api.post("/support/register", {
          email: email.trim().toLowerCase(),
          username: username.trim(), password,
        });
        setOk("✅ Compte créé. En attente d'autorisation par un administrateur. Vous pourrez vous connecter dès validation.");
        setMode("login"); setPassword("");
      } else {
        const r = await api.post<any>("/support/login", {
          email: email.trim().toLowerCase(), password,
        });
        window.localStorage.setItem(TOK, r.token);
        window.localStorage.setItem(TOK + "_user", JSON.stringify(r.user));
        setAuthToken(r.token);
        setMe(r.user);
        setAuthed(true);
      }
    } catch (e: any) {
      setErr(e?.detail || "Erreur.");
    } finally { setLoading(false); }
  };

  const logout = () => {
    window.localStorage.removeItem(TOK);
    window.localStorage.removeItem(TOK + "_user");
    setAuthToken(null as any);
    setAuthed(false); setMe(null);
  };

  if (authed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerT}>💬 Chat Support — {me?.username || me?.email}</Text>
            <Text style={styles.headerS}>Espace dédié · Accès réservé aux agents autorisés</Text>
          </View>
          <TouchableOpacity onPress={logout} style={styles.logoutBtn} testID="support-logout">
            <Ionicons name="log-out" size={18} color="#fff" />
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 12 }}>Déconnexion</Text>
          </TouchableOpacity>
        </View>
        <View style={{ flex: 1, padding: 12 }}>
          <AdminSupportTab />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.center}>
        <View style={styles.card}>
          <View style={{ alignItems: "center", marginBottom: 14 }}>
            <View style={styles.logo}><Ionicons name="chatbubbles" size={28} color="#fff" /></View>
            <Text style={styles.title}>Chat Support SPILOVEURE</Text>
            <Text style={styles.sub}>Espace réservé aux agents support.</Text>
          </View>

          <View style={styles.tabs}>
            <TouchableOpacity style={[styles.tab, mode === "login" && styles.tabActive]} onPress={() => { setMode("login"); setErr(null); setOk(null); }} testID="support-tab-login">
              <Text style={[styles.tabT, mode === "login" && { color: "#fff" }]}>Se connecter</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.tab, mode === "register" && styles.tabActive]} onPress={() => { setMode("register"); setErr(null); setOk(null); }} testID="support-tab-register">
              <Text style={[styles.tabT, mode === "register" && { color: "#fff" }]}>Créer un compte</Text>
            </TouchableOpacity>
          </View>

          {mode === "register" && (
            <View style={{ padding: 10, backgroundColor: theme.colors.warningBg, borderRadius: 10, marginBottom: 10 }}>
              <Text style={{ color: "#92400E", fontSize: 12 }}>
                ⚠️ Créer un compte ne donne pas automatiquement accès. Un administrateur doit d'abord autoriser votre compte avant que vous puissiez vous connecter et répondre aux utilisateurs.
              </Text>
            </View>
          )}

          <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="E-mail" placeholderTextColor={theme.colors.textSecondary} autoCapitalize="none" keyboardType="email-address" testID="support-email" />
          {mode === "register" && (
            <TextInput style={styles.input} value={username} onChangeText={setUsername} placeholder="Nom d'affichage (ex: Jean)" placeholderTextColor={theme.colors.textSecondary} testID="support-username" />
          )}
          <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="Mot de passe (8 caractères min.)" placeholderTextColor={theme.colors.textSecondary} secureTextEntry testID="support-password" />

          {err ? <Text style={{ color: theme.colors.danger, fontSize: 12, marginTop: 6 }}>❌ {err}</Text> : null}
          {ok ? <Text style={{ color: theme.colors.success, fontSize: 12, marginTop: 6 }}>{ok}</Text> : null}

          <TouchableOpacity style={[styles.primary, loading && { opacity: 0.6 }]} onPress={submit} disabled={loading} testID="support-submit">
            {loading ? <ActivityIndicator color="#fff" /> :
              <Text style={{ color: "#fff", fontWeight: "800", letterSpacing: 0.3 }}>
                {mode === "register" ? "Créer le compte" : "Se connecter"}
              </Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  card: { width: "100%", maxWidth: 420, backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, padding: 20, borderWidth: 1, borderColor: theme.colors.border, ...theme.shadow.card },
  logo: { width: 56, height: 56, borderRadius: 28, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  title: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 18, letterSpacing: -0.3 },
  sub: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 4 },
  tabs: { flexDirection: "row", gap: 6, marginBottom: 14 },
  tab: { flex: 1, padding: 10, borderRadius: 10, backgroundColor: theme.colors.surfaceMuted, alignItems: "center", borderWidth: 1, borderColor: theme.colors.border },
  tabActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tabT: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },
  input: { padding: 12, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceMuted, color: theme.colors.textPrimary, fontSize: 13, marginBottom: 8 },
  primary: { marginTop: 6, padding: 14, borderRadius: 12, backgroundColor: theme.colors.primary, alignItems: "center", ...theme.shadow.button },
  header: { flexDirection: "row", alignItems: "center", gap: 8, padding: 14, backgroundColor: theme.colors.primaryDark },
  headerT: { color: "#fff", fontWeight: "800", fontSize: 15 },
  headerS: { color: "rgba(255,255,255,0.8)", fontSize: 11 },
  logoutBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(255,255,255,0.18)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
});
