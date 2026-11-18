import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { api } from "@/src/api";
import { Card } from "@/src/components/Card";

type MoneyFusionConfig = {
  payin_enabled: boolean;
  payout_enabled: boolean;
  payin_api_configured: boolean;
  payin_api_masked: string;
  payout_key_configured: boolean;
  payout_key_masked: string;
  catalog_updated_at: string | null;
};

const palette = {
  ink: "#183B43",
  muted: "#60777A",
  line: "#D5E3DF",
  paper: "#F8FBF8",
  teal: "#176B64",
  pale: "#EAF4EF",
  alert: "#8B4B24",
  alertBg: "#FFF4E8",
};

export default function MoneyFusionSettings({
  onSaved,
  onCatalogueRefreshed,
}: {
  onSaved?: () => void;
  onCatalogueRefreshed?: () => void;
}) {
  const [config, setConfig] = useState<MoneyFusionConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [payinUrl, setPayinUrl] = useState("");
  const [payoutKey, setPayoutKey] = useState("");
  const [payinEnabled, setPayinEnabled] = useState(false);
  const [payoutEnabled, setPayoutEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const data = await api.get<MoneyFusionConfig>("/admin/payment-gateways/moneyfusion");
      setConfig(data);
      setPayinEnabled(!!data.payin_enabled);
      setPayoutEnabled(!!data.payout_enabled);
      setPayinUrl("");
      setPayoutKey("");
    } catch (e: any) {
      setLoadError(e?.detail || "Impossible de charger les réglages MoneyFusion.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const hasChanges = !!config && (
    !!payinUrl.trim()
    || !!payoutKey.trim()
    || payinEnabled !== config.payin_enabled
    || payoutEnabled !== config.payout_enabled
  );

  const save = async () => {
    setError("");
    setMessage("");
    setSaving(true);
    try {
      const body: Record<string, any> = {
        payin_enabled: payinEnabled,
        payout_enabled: payoutEnabled,
      };
      if (payinUrl.trim()) body.payin_api_url = payinUrl.trim();
      if (payoutKey.trim()) body.payout_private_key = payoutKey.trim();
      const updated = await api.put<MoneyFusionConfig>("/admin/payment-gateways/moneyfusion", body);
      setConfig(updated);
      setPayinEnabled(!!updated.payin_enabled);
      setPayoutEnabled(!!updated.payout_enabled);
      setPayinUrl("");
      setPayoutKey("");
      setMessage("Réglages enregistrés.");
      onSaved?.();
    } catch (e: any) {
      setError(e?.detail || "L’enregistrement a échoué. Vérifiez les champs et réessayez.");
    } finally {
      setSaving(false);
    }
  };

  const refreshCatalog = async () => {
    setError("");
    setMessage("");
    setRefreshing(true);
    try {
      await api.post("/admin/payment-gateways/moneyfusion/catalog/refresh");
      setMessage("Catalogue des retraits actualisé.");
      const updated = await api.get<MoneyFusionConfig>("/admin/payment-gateways/moneyfusion");
      setConfig(updated);
      onCatalogueRefreshed?.();
    } catch (e: any) {
      setError(e?.detail || "Impossible d’actualiser le catalogue MoneyFusion.");
    } finally {
      setRefreshing(false);
    }
  };

  if (!config && !loadError) {
    return <Card style={styles.loading}><ActivityIndicator color={palette.teal} /><Text style={styles.muted}>Chargement des réglages MoneyFusion…</Text></Card>;
  }
  if (!config) {
    return (
      <Card style={styles.card}>
        <Heading />
        <Text accessibilityRole="alert" style={styles.error}>{loadError}</Text>
        <ActionButton label="Réessayer" icon="refresh-outline" onPress={load} />
      </Card>
    );
  }

  return (
    <Card style={styles.card} testID="moneyfusion-settings">
      <Heading />

      {(error || message) ? (
        <View accessibilityRole={error ? "alert" : undefined} accessibilityLiveRegion="polite" style={[styles.notice, error ? styles.errorNotice : styles.successNotice]}>
          <Ionicons name={error ? "alert-circle-outline" : "checkmark-circle-outline"} size={18} color={error ? palette.alert : palette.teal} />
          <Text style={[styles.noticeText, { color: error ? palette.alert : palette.teal }]}>{error || message}</Text>
        </View>
      ) : null}

      <View style={styles.statusRow}>
        <View style={styles.statusPill}>
          <View style={[styles.dot, { backgroundColor: config.payin_enabled ? palette.teal : "#B7C4C0" }]} />
          <Text style={styles.statusText}>Pay-in {config.payin_enabled ? "actif" : "inactif"}</Text>
        </View>
        <View style={styles.statusPill}>
          <View style={[styles.dot, { backgroundColor: config.payout_enabled ? palette.teal : "#B7C4C0" }]} />
          <Text style={styles.statusText}>Retraits {config.payout_enabled ? "actifs" : "inactifs"}</Text>
        </View>
      </View>

      <FieldLabel>URL API MoneyFusion</FieldLabel>
      <TextInput
        value={payinUrl}
        onChangeText={setPayinUrl}
        placeholder={config.payin_api_configured ? `Configurée : ${config.payin_api_masked}` : "URL fournie par MoneyFusion"}
        placeholderTextColor="#819592"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.input}
        accessibilityLabel="URL API Pay-in MoneyFusion"
      />
      <SwitchRow label="Activer les dépôts" value={payinEnabled} onChange={setPayinEnabled} />

      <FieldLabel>Clé privée de retrait</FieldLabel>
      <TextInput
        value={payoutKey}
        onChangeText={setPayoutKey}
        placeholder={config.payout_key_configured ? `Configurée : ${config.payout_key_masked}` : "Clé privée fournie par MoneyFusion"}
        placeholderTextColor="#819592"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        accessibilityLabel="Clé privée MoneyFusion pour les retraits"
      />
      <SwitchRow label="Activer les retraits automatiques" value={payoutEnabled} onChange={setPayoutEnabled} />
      <Text style={styles.hint}>L’IP fixe du VPS doit être autorisée dans le compte MoneyFusion.</Text>

      <View style={styles.catalogBox}>
        <View style={{ flex: 1 }}>
          <Text style={styles.catalogTitle}>Catalogue des retraits</Text>
          <Text style={styles.hint}>{config.catalog_updated_at ? `Actualisé le ${new Date(config.catalog_updated_at).toLocaleString("fr-FR")}` : "Pas encore actualisé"}</Text>
        </View>
        <ActionButton label={refreshing ? "Actualisation…" : "Actualiser"} icon="sync-outline" onPress={refreshCatalog} disabled={refreshing} />
      </View>

      {hasChanges ? (
        <TouchableOpacity accessibilityRole="button" onPress={save} disabled={saving} style={[styles.saveButton, saving && { opacity: 0.65 }]}>
          {saving ? <ActivityIndicator color="#fff" /> : <Ionicons name="save-outline" size={18} color="#fff" />}
          <Text style={styles.saveText}>{saving ? "Enregistrement…" : "Enregistrer"}</Text>
        </TouchableOpacity>
      ) : null}
    </Card>
  );
}

