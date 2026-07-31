/**
 * MediaLightbox — modal-only viewer for a list of media slides.
 *
 * Used both by `MediaViewer` (which owns thumbnails + open state) and by
 * screens that already render their own inline image / video carousel
 * and simply want a "tap to view full-screen" experience (marketplace
 * public feed, ads feed, etc.).
 *
 * Exports the `<MediaLightbox />` component and a `useMediaLightbox()`
 * hook returning `{ open, close, openAt, slides, index, controls }`.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { resolveMediaUrl } from "@/src/api";

export type Slide = { kind: "image" | "video"; url: string };

const isWeb = Platform.OS === "web";

export type MediaLightboxProps = {
  open: boolean;
  slides: Slide[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
  title?: string;
  description?: string;
  testID?: string;
};

export function MediaLightbox({
  open, slides, index, onClose, onIndexChange,
  title, description, testID,
}: MediaLightboxProps) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => { if (!open) setZoom(1); }, [open, index]);

  const total = slides.length;
  const next = useCallback(() => {
    if (total > 0) onIndexChange((index + 1) % total);
  }, [index, total, onIndexChange]);
  const prev = useCallback(() => {
    if (total > 0) onIndexChange((index - 1 + total) % total);
  }, [index, total, onIndexChange]);

  // Keyboard shortcuts on web
  useEffect(() => {
    if (!isWeb || !open) return;
    const handler = (e: any) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(4, z + 0.5));
      else if (e.key === "-") setZoom((z) => Math.max(1, z - 0.5));
      else if (e.key === "0") setZoom(1);
    };
    // @ts-ignore web only
    window.addEventListener("keydown", handler);
    // @ts-ignore
    return () => window.removeEventListener("keydown", handler);
  }, [open, next, prev, onClose]);

  if (!open) return null;
  const current = slides[index];

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose} testID={testID || "media-lightbox"}>
        <Pressable onPress={(e) => e.stopPropagation()} style={{ maxWidth: "95%", maxHeight: "90%" }}>
          {current?.kind === "image" ? (
            isWeb ? (
              // @ts-ignore raw web img
              <img
                src={resolveMediaUrl(current.url)}
                alt={`slide-${index}`}
                onClick={(e: any) => { e.stopPropagation(); setZoom((z) => (z >= 2 ? 1 : 2)); }}
                onWheel={(e: any) => {
                  e.preventDefault();
                  setZoom((z) => Math.max(1, Math.min(4, z + (e.deltaY < 0 ? 0.25 : -0.25))));
                }}
                style={{
                  maxWidth: "90vw", maxHeight: "80vh", objectFit: "contain",
                  display: "block", transform: `scale(${zoom})`,
                  transformOrigin: "center center",
                  transition: "transform 120ms ease-out",
                  cursor: zoom >= 2 ? "zoom-out" : "zoom-in",
                  userSelect: "none",
                }}
              />
            ) : (
              <Image source={{ uri: resolveMediaUrl(current.url) }} resizeMode="contain"
                     style={{ width: 360, height: 480 }} />
            )
          ) : current?.kind === "video" ? (
            isWeb ? (
              // @ts-ignore raw web video
              <video
                src={resolveMediaUrl(current.url)}
                controls autoPlay
                style={{ maxWidth: "90vw", maxHeight: "80vh", background: "#000", display: "block" }}
              />
            ) : (
              <View style={{ width: 360, height: 240, backgroundColor: "#000",
                              alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="videocam" size={48} color="#fff" />
              </View>
            )
          ) : null}
        </Pressable>

        <View style={styles.topBar} pointerEvents="box-none">
          <View style={styles.counter}>
            <Text style={styles.counterTxt}>{index + 1} / {total}</Text>
          </View>
          {current?.kind === "image" && (
            <View style={styles.zoomBar}>
              <Pressable onPress={(e) => { e.stopPropagation(); setZoom((z) => Math.max(1, z - 0.5)); }}
                         style={styles.zoomBtn} testID={`${testID || "media"}-zoom-out`}>
                <Ionicons name="remove" size={16} color="#fff" />
              </Pressable>
              <Text style={styles.zoomTxt}>{Math.round(zoom * 100)}%</Text>
              <Pressable onPress={(e) => { e.stopPropagation(); setZoom((z) => Math.min(4, z + 0.5)); }}
                         style={styles.zoomBtn} testID={`${testID || "media"}-zoom-in`}>
                <Ionicons name="add" size={16} color="#fff" />
              </Pressable>
            </View>
          )}
          <Pressable onPress={onClose} style={styles.iconBtn} testID={`${testID || "media"}-close`}>
            <Ionicons name="close" size={22} color="#fff" />
          </Pressable>
        </View>

        {total > 1 && (
          <>
            <Pressable style={[styles.nav, { left: 16 }]}
                       onPress={(e) => { e.stopPropagation(); prev(); }}
                       testID={`${testID || "media"}-prev`}>
              <Ionicons name="chevron-back" size={28} color="#fff" />
            </Pressable>
            <Pressable style={[styles.nav, { right: 16 }]}
                       onPress={(e) => { e.stopPropagation(); next(); }}
                       testID={`${testID || "media"}-next`}>
              <Ionicons name="chevron-forward" size={28} color="#fff" />
            </Pressable>
          </>
        )}

        {!!description && (
          <ScrollView style={styles.descStrip} contentContainerStyle={{ padding: 12 }}
                       onStartShouldSetResponder={() => true}>
            {!!title && <Text style={styles.descStripTitle}>{title}</Text>}
            <Text style={styles.descStripBody}>{description}</Text>
          </ScrollView>
        )}
      </Pressable>
    </Modal>
  );
}

/**
 * Small controller hook — sugar for the (open, index, slides) triplet
 * needed when a parent screen wants to lazily open the lightbox from
 * multiple entry points.
 */
