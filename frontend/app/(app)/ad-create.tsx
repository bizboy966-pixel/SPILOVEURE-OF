import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme";
import { api } from "../../src/api";

type Pricing = {
  price_per_day: number;
  currency: string;
  available_durations: number[];
  configured: boolean;
};

type Step = 1 | 2 | 3 | 4;

// Countries — align with the rest of the app (add more if needed).
const COUNTRIES = [
  { code: "TG", label: "🇹🇬 Togo" },
  { code: "BJ", label: "🇧🇯 Bénin" },
  { code: "CI", label: "🇨🇮 Côte d'Ivoire" },
  { code: "SN", label: "🇸🇳 Sénégal" },
  { code: "ML", label: "🇲🇱 Mali" },
  { code: "BF", label: "🇧🇫 Burkina Faso" },
  { code: "NE", label: "🇳🇪 Niger" },
  { code: "CM", label: "🇨🇲 Cameroun" },
  { code: "GN", label: "🇬🇳 Guinée" },
  { code: "GA", label: "🇬🇦 Gabon" },
  { code: "CD", label: "🇨🇩 RD Congo" },
  { code: "CG", label: "🇨🇬 Congo" },
  { code: "HT", label: "🇭🇹 Haïti" },
  { code: "FR", label: "🇫🇷 France" },
];

