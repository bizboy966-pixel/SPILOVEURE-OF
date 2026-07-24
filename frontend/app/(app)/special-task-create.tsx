import React, { useEffect, useState } from "react";
import { ActivityIndicator, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme";
import { api } from "../../src/api";

type ActionType = "video" | "subscribe" | "share" | "like" | "comment" | "group";
type Cfg = { enabled: boolean; price_per_action: number; reward_per_action: number; min_qty: number; max_qty: number };

const COUNTRIES = [
  { code: "TG", label: "🇹🇬 Togo" }, { code: "BJ", label: "🇧🇯 Bénin" },
  { code: "CI", label: "🇨🇮 Côte d'Ivoire" }, { code: "SN", label: "🇸🇳 Sénégal" },
  { code: "ML", label: "🇲🇱 Mali" }, { code: "BF", label: "🇧🇫 Burkina Faso" },
  { code: "NE", label: "🇳🇪 Niger" }, { code: "CM", label: "🇨🇲 Cameroun" },
  { code: "GN", label: "🇬🇳 Guinée" }, { code: "GA", label: "🇬🇦 Gabon" },
  { code: "CD", label: "🇨🇩 RD Congo" }, { code: "CG", label: "🇨🇬 Congo" },
  { code: "HT", label: "🇭🇹 Haïti" }, { code: "FR", label: "🇫🇷 France" },
];

const TYPE_LABELS: Record<ActionType, { icon: any; title: string; hint: string }> = {
  video: { icon: "play", title: "Regarder une vidéo", hint: "Je veux que des personnes regardent ma vidéo." },
  subscribe: { icon: "person-add", title: "S'abonner", hint: "Je veux que des personnes s'abonnent à ma chaîne/page/compte." },
  share: { icon: "share-social", title: "Partager un contenu", hint: "Je veux que des personnes partagent ma vidéo ou mon contenu." },
  like: { icon: "heart", title: "Aimer une publication", hint: "Je veux que des personnes aiment mon contenu." },
  comment: { icon: "chatbubble", title: "Commenter une publication", hint: "Je veux que des personnes commentent mon post." },
  group: { icon: "people", title: "Rejoindre un groupe", hint: "Je veux que des personnes rejoignent mon groupe." },
};

const NETWORKS_STD = [
  { k: "tiktok", label: "🎵 TikTok" }, { k: "facebook", label: "📘 Facebook" },
  { k: "instagram", label: "📸 Instagram" }, { k: "youtube", label: "📺 YouTube" },
];
const NETWORKS_GROUP = [
  { k: "whatsapp", label: "🟢 WhatsApp" }, { k: "telegram", label: "✈️ Telegram" },
];

function SpecialTaskCreateInner() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [cfg, setCfg] = useState<Record<string, Cfg>>({});
  const [taskId, setTaskId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [actionType, setActionType] = useState<ActionType | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [description, setDescription] = useState("");

  const [countries, setCountries] = useState<string[]>([]);
  const [ageMin, setAgeMin] = useState("18");
  const [ageMax, setAgeMax] = useState("55");
  const [gender, setGender] = useState<"male" | "female" | "both">("both");

  const [quantity, setQuantity] = useState("100");

  useEffect(() => {
    (async () => { try { const r = await api.get<any>("/special-tasks/config"); setCfg(r.action_types || {}); } catch {} })();
  }, []);

  const nets = actionType === "group" ? NETWORKS_GROUP : NETWORKS_STD;
  const currentCfg: Cfg | null = actionType ? (cfg[actionType] || null) : null;
  const q = parseInt(quantity, 10) || 0;
  const totalPrice = currentCfg ? currentCfg.price_per_action * q : 0;

  const start = async () => {
    if (!actionType || !network || !link.trim()) { window.alert("Complétez tous les champs."); return; }
    setSaving(true);
    try {
      const r = await api.post<{ id: string }>("/special-tasks", { action_type: actionType, network, link: link.trim(), description });
      setTaskId(r.id); setStep(3);
    } catch (e: any) { window.alert(`❌ ${e?.detail || "Échec"}`); }
    finally { setSaving(false); }
  };

  const submitAudience = async () => {
    if (!taskId) return;
    if (countries.length === 0) { window.alert("Sélectionnez au moins un pays."); return; }
    setSaving(true);
    try {
      await api.put(`/special-tasks/${taskId}/audience`, { target_countries: countries, target_age_min: parseInt(ageMin, 10), target_age_max: parseInt(ageMax, 10), target_gender: gender });
      setStep(4);
    } catch (e: any) { window.alert(`❌ ${e?.detail || "Échec"}`); }
    finally { setSaving(false); }
  };

  const submitQuantity = async () => {
    if (!taskId || !currentCfg) return;
    if (q < currentCfg.min_qty || q > currentCfg.max_qty) { window.alert(`Quantité hors bornes (${currentCfg.min_qty}–${currentCfg.max_qty}).`); return; }
    setSaving(true);
    try {
      await api.put(`/special-tasks/${taskId}/quantity`, { quantity: q });
      await api.post(`/special-tasks/${taskId}/publish`);
      setStep(5);
    } catch (e: any) { window.alert(`❌ ${e?.detail || "Échec"}`); }
    finally { setSaving(false); }
  };

  const confirmPayment = async () => {
    if (!taskId) return;
    setSaving(true);
    try {
      await api.post(`/special-tasks/${taskId}/confirm-payment`);
      window.alert("✅ Paiement confirmé. Votre tâche est maintenant active !");
      router.replace("/(app)/tasks" as any);
    } catch (e: any) { window.alert(`❌ ${e?.detail || "Échec"}`); }
    finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="stc-back"><Ionicons name="arrow-back" size={22} color="#fff" /></TouchableOpacity>
        <Text style={styles.title}>🎯 Créer une tâche spéciale</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {step === 1 && (
          <View style={{ alignItems: "center", gap: 16, padding: 20 }}>
            <Ionicons name="rocket" size={72} color={theme.colors.primary} />
            <Text style={{ fontSize: 18, fontWeight: "900", color: theme.colors.textPrimary, textAlign: "center" }}>Choisissez ce que vous souhaitez obtenir. Nous vous aiderons à l'obtenir.</Text>
            <TouchableOpacity style={styles.next} onPress={() => setStep(2)} testID="stc-choose"><Text style={styles.nextT}>Choisir</Text></TouchableOpacity>
          </View>
        )}

        {step === 2 && (
          <>
            <Text style={styles.section}>Type de tâche</Text>
            {(Object.keys(TYPE_LABELS) as ActionType[]).map((k) => {
              const enabled = cfg[k]?.enabled;
              const meta = TYPE_LABELS[k];
              return (
                <TouchableOpacity key={k} disabled={!enabled} onPress={() => setActionType(k)}
                  style={[styles.card, actionType === k && styles.cardOn, !enabled && { opacity: 0.4 }]}
                  testID={`stc-type-${k}`}>
                  <Ionicons name={meta.icon} size={24} color={actionType === k ? "#fff" : theme.colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.cardT, actionType === k && { color: "#fff" }]}>{meta.title}</Text>
                    <Text style={[styles.cardS, actionType === k && { color: "#fff" }]}>{meta.hint}</Text>
                  </View>
                  {!enabled && <Text style={{ fontSize: 9, color: theme.colors.textSecondary }}>INACTIF</Text>}
                </TouchableOpacity>
              );
            })}

            {actionType && (
              <>
                <Text style={styles.section}>Réseau social</Text>
                <View style={styles.chipRow}>
                  {nets.map((n) => (
                    <TouchableOpacity key={n.k} style={[styles.chip, network === n.k && styles.chipOn]} onPress={() => setNetwork(n.k)} testID={`stc-net-${n.k}`}>
                      <Text style={[styles.chipT, network === n.k && { color: "#fff" }]}>{n.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.section}>Lien</Text>
                <TextInput style={styles.input} placeholder="https://…" value={link} onChangeText={setLink} testID="stc-link" />

                <Text style={styles.section}>Description (optionnelle)</Text>
                <TextInput style={styles.textarea} placeholder="Instructions particulières…" value={description} onChangeText={setDescription} multiline numberOfLines={3} testID="stc-desc" />

                <TouchableOpacity style={styles.next} onPress={start} disabled={saving || !network || !link.trim()} testID="stc-step2-next">
                  {saving ? <ActivityIndicator color="#fff" /> : <><Text style={styles.nextT}>Suivant</Text><Ionicons name="arrow-forward" size={16} color="#fff" /></>}
                </TouchableOpacity>
              </>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <Text style={styles.section}>Audience ciblée</Text>
            <Text style={styles.lbl}>🌍 Pays</Text>
            <View style={styles.chipRow}>
              {COUNTRIES.map((c) => {
                const on = countries.includes(c.code);
                return <TouchableOpacity key={c.code} style={[styles.chip, on && styles.chipOn]}
                  onPress={() => setCountries((v) => on ? v.filter(x => x !== c.code) : [...v, c.code])}
                  testID={`stc-country-${c.code}`}><Text style={[styles.chipT, on && { color: "#fff" }]}>{c.label}</Text></TouchableOpacity>;
              })}
            </View>
            <Text style={styles.lbl}>🎂 Âge</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}><TextInput style={styles.input} keyboardType="numeric" value={ageMin} onChangeText={setAgeMin} placeholder="Min" testID="stc-age-min" /></View>
              <View style={{ flex: 1 }}><TextInput style={styles.input} keyboardType="numeric" value={ageMax} onChangeText={setAgeMax} placeholder="Max" testID="stc-age-max" /></View>
            </View>
            <Text style={styles.lbl}>⚧ Genre</Text>
            <View style={styles.chipRow}>
              {(["male", "female", "both"] as const).map((g) => {
                const on = gender === g;
                const l = { male: "♂️ Masculin", female: "♀️ Féminin", both: "⚧ Les deux" }[g];
                return <TouchableOpacity key={g} style={[styles.chip, on && styles.chipOn]} onPress={() => setGender(g)} testID={`stc-gender-${g}`}><Text style={[styles.chipT, on && { color: "#fff" }]}>{l}</Text></TouchableOpacity>;
              })}
            </View>
            <TouchableOpacity style={styles.next} onPress={submitAudience} disabled={saving} testID="stc-step3-next">
              {saving ? <ActivityIndicator color="#fff" /> : <><Text style={styles.nextT}>Publier</Text><Ionicons name="arrow-forward" size={16} color="#fff" /></>}
            </TouchableOpacity>
          </>
        )}

        {step === 4 && currentCfg && (
          <>
            <Text style={styles.section}>Quantité & tarif</Text>
            <Text style={styles.lbl}>Nombre d'actions souhaitées (min {currentCfg.min_qty} – max {currentCfg.max_qty})</Text>
            <TextInput style={styles.input} keyboardType="numeric" value={quantity} onChangeText={setQuantity} testID="stc-quantity" />
            <View style={styles.priceBox}>
              <Text style={styles.priceL}>Prix / action</Text><Text style={styles.priceV}>{currentCfg.price_per_action} FCFA</Text>
              <Text style={styles.priceL}>Quantité</Text><Text style={styles.priceV}>{q}</Text>
              <View style={styles.sep} />
              <Text style={styles.priceL}>Total à payer</Text><Text style={styles.priceTot}>{totalPrice} FCFA</Text>
              <Text style={styles.priceL}>💡 Récompense/participant</Text><Text style={styles.priceV}>{currentCfg.reward_per_action} FCFA</Text>
            </View>
            <TouchableOpacity style={styles.next} onPress={submitQuantity} disabled={saving} testID="stc-publish">
              {saving ? <ActivityIndicator color="#fff" /> : <><Ionicons name="rocket" size={16} color="#fff" /><Text style={styles.nextT}>Publier</Text></>}
            </TouchableOpacity>
          </>
        )}

        {step === 5 && (
          <View style={{ alignItems: "center", gap: 12, padding: 20 }}>
            <Ionicons name="card" size={64} color={theme.colors.primary} />
            <Text style={styles.section}>💳 Paiement</Text>
            <Text style={styles.priceTot}>{totalPrice} FCFA</Text>
            <Text style={{ textAlign: "center", color: theme.colors.textSecondary, fontSize: 12 }}>Paiement via SoleasPay/AshtechPay. Après confirmation, la tâche est activée automatiquement (aucune validation admin requise).</Text>
            <TouchableOpacity style={styles.next} onPress={confirmPayment} disabled={saving} testID="stc-payment-confirm">
              {saving ? <ActivityIndicator color="#fff" /> : <><Ionicons name="checkmark-circle" size={16} color="#fff" /><Text style={styles.nextT}>J'ai payé — activer la tâche</Text></>}
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, backgroundColor: theme.colors.primary },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  title: { color: "#fff", fontWeight: "900", fontSize: 16, flex: 1 },
  section: { fontSize: 14, fontWeight: "900", color: theme.colors.textPrimary, marginTop: 8 },
  lbl: { fontSize: 12, fontWeight: "800", color: theme.colors.textPrimary, marginTop: 4 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, backgroundColor: theme.colors.surface, fontSize: 13 },
  textarea: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, backgroundColor: theme.colors.surface, minHeight: 80, textAlignVertical: "top" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.colors.surface },
  chipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipT: { fontSize: 12, fontWeight: "700", color: theme.colors.textPrimary },
  card: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  cardOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  cardT: { fontSize: 14, fontWeight: "800", color: theme.colors.textPrimary },
  cardS: { fontSize: 11, color: theme.colors.textSecondary },
  next: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.colors.success, padding: 12, borderRadius: 10, marginTop: 8 },
  nextT: { color: "#fff", fontWeight: "900" },
  priceBox: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, backgroundColor: theme.colors.surface, padding: 12 },
  priceL: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 4 },
  priceV: { fontSize: 14, fontWeight: "800", color: theme.colors.textPrimary },
  priceTot: { fontSize: 22, fontWeight: "900", color: theme.colors.primary },
  sep: { height: 1, backgroundColor: theme.colors.border, marginVertical: 6 },
});


import { FeatureGuard } from "@/src/components/FeatureGuard";

export default function SpecialTaskCreate() {
  return (
    <FeatureGuard featureKey="special_tasks" title="Création de tâche spéciale désactivée">
      <SpecialTaskCreateInner />
    </FeatureGuard>
  );
}
