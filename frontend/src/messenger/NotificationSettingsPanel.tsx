import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { setupWebPush, currentPermission, isWebPushConfigured } from "@/src/lib/firebase";
import { requestChatNotificationPermission } from "./browserNotificationPermission";
import {
  getCustomNotificationSound,
  playNotificationSound,
  prepareNotificationSound,
  removeCustomNotificationSound,
  storeCustomNotificationSound,
  unlockNotificationAudio,
  type NotificationSoundSettings,
} from "./notificationSound";

type Props = { userId: string; conversationId?: string };
type Settings = NotificationSoundSettings & { custom_name?: string };
const defaults: Settings = { enabled: true, sound_enabled: true, preview: true, sound: "default", inherit: true };
const blue = "#1769e8", ink = "#102042", muted = "#7d879a";
const SOUND_OPTIONS: Array<{ value: Settings["sound"]; label: string }> = [
  { value: "default", label: "Par défaut" }, { value: "chime", label: "Carillon" },
  { value: "bell", label: "Cloche" }, { value: "custom", label: "Personnalisé" },
];

function errorText(error: any, fallback: string): string {
  return error?.detail || error?.message || fallback;
}

export default function NotificationSettingsPanel({ userId, conversationId }: Props) {
  const isConversation = !!conversationId;
  const scope = conversationId || "global";
  const endpoint = useMemo(() => isConversation
    ? `/messenger/conversations/${encodeURIComponent(conversationId!)}/notification-settings`
    : "/messenger/notification-settings", [conversationId, isConversation]);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => ({ ...defaults, inherit: isConversation }));
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [pushConfigured, setPushConfigured] = useState<boolean | null>(null);
  const [customAvailable, setCustomAvailable] = useState(false);
  const [customName, setCustomName] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [testing, setTesting] = useState(false);

  const controlsDisabled = isConversation && settings.inherit === true;
  const effectiveSettings = useMemo(() => settings, [settings]);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const loaded = await api.get<Settings>(endpoint);
      setSettings({ ...defaults, ...loaded, inherit: isConversation ? loaded.inherit !== false : undefined });
      setLoaded(true);
    } catch (e: any) {
      setError(errorText(e, "Impossible de charger les notifications."));
    } finally {
      setLoading(false);
    }
  };

  const loadCapabilities = async () => {
    setPermission(currentPermission());
    try {
      const capabilities = await api.get<{ push_configured?: boolean }>("/messenger/capabilities");
      setPushConfigured(!!capabilities.push_configured);
    } catch {
      setPushConfigured(null);
    }
  };

  const checkCustom = async () => {
    try {
      const custom = await getCustomNotificationSound(userId, scope);
      setCustomAvailable(!!custom);
      setCustomName(custom?.name || "");
    } catch {
      setCustomAvailable(false);
      setCustomName("");
    }
  };

  useEffect(() => {
    void load();
    void loadCapabilities();
    void checkCustom();
  }, [endpoint, userId, scope]);

  const change = (patch: Partial<Settings>) => {
    setSettings(current => ({ ...current, ...patch }));
    setError("");
    setNotice("");
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (!loaded) throw new Error("Chargez les paramètres avant de les modifier.");
      if (settings.sound === "custom" && !controlsDisabled && !(await getCustomNotificationSound(userId, scope))) {
        throw new Error("Importez le son personnalisé sur cet appareil avant d’enregistrer.");
      }
      const payload = settings.sound === "custom"
        ? { ...settings, custom_name: settings.custom_name || customName || undefined }
        : settings;
      const saved = await api.patch<Settings>(endpoint, payload);
      setSettings({ ...defaults, ...saved, inherit: isConversation ? saved.inherit !== false : undefined });
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("spv-notification-settings-changed"));
      setNotice("Paramètres enregistrés.");
    } catch (e: any) {
      setError(errorText(e, "Enregistrement impossible. Réessayez."));
    } finally {
      setSaving(false);
    }
  };

  const previewSound = async () => {
    setError("");
    setNotice("");
    setTesting(true);
    unlockNotificationAudio();
    try {
      const trial = { ...effectiveSettings, enabled: true, sound_enabled: true };
      await playNotificationSound(userId, scope, trial);
      setNotice("Lecture terminée.");
    } catch (e: any) {
      setError(errorText(e, "Lecture du son impossible."));
    } finally { setTesting(false); }
  };

  const importSound = () => {
    if (typeof document === "undefined") {
      setError("L’import de son personnalisé est disponible sur le Web.");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImporting(true);
      setError("");
      setNotice(file.size > 4 * 1024 * 1024 ? "Préparation d’un extrait de 4 Mo maximum…" : "Vérification du fichier audio…");
      try {
        const prepared = await prepareNotificationSound(file);
        const name = prepared.trimmed ? `${file.name.replace(/\.[^.]+$/, "").slice(0, 100)}-extrait.wav` : file.name;
        await storeCustomNotificationSound(userId, scope, prepared.blob, name);
        const next = { ...settings, sound: "custom" as const, custom_name: name.slice(0, 120) };
        setSettings(next);
        setCustomAvailable(true);
        setCustomName(name);
        setNotice(prepared.trimmed
          ? `Extrait du début de ${Math.round(prepared.duration)} s préparé automatiquement (4 Mo maximum). Enregistrez pour l’appliquer.`
          : "Son importé sur cet appareil. Enregistrez les paramètres pour les appliquer.");
      } catch (e: any) {
        setNotice("");
        setError(errorText(e, "Ce fichier audio ne peut pas être utilisé."));
      } finally { setImporting(false); }
    };
    input.click();
  };

  const enableBrowserNotifications = async () => {
    setPushBusy(true);
    setError("");
    setNotice("");
    try {
      const allowed = await requestChatNotificationPermission();
      setPermission(allowed);
      if (allowed !== "granted") {
        setError("L’autorisation n’a pas été accordée. Vous pouvez réessayer ; les bannières dans le Chat restent actives.");
        return;
      }
      if (!pushConfigured || !isWebPushConfigured()) {
        setNotice("Notifications du navigateur autorisées pour le site ouvert. Les alertes site fermé nécessitent encore la configuration du service push par l’administrateur.");
        return;
      }
      const token = await setupWebPush(() => {}, {
        registerToken: payload => api.post("/identity/chat/push-token", payload, { auth: false, credentials: "include" }),
      });
      setPermission(currentPermission());
      if (currentPermission() === "granted" && token) setNotice("Notifications du navigateur autorisées et appareil enregistré.");
      else if (currentPermission() === "granted") setError("Autorisation accordée, mais l’enregistrement push a échoué. Réessayez l’activation.");
      else setError("L’autorisation n’a pas été accordée ou les notifications Web ne sont pas disponibles.");
    } catch (e: any) {
      setError(errorText(e, "Activation des notifications impossible."));
    } finally {
      setPushBusy(false);
    }
  };

  const toggleRow = (label: string, description: string, value: boolean, onPress: () => void, testID: string, disabled = controlsDisabled) => (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={[styles.settingRow, disabled && styles.disabled]} accessibilityRole="checkbox" accessibilityState={{ checked: value, disabled }} testID={testID}>
      <View style={styles.copy}><Text style={styles.rowTitle}>{label}</Text><Text style={styles.help}>{description}</Text></View>
      <Ionicons name={value ? "checkbox" : "square-outline"} size={21} color={value ? blue : muted} />
    </TouchableOpacity>
  );

  return <View style={styles.wrapper} testID={isConversation ? "messenger-conversation-notification-settings" : "messenger-global-notification-settings"}>
    <TouchableOpacity onPress={() => setOpen(value => !value)} style={styles.collapsible} accessibilityRole="button" accessibilityState={{ expanded: open }} testID={isConversation ? "messenger-conversation-notification-settings-toggle" : "messenger-global-notification-settings-toggle"}>
      <View style={styles.headingIcon}><Ionicons name="notifications-outline" size={17} color={blue} /></View>
      <View style={styles.headingCopy}><Text style={styles.heading}>{isConversation ? "Notifications de cette discussion" : "Notifications"}</Text><Text style={styles.headingSub}>{isConversation ? "Réglages de la conversation" : "Sons et alertes du navigateur"}</Text></View>
      <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={muted} />
    </TouchableOpacity>
    {open && <View style={styles.body}>
      {loading ? <View style={styles.loading}><ActivityIndicator color={blue} /><Text style={styles.help}>Chargement des réglages…</Text></View> : <>
        {isConversation && toggleRow("Hériter des réglages généraux", "Utiliser les préférences globales de notifications.", settings.inherit !== false, () => change({ inherit: settings.inherit === false }), "messenger-notification-inherit", false)}
        {controlsDisabled && <Text style={styles.inheritNote}>Les réglages détaillés suivent vos préférences générales.</Text>}
        {toggleRow("Notifications activées", "Recevoir les alertes pour cette portée.", settings.enabled, () => change({ enabled: !settings.enabled }), "messenger-notification-enabled")}
        {toggleRow("Jouer un son", "Le son est lu lorsque SPILOVEURE Chat est ouvert.", settings.sound_enabled, () => change({ sound_enabled: !settings.sound_enabled }), "messenger-notification-sound-enabled")}
        {toggleRow("Afficher un aperçu", "Afficher un aperçu du message dans la notification.", settings.preview, () => change({ preview: !settings.preview }), "messenger-notification-preview")}

        <Text style={[styles.label, controlsDisabled && styles.faded]}>Son de notification</Text>
        <View style={[styles.soundOptions, controlsDisabled && styles.disabled]} testID="messenger-notification-sound-options">
          {SOUND_OPTIONS.map(option => <TouchableOpacity key={option.value} onPress={() => change({ sound: option.value })} disabled={controlsDisabled} style={[styles.soundOption, settings.sound === option.value && styles.soundOptionSelected]} accessibilityRole="radio" accessibilityState={{ checked: settings.sound === option.value, disabled: controlsDisabled }} testID={`messenger-notification-sound-${option.value}`}>
            <Text style={[styles.soundOptionText, settings.sound === option.value && styles.soundOptionTextSelected]}>{option.label}</Text>
          </TouchableOpacity>)}
        </View>
        {settings.sound === "custom" && <View style={styles.customBox}>
          <Text style={styles.help}>{customAvailable ? `Disponible sur cet appareil : ${customName || settings.custom_name || "son personnalisé"}` : "Ce son personnalisé n’est pas présent sur cet appareil. Importez-le à nouveau ici."}</Text>
          <Text style={styles.help}>4 Mo maximum. Au-delà, le début du son est découpé automatiquement en un extrait audio lisible.</Text>
          <TouchableOpacity onPress={importSound} disabled={controlsDisabled || importing} style={styles.secondaryButton} testID="messenger-notification-import-sound">{importing ? <ActivityIndicator size="small" color={blue} /> : <Ionicons name="attach-outline" size={17} color={blue} />}<Text style={styles.secondaryText}>{importing ? "Préparation…" : customAvailable ? "Remplacer le son" : "Importer un son"}</Text></TouchableOpacity>
          {customAvailable && <TouchableOpacity onPress={async () => {
            try {
              await removeCustomNotificationSound(userId, scope);
              setCustomAvailable(false); setCustomName("");
              change({ sound: "default", custom_name: "" });
              setNotice("Son retiré de cet appareil. Enregistrez les paramètres pour appliquer le changement.");
            } catch (e: any) { setError(errorText(e, "Suppression impossible.")); }
          }} disabled={controlsDisabled} style={styles.removeButton} testID="messenger-notification-remove-sound"><Text style={styles.removeText}>Retirer le son de cet appareil</Text></TouchableOpacity>}
        </View>}
        <Text style={styles.disclaimer}>Un son personnalisé fonctionne uniquement lorsque le site est ouvert. Le test joue jusqu’à 6 secondes. Le son système du téléphone est géré par le navigateur et le système, il n’est pas sélectionnable ici. Un son importé reste sur cet appareil.</Text>

        <TouchableOpacity onPress={previewSound} disabled={controlsDisabled || testing || importing} style={[styles.secondaryButton, styles.testButton, controlsDisabled && styles.disabled]} testID="messenger-notification-test-sound">{testing ? <ActivityIndicator size="small" color={blue} /> : <Ionicons name="play-outline" size={17} color={blue} />}<Text style={styles.secondaryText}>{testing ? "Lecture…" : "Tester le son"}</Text></TouchableOpacity>

        <View style={styles.pushBox}>
          <Text style={styles.rowTitle}>Notifications du navigateur</Text>
          <Text style={styles.help}>Autorisation : {permission === "granted" ? "accordée" : permission === "denied" ? "refusée dans le navigateur" : permission === "default" ? "non demandée" : "non prise en charge"}.</Text>
          <Text style={styles.help}>{pushConfigured === null ? "État du service push indisponible." : pushConfigured && isWebPushConfigured() ? "Le service push est configuré. La réception dépend aussi des autorisations du navigateur." : "Les bannières fonctionnent site ouvert. La configuration des notifications site fermé reste à compléter."}</Text>
          {<TouchableOpacity onPress={enableBrowserNotifications} disabled={pushBusy} style={styles.secondaryButton} testID="messenger-notification-enable-browser">
            {pushBusy ? <ActivityIndicator size="small" color={blue} /> : <Ionicons name="notifications-outline" size={17} color={blue} />}
            <Text style={styles.secondaryText}>{pushBusy ? "Activation…" : permission === "granted" ? "Réenregistrer cet appareil" : "Activer les notifications du navigateur"}</Text>
          </TouchableOpacity>}
        </View>
        <TouchableOpacity onPress={() => {
          if (typeof window !== "undefined") window.open(`${window.location.origin}/messenger`, "_blank", "noopener,noreferrer");
        }} style={styles.secondaryButton} testID="messenger-notification-open-tab"><Ionicons name="open-outline" size={17} color={blue} /><Text style={styles.secondaryText}>Ouvrir le Chat dans un nouvel onglet</Text></TouchableOpacity>
        {error ? <Text accessibilityRole="alert" style={styles.error} testID="messenger-notification-error">{error}</Text> : null}
        {notice ? <Text style={styles.success} testID="messenger-notification-notice">{notice}</Text> : null}
        {!loaded && <TouchableOpacity onPress={load} style={styles.secondaryButton}><Text style={styles.secondaryText}>Réessayer le chargement</Text></TouchableOpacity>}
        <TouchableOpacity onPress={save} disabled={saving || !loaded || importing} style={[styles.saveButton, (saving || !loaded || importing) && styles.disabled]} testID="messenger-notification-save">
          {saving ? <ActivityIndicator size="small" color="#fff" /> : null}<Text style={styles.saveText}>{saving ? "Enregistrement…" : "Enregistrer"}</Text>
        </TouchableOpacity>
      </>}
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  wrapper: { borderWidth: 1, borderColor: "#e8edf4", borderRadius: 13, backgroundColor: "#fff", marginVertical: 8, overflow: "hidden" },
  collapsible: { minHeight: 58, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 10 },
  headingIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#edf4ff", alignItems: "center", justifyContent: "center" },
  headingCopy: { flex: 1 }, heading: { color: ink, fontWeight: "800", fontSize: 13 }, headingSub: { color: muted, fontSize: 11, marginTop: 2 },
  body: { paddingHorizontal: 12, paddingBottom: 12, borderTopWidth: 1, borderColor: "#edf0f4" },
  loading: { minHeight: 80, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  settingRow: { minHeight: 55, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: 1, borderColor: "#eef1f5", paddingVertical: 7 },
  copy: { flex: 1 }, rowTitle: { color: ink, fontSize: 12, fontWeight: "800" }, help: { color: muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  disabled: { opacity: .45 }, inheritNote: { color: blue, fontSize: 11, lineHeight: 16, backgroundColor: "#f2f6fd", borderRadius: 9, padding: 9, marginTop: 9 },
  label: { color: ink, fontSize: 12, fontWeight: "800", marginTop: 13, marginBottom: 7 }, faded: { opacity: .5 },
  soundOptions: { flexDirection: "row", flexWrap: "wrap", gap: 6 }, soundOption: { minHeight: 34, borderRadius: 18, paddingHorizontal: 11, justifyContent: "center", borderWidth: 1, borderColor: "#e2e7ef", backgroundColor: "#fafbfc" },
  soundOptionSelected: { backgroundColor: "#edf4ff", borderColor: "#b8d0ff" }, soundOptionText: { color: muted, fontSize: 11, fontWeight: "700" }, soundOptionTextSelected: { color: blue },
  customBox: { backgroundColor: "#f7f9fc", borderRadius: 10, padding: 10, marginTop: 9 },
  secondaryButton: { minHeight: 36, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderRadius: 18, backgroundColor: "#edf4ff", marginTop: 8 },
  secondaryText: { color: blue, fontSize: 11, fontWeight: "800" }, removeButton: { alignSelf: "flex-start", paddingVertical: 7 }, removeText: { color: "#bf3e45", fontSize: 11, fontWeight: "700" },
  disclaimer: { color: muted, fontSize: 10, lineHeight: 15, marginTop: 10 }, testButton: { marginTop: 11 }, pushBox: { backgroundColor: "#f7f9fc", borderRadius: 10, padding: 10, marginTop: 13 },
  error: { color: "#bf3e45", fontSize: 11, lineHeight: 16, marginTop: 9 }, success: { color: "#16805f", fontSize: 11, lineHeight: 16, marginTop: 9 },
  saveButton: { minHeight: 39, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 7, backgroundColor: blue, borderRadius: 20, marginTop: 12 },
  saveText: { color: "#fff", fontWeight: "800", fontSize: 12 },
});
