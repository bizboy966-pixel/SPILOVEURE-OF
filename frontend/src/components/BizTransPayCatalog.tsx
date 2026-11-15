import React, { useState } from "react";
import { ActivityIndicator, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import { api } from "@/src/api";

type Entry = {
  country: string; country_name?: string; code: string; label: string; currency: string;
  enabled: boolean; country_enabled: boolean;
  flow: { kind?: string; otp_required?: boolean; before_submit?: boolean };
};
type Catalog = { items: Entry[]; updated_at?: string };

export default function BizTransPayCatalog() {
  const [direction, setDirection] = useState<"deposit" | "payout">("deposit");
  const [data, setData] = useState<Catalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async (next = direction) => {
    setBusy(true); setError("");
    try {
      const result = await api.get<Catalog>(`/admin/biztranspay/catalog?direction=${next}`);
      setData(result);
    } catch (e: any) {
      setError(typeof e?.detail === "string" ? e.detail : "Catalogue indisponible. Vérifiez les deux clés API et leurs autorisations.");
    } finally { setBusy(false); }
  };
  const toggle = async (cc: string, enabled: boolean, code?: string) => {
    setBusy(true); setError("");
    try {
      const path = `/admin/payment-providers/biztranspay/countries/${encodeURIComponent(cc)}`;
      await api.put(code ? `${path}/operators/${encodeURIComponent(code)}` : path, { enabled });
      setData(current => current ? { ...current, items: current.items.map(entry =>
        entry.country !== cc ? entry : code
          ? { ...entry, enabled: entry.code === code ? enabled : entry.enabled,
              country_enabled: enabled ? true : entry.country_enabled }
          : { ...entry, country_enabled: enabled, enabled }
      ) } : current);
    } catch (e: any) {
      setError(typeof e?.detail === "string" ? e.detail : "Impossible d’enregistrer ce changement.");
    } finally { setBusy(false); }
  };
  const countries = [...new Set((data?.items || []).map(entry => entry.country))].sort();

  return (
    <View style={s.box}>
      <Text style={s.title}>Catalogue officiel Mobile Money</Text>
      <Text style={s.hint}>Pays, devises, codes opérateurs et parcours fournis par Biz-transPay, séparément pour les encaissements et les retraits. Les interrupteurs locaux s’appliquent aux deux sens ; la disponibilité reste propre à chaque catalogue.</Text>
      <View style={s.row}>
        {(["deposit", "payout"] as const).map(value => (
          <TouchableOpacity key={value} disabled={busy} accessibilityRole="button"
            onPress={() => { setDirection(value); setData(null); refresh(value); }}
            style={[s.button, direction === value && s.selected]}>
            <Text style={direction === value ? s.white : s.title}>{value === "deposit" ? "Encaissements" : "Retraits"}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <TouchableOpacity disabled={busy} onPress={() => refresh()} style={s.button} accessibilityRole="button">
        <Text style={s.title}>{busy ? "Chargement…" : "Actualiser le catalogue"}</Text>
      </TouchableOpacity>
      {busy && <ActivityIndicator />}
      {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
      {data?.updated_at && <Text style={s.hint}>Actualisé : {new Date(data.updated_at).toLocaleString("fr-FR")}</Text>}
      {data && !countries.length && <Text style={s.hint}>Aucun opérateur disponible pour ce compte dans ce sens.</Text>}
      {!data && !busy && !error && <Text style={s.hint}>Enregistrez les clés puis actualisez pour charger les pays et opérateurs autorisés.</Text>}
      {countries.map(cc => {
        const entries = data!.items.filter(entry => entry.country === cc);
        return (
          <View key={cc} style={s.country}>
            <View style={s.row}>
              <Text style={[s.title, s.flex]}>{entries[0].country_name || cc} ({cc}) — {[...new Set(entries.map(entry => entry.currency))].join(", ")}</Text>
              <Switch value={entries[0].country_enabled} disabled={busy}
                accessibilityLabel={`Activer le pays ${cc}`} onValueChange={enabled => toggle(cc, enabled)} />
            </View>
            {entries.map(entry => (
              <View key={entry.code} style={s.row}>
                <View style={s.flex}>
                  <Text style={s.title}>{entry.label}</Text>
                  <Text selectable style={s.hint}>{entry.code} · {entry.flow.kind || "Mobile Money"}{entry.flow.otp_required ? " · OTP" : ""}{entry.flow.before_submit ? " · autorisation préalable" : ""}</Text>
                </View>
                <Switch value={entry.enabled} disabled={busy}
                  accessibilityLabel={`Activer ${entry.label} ${cc}`}
                  onValueChange={enabled => toggle(cc, enabled, entry.code)} />
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  box: { marginTop: 14, padding: 12, borderWidth: 1, borderColor: "#D5E3DF", borderRadius: 12, gap: 10, backgroundColor: "#F8FBF8" },
  title: { color: "#183B43", fontSize: 13, fontWeight: "700" },
  hint: { color: "#60777A", fontSize: 12, lineHeight: 18 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  flex: { flex: 1, minWidth: 120 },
  button: { padding: 10, borderRadius: 8, backgroundColor: "#EAF4EF" },
  selected: { backgroundColor: "#176B64" },
  white: { color: "#FFFFFF", fontWeight: "700" },
  error: { color: "#9B2929", fontSize: 12 },
  country: { borderTopWidth: 1, borderTopColor: "#D5E3DF", paddingTop: 10, gap: 8 },
});
