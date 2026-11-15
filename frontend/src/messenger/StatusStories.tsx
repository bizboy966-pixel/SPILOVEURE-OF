import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Image, Modal, Platform, Pressable, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import type { Attachment, ChatStatus } from "./types";
import { protectedFileUrl } from "./api";

const blue = "#1769e8";
const ink = "#102042";
const muted = "#7d879a";

type Props = {
  userId: string; version?: number; requestedAuthorId?: string | null;
  onRequestConsumed?: () => void; onViewerClose?: () => void;
};

export default function StatusStories({ userId, version = 0, requestedAuthorId, onRequestConsumed, onViewerClose }: Props) {
  const [items, setItems] = useState<ChatStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [openAuthorId, setOpenAuthorId] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [mediaUrl, setMediaUrl] = useState("");
  const [paused, setPaused] = useState(false);
  const [storyProgress, setStoryProgress] = useState(0);
  const progressRef = useRef(0);
  const videoElement = useRef<HTMLVideoElement | null>(null);
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const videoHost = useRef<View | null>(null);

  const load = async () => {
    try { setItems(await api.get<ChatStatus[]>("/messenger/statuses")); setError(""); }
    catch (e: any) { setError(e?.detail || "Impossible de charger les statuts."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [userId]);
  useEffect(() => { if (version > 0) void load(); }, [version]);
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(timer);
  }, [userId]);

  const groups = useMemo(() => {
    const map = new Map<string, ChatStatus[]>();
    for (const status of items) {
      const group = map.get(status.author_id) || [];
      group.push(status);
      map.set(status.author_id, group);
    }
    return [...map.entries()].map(([authorId, statuses]) => ({ authorId, statuses }));
  }, [items]);
  const ownStatuses = groups.find(group => group.authorId === userId)?.statuses || [];
  const selectedGroup = groups.find(group => group.authorId === openAuthorId);
  const story = selectedGroup?.statuses[activeIndex];
  const media = story?.attachments?.[0];
  const holdStory = () => { setPaused(true); videoElement.current?.pause(); };
  const resumeStory = () => {
    setPaused(false);
    if (videoElement.current) void videoElement.current.play().catch(() => undefined);
  };

  useEffect(() => {
    if (!requestedAuthorId || loading) return;
    if (groups.some(group => group.authorId === requestedAuthorId)) {
      setOpenAuthorId(requestedAuthorId);
      setActiveIndex(0);
      setPaused(false);
      progressRef.current = 0;
      setStoryProgress(0);
    } else {
      onViewerClose?.();
    }
    onRequestConsumed?.();
  }, [requestedAuthorId, loading, groups]);

  useEffect(() => {
    if (!media) { setMediaUrl(""); return; }
    let active = true;
    let objectUrl = "";
    protectedFileUrl(media.id).then(url => {
      objectUrl = url;
      if (active) setMediaUrl(url);
      else URL.revokeObjectURL(url);
    }).catch(() => { if (active) setMediaUrl(""); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [media?.id]);

  useEffect(() => {
    const host = videoHost.current as unknown as HTMLElement | null;
    if (!story || !mediaUrl || !media?.mime.startsWith("video/") || Platform.OS !== "web" || !host) return;
    const video = document.createElement("video");
    videoElement.current = video;
    video.src = mediaUrl;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.width = "100%";
    video.style.maxHeight = "72vh";
    video.style.objectFit = "contain";
    video.onended = () => advance();
    host.replaceChildren(video);
    return () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      host.replaceChildren();
    };
  }, [story?.id, media?.mime, mediaUrl]);

  const closeViewer = () => {
    setOpenAuthorId(null);
    setActiveIndex(0);
    setPaused(false);
    progressRef.current = 0;
    setStoryProgress(0);
    onViewerClose?.();
  };
  const advance = () => {
    if (!selectedGroup) return;
    if (activeIndex + 1 >= selectedGroup.statuses.length) closeViewer();
    else setActiveIndex(index => index + 1);
  };
  const goBack = () => {
    progressRef.current = 0;
    setStoryProgress(0);
    setActiveIndex(index => Math.max(0, index - 1));
  };
  useEffect(() => {
    if (!story || !openAuthorId) return;
    if (story.author_id !== userId && !story.viewed_by_me) {
      api.post(`/messenger/statuses/${encodeURIComponent(story.id)}/view`, {}).then(() => {
        setItems(previous => previous.map(item => item.id === story.id ? { ...item, viewed_by_me: true } : item));
      }).catch(() => {});
    }
    progressRef.current = 0;
    setStoryProgress(0);
  }, [story?.id]);
  useEffect(() => {
    if (!story || !openAuthorId || paused || media?.mime.startsWith("video/")) return;
    const startedAt = Date.now() - progressRef.current * 6000;
    const timer = setInterval(() => {
      const next = Math.min(1, (Date.now() - startedAt) / 6000);
      progressRef.current = next;
      setStoryProgress(next);
      if (next >= 1) {
        clearInterval(timer);
        advance();
      }
    }, 80);
    return () => clearInterval(timer);
  }, [story?.id, openAuthorId, activeIndex, paused, media?.mime]);

  const openGroup = (authorId: string) => {
    setOpenAuthorId(authorId);
    setActiveIndex(0);
    setPaused(false);
    progressRef.current = 0;
    setStoryProgress(0);
  };

  const chooseMedia = () => {
    if (Platform.OS !== "web" || typeof document === "undefined") {
      setError("L’ajout de photo ou vidéo est disponible depuis la version web.");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,video/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) { setError("La photo ou vidéo dépasse 20 Mo."); return; }
      setUploading(true);
      setError("");
      try {
        const uploaded = await api.upload<Attachment>("/messenger/feed/files", file);
        setAttachment(uploaded);
      } catch (e: any) { setError(e?.detail || "Ajout du média impossible."); }
      finally { setUploading(false); }
    };
    input.click();
  };

  const publish = async () => {
    if (!text.trim() && !attachment) return;
    setPublishing(true);
    setError("");
    try {
      await api.post("/messenger/statuses", {
        text: text.trim(), attachments: attachment ? [attachment] : [],
      });
      setText("");
      setAttachment(null);
      setComposeOpen(false);
      await load();
    } catch (e: any) { setError(e?.detail || "Publication du statut impossible."); }
    finally { setPublishing(false); }
  };

  const deleteStory = async () => {
    if (!story || story.author_id !== userId) return;
    if (typeof window !== "undefined" && !window.confirm("Supprimer ce statut ?")) return;
    try {
      await api.delete(`/messenger/statuses/${encodeURIComponent(story.id)}`);
      const remaining = selectedGroup?.statuses.length || 0;
      setItems(previous => previous.filter(item => item.id !== story.id));
      if (remaining <= 1 || activeIndex >= remaining - 1) closeViewer();
      else setActiveIndex(index => index + 1);
    } catch (e: any) { setError(e?.detail || "Suppression impossible."); }
  };

  const authorName = (authorId: string) =>
    items.find(item => item.author_id === authorId)?.author_name || (authorId === userId ? "Mon statut" : "Membre");
  const authorAvatar = (authorId: string) =>
    items.find(item => item.author_id === authorId)?.author_avatar || "";
  const authorUnread = (authorId: string) =>
    (groups.find(group => group.authorId === authorId)?.statuses || []).some(item => !item.viewed_by_me);

  return <View style={styles.wrap} testID="messenger-statuses">
    <View style={styles.sectionHead}>
      <View><Text style={styles.title}>Statuts</Text><Text style={styles.subtitle}>Photos, vidéos ou texte · visibles 24 heures</Text></View>
      <TouchableOpacity onPress={load} accessibilityLabel="Actualiser les statuts"><Ionicons name="refresh" size={18} color={blue} /></TouchableOpacity>
    </View>
    {!!error && <TouchableOpacity onPress={load} style={styles.error}><Text style={styles.errorText}>{error}</Text></TouchableOpacity>}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.storyRow}>
      <View style={styles.storyPerson}>
        <TouchableOpacity style={[styles.storyRing, ownStatuses.length > 0 ? styles.storyRingSeen : undefined]} onPress={() => ownStatuses.length ? openGroup(userId) : setComposeOpen(true)} testID="status-open-own">
          <View style={styles.storyAvatar}>
            {ownStatuses[0]?.author_avatar ? <Image source={{ uri: ownStatuses[0].author_avatar }} style={styles.storyAvatarImage} /> : <Ionicons name="person" size={23} color={blue} />}
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.addStatus} onPress={() => { setComposeOpen(true); setError(""); }} accessibilityLabel="Ajouter un statut"><Ionicons name="add" size={16} color="#fff" /></TouchableOpacity>
        <Text style={styles.storyName} numberOfLines={1}>Mon statut</Text>
      </View>
      {groups.filter(group => group.authorId !== userId).map(group => {
        const unread = authorUnread(group.authorId);
        return <TouchableOpacity key={group.authorId} style={styles.storyPerson} onPress={() => openGroup(group.authorId)} testID={`status-open-${group.authorId}`}>
          <View style={[styles.storyRing, unread ? styles.storyRingNew : styles.storyRingSeen]}>
            <View style={styles.storyAvatar}>
              {authorAvatar(group.authorId) ? <Image source={{ uri: authorAvatar(group.authorId) }} style={styles.storyAvatarImage} /> : <Text style={styles.storyInitial}>{authorName(group.authorId).slice(0, 1).toUpperCase()}</Text>}
            </View>
          </View>
          <Text style={styles.storyName} numberOfLines={1}>{authorName(group.authorId)}</Text>
        </TouchableOpacity>;
      })}
      {loading && !items.length && <ActivityIndicator color={blue} style={{ marginHorizontal: 12 }} />}
      {!loading && !groups.length && <Text style={styles.empty}>Aucun statut de contact pour le moment.</Text>}
    </ScrollView>

    <Modal visible={composeOpen} transparent animationType="slide" onRequestClose={() => setComposeOpen(false)}>
      <View style={styles.modalBackdrop}><View style={styles.composeSheet}>
        <View style={styles.sheetHead}><Text style={styles.sheetTitle}>Nouveau statut</Text><TouchableOpacity onPress={() => setComposeOpen(false)}><Ionicons name="close" size={23} color={muted} /></TouchableOpacity></View>
        <TextInput value={text} onChangeText={setText} placeholder="Écrivez un statut…" multiline maxLength={800} style={styles.statusInput} testID="status-text-input" />
        {attachment && <View style={styles.attachmentRow}><Ionicons name={attachment.mime.startsWith("video/") ? "videocam" : "image"} size={17} color={blue} /><Text style={styles.attachmentName} numberOfLines={1}>{attachment.name}</Text><TouchableOpacity onPress={() => setAttachment(null)}><Ionicons name="close-circle" size={19} color={muted} /></TouchableOpacity></View>}
        <Text style={styles.privacy}>Partagé avec vos contacts pendant 24 heures.</Text>
        <View style={styles.composeActions}>
          <TouchableOpacity style={styles.mediaButton} onPress={chooseMedia} disabled={uploading}><Ionicons name="image-outline" size={18} color={blue} /><Text style={styles.mediaButtonText}>{uploading ? "Ajout…" : "Photo ou vidéo"}</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.publishButton, (!text.trim() && !attachment || publishing) && styles.disabled]} onPress={publish} disabled={(!text.trim() && !attachment) || publishing} testID="status-publish">
            {publishing ? <ActivityIndicator color="#fff" /> : <Text style={styles.publishText}>Publier</Text>}
          </TouchableOpacity>
        </View>
      </View></View>
    </Modal>

    <Modal visible={!!story} transparent animationType="fade" onRequestClose={closeViewer}>
      <View style={styles.viewer}>
        <View style={styles.viewerTop}>
          <View style={styles.progressRow}>{selectedGroup?.statuses.map((item, index) => <View key={item.id} style={styles.progressTrack}><View style={[styles.progressFill, { width: index < activeIndex ? "100%" : index === activeIndex ? `${storyProgress * 100}%` : "0%" }]} /></View>)}</View>
          <View style={styles.viewerHeader}>
            <View style={styles.viewerAvatar}>{story?.author_avatar ? <Image source={{ uri: story.author_avatar }} style={styles.viewerAvatarImage} /> : <Text style={styles.viewerInitial}>{story?.author_name.slice(0, 1).toUpperCase()}</Text>}</View>
            <View style={{ flex: 1 }}><Text style={styles.viewerName}>{story?.author_name}</Text><Text style={styles.viewerTime}>{story?.created_at ? new Date(story.created_at).toLocaleString() : ""}</Text></View>
            {story?.author_id === userId && <TouchableOpacity onPress={deleteStory} accessibilityLabel="Supprimer mon statut"><Ionicons name="trash-outline" size={20} color="#fff" /></TouchableOpacity>}
            <TouchableOpacity onPress={closeViewer} accessibilityLabel="Fermer le statut"><Ionicons name="close" size={25} color="#fff" /></TouchableOpacity>
          </View>
        </View>
        <Pressable
          style={styles.storyContent}
          onPressIn={holdStory}
          onPressOut={resumeStory}
        >
          {media?.mime.startsWith("image/") && mediaUrl ? <Image source={{ uri: mediaUrl }} style={styles.storyMedia} resizeMode="contain" /> : null}
          {media?.mime.startsWith("video/") && <View ref={videoHost} style={styles.videoHost}>{!mediaUrl && <ActivityIndicator color="#fff" />}</View>}
          {!media && <Text style={styles.storyText}>{story?.text}</Text>}
          {!!story?.text && !!media && <Text style={styles.storyCaption}>{story.text}</Text>}
          <TouchableOpacity style={styles.leftTap} onPress={goBack} accessibilityLabel="Statut précédent" />
          <TouchableOpacity style={styles.rightTap} onPress={advance} accessibilityLabel="Statut suivant" />
          {paused && <View pointerEvents="none" style={styles.pauseMark}><Ionicons name="pause" size={22} color="#fff" /></View>}
        </Pressable>
        {story?.author_id === userId && <Text style={styles.viewCount}><Ionicons name="eye-outline" size={16} color="#fff" /> {story.views_count || 0} vues</Text>}
      </View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: "#fff", borderBottomWidth: 1, borderColor: "#edf0f4", paddingTop: 12 },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 15, marginBottom: 8 },
  title: { color: ink, fontWeight: "900", fontSize: 17 }, subtitle: { color: muted, fontSize: 11, marginTop: 2 },
  storyRow: { flexDirection: "row", alignItems: "flex-start", gap: 15, paddingHorizontal: 14, paddingBottom: 12 },
  storyPerson: { width: 62, alignItems: "center", position: "relative" },
  storyRing: { width: 56, height: 56, borderRadius: 29, borderWidth: 2, padding: 3, alignItems: "center", justifyContent: "center" },
  storyRingNew: { borderColor: "#13b981" }, storyRingSeen: { borderColor: "#c8d0dc" },
  storyAvatar: { width: 46, height: 46, borderRadius: 24, backgroundColor: "#eaf1ff", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  storyAvatarImage: { width: 46, height: 46, borderRadius: 24 }, storyInitial: { color: blue, fontWeight: "900", fontSize: 18 },
  addStatus: { position: "absolute", right: 1, top: 35, width: 21, height: 21, borderRadius: 11, backgroundColor: blue, borderWidth: 2, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  storyName: { color: ink, fontSize: 10, fontWeight: "700", textAlign: "center", marginTop: 5, width: 60 },
  empty: { color: muted, fontSize: 12, alignSelf: "center", paddingVertical: 17 },
  error: { marginHorizontal: 14, marginBottom: 7, backgroundColor: "#fff1f0", borderRadius: 10, padding: 8 }, errorText: { color: "#b83a42", fontSize: 12 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(10,20,38,.5)", justifyContent: "flex-end" },
  composeSheet: { backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, paddingBottom: 30 },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  sheetTitle: { color: ink, fontSize: 18, fontWeight: "900" },
  statusInput: { minHeight: 125, maxHeight: 220, color: ink, fontSize: 16, textAlignVertical: "top", backgroundColor: "#f6f8fb", borderRadius: 14, padding: 13, outlineStyle: "none" as any },
  attachmentRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#eef4ff", borderRadius: 10, padding: 9, marginTop: 9 },
  attachmentName: { flex: 1, color: ink, fontSize: 12 },
  privacy: { color: muted, fontSize: 11, marginTop: 10 },
  composeActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 14 },
  mediaButton: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 18, backgroundColor: "#eef4ff" },
  mediaButtonText: { color: blue, fontSize: 12, fontWeight: "800" },
  publishButton: { backgroundColor: blue, minWidth: 104, alignItems: "center", justifyContent: "center", paddingVertical: 11, paddingHorizontal: 18, borderRadius: 20 },
  publishText: { color: "#fff", fontSize: 13, fontWeight: "900" }, disabled: { opacity: .48 },
  viewer: { flex: 1, backgroundColor: "#0b1220", justifyContent: "space-between" },
  viewerTop: { paddingTop: 42, paddingHorizontal: 12, zIndex: 2 },
  progressRow: { flexDirection: "row", gap: 4, marginBottom: 10 },
  progressTrack: { height: 3, flex: 1, borderRadius: 3, backgroundColor: "rgba(255,255,255,.28)", overflow: "hidden" },
  progressFill: { width: "0%", height: "100%", backgroundColor: "#fff" }, progressFilled: { width: "100%" },
  viewerHeader: { flexDirection: "row", alignItems: "center", gap: 9 },
  viewerAvatar: { width: 35, height: 35, borderRadius: 18, backgroundColor: "#42516a", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  viewerAvatarImage: { width: 35, height: 35, borderRadius: 18 }, viewerInitial: { color: "#fff", fontWeight: "900" },
  viewerName: { color: "#fff", fontSize: 13, fontWeight: "900" }, viewerTime: { color: "rgba(255,255,255,.7)", fontSize: 10, marginTop: 2 },
  storyContent: { flex: 1, alignItems: "center", justifyContent: "center", position: "relative", padding: 14 },
  storyMedia: { width: "100%", height: "78%" }, videoHost: { width: "100%", alignItems: "center", justifyContent: "center" },
  storyText: { color: "#fff", fontSize: 27, lineHeight: 36, fontWeight: "800", textAlign: "center", paddingHorizontal: 24 },
  storyCaption: { color: "#fff", fontSize: 15, lineHeight: 21, textAlign: "center", paddingHorizontal: 12, paddingTop: 10 },
  leftTap: { position: "absolute", top: 0, bottom: 0, left: 0, width: "35%" }, rightTap: { position: "absolute", top: 0, bottom: 0, right: 0, width: "65%" },
  pauseMark: { position: "absolute", alignSelf: "center", top: "46%", width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(0,0,0,.48)", alignItems: "center", justifyContent: "center" },
  viewCount: { color: "#fff", alignSelf: "center", paddingBottom: 28, fontSize: 12, fontWeight: "700" },
});
