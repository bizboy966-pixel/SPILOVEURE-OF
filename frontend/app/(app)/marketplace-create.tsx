import React, { useRef, useState } from "react";
import { ActivityIndicator, Image, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme";
import { api, resolveMediaUrl } from "../../src/api";

const CATEGORIES = ["Électronique", "Vêtements", "Maison", "Beauté", "Sport", "Automobile", "Immobilier", "Alimentation", "Livres", "Services", "Autre"];

const MAX_IMAGES = 10;
const MAX_VIDEOS = 5;

function MarketplaceCreateInner() {
  const router = useRouter();
  const [images, setImages] = useState<string[]>([]);
  const [videos, setVideos] = useState<string[]>([]);
  const [audio, setAudio] = useState<string>("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [price, setPrice] = useState("");
  const [promoPrice, setPromoPrice] = useState("");
  const [city, setCity] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState<"img" | "vid" | "aud" | null>(null);
  const [saving, setSaving] = useState(false);
  const imgInput = useRef<HTMLInputElement | null>(null);
  const vidInput = useRef<HTMLInputElement | null>(null);
  const audInput = useRef<HTMLInputElement | null>(null);

  const uploadMany = async (
    files: File[],
    kind: "img" | "vid",
  ) => {
    setUploading(kind);
    try {
      const results: string[] = [];
      for (const f of files) {
        const r = await api.upload<{ url: string }>("/user/uploads", f);
        results.push(r.url);
      }
      if (kind === "img") setImages((p) => [...p, ...results].slice(0, MAX_IMAGES));
      else setVideos((p) => [...p, ...results].slice(0, MAX_VIDEOS));
    } catch (e: any) {
      window.alert(`❌ ${e?.detail || "Échec upload"}`);
    } finally {
      setUploading(null);
    }
  };

  const uploadAudio = async (file: File) => {
    setUploading("aud");
    try {
      const r = await api.upload<{ url: string }>("/user/uploads", file);
      setAudio(r.url);
    } catch (e: any) {
      window.alert(`❌ ${e?.detail || "Échec upload"}`);
    } finally {
      setUploading(null);
    }
  };

  const moveImage = (from: number, to: number) => {
    if (to < 0 || to >= images.length) return;
    setImages((v) => {
      const c = [...v];
      const [x] = c.splice(from, 1);
      c.splice(to, 0, x);
      return c;
    });
  };

  const submit = async () => {
    if (!images.length || !name || !city || !whatsapp || !price) { window.alert("Complétez tous les champs obligatoires."); return; }
    setSaving(true);
    try {
      await api.post("/marketplace", {
        images, videos, audio: audio || null,
        name, category,
        price: parseFloat(price) || 0,
        promo_price: promoPrice ? parseFloat(promoPrice) : null,
        city, whatsapp, description,
      });
      window.alert("✅ Annonce soumise. Elle sera visible après validation par l'administrateur.");
      router.replace("/(app)/marketplace" as any);
    } catch (e: any) { window.alert(`❌ ${e?.detail || "Échec"}`); }
    finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="mkc-back"><Ionicons name="arrow-back" size={22} color="#fff" /></TouchableOpacity>
        <Text style={styles.title}>📝 Publier un article</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        {/* ─── PHOTOS ────────────────────────────────────────── */}
        <Text style={styles.section}>📸 Photos ({images.length}/{MAX_IMAGES})</Text>
        <Text style={styles.hint}>Utilisez les flèches pour réorganiser. La première photo est la miniature.</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {images.map((url, i) => (
            <View key={i} style={styles.imgBox} testID={`mkc-img-${i}`}>
              <Image source={{ uri: resolveMediaUrl(url) }} style={{ width: 90, height: 90, borderRadius: 10 }} />
              {i === 0 && <View style={styles.thumbBadge}><Text style={styles.thumbBadgeT}>Miniature</Text></View>}
              <TouchableOpacity style={styles.imgRm} onPress={() => setImages((v) => v.filter((_, x) => x !== i))} testID={`mkc-remove-img-${i}`}>
                <Ionicons name="close" size={12} color="#fff" />
              </TouchableOpacity>
              <View style={styles.moveRow}>
                <TouchableOpacity style={styles.moveBtn} onPress={() => moveImage(i, i - 1)} disabled={i === 0} testID={`mkc-move-up-${i}`}>
                  <Ionicons name="chevron-back" size={14} color={i === 0 ? "#94A3B8" : "#fff"} />
                </TouchableOpacity>
                <TouchableOpacity style={styles.moveBtn} onPress={() => moveImage(i, i + 1)} disabled={i === images.length - 1} testID={`mkc-move-down-${i}`}>
                  <Ionicons name="chevron-forward" size={14} color={i === images.length - 1 ? "#94A3B8" : "#fff"} />
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
        <TouchableOpacity style={styles.uploadBtn} disabled={!!uploading || images.length >= MAX_IMAGES} onPress={() => imgInput.current?.click()} testID="mkc-add-img">
          <Ionicons name="camera" size={18} color="#fff" />
          <Text style={styles.uploadT}>{uploading === "img" ? "Envoi…" : `Ajouter ${images.length ? "d'autres photos" : "des photos"}`}</Text>
        </TouchableOpacity>

        {/* ─── VIDÉOS ─────────────────────────────────────────── */}
        <Text style={styles.section}>🎥 Vidéos ({videos.length}/{MAX_VIDEOS})</Text>
        <Text style={styles.hint}>Montrez le produit en action pour rassurer vos acheteurs.</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {videos.map((url, i) => (
            <View key={i} style={styles.videoBox} testID={`mkc-vid-${i}`}>
              {Platform.OS === "web" ? (
                // @ts-ignore raw video element for RN web preview
                <video src={resolveMediaUrl(url)} controls style={{ width: 140, height: 90, borderRadius: 10, background: "#000" }} />
              ) : (
                <View style={{ width: 140, height: 90, backgroundColor: "#000", alignItems: "center", justifyContent: "center", borderRadius: 10 }}>
                  <Ionicons name="videocam" size={24} color="#fff" />
                </View>
              )}
              <TouchableOpacity style={styles.imgRm} onPress={() => setVideos((v) => v.filter((_, x) => x !== i))} testID={`mkc-remove-vid-${i}`}>
                <Ionicons name="close" size={12} color="#fff" />
              </TouchableOpacity>
            </View>
          ))}
        </View>
        <TouchableOpacity style={[styles.uploadBtn, { backgroundColor: "#7B61FF" }]} disabled={!!uploading || videos.length >= MAX_VIDEOS} onPress={() => vidInput.current?.click()} testID="mkc-add-vid">
          <Ionicons name="videocam" size={18} color="#fff" />
          <Text style={styles.uploadT}>{uploading === "vid" ? "Envoi…" : `Ajouter ${videos.length ? "d'autres vidéos" : "des vidéos"}`}</Text>
        </TouchableOpacity>

        {/* ─── MUSIQUE ────────────────────────────────────────── */}
        <Text style={styles.section}>🎵 Musique de fond (facultatif)</Text>
        <Text style={styles.hint}>Accompagne le défilement de vos photos dans le marketplace.</Text>
        {audio ? (
          <View style={styles.audioBox} testID="mkc-audio">
            <Ionicons name="musical-notes" size={22} color="#7B61FF" />
            <View style={{ flex: 1 }}>
              {Platform.OS === "web" ? (
                // @ts-ignore raw audio element for RN web preview
                <audio src={resolveMediaUrl(audio)} controls style={{ width: "100%" }} />
              ) : (
                <Text style={{ color: theme.colors.textPrimary, fontWeight: "700" }}>Musique importée</Text>
              )}
            </View>
            <TouchableOpacity onPress={() => setAudio("")} style={styles.audioRm} testID="mkc-remove-audio">
              <Ionicons name="close" size={14} color="#fff" />
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={[styles.uploadBtn, { backgroundColor: "#EC4899" }]} disabled={!!uploading} onPress={() => audInput.current?.click()} testID="mkc-add-audio">
            <Ionicons name="musical-notes" size={18} color="#fff" />
            <Text style={styles.uploadT}>{uploading === "aud" ? "Envoi…" : "Ajouter une musique"}</Text>
          </TouchableOpacity>
        )}

        {/* Hidden file inputs */}
        {/* @ts-ignore RN Web */}
        <input ref={imgInput} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={(e: any) => { const fs = Array.from(e.target.files || []) as File[]; if (fs.length) uploadMany(fs, "img"); e.target.value = ""; }} />
        {/* @ts-ignore RN Web */}
        <input ref={vidInput} type="file" accept="video/*" multiple style={{ display: "none" }}
          onChange={(e: any) => { const fs = Array.from(e.target.files || []) as File[]; if (fs.length) uploadMany(fs, "vid"); e.target.value = ""; }} />
        {/* @ts-ignore RN Web */}
        <input ref={audInput} type="file" accept="audio/*" style={{ display: "none" }}
          onChange={(e: any) => { const f = e.target.files?.[0]; if (f) uploadAudio(f); e.target.value = ""; }} />

        <Text style={styles.section}>ℹ️ Informations</Text>
        <TextInput style={styles.input} placeholder="Nom du produit *" value={name} onChangeText={setName} testID="mkc-name" />
        <Text style={styles.lbl}>Catégorie</Text>
        <View style={styles.chipRow}>
          {CATEGORIES.map((c) => (
            <TouchableOpacity key={c} style={[styles.chip, category === c && styles.chipOn]} onPress={() => setCategory(c)} testID={`mkc-cat-${c}`}>
              <Text style={[styles.chipT, category === c && { color: "#fff" }]}>{c}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <View style={{ flex: 1 }}><TextInput style={styles.input} placeholder="Prix normal * (FCFA)" keyboardType="numeric" value={price} onChangeText={setPrice} testID="mkc-price" /></View>
          <View style={{ flex: 1 }}><TextInput style={styles.input} placeholder="Prix promo (optionnel)" keyboardType="numeric" value={promoPrice} onChangeText={setPromoPrice} testID="mkc-promo" /></View>
        </View>
        <TextInput style={styles.textarea} placeholder="Description du produit…" value={description} onChangeText={setDescription} multiline numberOfLines={4} testID="mkc-desc" />

        <Text style={styles.section}>📍 Localisation</Text>
        <TextInput style={styles.input} placeholder="Ville / localité *" value={city} onChangeText={setCity} testID="mkc-city" />

        <Text style={styles.section}>💬 Contact WhatsApp</Text>
        <TextInput style={styles.input} placeholder="Ex : +22890123456 *" keyboardType="phone-pad" value={whatsapp} onChangeText={setWhatsapp} testID="mkc-whatsapp" />

        <TouchableOpacity style={styles.publish} onPress={submit} disabled={saving} testID="mkc-publish">
          {saving ? <ActivityIndicator color="#fff" /> : <><Ionicons name="rocket" size={16} color="#fff" /><Text style={styles.publishT}>Publier</Text></>}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, backgroundColor: theme.colors.primary },
  backBtn: { width: 36, height: 36, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  title: { color: "#fff", fontWeight: "900", fontSize: 16 },
  section: { fontSize: 14, fontWeight: "900", color: theme.colors.textPrimary, marginTop: 10 },
  hint: { fontSize: 11, color: theme.colors.textSecondary },
  lbl: { fontSize: 11, fontWeight: "700", color: theme.colors.textPrimary },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 10, backgroundColor: theme.colors.surface, fontSize: 13 },
  textarea: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 10, backgroundColor: theme.colors.surface, minHeight: 80, textAlignVertical: "top" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  chip: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: theme.colors.surface },
  chipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipT: { fontSize: 11, fontWeight: "700", color: theme.colors.textPrimary },
  imgBox: { position: "relative" },
  imgRm: { position: "absolute", top: -4, right: -4, backgroundColor: theme.colors.danger, borderRadius: 12, width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  thumbBadge: { position: "absolute", bottom: 4, left: 4, backgroundColor: "rgba(11,45,111,0.85)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  thumbBadgeT: { color: "#fff", fontSize: 9, fontWeight: "800" },
  moveRow: { position: "absolute", bottom: 4, right: 4, flexDirection: "row", gap: 2 },
  moveBtn: { backgroundColor: "rgba(0,0,0,0.55)", width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  videoBox: { position: "relative" },
  audioBox: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#F5F3FF", borderWidth: 1, borderColor: "#DDD6FE", padding: 10, borderRadius: 12 },
  audioRm: { backgroundColor: theme.colors.danger, borderRadius: 14, width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  uploadBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.colors.primary, padding: 10, borderRadius: 12 },
  uploadT: { color: "#fff", fontWeight: "800", fontSize: 13 },
  publish: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.colors.success, padding: 14, borderRadius: 12, marginTop: 16 },
  publishT: { color: "#fff", fontWeight: "900" },
});


import { FeatureGuard } from "@/src/components/FeatureGuard";

export default function MarketplaceCreate() {
  return (
    <FeatureGuard featureKey="marketplace_publish" title="Publication d'article désactivée">
      <MarketplaceCreateInner />
    </FeatureGuard>
  );
}
