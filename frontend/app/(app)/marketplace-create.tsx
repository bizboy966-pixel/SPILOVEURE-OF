import React, { useRef, useState } from "react";
import { ActivityIndicator, Image, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme";
import { api } from "../../src/api";

const CATEGORIES = ["Électronique", "Vêtements", "Maison", "Beauté", "Sport", "Automobile", "Immobilier", "Alimentation", "Livres", "Services", "Autre"];

function MarketplaceCreateInner() {
  const router = useRouter();
  const [images, setImages] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [price, setPrice] = useState("");
  const [promoPrice, setPromoPrice] = useState("");
  const [city, setCity] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const uploadImages = async (files: File[]) => {
    setUploading(true);
    try {
      const results: string[] = [];
      for (const f of files) {
        const r = await api.upload<{ url: string }>("/user/uploads", f);
        results.push(r.url);
      }
      setImages((prev) => [...prev, ...results].slice(0, 10));
    } catch (e: any) {
      window.alert(`❌ ${e?.detail || "Échec upload"}`);
    } finally { setUploading(false); }
  };

  const submit = async () => {
    if (!images.length || !name || !city || !whatsapp || !price) { window.alert("Complétez tous les champs obligatoires."); return; }
    setSaving(true);
    try {
      await api.post("/marketplace", {
        images, name, category,
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
        <Text style={styles.section}>📸 Images du produit (max 10)</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {images.map((url, i) => (
            <View key={i} style={styles.imgBox}>
              <Image source={{ uri: `${process.env.EXPO_PUBLIC_BACKEND_URL || ""}${url}` }} style={{ width: 80, height: 80, borderRadius: 8 }} />
              <TouchableOpacity style={styles.imgRm} onPress={() => setImages((v) => v.filter((_, x) => x !== i))} testID={`mkc-remove-${i}`}>
                <Ionicons name="close" size={12} color="#fff" />
              </TouchableOpacity>
            </View>
          ))}
        </View>
        <TouchableOpacity style={styles.uploadBtn} disabled={uploading || images.length >= 10} onPress={() => fileInput.current?.click()} testID="mkc-add-img">
          <Ionicons name="camera" size={18} color="#fff" />
          <Text style={styles.uploadT}>{uploading ? "Envoi…" : `Ajouter ${images.length ? "d'autres photos" : "des photos"}`}</Text>
        </TouchableOpacity>
        {/* @ts-ignore RN Web */}
        <input ref={fileInput} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={(e: any) => { const fs = Array.from(e.target.files || []) as File[]; if (fs.length) uploadImages(fs); }} />

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
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  title: { color: "#fff", fontWeight: "900", fontSize: 16 },
  section: { fontSize: 14, fontWeight: "900", color: theme.colors.textPrimary, marginTop: 8 },
  lbl: { fontSize: 11, fontWeight: "700", color: theme.colors.textPrimary },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, backgroundColor: theme.colors.surface, fontSize: 13 },
  textarea: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, backgroundColor: theme.colors.surface, minHeight: 80, textAlignVertical: "top" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  chip: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: theme.colors.surface },
  chipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipT: { fontSize: 11, fontWeight: "700", color: theme.colors.textPrimary },
  imgBox: { position: "relative" },
  imgRm: { position: "absolute", top: -4, right: -4, backgroundColor: theme.colors.danger, borderRadius: 10, width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  uploadBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.colors.primary, padding: 10, borderRadius: 10 },
  uploadT: { color: "#fff", fontWeight: "800", fontSize: 13 },
  publish: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.colors.success, padding: 14, borderRadius: 10, marginTop: 12 },
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
