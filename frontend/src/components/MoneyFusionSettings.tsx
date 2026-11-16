import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";

import { api } from "@/src/api";
import { Card } from "@/src/components/Card";

type MoneyFusionConfig = {
  payin_enabled: boolean;
  payout_enabled: boolean;
  payin_local_currency_confirmed: boolean;
  mobile_money_only_confirmed: boolean;
  payout_ip_confirmed: boolean;
  payin_country_codes: string[];
  payin_api_configured: boolean;
  payin_api_masked: string;
  payout_key_configured: boolean;
  payout_key_masked: string;
  fx_rate_date: string | null;
  fx_source: string;
  catalog_updated_at: string | null;
  public_app_url: string;
  payout_ip_notice: string;
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
  const [clearPayinUrl, setClearPayinUrl] = useState(false);
  const [clearPayoutKey, setClearPayoutKey] = useState(false);
  const [payinEnabled, setPayinEnabled] = useState(false);
  const [payoutEnabled, setPayoutEnabled] = useState(false);
  const [currencyConfirmed, setCurrencyConfirmed] = useState(false);
  const [mobileMoneyOnlyConfirmed, setMobileMoneyOnlyConfirmed] = useState(false);
  const [payoutIpConfirmed, setPayoutIpConfirmed] = useState(false);
  const [payinCountryCodes, setPayinCountryCodes] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [recoveryId, setRecoveryId] = useState("");
  const [recoveryToken, setRecoveryToken] = useState("");
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryResult, setRecoveryResult] = useState("");
  const [recoveryError, setRecoveryError] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const data = await api.get<MoneyFusionConfig>("/admin/payment-gateways/moneyfusion");
      setConfig(data);
      setPayinEnabled(!!data.payin_enabled);
      setPayoutEnabled(!!data.payout_enabled);
      setCurrencyConfirmed(!!data.payin_local_currency_confirmed);
      setMobileMoneyOnlyConfirmed(!!data.mobile_money_only_confirmed);
      setPayoutIpConfirmed(!!data.payout_ip_confirmed);
      setPayinCountryCodes(Array.isArray(data.payin_country_codes) ? data.payin_country_codes.join(", ") : "");
      setPayinUrl("");
      setPayoutKey("");
      setClearPayinUrl(false);
      setClearPayoutKey(false);
    } catch (e: any) {
      setLoadError(e?.detail || "Impossible de charger les réglages MoneyFusion.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setError("");
    setMessage("");
    if (payinEnabled && (!currencyConfirmed || !mobileMoneyOnlyConfirmed)) {
      setError("Confirmez d’abord la devise locale auprès de MoneyFusion et le périmètre Mobile Money avant d’activer le Pay-in.");
      return;
    }
    const countryCodes = payinCountryCodes.split(",").map((code) => code.trim().toUpperCase()).filter(Boolean);
    if (countryCodes.some((code) => !/^[A-Z]{2}$/.test(code))) {
      setError("Saisissez les codes pays Pay-in au format ISO à deux lettres, séparés par des virgules.");
      return;
    }
    if (payinEnabled && !countryCodes.length) {
      setError("Ajoutez au moins un code pays dont la disponibilité Pay-in a été confirmée auprès de MoneyFusion.");
      return;
    }
    if (payoutEnabled && !payoutIpConfirmed) {
      setError("Confirmez l’enregistrement de l’IP serveur avant d’activer les retraits.");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, any> = {
        payin_enabled: payinEnabled,
        payout_enabled: payoutEnabled,
        payin_local_currency_confirmed: currencyConfirmed,
        mobile_money_only_confirmed: mobileMoneyOnlyConfirmed,
        payout_ip_confirmed: payoutIpConfirmed,
        payin_country_codes: countryCodes,
      };
      if (clearPayinUrl) body.payin_api_url = "DELETE";
      else if (payinUrl.trim()) body.payin_api_url = payinUrl.trim();
      if (clearPayoutKey) body.payout_private_key = "DELETE";
      else if (payoutKey.trim()) body.payout_private_key = payoutKey.trim();
      const updated = await api.put<MoneyFusionConfig>("/admin/payment-gateways/moneyfusion", body);
      setConfig(updated);
      setPayinEnabled(!!updated.payin_enabled);
      setPayoutEnabled(!!updated.payout_enabled);
      setCurrencyConfirmed(!!updated.payin_local_currency_confirmed);
      setMobileMoneyOnlyConfirmed(!!updated.mobile_money_only_confirmed);
      setPayoutIpConfirmed(!!updated.payout_ip_confirmed);
      setPayinCountryCodes(Array.isArray(updated.payin_country_codes) ? updated.payin_country_codes.join(", ") : "");
      setPayinUrl("");
      setPayoutKey("");
      setClearPayinUrl(false);
      setClearPayoutKey(false);
      setMessage("Réglages MoneyFusion enregistrés.");
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
      setMessage("Catalogue officiel des retraits actualisé. Les pays et opérateurs restent à régler dans la carte Prestataires de paiement.");
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
      <Text style={styles.intro}>Contrôles distincts pour les paiements d’activation et les retraits. Un même pays + opérateur ne peut pas être actif chez plusieurs prestataires. Aucun paiement de test n’est lancé depuis ce panneau.</Text>

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

      <SectionTitle number="01" title="Encaissement · activation" />
      <FieldLabel>URL de redirection après paiement</FieldLabel>
      {config.public_app_url.trim().startsWith("https://") ? (
        <>
          <Text selectable style={styles.hint} accessibilityLabel="URL de redirection après paiement">
            {`${config.public_app_url.replace(/\/+$/, "")}/pay`}
          </Text>
          <SmallAction label="Copier l’URL de redirection" onPress={async () => {
            try {
              await Clipboard.setStringAsync(`${config.public_app_url.replace(/\/+$/, "")}/pay`);
              setError("");
              setMessage("URL de redirection copiée.");
            } catch {
              setMessage("");
              setError("Impossible de copier le lien. Sélectionnez l’URL pour la copier manuellement.");
            }
          }} />
        </>
      ) : (
        <Text style={styles.cautionText}>URL indisponible : configurez PUBLIC_APP_URL avec le domaine HTTPS public de ce serveur.</Text>
      )}
      <Text style={styles.hint}>À renseigner dans MoneyFusion comme URL de retour après paiement. Ce lien renvoie vers la page de paiement ; seule la vérification serveur confirme l’activation. Utilisez le lien du serveur de production, pas celui de l’aperçu.</Text>
      <FieldLabel>URL API Pay-in MoneyFusion</FieldLabel>
      <TextInput
        value={payinUrl}
        onChangeText={(value) => { setPayinUrl(value); setClearPayinUrl(false); }}
        placeholder={config.payin_api_configured ? `Configurée : ${config.payin_api_masked} — saisie vide = inchangée` : "https://…moneyfusion.net/…"}
        placeholderTextColor="#819592"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.input}
        accessibilityLabel="URL API Pay-in MoneyFusion"
      />
      <View style={styles.inlineActions}>
        <Text style={styles.hint}>Saisir l’URL HTTPS complète fournie par MoneyFusion, pas une clé seule. Valeur vide = URL actuelle conservée.</Text>
        {config.payin_api_configured ? <SmallAction label={clearPayinUrl ? "Suppression prévue" : "Effacer l’URL"} onPress={() => { setClearPayinUrl((v) => !v); setPayinUrl(""); }} /> : null}
      </View>
      <SwitchRow label="Pay-in activé" detail="Les membres pourront initier l’activation si un pays est également disponible." value={payinEnabled} onChange={setPayinEnabled} />
      <SwitchRow label="Devise locale confirmée auprès de MoneyFusion" detail="À cocher uniquement après confirmation explicite du marchand." value={currencyConfirmed} onChange={setCurrencyConfirmed} />
      <ConfirmRow
        label="J’ai confirmé auprès de MoneyFusion que la page de paiement hébergée de ce compte marchand propose UNIQUEMENT Mobile Money."
        value={mobileMoneyOnlyConfirmed}
        onChange={setMobileMoneyOnlyConfirmed}
      />
      <FieldLabel>Pays confirmés pour l’encaissement Pay-in</FieldLabel>
      <TextInput
        value={payinCountryCodes}
        onChangeText={setPayinCountryCodes}
        placeholder="Ex. GH, GN — uniquement après confirmation marchand"
        placeholderTextColor="#819592"
        autoCapitalize="characters"
        style={styles.input}
        accessibilityLabel="Codes pays confirmés pour le Pay-in, séparés par des virgules"
      />
      <Text style={styles.hint}>Saisie manuelle des codes ISO à deux lettres, séparés par des virgules. Ne déduisez pas la couverture Pay-in du catalogue de retrait.</Text>
      <View style={styles.caution}>
        <Ionicons name="information-circle-outline" size={18} color={palette.alert} />
        <Text style={styles.cautionText}>La disponibilité Pay-in par pays dépend aussi de la confirmation marchande et des pays/opérateurs activés. Le checkout hébergé ne filtre pas l’opérateur : un pays n’est exposé que si tous ses opérateurs catalogue sont actifs. Le catalogue ci-dessous décrit les capacités de retrait, pas la couverture Pay-in.</Text>
      </View>

      <SectionTitle number="02" title="Décaissement · retraits" />
      <FieldLabel>Clé privée de retrait</FieldLabel>
      <TextInput
        value={payoutKey}
        onChangeText={(value) => { setPayoutKey(value); setClearPayoutKey(false); }}
        placeholder={config.payout_key_configured ? `Configurée : ${config.payout_key_masked} — saisie vide = inchangée` : "Saisir la clé privée MoneyFusion"}
        placeholderTextColor="#819592"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        accessibilityLabel="Clé privée MoneyFusion pour les retraits"
      />
      <View style={styles.inlineActions}>
        <Text style={styles.hint}>Secret jamais prérempli. Une valeur vide conserve la valeur actuelle.</Text>
        {config.payout_key_configured ? <SmallAction label={clearPayoutKey ? "Suppression prévue" : "Effacer la clé"} onPress={() => { setClearPayoutKey((v) => !v); setPayoutKey(""); }} /> : null}
      </View>
      <SwitchRow label="Retraits activés" detail="Le dispatch automatique concerne uniquement les retraits Mobile Money compatibles." value={payoutEnabled} onChange={setPayoutEnabled} />
      <ConfirmRow
        label="J’ai confirmé l’enregistrement de l’IP publique fixe du serveur auprès de MoneyFusion."
        value={payoutIpConfirmed}
        onChange={setPayoutIpConfirmed}
      />
      <Text style={styles.hint}>{config.payout_ip_notice || "Enregistrez l’IP publique fixe du serveur auprès de MoneyFusion."}</Text>
      <Text style={styles.hint}>URL publique déclarée : {config.public_app_url || "non configurée"} · Webhook retraits : /api/webhooks/moneyfusion/payout</Text>

      <View style={styles.recoveryBox}>
        <Text style={styles.recoveryTitle}>Vérifier un retrait déjà envoyé</Text>
        <Text style={styles.hint}>Vérifie l’état d’une soumission existante auprès de MoneyFusion. Cette action ne renvoie jamais de retrait.</Text>
        <FieldLabel>Identifiant du retrait</FieldLabel>
        <TextInput
          value={recoveryId}
          onChangeText={setRecoveryId}
          placeholder="ID du retrait"
          placeholderTextColor="#819592"
          autoCapitalize="none"
          style={styles.input}
          accessibilityLabel="Identifiant du retrait à vérifier"
        />
        <FieldLabel>Token MoneyFusion (facultatif)</FieldLabel>
        <TextInput
          value={recoveryToken}
          onChangeText={setRecoveryToken}
          placeholder="À saisir si le token n’est pas enregistré"
          placeholderTextColor="#819592"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          accessibilityLabel="Token MoneyFusion facultatif"
        />
        <ActionButton
          label={recoveryBusy ? "Vérification…" : "Vérifier l’envoi existant"}
          icon="search-outline"
          disabled={recoveryBusy || !recoveryId.trim()}
          onPress={async () => {
            setRecoveryBusy(true);
            setRecoveryResult("");
            setRecoveryError(false);
            try {
              const result = await api.post<any>(
                `/admin/payment-gateways/moneyfusion/payouts/${encodeURIComponent(recoveryId.trim())}/check`,
                recoveryToken.trim() ? { token: recoveryToken.trim() } : {},
              );
              setRecoveryResult(`Résultat MoneyFusion : ${result?.status || "reçu"}${result?.ok === false ? " — vérification non confirmée" : ""}`);
            } catch (e: any) {
              setRecoveryError(true);
              setRecoveryResult(e?.detail || "La vérification a échoué. Ne renvoyez pas le retrait.");
            } finally {
              setRecoveryBusy(false);
            }
          }}
        />
        {recoveryResult ? <Text accessibilityRole={recoveryError ? "alert" : undefined} style={[styles.recoveryResult, recoveryError && { color: palette.alert }]}>{recoveryResult}</Text> : null}
      </View>

      <SectionTitle number="03" title="Conversion automatique" />
      <Text style={styles.hint}>
        Le prix de l’activation reste fixé à 2 650 XOF. Les conversions MoneyFusion vers une autre devise sont calculées automatiquement avec un taux de référence public ; aucun taux n’est saisi manuellement.
      </Text>
      <Text style={styles.hint}>
        Source : {config.fx_source || "Frankfurter (taux de référence, non instantané)"} · Dernière référence : {config.fx_rate_date ? new Date(`${config.fx_rate_date}T00:00:00`).toLocaleDateString("fr-FR", { dateStyle: "long" }) : "chargée au premier calcul de paiement"}.
      </Text>

      <View style={styles.catalogBox}>
        <View style={{ flex: 1 }}>
          <Text style={styles.catalogTitle}>Catalogue officiel des retraits</Text>
          <Text style={styles.hint}>Actualisé : {config.catalog_updated_at ? new Date(config.catalog_updated_at).toLocaleString("fr-FR") : "jamais"}</Text>
        </View>
        <ActionButton label={refreshing ? "Actualisation…" : "Actualiser"} icon="sync-outline" onPress={refreshCatalog} disabled={refreshing} />
      </View>
      <Text style={styles.hint}>Après actualisation, réglez les pays et opérateurs dans la carte Prestataires ci-dessous. Ces réglages gouvernent les retraits ; ils ne prouvent pas qu’un pays peut recevoir un paiement d’activation.</Text>

      <TouchableOpacity accessibilityRole="button" onPress={save} disabled={saving} style={[styles.saveButton, saving && { opacity: 0.65 }]}>
        {saving ? <ActivityIndicator color="#fff" /> : <Ionicons name="save-outline" size={18} color="#fff" />}
        <Text style={styles.saveText}>{saving ? "Enregistrement…" : "Enregistrer les réglages"}</Text>
      </TouchableOpacity>
    </Card>
  );
}

