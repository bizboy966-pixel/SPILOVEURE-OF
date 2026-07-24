import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Image, RefreshControl, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme";
import { api } from "../../src/api";

type Review = { id: string; user_id: string; username: string; rating: number; comment: string; at: string };
type Listing = { id: string; seller_id: string; seller_username: string; images: string[]; name: string; category: string; price: number; promo_price: number | null; currency: string; city: string; whatsapp: string; description: string; views: number; reviews: Review[]; expires_at?: string };

function MarketplaceScreenInner() {
  const router = useRouter();
  const [items, setItems] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [imgIdx, setImgIdx] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    try { const r = await api.get<{ items: Listing[] }>("/marketplace"); setItems(r.items || []); }
    catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openWhatsapp = (num: string) => {
    const cleaned = num.replace(/[^0-9+]/g, "");
    const url = `https://wa.me/${cleaned.replace(/^\+/, "")}`;
    if (typeof window !== "undefined") window.open(url, "_blank");
  };

  const rate = async (id: string) => {
    const raw = typeof window !== "undefined" ? window.prompt("Note (1-5) et commentaire optionnel séparés par | (ex : 5|Très bon vendeur)") : "";
    if (!raw) return;
    const [rStr, ...rest] = raw.split("|");
    const rating = parseInt(rStr.trim(), 10);
    if (isNaN(rating) || rating < 1 || rating > 5) { window.alert("Note invalide (1-5)."); return; }
    try {
      await api.post(`/marketplace/${id}/review`, { rating, comment: rest.join("|").trim() });
      window.alert("✅ Avis publié. Merci !");
      load();
    } catch (e: any) { window.alert(`❌ ${e?.detail || "Échec"}`); }
  };

  const avgRating = (l: Listing) => {
    if (!l.reviews.length) return null;
    const total = l.reviews.reduce((s, r) => s + r.rating, 0);
    return (total / l.reviews.length).toFixed(1);
  };

  const renderItem = ({ item }: { item: Listing }) => {
    const idx = imgIdx[item.id] || 0;
    const imgs = item.images || [];
    const src = imgs[idx] ? `${process.env.EXPO_PUBLIC_BACKEND_URL || ""}${imgs[idx]}` : "";
    const avg = avgRating(item);
    return (
      <View style={styles.card} testID={`mk-card-${item.id}`}>
        <View style={{ position: "relative" }}>
          {src ? <Image source={{ uri: src }} style={styles.img} resizeMode="cover" /> : null}
          {imgs.length > 1 && (
            <>
              <TouchableOpacity style={[styles.navBtn, { left: 4 }]} onPress={() => setImgIdx((s) => ({ ...s, [item.id]: (idx - 1 + imgs.length) % imgs.length }))} testID={`mk-prev-${item.id}`}>
                <Ionicons name="chevron-back" size={20} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.navBtn, { right: 4 }]} onPress={() => setImgIdx((s) => ({ ...s, [item.id]: (idx + 1) % imgs.length }))} testID={`mk-next-${item.id}`}>
                <Ionicons name="chevron-forward" size={20} color="#fff" />
              </TouchableOpacity>
              <View style={styles.imgCount}><Text style={{ color: "#fff", fontSize: 10 }}>{idx + 1}/{imgs.length}</Text></View>
            </>
          )}
        </View>
        <View style={{ padding: 10, gap: 4 }}>
          <Text style={styles.name}>{item.name}</Text>
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
            <View style={styles.catBadge}><Text style={styles.catT}>{item.category}</Text></View>
            <Text style={styles.meta}>📍 {item.city}</Text>
            {avg && <Text style={styles.meta}>⭐ {avg}</Text>}
          </View>
          <View style={{ flexDirection: "row", gap: 6, alignItems: "baseline" }}>
            {item.promo_price ? (
              <>
                <Text style={styles.promo}>{item.promo_price} {item.currency}</Text>
                <Text style={styles.priceOld}>{item.price} {item.currency}</Text>
              </>
            ) : (
              <Text style={styles.promo}>{item.price} {item.currency}</Text>
            )}
          </View>
          {item.description ? <Text style={styles.desc} numberOfLines={2}>{item.description}</Text> : null}
          <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
            <TouchableOpacity style={[styles.btn, { backgroundColor: "#25D366", flex: 1 }]} onPress={() => openWhatsapp(item.whatsapp)} testID={`mk-chat-${item.id}`}>
              <Ionicons name="logo-whatsapp" size={16} color="#fff" />
              <Text style={styles.btnT}>Discuter</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, { backgroundColor: theme.colors.primary, flex: 1 }]} onPress={() => rate(item.id)} testID={`mk-rate-${item.id}`}>
              <Ionicons name="star" size={16} color="#fff" />
              <Text style={styles.btnT}>Avis / Acheter</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="mk-back"><Ionicons name="arrow-back" size={22} color="#fff" /></TouchableOpacity>
        <Text style={styles.title}>🛒 Marketplace</Text>
        <TouchableOpacity onPress={() => router.push("/(app)/marketplace-create" as any)} style={styles.addBtn} testID="mk-create"><Ionicons name="add" size={22} color="#fff" /></TouchableOpacity>
      </View>
      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator size="large" color={theme.colors.primary} /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}
          ListEmptyComponent={
            <View style={{ alignItems: "center", padding: 40 }}>
              <Ionicons name="cart-outline" size={48} color={theme.colors.textSecondary} />
              <Text style={{ fontWeight: "900", fontSize: 15, marginTop: 8 }}>Aucune annonce publiée</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textSecondary, marginTop: 4 }}>Soyez le premier à publier gratuitement !</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, backgroundColor: theme.colors.primary },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  addBtn: { marginLeft: "auto", width: 36, height: 36, borderRadius: 18, backgroundColor: theme.colors.success, alignItems: "center", justifyContent: "center" },
  title: { color: "#fff", fontWeight: "900", fontSize: 18, flex: 1 },
  card: { backgroundColor: theme.colors.surface, borderRadius: 12, marginBottom: 12, overflow: "hidden", borderWidth: 1, borderColor: theme.colors.border },
  img: { width: "100%", height: 220, backgroundColor: "#000" },
  navBtn: { position: "absolute", top: "50%", marginTop: -18, width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center" },
  imgCount: { position: "absolute", bottom: 6, right: 6, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  name: { fontSize: 15, fontWeight: "900", color: theme.colors.textPrimary },
  meta: { fontSize: 11, color: theme.colors.textSecondary },
  catBadge: { backgroundColor: theme.colors.background, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  catT: { fontSize: 10, fontWeight: "700", color: theme.colors.primary },
  promo: { fontSize: 18, fontWeight: "900", color: theme.colors.primary },
  priceOld: { fontSize: 12, color: theme.colors.textSecondary, textDecorationLine: "line-through" },
  desc: { fontSize: 12, color: theme.colors.textPrimary, marginTop: 2 },
  btn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, padding: 8, borderRadius: 8 },
  btnT: { color: "#fff", fontWeight: "800", fontSize: 12 },
});


import { FeatureGuard } from "@/src/components/FeatureGuard";

export default function MarketplaceScreen() {
  return (
    <FeatureGuard featureKey="marketplace" title="Marketplace désactivé">
      <MarketplaceScreenInner />
    </FeatureGuard>
  );
}
