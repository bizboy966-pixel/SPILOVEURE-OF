import React, { useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Modal, ActivityIndicator, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";

/**
 * ProfilePhotoManager — importer / remplacer / supprimer la photo de profil.
 *
 * Approche : `<input type="file">` invisible côté web, canvas côté client
 * pour redimensionner à 512x512 max en JPEG q=0.85 (typiquement ~40-80 KB),
 * puis POST /api/me/profile-photo avec le data-URI base64. Suppression via
 * DELETE /api/me/profile-photo. Chaque opération termine par un `refresh()`
 * du contexte auth pour mettre à jour le Dashboard instantanément.
 */

type Props = {
  visible: boolean;
  onClose: () => void;
};

async function fileToResizedDataURI(file: File, maxDim = 512, quality = 0.85): Promise<string> {
  const img = new Image();
  const url = URL.createObjectURL(file);
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = url;
  });
  const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  // Crop square-center for consistent avatar rendering.
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  const scale = maxDim / side;
  canvas.width = Math.round(side * scale);
  canvas.height = Math.round(side * scale);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
  return canvas.toDataURL("image/jpeg", quality);
}

export default function ProfilePhotoManager({ visible, onClose }: Props) {
  const { user, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const pickPhoto = () => {
    setErr(null);
    if (Platform.OS !== "web") {
      setErr("L'import de photo n'est disponible que sur le web pour le moment.");
      return;
    }
    inputRef.current?.click();
  };

  const onFileChange = async (e: any) => {
    const file = e?.target?.files?.[0] as File | undefined;
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErr("Choisissez une image (JPEG, PNG ou WEBP)."); return;
    }
    setBusy(true); setErr(null);
    try {
      const dataURI = await fileToResizedDataURI(file, 512, 0.85);
      await api.post("/me/profile-photo", { data: dataURI });
      await refresh();
      onClose();
    } catch (e: any) {
      setErr(e?.detail || e?.message || "Erreur inconnue");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const deletePhoto = async () => {
    if (typeof window !== "undefined" && !window.confirm("Supprimer votre photo de profil ?")) return;
    setBusy(true); setErr(null);
    try {
      await api.delete("/me/profile-photo");
      await refresh();
      onClose();
    } catch (e: any) {
      setErr(e?.detail || e?.message || "Erreur inconnue");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.sheet}>
          <Text style={styles.title}>Photo de profil</Text>
          <Text style={styles.hint}>
            Formats acceptés : JPEG, PNG, WEBP. Redimensionnée automatiquement à 512×512 pour un affichage rapide.
          </Text>
          {err ? <Text style={styles.err}>{err}</Text> : null}
          <TouchableOpacity
            style={[styles.action, { backgroundColor: theme.colors.primary }]}
            onPress={pickPhoto}
            disabled={busy}
            testID="profile-photo-pick"
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="image" size={17} color="#fff" />
                <Text style={styles.actionTxt}>{user?.profile_photo ? "Modifier la photo" : "Importer une photo"}</Text>
              </>
            )}
          </TouchableOpacity>
          {user?.profile_photo ? (
            <TouchableOpacity
              style={[styles.action, { backgroundColor: "#EF4444" }]}
              onPress={deletePhoto}
              disabled={busy}
              testID="profile-photo-delete"
            >
              <Ionicons name="trash" size={17} color="#fff" />
              <Text style={styles.actionTxt}>Supprimer la photo</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelTxt}>Annuler</Text>
          </TouchableOpacity>
          {Platform.OS === "web" ? (
            // eslint-disable-next-line
            <input
              ref={inputRef as any}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: "none" } as any}
              onChange={onFileChange as any}
              data-testid="profile-photo-input"
            />
          ) : null}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(15, 23, 42, 0.55)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#fff", borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 22, paddingBottom: 34,
  },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 6 },
  hint: { fontSize: 12, color: theme.colors.textSecondary, marginBottom: 14, lineHeight: 17 },
  err: { color: "#DC2626", fontSize: 12, marginBottom: 10, fontWeight: "600" },
  action: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    paddingVertical: 13, borderRadius: 14, marginBottom: 10,
  },
  actionTxt: { color: "#fff", fontSize: 14, fontWeight: "700" },
  cancel: { paddingVertical: 12, alignItems: "center" },
  cancelTxt: { color: theme.colors.textSecondary, fontSize: 13, fontWeight: "600" },
});
