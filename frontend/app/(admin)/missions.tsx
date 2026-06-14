/**
 * Admin — Manage paid missions. CRUD + search.
 */
import React, { useEffect, useState, useCallback } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

const TYPES = ["youtube", "tiktok", "instagram", "facebook", "questionnaire"];

export default function AdminMissions() {
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [stats, setStats] = useState<any>(null);
  const [editing, setEditing] = useState<any | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, s] = await Promise.all([
        api.get<any[]>(`/admin/missions${q ? `?q=${encodeURIComponent(q)}` : ""}`),
        api.get<any>("/admin/missions/stats"),
      ]);
      setItems(list || []);
      setStats(s);
    } catch {}
  }, [q]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    try {
      const body = {
        title: editing.title || "",
        description: editing.description || "",
        type: editing.type || "youtube",
        url: editing.url || "",
        duration_seconds: Number(editing.duration_seconds) || 60,
        reward: Number(editing.reward) || 50,
        question: editing.question || "",
        correct_answer: editing.correct_answer || "",
        expires_at: editing.expires_at || null,
        active: editing.active !== false,
      };
      if (editing.id) await api.put(`/admin/missions/${editing.id}`, body);
      else await api.post(`/admin/missions`, body);
      setEditing(null);
      await load();
      if (typeof window !== "undefined") window.alert("✅ Mission enregistrée");
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Échec");
    }
  };

  const del = async (m: any) => {
    if (typeof window !== "undefined" && !window.confirm(`Supprimer "${m.title}" ?`)) return;
    try { await api.delete(`/admin/missions/${m.id}`); await load(); } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Échec");
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="missions-admin-back">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.hTitle}>🎥 Gestion des Missions</Text>
        <TouchableOpacity
          onPress={() => setEditing({ type: "youtube", duration_seconds: 60, reward: 50, active: true })}
          testID="add-mission-btn"
        >
          <Ionicons name="add-circle" size={26} color="#fff" />
        </TouchableOpacity>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 80 }}>
        {stats ? (
          <View style={styles.statsRow}>
            <View style={styles.stat}><Text style={styles.statN}>{stats.total_missions}</Text><Text style={styles.statL}>Missions</Text></View>
            <View style={styles.stat}><Text style={styles.statN}>{stats.completions}</Text><Text style={styles.statL}>Validées</Text></View>
            <View style={styles.stat}><Text style={styles.statN}>{stats.active_users}</Text><Text style={styles.statL}>Utilisateurs</Text></View>
            <View style={styles.stat}><Text style={[styles.statN, { color: theme.colors.success }]}>{Math.round(stats.total_rewards)}</Text><Text style={styles.statL}>FCFA versés</Text></View>
          </View>
        ) : null}

        <View style={styles.searchBox}>
          <Ionicons name="search" size={14} color={theme.colors.textSecondary} />
          <TextInput
            placeholder="Rechercher (titre, ID, type)…"
            placeholderTextColor={theme.colors.textSecondary}
            style={styles.searchI}
            value={q}
            onChangeText={setQ}
            testID="missions-search"
          />
        </View>

        {items.length === 0 ? <Text style={styles.empty}>Aucune mission.</Text> : items.map((m) => (
          <View key={m.id} style={styles.row} testID={`mission-row-${m.id}`}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{m.title}</Text>
              <Text style={styles.meta}>{m.type.toUpperCase()} • {m.duration_seconds}s • +{Math.round(m.reward)} FCFA {m.active ? "" : "• 🚫 désactivée"}</Text>
            </View>
            <TouchableOpacity style={styles.editBtn} onPress={() => setEditing(m)} testID={`edit-${m.id}`}>
              <Ionicons name="pencil" size={14} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.delBtn} onPress={() => del(m)} testID={`del-${m.id}`}>
              <Ionicons name="trash" size={14} color="#fff" />
            </TouchableOpacity>
          </View>
        ))}

        {editing ? (
          <View style={styles.formCard} testID="mission-form">
            <Text style={styles.formTitle}>{editing.id ? "Modifier" : "Nouvelle mission"}</Text>
            <Text style={styles.lbl}>Titre</Text>
            <TextInput style={styles.input} value={editing.title || ""} onChangeText={(v) => setEditing({ ...editing, title: v })} testID="m-title" />
            <Text style={styles.lbl}>Description</Text>
            <TextInput style={[styles.input, { minHeight: 60 }]} multiline value={editing.description || ""} onChangeText={(v) => setEditing({ ...editing, description: v })} testID="m-desc" />
            <Text style={styles.lbl}>Type</Text>
            <View style={styles.typeRow}>
              {TYPES.map((t) => (
                <TouchableOpacity key={t} style={[styles.tchip, editing.type === t && styles.tchipOn]} onPress={() => setEditing({ ...editing, type: t })} testID={`m-type-${t}`}>
                  <Text style={[styles.tchipTxt, editing.type === t && { color: "#fff" }]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.lbl}>URL (YouTube / TikTok / Instagram / Facebook ou /api/uploads/...)</Text>
            <TextInput style={styles.input} value={editing.url || ""} onChangeText={(v) => setEditing({ ...editing, url: v })} testID="m-url" />
            <Text style={styles.lbl}>Durée minimum (secondes)</Text>
            <TextInput style={styles.input} keyboardType="numeric" value={String(editing.duration_seconds || 0)} onChangeText={(v) => setEditing({ ...editing, duration_seconds: v })} testID="m-duration" />
            <Text style={styles.lbl}>Récompense (FCFA)</Text>
            <TextInput style={styles.input} keyboardType="numeric" value={String(editing.reward || 0)} onChangeText={(v) => setEditing({ ...editing, reward: v })} testID="m-reward" />
            <Text style={styles.lbl}>Question de vérification (optionnel)</Text>
            <TextInput style={styles.input} value={editing.question || ""} onChangeText={(v) => setEditing({ ...editing, question: v })} testID="m-q" />
            <Text style={styles.lbl}>Réponse correcte (insensible à la casse)</Text>
            <TextInput style={styles.input} value={editing.correct_answer || ""} onChangeText={(v) => setEditing({ ...editing, correct_answer: v })} testID="m-ans" />
            <Text style={styles.lbl}>Date d'expiration ISO (optionnel)</Text>
            <TextInput style={styles.input} value={editing.expires_at || ""} onChangeText={(v) => setEditing({ ...editing, expires_at: v })} placeholder="2026-12-31T23:59:59Z" placeholderTextColor={theme.colors.textSecondary} testID="m-exp" />

            <TouchableOpacity
              style={[styles.toggleRow, editing.active !== false ? styles.togOn : styles.togOff]}
              onPress={() => setEditing({ ...editing, active: !(editing.active !== false) })}
              testID="m-active"
            >
              <Ionicons name={editing.active !== false ? "checkmark-circle" : "close-circle"} size={16} color="#fff" />
              <Text style={styles.togTxt}>{editing.active !== false ? "Active" : "Désactivée"}</Text>
            </TouchableOpacity>

            <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
              <TouchableOpacity style={[styles.btn, { backgroundColor: theme.colors.success }]} onPress={save} testID="m-save">
                <Text style={styles.btnTxt}>💾 Enregistrer</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, { backgroundColor: theme.colors.surfaceSecondary }]} onPress={() => setEditing(null)} testID="m-cancel">
                <Text style={[styles.btnTxt, { color: theme.colors.textPrimary }]}>Annuler</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12 },
  hTitle: { color: "#fff", fontWeight: "800", fontSize: 16 },
  statsRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  stat: { flex: 1, padding: 10, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center" },
  statN: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 16 },
  statL: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 2 },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 12 },
  searchI: { flex: 1, color: theme.colors.textPrimary, fontSize: 13 },
  empty: { color: theme.colors.textSecondary, textAlign: "center", marginTop: 30 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 8 },
  title: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13 },
  meta: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  editBtn: { padding: 8, borderRadius: 8, backgroundColor: theme.colors.primary },
  delBtn: { padding: 8, borderRadius: 8, backgroundColor: theme.colors.danger },
  formCard: { marginTop: 16, padding: 14, borderRadius: 14, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  formTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 14, marginBottom: 8 },
  lbl: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "600", marginTop: 8, marginBottom: 3 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, color: theme.colors.textPrimary, backgroundColor: theme.colors.background },
  typeRow: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
  tchip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  tchipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tchipTxt: { color: theme.colors.textPrimary, fontSize: 11, fontWeight: "700" },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 18, alignSelf: "flex-start", marginTop: 12 },
  togOn: { backgroundColor: theme.colors.success },
  togOff: { backgroundColor: theme.colors.danger },
  togTxt: { color: "#fff", fontWeight: "700", fontSize: 12 },
  btn: { flex: 1, paddingVertical: 11, borderRadius: 18, alignItems: "center" },
  btnTxt: { color: "#fff", fontWeight: "800", fontSize: 13 },
});
