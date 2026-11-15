import React from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { api } from "@/src/api";
import { useI18n } from "@/src/i18n";

type Msg = { kind: "ok" | "err"; text: string } | null;

function clientCheck(url: string, t: (key: string) => string): string | null {
  const v = url.trim();
  if (!v) return t("profile.support_group_required");
  if (!/^https:\/\/[^\s/?#]+\.[^\s/?#]+/i.test(v)) return t("profile.support_group_invalid");
  return null;
}

export const SupportGroupCard: React.FC = () => {
  const { t } = useI18n();
  const [url, setUrl] = React.useState("");
  const [saved, setSaved] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    api.get<{ url: string | null }>("/me/support-group")
      .then((r) => { setSaved(r.url); setUrl(r.url || ""); })
      .catch(() => setMsg({ kind: "err", text: t("profile.support_group_load_failed") }))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    const e = clientCheck(url, t);
    if (e) { setMsg({ kind: "err", text: e }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await api.put<{ url: string }>("/me/support-group", { url: url.trim() });
      setSaved(r.url); setUrl(r.url);
      setMsg({ kind: "ok", text: t("profile.support_group_saved") });
    } catch (err: any) {
      setMsg({ kind: "err", text: err?.detail || t("profile.support_group_save_failed") });
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.delete("/me/support-group");
      setSaved(null); setUrl("");
      setMsg({ kind: "ok", text: t("profile.support_group_removed") });
    } catch (err: any) {
      setMsg({ kind: "err", text: err?.detail || t("profile.support_group_remove_failed") });
    } finally { setBusy(false); }
  };

  return (
    <View style={styles.card} testID="profile-support-group-card">
      <View style={styles.head}>
        <View style={styles.iconWrap}><Ionicons name="people" size={20} color="#16A34A" /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{t("profile.support_group_title")}</Text>
          <Text style={styles.hint}>
            {t("profile.support_group_desc")}
          </Text>
        </View>
      </View>
      <View style={styles.inputWrap}>
        <Ionicons name="link" size={17} color={theme.colors.textMuted} />
        <TextInput
          value={url}
          onChangeText={(t) => { setUrl(t); setMsg(null); }}
          placeholder="https://chat.whatsapp.com/ExempleGroupe"
          placeholderTextColor={theme.colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!loading && !busy}
          style={styles.input}
          testID="support-group-input"
        />
      </View>
      <TouchableOpacity style={[styles.saveBtn, (busy || loading) && { opacity: 0.7 }]} onPress={save} disabled={busy || loading} testID="support-group-save">
        {busy ? <ActivityIndicator color="#fff" /> : (
          <>
            <Ionicons name="save" size={17} color="#fff" />
            <Text style={styles.saveTxt}>{saved ? t("profile.support_group_update") : t("profile.support_group_save")}</Text>
          </>
        )}
      </TouchableOpacity>
      {msg && (
        <Text style={[styles.msg, { color: msg.kind === "ok" ? "#16A34A" : theme.colors.danger }]} testID={`support-group-msg-${msg.kind}`}>
          {msg.text}
        </Text>
      )}
      <View style={styles.footRow}>
        <Ionicons name="information-circle" size={15} color={theme.colors.textMuted} />
        <Text style={styles.foot}>{t("profile.support_group_note")}</Text>
      </View>
      {saved && !busy && (
        <TouchableOpacity onPress={remove} style={styles.removeBtn} testID="support-group-delete">
          <Ionicons name="trash-outline" size={14} color={theme.colors.danger} />
          <Text style={styles.removeTxt}>{t("profile.delete_link")}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  card: { backgroundColor: "#fff", borderRadius: 22, padding: 16, borderWidth: 1, borderColor: "#D1FAE5", marginTop: 12 },
  head: { flexDirection: "row", gap: 12, marginBottom: 12 },
  iconWrap: { width: 42, height: 42, borderRadius: 21, backgroundColor: "#DCFCE7", alignItems: "center", justifyContent: "center" },
  title: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 15.5 },
  hint: { color: theme.colors.textSecondary, fontSize: 12.5, marginTop: 3, lineHeight: 17 },
  inputWrap: {
    flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: theme.colors.borderStrong,
    borderRadius: 14, paddingHorizontal: 12, backgroundColor: "#fff",
  },
  input: { flex: 1, paddingVertical: 12, fontSize: 13.5, color: theme.colors.textPrimary, outlineStyle: "none" } as any,
  saveBtn: {
    marginTop: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: "#16A34A", paddingVertical: 13, borderRadius: 14,
  },
  saveTxt: { color: "#fff", fontWeight: "800", fontSize: 14 },
  msg: { fontSize: 12.5, fontWeight: "600", marginTop: 8 },
  footRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 },
  foot: { color: theme.colors.textSecondary, fontSize: 11.5, flex: 1 },
  removeBtn: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", marginTop: 8, paddingVertical: 4 },
  removeTxt: { color: theme.colors.danger, fontSize: 12, fontWeight: "700" },
});
