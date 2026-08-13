/**
 * Admin — Notifications Push (Firebase Cloud Messaging)
 * Envoi vers TOUS / un utilisateur précis / un groupe filtré (niveau, pays, statut).
 * Utilise les endpoints /api/admin/push/all|user|group.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, TextInput,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { theme } from "@/src/theme";
import { api } from "@/src/api";
import { Card } from "@/src/components/Card";

type Audience = "all" | "user" | "group";

type SendResult = {
  requested: number;
  success: number;
  failure: number;
  removed_invalid: number;
};

type PushStats = {
  total_users_with_token: number;
  total_devices: number;
  per_level: { level: number | null; devices: number }[];
  per_country: { country: string; devices: number }[];
};

export default function AdminPush() {
  const [audience, setAudience] = useState<Audience>("all");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [link, setLink] = useState("");
  const [userId, setUserId] = useState("");
  const [levelMin, setLevelMin] = useState("");
  const [levelMax, setLevelMax] = useState("");
  const [country, setCountry] = useState("");
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<PushStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const r = await api.get<PushStats>("/admin/push/stats");
      setStats(r);
    } catch (e: any) {
      // silent — the panel still works without stats
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  const canSend =
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    (audience !== "user" || userId.trim().length > 0) &&
    (audience !== "group" ||
      levelMin.length > 0 || levelMax.length > 0 ||
      country.trim().length > 0 || status.trim().length > 0);

  const send = useCallback(async () => {
    if (!canSend || sending) return;
    setSending(true);
    setResult(null);
    setError(null);
    const payload: any = {
      title: title.trim(),
      body: body.trim(),
      link: link.trim() || undefined,
    };
    try {
      let path = "";
      if (audience === "all") {
        path = "/admin/push/all";
      } else if (audience === "user") {
        path = `/admin/push/user/${encodeURIComponent(userId.trim())}`;
      } else {
        path = "/admin/push/group";
        if (levelMin.length > 0) payload.max_level_min = Number(levelMin);
        if (levelMax.length > 0) payload.max_level_max = Number(levelMax);
        if (country.trim().length > 0) payload.country = country.trim().toUpperCase();
        if (status.trim().length > 0) payload.status = status.trim().toLowerCase();
      }
      const r = await api.post<SendResult>(path, payload);
      setResult(r);
      loadStats();
    } catch (e: any) {
      setError(e?.detail || e?.message || "Échec de l'envoi.");
    } finally {
      setSending(false);
    }
  }, [audience, title, body, link, userId, levelMin, levelMax, country, status,
      canSend, sending, loadStats]);

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={{ padding: 16, paddingBottom: 64 }}>
      <Text style={styles.h1}>🔔 Notifications Push</Text>
      <Text style={styles.sub}>Envoi via Firebase Cloud Messaging (Web Push).</Text>

      {/* Test push button — checks the whole FCM pipeline in one click */}
      <TouchableOpacity
        style={styles.testSelfBtn}
        onPress={async () => {
          try {
            const r = await api.post<SendResult>("/push/test-self", {});
            if (typeof window !== "undefined") {
              window.alert(
                `📊 Test push envoyé\n` +
                `📨 Tokens ciblés : ${r.requested}\n` +
                `✅ Réussites : ${r.success}\n` +
                `❌ Échecs : ${r.failure}\n` +
                (r.requested === 0 ? "\n⚠️ Aucun appareil enregistré pour votre compte. Cliquez sur '🔔 Activer les notifications' depuis votre profil, puis réessayez." : "")
              );
            }
          } catch (e: any) {
            if (typeof window !== "undefined") {
              window.alert(`❌ Test échoué : ${e?.detail || e?.message || "erreur inconnue"}`);
            }
          }
        }}
        testID="push-test-self"
      >
        <Ionicons name="flash" size={16} color="#fff" />
        <Text style={styles.sendTxt}>Envoyer un test à mon appareil</Text>
      </TouchableOpacity>

      {/* ── Stats bar ────────────────────────────────────────────── */}
      <Card style={{ marginTop: 12 }} testID="push-stats-card">
        {statsLoading || !stats ? (
          <ActivityIndicator color={theme.colors.primary} />
        ) : (
          <View>
            <View style={styles.statRow}>
              <View style={styles.statBox}>
                <Text style={styles.statN}>{stats.total_users_with_token}</Text>
                <Text style={styles.statL}>Utilisateurs abonnés</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statN}>{stats.total_devices}</Text>
                <Text style={styles.statL}>Appareils enregistrés</Text>
              </View>
            </View>
            {stats.per_level.length > 0 && (
              <Text style={styles.hint}>
                Répartition par niveau : {stats.per_level.map((r) => `N${r.level ?? "?"}=${r.devices}`).join(" · ")}
              </Text>
            )}
            {stats.per_country.length > 0 && (
              <Text style={styles.hint}>
                Répartition pays : {stats.per_country.slice(0, 6).map((r) => `${r.country}=${r.devices}`).join(" · ")}
              </Text>
            )}
          </View>
        )}
      </Card>

      {/* ── Audience selector ─────────────────────────────────────── */}
      <Text style={styles.section}>1 · Cible</Text>
      <View style={styles.audienceRow}>
        {(["all", "user", "group"] as Audience[]).map((a) => (
          <TouchableOpacity
            key={a}
            style={[styles.audienceBtn, audience === a && styles.audienceBtnActive]}
            onPress={() => setAudience(a)}
            testID={`push-audience-${a}`}
          >
            <Text style={[styles.audienceTxt, audience === a && styles.audienceTxtActive]}>
              {a === "all" ? "👥 Tout le monde" : a === "user" ? "👤 Un utilisateur" : "🎯 Un groupe"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {audience === "user" && (
        <View style={{ marginTop: 8 }}>
          <Text style={styles.label}>ID de l'utilisateur</Text>
          <TextInput
            value={userId}
            onChangeText={setUserId}
            placeholder="ex: f3314320-bab3-47ab-b750-c4873cc3faa2"
            placeholderTextColor="#94A3B8"
            style={styles.input}
            testID="push-user-id"
          />
        </View>
      )}

      {audience === "group" && (
        <View style={{ marginTop: 8 }}>
          <View style={styles.rowInputs}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Niveau min</Text>
              <TextInput
                value={levelMin}
                onChangeText={setLevelMin}
                placeholder="ex: 1"
                keyboardType="numeric"
                placeholderTextColor="#94A3B8"
                style={styles.input}
                testID="push-level-min"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Niveau max</Text>
              <TextInput
                value={levelMax}
                onChangeText={setLevelMax}
                placeholder="ex: 12"
                keyboardType="numeric"
                placeholderTextColor="#94A3B8"
                style={styles.input}
                testID="push-level-max"
              />
            </View>
          </View>
          <View style={styles.rowInputs}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Pays (code)</Text>
              <TextInput
                value={country}
                onChangeText={setCountry}
                placeholder="ex: TG, CI, BJ..."
                placeholderTextColor="#94A3B8"
                style={styles.input}
                autoCapitalize="characters"
                testID="push-country"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Statut</Text>
              <View style={styles.audienceRow}>
                {(["", "active", "pending"] as const).map((s) => (
                  <TouchableOpacity
                    key={s || "any"}
                    style={[styles.chip, status === s && styles.chipActive]}
                    onPress={() => setStatus(s)}
                    testID={`push-status-${s || "any"}`}
                  >
                    <Text style={[styles.chipTxt, status === s && styles.chipTxtActive]}>
                      {s === "" ? "tous" : s === "active" ? "activés" : "en attente"}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
          <Text style={styles.hint}>
            💡 Combinez plusieurs filtres. Fournissez au moins un critère.
          </Text>
        </View>
      )}

      {/* ── Message content ───────────────────────────────────────── */}
      <Text style={styles.section}>2 · Message</Text>
      <Text style={styles.label}>Titre</Text>
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="ex: 🎉 Nouvelle mise à jour disponible"
        placeholderTextColor="#94A3B8"
        style={styles.input}
        maxLength={120}
        testID="push-title"
      />
      <Text style={styles.label}>Corps</Text>
      <TextInput
        value={body}
        onChangeText={setBody}
        placeholder="ex: Découvrez les nouvelles fonctionnalités de SPILOVEURE..."
        placeholderTextColor="#94A3B8"
        style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
        multiline
        maxLength={800}
        testID="push-body"
      />
      <Text style={styles.label}>Lien (optionnel)</Text>
      <TextInput
        value={link}
        onChangeText={setLink}
        placeholder="https://spiloveure.com/(app)/dashboard"
        placeholderTextColor="#94A3B8"
        style={styles.input}
        testID="push-link"
      />

      {/* ── Send button ───────────────────────────────────────────── */}
      <TouchableOpacity
        style={[styles.sendBtn, (!canSend || sending) && styles.sendBtnDisabled]}
        onPress={send}
        disabled={!canSend || sending}
        testID="push-send"
      >
        {sending ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Ionicons name="send" size={16} color="#fff" />
            <Text style={styles.sendTxt}>Envoyer maintenant</Text>
          </>
        )}
      </TouchableOpacity>

      {error && (
        <Card style={{ marginTop: 12, borderLeftWidth: 4, borderLeftColor: theme.colors.danger }} testID="push-error">
          <Text style={{ color: theme.colors.danger, fontWeight: "700" }}>❌ {error}</Text>
        </Card>
      )}

      {result && (
        <Card style={{ marginTop: 12, borderLeftWidth: 4, borderLeftColor: theme.colors.success }} testID="push-result">
          <Text style={{ color: theme.colors.success, fontWeight: "800" }}>✅ Envoi terminé</Text>
          <Text style={styles.resultLine}>📨 Tokens ciblés : {result.requested}</Text>
          <Text style={styles.resultLine}>✔️  Réussites : {result.success}</Text>
          <Text style={styles.resultLine}>❌ Échecs : {result.failure}</Text>
          <Text style={styles.resultLine}>🧹 Tokens invalides supprimés : {result.removed_invalid}</Text>
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.colors.background },
  h1: { color: theme.colors.textPrimary, fontWeight: "900", fontSize: 22 },
  sub: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 },
  section: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 15, marginTop: 20 },
  label: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: "700", marginTop: 12, marginBottom: 4 },
  hint: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 4 },
  input: {
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: 14,
    padding: 12, backgroundColor: "#fff", color: theme.colors.textPrimary,
  },
  rowInputs: { flexDirection: "row", gap: 10 },
  audienceRow: { flexDirection: "row", gap: 8, marginTop: 6, flexWrap: "wrap" },
  audienceBtn: {
    flexGrow: 1, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14,
    borderWidth: 1, borderColor: theme.colors.border, backgroundColor: "#fff",
    alignItems: "center",
  },
  audienceBtnActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  audienceTxt: { color: theme.colors.textSecondary, fontWeight: "700", fontSize: 12 },
  audienceTxtActive: { color: "#fff" },
  chip: {
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: 24,
    borderWidth: 1, borderColor: theme.colors.border, backgroundColor: "#fff",
  },
  chipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipTxt: { color: theme.colors.textSecondary, fontWeight: "700", fontSize: 12 },
  chipTxtActive: { color: "#fff" },
  sendBtn: {
    marginTop: 20, backgroundColor: theme.colors.primary,
    paddingVertical: 14, borderRadius: 16, alignItems: "center",
    flexDirection: "row", justifyContent: "center", gap: 8,
  },
  sendBtnDisabled: { opacity: 0.5 },
  sendTxt: { color: "#fff", fontWeight: "800", fontSize: 14 },
  testSelfBtn: {
    marginTop: 12, backgroundColor: "#F59E0B",
    paddingVertical: 12, borderRadius: 14, alignItems: "center",
    flexDirection: "row", justifyContent: "center", gap: 8,
  },
  statRow: { flexDirection: "row", gap: 12 },
  statBox: {
    flex: 1, backgroundColor: "#F8FAFC", borderRadius: 14,
    padding: 12, alignItems: "center",
  },
  statN: { color: theme.colors.textPrimary, fontWeight: "900", fontSize: 20 },
  statL: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  resultLine: { color: theme.colors.textPrimary, marginTop: 4, fontSize: 13 },
});