function Heading() {
  return (
    <View style={styles.heading}>
      <View style={styles.mark}><Ionicons name="phone-portrait-outline" size={20} color={palette.teal} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>MoneyFusion</Text>
        <Text style={styles.subtitle}>Dépôts et retraits Mobile Money</Text>
      </View>
    </View>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

function SwitchRow({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.switchRow}>
      <Text style={styles.switchLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: "#CBD8D4", true: "#88BDB0" }} thumbColor={value ? palette.teal : "#F8FBF8"} accessibilityLabel={label} />
    </View>
  );
}

function ActionButton({ label, icon, onPress, disabled }: { label: string; icon: any; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity accessibilityRole="button" onPress={onPress} disabled={disabled} style={[styles.actionButton, disabled && { opacity: 0.6 }]}>
      {disabled ? <ActivityIndicator color={palette.teal} size="small" /> : <Ionicons name={icon} size={16} color={palette.teal} />}
      <Text style={styles.actionText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12, padding: 16, backgroundColor: palette.paper, borderColor: palette.line, borderRadius: 18 },
  loading: { padding: 20, alignItems: "center", gap: 10, backgroundColor: palette.paper, borderColor: palette.line },
  muted: { color: palette.muted, fontSize: 13 },
  heading: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 },
  mark: { width: 42, height: 42, borderRadius: 13, backgroundColor: palette.pale, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 19, fontWeight: "900", color: palette.ink, letterSpacing: -0.3 },
  subtitle: { fontSize: 12, color: palette.muted, marginTop: 2 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 10 },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "#EDF3F0", paddingHorizontal: 10, paddingVertical: 7, borderRadius: 18 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 12, color: palette.ink, fontWeight: "700" },
  label: { color: palette.ink, fontSize: 12, fontWeight: "800", marginBottom: 6 },
  input: { minHeight: 44, borderWidth: 1, borderColor: palette.line, borderRadius: 10, backgroundColor: "#fff", paddingHorizontal: 12, color: palette.ink, fontSize: 13, marginBottom: 12 },
  hint: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#E7EFEC" },
  switchLabel: { color: palette.ink, fontSize: 13, fontWeight: "800" },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, borderRadius: 10, marginVertical: 8 },
  errorNotice: { backgroundColor: palette.alertBg },
  successNotice: { backgroundColor: palette.pale },
  noticeText: { flex: 1, fontSize: 12, lineHeight: 18, fontWeight: "700" },
  error: { color: "#8B332B", fontSize: 13, lineHeight: 19, marginVertical: 10 },
  catalogBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: 11, backgroundColor: "#EEF5F1", borderRadius: 12, marginTop: 13 },
  catalogTitle: { color: palette.ink, fontWeight: "800", fontSize: 12 },
  actionButton: { borderWidth: 1, borderColor: "#A7C9BF", borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#fff" },
  actionText: { color: palette.teal, fontWeight: "800", fontSize: 11 },
  saveButton: { minHeight: 48, borderRadius: 12, marginTop: 18, paddingHorizontal: 16, backgroundColor: palette.teal, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 },
  saveText: { color: "#fff", fontSize: 13, fontWeight: "900" },
});
