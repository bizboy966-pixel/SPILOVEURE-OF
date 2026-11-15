import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { setupWebPush, currentPermission, isWebPushConfigured } from "@/src/lib/firebase";
import { chatNotificationAvailability, requestChatNotificationPermission } from "./browserNotificationPermission";
import {
  BUILT_IN_NOTIFICATION_SOUNDS,
  getCustomNotificationSound,
  playNotificationSound,
  prepareNotificationSound,
  removeCustomNotificationSound,
  storeCustomNotificationSound,
  unlockNotificationAudio,
  type NotificationSoundSettings,
} from "./notificationSound";
import { useI18n } from "@/src/i18n";

type Props = { userId: string; conversationId?: string };
type Settings = NotificationSoundSettings & { custom_name?: string };
const defaults: Settings = { enabled: true, sound_enabled: true, preview: true, sound: "default", inherit: true };
const blue = "#1769e8", ink = "#102042", muted = "#7d879a";
const SOUND_LABEL_KEYS: Record<Settings["sound"], string> = {
  default: "chat.notifications.sound_default",
  chime: "chat.notifications.sound_chime",
  bell: "chat.notifications.sound_bell",
  soft: "chat.notifications.sound_soft",
  bright: "chat.notifications.sound_bright",
  bubble: "chat.notifications.sound_bubble",
  pulse: "chat.notifications.sound_pulse",
  marimba: "chat.notifications.sound_marimba",
  custom: "chat.notifications.sound_custom",
};

function errorText(error: any, fallback: string): string {
  return error?.detail || error?.message || fallback;
}