function Heading() {
  return (
    <View style={styles.heading}>
      <View style={styles.mark}><Ionicons name="phone-portrait-outline" size={20} color={palette.teal} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>MoneyFusion</Text>
        <Text style={styles.subtitle}>Mobile Money · contrôles marchand</Text>
      </View>
    </View>
  );
}

function SectionTitle({ number, title }: { number: string; title: string }) {
  return <View style={styles.sectionTitle}><Text style={styles.sectionNumber}>{number}</Text><Text style={styles.sectionText}>{title}</Text></View>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

function SwitchRow({ label, detail, value, onChange }: { label: string; detail: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.switchRow}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={styles.switchLabel}>{label}</Text>
        <Text style={styles.hint}>{detail}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: "#CBD8D4", true: "#88BDB0" }} thumbColor={value ? palette.teal : "#F8FBF8"} accessibilityLabel={label} />
    </View>
  );
}

function ConfirmRow({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={styles.confirmRow}>
      <View style={[styles.checkbox, value && styles.checkboxOn]}>{value ? <Ionicons name="checkmark" size={14} color="#fff" /> : null}</View>
      <Text style={styles.confirmText}>{label}</Text>
    </TouchableOpacity>
  );
}

function SmallAction({ label, onPress }: { label: string; onPress: () => void }) {
  return <TouchableOpacity accessibilityRole="button" onPress={onPress}><Text style={styles.smallAction}>{label}</Text></TouchableOpacity>;
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
  intro: { color: palette.muted, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "#EDF3F0", paddingHorizontal: 10, paddingVertical: 7, borderRadius: 18 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 12, color: palette.ink, fontWeight: "700" },
  sectionTitle: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 17, marginBottom: 10, paddingTop: 13, borderTopWidth: 1, borderTopColor: palette.line },
  sectionNumber: { color: palette.teal, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  sectionText: { color: palette.ink, fontSize: 14, fontWeight: "900" },
  label: { color: palette.ink, fontSize: 12, fontWeight: "800", marginBottom: 6 },
  input: { minHeight: 44, borderWidth: 1, borderColor: palette.line, borderRadius: 10, backgroundColor: "#fff", paddingHorizontal: 12, color: palette.ink, fontSize: 13 },
  inlineActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 6 },
  hint: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 3, flexShrink: 1 },
  smallAction: { color: "#994B34", fontSize: 11, fontWeight: "800", paddingVertical: 5 },
  switchRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#E7EFEC" },
  switchLabel: { color: palette.ink, fontSize: 13, fontWeight: "800" },
  confirmRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10 },
  checkbox: { width: 21, height: 21, borderRadius: 6, borderWidth: 1.5, borderColor: "#9CB3AD", alignItems: "center", justifyContent: "center", backgroundColor: "#fff", marginTop: 1 },
  checkboxOn: { backgroundColor: palette.teal, borderColor: palette.teal },
  confirmText: { flex: 1, color: palette.ink, fontSize: 12, lineHeight: 18, fontWeight: "600" },
  caution: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 11, borderRadius: 11, backgroundColor: palette.alertBg, marginTop: 7 },
  cautionText: { flex: 1, color: palette.alert, fontSize: 11, lineHeight: 16 },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, borderRadius: 10, marginVertical: 8 },
  errorNotice: { backgroundColor: palette.alertBg },
  successNotice: { backgroundColor: palette.pale },
  noticeText: { flex: 1, fontSize: 12, lineHeight: 18, fontWeight: "700" },
  error: { color: "#8B332B", fontSize: 13, lineHeight: 19, marginVertical: 10 },
  catalogBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: 11, backgroundColor: "#EEF5F1", borderRadius: 12, marginTop: 13 },
  catalogTitle: { color: palette.ink, fontWeight: "800", fontSize: 12 },
  recoveryBox: { padding: 12, borderRadius: 12, backgroundColor: "#F0F5F2", marginTop: 14, gap: 7 },
  recoveryTitle: { color: palette.ink, fontSize: 13, fontWeight: "900" },
  recoveryResult: { color: palette.teal, fontSize: 12, lineHeight: 18, fontWeight: "700", marginTop: 5 },
  actionButton: { borderWidth: 1, borderColor: "#A7C9BF", borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#fff" },
  actionText: { color: palette.teal, fontWeight: "800", fontSize: 11 },
  saveButton: { minHeight: 48, borderRadius: 12, marginTop: 18, paddingHorizontal: 16, backgroundColor: palette.teal, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 },
  saveText: { color: "#fff", fontSize: 13, fontWeight: "900" },
});
