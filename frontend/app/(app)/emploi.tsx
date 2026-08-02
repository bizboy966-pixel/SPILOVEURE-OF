import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, Linking, Platform, RefreshControl,
  SafeAreaView, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme";
import { api, resolveMediaUrl } from "../../src/api";
import { MediaLightbox, useMediaLightbox } from "@/src/components/MediaLightbox";

/**
 * Emploi — public read-only listing of jobs published by the admin.
 *
 * Business rules baked into this screen:
 *   • The full description MUST be shown at once (no "voir plus" toggle).
 *   • Images are optional; when present, tapping opens the fullscreen viewer.
 *   • Contact info is rendered as an actionable chip (tel: / mailto: / wa.me
 *     when we can detect the format) so users can reach the recruiter in
 *     one tap.
 */

type Job = {
  id: string;
  title: string;
  description: string;
  contact: string;
  country: string;
  salary: string | null;
  image_url: string | null;
  active: boolean;
  created_at: string;
};

type Country = { code: string; name: string; flag: string };

function countryLabel(code: string, countries: Country[]): string {
  const c = countries.find((x) => x.code === code);
  return c ? `${c.flag} ${c.name}` : code;
}

function contactHref(contact: string): { url: string; icon: any; label: string } | null {
  const trimmed = (contact || "").trim();
  if (!trimmed) return null;
  // Email
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(trimmed)) {
    return { url: `mailto:${trimmed}`, icon: "mail", label: "Envoyer un e-mail" };
  }
  // WhatsApp / already-a-url
  if (/^https?:\/\//i.test(trimmed)) {
    const wa = /wa\.me|whatsapp/i.test(trimmed);
    return { url: trimmed, icon: wa ? "logo-whatsapp" : "link", label: wa ? "WhatsApp" : "Ouvrir le lien" };
  }
  // Phone number (starts with + or has 6+ digits)
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 6) {
    // Prefer WhatsApp if it looks like an intl number ready for wa.me
    return { url: `tel:${trimmed.replace(/\s+/g, "")}`, icon: "call", label: "Appeler" };
  }
  return null;
}