export default function NotificationSettingsPanel({ userId, conversationId }: Props) {
  const { t } = useI18n();
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
  const [playingSound, setPlayingSound] = useState<Settings["sound"] | null>(null);
  const notificationAvailability = chatNotificationAvailability();

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
  useEffect(() => {
    if (typeof window === "undefined") return;
    const updatePermission = () => setPermission(currentPermission());
    window.addEventListener("focus", updatePermission);
    document.addEventListener("visibilitychange", updatePermission);
    return () => {
      window.removeEventListener("focus", updatePermission);
      document.removeEventListener("visibilitychange", updatePermission);
    };
  }, []);

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
      setNotice(t("chat.notifications.saved"));
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

  const chooseSound = async (sound: Settings["sound"]) => {
    if (sound === "custom") {
      if (!customAvailable) {
        importSound();
        return;
      }
      const trial = { ...effectiveSettings, sound, enabled: true, sound_enabled: true };
      setPlayingSound(sound);
      setError("");
      try {
        unlockNotificationAudio();
        await playNotificationSound(userId, scope, trial);
        const saved = await api.patch<Settings>(endpoint, { sound });
        setSettings(current => ({ ...current, sound: saved.sound, custom_name: saved.custom_name || current.custom_name }));
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("spv-notification-settings-changed"));
        setNotice(t("chat.notifications.sound_selected"));
      } catch (e: any) { setError(errorText(e, "Lecture du son impossible.")); }
      finally { setPlayingSound(null); }
      return;
    }
    setPlayingSound(sound);
    setError("");
    setNotice("");
    try {
      unlockNotificationAudio();
      await playNotificationSound(userId, scope, {
        ...effectiveSettings, sound, enabled: true, sound_enabled: true,
      });
      const saved = await api.patch<Settings>(endpoint, { sound });
      setSettings(current => ({ ...current, sound: saved.sound, inherit: isConversation ? saved.inherit !== false : undefined }));
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("spv-notification-settings-changed"));
      setNotice(t("chat.notifications.sound_selected"));
    } catch (e: any) {
      setError(errorText(e, "Lecture du son impossible."));
    } finally { setPlayingSound(null); }
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
      const availability = chatNotificationAvailability();
      if (!availability.canRequest) { setNotice(availability.message); return; }
      const allowed = await requestChatNotificationPermission();
      setPermission(allowed);
      if (allowed !== "granted") {
        setNotice(allowed === "denied"
          ? chatNotificationAvailability().message
          : "La demande a été fermée sans autorisation. Cliquez à nouveau sur « Activer », puis choisissez « Autoriser » dans le navigateur. Les bannières dans le Chat restent actives.");
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
      else setNotice(chatNotificationAvailability().message);
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
      <View style={styles.headingCopy}><Text style={styles.heading}>{isConversation ? t("chat.notifications.heading_conversation") : t("chat.notifications.heading")}</Text><Text style={styles.headingSub}>{isConversation ? t("chat.notifications.subtitle_conversation") : t("chat.notifications.subtitle")}</Text></View>
      <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={muted} />
    </TouchableOpacity>
    {open && <View style={styles.body}>
      {loading ? <View style={styles.loading}><ActivityIndicator color={blue} /><Text style={styles.help}>{t("chat.notifications.loading")}</Text></View> : <>
        {isConversation && toggleRow(t("chat.notifications.inherit"), t("chat.notifications.inherit_desc"), settings.inherit !== false, () => change({ inherit: settings.inherit === false }), "messenger-notification-inherit", false)}
        {controlsDisabled && <Text style={styles.inheritNote}>{t("chat.notifications.inherited_note")}</Text>}
        {toggleRow(t("chat.notifications.enabled"), t("chat.notifications.enabled_desc"), settings.enabled, () => change({ enabled: !settings.enabled }), "messenger-notification-enabled")}
        {toggleRow(t("chat.notifications.play_sound"), t("chat.notifications.play_sound_desc"), settings.sound_enabled, () => change({ sound_enabled: !settings.sound_enabled }), "messenger-notification-sound-enabled")}
        {toggleRow(t("chat.notifications.preview"), t("chat.notifications.preview_desc"), settings.preview, () => change({ preview: !settings.preview }), "messenger-notification-preview")}

        <Text style={[styles.label, controlsDisabled && styles.faded]}>{t("chat.notifications.sound")}</Text>
        <View style={[styles.soundList, controlsDisabled && styles.disabled]} testID="messenger-notification-sound-options">
          {BUILT_IN_NOTIFICATION_SOUNDS.map(sound => <TouchableOpacity
            key={sound}
            onPress={() => void chooseSound(sound)}
            disabled={controlsDisabled || !!playingSound || importing}
            style={styles.soundRow}
            accessibilityRole="radio"
            accessibilityState={{ checked: settings.sound === sound, disabled: controlsDisabled || !!playingSound }}
            testID={`messenger-notification-sound-${sound}`}
          >
            <View style={styles.soundName}>
              {playingSound === sound ? <ActivityIndicator size="small" color={blue} /> : <Ionicons name="play-circle-outline" size={22} color={blue} />}
              <Text style={styles.soundRowText}>{t(SOUND_LABEL_KEYS[sound])}</Text>
            </View>
            <Ionicons name={settings.sound === sound ? "radio-button-on" : "radio-button-off"} size={21} color={settings.sound === sound ? "#20b879" : "#96a0ae"} />
          </TouchableOpacity>)}
          <TouchableOpacity
            onPress={() => void chooseSound("custom")}
            disabled={controlsDisabled || !!playingSound || importing}
            style={styles.soundRow}
            accessibilityRole="radio"
            accessibilityState={{ checked: settings.sound === "custom", disabled: controlsDisabled }}
            testID="messenger-notification-sound-custom"
          >
            <View style={styles.soundName}>
              {playingSound === "custom" ? <ActivityIndicator size="small" color={blue} /> : <Ionicons name="play-circle-outline" size={22} color={blue} />}
              <Text style={styles.soundRowText}>{t(SOUND_LABEL_KEYS.custom)}</Text>
            </View>
            <Ionicons name={settings.sound === "custom" ? "radio-button-on" : "radio-button-off"} size={21} color={settings.sound === "custom" ? "#20b879" : "#96a0ae"} />
          </TouchableOpacity>
        </View>
        <Text style={styles.disclaimer}>{t("chat.notifications.sound_web_note")}</Text>
        {settings.sound === "custom" && <View style={styles.customBox}>
          <Text style={styles.help}>{customAvailable ? t("chat.notifications.custom_available", { name: customName || settings.custom_name || t("chat.notifications.sound_custom") }) : t("chat.notifications.custom_missing")}</Text>
          <Text style={styles.help}>{t("chat.notifications.custom_limit")}</Text>
          <TouchableOpacity onPress={importSound} disabled={controlsDisabled || importing} style={styles.secondaryButton} testID="messenger-notification-import-sound">{importing ? <ActivityIndicator size="small" color={blue} /> : <Ionicons name="attach-outline" size={17} color={blue} />}<Text style={styles.secondaryText}>{importing ? t("chat.notifications.custom_prepare") : customAvailable ? t("chat.notifications.custom_replace") : t("chat.notifications.custom_import")}</Text></TouchableOpacity>
          {customAvailable && <TouchableOpacity onPress={async () => {
            try {
              await removeCustomNotificationSound(userId, scope);
              setCustomAvailable(false); setCustomName("");
              change({ sound: "default", custom_name: "" });
              setNotice("Son retiré de cet appareil. Enregistrez les paramètres pour appliquer le changement.");
            } catch (e: any) { setError(errorText(e, "Suppression impossible.")); }
          }} disabled={controlsDisabled} style={styles.removeButton} testID="messenger-notification-remove-sound"><Text style={styles.removeText}>{t("chat.notifications.custom_remove")}</Text></TouchableOpacity>}
        </View>}
        <TouchableOpacity onPress={previewSound} disabled={controlsDisabled || testing || importing} style={[styles.secondaryButton, styles.testButton, controlsDisabled && styles.disabled]} testID="messenger-notification-test-sound">{testing ? <ActivityIndicator size="small" color={blue} /> : <Ionicons name="play-outline" size={17} color={blue} />}<Text style={styles.secondaryText}>{testing ? t("chat.notifications.testing") : t("chat.notifications.test")}</Text></TouchableOpacity>

        <View style={styles.pushBox}>
          <Text style={styles.rowTitle}>Notifications du navigateur</Text>
          <Text style={styles.help}>Autorisation : {permission === "granted" ? "accordée" : permission === "denied" ? "refusée dans le navigateur" : permission === "default" ? "non demandée" : "non prise en charge"}.</Text>
          <Text style={styles.help} testID="messenger-notification-availability">{notificationAvailability.message}</Text>
          <Text style={styles.help}>{pushConfigured === null ? "État du service push indisponible." : pushConfigured && isWebPushConfigured() ? "Le service push est configuré. La réception dépend aussi des autorisations du navigateur." : "Les bannières fonctionnent site ouvert. La configuration des notifications site fermé reste à compléter."}</Text>
          {<TouchableOpacity onPress={enableBrowserNotifications} disabled={pushBusy || !notificationAvailability.canRequest} style={[styles.secondaryButton, !notificationAvailability.canRequest && styles.disabled]} testID="messenger-notification-enable-browser">
            {pushBusy ? <ActivityIndicator size="small" color={blue} /> : <Ionicons name="notifications-outline" size={17} color={blue} />}
            <Text style={[styles.secondaryText, { flexShrink: 1 }]}>{pushBusy ? "Activation…" : notificationAvailability.action}</Text>
          </TouchableOpacity>}
        </View>
        <TouchableOpacity onPress={() => {
          if (typeof window !== "undefined") window.open(`${window.location.origin}/messenger`, "_blank", "noopener,noreferrer");
        }} style={styles.secondaryButton} testID="messenger-notification-open-tab"><Ionicons name="open-outline" size={17} color={blue} /><Text style={styles.secondaryText}>{t("chat.notifications.open_tab")}</Text></TouchableOpacity>
        {error ? <Text accessibilityRole="alert" style={styles.error} testID="messenger-notification-error">{error}</Text> : null}
        {notice ? <Text style={styles.success} testID="messenger-notification-notice">{notice}</Text> : null}
        {!loaded && <TouchableOpacity onPress={load} style={styles.secondaryButton}><Text style={styles.secondaryText}>{t("chat.notifications.retry")}</Text></TouchableOpacity>}
        <TouchableOpacity onPress={save} disabled={saving || !loaded || importing} style={[styles.saveButton, (saving || !loaded || importing) && styles.disabled]} testID="messenger-notification-save">
          {saving ? <ActivityIndicator size="small" color="#fff" /> : null}<Text style={styles.saveText}>{saving ? t("chat.notifications.saving") : t("chat.notifications.save")}</Text>
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
  soundList: { borderTopWidth: 1, borderColor: "#edf0f4" },
  soundRow: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderColor: "#edf0f4", paddingHorizontal: 4 },
  soundName: { flexDirection: "row", alignItems: "center", gap: 10 },
  soundRowText: { color: ink, fontSize: 13, fontWeight: "600" },
  customBox: { backgroundColor: "#f7f9fc", borderRadius: 10, padding: 10, marginTop: 9 },
  secondaryButton: { minHeight: 36, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderRadius: 18, backgroundColor: "#edf4ff", marginTop: 8 },
  secondaryText: { color: blue, fontSize: 11, fontWeight: "800" }, removeButton: { alignSelf: "flex-start", paddingVertical: 7 }, removeText: { color: "#bf3e45", fontSize: 11, fontWeight: "700" },
  disclaimer: { color: muted, fontSize: 10, lineHeight: 15, marginTop: 10 }, testButton: { marginTop: 11 }, pushBox: { backgroundColor: "#f7f9fc", borderRadius: 10, padding: 10, marginTop: 13 },
  error: { color: "#bf3e45", fontSize: 11, lineHeight: 16, marginTop: 9 }, success: { color: "#16805f", fontSize: 11, lineHeight: 16, marginTop: 9 },
  saveButton: { minHeight: 39, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 7, backgroundColor: blue, borderRadius: 20, marginTop: 12 },
  saveText: { color: "#fff", fontWeight: "800", fontSize: 12 },
});
