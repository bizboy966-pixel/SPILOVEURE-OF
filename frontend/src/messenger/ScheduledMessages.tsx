import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { messengerApi } from "./api";
import type { ScheduledMessage } from "./types";

const blue = "#1769e8", ink = "#102042", muted = "#7d879a";
function toLocalInputValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const makeId = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function ScheduledMessages({ conversationId, visible, onClose }: { conversationId: string; visible: boolean; onClose: () => void }) {
  const [items, setItems] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [scheduledAt, setScheduledAt] = useState(() => toLocalInputValue(new Date(Date.now() + 15 * 60_000)));
  const [silent, setSilent] = useState(false);
  const [error, setError] = useState("");
  const minValue = useMemo(() => toLocalInputValue(new Date(Date.now() + 60_000)), []);

  const load = async () => {
    setLoading(true); setError("");
    try { setItems(await messengerApi.scheduledMessages(conversationId)); }
    catch (e: any) { setError(e?.detail || "Impossible de charger les messages programmés."); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (visible) load(); }, [visible, conversationId]);
  const create = async () => {
    const date = new Date(scheduledAt);
    if (!text.trim()) { setError("Saisissez un message."); return; }
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) { setError("Choisissez une date future."); return; }
    setBusy(true); setError("");
    try {
      await messengerApi.scheduleMessage(conversationId, {
        text: text.trim(), client_id: makeId(), scheduled_at: date.toISOString(), silent,
      });
      setText(""); setSilent(false); await load();
    } catch (e: any) { setError(e?.detail || "Programmation impossible."); }
    finally { setBusy(false); }
  };
  const cancel = async (item: ScheduledMessage) => {
    setBusy(true); setError("");
    try { await messengerApi.cancelScheduledMessage(conversationId, item.id); await load(); }
    catch (e: any) { setError(e?.detail || "Annulation impossible."); }
    finally { setBusy(false); }
  };
  const input = Platform.OS === "web"
    ? React.createElement("input" as any, {
      type: "datetime-local", value: scheduledAt, min: minValue,
      onChange: (event: any) => setScheduledAt(event.currentTarget.value),
      "aria-label": "Date et heure d’envoi",
      style: { width: "100%", height: 43, boxSizing: "border-box", borderRadius: 10, border: "1px solid #dce3ed", padding: "0 11px", color: ink, background: "#fff", fontSize: 14 },
    })
    : <TextInput value={scheduledAt} onChangeText={setScheduledAt} placeholder="AAAA-MM-JJ HH:mm" style={styles.dateInput} accessibilityLabel="Date et heure d’envoi" />;

  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.backdrop}><View style={styles.sheet}>
      <View style={styles.head}><View><Text style={styles.title}>Messages programmés</Text><Text style={styles.subtitle}>Envoi selon votre fuseau horaire</Text></View><TouchableOpacity onPress={onClose} accessibilityLabel="Fermer les messages programmés"><Ionicons name="close" size={23} color={muted} /></TouchableOpacity></View>
      <TextInput value={text} onChangeText={setText} placeholder="Votre message" multiline style={styles.messageInput} accessibilityLabel="Texte du message programmé" />
      <View style={styles.dateWrap}>{input}</View>
      <TouchableOpacity style={styles.silentRow} onPress={() => setSilent(value => !value)} accessibilityRole="checkbox" accessibilityState={{ checked: silent }}>
        <Ionicons name={silent ? "checkbox" : "square-outline"} size={20} color={silent ? blue : muted} />
        <Text style={styles.silentText}>Envoyer sans notification push</Text>
      </TouchableOpacity>
      {error ? <TouchableOpacity onPress={load}><Text style={styles.error}>{error}</Text></TouchableOpacity> : null}
      <TouchableOpacity onPress={create} disabled={busy} style={[styles.createButton, busy && { opacity: .6 }]} testID="messenger-schedule-submit">
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.createText}>Programmer le message</Text>}
      </TouchableOpacity>
      <Text style={styles.section}>À venir</Text>
      {loading ? <ActivityIndicator color={blue} style={{ margin: 16 }} /> : <ScrollView style={styles.list}>
        {items.map(item => <View key={item.id} style={styles.item}>
          <View style={{ flex: 1 }}><Text style={styles.itemDate}>{new Date(item.scheduled_at).toLocaleString()}</Text><Text style={styles.itemText} numberOfLines={2}>{item.payload.text || "Pièce jointe"}{item.payload.silent ? " · silencieux" : ""}</Text><Text style={[styles.status, item.status === "failed" && styles.failed]}>{item.status === "pending" ? "En attente" : item.status === "processing" ? "En cours d’envoi" : `Échec${item.error ? ` · ${item.error}` : ""}`}</Text></View>
          {item.status === "pending" && <TouchableOpacity onPress={() => cancel(item)} disabled={busy} style={styles.cancelButton} accessibilityLabel="Annuler ce message programmé" testID={`messenger-schedule-cancel-${item.id}`}><Ionicons name="trash-outline" size={18} color="#c34249" /></TouchableOpacity>}
        </View>)}
        {!items.length && <Text style={styles.empty}>Aucun message programmé.</Text>}
      </ScrollView>}
    </View></View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(13,24,42,.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#fff", maxHeight: "91%", borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 24 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 13 }, title: { color: ink, fontSize: 19, fontWeight: "900" }, subtitle: { color: muted, fontSize: 12, marginTop: 3 },
  messageInput: { minHeight: 78, maxHeight: 130, borderRadius: 11, backgroundColor: "#f4f6f9", padding: 12, color: ink, fontSize: 14, textAlignVertical: "top", outlineStyle: "none" as any },
  dateWrap: { marginTop: 10 }, dateInput: { width: "100%", height: 43, borderRadius: 10, borderWidth: 1, borderColor: "#dce3ed", paddingHorizontal: 11, color: ink },
  silentRow: { minHeight: 43, flexDirection: "row", alignItems: "center", gap: 8 }, silentText: { color: ink, fontSize: 13 },
  error: { color: "#c34249", fontSize: 12, paddingVertical: 5 }, createButton: { height: 44, backgroundColor: blue, borderRadius: 22, alignItems: "center", justifyContent: "center", marginTop: 4 }, createText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  section: { color: muted, fontSize: 12, fontWeight: "900", marginTop: 18, marginBottom: 7, textTransform: "uppercase" }, list: { maxHeight: 250 }, item: { minHeight: 65, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: 1, borderColor: "#edf0f4", paddingVertical: 9 }, itemDate: { color: ink, fontSize: 13, fontWeight: "800" }, itemText: { color: "#4c5870", fontSize: 12, marginTop: 3 }, status: { color: blue, fontSize: 10, fontWeight: "700", marginTop: 3 }, failed: { color: "#c34249" }, cancelButton: { padding: 10 }, empty: { textAlign: "center", color: muted, fontSize: 13, padding: 18 },
});
