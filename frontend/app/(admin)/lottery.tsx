import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Modal, Dimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { api } from "@/src/api";
import { Card } from "@/src/components/Card";

const fmt = (v: any) => `${Math.round(Number(v) || 0).toLocaleString("fr-FR")} FCFA`;

type Tab = "draws" | "settings" | "stats";

const STATUS_LABEL: Record<string, string> = {
  open: "🟢 Ouvert aux participations",
  running: "⏱ En cours (tirage lancé)",
  announced: "🏆 Annoncé",
};

function useCountdown(endsAtISO: string | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!endsAtISO) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [endsAtISO]);
  if (!endsAtISO) return { h: 0, m: 0, s: 0, done: true, label: "—" };
  const target = new Date(endsAtISO).getTime();
  const diff = Math.max(0, target - now);
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  const done = diff <= 0;
  return { h, m, s, done, label: done ? "Terminé" : `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` };
}

function DrawCountdown({ endsAt }: { endsAt: string | null | undefined }) {
  const cd = useCountdown(endsAt);
  if (!endsAt) return null;
  return (
    <Text style={styles.runningCountdown}>⏱ Compte à rebours : <Text style={{ fontWeight: "900" }}>{cd.label}</Text></Text>
  );
}

export default function AdminLottery() {
  const [tab, setTab] = useState<Tab>("draws");
  const [settings, setSettings] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [draws, setDraws] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [participants, setParticipants] = useState<any[]>([]);
  const [winners, setWinners] = useState<Record<number, { user_id: string; prize: string }>>({});

  // Launch modal state
  const [launchTarget, setLaunchTarget] = useState<any | null>(null);
  const [launchDuration, setLaunchDuration] = useState<string>("10"); // minutes
  const [launching, setLaunching] = useState(false);

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
  // Auto-refresh every 10 s so running countdowns / auto-announcements stay live.
  useEffect(() => {
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [load]);

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
  const [draft, setDraft] = useState<any>({
    name: "",
    description: "",
    entry: "500",
    minParticipants: "0",
    maxP: "100",
    winnersCount: "3",
    prizes: ["100000", "50000", "25000"],
  });

  const updateWinnersCount = (v: string) => {
    const n = Math.max(1, parseInt(v) || 1);
    const newPrizes = Array.from({ length: n }, (_, i) => draft.prizes[i] || "0");
    setDraft({ ...draft, winnersCount: v, prizes: newPrizes });
  };

  const submitCreate = async () => {
    if (!draft.name?.trim()) {
      if (typeof window !== "undefined") window.alert("❌ Le nom du Jackpot est requis.");
      return;
    }
    const winnersCount = Math.max(1, parseInt(draft.winnersCount) || 1);
    const maxP = parseInt(draft.maxP) || 0;
    const minP = parseInt(draft.minParticipants) || 0;
    const entry = Math.max(0, parseFloat(draft.entry) || 0);
    try {
      await api.post("/admin/lottery/draws", {
        name: draft.name.trim(),
        description: (draft.description || "").trim(),
        winners_count: winnersCount,
        max_participants: maxP > 0 ? maxP : null,
        min_participants: minP > 0 ? minP : null,
        entry_amount: entry,
        prizes: Array.from({ length: winnersCount }, (_, i) => ({
          rank: i + 1,
          amount: parseFloat(draft.prizes[i] || "0") || 0,
        })),
      });
      setCreating(false);
      setDraft({
        name: "", description: "", entry: "500", minParticipants: "0", maxP: "100",
        winnersCount: "3", prizes: ["100000", "50000", "25000"],
      });
      await load();
      if (typeof window !== "undefined") window.alert("✅ Jackpot créé et ouvert aux participations. Cliquez sur \"Lancer le tirage\" lorsque vous êtes prêt à démarrer le compte à rebours.");
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    }
  };

  const submitLaunch = async () => {
    if (!launchTarget) return;
    const minutes = Math.max(1, parseInt(launchDuration) || 0);
    if (minutes <= 0) {
      if (typeof window !== "undefined") window.alert("❌ Durée invalide.");
      return;
    }
    if ((launchTarget.participants_count || 0) <= 0) {
      if (typeof window !== "undefined") window.alert("❌ Aucun participant inscrit — impossible de lancer le tirage.");
      return;
    }
    if (typeof window !== "undefined" && !window.confirm(`🚀 Lancer le tirage « ${launchTarget.name} » avec une durée de ${minutes} min ?\n\nUne fois lancé :\n• Les utilisateurs ne pourront plus rejoindre\n• Le compte à rebours sera visible chez les participants\n• Les gagnants seront sélectionnés et crédités automatiquement à la fin`)) return;
    setLaunching(true);
    try {
      await api.post(`/admin/lottery/draws/${launchTarget.id}/launch`, { duration_minutes: minutes });
      setLaunchTarget(null);
      setLaunchDuration("10");
      await load();
      if (typeof window !== "undefined") window.alert("🚀 Tirage lancé ! Le compte à rebours est démarré.");
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    } finally {
      setLaunching(false);
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
    if (typeof window !== "undefined" && !window.confirm(`Annoncer ${list.length} gagnant(s) manuellement ?\n\nLes gains seront crédités immédiatement.`)) return;
    try {
      await api.post(`/admin/lottery/draws/${editing.id}/announce`, { winners: list });
      setEditing(null);
      await load();
      if (typeof window !== "undefined") window.alert("🎉 Gagnants annoncés et crédités !");
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
          ) : draws.map((d) => {
            const isFull = d.max_participants && d.participants_count >= d.max_participants;
            return (
              <Card key={d.id} style={{ marginTop: 10 }} testID={`lottery-draw-${d.id}`}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.drawName}>{d.name}</Text>
                    <Text style={styles.drawSub}>{STATUS_LABEL[d.status] || d.status} • {d.participants_count}{d.max_participants ? `/${d.max_participants}` : ""} participants{isFull ? "  (COMPLET)" : ""}</Text>
                  </View>
                  <View style={[styles.statusPill, statusColor(d.status)]}>
                    <Text style={styles.statusTxt}>{d.status === "open" ? "OUVERT" : d.status === "running" ? "EN COURS" : d.status === "announced" ? "ANNONCÉ" : d.status}</Text>
                  </View>
                </View>
                {d.description ? <Text style={styles.drawDates}>📝 {d.description}</Text> : null}
                <Text style={styles.drawDates}>💰 {fmt(d.entry_amount)} • 🏆 {d.winners_count} gagnant(s){d.min_participants ? ` • min ${d.min_participants}` : ""}</Text>
                {d.status === "running" ? (
                  <DrawCountdown endsAt={d.ends_at} />
                ) : null}

                <Text style={styles.subT}>🎁 Récompenses</Text>
                {(d.prizes || []).map((p: any) => (
                  <TouchableOpacity key={p.rank} style={styles.prizeRow} onPress={() => editPrize(d, p.rank)} disabled={d.status !== "open"}>
                    <Text style={styles.prizeR}>Rang {p.rank}</Text>
                    <Text style={styles.prizeA}>{fmt(p.amount)}</Text>
                    {d.status === "open" ? <Ionicons name="create" size={14} color={theme.colors.primary} /> : null}
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
                  {d.status === "open" ? (
                    <TouchableOpacity
                      style={[styles.actBtn, { backgroundColor: "#F59E0B" }]}
                      onPress={() => { setLaunchTarget(d); setLaunchDuration("10"); }}
                      testID={`lottery-launch-${d.id}`}
                    >
                      <Text style={styles.actT}>🚀 Lancer le tirage</Text>
                    </TouchableOpacity>
                  ) : null}
                  {d.status === "running" ? (
                    <TouchableOpacity
                      style={[styles.actBtn, { backgroundColor: theme.colors.primary }]}
                      onPress={() => openWinnerPicker(d)}
                      testID={`lottery-finalize-${d.id}`}
                    >
                      <Text style={styles.actT}>🎯 Annoncer manuellement</Text>
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
            );
          })}
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
            <View style={styles.stat}><Text style={[styles.statN, { color: theme.colors.warning }]}>{stats.running_count || 0}</Text><Text style={styles.statL}>⏱ En cours</Text></View>
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

      {/* CREATE MODAL */}
      <Modal visible={creating} transparent animationType="fade" onRequestClose={() => setCreating(false)}>
        <View style={styles.modalBg} testID="lottery-create-modal">
          <View style={styles.modalCardSized}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>🎰 Créer un Jackpot</Text>
              <TouchableOpacity onPress={() => setCreating(false)} testID="lottery-create-close" style={{ padding: 4 }}>
                <Ionicons name="close" size={22} color={theme.colors.textPrimary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalSub}>Le Jackpot sera immédiatement ouvert aux participations. La durée du compte à rebours sera définie au moment du lancement.</Text>

            <ScrollView style={styles.modalScroll} contentContainerStyle={{ paddingVertical: 8 }} showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
              <Text style={styles.subT}>1. Nom du Jackpot *</Text>
              <TextInput style={styles.input} value={draft.name} onChangeText={(v) => setDraft({ ...draft, name: v })} placeholder="Ex: Jackpot Juin 2026" placeholderTextColor={theme.colors.textSecondary} testID="lottery-name" autoFocus />

              <Text style={styles.subT}>2. Description</Text>
              <TextInput style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]} value={draft.description} onChangeText={(v) => setDraft({ ...draft, description: v })} placeholder="Description du tirage (optionnel)" placeholderTextColor={theme.colors.textSecondary} multiline numberOfLines={3} testID="lottery-description" />

              <Text style={styles.subT}>3. Montant de participation (FCFA)</Text>
              <TextInput style={styles.input} value={draft.entry} onChangeText={(v) => setDraft({ ...draft, entry: v })} keyboardType="numeric" placeholder="500" placeholderTextColor={theme.colors.textSecondary} testID="lottery-entry" />

              <Text style={styles.subT}>4. Nombre minimum de participants</Text>
              <TextInput style={styles.input} value={draft.minParticipants} onChangeText={(v) => setDraft({ ...draft, minParticipants: v })} keyboardType="numeric" placeholder="0 (sans minimum)" placeholderTextColor={theme.colors.textSecondary} testID="lottery-minp" />

              <Text style={styles.subT}>5. Nombre maximum de participants</Text>
              <TextInput style={styles.input} value={draft.maxP} onChangeText={(v) => setDraft({ ...draft, maxP: v })} keyboardType="numeric" placeholder="0 = illimité" placeholderTextColor={theme.colors.textSecondary} testID="lottery-maxp" />

              <Text style={styles.subT}>6. Nombre de gagnants</Text>
              <TextInput style={styles.input} value={draft.winnersCount} onChangeText={updateWinnersCount} keyboardType="numeric" placeholder="3" placeholderTextColor={theme.colors.textSecondary} testID="lottery-winners" />

              <Text style={styles.subT}>7. Récompenses par rang (FCFA)</Text>
              {Array.from({ length: Math.max(1, parseInt(draft.winnersCount) || 1) }, (_, i) => i + 1).map((rank) => (
                <View key={`p-${rank}`} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <Text style={styles.rankLbl}>
                    {rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "🏅"} Rang {rank}
                  </Text>
                  <TextInput
                    style={[styles.input, { flex: 1, marginBottom: 0 }]}
                    value={draft.prizes[rank - 1] || ""}
                    onChangeText={(v) => {
                      const np = [...draft.prizes];
                      np[rank - 1] = v;
                      setDraft({ ...draft, prizes: np });
                    }}
                    keyboardType="numeric"
                    placeholder="0"
                    placeholderTextColor={theme.colors.textSecondary}
                    testID={`lottery-prize-${rank}`}
                  />
                </View>
              ))}
              <View style={{ height: 20 }} />
            </ScrollView>

            <View style={styles.modalFooter}>
              <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.surfaceSecondary, flex: 1 }]} onPress={() => setCreating(false)} testID="lottery-create-cancel">
                <Text style={[styles.actT, { color: theme.colors.textPrimary }]}>Annuler</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actBtn, { backgroundColor: "#F59E0B", flex: 2 }]} onPress={submitCreate} testID="lottery-create-submit">
                <Text style={styles.actT}>✅ Créer & Ouvrir</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* LAUNCH MODAL */}
      <Modal visible={!!launchTarget} transparent animationType="fade" onRequestClose={() => setLaunchTarget(null)}>
        <View style={styles.modalBg} testID="lottery-launch-modal">
          <View style={[styles.modalCardSized, { maxHeight: 480 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>🚀 Lancer le tirage</Text>
              <TouchableOpacity onPress={() => setLaunchTarget(null)} testID="lottery-launch-close" style={{ padding: 4 }}>
                <Ionicons name="close" size={22} color={theme.colors.textPrimary} />
              </TouchableOpacity>
            </View>

            <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }}>
              <Text style={styles.modalSub}>{launchTarget?.name}</Text>
              <Text style={[styles.drawDates, { marginTop: 6 }]}>👥 {launchTarget?.participants_count || 0}{launchTarget?.max_participants ? `/${launchTarget.max_participants}` : ""} participants inscrits</Text>

              <Text style={styles.subT}>Durée du compte à rebours (minutes)</Text>
              <TextInput
                style={styles.input}
                value={launchDuration}
                onChangeText={setLaunchDuration}
                keyboardType="numeric"
                placeholder="10"
                placeholderTextColor={theme.colors.textSecondary}
                testID="lottery-launch-duration"
              />

              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {[5, 10, 30, 60, 180, 720].map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={styles.presetChip}
                    onPress={() => setLaunchDuration(String(m))}
                    testID={`lottery-launch-preset-${m}`}
                  >
                    <Text style={styles.presetChipT}>
                      {m < 60 ? `${m} min` : m === 60 ? "1 h" : m === 180 ? "3 h" : "12 h"}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={[styles.helper, { marginTop: 10 }]}>
                ⚠️ Une fois lancé, plus aucun utilisateur ne pourra rejoindre le tirage. Les gagnants seront tirés au sort automatiquement à la fin du compte à rebours et leurs gains crédités sur leur solde retirable.
              </Text>
            </View>

            <View style={styles.modalFooter}>
              <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.surfaceSecondary, flex: 1 }]} onPress={() => setLaunchTarget(null)} testID="lottery-launch-cancel">
                <Text style={[styles.actT, { color: theme.colors.textPrimary }]}>Annuler</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actBtn, { backgroundColor: "#F59E0B", flex: 2, opacity: launching ? 0.6 : 1 }]}
                onPress={submitLaunch}
                disabled={launching}
                testID="lottery-launch-submit"
              >
                <Text style={styles.actT}>{launching ? "Lancement…" : "🚀 Lancer maintenant"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* MANUAL ANNOUNCE PICKER */}
      {editing ? (
        <View style={styles.modalOverlay} testID="winner-picker-modal">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>🏆 Sélection manuelle des gagnants — {editing.name}</Text>
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
    open: { backgroundColor: "#D1FAE5" },
    running: { backgroundColor: "#FEF3C7" },
    announced: { backgroundColor: "#DBEAFE" },
  };
  return m[s] || { backgroundColor: "#E5E7EB" };
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
  runningCountdown: { fontSize: 12, color: "#92400E", marginTop: 6, padding: 6, borderRadius: 6, backgroundColor: "#FEF3C7" },
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
  modalBg: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 24,
  },
  modalCardSized: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    width: "100%",
    maxWidth: 560,
    maxHeight: Math.min(Dimensions.get("window").height - 40, 720),
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    paddingBottom: 4,
  },
  modalScroll: {
    paddingHorizontal: 16,
    flexGrow: 0,
  },
  modalFooter: {
    flexDirection: "row",
    gap: 8,
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  rankLbl: { width: 80, fontSize: 12, fontWeight: "700", color: theme.colors.textPrimary },
  modalTitle: { fontSize: 16, fontWeight: "900", color: theme.colors.textPrimary },
  modalSub: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 2 },
  winnerSlot: { padding: 10, borderRadius: 8, backgroundColor: theme.colors.surfaceSecondary, marginBottom: 8 },
  slotTitle: { fontSize: 13, fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 6 },
  helper: { fontSize: 10, color: theme.colors.textSecondary, marginTop: 4, marginBottom: 4 },
  partRow: { padding: 6, borderRadius: 6, backgroundColor: theme.colors.surface, marginBottom: 3, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  partRowOn: { backgroundColor: theme.colors.primary },
  partTxt: { color: theme.colors.textPrimary, fontSize: 11, fontWeight: "700" },
  presetChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  presetChipT: { fontSize: 11, fontWeight: "700", color: theme.colors.textPrimary },
});
