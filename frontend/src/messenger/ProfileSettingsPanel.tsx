import React, { useEffect, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, Share, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { api } from "@/src/api";
import { useI18n, LANG_LABELS, type Lang } from "@/src/i18n";
import { useChat } from "@/src/chat/ChatContext";
import ProfilePhotoManager from "@/src/components/ProfilePhotoManager";
import NotificationSettingsPanel from "./NotificationSettingsPanel";
import ProfileSettingsHome from "./ProfileSettingsHome";
import ChatListsManager from "./ChatListsManager";
import { chatProfileUrl } from "./userLinks";
import type { Conversation, Message } from "./types";

type ProfileSection =
  | "Appareils connectés" | "Compte" | "Confidentialité" | "Listes" | "Discussions"
  | "Apparence" | "Diffusions" | "Accessibilité" | "Langue de l’application"
  | "Notifications" | "Stockage et données";

type Session = {
  id: string; device: string; created_at: string; last_seen: string;
  expires_at: string; current: boolean;
};
type Settings = {
  show_presence: boolean; allow_contacts: boolean; appearance: "light" | "dark";
  message_color: "blue" | "green" | "gold"; font_scale: number;
  high_contrast: boolean; reduce_motion: boolean; auto_load_media: boolean;
  default_disappearing_seconds: number;
};
type StorageUsage = { file_count: number; used_bytes: number; daily_upload_limit_bytes: number; max_file_bytes: number };
type Props = {
  user: { id: string; username: string; email?: string; phone?: string; country?: string; profile_photo?: string };
  onOpenContacts?: () => void;
  onOpenChats?: () => void;
  onAppearanceChange?: (value: "light" | "dark") => void;
  onReduceMotionChange?: (value: boolean) => void;
  onHighContrastChange?: (value: boolean) => void;
};

const blue = "#1769e8", ink = "#102042", muted = "#7d879a";
const isProfileSection = (name: string): name is ProfileSection => [
  "Appareils connectés", "Compte", "Confidentialité", "Listes", "Discussions",
  "Apparence", "Diffusions", "Accessibilité", "Langue de l’application",
  "Notifications", "Stockage et données",
].includes(name);

export default function ProfileSettingsPanel({ user, onOpenContacts, onOpenChats, onAppearanceChange, onReduceMotionChange, onHighContrastChange }: Props) {
  const router = useRouter();
  const { logout } = useChat();
  const { lang, setLang } = useI18n();
  const [section, setSection] = useState<ProfileSection | null>(null);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>({
    show_presence: true, allow_contacts: true, appearance: "light",
    message_color: "blue", font_scale: 1, high_contrast: false,
    reduce_motion: false, auto_load_media: true, default_disappearing_seconds: 0,
  });
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [error, setError] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const personalLink = chatProfileUrl(user.username);

  const loadSessions = async () => {
    setSessionsLoading(true);
    try {
      setSessions(await api.get<Session[]>("/identity/chat/sessions", { auth: false, credentials: "include" }));
      setError("");
    } catch (e: any) {
      setError(e?.detail || "Sessions indisponibles.");
    } finally {
      setSessionsLoading(false);
    }
  };
  useEffect(() => { if (section === "Appareils connectés") void loadSessions(); }, [section]);
  useEffect(() => {
    if (!["Confidentialité", "Apparence", "Accessibilité", "Stockage et données"].includes(section || "")) return;
    setSettingsLoading(true);
    api.get<Settings>("/messenger/settings").then(setSettings)
      .catch((e: any) => setError(e?.detail || "Paramètres indisponibles."))
      .finally(() => setSettingsLoading(false));
  }, [section]);
  useEffect(() => {
    if (section !== "Stockage et données") return;
    setStorageLoading(true);
    api.get<StorageUsage>("/messenger/storage")
      .then(setStorageUsage)
      .catch((e: any) => setError(e?.detail || "Le stockage ne peut pas être consulté."))
      .finally(() => setStorageLoading(false));
  }, [section]);

  const updatePrivacy = async (key: "show_presence" | "allow_contacts" | "high_contrast" | "reduce_motion" | "auto_load_media") => {
    const next = { ...settings, [key]: !settings[key] };
    const previous = settings;
    setSettings(next);
    try {
      setSettings(await api.patch<Settings>("/messenger/settings", next));
      setError("");
    } catch (e: any) {
      setSettings(previous);
      setError(e?.detail || "Modification impossible.");
    }
  };
  const updateSetting = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const previous = settings;
    const next = { ...settings, [key]: value };
    setSettings(next);
    try {
      const saved = await api.patch<Settings>("/messenger/settings", { [key]: value });
      setSettings(saved);
      if (key === "appearance") onAppearanceChange?.(value as "light" | "dark");
      if (key === "reduce_motion") onReduceMotionChange?.(value as boolean);
      if (key === "high_contrast") onHighContrastChange?.(value as boolean);
      setError("");
    } catch (e: any) {
      setSettings(previous);
      setError(e?.detail || "Modification impossible.");
    }
  };
  const revokeSession = async (id: string) => {
    try {
      await api.delete(`/identity/chat/sessions/${encodeURIComponent(id)}`, { auth: false, credentials: "include" });
      await loadSessions();
    } catch (e: any) {
      setError(e?.detail || "Révocation impossible.");
    }
  };
  const copyPersonalLink = async () => {
    try {
      await Clipboard.setStringAsync(personalLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2200);
    } catch {
      setError("Impossible de copier le lien sur cet appareil.");
    }
  };
  const sharePersonalLink = async () => {
    try {
      const message = `SPV@${user.username}\n${personalLink}`;
      if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: "SPILOVEURE Chat", text: message, url: personalLink });
      } else if (Platform.OS === "web") {
        await Clipboard.setStringAsync(message);
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2200);
      } else {
        await Share.share({ title: "SPILOVEURE Chat", message });
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e?.message || "Impossible de partager le lien.");
    }
  };
  const info = (title: string, description: string) => (
    <View style={styles.info} key={title}>
      <Ionicons name="information-circle-outline" size={19} color={blue} />
      <View style={styles.infoCopy}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.secondary}>{description}</Text>
      </View>
    </View>
  );
  const action = (title: string, onPress?: () => void, icon = "chevron-forward") => (
    <TouchableOpacity onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={title} testID={`profile-settings-action-${title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`} style={styles.action}>
      <Text style={[styles.actionText, !onPress && styles.actionDisabled]}>{title}</Text>
      <Ionicons name={icon as any} size={18} color={blue} />
    </TouchableOpacity>
  );
  const switchRow = (title: string, detail: string, key: "show_presence" | "allow_contacts" | "high_contrast" | "reduce_motion" | "auto_load_media") => (
    <TouchableOpacity onPress={() => updatePrivacy(key)} style={styles.settingRow} accessibilityRole="switch" accessibilityState={{ checked: settings[key] }} testID={`profile-privacy-${key}`}>
      <View style={styles.infoCopy}><Text style={styles.rowTitle}>{title}</Text><Text style={styles.secondary}>{detail}</Text></View>
      <View style={[styles.switch, settings[key] && styles.switchOn]}><View style={[styles.knob, settings[key] && styles.knobOn]} /></View>
    </TouchableOpacity>
  );
  const choiceRow = <K extends keyof Settings>(title: string, values: Array<{ value: Settings[K]; label: string }>, key: K) => (
    <View style={styles.choiceBlock} key={title}>
      <Text style={styles.rowTitle}>{title}</Text>
      <View style={styles.choiceRow}>{values.map(item => {
        const selected = settings[key] === item.value;
        return <TouchableOpacity key={String(item.value)} onPress={() => void updateSetting(key, item.value)} accessibilityRole="radio" accessibilityState={{ selected }} style={[styles.choice, selected && styles.choiceActive]}>
          <Text style={[styles.choiceText, selected && styles.choiceTextActive]}>{item.label}</Text>
        </TouchableOpacity>;
      })}</View>
    </View>
  );
  const formatBytes = (bytes: number) => {
    if (!bytes) return "0 o";
    const units = ["o", "Ko", "Mo", "Go"];
    const order = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** order).toFixed(order ? 1 : 0)} ${units[order]}`;
  };
  const exportHistory = async () => {
    if (typeof document === "undefined") {
      setError("L’export de l’historique est disponible depuis le navigateur Web.");
      return;
    }
    setBusy(true); setError("");
    try {
      const conversations = await api.get<Conversation[]>("/messenger/conversations");
      const exported = [];
      for (const conversation of conversations.filter(item => item.kind === "private")) {
        const messages: Message[] = [];
        let before = "";
        for (let page = 0; page < 20; page += 1) {
          const query = new URLSearchParams({ limit: "100" });
          if (before) query.set("before", before);
          const result = await api.get<{ items: Message[]; has_more: boolean }>(
            `/messenger/conversations/${encodeURIComponent(conversation.id)}/messages?${query.toString()}`,
          );
          if (!result.items.length) break;
          messages.unshift(...result.items);
          if (!result.has_more || messages.length >= 2000) break;
          before = result.items[0].id;
        }
        exported.push({ title: conversation.title, kind: conversation.is_saved ? "saved" : "private", messages });
      }
      const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), conversations: exported }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `spiloveure-chat-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e?.detail || "L’export de l’historique a échoué.");
    } finally { setBusy(false); }
  };

  const renderSection = () => {
    if (!section) return null;
    switch (section) {
      case "Appareils connectés":
        return <>
          {info("Sessions de ce compte", "SPILOVEURE Chat liste ici les sessions Web de votre compte. Il ne s’agit pas d’une liaison native de nouveaux appareils.")}
          <TouchableOpacity onPress={() => void loadSessions()} style={styles.refresh}><Text style={styles.actionText}>Actualiser</Text><Ionicons name="refresh-outline" size={18} color={blue} /></TouchableOpacity>
          {sessionsLoading && !sessions.length ? <ActivityIndicator color={blue} /> : null}
          {sessions.map(session => <View key={session.id} style={styles.settingRow}>
            <View style={styles.infoCopy}><Text style={styles.rowTitle}>{session.device || "Navigateur"}{session.current ? " · Cet appareil" : ""}</Text><Text style={styles.secondary}>Dernière activité : {new Date(session.last_seen).toLocaleString()}</Text></View>
            {!session.current && <TouchableOpacity onPress={() => void revokeSession(session.id)} accessibilityRole="button" accessibilityLabel="Terminer cette session"><Text style={styles.dangerText}>Déconnecter</Text></TouchableOpacity>}
          </View>)}
          {!sessionsLoading && sessions.length === 0 ? <Text style={styles.secondary}>Aucune session disponible.</Text> : null}
          {action("Se déconnecter de cet appareil", async () => { await logout(); router.replace("/verify-email" as any); }, "log-out-outline")}
        </>;
      case "Compte":
        return <>
          {info("Identifiants", "L’e-mail, le nom d’utilisateur ou le numéro de téléphone permettent de se connecter avec le même mot de passe.")}
          <View style={styles.settingRow}><View><Text style={styles.secondary}>Nom d’utilisateur</Text><Text style={styles.rowTitle}>{user.username}</Text></View></View>
          <View style={styles.settingRow}><View><Text style={styles.secondary}>E-mail</Text><Text style={styles.rowTitle}>{user.email || "Non renseigné"}</Text></View></View>
          <View style={styles.settingRow}><View><Text style={styles.secondary}>Téléphone</Text><Text style={styles.rowTitle}>{user.phone || "Non renseigné"}</Text></View></View>
          {action("Réinitialiser le mot de passe", () => router.push("/forgot-password" as any), "lock-closed-outline")}
          <View style={styles.personalLink}>
            <Text style={styles.rowTitle}>Mon lien personnel SPILOVEURE</Text>
            <Text style={styles.handle}>SPV@{user.username}</Text>
            <Text selectable style={styles.link}>{personalLink}</Text>
            <View style={styles.linkActions}>
              <TouchableOpacity onPress={() => void copyPersonalLink()} style={styles.linkButton}><Ionicons name={linkCopied ? "checkmark-circle" : "copy-outline"} size={16} color={blue} /><Text style={styles.actionText}>{linkCopied ? "Copié" : "Copier"}</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => void sharePersonalLink()} style={styles.linkButton}><Ionicons name="share-social-outline" size={16} color={blue} /><Text style={styles.actionText}>Partager</Text></TouchableOpacity>
            </View>
          </View>
          {info("Changer de numéro", "La vérification nécessaire pour remplacer le numéro de connexion n’est pas encore disponible.")}
        </>;
      case "Confidentialité":
        return <>
          {settingsLoading ? <ActivityIndicator color={blue} /> : <>
            {switchRow("Afficher ma présence", "Autoriser les membres à voir quand vous êtes en ligne.", "show_presence")}
            {switchRow("Demandes de contact", "Autoriser les membres à vous ajouter.", "allow_contacts")}
            {choiceRow("Délai par défaut des nouveaux messages", [
              { value: 0, label: "Désactivé" }, { value: 86400, label: "24 h" },
              { value: 604800, label: "7 jours" }, { value: 7776000, label: "90 jours" },
            ], "default_disappearing_seconds")}
          </>}
          {action("Voir les contacts bloqués", onOpenContacts, "ban-outline")}
          {info("Messages éphémères", "Le délai par défaut s’applique aux futurs messages des nouvelles discussions. Il ne supprime pas l’historique déjà envoyé.")}
        </>;
      case "Listes":
        return <>
          <ChatListsManager mode="lists" />
          {action("Gérer mes contacts", onOpenContacts, "people-outline")}
          {info("Groupes", "La gestion des groupes reste séparée des listes et n’est pas encore disponible dans le Chat.")}
        </>;
      case "Discussions":
        return <>
          {action("Ouvrir mes discussions", onOpenChats, "chatbubbles-outline")}
          {action("Exporter l’historique", () => void exportHistory(), "download-outline")}
          {info("Export local", "L’export crée une copie lisible des messages privés et de leurs métadonnées. Les fichiers protégés ne sont pas inclus.")}
        </>;
      case "Apparence":
        return <>
          {choiceRow("Thème du Chat", [{ value: "light", label: "Clair" }, { value: "dark", label: "Sombre" }], "appearance")}
          {choiceRow("Couleur des messages envoyés", [{ value: "blue", label: "Bleu" }, { value: "green", label: "Vert" }, { value: "gold", label: "Doré" }], "message_color")}
          {info("Application", "Ces réglages s’appliquent à l’interface du Chat et aux bulles de conversation sur cet appareil.")}
        </>;
      case "Diffusions":
        return <>
          <ChatListsManager mode="broadcasts" />
          {info("Envoi individuel", "Chaque contact reçoit son propre message privé. La diffusion demande une confirmation avant l’envoi et ne crée pas de groupe.")}
        </>;
      case "Accessibilité":
        return <>
          {choiceRow("Taille des messages", [
            { value: 0.9, label: "Petite" }, { value: 1, label: "Normale" },
            { value: 1.2, label: "Grande" }, { value: 1.4, label: "Très grande" },
          ], "font_scale")}
          {switchRow("Contraste renforcé", "Renforcer la lisibilité des bulles et du texte.", "high_contrast")}
          {switchRow("Réduire les animations", "Limiter les mouvements décoratifs du Chat.", "reduce_motion")}
          {info("Zoom et lecteur d’écran", "Le zoom global et le lecteur d’écran restent aussi contrôlés par les réglages d’accessibilité de votre navigateur ou appareil.")}
        </>;
      case "Langue de l’application":
        return <>
          {info("Langue enregistrée sur cet appareil", "Le choix est conservé. Certaines parties de SPILOVEURE Chat restent actuellement en français.")}
          {(["fr", "en"] as Lang[]).map(value => <TouchableOpacity key={value} onPress={() => void setLang(value)} accessibilityRole="radio" accessibilityState={{ selected: lang === value }} testID={`profile-language-${value}`} style={styles.settingRow}>
            <Text style={[styles.rowTitle, styles.infoCopy]}>{LANG_LABELS[value].flag}  {LANG_LABELS[value].native}</Text><Ionicons name={lang === value ? "radio-button-on" : "radio-button-off"} size={20} color={blue} />
          </TouchableOpacity>)}
        </>;
      case "Notifications":
        return <>
          <NotificationSettingsPanel userId={user.id} />
          {info("Portée Web", "Les réglages ici concernent les alertes du navigateur. Les sonneries système et les appels nécessitent l’application native et les réglages du téléphone.")}
        </>;
      case "Stockage et données":
        return <>
          {storageLoading ? <ActivityIndicator color={blue} /> : storageUsage ? <>
            <View style={styles.storageCard}>
              <Text style={styles.rowTitle}>Fichiers envoyés par votre compte</Text>
              <Text style={styles.storageAmount}>{formatBytes(storageUsage.used_bytes)}</Text>
              <Text style={styles.secondary}>{storageUsage.file_count} fichier{storageUsage.file_count === 1 ? "" : "s"} · quota quotidien d’envoi {formatBytes(storageUsage.daily_upload_limit_bytes)}</Text>
            </View>
            <TouchableOpacity onPress={() => {
              setStorageLoading(true);
              api.get<StorageUsage>("/messenger/storage").then(setStorageUsage).catch((e: any) => setError(e?.detail || "Actualisation impossible.")).finally(() => setStorageLoading(false));
            }} style={styles.refresh}><Text style={styles.actionText}>Actualiser l’utilisation</Text><Ionicons name="refresh-outline" size={18} color={blue} /></TouchableOpacity>
          </> : null}
          {switchRow("Charger les médias automatiquement", "Désactivez cette option pour ouvrir les photos et vidéos uniquement à votre demande.", "auto_load_media")}
          {info("Réseau mobile et itinérance", "Le Chat Web ne peut pas détecter de façon fiable le Wi-Fi, les données mobiles ou l’itinérance. Ce réglage contrôle uniquement le chargement automatique dans le Chat.")}
        </>;
    }
  };

  return <View style={[styles.root, settings.appearance === "dark" && { backgroundColor: "#111827" }]}>
    {section === null ? <ProfileSettingsHome
      username={user.username} photo={user.profile_photo || undefined} dark={settings.appearance === "dark"}
      onPhotoPress={() => setPhotoOpen(true)}
      onOpen={name => { if (isProfileSection(name)) { setError(""); setSection(name); } }}
    /> : <ScrollView style={styles.detail} contentContainerStyle={styles.detailContent} testID="profile-settings-detail">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => { setError(""); setSection(null); }} accessibilityRole="button" accessibilityLabel="Retour aux paramètres du profil" style={styles.back}>
          <Ionicons name="arrow-back" size={20} color={blue} />
        </TouchableOpacity>
        <Text style={styles.title}>{section}</Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {renderSection()}
    </ScrollView>}
    <ProfilePhotoManager mode="chat" visible={photoOpen} onClose={() => setPhotoOpen(false)} />
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: "#fff" },
  detail: { flex: 1, minHeight: 0, backgroundColor: "#fff", paddingHorizontal: 16, paddingTop: 17 },
  detailContent: { paddingBottom: 32 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  back: { width: 42, height: 42, borderRadius: 21, backgroundColor: "#eef4ff", alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: ink, fontSize: 20, fontWeight: "900" },
  info: { flexDirection: "row", alignItems: "flex-start", gap: 9, backgroundColor: "#f4f7fc", borderRadius: 13, padding: 13, marginVertical: 7 },
  infoCopy: { flex: 1, minWidth: 0 },
  rowTitle: { color: ink, fontSize: 14, fontWeight: "700" },
  secondary: { color: muted, fontSize: 12, lineHeight: 18, marginTop: 3 },
  settingRow: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, borderColor: "#eef1f5", paddingVertical: 9 },
  switch: { width: 40, height: 23, borderRadius: 14, backgroundColor: "#d3d9e2", padding: 3, justifyContent: "center" },
  switchOn: { backgroundColor: blue },
  knob: { width: 17, height: 17, backgroundColor: "#fff", borderRadius: 9 },
  knobOn: { alignSelf: "flex-end" },
  choiceBlock: { marginVertical: 10, gap: 8 },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  choice: { minHeight: 36, borderRadius: 18, borderWidth: 1, borderColor: "#dbe4f0", backgroundColor: "#fff", paddingHorizontal: 12, alignItems: "center", justifyContent: "center" },
  choiceActive: { backgroundColor: "#e8f0ff", borderColor: blue },
  choiceText: { color: muted, fontSize: 12, fontWeight: "700" },
  choiceTextActive: { color: blue },
  storageCard: { borderRadius: 14, padding: 14, marginVertical: 8, backgroundColor: "#f5f8ff", borderColor: "#e3ebf8", borderWidth: 1 },
  storageAmount: { color: blue, fontSize: 24, fontWeight: "900", marginTop: 5 },
  action: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderRadius: 12, paddingHorizontal: 12, backgroundColor: "#eef4ff", marginVertical: 6 },
  refresh: { minHeight: 42, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  actionText: { color: blue, fontWeight: "800", fontSize: 13 },
  actionDisabled: { color: muted },
  dangerText: { color: "#c43e48", fontWeight: "700", fontSize: 12 },
  error: { color: "#bf3e45", backgroundColor: "#fff1f0", padding: 10, borderRadius: 10, marginBottom: 8 },
  personalLink: { backgroundColor: "#f5f8ff", borderColor: "#e1eaff", borderWidth: 1, borderRadius: 14, padding: 13, marginVertical: 8 },
  handle: { color: ink, fontSize: 15, fontWeight: "900", marginTop: 5 },
  link: { color: blue, fontSize: 11, lineHeight: 17, marginTop: 3, overflowWrap: "anywhere", wordBreak: "break-word" } as any,
  linkActions: { flexDirection: "row", gap: 10, marginTop: 10 },
  linkButton: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#e8f0ff", borderRadius: 18, minHeight: 34, paddingHorizontal: 12 },
});
