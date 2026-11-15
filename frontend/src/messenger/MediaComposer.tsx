import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Image, Modal, PanResponder, Platform, ScrollView, StyleSheet, Text,
  TextInput, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

type CropRatio = "original" | "square" | "portrait" | "wide";
type FilterName = "normal" | "mono" | "warm" | "vivid";
type Stroke = { color: string; points: { x: number; y: number }[] };
type Edit = {
  rotation: number; mirrored: boolean; zoom: number; ratio: CropRatio; filter: FilterName;
  offsetX: number; offsetY: number; overlayText: string; overlayColor: string; strokes: Stroke[];
};

type Props = {
  files: File[];
  visible: boolean;
  initialCaption?: string;
  onClose: () => void;
  onConfirm: (files: File[], caption: string) => Promise<void>;
};

const ratios: { value: CropRatio; label: string; ratio?: number }[] = [
  { value: "original", label: "Original" },
  { value: "square", label: "1:1", ratio: 1 },
  { value: "portrait", label: "4:5", ratio: 4 / 5 },
  { value: "wide", label: "16:9", ratio: 16 / 9 },
];
const filters: { value: FilterName; label: string; css: string }[] = [
  { value: "normal", label: "Normal", css: "none" },
  { value: "mono", label: "N&B", css: "grayscale(1)" },
  { value: "warm", label: "Chaud", css: "sepia(.5) saturate(1.2)" },
  { value: "vivid", label: "Vif", css: "saturate(1.6) contrast(1.08)" },
];
const initialEdit = (): Edit => ({
  rotation: 0, mirrored: false, zoom: 1, ratio: "original", filter: "normal",
  offsetX: 0, offsetY: 0, overlayText: "", overlayColor: "#ffffff", strokes: [],
});
const fileIsMedia = (file: File) => file.type.startsWith("image/") || file.type.startsWith("video/");
const imageFilter = (filter: FilterName) => filters.find(item => item.value === filter)?.css || "none";

