import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Modal, Platform,
  Pressable, RefreshControl, SafeAreaView, ScrollView, Share, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { FeatureGuard } from "@/src/components/FeatureGuard";
import { theme } from "../../src/theme";
import { api, resolveMediaUrl } from "../../src/api";
import { MediaLightbox, useMediaLightbox } from "@/src/components/MediaLightbox";
import { BottomNav } from "@/src/components/BottomNav";
import { useAuth } from "@/src/auth";
import { useChat } from "@/src/chat/ChatContext";
import { clearChatLogoutMarker } from "@/src/chat/chatLaunchState";
import { messengerApi } from "@/src/messenger/api";
import { useI18n } from "@/src/i18n";
import { isAndroidApkWebView } from "@/src/utils/isAndroidApkWebView";
import {
  marketplaceConversationRoute, marketplaceListingUrl, marketplaceReturnRoute,
  marketplaceShareMessage,
} from "@/src/marketplace/marketplaceFlow";

type Review = { id: string; user_id: string; username: string; rating: number; comment: string; at: string };
type ListingComment = { id: string; listing_id: string; user_id: string; username: string; text: string; created_at: string };
type SellerProfile = { username: string; avatar: string; verified: boolean };
type Listing = {
  id: string; seller_id: string; seller_username: string;
  seller_profile?: SellerProfile;
  images: string[]; videos?: string[]; audio?: string | null;
  name: string; category: string; price: number; promo_price: number | null;
  currency: string; city: string; whatsapp: string; description: string;
  views: number; reviews: Review[]; expires_at?: string;
  likes_count?: number; liked_by_me?: boolean; comments_count?: number;
};
type ContactState = { contacts: { id: string }[]; sent: string[] };

const firstParam = (value?: string | string[]) => Array.isArray(value) ? value[0] : value;

