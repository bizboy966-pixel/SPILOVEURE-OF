/**
 * MediaViewer — grid of thumbnails + description block that opens the
 * shared `<MediaLightbox />` on click. Used by admin moderation screens
 * that need a compact "review this content" widget.
 */
import React, { useMemo, useState } from "react";
import {
  Image, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { resolveMediaUrl } from "@/src/api";
import { MediaLightbox, useMediaLightbox } from "@/src/components/MediaLightbox";

export type MediaViewerProps = {
  images?: string[];
  videos?: string[];
  audio?: string | null;
  title?: string;
  description?: string;
  extraInfo?: React.ReactNode;
  compact?: boolean;
  testID?: string;
};

const isWeb = Platform.OS === "web";

export function MediaViewer({
  images = [], videos = [], audio = null,
  title, description, extraInfo, compact = false, testID,
}: MediaViewerProps) {
  const slides = useMemo(() => [
    ...images.map((u) => ({ kind: "image" as const, url: u })),
    ...videos.map((u) => ({ kind: "video" as const, url: u })),
  ], [images, videos]);
  const lightbox = useMediaLightbox();
  const [descExpanded, setDescExpanded] = useState(false);

  const total = slides.length;
  const showExpand = (description || "").length > 220;
  const descriptionShown = !description
    ? ""
    : showExpand && !descExpanded
      ? description.slice(0, 220).trimEnd() + "…"
      : description;

  return (
    <View style={styles.wrap} testID={testID || "media-viewer"}>
      {slides.length > 0 && (
        <View style={styles.grid}>
          {slides.map((s, i) => {
            const url = resolveMediaUrl(s.url);
            return (
              <TouchableOpacity
                key={`${s.kind}-${i}`}
                style={[styles.thumb, compact && styles.thumbCompact]}
                onPress={() => lightbox.openAt(slides, i, { title, description })}
                testID={`${testID || "media"}-thumb-${i}`}
                activeOpacity={0.85}
              >
                {isWeb ? (
                  s.kind === "image" ? (
                    // @ts-ignore raw web img
                    <img src={url} alt={`img-${i}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  ) : (
                    // @ts-ignore raw web video
                    <video src={url} muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover", background: "#000" }} />
                  )
                ) : (
                  s.kind === "image" ? (
                    <Image source={{ uri: url }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
                  ) : (
                    <View style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}>
                      <Ionicons name="play-circle" size={28} color="#fff" />
                    </View>
                  )
                )}
                {s.kind === "video" && (
                  <View style={styles.playBadge} pointerEvents="none">
                    <Ionicons name="play" size={14} color="#fff" />
                  </View>
                )}
                <View style={styles.thumbIdx}>
                  <Text style={styles.thumbIdxTxt}>{i + 1}/{total}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {audio && isWeb && (
        <View style={{ marginTop: 8 }}>
          {/* @ts-ignore raw web audio */}
          <audio src={resolveMediaUrl(audio)} controls style={{ width: "100%" }} />
        </View>
      )}

      {(!!title || !!description || !!extraInfo) && (
        <View style={styles.textBlock}>
          {!!title && <Text style={styles.title}>{title}</Text>}
          {!!description && (
            <>
              <Text style={styles.body} testID={`${testID || "media"}-description`}>
                {descriptionShown}
              </Text>
              {showExpand && (
                <TouchableOpacity onPress={() => setDescExpanded((v) => !v)} testID={`${testID || "media"}-desc-toggle`}>
                  <Text style={styles.link}>
                    {descExpanded ? "▲ Voir moins" : "▼ Lire la suite"}
                  </Text>
                </TouchableOpacity>
              )}
            </>
          )}
          {extraInfo}
        </View>
      )}

      <MediaLightbox
        open={lightbox.open}
        slides={lightbox.slides}
        index={lightbox.index}
        onClose={lightbox.close}
        onIndexChange={lightbox.setIndex}
        title={lightbox.title}
        description={lightbox.description}
        testID={`${testID || "media"}-lightbox`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  thumb: {
    width: 120, height: 120, borderRadius: 10, overflow: "hidden",
    backgroundColor: "#F1F5F9", borderWidth: 1, borderColor: theme.colors.border,
    position: "relative",
  },
  thumbCompact: { width: 84, height: 84 },
  playBadge: {
    position: "absolute", top: 4, right: 4,
    backgroundColor: "rgba(15, 23, 42, 0.7)", borderRadius: 12, padding: 4,
  },
  thumbIdx: {
    position: "absolute", bottom: 4, right: 4,
    backgroundColor: "rgba(15, 23, 42, 0.75)", borderRadius: 6,
    paddingHorizontal: 5, paddingVertical: 2,
  },
  thumbIdxTxt: { color: "#fff", fontSize: 9, fontWeight: "700" },
  textBlock: { marginTop: 10 },
  title: { fontWeight: "900", fontSize: 15, color: theme.colors.textPrimary, marginBottom: 4 },
  body: { fontSize: 13, color: theme.colors.textPrimary, lineHeight: 18 },
  link: { marginTop: 4, color: theme.colors.primary, fontWeight: "800", fontSize: 12 },
});
