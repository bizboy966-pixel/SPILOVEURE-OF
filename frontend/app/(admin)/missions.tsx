/**
 * Admin — Manage paid missions.
 *
 * Tabs:
 *   1) Missions   — CRUD, with MediaUploader for the video URL field.
 *   2) Retraits   — pending mission-withdrawal requests (validate / reject).
 *   3) Statistiques — totals + per-type breakdown.
 */
import React, { useEffect, useState, useCallback } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { MediaUploader } from "@/src/components/MediaUploader";

const TYPES = ["youtube", "tiktok", "instagram", "facebook", "questionnaire"];
const TYPE_LABEL: Record<string, string> = {
  youtube: "📺 YouTube",
  tiktok: "🎵 TikTok",
  instagram: "📸 Instagram",
  facebook: "📘 Facebook",
  questionnaire: "📝 Questionnaire",
};

type Tab = "missions" | "schedule" | "withdrawals" | "stats";

const DAY_LABELS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

export default function AdminMissions() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("missions");
  const [items, setItems] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [stats, setStats] = useState<any>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [wdFilter, setWdFilter] = useState<"" | "pending" | "validated" | "rejected">("pending");
  const [schedule, setSchedule] = useState<any | null>(null);
  const [savingSched, setSavingSched] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, s, w, sched] = await Promise.all([
        api.get<any[]>(`/admin/missions${q ? `?q=${encodeURIComponent(q)}` : ""}`),
        api.get<any>("/admin/missions/stats"),
        api.get<any>(`/admin/mission-withdrawals${wdFilter ? `?status=${wdFilter}` : ""}`),
        api.get<any>("/admin/missions-schedule"),
      ]);
      setItems(list || []);
      setStats(s);
      setWithdrawals(w.items || []);
      setSchedule(sched || null);
    } catch {}
  }, [q, wdFilter]);

  useEffect(() => { load(); }, [load]);

  const toggleDay = (d: number) => {
    if (!schedule) return;
    const cur: number[] = schedule.schedule?.allowed_days || [];
    const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort();
    setSchedule({ ...schedule, schedule: { ...schedule.schedule, allowed_days: next } });
  };

  const saveSchedule = async () => {
    if (!schedule) return;
    setSavingSched(true);
    try {
      const r = await api.put<any>("/admin/missions-schedule", schedule.schedule);
      setSchedule(r);
      if (typeof window !== "undefined") window.alert(`✅ Programmation sauvegardée\n${r.label}\nÉtat actuel : ${r.window_open_now ? "🟢 Ouvert" : "🔴 Fermé"}`);
    } catch (e: any) {
      const msg = e?.detail ? (typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)) : "Échec";
      if (typeof window !== "undefined") window.alert(`❌ ${msg}`);
    } finally {
      setSavingSched(false);
    }
  };

  const save = async () => {
    // Frontend validation
    const title = String(editing.title || "").trim();
    if (!title) {
      if (typeof window !== "undefined") window.alert("❌ Le titre est obligatoire");
      return;
    }
    const duration = parseInt(String(editing.duration_seconds), 10);
    if (!Number.isFinite(duration) || duration < 0 || duration > 3600) {
      if (typeof window !== "undefined") window.alert("❌ Durée invalide (0 à 3600 secondes)");
      return;
    }
    const reward = parseFloat(String(editing.reward));
    if (!Number.isFinite(reward) || reward < 0) {
      if (typeof window !== "undefined") window.alert("❌ Récompense invalide");
      return;
    }
    try {
      const body = {
        title,
        description: String(editing.description || ""),
        type: editing.type || "youtube",
        url: String(editing.url || ""),
        duration_seconds: duration,
        reward,
        question: String(editing.question || ""),
        correct_answer: String(editing.correct_answer || ""),
        expires_at: editing.expires_at ? String(editing.expires_at) : null,
        active: editing.active !== false,
      };
      if (editing.id) await api.put(`/admin/missions/${editing.id}`, body);
      else await api.post(`/admin/missions`, body);
      setEditing(null);
      await load();
      if (typeof window !== "undefined") window.alert("✅ Mission enregistrée");
    } catch (e: any) {
      const msg = e?.detail
        ? (typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail))
        : "Échec de l'enregistrement";
      if (typeof window !== "undefined") window.alert(`❌ ${msg}`);
      else Alert.alert("Erreur", msg);
    }
  };

  const del = async (m: any) => {
    if (typeof window !== "undefined" && !window.confirm(`Supprimer "${m.title}" ?`)) return;
    try { await api.delete(`/admin/missions/${m.id}`); await load(); } catch (e: any) {
      const msg = e?.detail ? (typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)) : "Échec";
      if (typeof window !== "undefined") window.alert(`❌ ${msg}`);
      else Alert.alert("Erreur", msg);
    }
  };

  const decide = async (w: any, action: "validate" | "reject") => {
    const label = action === "validate" ? "Valider" : "Rejeter";
    if (typeof window !== "undefined" && !window.confirm(`${label} le retrait de ${Math.round(w.amount)} FCFA (${TYPE_LABEL[w.wallet] || w.wallet}) pour ${w.username || w.user_id} ?`)) return;
    try {
      await api.post(`/admin/mission-withdrawals/${w.id}/action`, { action });
      await load();
      if (typeof window !== "undefined") window.alert(`✅ Retrait ${action === "validate" ? "validé" : "rejeté"}`);
    } catch (e: any) {
      const msg = e?.detail ? (typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)) : "Échec";
      if (typeof window !== "undefined") window.alert(`❌ ${msg}`);
      else Alert.alert("Erreur", msg);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="missions-admin-back">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.hTitle}>🎥 Gestion des Missions</Text>
        {tab === "missions" ? (
          <TouchableOpacity
            onPress={() => setEditing({ type: "youtube", duration_seconds: 60, reward: 50, active: true })}
            testID="add-mission-btn"
          >
            <Ionicons name="add-circle" size={26} color="#fff" />
          </TouchableOpacity>
        ) : <View style={{ width: 26 }} />}
      </LinearGradient>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {(["missions", "schedule", "withdrawals", "stats"] as Tab[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tab, tab === t && styles.tabOn]}
            onPress={() => setTab(t)}
            testID={`admin-missions-tab-${t}`}
          >
            <Text style={[styles.tabTxt, tab === t && { color: "#fff" }]}>
              {t === "missions" ? "🎬 Missions" :
               t === "schedule" ? "⏰ Programmation" :
               t === "withdrawals" ? `💸 Retraits${withdrawals.length ? ` (${withdrawals.length})` : ""}` :
               "📊 Stats"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 80 }}>
        {tab === "missions" && (
          <>
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
              {q.length > 0 && (
                <TouchableOpacity onPress={() => setQ("")}>
                  <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                </TouchableOpacity>
              )}
            </View>

            {items.length === 0 ? <Text style={styles.empty}>Aucune mission.</Text> : items.map((m) => (
              <View key={m.id} style={styles.row} testID={`mission-row-${m.id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title}>{m.title}</Text>
                  <Text style={styles.meta}>
                    {(TYPE_LABEL[m.type] || m.type.toUpperCase())} • {m.duration_seconds}s • +{Math.round(m.reward)} FCFA{m.active ? "" : " • 🚫 désactivée"}
                  </Text>
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
                      <Text style={[styles.tchipTxt, editing.type === t && { color: "#fff" }]}>{TYPE_LABEL[t] || t}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.lbl}>Vidéo / Lien</Text>
                <Text style={styles.help}>
                  Vous pouvez importer une vidéo depuis votre appareil OU coller un lien externe (YouTube, TikTok, Instagram, Facebook).
                </Text>
                <MediaUploader
                  kind="video"
                  url={editing.url || ""}
                  onChange={(v) => setEditing({ ...editing, url: v })}
                  testID="m-upload"
                />
                <TextInput
                  style={styles.input}
                  value={editing.url || ""}
                  onChangeText={(v) => setEditing({ ...editing, url: v })}
                  placeholder="https://… ou /api/uploads/…"
                  placeholderTextColor={theme.colors.textSecondary}
                  testID="m-url"
                />

                <Text style={styles.lbl}>Durée minimum (secondes)</Text>
                <TextInput style={styles.input} keyboardType="numeric" value={String(editing.duration_seconds ?? "")} onChangeText={(v) => setEditing({ ...editing, duration_seconds: v })} testID="m-duration" />
                <Text style={styles.lbl}>Récompense (FCFA)</Text>
                <TextInput style={styles.input} keyboardType="numeric" value={String(editing.reward ?? "")} onChangeText={(v) => setEditing({ ...editing, reward: v })} testID="m-reward" />
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
          </>
        )}

        {tab === "schedule" && (
          <View>
            <View style={styles.schedBanner}>
              <Ionicons name="time" size={20} color="#fff" />
              <View style={{ flex: 1, marginLeft: 8 }}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 13 }}>
                  État actuel : {schedule?.window_open_now ? "🟢 Missions OUVERTES" : "🔴 Missions FERMÉES"}
                </Text>
                <Text style={{ color: "#fff", fontSize: 11, opacity: 0.9, marginTop: 2 }}>
                  {schedule?.label || "Chargement…"}
                </Text>
                {schedule?.period_key_now ? (
                  <Text style={{ color: "#fff", fontSize: 10, opacity: 0.85, marginTop: 2 }}>
                    Période active : {schedule.period_key_now} • Reset auto à minuit ({schedule?.schedule?.timezone})
                  </Text>
                ) : null}
              </View>
            </View>

            <Text style={styles.schedSection}>📅 Jours de disponibilité</Text>
            <Text style={styles.schedHelp}>Cochez les jours pendant lesquels les missions sont accessibles.</Text>
            <View style={styles.daysGrid}>
              {DAY_LABELS.map((lbl, idx) => {
                const on = (schedule?.schedule?.allowed_days || []).includes(idx);
                return (
                  <TouchableOpacity
                    key={idx}
                    onPress={() => toggleDay(idx)}
                    style={[styles.dayChip, on && styles.dayChipOn]}
                    testID={`sched-day-${idx}`}
                  >
                    <Ionicons name={on ? "checkmark-circle" : "ellipse-outline"} size={14} color={on ? "#fff" : theme.colors.primary} />
                    <Text style={[styles.dayChipTxt, on && { color: "#fff" }]}>{lbl}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.schedSection}>🕒 Heure de début</Text>
            <TextInput
              style={styles.input}
              value={schedule?.schedule?.open_time || ""}
              onChangeText={(v) => setSchedule({ ...schedule, schedule: { ...(schedule?.schedule || {}), open_time: v } })}
              placeholder="08:00"
              placeholderTextColor={theme.colors.textSecondary}
              testID="sched-open"
            />

            <Text style={styles.schedSection}>🕓 Heure de fin</Text>
            <TextInput
              style={styles.input}
              value={schedule?.schedule?.close_time || ""}
              onChangeText={(v) => setSchedule({ ...schedule, schedule: { ...(schedule?.schedule || {}), close_time: v } })}
              placeholder="16:00"
              placeholderTextColor={theme.colors.textSecondary}
              testID="sched-close"
            />

            <Text style={styles.schedSection}>🌍 Fuseau horaire</Text>
            <TextInput
              style={styles.input}
              value={schedule?.schedule?.timezone || ""}
              onChangeText={(v) => setSchedule({ ...schedule, schedule: { ...(schedule?.schedule || {}), timezone: v } })}
              placeholder="Africa/Lome"
              placeholderTextColor={theme.colors.textSecondary}
              testID="sched-tz"
            />

            <TouchableOpacity
              onPress={() => setSchedule({ ...schedule, schedule: { ...(schedule?.schedule || {}), enabled: !(schedule?.schedule?.enabled) } })}
              style={[styles.toggleRow, schedule?.schedule?.enabled ? styles.togOn : styles.togOff]}
              testID="sched-enabled"
            >
              <Ionicons name={schedule?.schedule?.enabled ? "checkmark-circle" : "close-circle"} size={16} color="#fff" />
              <Text style={styles.togTxt}>
                {schedule?.schedule?.enabled ? "Réactivation automatique : Activée" : "Système désactivé"}
              </Text>
            </TouchableOpacity>

            <View style={styles.schedInfo}>
              <Ionicons name="information-circle" size={14} color={theme.colors.primary} />
              <Text style={styles.schedInfoTxt}>
                Une fois sauvegardé, les missions s'ouvriront et se fermeront automatiquement selon ces paramètres. Chaque utilisateur peut effectuer chaque mission UNE fois par période (par jour), puis la mission redevient disponible automatiquement à la prochaine période programmée.
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.btn, { backgroundColor: theme.colors.success, marginTop: 14 }]}
              onPress={saveSchedule}
              disabled={savingSched}
              testID="sched-save"
            >
              <Text style={styles.btnTxt}>{savingSched ? "Enregistrement…" : "💾 Enregistrer la programmation"}</Text>
            </TouchableOpacity>
          </View>
        )}

        {tab === "withdrawals" && (
          <>
            <View style={styles.filterRow}>
              {(["pending", "validated", "rejected", ""] as const).map((f) => (
                <TouchableOpacity
                  key={f || "all"}
                  style={[styles.fchip, wdFilter === f && styles.fchipOn]}
                  onPress={() => setWdFilter(f)}
                  testID={`mwd-filter-${f || "all"}`}
                >
                  <Text style={[styles.fchipTxt, wdFilter === f && { color: "#fff" }]}>
                    {f === "" ? "Toutes" : f === "pending" ? "En attente" : f === "validated" ? "Validées" : "Rejetées"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {withdrawals.length === 0 ? (
              <Text style={styles.empty}>Aucune demande de retrait.</Text>
            ) : withdrawals.map((w: any) => (
              <View key={w.id} style={styles.wdRow} testID={`mwd-row-${w.id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title}>{w.username || w.user_id}</Text>
                  <Text style={styles.meta}>
                    {TYPE_LABEL[w.wallet] || w.wallet} • {new Date(w.created_at).toLocaleString("fr-FR")}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.amt}>{Math.round(w.amount)} FCFA</Text>
                  <View style={[styles.badge, w.status === "pending" ? styles.bgPending : w.status === "validated" ? styles.bgValid : styles.bgRejected]}>
                    <Text style={styles.badgeTxt}>{w.status === "pending" ? "En attente" : w.status === "validated" ? "Validé" : "Rejeté"}</Text>
                  </View>
                </View>
                {w.status === "pending" && (
                  <View style={{ flexDirection: "column", gap: 6, marginLeft: 6 }}>
                    <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.success }]} onPress={() => decide(w, "validate")} testID={`mwd-validate-${w.id}`}>
                      <Ionicons name="checkmark" size={14} color="#fff" />
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.danger }]} onPress={() => decide(w, "reject")} testID={`mwd-reject-${w.id}`}>
                      <Ionicons name="close" size={14} color="#fff" />
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ))}
          </>
        )}

        {tab === "stats" && stats && (
          <>
            <View style={styles.statsRow}>
              <View style={styles.stat}><Text style={styles.statN}>{stats.total_missions}</Text><Text style={styles.statL}>Missions</Text></View>
              <View style={styles.stat}><Text style={styles.statN}>{stats.active_missions}</Text><Text style={styles.statL}>Actives</Text></View>
              <View style={styles.stat}><Text style={styles.statN}>{stats.completions}</Text><Text style={styles.statL}>Validées</Text></View>
            </View>
            <View style={styles.statsRow}>
              <View style={styles.stat}><Text style={styles.statN}>{stats.active_users}</Text><Text style={styles.statL}>Utilisateurs actifs</Text></View>
              <View style={[styles.stat, { flex: 2 }]}>
                <Text style={[styles.statN, { color: theme.colors.success }]}>{Math.round(stats.total_rewards)} FCFA</Text>
                <Text style={styles.statL}>Total versé</Text>
              </View>
            </View>

            <Text style={[styles.formTitle, { marginTop: 14 }]}>📊 Récompenses par type</Text>
            {TYPES.map((t) => {
              const row = (stats.by_type || {})[t] || { rewards: 0, count: 0 };
              return (
                <View key={t} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.title}>{TYPE_LABEL[t]}</Text>
                    <Text style={styles.meta}>{row.count} validation(s)</Text>
                  </View>
                  <Text style={[styles.amt, { color: theme.colors.success }]}>{Math.round(row.rewards)} FCFA</Text>
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12 },
  hTitle: { color: "#fff", fontWeight: "800", fontSize: 16 },
  tabRow: { flexDirection: "row", gap: 6, padding: 10, paddingBottom: 0 },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 18, backgroundColor: theme.colors.surfaceSecondary, alignItems: "center", borderWidth: 1, borderColor: theme.colors.border },
  tabOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tabTxt: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },
  statsRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  stat: { flex: 1, padding: 10, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center" },
  statN: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 16 },
  statL: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 2 },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 12 },
  searchI: { flex: 1, color: theme.colors.textPrimary, fontSize: 13 },
  empty: { color: theme.colors.textSecondary, textAlign: "center", marginTop: 30 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 8 },
  title: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13 },
  meta: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  amt: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13 },
  editBtn: { padding: 8, borderRadius: 8, backgroundColor: theme.colors.primary },
  delBtn: { padding: 8, borderRadius: 8, backgroundColor: theme.colors.danger },
  formCard: { marginTop: 16, padding: 14, borderRadius: 14, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  formTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 14, marginBottom: 8 },
  lbl: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "600", marginTop: 8, marginBottom: 3 },
  help: { color: theme.colors.textSecondary, fontSize: 11, marginBottom: 6, fontStyle: "italic" },
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
  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 10 },
  fchip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  fchipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  fchipTxt: { color: theme.colors.textPrimary, fontSize: 11, fontWeight: "700" },
  wdRow: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 8 },
  badge: { marginTop: 4, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  badgeTxt: { color: "#fff", fontSize: 10, fontWeight: "700" },
  bgPending: { backgroundColor: theme.colors.warning },
  bgValid: { backgroundColor: theme.colors.success },
  bgRejected: { backgroundColor: theme.colors.danger },
  actBtn: { padding: 8, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  schedBanner: { flexDirection: "row", alignItems: "center", padding: 12, borderRadius: 12, backgroundColor: theme.colors.primary, marginBottom: 14 },
  schedSection: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "800", marginTop: 14, marginBottom: 4 },
  schedHelp: { color: theme.colors.textSecondary, fontSize: 11, marginBottom: 8 },
  daysGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  dayChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  dayChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  dayChipTxt: { color: theme.colors.textPrimary, fontSize: 11, fontWeight: "700" },
  schedInfo: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 14, padding: 10, borderRadius: 8, backgroundColor: "#EFF6FF" },
  schedInfoTxt: { color: theme.colors.primary, fontSize: 11, flex: 1, lineHeight: 16 },
});