export default function EmploiScreen() {
  const router = useRouter();
  const [items, setItems] = useState<Job[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const lightbox = useMediaLightbox();

  const load = useCallback(async () => {
    try {
      const [jobs, cfg] = await Promise.all([
        api.get<Job[]>("/jobs"),
        api.get<{ countries: Country[] }>("/config", { auth: false } as any).catch(() => ({ countries: [] })),
      ]);
      setItems(Array.isArray(jobs) ? jobs : []);
      setCountries(Array.isArray(cfg?.countries) ? cfg.countries : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openContact = (raw: string) => {
    const info = contactHref(raw);
    if (!info) {
      if (typeof window !== "undefined") window.alert(`Contact : ${raw}`);
      return;
    }
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.open(info.url, "_blank");
    } else {
      Linking.openURL(info.url).catch(() => {});
    }
  };

  const openImage = (job: Job) => {
    if (!job.image_url) return;
    lightbox.openAt(
      [{ kind: "image", url: resolveMediaUrl(job.image_url) }],
      0,
      { title: job.title, description: job.description },
    );
  };

  const renderItem = ({ item }: { item: Job }) => {
    const info = contactHref(item.contact);
    const img = item.image_url ? resolveMediaUrl(item.image_url) : "";
    return (
      <View style={styles.card} testID={`job-card-${item.id}`}>
        {img ? (
          <TouchableOpacity onPress={() => openImage(item)} activeOpacity={0.85} testID={`job-image-${item.id}`}>
            <Image source={{ uri: img }} style={styles.img} resizeMode="cover" />
            <View style={styles.zoomHint}>
              <Ionicons name="expand" size={12} color="#fff" />
              <Text style={styles.zoomHintTxt}>Agrandir</Text>
            </View>
          </TouchableOpacity>
        ) : null}
        <View style={styles.body}>
          <Text style={styles.title} testID={`job-title-${item.id}`}>{item.title}</Text>
          <View style={styles.metaRow}>
            <View style={styles.chip}>
              <Ionicons name="location" size={12} color={theme.colors.primary} />
              <Text style={styles.chipT}>{countryLabel(item.country, countries)}</Text>
            </View>
            {item.salary ? (
              <View style={[styles.chip, { backgroundColor: "#ECFDF5", borderColor: "#10B98133" }]}>
                <Ionicons name="cash" size={12} color="#059669" />
                <Text style={[styles.chipT, { color: "#065F46" }]}>{item.salary}</Text>
              </View>
            ) : null}
          </View>

          {/* Description — MUST be rendered in full, no toggle. */}
          <Text style={styles.desc} testID={`job-desc-${item.id}`} selectable>
            {item.description}
          </Text>

          {/* Contact */}
          <View style={styles.contactBox}>
            <Text style={styles.contactLabel}>📞 Contact du recruteur</Text>
            <TouchableOpacity
              style={styles.contactBtn}
              onPress={() => openContact(item.contact)}
              testID={`job-contact-${item.id}`}
            >
              <Ionicons name={(info?.icon as any) || "call"} size={16} color="#fff" />
              <Text style={styles.contactBtnT} numberOfLines={2}>
                {item.contact}
              </Text>
            </TouchableOpacity>
            <Text style={styles.disclaim}>
              SPILOVEURE ne participe pas au recrutement — vous contactez directement l'employeur.
            </Text>
          </View>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/(app)/dashboard" as any))}
          style={styles.backBtn}
          testID="emploi-back"
        >
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.htitle}>💼 Emploi</Text>
          <Text style={styles.hsub}>{items.length} offre{items.length > 1 ? "s" : ""} disponible{items.length > 1 ? "s" : ""}</Text>
        </View>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty} testID="emploi-empty">
              <Ionicons name="briefcase-outline" size={54} color={theme.colors.textSecondary} />
              <Text style={styles.emptyT}>Aucune offre d'emploi pour le moment</Text>
              <Text style={styles.emptyS}>
                Les nouvelles opportunités publiées par SPILOVEURE apparaîtront ici. Revenez plus tard !
              </Text>
            </View>
          }
        />
      )}

      <MediaLightbox
        open={lightbox.open}
        slides={lightbox.slides}
        index={lightbox.index}
        onClose={lightbox.close}
        onIndexChange={lightbox.setIndex}
        title={lightbox.title}
        description={lightbox.description}
        testID="emploi-lightbox"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: 16, backgroundColor: theme.colors.primary,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center", justifyContent: "center",
  },
  htitle: { color: "#fff", fontWeight: "900", fontSize: 20 },
  hsub: { color: "rgba(255,255,255,0.9)", fontSize: 11, fontWeight: "600", marginTop: 2 },

  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    marginBottom: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
    shadowColor: "#0F172A",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  img: { width: "100%", height: 200, backgroundColor: "#0F172A" },
  zoomHint: {
    position: "absolute", top: 8, right: 8,
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12,
  },
  zoomHintTxt: { color: "#fff", fontSize: 10, fontWeight: "700" },
  body: { padding: 14 },
  title: { fontSize: 17, fontWeight: "900", color: theme.colors.textPrimary, marginBottom: 8 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 10 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "#EEF2FF",
    borderWidth: 1, borderColor: "#6366F133",
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 999,
  },
  chipT: { fontSize: 11, fontWeight: "800", color: theme.colors.primary },
  desc: {
    fontSize: 13,
    color: theme.colors.textPrimary,
    lineHeight: 20,
    marginBottom: 12,
  },
  contactBox: {
    borderTopWidth: 1, borderTopColor: theme.colors.border,
    paddingTop: 10, gap: 6,
  },
  contactLabel: { fontSize: 11, fontWeight: "800", color: theme.colors.textSecondary },
  contactBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.colors.primary,
    paddingVertical: 10, paddingHorizontal: 12,
    borderRadius: 10,
  },
  contactBtnT: { color: "#fff", fontWeight: "800", fontSize: 13, flex: 1 },
  disclaim: { fontSize: 10, color: theme.colors.textSecondary, fontStyle: "italic", marginTop: 2 },

  empty: { alignItems: "center", padding: 50 },
  emptyT: { fontWeight: "900", fontSize: 15, marginTop: 12, color: theme.colors.textPrimary },
  emptyS: {
    fontSize: 12, color: theme.colors.textSecondary,
    marginTop: 6, textAlign: "center", lineHeight: 18, paddingHorizontal: 20,
  },
});