export default function AdCreateScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [adId, setAdId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Step 1
  const [coverUrl, setCoverUrl] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [description, setDescription] = useState("");
  const [uploadingCover, setUploadingCover] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const coverInput = useRef<HTMLInputElement | null>(null);
  const videoInput = useRef<HTMLInputElement | null>(null);

  // Step 2
  const [countries, setCountries] = useState<string[]>([]);
  const [ageMin, setAgeMin] = useState("18");
  const [ageMax, setAgeMax] = useState("55");
  const [gender, setGender] = useState<"male" | "female" | "both">("both");

  // Step 3
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [duration, setDuration] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try { setPricing(await api.get<Pricing>("/ads/pricing")); } catch {}
    })();
  }, []);

  const uploadFile = async (f: File, kind: "cover" | "video") => {
    const setUploading = kind === "cover" ? setUploadingCover : setUploadingVideo;
    setUploading(true);
    try {
      const r = await api.upload<{ url: string }>("/user/uploads", f);
      if (kind === "cover") setCoverUrl(r.url); else setVideoUrl(r.url);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec de l'upload."}`);
    } finally { setUploading(false); }
  };

  const submitStep1 = async () => {
    if (!coverUrl || !videoUrl || !description.trim()) {
      if (typeof window !== "undefined") window.alert("Veuillez remplir tous les champs.");
      return;
    }
    setSaving(true);
    try {
      const r = await api.post<{ id: string }>("/ads", {
        cover_image_url: coverUrl,
        video_url: videoUrl,
        description: description.trim(),
      });
      setAdId(r.id);
      setStep(2);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    } finally { setSaving(false); }
  };

  const submitStep2 = async () => {
    if (!adId) return;
    if (countries.length === 0) {
      if (typeof window !== "undefined") window.alert("Sélectionnez au moins un pays.");
      return;
    }
    const mn = parseInt(ageMin, 10); const mx = parseInt(ageMax, 10);
    if (Number.isNaN(mn) || Number.isNaN(mx) || mx < mn) {
      if (typeof window !== "undefined") window.alert("Tranche d'âge invalide.");
      return;
    }
    setSaving(true);
    try {
      await api.put(`/ads/${adId}/audience`, {
        target_countries: countries,
        target_age_min: mn,
        target_age_max: mx,
        target_gender: gender,
      });
      setStep(3);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    } finally { setSaving(false); }
  };

  const submitStep3 = async () => {
    if (!adId || !duration) return;
    setSaving(true);
    try {
      await api.put(`/ads/${adId}/duration`, { duration_days: duration });
      await api.post(`/ads/${adId}/publish`);
      setStep(4);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    } finally { setSaving(false); }
  };

  const confirmPayment = async () => {
    if (!adId) return;
    setSaving(true);
    try {
      await api.post(`/ads/${adId}/confirm-payment`);
      if (typeof window !== "undefined") {
        window.alert("✅ Paiement confirmé. Votre publicité est en attente de validation par l'administrateur.");
      }
      router.replace("/(app)/ads" as any);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    } finally { setSaving(false); }
  };

  const totalPrice = duration && pricing ? pricing.price_per_day * duration : 0;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="adcreate-back">
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>🎥 Nouvelle vidéo publicitaire</Text>
      </View>

      <View style={styles.stepper}>
        {[1, 2, 3, 4].map((n) => (
          <View key={n} style={[styles.stepDot, step >= n ? styles.stepDotActive : null]}>
            <Text style={[styles.stepText, step >= n ? { color: "#fff" } : null]}>{n}</Text>
          </View>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {step === 1 && (
          <>
            <Text style={styles.section}>Informations de la publicité</Text>

            <Text style={styles.label}>🖼 Image de couverture</Text>
            {coverUrl ? (
              <Image source={{ uri: `${process.env.EXPO_PUBLIC_BACKEND_URL || ""}${coverUrl}` }} style={styles.preview} />
            ) : null}
            <TouchableOpacity
              style={[styles.uploadBtn, uploadingCover && { opacity: 0.5 }]}
              onPress={() => coverInput.current?.click()}
              disabled={uploadingCover}
              testID="adcreate-cover-btn"
            >
              <Ionicons name={coverUrl ? "checkmark-circle" : "image"} size={18} color="#fff" />
              <Text style={styles.uploadT}>{uploadingCover ? "Envoi…" : coverUrl ? "Remplacer" : "Importer une image"}</Text>
            </TouchableOpacity>
            {/* @ts-ignore RN Web */}
            <input ref={coverInput} type="file" accept="image/*" style={{ display: "none" }}
              onChange={(e: any) => { const f = e.target.files?.[0]; if (f) uploadFile(f, "cover"); }} />

            <Text style={styles.label}>🎥 Vidéo publicitaire</Text>
            {videoUrl ? (
              <Text style={styles.uploadInfo}>✅ Vidéo importée : {videoUrl.split("/").pop()}</Text>
            ) : null}
            <TouchableOpacity
              style={[styles.uploadBtn, uploadingVideo && { opacity: 0.5 }]}
              onPress={() => videoInput.current?.click()}
              disabled={uploadingVideo}
              testID="adcreate-video-btn"
            >
              <Ionicons name={videoUrl ? "checkmark-circle" : "videocam"} size={18} color="#fff" />
              <Text style={styles.uploadT}>{uploadingVideo ? "Envoi…" : videoUrl ? "Remplacer" : "Importer une vidéo"}</Text>
            </TouchableOpacity>
            {/* @ts-ignore RN Web */}
            <input ref={videoInput} type="file" accept="video/*" style={{ display: "none" }}
              onChange={(e: any) => { const f = e.target.files?.[0]; if (f) uploadFile(f, "video"); }} />

            <Text style={styles.label}>📝 Description</Text>
            <TextInput
              style={styles.textarea}
              placeholder="Décrivez brièvement votre publicité (ce qu'elle promeut, votre offre, un appel à l'action…)"
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={4}
              testID="adcreate-description"
            />

            <TouchableOpacity style={styles.next} onPress={submitStep1} disabled={saving} testID="adcreate-step1-next">
              {saving ? <ActivityIndicator color="#fff" /> : <><Text style={styles.nextT}>Suivant</Text><Ionicons name="arrow-forward" size={18} color="#fff" /></>}
            </TouchableOpacity>
          </>
        )}

        {step === 2 && (
          <>
            <Text style={styles.section}>Audience ciblée</Text>

            <Text style={styles.label}>🌍 Pays ciblés</Text>
            <View style={styles.chipRow}>
              {COUNTRIES.map((c) => {
                const on = countries.includes(c.code);
                return (
                  <TouchableOpacity
                    key={c.code}
                    style={[styles.chip, on && styles.chipOn]}
                    onPress={() => setCountries((v) => on ? v.filter(x => x !== c.code) : [...v, c.code])}
                    testID={`adcreate-country-${c.code}`}
                  >
                    <Text style={[styles.chipT, on && { color: "#fff" }]}>{c.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.label}>🎂 Tranche d'âge</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <TextInput style={styles.input} keyboardType="numeric" value={ageMin} onChangeText={setAgeMin} placeholder="Min (13-99)" testID="adcreate-age-min" />
              </View>
              <View style={{ flex: 1 }}>
                <TextInput style={styles.input} keyboardType="numeric" value={ageMax} onChangeText={setAgeMax} placeholder="Max (13-99)" testID="adcreate-age-max" />
              </View>
            </View>

            <Text style={styles.label}>⚧ Genre</Text>
            <View style={styles.chipRow}>
              {(["male", "female", "both"] as const).map((g) => {
                const on = gender === g;
                const labels = { male: "♂️ Masculin", female: "♀️ Féminin", both: "⚧ Les deux" };
                return (
                  <TouchableOpacity key={g} style={[styles.chip, on && styles.chipOn]} onPress={() => setGender(g)} testID={`adcreate-gender-${g}`}>
                    <Text style={[styles.chipT, on && { color: "#fff" }]}>{labels[g]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity style={styles.next} onPress={submitStep2} disabled={saving} testID="adcreate-step2-next">
              {saving ? <ActivityIndicator color="#fff" /> : <><Text style={styles.nextT}>Suivant</Text><Ionicons name="arrow-forward" size={18} color="#fff" /></>}
            </TouchableOpacity>
          </>
        )}

        {step === 3 && (
          <>
            <Text style={styles.section}>Durée & tarification</Text>
            {!pricing || !pricing.configured ? (
              <Text style={styles.warn}>⚠️ La tarification n'est pas encore configurée par l'administrateur. Réessayez plus tard.</Text>
            ) : (
              <>
                <Text style={styles.label}>⏱ Choisissez la durée de diffusion</Text>
                <View style={styles.chipRow}>
                  {pricing.available_durations.map((d) => {
                    const on = duration === d;
                    return (
                      <TouchableOpacity key={d} style={[styles.chip, on && styles.chipOn]} onPress={() => setDuration(d)} testID={`adcreate-duration-${d}`}>
                        <Text style={[styles.chipT, on && { color: "#fff" }]}>{d} jour{d > 1 ? "s" : ""}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {duration ? (
                  <View style={styles.priceBox} testID="adcreate-price-summary">
                    <Text style={styles.priceLbl}>Durée</Text>
                    <Text style={styles.priceV}>{duration} jour{duration > 1 ? "s" : ""}</Text>
                    <Text style={styles.priceLbl}>Prix par jour</Text>
                    <Text style={styles.priceV}>{pricing.price_per_day} {pricing.currency}</Text>
                    <View style={styles.priceSep} />
                    <Text style={styles.priceLbl}>Total à payer</Text>
                    <Text style={styles.priceTotal}>{totalPrice} {pricing.currency}</Text>
                  </View>
                ) : null}
                <TouchableOpacity
                  style={[styles.next, !duration && { opacity: 0.5 }]}
                  disabled={!duration || saving}
                  onPress={submitStep3}
                  testID="adcreate-publish"
                >
                  {saving ? <ActivityIndicator color="#fff" /> : <><Ionicons name="rocket" size={18} color="#fff" /><Text style={styles.nextT}>Publier</Text></>}
                </TouchableOpacity>
              </>
            )}
          </>
        )}

        {step === 4 && (
          <View style={{ alignItems: "center", padding: 20, gap: 12 }}>
            <Ionicons name="card" size={64} color={theme.colors.primary} />
            <Text style={styles.section}>💳 Paiement</Text>
            <Text style={{ textAlign: "center", color: theme.colors.textSecondary }}>
              Le paiement s'effectue via SoleasPay / AshtechPay pour un montant total de :
            </Text>
            <Text style={styles.priceTotal}>{totalPrice} FCFA</Text>
            <Text style={{ textAlign: "center", color: theme.colors.textSecondary, fontSize: 12 }}>
              Cliquez ci-dessous après avoir effectué votre paiement. Votre publicité sera soumise à validation par l'administrateur.
            </Text>
            <TouchableOpacity style={styles.next} onPress={confirmPayment} disabled={saving} testID="adcreate-payment-confirm">
              {saving ? <ActivityIndicator color="#fff" /> : <><Ionicons name="checkmark-circle" size={18} color="#fff" /><Text style={styles.nextT}>J'ai payé — soumettre pour validation</Text></>}
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingTop: 16, paddingBottom: 14,
    backgroundColor: theme.colors.primary,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center", justifyContent: "center",
  },
  title: { color: "#fff", fontWeight: "900", fontSize: 16, flex: 1 },
  stepper: { flexDirection: "row", justifyContent: "center", gap: 8, paddingVertical: 10, backgroundColor: theme.colors.surface },
  stepDot: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: theme.colors.border,
    alignItems: "center", justifyContent: "center",
  },
  stepDotActive: { backgroundColor: theme.colors.primary },
  stepText: { fontSize: 12, fontWeight: "900", color: theme.colors.textSecondary },
  section: { fontSize: 15, fontWeight: "900", color: theme.colors.textPrimary },
  label: { fontSize: 12, fontWeight: "800", color: theme.colors.textPrimary, marginTop: 4 },
  input: {
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, backgroundColor: theme.colors.surface, fontSize: 13,
  },
  textarea: {
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8,
    padding: 10, backgroundColor: theme.colors.surface, minHeight: 96, textAlignVertical: "top",
  },
  preview: { width: "100%", height: 180, borderRadius: 10, backgroundColor: "#000" },
  uploadBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.colors.primary, borderRadius: 10, padding: 10, justifyContent: "center",
  },
  uploadT: { color: "#fff", fontWeight: "800", fontSize: 13 },
  uploadInfo: { fontSize: 12, color: theme.colors.success, fontWeight: "700" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.colors.surface,
  },
  chipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipT: { fontSize: 12, fontWeight: "700", color: theme.colors.textPrimary },
  next: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.colors.success, padding: 12, borderRadius: 10, marginTop: 8,
  },
  nextT: { color: "#fff", fontWeight: "900" },
  warn: { padding: 12, backgroundColor: theme.colors.warningBg, color: theme.colors.warning, borderRadius: 10 },
  priceBox: {
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10,
    backgroundColor: theme.colors.surface, padding: 12, gap: 4,
  },
  priceLbl: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 4 },
  priceV: { fontSize: 14, fontWeight: "800", color: theme.colors.textPrimary },
  priceSep: { height: 1, backgroundColor: theme.colors.border, marginVertical: 6 },
  priceTotal: { fontSize: 22, fontWeight: "900", color: theme.colors.primary },
});
