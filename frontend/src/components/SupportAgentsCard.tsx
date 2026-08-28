/**
 * SupportAgentsCard — Admin management for support agents (Phase 3a).
 *
 * Lists all `role:support` users with their status (pending / authorized /
 * revoked), a chat global on/off toggle, and Copy-URL for the dedicated
 * /support-desk link. Actions per agent: authorize, revoke, delete.
 */
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type Agent = { id: string; email?: string; username?: string; status: string; created_at: string | null; last_seen: string | null };

function StatusPill({ s }: { s: string }) {
  const map: Record<string, { c: string; bg: string; label: string }> = {
    pending: { c: "#92400E", bg: "#FEF3C7", label: "🟡 En attente" },
    authorized: { c: "#065F46", bg: "#D1FAE5", label: "🟢 Autorisé" },
    revoked: { c: "#7F1D1D", bg: "#FEE2E2", label: "🔴 Révoqué" },
  };
  const p = map[s] || { c: theme.colors.textSecondary, bg: theme.colors.surfaceMuted, label: s };
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: p.bg }}>
      <Text style={{ color: p.c, fontSize: 10, fontWeight: "800", letterSpacing: 0.3 }}>{p.label}</Text>
    </View>
  );
}

export default function SupportAgentsCard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, cs] = await Promise.all([
        api.get<{ agents: Agent[] }>("/admin/support/agents"),
        api.get<{ enabled: boolean }>("/admin/support/chat-status"),
      ]);
      setAgents(a.agents || []); setChatEnabled(!!cs.enabled);
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);

  const setStatus = async (id: string, action: "authorize" | "revoke" | "delete") => {
    setBusyId(id);
    try {
      if (action === "delete") {
        if (typeof window !== "undefined" && !window.confirm("Supprimer définitivement cet agent ?")) { setBusyId(null); return; }
        await api.delete("/admin/support/agents/" + id);
      } else {
        await api.post(`/admin/support/agents/${id}/${action}`, {});
      }
      await load();
    } catch (e: any) { if (typeof window !== "undefined") window.alert("Erreur : " + (e?.detail || "action impossible")); }
    finally { setBusyId(null); }
  };

  const toggleChat = async () => {
    try {
      const r = await api.post<{ enabled: boolean }>("/admin/support/chat-status", { enabled: !chatEnabled });
      setChatEnabled(!!r.enabled);
    } catch { /* silent */ }
  };

  const supportDeskUrl = typeof window !== "undefined" ? `${window.location.origin}/support-desk` : "/support-desk";
  const copyUrl = () => {
    if (typeof navigator !== "undefined" && (navigator as any).clipboard) {
      (navigator as any).clipboard.writeText(supportDeskUrl);
      if (typeof window !== "undefined") window.alert("✅ Lien copié");
    }
  };

  return (
    <Card style={{ marginBottom: 12 }} testID="support-agents-card">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Ionicons name="people" size={20} color={theme.colors.primary} />
        <Text style={{ fontSize: 15, fontWeight: "800", color: theme.colors.textPrimary, flex: 1 }}>
          Gestion du Chat Direct
        </Text>
        <TouchableOpacity onPress={toggleChat} style={[styles.toggle, chatEnabled ? styles.toggleOn : styles.toggleOff]} testID="chat-global-toggle">
          <Ionicons name={chatEnabled ? "checkmark-circle" : "close-circle"} size={16} color={chatEnabled ? "#fff" : theme.colors.textSecondary} />
          <Text style={{ color: chatEnabled ? "#fff" : theme.colors.textSecondary, fontWeight: "700", fontSize: 11 }}>
            Chat {chatEnabled ? "ACTIVÉ" : "DÉSACTIVÉ"}
          </Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity onPress={copyUrl} style={styles.urlBox} testID="support-desk-url">
        <Ionicons name="link" size={14} color={theme.colors.primary} />
        <Text style={{ flex: 1, color: theme.colors.primary, fontFamily: "monospace", fontSize: 11 }} numberOfLines={1}>
          {supportDeskUrl}
        </Text>
        <View style={styles.copyPill}><Ionicons name="copy-outline" size={11} color={theme.colors.primary} /><Text style={{ color: theme.colors.primary, fontSize: 10, fontWeight: "800" }}>COPIER</Text></View>
      </TouchableOpacity>

      <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 8, marginBottom: 6 }}>
        Envoyez ce lien aux personnes de confiance. Elles pourront créer un compte, mais devront être <Text style={{ fontWeight: "800" }}>autorisées ici</Text> avant d'accéder aux conversations.
      </Text>

      {loading ? (
        <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 10 }} />
      ) : agents.length === 0 ? (
        <Text style={{ color: theme.colors.textSecondary, fontSize: 12, textAlign: "center", padding: 10 }}>
          Aucun agent inscrit pour l'instant.
        </Text>
      ) : agents.map((a) => (
        <View key={a.id} style={styles.row} testID={`support-agent-${a.id}`}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13 }}>{a.username || a.email || a.id.slice(0, 8)}</Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>{a.email}</Text>
          </View>
          <StatusPill s={a.status} />
          <View style={{ flexDirection: "row", gap: 4 }}>
            {a.status !== "authorized" && (
              <TouchableOpacity disabled={busyId === a.id} style={[styles.btn, styles.btnOk]} onPress={() => setStatus(a.id, "authorize")} testID={`agent-authorize-${a.id}`}>
                <Ionicons name="checkmark" size={13} color="#fff" /><Text style={{ color: "#fff", fontSize: 10, fontWeight: "800" }}>Autoriser</Text>
              </TouchableOpacity>
            )}
            {a.status === "authorized" && (
              <TouchableOpacity disabled={busyId === a.id} style={[styles.btn, styles.btnWarn]} onPress={() => setStatus(a.id, "revoke")} testID={`agent-revoke-${a.id}`}>
                <Ionicons name="ban" size={13} color="#fff" /><Text style={{ color: "#fff", fontSize: 10, fontWeight: "800" }}>Révoquer</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity disabled={busyId === a.id} style={[styles.btn, styles.btnDel]} onPress={() => setStatus(a.id, "delete")} testID={`agent-delete-${a.id}`}>
              <Ionicons name="trash" size={13} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  toggle: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  toggleOn: { backgroundColor: theme.colors.success },
  toggleOff: { backgroundColor: theme.colors.surfaceMuted, borderWidth: 1, borderColor: theme.colors.border },
  urlBox: { flexDirection: "row", alignItems: "center", gap: 6, padding: 8, borderRadius: 8, backgroundColor: theme.colors.primary + "10", borderWidth: 1, borderColor: theme.colors.primary + "30", marginTop: 8 },
  copyPill: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: theme.colors.primary + "18", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, padding: 8, borderTopWidth: 1, borderTopColor: theme.colors.border, marginTop: 4, flexWrap: "wrap" },
  btn: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6 },
  btnOk: { backgroundColor: theme.colors.success },
  btnWarn: { backgroundColor: "#F59E0B" },
  btnDel: { backgroundColor: theme.colors.danger, paddingHorizontal: 6 },
});