function MarketplaceScreenInner() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useLocalSearchParams<{
    marketplaceAction?: string | string[]; sellerId?: string | string[];
    listingId?: string | string[]; listing_id?: string | string[];
  }>();
  const isApkWebView = isAndroidApkWebView();
  const ScreenContainer = isApkWebView ? View : SafeAreaView;
  const { user: mainUser } = useAuth();
  const { user: chatUser, loading: chatLoading, refresh: refreshChat } = useChat();
  const [items, setItems] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [mediaIdx, setMediaIdx] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [audioPlaying, setAudioPlaying] = useState<string | null>(null);
  const [pageHeight, setPageHeight] = useState(620);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [contactTarget, setContactTarget] = useState<Listing | null>(null);
  const [contactBusy, setContactBusy] = useState(false);
  const [contactError, setContactError] = useState("");
  const [savedContactIds, setSavedContactIds] = useState<Set<string>>(new Set());
  const [commentsTarget, setCommentsTarget] = useState<Listing | null>(null);
  const [comments, setComments] = useState<ListingComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [socialBusy, setSocialBusy] = useState<Record<string, boolean>>({});
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const listRef = useRef<FlatList<Listing> | null>(null);
  const handledAction = useRef<string | null>(null);
  const lightbox = useMediaLightbox();
  const actionParam = firstParam(params.marketplaceAction);
  const actionSellerId = firstParam(params.sellerId);
  const actionListingId = firstParam(params.listingId);
  const listingQuery = firstParam(params.listing_id);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const result = await api.get<{ items: Listing[] }>("/marketplace");
      setItems(result.items || []);
      api.post("/marketplace/mark-seen").catch(() => {});
    } catch (error: any) {
      setLoadError(error?.detail || "Impossible de charger les annonces. Vérifiez votre connexion puis réessayez.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const markedSeenRef = useRef<Set<string>>(new Set());
  const markListingSeen = useCallback(async (id: string) => {
    if (markedSeenRef.current.has(id)) return;
    markedSeenRef.current.add(id);
    try { await api.post(`/marketplace/${encodeURIComponent(id)}/mark-seen`, {}); }
    catch { markedSeenRef.current.delete(id); }
  }, []);
  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    for (const visible of viewableItems || []) {
      if (visible?.item?.id) markListingSeen(visible.item.id);
    }
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50, minimumViewTime: 500 }).current;

  const fetchContacts = useCallback(async () => {
    const response = await api.get<ContactState>("/messenger/contacts");
    const next = new Set([
      ...(response.contacts || []).map(person => person.id),
      ...(response.sent || []),
    ]);
    setSavedContactIds(next);
    return next;
  }, []);

  useEffect(() => {
    if (!chatUser || (mainUser && chatUser.id !== mainUser.id)) {
      setSavedContactIds(new Set());
      return;
    }
    void fetchContacts().catch(() => {});
  }, [chatUser, mainUser, fetchContacts]);

  const ensureChatSession = useCallback(async (returnTo: string) => {
    const verifyRoute = `/verify-email?source=chat&returnTo=${encodeURIComponent(returnTo)}`;
    if (chatLoading) {
      setNotice({ text: "Vérification de votre session Chat…", error: true });
      return false;
    }
    if (chatUser && (!mainUser || chatUser.id === mainUser.id)) {
      await clearChatLogoutMarker();
      return true;
    }
    if (chatUser && mainUser && chatUser.id !== mainUser.id) {
      setNotice({ text: "La session SPILOVEURE Chat appartient à un autre compte. Déconnectez-la avant de continuer.", error: true });
      return false;
    }
    try {
      const identity = await api.get<{
        user?: { id: string };
        email_verified?: boolean;
        chat_access_allowed?: boolean;
        main_authenticated?: boolean;
        chat_authenticated?: boolean;
      }>("/identity/state", { credentials: "include" });
      const existing = await api.get<{ user: { id: string } }>(
        "/identity/chat/session", { auth: false, credentials: "include" },
      ).catch(() => null);
      if (existing && identity.user?.id && existing.user?.id !== identity.user.id) {
        setNotice({ text: "La session SPILOVEURE Chat appartient à un autre compte. Déconnectez-la avant de continuer.", error: true });
        return false;
      }
      if (!(identity.chat_access_allowed ?? identity.email_verified)
        || !(identity.main_authenticated || identity.chat_authenticated)) {
        router.push(verifyRoute as any);
        return false;
      }
      if (!existing) await api.post("/identity/chat/open", undefined, { credentials: "include" });
      const opened = await refreshChat();
      if (!opened || (identity.user?.id && opened.id !== identity.user.id)) {
        throw new Error("La session Chat ne correspond pas au compte actif.");
      }
      await clearChatLogoutMarker();
      return true;
    } catch (error: any) {
      if (error?.status === 401) {
        router.push(verifyRoute as any);
      } else {
        setNotice({ text: error?.detail || error?.message || "Impossible d’ouvrir votre session Chat.", error: true });
      }
      return false;
    }
  }, [chatLoading, chatUser, mainUser, refreshChat, router]);

  const openContactModal = (listing: Listing) => {
    setContactTarget(listing);
    setContactError("");
  };

  const saveContact = useCallback(async (listing: Listing) => {
    setContactBusy(true);
    setContactError("");
    const returnTo = marketplaceReturnRoute("save", listing.seller_id, listing.id);
    try {
      if (!await ensureChatSession(returnTo)) return;
      const currentContacts = await fetchContacts();
      if (currentContacts.has(listing.seller_id)) {
        setContactTarget(null);
        setNotice({ text: `${listing.seller_profile?.username || listing.seller_username} figure déjà dans vos contacts.` });
        return;
      }
      await api.post(`/messenger/contacts/${encodeURIComponent(listing.seller_id)}`);
      setSavedContactIds(previous => new Set(previous).add(listing.seller_id));
      setContactTarget(null);
      setNotice({ text: "Le vendeur a été enregistré dans vos contacts SPILOVEURE." });
    } catch (error: any) {
      setContactError(error?.detail || "Impossible d’enregistrer ce contact. Vérifiez votre connexion puis réessayez.");
    } finally {
      setContactBusy(false);
    }
  }, [ensureChatSession, fetchContacts]);

  const openChat = useCallback(async (listing: Listing) => {
    setNotice(null);
    const returnTo = marketplaceReturnRoute("chat", listing.seller_id, listing.id);
    if (!await ensureChatSession(returnTo)) return;
    try {
      const currentContacts = await fetchContacts();
      if (!currentContacts.has(listing.seller_id)) {
        setContactTarget(listing);
        setNotice({ text: "Enregistrez d’abord ce vendeur dans vos contacts pour lui écrire.", error: true });
        return;
      }
      setSocialBusy(previous => ({ ...previous, [`chat:${listing.id}`]: true }));
      const conversation = await messengerApi.createConversation({
        kind: "private", member_ids: [listing.seller_id],
      });
      router.push(marketplaceConversationRoute(conversation.id, listing.id) as any);
    } catch (error: any) {
      setNotice({ text: error?.detail || "Ce vendeur est indisponible ou ne peut pas recevoir de messages.", error: true });
    } finally {
      setSocialBusy(previous => ({ ...previous, [`chat:${listing.id}`]: false }));
    }
  }, [ensureChatSession, fetchContacts, router]);

  useEffect(() => {
    if (loading || !actionParam || !actionSellerId || !actionListingId) {
      if (!actionParam) handledAction.current = null;
      return;
    }
    const key = `${actionParam}:${actionSellerId}:${actionListingId}`;
    if (handledAction.current === key) return;
    handledAction.current = key;
    const listing = items.find(row => row.id === actionListingId && row.seller_id === actionSellerId);
    router.setParams({ marketplaceAction: "", sellerId: "", listingId: "" } as any);
    if (!listing) {
      setNotice({ text: "Cette annonce ou ce vendeur n’est plus disponible.", error: true });
      return;
    }
    if (actionParam === "save") void saveContact(listing);
    else if (actionParam === "chat") void openChat(listing);
  }, [actionParam, actionSellerId, actionListingId, items, loading, openChat, router, saveContact]);

  useEffect(() => {
    if (!listingQuery || !items.length) return;
    const index = items.findIndex(row => row.id === listingQuery);
    if (index < 0) return;
    requestAnimationFrame(() => listRef.current?.scrollToIndex({ index, animated: false }));
  }, [items, listingQuery]);

  const openWhatsapp = (number: string) => {
    const clean = number.replace(/[^0-9+]/g, "").replace(/^\+/, "");
    if (!clean || typeof window === "undefined") return;
    window.open(`https://wa.me/${clean}`, "_blank");
  };

  const toggleLike = async (listing: Listing) => {
    if (socialBusy[`like:${listing.id}`]) return;
    setSocialBusy(previous => ({ ...previous, [`like:${listing.id}`]: true }));
    try {
      const result = await api.post<{ liked_by_me: boolean; likes_count: number }>(
        `/marketplace/${encodeURIComponent(listing.id)}/like`, {},
      );
      setItems(previous => previous.map(row => row.id === listing.id
        ? { ...row, liked_by_me: result.liked_by_me, likes_count: result.likes_count }
        : row));
    } catch (error: any) {
      setNotice({ text: error?.detail || "Impossible de mettre à jour le J’aime.", error: true });
    } finally {
      setSocialBusy(previous => ({ ...previous, [`like:${listing.id}`]: false }));
    }
  };

  const openComments = async (listing: Listing) => {
    setCommentsTarget(listing);
    setComments([]);
    setCommentText("");
    setCommentsLoading(true);
    try {
      const result = await api.get<ListingComment[]>(
        `/marketplace/${encodeURIComponent(listing.id)}/comments`,
      );
      setComments(result);
    } catch (error: any) {
      setNotice({ text: error?.detail || "Impossible de charger les commentaires.", error: true });
    } finally {
      setCommentsLoading(false);
    }
  };

  const submitComment = async () => {
    if (!commentsTarget || !commentText.trim() || commentBusy) return;
    setCommentBusy(true);
    try {
      const created = await api.post<ListingComment>(
        `/marketplace/${encodeURIComponent(commentsTarget.id)}/comments`,
        { text: commentText.trim() },
      );
      setComments(previous => [...previous, created]);
      setItems(previous => previous.map(row => row.id === commentsTarget.id
        ? { ...row, comments_count: (row.comments_count || 0) + 1 }
        : row));
      setCommentText("");
    } catch (error: any) {
      setNotice({ text: error?.detail || "Impossible de publier le commentaire.", error: true });
    } finally {
      setCommentBusy(false);
    }
  };

  const shareListing = async (listing: Listing) => {
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "https://spiloveure.org";
      const url = marketplaceListingUrl(listing.id, origin);
      await Share.share({
        title: listing.name,
        message: marketplaceShareMessage(
          listing.name, listing.promo_price ?? listing.price, listing.currency, url,
        ),
      });
    } catch (error: any) {
      setNotice({ text: error?.message || "Le partage n’a pas pu être ouvert.", error: true });
    }
  };

  const rate = async (id: string) => {
    const raw = typeof window !== "undefined" ? window.prompt(t("marketplace.review_prompt")) : "";
    if (!raw) return;
    const [ratingText, ...rest] = raw.split("|");
    const rating = parseInt(ratingText.trim(), 10);
    if (isNaN(rating) || rating < 1 || rating > 5) {
      if (typeof window !== "undefined") window.alert(t("marketplace.rating_invalid"));
      return;
    }
    try {
      await api.post(`/marketplace/${id}/review`, { rating, comment: rest.join("|").trim() });
      if (typeof window !== "undefined") window.alert(t("marketplace.review_published"));
      await load();
    } catch (error: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${error?.detail || t("marketplace.failed")}`);
    }
  };

  const toggleAudio = (listing: Listing) => {
    if (Platform.OS !== "web" || !listing.audio) return;
    const element = audioRefs.current[listing.id];
    if (!element) return;
    if (audioPlaying === listing.id) {
      element.pause();
      setAudioPlaying(null);
    } else {
      Object.entries(audioRefs.current).forEach(([id, audio]) => {
        if (id !== listing.id && audio) audio.pause();
      });
      element.currentTime = 0;
      element.play().catch(() => {});
      setAudioPlaying(listing.id);
    }
  };

  const filteredItems = searchText.trim()
    ? items.filter(row => `${row.name} ${row.description} ${row.category} ${row.city} ${row.seller_username}`
      .toLocaleLowerCase().includes(searchText.trim().toLocaleLowerCase()))
    : items;

  const renderItem = ({ item }: { item: Listing }) => {
    const media = [
      ...(item.images || []).map(url => ({ kind: "image" as const, url })),
      ...(item.videos || []).map(url => ({ kind: "video" as const, url })),
    ];
    const index = Math.min(mediaIdx[item.id] || 0, Math.max(media.length - 1, 0));
    const current = media[index];
    const seller = item.seller_profile;
    const username = seller?.username || item.seller_username || "Vendeur";
    const avatar = seller?.avatar || "";
    const liked = Boolean(item.liked_by_me);
    const saved = savedContactIds.has(item.seller_id);
    const isPlaying = audioPlaying === item.id;
    const average = item.reviews?.length
      ? (item.reviews.reduce((sum, review) => sum + review.rating, 0) / item.reviews.length).toFixed(1)
      : null;

    return (
      <View style={[styles.feedPage, { height: pageHeight }]} testID={`mk-card-${item.id}`}>
        {current?.kind === "video" && Platform.OS === "web" ? (
          // @ts-ignore raw HTML video is supported by the Android WebView build.
          <video
            src={resolveMediaUrl(current.url)}
            autoPlay muted loop playsInline controls
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#050914" }}
            data-testid={`mk-video-${item.id}`}
          />
        ) : current?.kind === "image" ? (
          <Image
            source={{ uri: resolveMediaUrl(current.url) }}
            resizeMode="cover"
            style={StyleSheet.absoluteFill}
            testID={`mk-image-${item.id}`}
          />
        ) : (
          <View style={styles.noMedia}>
            <Ionicons name="image-outline" size={48} color="rgba(255,255,255,0.65)" />
            <Text style={styles.noMediaText}>Média indisponible</Text>
          </View>
        )}
        {current?.kind !== "video" && (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => media.length > 0 && lightbox.openAt(
              media, index, { title: item.name, description: item.description },
            )}
            accessibilityLabel="Afficher le média en plein écran"
            testID={`mk-open-media-${item.id}`}
          />
        )}
        <LinearGradient
          colors={["rgba(5,14,34,0.24)", "transparent", "rgba(5,14,34,0.86)"]}
          locations={[0, 0.38, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View style={styles.topOverlay} pointerEvents="box-none">
          {!!item.audio && Platform.OS === "web" && (
            <>
              <TouchableOpacity style={styles.audioButton} onPress={() => toggleAudio(item)} testID={`mk-audio-toggle-${item.id}`}>
                <Ionicons name={isPlaying ? "pause" : "musical-notes"} size={15} color="#fff" />
                <Text style={styles.audioText}>{isPlaying ? "Pause" : "Musique"}</Text>
              </TouchableOpacity>
              {/* @ts-ignore RN Web audio element */}
              <audio
                ref={(element: HTMLAudioElement | null) => { audioRefs.current[item.id] = element; }}
                src={resolveMediaUrl(item.audio || "")}
                loop
                onEnded={() => setAudioPlaying(null)}
                style={{ display: "none" }}
              />
            </>
          )}
          {media.length > 1 && (
            <View style={styles.mediaCount}>
              <Text style={styles.mediaCountText}>{index + 1} / {media.length}</Text>
            </View>
          )}
        </View>
        {media.length > 1 && (
          <>
            <TouchableOpacity
              style={[styles.mediaNav, { left: 10 }]}
              onPress={() => setMediaIdx(previous => ({ ...previous, [item.id]: (index - 1 + media.length) % media.length }))}
              testID={`mk-media-prev-${item.id}`}
              accessibilityLabel="Média précédent"
            >
              <Ionicons name="chevron-back" size={22} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.mediaNav, { right: 72 }]}
              onPress={() => setMediaIdx(previous => ({ ...previous, [item.id]: (index + 1) % media.length }))}
              testID={`mk-media-next-${item.id}`}
              accessibilityLabel="Média suivant"
            >
              <Ionicons name="chevron-forward" size={22} color="#fff" />
            </TouchableOpacity>
          </>
        )}

        <View style={styles.actionRail}>
          <View style={styles.sellerAvatarWrap}>
            <TouchableOpacity
              style={styles.avatarButton}
              onPress={() => openContactModal(item)}
              testID={`mk-contact-${item.id}`}
              accessibilityLabel={saved ? `${username}, contact enregistré` : `Ajouter ${username} aux contacts`}
            >
              {avatar
                ? <Image source={{ uri: resolveMediaUrl(avatar) }} style={styles.sellerAvatar} />
                : <View style={styles.avatarFallback}><Text style={styles.avatarLetter}>{username.slice(0, 1).toUpperCase()}</Text></View>}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.addContactBadge, saved && styles.savedContactBadge]}
              onPress={() => openContactModal(item)}
              testID={`mk-contact-add-${item.id}`}
              accessibilityLabel={saved ? "Contact déjà enregistré" : "Enregistrer le contact"}
            >
              <Ionicons name={saved ? "checkmark" : "add"} size={17} color="#fff" />
            </TouchableOpacity>
          </View>
          <ActionButton
            icon={liked ? "heart" : "heart-outline"}
            color={liked ? "#ff3f65" : "#fff"}
            label={`${item.likes_count || 0}`}
            testID={`mk-like-${item.id}`}
            onPress={() => void toggleLike(item)}
            busy={socialBusy[`like:${item.id}`]}
          />
          <ActionButton
            icon="chatbubble-ellipses"
            label={`${item.comments_count || 0}`}
            testID={`mk-comments-${item.id}`}
            onPress={() => void openComments(item)}
          />
          <ActionButton
            icon="chatbubbles"
            label="Chat"
            testID={`mk-chat-${item.id}`}
            onPress={() => void openChat(item)}
            busy={socialBusy[`chat:${item.id}`]}
          />
          <ActionButton
            icon="arrow-redo"
            label="Partager"
            testID={`mk-share-${item.id}`}
            onPress={() => void shareListing(item)}
          />
        </View>

        <View style={styles.listingDetails}>
          <View style={styles.sellerLine}>
            <Text style={styles.sellerName} numberOfLines={1}>{username}</Text>
            {seller?.verified && <Ionicons name="checkmark-circle" size={17} color="#68b4ff" />}
            <View style={styles.categoryPill}><Text style={styles.categoryText}>{item.category}</Text></View>
          </View>
          <Text style={styles.productName} numberOfLines={2}>{item.name}</Text>
          {!!item.description && (
            <Text
              style={styles.description}
              numberOfLines={expanded[item.id] ? 5 : 2}
              testID={`mk-desc-${item.id}`}
            >
              {item.description}
            </Text>
          )}
          <View style={styles.productMeta}>
            <Text style={styles.metaText}>📍 {item.city}</Text>
            {average && <Text style={styles.metaText}>⭐ {average}</Text>}
            {media.length > 1 && <Text style={styles.metaText}>• {media.length} médias</Text>}
          </View>
          <View style={styles.priceLine}>
            <Text style={styles.price}>
              {item.promo_price ?? item.price} {item.currency}
            </Text>
            {item.promo_price != null && (
              <Text style={styles.oldPrice}>{item.price} {item.currency}</Text>
            )}
          </View>
          <View style={styles.detailActions}>
            {!!item.description && item.description.length > 80 && (
              <TouchableOpacity
                onPress={() => setExpanded(previous => ({ ...previous, [item.id]: !previous[item.id] }))}
                testID={`mk-desc-toggle-${item.id}`}
              >
                <Text style={styles.detailLink}>{expanded[item.id] ? "Voir moins" : "Voir plus"}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => rate(item.id)} style={styles.whatsappAction} testID={`mk-rate-${item.id}`}>
              <Ionicons name="star-outline" size={15} color="#fff" />
              <Text style={styles.detailLink}>Avis</Text>
            </TouchableOpacity>
            {!!item.whatsapp && (
              <TouchableOpacity onPress={() => openWhatsapp(item.whatsapp)} style={styles.whatsappAction} testID={`mk-whatsapp-${item.id}`}>
                <Ionicons name="logo-whatsapp" size={15} color="#fff" />
                <Text style={styles.detailLink}>WhatsApp</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <ScreenContainer style={{ flex: 1, backgroundColor: "#fff" }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton} testID="mk-back" accessibilityLabel="Retour">
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        {searchOpen ? (
          <TextInput
            value={searchText}
            onChangeText={setSearchText}
            placeholder="Rechercher un produit"
            placeholderTextColor="rgba(255,255,255,0.72)"
            autoFocus
            style={styles.searchInput}
            returnKeyType="search"
            testID="mk-search-input"
          />
        ) : (
          <Text style={styles.headerTitle}>{t("marketplace.title")}</Text>
        )}
        <TouchableOpacity
          onPress={() => {
            if (searchOpen) { setSearchText(""); setSearchOpen(false); }
            else setSearchOpen(true);
          }}
          style={styles.headerButton}
          testID="mk-search"
          accessibilityLabel={searchOpen ? "Fermer la recherche" : "Rechercher"}
        >
          <Ionicons name={searchOpen ? "close" : "search"} size={22} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.push("/(app)/marketplace-create" as any)} style={styles.createButton} testID="mk-create" accessibilityLabel="Publier une annonce">
          <Ionicons name="add" size={25} color="#fff" />
        </TouchableOpacity>
      </View>
      {notice && (
        <View style={[styles.notice, notice.error && styles.noticeError]} testID="mk-notice">
          <Text style={styles.noticeText}>{notice.text}</Text>
          <TouchableOpacity onPress={() => setNotice(null)} accessibilityLabel="Fermer le message">
            <Ionicons name="close" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      )}
      {loading ? (
        <View style={styles.loadingState}><ActivityIndicator size="large" color={theme.colors.primary} /><Text style={styles.loadingText}>Chargement des annonces…</Text></View>
      ) : loadError ? (
        <View style={styles.emptyState}>
          <Ionicons name="cloud-offline-outline" size={42} color={theme.colors.primary} />
          <Text style={styles.emptyTitle}>Marketplace indisponible</Text>
          <Text style={styles.emptyText}>{loadError}</Text>
          <TouchableOpacity onPress={() => { setLoading(true); void load(); }} style={styles.retryButton} testID="mk-retry">
            <Text style={styles.retryText}>Réessayer</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.feedArea} onLayout={event => {
          const height = Math.round(event.nativeEvent.layout.height);
          if (height > 0 && height !== pageHeight) setPageHeight(height);
        }}>
          <FlatList
            ref={listRef}
            data={filteredItems}
            contentContainerStyle={{ flexGrow: 1, backgroundColor: "#fff" }}
            keyExtractor={row => row.id}
            renderItem={renderItem}
            getItemLayout={(_, index) => ({ length: pageHeight, offset: pageHeight * index, index })}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              listRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
            }}
            pagingEnabled
            snapToInterval={pageHeight}
            snapToAlignment="start"
            decelerationRate="fast"
            disableIntervalMomentum
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={theme.colors.primary} />}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            ListEmptyComponent={
              <View style={[styles.emptyState, { height: pageHeight }]}>
                <Ionicons name="cart-outline" size={48} color={theme.colors.primary} />
                <Text style={styles.emptyTitle}>{searchText ? "Aucune annonce trouvée" : t("marketplace.empty_title")}</Text>
                <Text style={styles.emptyText}>{searchText ? "Essayez un autre nom ou une autre catégorie." : t("marketplace.empty_hint")}</Text>
              </View>
            }
            testID="mk-feed"
          />
        </View>
      )}
      <BottomNav />
      <MediaLightbox
        open={lightbox.open}
        slides={lightbox.slides}
        index={lightbox.index}
        onClose={lightbox.close}
        onIndexChange={lightbox.setIndex}
        title={lightbox.title}
        description={lightbox.description}
        testID="mk-lightbox"
      />

      <Modal visible={!!contactTarget} transparent animationType="fade" onRequestClose={() => setContactTarget(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => !contactBusy && setContactTarget(null)} testID="mk-contact-backdrop">
          <Pressable onPress={event => event.stopPropagation()} style={styles.contactModal}>
            <TouchableOpacity
              style={styles.modalClose}
              onPress={() => setContactTarget(null)}
              disabled={contactBusy}
              accessibilityLabel="Fermer"
              testID="mk-contact-close"
            >
              <Ionicons name="close" size={21} color={theme.colors.textPrimary} />
            </TouchableOpacity>
            <View style={styles.contactIcon}><Ionicons name="person-add" size={28} color={theme.colors.primary} /></View>
            <Text style={styles.modalTitle}>Enregistrer le contact</Text>
            <Text style={styles.modalCopy}>Pour discuter avec ce vendeur, veuillez d’abord enregistrer son contact dans vos contacts.</Text>
            {contactTarget && (
              <View style={styles.sellerCard}>
                {contactTarget.seller_profile?.avatar
                  ? <Image source={{ uri: resolveMediaUrl(contactTarget.seller_profile.avatar) }} style={styles.modalAvatar} />
                  : <View style={[styles.modalAvatar, styles.modalAvatarFallback]}><Text style={styles.modalAvatarLetter}>{(contactTarget.seller_profile?.username || contactTarget.seller_username || "V").slice(0, 1).toUpperCase()}</Text></View>}
                <View style={styles.sellerCardText}>
                  <View style={styles.modalSellerNameLine}>
                    <Text style={styles.modalSellerName} numberOfLines={1}>{contactTarget.seller_profile?.username || contactTarget.seller_username || "Vendeur"}</Text>
                    {contactTarget.seller_profile?.verified && <Ionicons name="checkmark-circle" size={16} color={theme.colors.primary} />}
                  </View>
                  <Text style={styles.phoneText}>{contactTarget.whatsapp || "Numéro non communiqué"}</Text>
                </View>
                {savedContactIds.has(contactTarget.seller_id) && <Ionicons name="checkmark-circle" size={22} color={theme.colors.success} />}
              </View>
            )}
            {!!contactError && <Text style={styles.modalError} testID="mk-contact-error">{contactError}</Text>}
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => { setContactTarget(null); setContactError(""); }}
                disabled={contactBusy}
                testID="mk-contact-cancel"
              >
                <Text style={styles.cancelButtonText}>Annuler</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveButton, contactBusy && { opacity: 0.75 }]}
                onPress={() => contactTarget && void saveContact(contactTarget)}
                disabled={contactBusy || !contactTarget}
                testID="mk-contact-save"
              >
                {contactBusy
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Ionicons name={contactTarget && savedContactIds.has(contactTarget.seller_id) ? "checkmark" : "person-add"} size={17} color="#fff" />}
                <Text style={styles.saveButtonText}>
                  {contactBusy ? "Enregistrement…" : contactTarget && savedContactIds.has(contactTarget.seller_id) ? "Contact enregistré" : "Enregistrer le contact"}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={!!commentsTarget} transparent animationType="slide" onRequestClose={() => setCommentsTarget(null)}>
        <View style={styles.commentsBackdrop}>
          <KeyboardAvoidingView
            behavior="padding"
            style={styles.commentsSheet}
            keyboardVerticalOffset={isApkWebView ? 0 : 12}
          >
            <View style={styles.commentsHeader}>
              <View>
                <Text style={styles.commentsTitle}>Commentaires</Text>
                <Text style={styles.commentsSubtitle} numberOfLines={1}>{commentsTarget?.name}</Text>
              </View>
              <TouchableOpacity onPress={() => setCommentsTarget(null)} accessibilityLabel="Fermer les commentaires" testID="mk-comments-close">
                <Ionicons name="close" size={23} color={theme.colors.textPrimary} />
              </TouchableOpacity>
            </View>
            {commentsLoading ? <ActivityIndicator color={theme.colors.primary} style={{ padding: 22 }} /> : (
              <ScrollView style={styles.commentsList} contentContainerStyle={{ paddingBottom: 12 }} keyboardShouldPersistTaps="handled">
                {comments.length ? comments.map(comment => (
                  <View key={comment.id} style={styles.commentRow}>
                    <View style={styles.commentAvatar}><Text style={styles.commentAvatarText}>{comment.username.slice(0, 1).toUpperCase()}</Text></View>
                    <View style={styles.commentBody}>
                      <Text style={styles.commentName}>{comment.username}</Text>
                      <Text style={styles.commentText}>{comment.text}</Text>
                    </View>
                  </View>
                )) : (
                  <View style={styles.noComments}><Ionicons name="chatbubble-ellipses-outline" size={30} color={theme.colors.textMuted} /><Text style={styles.noCommentsText}>Soyez le premier à commenter.</Text></View>
                )}
              </ScrollView>
            )}
            <View style={styles.commentComposer}>
              <TextInput
                value={commentText}
                onChangeText={setCommentText}
                placeholder="Écrire un commentaire…"
                placeholderTextColor={theme.colors.textMuted}
                style={styles.commentInput}
                maxLength={1000}
                multiline
                returnKeyType="send"
                onSubmitEditing={() => void submitComment()}
                testID="mk-comment-input"
              />
              <TouchableOpacity
                onPress={() => void submitComment()}
                disabled={!commentText.trim() || commentBusy}
                style={[styles.commentSend, (!commentText.trim() || commentBusy) && { opacity: 0.45 }]}
                accessibilityLabel="Publier le commentaire"
                testID="mk-comment-send"
              >
                {commentBusy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="send" size={17} color="#fff" />}
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </ScreenContainer>
  );
}

function ActionButton({
  icon, label, color = "#fff", onPress, testID, busy = false,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string; color?: string; onPress: () => void; testID: string; busy?: boolean;
}) {
  return (
    <TouchableOpacity style={styles.actionButton} onPress={onPress} testID={testID} accessibilityRole="button" accessibilityLabel={`${label}`}>
      <View style={styles.actionIcon}>
        {busy ? <ActivityIndicator size="small" color={color} /> : <Ionicons name={icon} size={25} color={color} />}
      </View>
      <Text style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  header: { minHeight: 58, backgroundColor: theme.colors.primary, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 10, zIndex: 2 },
  headerButton: { width: 38, height: 38, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.16)", alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: "#fff", fontWeight: "900", fontSize: 19 },
  searchInput: { flex: 1, height: 42, color: "#fff", fontSize: 15, outlineStyle: "none" as any },
  createButton: { width: 40, height: 40, borderRadius: 22, backgroundColor: "#10B981", alignItems: "center", justifyContent: "center" },
  notice: { zIndex: 3, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#10845f", paddingHorizontal: 14, paddingVertical: 9 },
  noticeError: { backgroundColor: "#a62e3d" },
  noticeText: { flex: 1, color: "#fff", fontSize: 12, fontWeight: "700", lineHeight: 17 },
  feedArea: { flex: 1, backgroundColor: "#050914" },
  feedPage: { width: "100%", overflow: "hidden", backgroundColor: "#050914" },
  noMedia: { ...StyleSheet.absoluteFillObject, justifyContent: "center", alignItems: "center", backgroundColor: "#111c32" },
  noMediaText: { color: "rgba(255,255,255,0.75)", marginTop: 8, fontWeight: "700" },
  topOverlay: { position: "absolute", top: 12, left: 12, right: 12, zIndex: 2, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  audioButton: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 18, backgroundColor: "rgba(0,0,0,0.45)" },
  audioText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  mediaCount: { marginLeft: "auto", backgroundColor: "rgba(0,0,0,0.48)", borderRadius: 15, paddingHorizontal: 10, paddingVertical: 5 },
  mediaCountText: { color: "#fff", fontWeight: "800", fontSize: 11 },
  mediaNav: { position: "absolute", top: "48%", zIndex: 3, width: 38, height: 38, borderRadius: 20, backgroundColor: "rgba(0,0,0,0.42)", alignItems: "center", justifyContent: "center" },
  actionRail: { position: "absolute", right: 10, bottom: 136, zIndex: 3, alignItems: "center", gap: 15 },
  sellerAvatarWrap: { width: 52, height: 58, alignItems: "center", marginBottom: 2 },
  avatarButton: { width: 48, height: 48, borderRadius: 25, borderWidth: 2, borderColor: "#fff", overflow: "hidden", backgroundColor: "#dbeafe" },
  sellerAvatar: { width: "100%", height: "100%" },
  avatarFallback: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.primary },
  avatarLetter: { color: "#fff", fontWeight: "900", fontSize: 20 },
  addContactBadge: { position: "absolute", bottom: 0, width: 23, height: 23, borderRadius: 12, backgroundColor: "#ee3d65", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#fff" },
  savedContactBadge: { backgroundColor: "#10B981" },
  actionButton: { minWidth: 48, alignItems: "center", gap: 2 },
  actionIcon: { width: 44, height: 44, borderRadius: 23, backgroundColor: "rgba(0,0,0,0.28)", alignItems: "center", justifyContent: "center" },
  actionLabel: { color: "#fff", textAlign: "center", fontSize: 10, fontWeight: "800", textShadowColor: "rgba(0,0,0,0.7)", textShadowRadius: 4, maxWidth: 54 },
  listingDetails: { position: "absolute", left: 16, right: 76, bottom: 112, zIndex: 2, gap: 5 },
  sellerLine: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 2 },
  sellerName: { color: "#fff", fontSize: 15, fontWeight: "900", maxWidth: "72%", textShadowColor: "rgba(0,0,0,.65)", textShadowRadius: 5 },
  categoryPill: { marginLeft: "auto", backgroundColor: "rgba(255,255,255,0.2)", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  categoryText: { color: "#fff", fontSize: 9, fontWeight: "800" },
  productName: { color: "#fff", fontSize: 15, fontWeight: "900", lineHeight: 20, textShadowColor: "rgba(0,0,0,.8)", textShadowRadius: 5 },
  description: { color: "rgba(255,255,255,0.96)", fontSize: 12, lineHeight: 17, textShadowColor: "rgba(0,0,0,.85)", textShadowRadius: 4 },
  productMeta: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 1 },
  metaText: { color: "rgba(255,255,255,0.92)", fontSize: 10, fontWeight: "700", textShadowColor: "rgba(0,0,0,.8)", textShadowRadius: 4 },
  priceLine: { flexDirection: "row", alignItems: "baseline", gap: 8, marginTop: 1 },
  price: { color: "#fff", fontSize: 18, fontWeight: "900", textShadowColor: "rgba(0,0,0,.9)", textShadowRadius: 5 },
  oldPrice: { color: "rgba(255,255,255,0.72)", fontSize: 12, textDecorationLine: "line-through" },
  detailActions: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 1 },
  detailLink: { color: "#fff", fontSize: 11, fontWeight: "800", textShadowColor: "rgba(0,0,0,.9)", textShadowRadius: 4 },
  whatsappAction: { flexDirection: "row", alignItems: "center", gap: 4 },
  loadingState: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#fff", gap: 12 },
  loadingText: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "700" },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#fff", paddingHorizontal: 28, gap: 9 },
  emptyTitle: { color: theme.colors.textPrimary, fontSize: 17, fontWeight: "900", textAlign: "center", marginTop: 6 },
  emptyText: { color: theme.colors.textSecondary, textAlign: "center", fontSize: 13, lineHeight: 19 },
  retryButton: { marginTop: 8, paddingHorizontal: 22, paddingVertical: 11, backgroundColor: theme.colors.primary, borderRadius: 13 },
  retryText: { color: "#fff", fontWeight: "900" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(5,15,35,0.64)", justifyContent: "center", alignItems: "center", padding: 18 },
  contactModal: { width: "100%", maxWidth: 410, borderRadius: 24, backgroundColor: "#fff", padding: 22, alignItems: "center", ...theme.shadow.lifted },
  modalClose: { position: "absolute", right: 12, top: 12, width: 34, height: 34, borderRadius: 18, backgroundColor: "#F1F5F9", alignItems: "center", justifyContent: "center" },
  contactIcon: { width: 58, height: 58, borderRadius: 18, backgroundColor: theme.colors.primaryBg, alignItems: "center", justifyContent: "center", marginTop: 4, marginBottom: 10 },
  modalTitle: { color: theme.colors.textPrimary, fontSize: 20, fontWeight: "900", textAlign: "center" },
  modalCopy: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 7, marginBottom: 17 },
  sellerCard: { width: "100%", minHeight: 70, flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: 15, backgroundColor: "#F8FAFC", borderWidth: 1, borderColor: theme.colors.border },
  modalAvatar: { width: 48, height: 48, borderRadius: 25 },
  modalAvatarFallback: { backgroundColor: theme.colors.primaryBg, alignItems: "center", justifyContent: "center" },
  modalAvatarLetter: { color: theme.colors.primary, fontWeight: "900", fontSize: 19 },
  sellerCardText: { flex: 1, minWidth: 0 },
  modalSellerNameLine: { flexDirection: "row", alignItems: "center", gap: 5 },
  modalSellerName: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: "900", flexShrink: 1 },
  phoneText: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 4 },
  modalError: { width: "100%", color: "#b42335", fontSize: 12, lineHeight: 17, backgroundColor: "#fff0f1", padding: 9, borderRadius: 10, marginTop: 10 },
  modalButtons: { width: "100%", flexDirection: "row", gap: 9, marginTop: 16 },
  cancelButton: { minHeight: 48, minWidth: 90, flex: 0.8, paddingHorizontal: 12, borderRadius: 14, backgroundColor: "#EEF2F7", alignItems: "center", justifyContent: "center" },
  cancelButtonText: { color: theme.colors.textPrimary, fontWeight: "900", fontSize: 13 },
  saveButton: { minHeight: 48, flex: 1.4, paddingHorizontal: 12, borderRadius: 14, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 7 },
  saveButtonText: { color: "#fff", fontWeight: "900", fontSize: 12, textAlign: "center" },
  commentsBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(5,15,35,0.58)" },
  commentsSheet: { maxHeight: "82%", minHeight: "48%", backgroundColor: "#fff", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 18, paddingTop: 17, paddingBottom: Platform.OS === "web" ? 14 : 24 },
  commentsHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  commentsTitle: { color: theme.colors.textPrimary, fontSize: 17, fontWeight: "900" },
  commentsSubtitle: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2, maxWidth: 280 },
  commentsList: { flexGrow: 1, flexShrink: 1, marginTop: 6 },
  commentRow: { flexDirection: "row", alignItems: "flex-start", gap: 9, paddingVertical: 10 },
  commentAvatar: { width: 32, height: 32, borderRadius: 17, backgroundColor: theme.colors.primaryBg, alignItems: "center", justifyContent: "center" },
  commentAvatarText: { color: theme.colors.primary, fontSize: 13, fontWeight: "900" },
  commentBody: { flex: 1 },
  commentName: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "900", marginBottom: 2 },
  commentText: { color: theme.colors.textPrimary, fontSize: 13, lineHeight: 18 },
  noComments: { alignItems: "center", justifyContent: "center", paddingVertical: 34, gap: 8 },
  noCommentsText: { color: theme.colors.textSecondary, fontSize: 13 },
  commentComposer: { flexDirection: "row", alignItems: "flex-end", gap: 9, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.border },
  commentInput: { flex: 1, minHeight: 44, maxHeight: 100, borderRadius: 15, backgroundColor: "#F1F5F9", paddingHorizontal: 13, paddingVertical: 10, color: theme.colors.textPrimary, fontSize: 13, outlineStyle: "none" as any },
  commentSend: { width: 42, height: 42, borderRadius: 22, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },
});

export default function MarketplaceScreen() {
  const { t } = useI18n();
  return (
    <FeatureGuard featureKey="marketplace" title={t("marketplace.disabled")}>
      <MarketplaceScreenInner />
    </FeatureGuard>
  );
}