export function useMediaLightbox() {
  const [state, setState] = useState<{ open: boolean; slides: Slide[]; index: number; title?: string; description?: string }>({
    open: false, slides: [], index: 0,
  });
  const openAt = useCallback((slides: Slide[], index: number = 0,
                              opts?: { title?: string; description?: string }) => {
    setState({ open: true, slides, index, title: opts?.title, description: opts?.description });
  }, []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  const setIndex = useCallback((i: number) => setState((s) => ({ ...s, index: i })), []);
  return { ...state, openAt, close, setIndex };
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center", justifyContent: "center",
  },
  topBar: {
    position: "absolute", top: 16, left: 16, right: 16,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  counter: { backgroundColor: "rgba(255,255,255,0.15)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  counterTxt: { color: "#fff", fontWeight: "800", fontSize: 12 },
  zoomBar: { flexDirection: "row", alignItems: "center", gap: 8,
             backgroundColor: "rgba(255,255,255,0.15)",
             paddingHorizontal: 8, paddingVertical: 4, borderRadius: 20 },
  zoomBtn: { width: 26, height: 26, borderRadius: 13,
             alignItems: "center", justifyContent: "center",
             backgroundColor: "rgba(255,255,255,0.1)" },
  zoomTxt: { color: "#fff", fontWeight: "800", fontSize: 11, minWidth: 32, textAlign: "center" },
  iconBtn: { width: 34, height: 34, borderRadius: 17,
             alignItems: "center", justifyContent: "center",
             backgroundColor: "rgba(255,255,255,0.15)" },
  nav: { position: "absolute", top: "45%",
         width: 46, height: 46, borderRadius: 23,
         alignItems: "center", justifyContent: "center",
         backgroundColor: "rgba(255,255,255,0.15)" },
  descStrip: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    maxHeight: "35%",
    backgroundColor: "rgba(15, 23, 42, 0.85)",
  },
  descStripTitle: { color: "#fff", fontWeight: "800", fontSize: 14, marginBottom: 4 },
  descStripBody: { color: "#E2E8F0", fontSize: 12, lineHeight: 18 },
});
