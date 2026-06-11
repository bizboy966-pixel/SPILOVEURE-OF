/**
 * Reusable file uploader for the admin content editor.
 *
 * Two modes per field:
 *   1. Upload from device (PC/phone) → POST /api/admin/uploads → stores URL.
 *   2. Manually paste an external URL into the existing text input.
 *
 * Works on Expo Web (uses native <input type="file">). On native (mobile),
 * the button is hidden because Expo Router web is the target — admins use
 * a desktop browser in 99% of cases.
 */
import React, { useRef, useState } from "react";
import { Platform, StyleSheet, Text, TouchableOpacity, View, Image, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { api, resolveMediaUrl } from "@/src/api";

type Kind = "image" | "video" | "pdf" | "audio" | "apk";

const ACCEPT: Record<Kind, string> = {
  image: "image/jpeg,image/png,image/webp,image/gif,image/svg+xml",
  video: "video/mp4,video/quicktime,video/webm",
  audio: "audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg",
  pdf: "application/pdf",
  apk: ".apk,application/vnd.android.package-archive",
};

const LABEL: Record<Kind, string> = {
  image: "Importer une image",
  video: "Importer une vidéo",
  pdf: "Importer un PDF",
  audio: "Importer un audio",
  apk: "Importer un APK",
};

const ICON: Record<Kind, any> = {
  image: "image",
  video: "videocam",
  pdf: "document-text",
  audio: "musical-notes",
  apk: "logo-android",
};

export function MediaUploader({
  kind,
  url,
  onChange,
  testID,
}: {
  kind: Kind;
  url: string;
  onChange: (newUrl: string) => void;
  testID?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleChoose = () => {
    if (Platform.OS !== "web") return; // web-only for now
    inputRef.current?.click();
  };

  const handleFile = async (file: File | null | undefined) => {
    if (!file) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await api.upload<{ url: string }>("/admin/uploads", file);
      onChange(r.url);
    } catch (e: any) {
      setErr(e?.detail || "Échec de l'import.");
    } finally {
      setBusy(false);
    }
  };

  const isImage = kind === "image";
  const resolved = resolveMediaUrl(url);

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.btn, busy && { opacity: 0.6 }]}
          onPress={handleChoose}
          disabled={busy || Platform.OS !== "web"}
          testID={testID ? `${testID}-pick` : undefined}
        >
          {busy ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Ionicons name={ICON[kind] as any} size={14} color="#fff" />
          )}
          <Text style={styles.btnTxt}>{busy ? "Envoi…" : LABEL[kind]}</Text>
        </TouchableOpacity>

        {url ? (
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={() => onChange("")}
            disabled={busy}
            testID={testID ? `${testID}-clear` : undefined}
          >
            <Ionicons name="close-circle" size={14} color={theme.colors.danger} />
            <Text style={styles.clearTxt}>Effacer</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {err ? <Text style={styles.err}>{err}</Text> : null}

      {url ? (
        <View style={styles.preview}>
          {isImage && resolved ? (
            <Image source={{ uri: resolved }} style={styles.thumb} resizeMode="cover" />
          ) : (
            <View style={[styles.thumb, styles.thumbPh]}>
              <Ionicons name={ICON[kind] as any} size={22} color={theme.colors.primary} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.fileTxt} numberOfLines={2}>
              {url.startsWith("/api/uploads/") ? "📁 Importé sur le serveur" : "🔗 Lien externe"}
            </Text>
            <Text style={styles.fileUrl} numberOfLines={1}>{url}</Text>
          </View>
        </View>
      ) : null}

      {/* Hidden native file input (web only) */}
      {Platform.OS === "web" && (
        // @ts-ignore — RN typings don't know about raw html on web
        <input
          ref={inputRef as any}
          type="file"
          accept={ACCEPT[kind]}
          style={{ display: "none" }}
          onChange={(e: any) => handleFile(e?.target?.files?.[0])}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 4, marginBottom: 8 },
  row: { flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" },
  btn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18,
    backgroundColor: theme.colors.primary,
  },
  btnTxt: { color: "#fff", fontWeight: "700", fontSize: 12 },
  clearBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 7, borderRadius: 16,
    backgroundColor: "#FEE2E2",
  },
  clearTxt: { color: theme.colors.danger, fontWeight: "700", fontSize: 11 },
  err: { color: theme.colors.danger, fontSize: 11, marginTop: 4 },
  preview: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: theme.colors.surfaceSecondary,
    borderRadius: 10, padding: 8, marginTop: 6,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  thumb: { width: 46, height: 46, borderRadius: 8, backgroundColor: "#fff" },
  thumbPh: { alignItems: "center", justifyContent: "center" },
  fileTxt: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },
  fileUrl: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 2 },
});
