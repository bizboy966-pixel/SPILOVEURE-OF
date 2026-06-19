import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { api } from "@/src/api";
import { Card } from "@/src/components/Card";

const fmt = (v: any) => `${Math.round(Number(v) || 0).toLocaleString("fr-FR")} FCFA`;

type Tab = "draws" | "settings" | "stats";

export default function AdminLottery() {
  const [tab, setTab] = useState<Tab>("draws");
  const [settings, setSettings] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [draws, setDraws] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [participants, setParticipants] = useState<any[]>([]);
  const [winners, setWinners] = useState<Record<number, { user_id: string; prize: string }>>({});

  const load = useCallback(async () => {
    try {
      const [s, st, ds] = await Promise.all([
        api.get<any>("/admin/lottery/settings"),
        api.get<any>("/admin/lottery/stats"),
        api.get<any>("/admin/lottery/draws"),
      ]);
      setSettings(s); setStats(st); setDraws(ds || []);
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveSettings = async (patch: any) => {
    try {
      const r = await api.put<any>("/admin/lottery/settings", patch);
      setSettings(r);
      if (typeof window !== "undefined") window.alert("✅ Réglages sauvegardés");
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    }
  };

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<any>({ name: "", durationH: "168", winnersCount: "3", maxP: "100", entry: "500", startsIn: "0" });

  const submitCreate = async () => {
    if (!draft.name?.trim()) {
      if (typeof window !== "undefined") window.alert("❌ Le nom du tirage est requis.");
      return;
    }
    const startsIn = Math.max(0, parseFloat(draft.startsIn) || 0);
    const durationH = Math.max(1, parseFloat(draft.durationH) || 1);
    const winnersCount = Math.max(1, parseInt(draft.winnersCount) || 1);
    const maxP = parseInt(draft.maxP) || 0;
    const entry = Math.max(0, parseFloat(draft.entry) || 0);
    const starts = new Date(Date.now() + startsIn * 3600000);
    const ends = new Date(starts.getTime() + durationH * 3600000);
    try {
      await api.post("/admin/lottery/draws", {
        name: draft.name.trim(),
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        winners_count: winnersCount,
        max_participants: maxP > 0 ? maxP : null,
        entry_amount: entry,
        prizes: Array.from({ length: winnersCount }, (_, i) => ({ rank: i + 1, amount: 0 })),
      });
      setCreating(false);
      setDraft({ name: "", durationH: "168", winnersCount: "3", maxP: "100", entry: "500", startsIn: "0" });
      await load();
      if (typeof window !== "undefined") window.alert("✅ Tirage créé en brouillon. Définissez les récompenses puis ouvrez-le.");
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    }
  };

  const setStatus = async (d: any, status: "draft" | "open" | "closed") => {
    if (typeof window !== "undefined" && !window.confirm(`Passer le tirage en statut "${status}" ?`)) return;
    try {
      await api.put(`/admin/lottery/draws/${d.id}`, { status });
      await load();
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    }
  };

  const editPrize = async (d: any, rank: number) => {
    const cur = (d.prizes || []).find((p: any) => p.rank === rank);
    const v = window.prompt(`Récompense pour le rang ${rank} (FCFA) :`, String(cur?.amount || 0));
    if (v === null) return;
    const amount = parseFloat(v);
    if (Number.isNaN(amount)) return;
    const newPrizes = (d.prizes || []).filter((p: any) => p.rank !== rank);
    newPrizes.push({ rank, amount });
    newPrizes.sort((a: any, b: any) => a.rank - b.rank);
    try {
      await api.put(`/admin/lottery/draws/${d.id}`, { prizes: newPrizes });
      await load();
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    }
  };

  const deleteDraw = async (d: any) => {
    if (typeof window !== "undefined" && !window.confirm(`Supprimer le tirage « ${d.name} » ?\n\nLes participants seront remboursés automatiquement.`)) return;
    try {
      await api.delete(`/admin/lottery/draws/${d.id}`);
      await load();
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    }
  };

  const openWinnerPicker = async (d: any) => {
    try {
      const p = await api.get<any[]>(`/admin/lottery/draws/${d.id}/participants`);
      setParticipants(p || []);
      const initial: Record<number, any> = {};
      (d.prizes || []).forEach((pr: any) => {
        initial[pr.rank] = { user_id: "", prize: String(pr.amount) };
      });
      setWinners(initial);
      setEditing(d);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    }
  };

  const announceWinners = async () => {
    if (!editing) return;
    const list = Object.entries(winners)
      .map(([rank, v]) => ({ rank: parseInt(rank, 10), user_id: v.user_id, prize: parseFloat(v.prize) || 0 }))
      .filter((w) => w.user_id);
    if (list.length === 0) {
      if (typeof window !== "undefined") window.alert("❌ Sélectionnez au moins un gagnant.");
      return;
    }
    if (typeof window !== "undefined" && !window.confirm(`Lancer le tirage et annoncer ${list.length} gagnant(s) ?\n\nLes gains seront crédités immédiatement.`)) return;
    try {
      await api.post(`/admin/lottery/draws/${editing.id}/announce`, { winners: list });
      setEditing(null);
      await load();
      if (typeof window !== "undefined") window.alert("🎉 Tirage annoncé et gagnants crédités !");
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    }
  };

  const exportCsv = async (d: any) => {
    const apiUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || process.env.REACT_APP_BACKEND_URL || "");
    if (typeof window !== "undefined") {
      window.open(`${apiUrl}/api/admin/lottery/draws/${d.id}/export.csv`, "_blank");
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 14 }} testID="admin-lottery-page">
      <Text style={styles.h1}>🎰 Lottery Jackpot</Text>

      <View style={styles.tabRow}>
        {(["draws", "settings", "stats"] as Tab[]).map((t) => (
          <TouchableOpacity key={t} style={[styles.tab, tab === t && styles.tabOn]} onPress={() => setTab(t)} testID={`admin-lottery-tab-${t}`}>
            <Text style={[styles.tabT, tab === t && { color: "#fff" }]}>
              {t === "draws" ? "🎟️ Tirages" : t === "settings" ? "⚙️ Réglages" : "📊 Statistiques"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === "draws" && (
        <View>
          <TouchableOpacity style={styles.createBtn} onPress={() => setCreating(true)} testID="lottery-create">
            <Ionicons name="add-circle" size={18} color="#fff" />
            <Text style={styles.createTxt}>Créer un tirage</Text>
          </TouchableOpacity>

          {draws.length === 0 ? (
            <Card style={{ marginTop: 12 }}><Text style={{ color: theme.colors.textSecondary }}>Aucun tirage créé.</Text></Card>
          ) : draws.map((d) => (
            <Card key={d.id} style={{ marginTop: 10 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.drawName}>{d.name}</Text>
                  <Text style={styles.drawSub}>Statut : <Text style={{ fontWeight: "800" }}>{d.status}</Text> • {d.participants_count}{d.max_participants ? `/${d.max_participants}` : ""} participants</Text>
                </View>
                <View style={[styles.statusPill, statusColor(d.status)]}>
                  <Text style={styles.statusTxt}>{d.status}</Text>
                </View>
              </View>
              <Text style={styles.drawDates}>{(d.starts_at || "").slice(0, 16).replace("T", " ")} → {(d.ends_at || "").slice(0, 16).replace("T", " ")}</Text>
              <Text style={styles.drawDates}>💰 {fmt(d.entry_amount)} • 🏆 {d.winners_count} gagnant(s)</Text>

              <Text style={styles.subT}>🎁 Récompenses</Text>
              {(d.prizes || []).map((p: any) => (
                <TouchableOpacity key={p.rank} style={styles.prizeRow} onPress={() => editPrize(d, p.rank)} disabled={d.status === "announced"}>
                  <Text style={styles.prizeR}>Rang {p.rank}</Text>
                  <Text style={styles.prizeA}>{fmt(p.amount)}</Text>
                  {d.status !== "announced" ? <Ionicons name="create" size={14} color={theme.colors.primary} /> : null}
                </TouchableOpacity>
              ))}

              {(d.winners || []).length > 0 ? (
                <View style={{ marginTop: 8 }}>
                  <Text style={styles.subT}>🏅 Gagnants annoncés</Text>
                  {[...d.winners].sort((a: any, b: any) => a.rank - b.rank).map((w: any, i: number) => (
                    <View key={`w-${i}`} style={styles.winnerRow}>
                      <Text style={styles.winRank}>#{w.rank}</Text>
                      <Text style={styles.winName}>{w.username || "—"}</Text>
                      <Text style={styles.winPrize}>{fmt(w.prize)}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              <View style={styles.actRow}>
                {d.status === "draft" ? (
                  <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.primary }]} onPress={() => setStatus(d, "open")}>
                    <Text style={styles.actT}>🟢 Ouvrir</Text>
                  </TouchableOpacity>
                ) : null}
                {d.status === "open" ? (
                  <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.warning }]} onPress={() => setStatus(d, "closed")}>
                    <Text style={styles.actT}>⏸ Clôturer</Text>
                  </TouchableOpacity>
                ) : null}
                {d.status === "closed" ? (
                  <TouchableOpacity style={[styles.actBtn, { backgroundColor: "#F59E0B" }]} onPress={() => openWinnerPicker(d)}>
                    <Text style={styles.actT}>🚀 Lancer & Annoncer</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={[styles.actBtn, { backgroundColor: "#0EA5E9" }]} onPress={() => exportCsv(d)}>
                  <Text style={styles.actT}>📥 CSV</Text>
                </TouchableOpacity>
                {d.status !== "announced" ? (
                  <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.danger }]} onPress={() => deleteDraw(d)}>
                    <Text style={styles.actT}>🗑️</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </Card>
          ))}
        </View>
      )}

      {tab === "settings" && settings && (
        <Card style={{ marginTop: 12 }}>
          <Text style={styles.subT}>Activation du module</Text>
          <TouchableOpacity
            style={[styles.toggleRow, settings.enabled ? styles.togOn : styles.togOff]}
            onPress={() => saveSettings({ enabled: !settings.enabled })}
            testID="lottery-enable-toggle"
          >
            <Ionicons name={settings.enabled ? "checkmark-circle" : "close-circle"} size={18} color="#fff" />
            <Text style={styles.toggleTxt}>{settings.enabled ? "Module ACTIVÉ" : "Module DÉSACTIVÉ"}</Text>
          </TouchableOpacity>

          <Text style={styles.subT}>Icône flottante (bas-gauche)</Text>
          <TouchableOpacity
            style={[styles.toggleRow, settings.floating_icon_visible ? styles.togOn : styles.togOff]}
            onPress={() => saveSettings({ floating_icon_visible: !settings.floating_icon_visible })}
            testID="lottery-icon-toggle"
          >
            <Ionicons name={settings.floating_icon_visible ? "eye" : "eye-off"} size={18} color="#fff" />
            <Text style={styles.toggleTxt}>{settings.floating_icon_visible ? "Icône visible" : "Icône masquée"}</Text>
          </TouchableOpacity>

          <Text style={styles.subT}>Durée d'affichage des résultats (minutes)</Text>
          <TextInput
            style={styles.input}
            keyboardType="numeric"
            value={String(settings.results_display_duration_minutes || 60)}
            onChangeText={(v) => setSettings({ ...settings, results_display_duration_minutes: parseInt(v) || 0 })}
            placeholder="60"
            placeholderTextColor={theme.colors.textSecondary}
          />
          <TouchableOpacity
            style={[styles.actBtn, { backgroundColor: theme.colors.success, marginTop: 10 }]}
            onPress={() => saveSettings({ results_display_duration_minutes: settings.results_display_duration_minutes })}
          >
            <Text style={styles.actT}>💾 Sauvegarder</Text>
          </TouchableOpacity>
        </Card>
      )}

      {tab === "stats" && stats && (
        <View>
          <View style={styles.statGrid}>
            <View style={styles.stat}><Text style={styles.statN}>{stats.total_draws}</Text><Text style={styles.statL}>Total tirages</Text></View>
            <View style={styles.stat}><Text style={[styles.statN, { color: theme.colors.success }]}>{stats.open_count}</Text><Text style={styles.statL}>🟢 Ouverts</Text></View>
            <View style={styles.stat}><Text style={[styles.statN, { color: theme.colors.warning }]}>{stats.closed_count}</Text><Text style={styles.statL}>⏸ Clôturés</Text></View>
            <View style={styles.stat}><Text style={[styles.statN, { color: theme.colors.primary }]}>{stats.announced_count}</Text><Text style={styles.statL}>🏆 Annoncés</Text></View>
          </View>
          <Card style={{ marginTop: 10 }}>
            <View style={styles.kvBox}>
              <View style={styles.kv}><Text style={styles.kvL}>👥 Total participants</Text><Text style={styles.kvV}>{stats.total_participants}</Text></View>
              <View style={styles.kv}><Text style={styles.kvL}>💰 Total collecté</Text><Text style={styles.kvV}>{fmt(stats.total_collected)}</Text></View>
              <View style={styles.kv}><Text style={styles.kvL}>🏆 Total distribué</Text><Text style={styles.kvV}>{fmt(stats.total_distributed)}</Text></View>
              <View style={styles.kv}><Text style={styles.kvL}>📈 Revenu net</Text><Text style={[styles.kvV, { color: stats.net_revenue >= 0 ? theme.colors.success : theme.colors.danger }]}>{fmt(stats.net_revenue)}</Text></View>
            </View>
          </Card>
        </View>
      )}

      {creating ? (
        <View style={styles.modalOverlay} testID="lottery-create-modal">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>🎰 Créer un tirage</Text>
            <Text style={styles.modalSub}>Le tirage sera créé en statut "brouillon" — vous pourrez ensuite définir les récompenses puis l'ouvrir.</Text>
            <Text style={styles.subT}>Nom du tirage *</Text>
            <TextInput style={styles.input} value={draft.name} onChangeText={(v) => setDraft({ ...draft, name: v })} placeholder="Ex: Jackpot Juin 2026" placeholderTextColor={theme.colors.textSecondary} testID="lottery-name" />
            <Text style={styles.subT}>Démarre dans (heures, 0 = immédiat)</Text>
            <TextInput style={styles.input} value={draft.startsIn} onChangeText={(v) => setDraft({ ...draft, startsIn: v })} keyboardType="numeric" placeholder="0" placeholderTextColor={theme.colors.textSecondary} testID="lottery-startin" />
            <Text style={styles.subT}>Durée du tirage (heures)</Text>
            <TextInput style={styles.input} value={draft.durationH} onChangeText={(v) => setDraft({ ...draft, durationH: v })} keyboardType="numeric" placeholder="168" placeholderTextColor={theme.colors.textSecondary} testID="lottery-duration" />
            <Text style={styles.subT}>Nombre de gagnants</Text>
            <TextInput style={styles.input} value={draft.winnersCount} onChangeText={(v) => setDraft({ ...draft, winnersCount: v })} keyboardType="numeric" placeholder="3" placeholderTextColor={theme.colors.textSecondary} testID="lottery-winners" />
            <Text style={styles.subT}>Max participants (0 = illimité)</Text>
            <TextInput style={styles.input} value={draft.maxP} onChangeText={(v) => setDraft({ ...draft, maxP: v })} keyboardType="numeric" placeholder="100" placeholderTextColor={theme.colors.textSecondary} testID="lottery-maxp" />
            <Text style={styles.subT}>Montant participation (FCFA)</Text>
            <TextInput style={styles.input} value={draft.entry} onChangeText={(v) => setDraft({ ...draft, entry: v })} keyboardType="numeric" placeholder="500" placeholderTextColor={theme.colors.textSecondary} testID="lottery-entry" />
            <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
              <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.surfaceSecondary, flex: 1 }]} onPress={() => setCreating(false)} testID="lottery-create-cancel">
                <Text style={[styles.actT, { color: theme.colors.textPrimary }]}>Annuler</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actBtn, { backgroundColor: "#F59E0B", flex: 2 }]} onPress={submitCreate} testID="lottery-create-submit">
                <Text style={styles.actT}>✅ Créer le tirage</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}

      {editing ? (
        <View style={styles.modalOverlay} testID="winner-picker-modal">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>🏆 Sélection des gagnants — {editing.name}</Text>
            <Text style={styles.modalSub}>{participants.length} participants</Text>
            <ScrollView style={{ maxHeight: 400, marginTop: 10 }}>
              {Array.from({ length: editing.winners_count }, (_, i) => i + 1).map((rank) => (
                <View key={`r-${rank}`} style={styles.winnerSlot}>
                  <Text style={styles.slotTitle}>{rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "🏅"} Rang {rank}</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Récompense (FCFA)"
                    placeholderTextColor={theme.colors.textSecondary}
                    keyboardType="numeric"
                    value={winners[rank]?.prize || ""}
                    onChangeText={(v) => setWinners({ ...winners, [rank]: { ...(winners[rank] || {}), prize: v, user_id: winners[rank]?.user_id || "" } })}
                  />
                  <Text style={styles.helper}>Sélectionner un participant :</Text>
                  <ScrollView style={{ maxHeight: 120 }}>
                    {participants.map((p) => {
                      const on = winners[rank]?.user_id === p.user_id;
                      return (
                        <TouchableOpacity
                          key={`${rank}-${p.user_id}`}
                          style={[styles.partRow, on && styles.partRowOn]}
                          onPress={() => setWinners({ ...winners, [rank]: { ...(winners[rank] || { prize: "0" }), user_id: p.user_id } })}
                        >
                          <Text style={[styles.partTxt, on && { color: "#fff" }]}>{p.username}</Text>
                          {on ? <Ionicons name="checkmark" size={14} color="#fff" /> : null}
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              ))}
            </ScrollView>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
              <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.surfaceSecondary, flex: 1 }]} onPress={() => setEditing(null)}>
                <Text style={[styles.actT, { color: theme.colors.textPrimary }]}>Annuler</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actBtn, { backgroundColor: "#F59E0B", flex: 2 }]} onPress={announceWinners}>
                <Text style={styles.actT}>🚀 Annoncer les gagnants</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

function statusColor(s: string) {
  const m: any = {
    draft: { backgroundColor: "#E5E7EB" },
    open: { backgroundColor: "#D1FAE5" },
    closed: { backgroundColor: "#FEF3C7" },
    announced: { backgroundColor: "#DBEAFE" },
  };
  return m[s] || {};
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  h1: { fontSize: 22, fontWeight: "900", color: theme.colors.textPrimary, marginBottom: 10 },
  tabRow: { flexDirection: "row", gap: 4, marginBottom: 10 },
  tab: { flex: 1, padding: 10, borderRadius: 8, backgroundColor: theme.colors.surfaceSecondary, alignItems: "center" },
  tabOn: { backgroundColor: theme.colors.primary },
  tabT: { fontSize: 11, fontWeight: "700", color: theme.colors.textPrimary },
  createBtn: { padding: 12, borderRadius: 10, backgroundColor: "#F59E0B", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  createTxt: { color: "#fff", fontWeight: "800", fontSize: 13 },
  drawName: { fontSize: 15, fontWeight: "800", color: theme.colors.textPrimary },
  drawSub: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 2 },
  drawDates: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 3 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  statusTxt: { fontSize: 10, fontWeight: "800", color: "#1F2937" },
  subT: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 12, marginTop: 8, marginBottom: 4 },
  prizeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 8, borderRadius: 6, backgroundColor: "#FEF3C7", marginBottom: 4 },
  prizeR: { color: "#92400E", fontWeight: "700", fontSize: 12 },
  prizeA: { color: "#92400E", fontWeight: "800", fontSize: 12, flex: 1, textAlign: "right", marginRight: 6 },
  winnerRow: { flexDirection: "row", alignItems: "center", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  winRank: { width: 35, fontWeight: "800", color: theme.colors.textPrimary },
  winName: { flex: 1, color: theme.colors.textPrimary, fontSize: 12, fontWeight: "700" },
  winPrize: { color: theme.colors.success, fontWeight: "800", fontSize: 12 },
  actRow: { flexDirection: "row", gap: 6, marginTop: 10, flexWrap: "wrap" },
  actBtn: { padding: 8, borderRadius: 8, alignItems: "center" },
  actT: { color: "#fff", fontWeight: "800", fontSize: 11 },
  statGrid: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  stat: { flex: 1, minWidth: 100, padding: 10, borderRadius: 10, backgroundColor: theme.colors.surface, alignItems: "center" },
  statN: { fontSize: 22, fontWeight: "900", color: theme.colors.primary },
  statL: { fontSize: 10, color: theme.colors.textSecondary, marginTop: 2 },
  kvBox: { gap: 6 },
  kv: { flexDirection: "row", justifyContent: "space-between" },
  kvL: { color: theme.colors.textSecondary, fontSize: 12 },
  kvV: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "800" },
  toggleRow: { padding: 12, borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  togOn: { backgroundColor: theme.colors.success },
  togOff: { backgroundColor: theme.colors.danger },
  toggleTxt: { color: "#fff", fontWeight: "800", fontSize: 13 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8, color: theme.colors.textPrimary, fontSize: 12, marginBottom: 6 },
  modalOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: 14 },
  modalCard: { backgroundColor: theme.colors.surface, borderRadius: 12, padding: 16, width: "100%", maxWidth: 600 },
  modalTitle: { fontSize: 16, fontWeight: "900", color: theme.colors.textPrimary },
  modalSub: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 2 },
  winnerSlot: { padding: 10, borderRadius: 8, backgroundColor: theme.colors.surfaceSecondary, marginBottom: 8 },
  slotTitle: { fontSize: 13, fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 6 },
  helper: { fontSize: 10, color: theme.colors.textSecondary, marginTop: 4, marginBottom: 4 },
  partRow: { padding: 6, borderRadius: 6, backgroundColor: theme.colors.surface, marginBottom: 3, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  partRowOn: { backgroundColor: theme.colors.primary },
  partTxt: { color: theme.colors.textPrimary, fontSize: 11, fontWeight: "700" },
});
