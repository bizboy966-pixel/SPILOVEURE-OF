import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  RefreshControl,
  SafeAreaView,
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

type Comment = { id: string; user_id: string; username: string; text: string; at: string };
type Ad = {
  id: string;
  username: string;
  cover_image_url: string;
  video_url: string;
  description: string;
  media_type?: "video" | "poster";
  views_count: number;
  shares_count: number;
  likes: string[];
  comments: Comment[];
  published_at?: string;
};

import { FeatureGuard } from "@/src/components/FeatureGuard";

function AdsScreenInner() {
  const router = useRouter();
  const [ads, setAds] = useState<Ad[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newComment, setNewComment] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: Ad[] }>("/ads");
      setAds(r.items || []);
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onLike = async (adId: string) => {
    try {
      const r = await api.post<{ liked: boolean; likes_count: number }>(`/ads/${adId}/like`);
      setAds((prev) => prev.map((a) => a.id === adId ? { ...a, likes: r.liked ? [...a.likes, "me"] : a.likes.slice(0, -1) } : a));
    } catch {}
  };

  const onShare = async (adId: string) => {
    try {
      await api.post(`/ads/${adId}/share`);
      setAds((prev) => prev.map((a) => a.id === adId ? { ...a, shares_count: a.shares_count + 1 } : a));
      if (typeof window !== "undefined" && navigator?.share) {
        try { await navigator.share({ url: window.location.href }); } catch {}
      }
    } catch {}
  };

  const onView = async (adId: string) => {
    try { await api.post(`/ads/${adId}/view`); } catch {}
  };

  const onComment = async (adId: string) => {
    const text = (newComment[adId] || "").trim();
    if (!text) return;
    try {
      const r = await api.post<{ comment: Comment }>(`/ads/${adId}/comment`, { text });
      setAds((prev) => prev.map((a) => a.id === adId ? { ...a, comments: [...a.comments, r.comment] } : a));
      setNewComment((n) => ({ ...n, [adId]: "" }));
    } catch {}
  };

  const renderAd = ({ item }: { item: Ad }) => {
    const isExpanded = expandedId === item.id;
    const isPoster = item.media_type === "poster";
    const videoSrc = item.video_url && !item.video_url.startsWith("http") ? `${process.env.EXPO_PUBLIC_BACKEND_URL || ""}${item.video_url}` : item.video_url;
    const coverSrc = item.cover_image_url.startsWith("http") ? item.cover_image_url : `${process.env.EXPO_PUBLIC_BACKEND_URL || ""}${item.cover_image_url}`;
    return (
      <View style={styles.card} testID={`ad-card-${item.id}`}>
        <View style={styles.cardHead}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={16} color="#fff" />
          </View>
          <Text style={styles.username}>@{item.username}</Text>
        </View>
        {isPoster ? (
          <Image
            source={{ uri: coverSrc }}
            style={styles.cover}
            resizeMode="contain"
            onLoad={() => onView(item.id)}
          />
        ) : typeof window !== "undefined" ? (
          // @ts-ignore RN Web renders HTML tags
          <video
            src={videoSrc}
            poster={coverSrc}
            controls
            playsInline
            preload="metadata"
            onPlay={() => onView(item.id)}
            style={{ width: "100%", maxHeight: 420, backgroundColor: "#000" }}
          />
        ) : (
          <Image source={{ uri: coverSrc }} style={styles.cover} />
        )}
        <Text style={styles.desc}>{item.description}</Text>
        <View style={styles.actionsRow}>
          <TouchableOpacity onPress={() => onLike(item.id)} style={styles.action} testID={`ad-like-${item.id}`}>
            <Ionicons name="heart" size={20} color={theme.colors.danger} />
            <Text style={styles.actionN}>{item.likes.length}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setExpandedId(isExpanded ? null : item.id)} style={styles.action} testID={`ad-comment-${item.id}`}>
            <Ionicons name="chatbubble-outline" size={20} color={theme.colors.textPrimary} />
            <Text style={styles.actionN}>{item.comments.length}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onShare(item.id)} style={styles.action} testID={`ad-share-${item.id}`}>
            <Ionicons name="share-social" size={20} color={theme.colors.textPrimary} />
            <Text style={styles.actionN}>{item.shares_count}</Text>
          </TouchableOpacity>
          <View style={styles.action}>
            <Ionicons name="eye-outline" size={20} color={theme.colors.textSecondary} />
            <Text style={styles.actionN}>{item.views_count}</Text>
          </View>
        </View>
        {isExpanded && (
          <View style={styles.commentsBox}>
            {item.comments.length === 0 ? (
              <Text style={styles.commentsEmpty}>Aucun commentaire — soyez le premier.</Text>
            ) : (
              item.comments.map((c) => (
                <View key={c.id} style={styles.commentItem}>
                  <Text style={styles.commentUser}>@{c.username}</Text>
                  <Text style={styles.commentText}>{c.text}</Text>
                </View>
              ))
            )}
            <View style={styles.commentInputRow}>
              <TextInput
                style={styles.commentInput}
                placeholder="Ajouter un commentaire…"
                value={newComment[item.id] || ""}
                onChangeText={(v) => setNewComment((n) => ({ ...n, [item.id]: v }))}
                testID={`ad-comment-input-${item.id}`}
              />
              <TouchableOpacity onPress={() => onComment(item.id)} style={styles.commentSend} testID={`ad-comment-send-${item.id}`}>
                <Ionicons name="send" size={16} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="ads-back">
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>📢 Publicités</Text>
        <TouchableOpacity onPress={() => router.push("/(app)/ad-create" as any)} style={styles.createBtn} testID="ads-create">
          <Ionicons name="add" size={22} color="#fff" />
        </TouchableOpacity>
      </View>
      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : (
        <FlatList
          data={ads}
          keyExtractor={(a) => a.id}
          renderItem={renderAd}
          contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="megaphone-outline" size={48} color={theme.colors.textSecondary} />
              <Text style={styles.emptyTitle}>Aucune publicité pour le moment</Text>
              <Text style={styles.emptyHint}>Soyez le premier à créer une campagne !</Text>
            </View>
          }
          testID="ads-feed"
        />
      )}
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
  createBtn: {
    marginLeft: "auto",
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: theme.colors.success,
    alignItems: "center", justifyContent: "center",
  },
  title: { color: "#fff", fontWeight: "900", fontSize: 18 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14, marginBottom: 14, overflow: "hidden",
    borderWidth: 1, borderColor: theme.colors.border,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10 },
  avatar: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: theme.colors.primary,
    alignItems: "center", justifyContent: "center",
  },
  username: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 13 },
  cover: { width: "100%", height: 320, backgroundColor: "#000" },
  desc: { padding: 10, color: theme.colors.textPrimary, fontSize: 13 },
  actionsRow: {
    flexDirection: "row", gap: 16, paddingHorizontal: 10, paddingBottom: 10,
  },
  action: { flexDirection: "row", alignItems: "center", gap: 4 },
  actionN: { fontSize: 12, color: theme.colors.textSecondary, fontWeight: "700" },
  commentsBox: {
    padding: 10, borderTopWidth: 1, borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  commentsEmpty: { color: theme.colors.textSecondary, fontStyle: "italic", fontSize: 12 },
  commentItem: { paddingVertical: 4 },
  commentUser: { fontWeight: "800", fontSize: 12, color: theme.colors.primary },
  commentText: { fontSize: 12, color: theme.colors.textPrimary },
  commentInputRow: { flexDirection: "row", gap: 6, marginTop: 8 },
  commentInput: {
    flex: 1, borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 12,
    backgroundColor: theme.colors.surface,
  },
  commentSend: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: theme.colors.primary,
    alignItems: "center", justifyContent: "center",
  },
  empty: { alignItems: "center", padding: 40, gap: 6 },
  emptyTitle: { fontWeight: "900", fontSize: 15, color: theme.colors.textPrimary },
  emptyHint: { fontSize: 12, color: theme.colors.textSecondary },
});


export default function AdsScreen() {
  return (
    <FeatureGuard featureKey="ads" title="Publicité désactivée">
      <AdsScreenInner />
    </FeatureGuard>
  );
}
