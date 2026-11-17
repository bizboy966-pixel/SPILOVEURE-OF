import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Image, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import type { Attachment, ChatStatus } from "./types";
import { protectedFileUrl } from "./api";
import { chatVisual } from "./chatVisualTokens";

const blue = chatVisual.brand;
const ink = chatVisual.ink;
const muted = chatVisual.muted;

type Props = {
  userId: string; version?: number; requestedAuthorId?: string | null; requestedStatusId?: string | null;
  onRequestConsumed?: () => void; onViewerClose?: () => void;
  onReply?: (authorId: string, text: string, statusId: string, voice?: Blob) => Promise<void>;
};

export default function StatusStories({ userId, version = 0, requestedAuthorId, requestedStatusId, onRequestConsumed, onViewerClose, onReply }: Props) {
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
  const [viewersOpen, setViewersOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [recordingReply, setRecordingReply] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const progressRef = useRef(0);
  const videoElement = useRef<HTMLVideoElement | null>(null);
  const storyContentRef = useRef<View | null>(null);
  const heldStoryId = useRef<string | null>(null);
  const currentStoryId = useRef<string | null>(null);
  const replyRecorder = useRef<MediaRecorder | null>(null);
  const replyStream = useRef<MediaStream | null>(null);
  const replyChunks = useRef<BlobPart[]>([]);
  const discardReplyVoice = useRef(false);
  const sendVoiceOnStop = useRef(false);
  const touchStartX = useRef<number | null>(null);
  const lastSwipeAt = useRef(0);
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
  currentStoryId.current = story?.id || null;
  const media = story?.attachments?.[0];
  const holdStory = () => {
    if (!story) return;
    heldStoryId.current = story.id;
    setPaused(true);
    videoElement.current?.pause();
  };
  const resumeStory = () => {
    const heldId = heldStoryId.current;
    heldStoryId.current = null;
    if (!heldId || currentStoryId.current !== heldId) return;
    setPaused(false);
    if (videoElement.current) void videoElement.current.play().catch(() => undefined);
  };

  useEffect(() => {
    if (!recordingReply) return;
    const timer = setInterval(() => setRecordingSeconds(seconds => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [recordingReply]);
  useEffect(() => () => {
    replyRecorder.current?.state === "recording" && replyRecorder.current.stop();
    replyStream.current?.getTracks().forEach(track => track.stop());
  }, []);

  useEffect(() => {
    if (!requestedAuthorId || loading) return;
    const group = groups.find(item => item.authorId === requestedAuthorId);
    if (group) {
      setOpenAuthorId(requestedAuthorId);
      const firstUnseen = requestedAuthorId === userId ? -1 : group.statuses.findIndex(item => !item.viewed_by_me);
      const requestedIndex = requestedStatusId ? group.statuses.findIndex(item => item.id === requestedStatusId) : -1;
      setActiveIndex(requestedIndex >= 0 ? requestedIndex : firstUnseen >= 0 ? firstUnseen : 0);
      setPaused(false);
      heldStoryId.current = null;
      progressRef.current = 0;
      setStoryProgress(0);
    } else {
      onViewerClose?.();
    }
    onRequestConsumed?.();
  }, [requestedAuthorId, requestedStatusId, loading, groups]);
  useEffect(() => {
    setReplyText("");
    setViewersOpen(false);
  }, [story?.id]);

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

  useEffect(() => {
    if (Platform.OS !== "web" || !story) return;
    const node = storyContentRef.current as unknown as HTMLElement | null;
    if (!node) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      holdStory();
    };
    const onPointerUp = () => resumeStory();
    node.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      node.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [story?.id]);

  const cancelReplyVoice = () => {
    const recorder = replyRecorder.current;
    discardReplyVoice.current = true;
    sendVoiceOnStop.current = false;
    if (recorder?.state === "recording") recorder.stop();
    replyStream.current?.getTracks().forEach(track => track.stop());
    setRecordingReply(false);
    resumeStory();
  };
  const startReplyVoice = async () => {
    if (!story || story.author_id === userId || !onReply || replyBusy || recordingReply) return;
    if (Platform.OS !== "web" || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("L’enregistrement vocal est disponible dans le navigateur.");
      return;
    }
    const voiceStory = story;
    holdStory();
    Keyboard.dismiss();
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (currentStoryId.current !== voiceStory.id) {
        stream.getTracks().forEach(track => track.stop());
        resumeStory();
        return;
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      replyStream.current = stream;
      replyChunks.current = [];
      discardReplyVoice.current = false;
      sendVoiceOnStop.current = false;
      recorder.ondataavailable = event => {
        if (event.data?.size) replyChunks.current.push(event.data);
      };
      recorder.onstop = () => {
        const shouldSend = sendVoiceOnStop.current && !discardReplyVoice.current;
        const chunks = replyChunks.current.splice(0);
        replyRecorder.current = null;
        replyStream.current?.getTracks().forEach(track => track.stop());
        replyStream.current = null;
        setRecordingReply(false);
        if (!shouldSend) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (!blob.size) {
          setError("L’enregistrement vocal est vide.");
          return;
        }
        setReplyBusy(true);
        void onReply(voiceStory.author_id, replyText.trim(), voiceStory.id, blob)
          .then(() => {
            setReplyText("");
            Keyboard.dismiss();
            resumeStory();
          })
          .catch((e: any) => setError(e?.detail || e?.message || "Envoi du vocal impossible."))
          .finally(() => setReplyBusy(false));
      };
      replyRecorder.current = recorder;
      setRecordingSeconds(0);
      setRecordingReply(true);
      recorder.start();
    } catch (e: any) {
      replyStream.current?.getTracks().forEach(track => track.stop());
      replyStream.current = null;
      replyRecorder.current = null;
      setRecordingReply(false);
      resumeStory();
      setError(e?.message || "Autorisez le microphone pour enregistrer une réponse vocale.");
    }
  };
  const sendRecordedReplyVoice = () => {
    if (replyRecorder.current?.state !== "recording") return;
    sendVoiceOnStop.current = true;
    replyRecorder.current.stop();
  };

  const closeViewer = () => {
    cancelReplyVoice();
    setOpenAuthorId(null);
    setActiveIndex(0);
    setPaused(false);
    heldStoryId.current = null;
    progressRef.current = 0;
    setStoryProgress(0);
    onViewerClose?.();
  };
  const advance = () => {
    if (!selectedGroup) return;
    setPaused(false);
    heldStoryId.current = null;
    progressRef.current = 0;
    setStoryProgress(0);
    if (activeIndex + 1 < selectedGroup.statuses.length) {
      setActiveIndex(index => index + 1);
      return;
    }
    const groupIndex = groups.findIndex(group => group.authorId === openAuthorId);
    const nextGroup = groups[groupIndex + 1];
    if (!nextGroup) closeViewer();
    else { setOpenAuthorId(nextGroup.authorId); setActiveIndex(0); }
  };
  const goBack = () => {
    setPaused(false);
    heldStoryId.current = null;
    progressRef.current = 0;
    setStoryProgress(0);
    if (activeIndex > 0) { setActiveIndex(index => index - 1); return; }
    const groupIndex = groups.findIndex(group => group.authorId === openAuthorId);
    const previousGroup = groups[groupIndex - 1];
    if (previousGroup) {
      setOpenAuthorId(previousGroup.authorId);
      setActiveIndex(previousGroup.statuses.length - 1);
    }
  };
  const handleStoryTouchStart = (event: any) => {
    const touch = event.nativeEvent?.touches?.[0] || event.nativeEvent?.changedTouches?.[0];
    touchStartX.current = touch?.pageX ?? event.nativeEvent?.pageX ?? null;
    holdStory();
  };
  const handleStoryTouchEnd = (event: any) => {
    const touch = event.nativeEvent?.changedTouches?.[0] || event.nativeEvent?.touches?.[0];
    const endX = touch?.pageX ?? event.nativeEvent?.pageX;
    const startX = touchStartX.current;
    touchStartX.current = null;
    if (typeof endX !== "number" || typeof startX !== "number" || Math.abs(endX - startX) < 45) {
      resumeStory();
      return;
    }
    lastSwipeAt.current = Date.now();
    if (endX < startX) advance();
    else goBack();
  };
  const leftTap = () => { if (Date.now() - lastSwipeAt.current < 250) return; goBack(); };
  const rightTap = () => { if (Date.now() - lastSwipeAt.current < 250) return; advance(); };
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
    const group = groups.find(item => item.authorId === authorId);
    const firstUnseen = authorId === userId ? -1 : group?.statuses.findIndex(item => !item.viewed_by_me) ?? -1;
    setOpenAuthorId(authorId);
    setActiveIndex(firstUnseen >= 0 ? firstUnseen : 0);
    setPaused(false);
    heldStoryId.current = null;
    progressRef.current = 0;
    setStoryProgress(0);
  };

  const chooseMedia = () => {
    if (Platform.OS !== "web" || typeof document === "undefined") {
      setError("L’ajout de photo est disponible depuis la version web.");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) { setError("Les statuts vidéo ne sont pas encore disponibles."); return; }
      if (file.size > 20 * 1024 * 1024) { setError("La photo dépasse 20 Mo."); return; }
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

  const toggleLike = async () => {
    if (!story || story.author_id === userId) return;
    try {
      const result = await api.post<{ liked_by_me: boolean; likes_count: number }>(
        `/messenger/statuses/${encodeURIComponent(story.id)}/like`, {},
      );
      setItems(previous => previous.map(item => item.id === story.id
        ? { ...item, liked_by_me: result.liked_by_me, likes_count: result.likes_count }
        : item));
    } catch (e: any) { setError(e?.detail || "Réaction impossible."); }
  };

  const submitReply = async () => {
    const text = replyText.trim();
    if (!story || story.author_id === userId || !text || !onReply) return;
    setReplyBusy(true);
    setError("");
    try {
      await onReply(story.author_id, text, story.id);
      setReplyText("");
      Keyboard.dismiss();
      resumeStory();
    } catch (e: any) { setError(e?.detail || e?.message || "Envoi de la réponse impossible."); }
    finally { setReplyBusy(false); }
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
  const authorUnreadCount = (authorId: string) =>
    (groups.find(group => group.authorId === authorId)?.statuses || []).filter(item => !item.viewed_by_me).length;

  return <View style={styles.wrap} testID="messenger-statuses">
    <View style={styles.sectionHead}>
       <View><Text style={styles.title}>Statuts</Text><Text style={styles.subtitle}>Photos ou texte · visibles 24 heures</Text></View>
      <TouchableOpacity onPress={load} accessibilityLabel="Actualiser les statuts"><Ionicons name="refresh" size={18} color={blue} /></TouchableOpacity>
    </View>
    {!!error && <TouchableOpacity onPress={load} style={styles.error}><Text style={styles.errorText}>{error}</Text></TouchableOpacity>}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.storyRow}>
      <View style={styles.storyPerson}>
         <TouchableOpacity style={styles.storyRingWrap} onPress={() => ownStatuses.length ? openGroup(userId) : setComposeOpen(true)} testID="status-open-own">
           <View style={[styles.storyRing, ownStatuses.length > 0 && styles.storyRingSeen]}>
             <View style={styles.storyAvatar}>
               {ownStatuses[0]?.author_avatar ? <Image source={{ uri: ownStatuses[0].author_avatar }} style={styles.storyAvatarImage} /> : <Ionicons name="person" size={23} color={blue} />}
             </View>
          </View>
           {ownStatuses.length > 0 && <View style={styles.storyCount}><Text style={styles.storyCountText}>{ownStatuses.length > 9 ? "9+" : ownStatuses.length}</Text></View>}
        </TouchableOpacity>
        <TouchableOpacity style={styles.addStatus} onPress={() => { setComposeOpen(true); setError(""); }} accessibilityLabel="Ajouter un statut"><Ionicons name="add" size={16} color="#fff" /></TouchableOpacity>
        <Text style={styles.storyName} numberOfLines={1}>Mon statut</Text>
      </View>
      {groups.filter(group => group.authorId !== userId).map(group => {
        const unread = authorUnread(group.authorId);
        const count = authorUnreadCount(group.authorId) || group.statuses.length;
        return <TouchableOpacity key={group.authorId} style={styles.storyPerson} onPress={() => openGroup(group.authorId)} testID={`status-open-${group.authorId}`}>
          <View style={[styles.storyRing, unread ? styles.storyRingNew : styles.storyRingSeen]}>
            <View style={styles.storyAvatar}>
              {authorAvatar(group.authorId) ? <Image source={{ uri: authorAvatar(group.authorId) }} style={styles.storyAvatarImage} /> : <Text style={styles.storyInitial}>{authorName(group.authorId).slice(0, 1).toUpperCase()}</Text>}
            </View>
          </View>
          <View style={styles.storyCount}><Text style={styles.storyCountText}>{count > 9 ? "9+" : count}</Text></View>
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
         {attachment && <View style={styles.attachmentRow}><Ionicons name="image" size={17} color={blue} /><Text style={styles.attachmentName} numberOfLines={1}>{attachment.name}</Text><TouchableOpacity onPress={() => setAttachment(null)}><Ionicons name="close-circle" size={19} color={muted} /></TouchableOpacity></View>}
        <Text style={styles.privacy}>Partagé avec vos contacts pendant 24 heures.</Text>
        <View style={styles.composeActions}>
           <TouchableOpacity style={styles.mediaButton} onPress={chooseMedia} disabled={uploading}><Ionicons name="image-outline" size={18} color={blue} /><Text style={styles.mediaButtonText}>{uploading ? "Ajout…" : "Ajouter une photo"}</Text></TouchableOpacity>
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
          ref={storyContentRef}
          style={styles.storyContent}
          onTouchStart={handleStoryTouchStart}
          onTouchEnd={handleStoryTouchEnd}
          onTouchCancel={resumeStory}
        >
          {media?.mime.startsWith("image/") && mediaUrl ? <Image source={{ uri: mediaUrl }} style={styles.storyMedia} resizeMode="contain" /> : null}
          {media?.mime.startsWith("video/") && <View ref={videoHost} style={styles.videoHost}>{!mediaUrl && <ActivityIndicator color="#fff" />}</View>}
          {!media && <Text style={styles.storyText}>{story?.text}</Text>}
          {!!story?.text && !!media && <Text style={styles.storyCaption}>{story.text}</Text>}
          <TouchableOpacity style={styles.leftTap} onPress={leftTap} accessibilityLabel="Statut précédent" />
          <TouchableOpacity style={styles.rightTap} onPress={rightTap} accessibilityLabel="Statut suivant" />
          {paused && <View pointerEvents="none" style={styles.pauseMark}><Ionicons name="pause" size={22} color="#fff" /></View>}
        </Pressable>
         {story?.author_id === userId
           ? <TouchableOpacity style={styles.viewCount} onPress={() => setViewersOpen(true)} accessibilityRole="button" accessibilityLabel={`Voir les ${story.views_count || 0} personnes qui ont vu ce statut`}>
               <Ionicons name="eye-outline" size={17} color="#fff" />
               <Text style={styles.viewCountText}>{story.views_count || 0} vues</Text>
             </TouchableOpacity>
             : <View style={styles.replyActions} testID="status-reply-actions">
                {recordingReply ? <>
                <View style={styles.recordingReplyCopy}><View style={styles.recordingReplyDot} /><Text style={styles.recordingReplyText}>Enregistrement · {recordingSeconds}s</Text></View>
                <TouchableOpacity style={styles.replySecondaryButton} onPress={cancelReplyVoice} accessibilityLabel="Annuler l’enregistrement vocal"><Ionicons name="trash-outline" size={19} color="#fff" /></TouchableOpacity>
                <TouchableOpacity style={styles.replySend} onPress={sendRecordedReplyVoice} disabled={replyBusy} accessibilityLabel="Envoyer la réponse vocale">
                  {replyBusy ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="send" size={18} color="#fff" />}
                </TouchableOpacity>
                </> : <>
               <TouchableOpacity style={styles.likeButton} onPress={toggleLike} accessibilityLabel={story?.liked_by_me ? "Retirer le j’aime" : "Aimer ce statut"}>
                 <Ionicons name={story?.liked_by_me ? "heart" : "heart-outline"} size={23} color={story?.liked_by_me ? "#ff5570" : "#fff"} />
                 <Text numberOfLines={1} style={styles.replyActionCount}>{story?.likes_count || 0}</Text>
               </TouchableOpacity>
               <TextInput
                 value={replyText}
                 onChangeText={setReplyText}
                 placeholder="Répondre au statut…"
                 placeholderTextColor="#d7deeb"
                 style={styles.replyInput}
                 maxLength={1200}
                 returnKeyType="send"
                 onSubmitEditing={submitReply}
                  onFocus={holdStory}
                 testID="status-reply-input"
               />
                <TouchableOpacity style={styles.replySecondaryButton} onPress={startReplyVoice} disabled={replyBusy} accessibilityLabel="Enregistrer une réponse vocale">
                  <Ionicons name="mic-outline" size={20} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.replySend} onPress={submitReply} disabled={!replyText.trim() || replyBusy} accessibilityLabel="Envoyer la réponse en privé" testID="status-reply-send">
                 {replyBusy ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="send" size={18} color="#fff" />}
               </TouchableOpacity>
                </>}
             </View>}
         {viewersOpen && story?.author_id === userId && <View style={styles.viewersBackdrop}>
           <TouchableOpacity style={styles.viewersScrim} activeOpacity={1} onPress={() => setViewersOpen(false)} accessibilityLabel="Fermer la liste des vues" />
           <View style={styles.viewersSheet} testID="status-viewers-list">
             <View style={styles.viewersHandle} />
             <View style={styles.viewersHeader}><Text style={styles.viewersTitle}>Personnes ayant vu le statut</Text><Text style={styles.viewersTotal}>{story.views_count || 0}</Text></View>
             <ScrollView style={styles.viewersScroll} contentContainerStyle={styles.viewersContent}>
               {(story.viewers || []).length
                 ? (story.viewers || []).map(viewer => <View key={viewer.id} style={styles.viewerRow}>
                     <View style={styles.viewerAvatar}>{viewer.avatar ? <Image source={{ uri: viewer.avatar }} style={styles.viewerAvatarImage} /> : <Text style={styles.viewerInitial}>{viewer.username.slice(0, 1).toUpperCase()}</Text>}</View>
                     <Text style={styles.viewerRowName} numberOfLines={1}>{viewer.username}</Text>
                   </View>)
                 : <Text style={styles.viewersEmpty}>Aucune vue pour le moment.</Text>}
             </ScrollView>
           </View>
         </View>}
      </View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: "#fffefa", borderBottomWidth: 1, borderColor: "#e2e8f0", paddingTop: 16 },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 17, marginBottom: 10 },
  title: { color: ink, fontWeight: "800", fontSize: 17, letterSpacing: -.2 }, subtitle: { color: muted, fontSize: 11, marginTop: 3 },
  storyRow: { flexDirection: "row", alignItems: "flex-start", gap: 17, paddingHorizontal: 17, paddingBottom: 15 },
  storyPerson: { width: 62, alignItems: "center", position: "relative" },
  storyRingWrap: { width: 56, height: 56, alignItems: "center", justifyContent: "center", position: "relative" },
  storyRing: { width: 58, height: 58, borderRadius: 30, borderWidth: 2, padding: 3, alignItems: "center", justifyContent: "center" },
  storyRingNew: { borderColor: "#13b981" }, storyRingSeen: { borderColor: "#f2a934" },
  storyCount: { position: "absolute", right: 0, top: -2, minWidth: 17, height: 17, paddingHorizontal: 4, borderRadius: 9, backgroundColor: "#1769e8", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#fff" },
  storyCountText: { color: "#fff", fontSize: 9, fontWeight: "900" },
  storyAvatar: { width: 48, height: 48, borderRadius: 25, backgroundColor: "#edf3fd", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  storyAvatarImage: { width: 46, height: 46, borderRadius: 24 }, storyInitial: { color: blue, fontWeight: "900", fontSize: 18 },
  addStatus: { position: "absolute", right: 1, top: 35, width: 21, height: 21, borderRadius: 11, backgroundColor: blue, borderWidth: 2, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  storyName: { color: ink, fontSize: 10, fontWeight: "700", textAlign: "center", marginTop: 6, width: 60 },
  empty: { color: muted, fontSize: 12, alignSelf: "center", paddingVertical: 17 },
  error: { marginHorizontal: 14, marginBottom: 7, backgroundColor: "#fff1f0", borderRadius: 10, padding: 8 }, errorText: { color: "#b83a42", fontSize: 12 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(10,20,38,.5)", justifyContent: "flex-end" },
  composeSheet: { backgroundColor: "#fffefa", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 30, borderWidth: 1, borderColor: "#e2e8f0" },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  sheetTitle: { color: ink, fontSize: 18, fontWeight: "900" },
  statusInput: { minHeight: 125, maxHeight: 220, color: ink, fontSize: 15, lineHeight: 22, textAlignVertical: "top", backgroundColor: "#f5f8fb", borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 13, padding: 14, outlineStyle: "none" as any },
  attachmentRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#eef4ff", borderRadius: 10, padding: 9, marginTop: 9 },
  attachmentName: { flex: 1, color: ink, fontSize: 12 },
  privacy: { color: muted, fontSize: 11, marginTop: 10 },
  composeActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 14 },
  mediaButton: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 11, paddingHorizontal: 13, borderRadius: 11, backgroundColor: "#edf4ff", borderWidth: 1, borderColor: "#e1eafb" },
  mediaButtonText: { color: blue, fontSize: 12, fontWeight: "800" },
  publishButton: { backgroundColor: blue, minWidth: 104, alignItems: "center", justifyContent: "center", paddingVertical: 12, paddingHorizontal: 18, borderRadius: 12 },
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
  viewCount: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, alignSelf: "center", paddingHorizontal: 14, paddingBottom: 28 },
  viewCountText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  replyActions: { alignSelf: "stretch", minWidth: 0, maxWidth: "100%", minHeight: 70, flexDirection: "row", flexWrap: "nowrap", alignItems: "center", gap: 9, paddingHorizontal: 12, paddingBottom: 22, backgroundColor: "#0b1220" },
  likeButton: { width: 46, height: 42, flexShrink: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3 },
  replyActionCount: { flexShrink: 1, minWidth: 0, color: "#fff", fontSize: 11, fontWeight: "800" },
  replyInput: { flex: 1, flexBasis: 0, flexShrink: 1, minWidth: 0, height: 42, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: "#253149", color: "#fff", fontSize: 14, outlineStyle: "none" as any },
  recordingReplyCopy: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  recordingReplyDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: "#f45b67" },
  recordingReplyText: { flexShrink: 1, minWidth: 0, color: "#fff", fontSize: 13, fontWeight: "700" },
  replySecondaryButton: { width: 38, height: 42, flexShrink: 0, borderRadius: 21, alignItems: "center", justifyContent: "center", backgroundColor: "#253149" },
  replySend: { width: 42, height: 42, flexShrink: 0, borderRadius: 21, backgroundColor: blue, alignItems: "center", justifyContent: "center" },
  viewersBackdrop: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end", zIndex: 10 },
  viewersScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,.52)" },
  viewersSheet: { height: "68%", minHeight: 270, backgroundColor: "#fff", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 20 },
  viewersHandle: { width: 38, height: 4, borderRadius: 3, backgroundColor: "#d8dee8", alignSelf: "center", marginBottom: 14 },
  viewersHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 12, borderBottomWidth: 1, borderColor: "#edf0f4" },
  viewersTitle: { color: ink, fontSize: 16, fontWeight: "900" }, viewersTotal: { color: blue, fontSize: 14, fontWeight: "900" },
  viewersScroll: { flex: 1 }, viewersContent: { paddingVertical: 7 },
  viewerRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 11, borderBottomWidth: 1, borderColor: "#f0f2f5" },
  viewerRowName: { color: ink, flex: 1, fontSize: 14, fontWeight: "700" },
  viewersEmpty: { color: muted, textAlign: "center", marginTop: 30, fontSize: 13 },
});