async function makeEditedImage(file: File, edit: Edit): Promise<File> {
  if (Platform.OS !== "web") return file;
  const needsEdit = edit.rotation !== 0 || edit.mirrored || edit.zoom !== 1 || edit.ratio !== "original"
    || edit.filter !== "normal" || edit.offsetX !== 0 || edit.offsetY !== 0
    || !!edit.overlayText.trim() || edit.strokes.length > 0;
  if (!needsEdit) return file;

  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new window.Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`Impossible de lire ${file.name}.`));
      element.src = sourceUrl;
    });
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    const rotated = Math.abs(edit.rotation % 180) === 90;
    const rotatedWidth = rotated ? sourceHeight : sourceWidth;
    const rotatedHeight = rotated ? sourceWidth : sourceHeight;
    const selectedRatio = ratios.find(item => item.value === edit.ratio)?.ratio;
    let cropWidth = rotatedWidth;
    let cropHeight = rotatedHeight;
    if (selectedRatio) {
      if (rotatedWidth / rotatedHeight > selectedRatio) cropWidth = rotatedHeight * selectedRatio;
      else cropHeight = rotatedWidth / selectedRatio;
    }
    const outputScale = Math.min(1, 2200 / Math.max(cropWidth, cropHeight));
    const width = Math.max(1, Math.round(cropWidth * outputScale));
    const height = Math.max(1, Math.round(cropHeight * outputScale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("L’éditeur d’image n’est pas disponible.");
    const scale = Math.max(cropWidth / rotatedWidth, cropHeight / rotatedHeight) * edit.zoom;
    context.save();
    context.translate(width / 2, height / 2);
    context.translate(edit.offsetX * cropWidth * outputScale, edit.offsetY * cropHeight * outputScale);
    context.rotate(edit.rotation * Math.PI / 180);
    context.scale(edit.mirrored ? -1 : 1, 1);
    context.filter = imageFilter(edit.filter);
    context.drawImage(image,
      -sourceWidth * scale * outputScale / 2,
      -sourceHeight * scale * outputScale / 2,
      sourceWidth * scale * outputScale, sourceHeight * scale * outputScale);
    context.restore();
    context.filter = "none";
    edit.strokes.forEach(stroke => {
      if (stroke.points.length < 2) return;
      context.beginPath();
      context.moveTo(stroke.points[0].x * width, stroke.points[0].y * height);
      stroke.points.slice(1).forEach(point => context.lineTo(point.x * width, point.y * height));
      context.lineWidth = Math.max(4, width * .007);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = stroke.color;
      context.stroke();
    });
    if (edit.overlayText.trim()) {
      const fontSize = Math.max(24, Math.min(92, height * .075));
      const maxTextWidth = width * .84;
      context.filter = "none";
      context.font = `800 ${fontSize}px system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.lineJoin = "round";
      context.lineWidth = Math.max(3, fontSize * .11);
      context.strokeStyle = "rgba(0,0,0,.76)";
      context.fillStyle = edit.overlayColor;
      const words = edit.overlayText.trim().split(/\s+/);
      const lines: string[] = [];
      let line = "";
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && context.measureText(candidate).width > maxTextWidth) {
          lines.push(line);
          line = word;
        } else line = candidate;
      }
      if (line) lines.push(line);
      const lineHeight = fontSize * 1.18;
      const startY = height * .74 - ((lines.length - 1) * lineHeight) / 2;
      lines.forEach((entry, i) => {
        const y = startY + i * lineHeight;
        context.strokeText(entry, width / 2, y, maxTextWidth);
        context.fillText(entry, width / 2, y, maxTextWidth);
      });
    }
    const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Impossible d’exporter l’image.")), mime, .9));
    const name = file.name.replace(/\.[^.]+$/, "");
    const extension = mime === "image/png" ? ".png" : ".jpg";
    return new File([blob], `${name}-modifiee${extension}`, { type: mime, lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export default function MediaComposer({ files, visible, initialCaption = "", onClose, onConfirm }: Props) {
  const [index, setIndex] = useState(0);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [caption, setCaption] = useState(initialCaption);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [objectUrls, setObjectUrls] = useState<string[]>([]);
  const [imageAspect, setImageAspect] = useState(1.2);
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [drawMode, setDrawMode] = useState(false);
  const [drawingColor, setDrawingColor] = useState("#ffffff");
  const dragStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const videoHost = useRef<View | null>(null);
  const drawingHost = useRef<View | null>(null);
  const currentFile = files[index];
  const currentEdit = edits[index] || initialEdit();
  const mediaCount = useMemo(() => files.filter(fileIsMedia).length, [files]);

  useEffect(() => {
    if (!visible) return;
    setIndex(0);
    setEdits(files.map(() => initialEdit()));
    setCaption(initialCaption);
    setError("");
    setSending(false);
    setImageAspect(1.2);
    setDrawMode(false);
  }, [visible, files, initialCaption]);

  useEffect(() => {
    if (!visible || Platform.OS !== "web") return;
    const urls = files.map(file => URL.createObjectURL(file));
    setObjectUrls(urls);
    return () => { urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [files, visible]);

  useEffect(() => {
    const host = videoHost.current as unknown as HTMLElement | null;
    if (!visible || !currentFile?.type.startsWith("video/") || Platform.OS !== "web" || !host) return;
    const video = document.createElement("video");
    video.src = objectUrls[index] || "";
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.style.width = "100%";
    video.style.maxHeight = "42vh";
    video.style.objectFit = "contain";
    host.replaceChildren(video);
    return () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      host.replaceChildren();
    };
  }, [visible, currentFile?.name, index, objectUrls]);

  useEffect(() => {
    const host = drawingHost.current as unknown as HTMLElement | null;
    if (!visible || !drawMode || !currentFile?.type.startsWith("image/") || Platform.OS !== "web" || !host) return;
    const rect = host.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    canvas.style.cursor = "crosshair";
    host.replaceChildren(canvas);
    const context = canvas.getContext("2d");
    if (!context) return () => host.replaceChildren();
    context.scale(ratio, ratio);
    const strokePath = (stroke: Stroke) => {
      if (stroke.points.length < 2) return;
      context.beginPath();
      context.moveTo(stroke.points[0].x * rect.width, stroke.points[0].y * rect.height);
      stroke.points.slice(1).forEach(point => context.lineTo(point.x * rect.width, point.y * rect.height));
      context.lineWidth = Math.max(4, rect.width * .007);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = stroke.color;
      context.stroke();
    };
    currentEdit.strokes.forEach(strokePath);
    let activeStroke: Stroke | null = null;
    const getPoint = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width))),
        y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / Math.max(1, bounds.height))),
      };
    };
    const down = (event: PointerEvent) => {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      activeStroke = { color: drawingColor, points: [getPoint(event)] };
      context.beginPath();
      context.moveTo(event.clientX - canvas.getBoundingClientRect().left, event.clientY - canvas.getBoundingClientRect().top);
      context.lineWidth = Math.max(4, rect.width * .007);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = drawingColor;
    };
    const move = (event: PointerEvent) => {
      if (!activeStroke) return;
      event.preventDefault();
      const point = getPoint(event);
      activeStroke.points.push(point);
      context.lineTo(point.x * rect.width, point.y * rect.height);
      context.stroke();
    };
    const up = () => {
      if (activeStroke && activeStroke.points.length > 1) {
        const next = activeStroke;
        setEdits(previous => previous.map((edit, i) =>
          i === index ? { ...edit, strokes: [...edit.strokes, next] } : edit));
      }
      activeStroke = null;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      host.replaceChildren();
    };
  }, [visible, drawMode, currentFile?.name, currentEdit.strokes, index, drawingColor, stageSize]);

  const updateEdit = (patch: Partial<Edit>) => {
    setEdits(previous => previous.map((edit, i) => i === index ? { ...edit, ...patch } : edit));
  };
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !!currentFile?.type.startsWith("image/") && !drawMode,
    onMoveShouldSetPanResponder: (_event, gesture) =>
      !!currentFile?.type.startsWith("image/") && !drawMode && (Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2),
    onPanResponderGrant: () => {
      dragStart.current = { x: 0, y: 0, offsetX: currentEdit.offsetX, offsetY: currentEdit.offsetY };
    },
    onPanResponderMove: (_event, gesture) => {
      const rotatedAspect = Math.abs(currentEdit.rotation % 180) === 90 ? 1 / imageAspect : imageAspect;
      const selectedRatio = ratios.find(item => item.value === currentEdit.ratio)?.ratio || rotatedAspect;
      const maxX = Math.max(0, (rotatedAspect / selectedRatio - 1) / 2) + (currentEdit.zoom - 1) / 2;
      const maxY = Math.max(0, (selectedRatio / rotatedAspect - 1) / 2) + (currentEdit.zoom - 1) / 2;
      setEdits(previous => previous.map((edit, i) => i === index ? {
        ...edit,
        offsetX: Math.max(-maxX, Math.min(maxX, dragStart.current.offsetX + gesture.dx / stageSize.width)),
        offsetY: Math.max(-maxY, Math.min(maxY, dragStart.current.offsetY + gesture.dy / stageSize.height)),
      } : edit));
    },
  }).panHandlers, [currentFile?.name, index, currentEdit, imageAspect, stageSize, drawMode]);
  const confirm = async () => {
    if (!files.length || sending) return;
    setSending(true);
    setError("");
    try {
      const edited = await Promise.all(files.map(async (file, i) =>
        file.type.startsWith("image/") ? makeEditedImage(file, edits[i] || initialEdit()) : file));
      await onConfirm(edited, caption.trim());
    } catch (e: any) {
      setError(e?.message || "Préparation des médias impossible.");
      setSending(false);
    }
  };

  const ratioStyle = currentEdit.ratio === "original"
    ? { aspectRatio: imageAspect }
    : { aspectRatio: ratios.find(item => item.value === currentEdit.ratio)?.ratio || 1 };
  const filterCss = imageFilter(currentEdit.filter);

  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <View style={styles.sheet} testID="messenger-media-composer">
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} disabled={sending} accessibilityLabel="Annuler la sélection"><Ionicons name="close" size={24} color={ink} /></TouchableOpacity>
          <Text style={styles.headerTitle}>{mediaCount > 1 ? `${mediaCount} médias` : "Aperçu du média"}</Text>
          <TouchableOpacity onPress={confirm} disabled={sending || !files.length} style={styles.sendButton} testID="messenger-media-confirm">
            {sending ? <ActivityIndicator color="#fff" size="small" /> : <><Text style={styles.sendText}>Envoyer</Text><Ionicons name="send" size={15} color="#fff" /></>}
          </TouchableOpacity>
        </View>
        {currentFile && <>
          <View style={styles.stageArea}>
            {currentFile.type.startsWith("image/") && objectUrls[index] ? <View
              {...panResponder}
              onLayout={event => setStageSize({
                width: Math.max(1, event.nativeEvent.layout.width),
                height: Math.max(1, event.nativeEvent.layout.height),
              })}
              style={[styles.imageStage, ratioStyle]}
            >
              <Image
                source={{ uri: objectUrls[index] }}
                resizeMode="cover"
                onLoad={(event: any) => {
                  const { width, height } = event.nativeEvent.source || {};
                  if (width && height) setImageAspect(width / height);
                }}
                style={[styles.previewImage, { filter: filterCss } as any, {
                  transform: [
                    { translateX: currentEdit.offsetX * stageSize.width },
                    { translateY: currentEdit.offsetY * stageSize.height },
                    { rotate: `${currentEdit.rotation}deg` },
                    { scale: currentEdit.zoom },
                    { scaleX: currentEdit.mirrored ? -1 : 1 },
                  ],
                }]}
              />
              {!!currentEdit.overlayText.trim() && <Text pointerEvents="none" style={[styles.overlayText, { color: currentEdit.overlayColor }]}>{currentEdit.overlayText}</Text>}
              <View ref={drawingHost} pointerEvents={drawMode ? "auto" : "none"} style={styles.drawingLayer} />
            </View> : null}
            {currentFile.type.startsWith("video/") && <View ref={videoHost} style={styles.videoStage}>
              {!objectUrls[index] && <ActivityIndicator color="#fff" />}
            </View>}
            {!fileIsMedia(currentFile) && <View style={styles.filePreview}>
              <Ionicons name="document-text-outline" size={54} color="#d5e1f3" />
              <Text style={styles.fileName} numberOfLines={2}>{currentFile.name}</Text>
              <Text style={styles.fileSize}>{Math.max(1, Math.round(currentFile.size / 1024))} Ko · sera envoyé avec les médias</Text>
            </View>}
          </View>
          {files.length > 1 && <View style={styles.pager}>
            <TouchableOpacity onPress={() => { setIndex(i => Math.max(0, i - 1)); setImageAspect(1.2); }} disabled={index === 0} accessibilityLabel="Média précédent"><Ionicons name="chevron-back" size={22} color={index === 0 ? "#566277" : "#fff"} /></TouchableOpacity>
            <Text style={styles.pagerLabel}>{index + 1} / {files.length}</Text>
            <TouchableOpacity onPress={() => { setIndex(i => Math.min(files.length - 1, i + 1)); setImageAspect(1.2); }} disabled={index === files.length - 1} accessibilityLabel="Média suivant"><Ionicons name="chevron-forward" size={22} color={index === files.length - 1 ? "#566277" : "#fff"} /></TouchableOpacity>
          </View>}
        </>}

        {!!currentFile?.type.startsWith("image/") && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tools}>
          {ratios.map(item => <TouchableOpacity key={item.value} onPress={() => updateEdit({ ratio: item.value, offsetX: 0, offsetY: 0 })} style={[styles.toolChip, currentEdit.ratio === item.value && styles.toolSelected]} testID={`media-crop-${item.value}`}>
            <Ionicons name="crop-outline" size={14} color={currentEdit.ratio === item.value ? "#fff" : "#dce6f5"} /><Text style={[styles.toolText, currentEdit.ratio === item.value && styles.toolTextSelected]}>{item.label}</Text>
          </TouchableOpacity>)}
          <TouchableOpacity onPress={() => updateEdit({ rotation: (currentEdit.rotation - 90 + 360) % 360, offsetX: 0, offsetY: 0 })} style={styles.toolChip} accessibilityLabel="Tourner à gauche"><Ionicons name="arrow-undo-outline" size={16} color="#dce6f5" /><Text style={styles.toolText}>Tourner</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => updateEdit({ mirrored: !currentEdit.mirrored })} style={styles.toolChip} accessibilityLabel="Retourner horizontalement"><Ionicons name="swap-horizontal-outline" size={16} color="#dce6f5" /><Text style={styles.toolText}>Miroir</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => updateEdit({ zoom: Math.min(2.5, currentEdit.zoom + .25) })} style={styles.toolChip} accessibilityLabel="Zoomer"><Ionicons name="add" size={17} color="#dce6f5" /><Text style={styles.toolText}>{currentEdit.zoom.toFixed(1)}×</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => updateEdit({ zoom: Math.max(1, currentEdit.zoom - .25) })} style={styles.toolChip} accessibilityLabel="Dézoomer"><Ionicons name="remove" size={17} color="#dce6f5" /><Text style={styles.toolText}>Zoom</Text></TouchableOpacity>
        </ScrollView>}
        {!!currentFile?.type.startsWith("image/") && <Text style={styles.panHint}>{drawMode ? "Dessinez sur la photo. Le trait sera inclus à l’envoi." : "Glissez la photo pour ajuster le cadrage."}</Text>}

        {!!currentFile?.type.startsWith("image/") && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tools}>
          {filters.map(item => <TouchableOpacity key={item.value} onPress={() => updateEdit({ filter: item.value })} style={[styles.filterChip, currentEdit.filter === item.value && styles.filterSelected]} testID={`media-filter-${item.value}`}>
            <View style={[styles.filterSwatch, { backgroundColor: item.value === "mono" ? "#727985" : item.value === "warm" ? "#c99b6e" : item.value === "vivid" ? "#ec737f" : "#aac5e8" }]} />
            <Text style={[styles.toolText, currentEdit.filter === item.value && styles.toolTextSelected]}>{item.label}</Text>
          </TouchableOpacity>)}
        </ScrollView>}

        {!!currentFile?.type.startsWith("image/") && <View style={styles.overlayRow}>
          <TextInput
            value={currentEdit.overlayText}
            onChangeText={overlayText => updateEdit({ overlayText })}
            placeholder="Ajouter du texte sur la photo"
            placeholderTextColor="#a6afbd"
            maxLength={160}
            style={styles.overlayInput}
            testID="messenger-media-overlay-text"
          />
          {["#ffffff", "#ffdf5d", "#65c8ff", "#ff7474"].map(color => <TouchableOpacity
            key={color} onPress={() => updateEdit({ overlayColor: color })}
            style={[styles.colorDot, { backgroundColor: color }, currentEdit.overlayColor === color && styles.colorDotSelected]}
            accessibilityLabel="Couleur du texte"
          />)}
        </View>}
        {!!currentFile?.type.startsWith("image/") && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tools}>
          <TouchableOpacity onPress={() => setDrawMode(value => !value)} style={[styles.toolChip, drawMode && styles.toolSelected]} testID="messenger-media-draw-toggle">
            <Ionicons name="brush-outline" size={15} color="#fff" /><Text style={styles.toolText}>{drawMode ? "Terminer le dessin" : "Dessiner"}</Text>
          </TouchableOpacity>
          {drawMode && ["#ffffff", "#ffdf5d", "#65c8ff", "#ff7474"].map(color => <TouchableOpacity
            key={color} onPress={() => setDrawingColor(color)}
            style={[styles.colorDot, { backgroundColor: color }, drawingColor === color && styles.colorDotSelected]}
            accessibilityLabel="Couleur du dessin"
          />)}
          {!!currentEdit.strokes.length && <TouchableOpacity onPress={() => updateEdit({ strokes: currentEdit.strokes.slice(0, -1) })} style={styles.toolChip} accessibilityLabel="Annuler le dernier trait">
            <Ionicons name="arrow-undo-outline" size={15} color="#dce6f5" /><Text style={styles.toolText}>Annuler le trait</Text>
          </TouchableOpacity>}
        </ScrollView>}

        <TextInput value={caption} onChangeText={setCaption} placeholder="Ajouter une légende…" placeholderTextColor="#a6afbd" multiline maxLength={1000} style={styles.caption} testID="messenger-media-caption" />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.privacy}>Rien n’est envoyé avant d’appuyer sur « Envoyer ».</Text>
      </View>
    </View>
  </Modal>;
}

const ink = "#102042";
const blue = "#1769e8";
const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(3,9,20,.94)", justifyContent: "center", alignItems: "center", padding: 10 },
  sheet: { width: "100%", maxWidth: 620, maxHeight: "96%", backgroundColor: "#111a29", borderRadius: 20, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, overflow: "hidden" },
  header: { minHeight: 43, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  headerTitle: { flex: 1, color: "#fff", fontSize: 15, fontWeight: "900", textAlign: "center" },
  sendButton: { minWidth: 92, height: 37, borderRadius: 20, backgroundColor: blue, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 7, paddingHorizontal: 12 },
  sendText: { color: "#fff", fontSize: 12, fontWeight: "900" },
  stageArea: { minHeight: 190, maxHeight: 390, marginTop: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#080d15", borderRadius: 15, overflow: "hidden" },
  imageStage: { width: "100%", maxHeight: 390, minHeight: 190, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  previewImage: { width: "100%", height: "100%" },
  drawingLayer: { ...StyleSheet.absoluteFillObject, zIndex: 3 },
  videoStage: { width: "100%", minHeight: 190, maxHeight: 390, alignItems: "center", justifyContent: "center" },
  filePreview: { minHeight: 190, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  fileName: { color: "#fff", fontWeight: "800", textAlign: "center", fontSize: 15 }, fileSize: { color: "#aeb8c8", fontSize: 11 },
  pager: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 16, paddingTop: 5 },
  pagerLabel: { color: "#dce6f5", fontSize: 12, fontWeight: "800" },
  tools: { alignItems: "center", gap: 7, paddingVertical: 8 },
  panHint: { color: "#aeb8c8", fontSize: 10, textAlign: "center", marginTop: -2 },
  toolChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 18, backgroundColor: "#263346" },
  toolSelected: { backgroundColor: blue }, toolText: { color: "#dce6f5", fontSize: 10, fontWeight: "700" }, toolTextSelected: { color: "#fff" },
  filterChip: { alignItems: "center", gap: 3, minWidth: 54, padding: 5, borderRadius: 10, backgroundColor: "#263346" },
  filterSelected: { backgroundColor: blue }, filterSwatch: { width: 26, height: 18, borderRadius: 5 },
  overlayText: { position: "absolute", left: 12, right: 12, bottom: "20%", textAlign: "center", fontSize: 24, fontWeight: "900", textShadowColor: "rgba(0,0,0,.85)", textShadowOffset: { width: 1, height: 2 }, textShadowRadius: 5 },
  overlayRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 4 },
  overlayInput: { flex: 1, minHeight: 38, color: "#fff", backgroundColor: "#263346", borderRadius: 12, paddingHorizontal: 10, fontSize: 12, outlineStyle: "none" as any },
  colorDot: { width: 21, height: 21, borderRadius: 11, borderWidth: 1, borderColor: "rgba(255,255,255,.55)" },
  colorDotSelected: { borderWidth: 3, borderColor: blue },
  caption: { width: "100%", minHeight: 45, maxHeight: 100, color: "#fff", backgroundColor: "#263346", borderRadius: 13, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, textAlignVertical: "top", outlineStyle: "none" as any, marginTop: 5 },
  error: { color: "#ff9090", fontSize: 12, paddingTop: 6 }, privacy: { color: "#aeb8c8", fontSize: 10, textAlign: "center", paddingTop: 7 },
});
