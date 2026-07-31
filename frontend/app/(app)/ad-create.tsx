import React, { useCallback, useEffect, useRef, useState } from "react";
import { Image, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
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

function AdCreateScreenInner() {
  const router = useRouter();
  const params = useLocalSearchParams<{ type?: string }>();
  const mediaType: "video" | "poster" = params.type === "poster" ? "poster" : "video";
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
  const [ashtecEnabled, setAshtecEnabled] = useState<boolean>(false);
  const [cryptoEnabled, setCryptoEnabledLocal] = useState<boolean>(true);

  useEffect(() => {
    (async () => {
      try {
        const f = await api.get<any>("/settings/payments", { auth: false });
        setAshtecEnabled(!!f.ashtec_enabled);
        setCryptoEnabledLocal(!!f.crypto_enabled);
      } catch {}
    })();
  }, []);

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
    if (!coverUrl || !description.trim() || (mediaType === "video" && !videoUrl)) {
      if (typeof window !== "undefined") window.alert("Veuillez remplir tous les champs.");
      return;
    }
    setSaving(true);
    try {
      const r = await api.post<{ id: string }>("/ads", {
        cover_image_url: coverUrl,
        video_url: mediaType === "video" ? videoUrl : null,
        description: description.trim(),
        media_type: mediaType,
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

  // Payment state (step 4).
  type PayInit = {
    method: "crypto";
    reference: string;
    // Crypto
    deposit_address?: string;
    amount_to_send?: string | number;
    coin?: string;
    network?: string;
    usdt_amount?: number;
    xof_amount?: number;
  };
  const [payInit, setPayInit] = useState<PayInit | null>(null);
  const [payErr, setPayErr] = useState<string | null>(null);
  const [adStatus, setAdStatus] = useState<string>("pending_payment");

  const startPayment = async () => {
    if (!adId) return;
    setSaving(true); setPayErr(null);
    try {
      const r = await api.post<PayInit>(`/ads/${adId}/pay`, { method: "crypto" });
      setPayInit(r);
    } catch (e: any) {
      setPayErr(e?.detail || "Impossible de démarrer le paiement.");
    } finally { setSaving(false); }
  };

  const copyAddr = async () => {
    if (!payInit?.deposit_address) return;
    try {
      if (typeof navigator !== "undefined" && (navigator as any).clipboard) {
        await (navigator as any).clipboard.writeText(payInit.deposit_address);
      }
      if (typeof window !== "undefined") window.alert("Adresse copiée ✅");
    } catch { /* noop */ }
  };

  // Poll ad status every 4s while on step 4 with a payment initiated.
  useEffect(() => {
    if (step !== 4 || !adId || !payInit) return;
    const iv = setInterval(async () => {
      try {
        const r = await api.get<any>(`/ads/${adId}`);
        const s = r?.status || "";
        setAdStatus(s);
        if (s && s !== "pending_payment") {
          clearInterval(iv);
          if (typeof window !== "undefined") {
            window.alert("✅ Paiement confirmé. Votre publicité est soumise à validation.");
          }
          router.replace("/(app)/ads" as any);
        }
      } catch { /* ignore */ }
    }, 4000);
    return () => clearInterval(iv);
  }, [step, adId, payInit, router]);


  const totalPrice = duration && pricing ? pricing.price_per_day * duration : 0;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="adcreate-back">
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>{mediaType === "poster" ? "🖼 Nouvelle affiche publicitaire" : "🎥 Nouvelle vidéo publicitaire"}</Text>
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

            <Text style={styles.label}>{mediaType === "poster" ? "🖼 Affiche publicitaire" : "🖼 Image de couverture"}</Text>
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
              <Text style={styles.uploadT}>{uploadingCover ? "Envoi…" : coverUrl ? "Remplacer" : (mediaType === "poster" ? "Importer l'affiche" : "Importer une image")}</Text>
            </TouchableOpacity>
            {/* @ts-ignore RN Web */}
            <input ref={coverInput} type="file" accept="image/*" style={{ display: "none" }}
              onChange={(e: any) => { const f = e.target.files?.[0]; if (f) uploadFile(f, "cover"); }} />

            {mediaType === "video" && (
              <>
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
              </>
            )}
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
          <View style={{ padding: 16, gap: 12 }}>
            <View style={{ alignItems: "center", gap: 6 }}>
              <Ionicons name="card" size={54} color={theme.colors.primary} />
              <Text style={styles.section}>💳 Paiement</Text>
              <Text style={styles.priceTotal}>{totalPrice} FCFA</Text>
            </View>

            {!payInit && (
              <>
                <Text style={{ textAlign: "center", color: theme.colors.textSecondary, marginBottom: 8 }}>
                  Choisissez votre mode de paiement.
                </Text>

                {/* ⚡ Mobile Money Ashtech Pay (priority) */}
                {ashtecEnabled && (
                <TouchableOpacity
                  style={[styles.next, { backgroundColor: "#0F172A", borderWidth: 2, borderColor: "#F59E0B" }]}
                  onPress={() => router.push({
                    pathname: "/(app)/pay-ashtec" as any,
                    params: {
                      kind: "ads",
                      target_id: adId!,
                      amount: String(totalPrice),
                      title: "Paiement Publicité",
                      return_to: "/(app)/ads",
                    },
                  })}
                  testID="ad-pay-mobile-money"
                >
                  <Ionicons name="phone-portrait" size={18} color="#FBBF24" />
                  <Text style={[styles.nextT, { color: "#fff" }]}>⚡ Mobile Money — Ashtech Pay</Text>
                </TouchableOpacity>
                )}

                {ashtecEnabled && cryptoEnabled && (
                  <Text style={{ textAlign: "center", color: theme.colors.textSecondary, marginVertical: 8, fontSize: 12 }}>
                    — ou —
                  </Text>
                )}

                {cryptoEnabled && (
                <TouchableOpacity
                  style={[styles.next, { backgroundColor: "#F59E0B" }, saving && { opacity: 0.6 }]}
                  onPress={() => startPayment()}
                  disabled={saving}
                  testID="ad-pay-crypto"
                >
                  {saving ? <ActivityIndicator color="#fff" /> : (
                    <><Ionicons name="logo-bitcoin" size={18} color="#fff" /><Text style={styles.nextT}>Payer en USDT (BEP20)</Text></>
                  )}
                </TouchableOpacity>
                )}
                {payErr ? (
                  <Text style={{ color: "#DC2626", textAlign: "center", marginTop: 8 }} testID="ad-pay-error">{payErr}</Text>
                ) : null}
                {!ashtecEnabled && !cryptoEnabled && (
                  <Text style={{ color: "#DC2626", textAlign: "center", marginTop: 8 }}>
                    Aucun moyen de paiement n'est actif actuellement. Contactez l'administrateur.
                  </Text>
                )}
              </>
            )}

            {payInit?.method === "crypto" && payInit.deposit_address && (
              <View style={{ gap: 10, padding: 12, backgroundColor: theme.colors.surface, borderRadius: 10 }}>
                <Text style={{ fontWeight: "800", color: theme.colors.textPrimary }}>
                  Envoyez {String(payInit.amount_to_send)} USDT (BEP20)
                </Text>
                <View style={{ alignItems: "center" }}>
                  {Platform.OS === "web" ? (
                    <Image
                      source={{ uri: `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(payInit.deposit_address)}` }}
                      style={{ width: 220, height: 220, backgroundColor: "#fff" }}
                      testID="ad-pay-qr"
                    />
                  ) : (
                    <View style={{ width: 220, height: 220, backgroundColor: "#F1F5F9", alignItems: "center", justifyContent: "center", borderRadius: 8 }}>
                      <Ionicons name="qr-code" size={60} color={theme.colors.primary} />
                    </View>
                  )}
                </View>
                <View style={{ padding: 10, backgroundColor: theme.colors.background, borderRadius: 8 }}>
                  <Text style={{ fontSize: 11, color: theme.colors.textSecondary, fontWeight: "700" }}>Adresse USDT BEP20</Text>
                  <Text selectable style={{ fontSize: 12, fontFamily: Platform.select({ web: "monospace", default: undefined }), color: theme.colors.textPrimary, marginTop: 4 }} testID="ad-pay-address">
                    {payInit.deposit_address}
                  </Text>
                </View>
                <TouchableOpacity style={styles.next} onPress={copyAddr} testID="ad-pay-copy">
                  <Ionicons name="copy" size={18} color="#fff" />
                  <Text style={styles.nextT}>Copier l'adresse</Text>
                </TouchableOpacity>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 12, textAlign: "center" }}>
                  {payInit.xof_amount} FCFA = {payInit.usdt_amount} USDT · Envoyez UNIQUEMENT sur BEP20.
                </Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 12, textAlign: "center" }}>
                  {adStatus === "pending_payment" ? "⏳ En attente de la confirmation on-chain…" : `✅ Statut: ${adStatus}`}
                </Text>
              </View>
            )}
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


import { FeatureGuard } from "@/src/components/FeatureGuard";

export default function AdCreateScreen() {
  return (
    <FeatureGuard featureKey="ads" title="Création publicité désactivée">
      <AdCreateScreenInner />
    </FeatureGuard>
  );
}
