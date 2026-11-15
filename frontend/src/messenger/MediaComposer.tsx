import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  CROP_RATIOS,
  FULL_CROP,
  cropAspect,
  cropForRatio,
  makeEditedImage,
  moveCropRect,
  paintEditedCanvas,
  resizeCropRect,
  rotatedDimensions,
  type CropHandle,
  type CropRatio,
  type MediaEdit,
  type MediaStroke,
} from "./mediaEditing";
import MediaEditorControls, { type Tool } from "./MediaEditorControls";
import { mediaComposerStyles as styles } from "./mediaComposerStyles";
type Props = {
  files: File[];
  visible: boolean;
  initialCaption?: string;
  onClose: () => void;
  onConfirm: (files: File[], caption: string) => Promise<void>;
};

const cropHandles: Exclude<CropHandle, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const handleLabels: Record<Exclude<CropHandle, "move">, string> = {
  nw: "Ajuster le coin supérieur gauche",
  n: "Ajuster le bord supérieur",
  ne: "Ajuster le coin supérieur droit",
  e: "Ajuster le bord droit",
  se: "Ajuster le coin inférieur droit",
  s: "Ajuster le bord inférieur",
  sw: "Ajuster le coin inférieur gauche",
  w: "Ajuster le bord gauche",
};
const blankEdit = (): MediaEdit => ({
  rotation: 0,
  mirrored: false,
  ratio: "original",
  crop: { ...FULL_CROP },
  filter: "none",
  overlayText: "",
  overlayColor: "#ffffff",
  overlayX: 0.5,
  overlayY: 0.72,
  overlaySize: 0.075,
  overlayAlign: "center",
  overlayStyle: "classic",
  overlayBackground: false,
  strokes: [],
});
const fileIsMedia = (file: File) => file.type.startsWith("image/") || file.type.startsWith("video/");

export default function MediaComposer({ files, visible, initialCaption = "", onClose, onConfirm }: Props) {
  const { height: windowHeight } = useWindowDimensions();
  const maxStageHeight = Math.max(145, Math.min(390, windowHeight * 0.36));
  const [index, setIndex] = useState(0);
  const [edits, setEdits] = useState<MediaEdit[]>([]);
  const [caption, setCaption] = useState(initialCaption);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [videoPreviewError, setVideoPreviewError] = useState("");
  const [objectUrls, setObjectUrls] = useState<string[]>([]);
  const [previewImage, setPreviewImage] = useState<HTMLImageElement | null>(null);
  const [imageAspect, setImageAspect] = useState(1.2);
  const [stageBounds, setStageBounds] = useState({ width: 1, height: 1 });
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [activeTool, setActiveTool] = useState<Tool>("view");
  const [drawingColor, setDrawingColor] = useState("#ffffff");
  const [drawingSize, setDrawingSize] = useState(0.007);
  const [cropSnapshot, setCropSnapshot] = useState<Pick<MediaEdit, "crop" | "ratio" | "rotation" | "mirrored"> | null>(null);
  const videoHost = useRef<View | null>(null);
  const previewHost = useRef<View | null>(null);
  const drawingHost = useRef<View | null>(null);
  const cropDrag = useRef({ start: { ...FULL_CROP }, index: 0 });
  const cropGesture = useRef({
    index: 0,
    crop: { ...FULL_CROP },
    sourceAspect: 1,
    targetAspect: undefined as number | undefined,
    size: { width: 1, height: 1 },
  });
  const textDrag = useRef({ x: 0.5, y: 0.72, index: 0, size: { width: 1, height: 1 } });
  const textGesture = useRef({
    active: false,
    x: 0.5,
    y: 0.72,
    index: 0,
    size: { width: 1, height: 1 },
  });
  const initialCaptionOnOpen = useRef(initialCaption);

  const currentFile = files[index];
  const currentEdit = useMemo(() => edits[index] || blankEdit(), [edits, index]);
  const mediaCount = useMemo(() => files.filter(fileIsMedia).length, [files]);
  const isImage = !!currentFile?.type.startsWith("image/");
  const isVideo = !!currentFile?.type.startsWith("video/");
  const sourceAspect = previewImage
    ? rotatedDimensions(previewImage.naturalWidth, previewImage.naturalHeight, currentEdit.rotation).width
      / rotatedDimensions(previewImage.naturalWidth, previewImage.naturalHeight, currentEdit.rotation).height
    : Math.abs(currentEdit.rotation % 180) === 90 ? 1 / imageAspect : imageAspect;
  const displayAspect = activeTool === "crop"
    ? sourceAspect
    : previewImage
      ? cropAspect(currentEdit.crop, previewImage.naturalWidth, previewImage.naturalHeight, currentEdit.rotation)
      : sourceAspect;
  const stageWidth = Math.max(1, Math.min(stageBounds.width, maxStageHeight * displayAspect));
  const stageHeight = Math.max(1, Math.min(stageBounds.height, stageWidth / displayAspect));
  const fileObjectUrl = objectUrls[index];

  useEffect(() => {
    if (!visible) return;
    initialCaptionOnOpen.current = initialCaption;
    setIndex(0);
    setEdits(files.map(() => blankEdit()));
    setCaption(initialCaptionOnOpen.current);
    setError("");
    setVideoPreviewError("");
    setSending(false);
    setImageAspect(1.2);
    setStageBounds({ width: 1, height: 1 });
    setStageSize({ width: 1, height: 1 });
    setActiveTool("view");
    setCropSnapshot(null);
    // initialCaption is sampled only when the composer opens or its file set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, files]);

  useEffect(() => {
    if (!visible || Platform.OS !== "web") return;
    const urls = files.map(file => URL.createObjectURL(file));
    setObjectUrls(urls);
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, [files, visible]);

  useEffect(() => {
    setPreviewImage(null);
    if (!visible || !isImage || Platform.OS !== "web" || !fileObjectUrl) return;
    let alive = true;
    const image = new window.Image();
    image.onload = () => {
      if (!alive) return;
      setPreviewImage(image);
      setImageAspect(image.naturalWidth / Math.max(1, image.naturalHeight));
      setError("");
    };
    image.onerror = () => {
      if (alive) setError("Impossible de lire cette image.");
    };
    image.src = fileObjectUrl;
    return () => {
      alive = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [visible, isImage, fileObjectUrl]);

  useEffect(() => {
    const host = videoHost.current as unknown as HTMLElement | null;
    if (!visible || !isVideo || Platform.OS !== "web" || !host || !fileObjectUrl) return;
    const video = document.createElement("video");
    video.onerror = () => setVideoPreviewError(
      "Ce format vidéo ne peut pas être lu par ce navigateur. Vous pouvez tout de même envoyer le fichier original.",
    );
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.maxHeight = `${maxStageHeight}px`;
    video.style.objectFit = "contain";
    host.replaceChildren(video);
    video.src = fileObjectUrl;
    return () => {
      video.onerror = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
      host.replaceChildren();
    };
  }, [visible, isVideo, fileObjectUrl, maxStageHeight]);

  useEffect(() => {
    const host = previewHost.current as unknown as HTMLElement | null;
    if (!visible || !isImage || Platform.OS !== "web" || !host || !previewImage) return;
    const bounds = host.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const pixelRatio = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
    canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.pointerEvents = "none";
    host.replaceChildren(canvas);
    const context = canvas.getContext("2d");
    if (!context) {
      setError("L’aperçu de cette image n’est pas disponible.");
      return () => host.replaceChildren();
    }
    paintEditedCanvas(
      context,
      previewImage,
      currentEdit,
      activeTool === "crop" ? FULL_CROP : currentEdit.crop,
      canvas.width,
      canvas.height,
      activeTool !== "crop",
    );
    return () => host.replaceChildren();
  }, [visible, isImage, previewImage, currentEdit, activeTool, stageSize]);

  useEffect(() => {
    const host = drawingHost.current as unknown as HTMLElement | null;
    if (!visible || activeTool !== "draw" || !isImage || Platform.OS !== "web" || !host) return;
    const bounds = host.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const pixelRatio = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
    canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    canvas.style.cursor = "crosshair";
    host.replaceChildren(canvas);
    const context = canvas.getContext("2d");
    if (!context) return () => host.replaceChildren();
    context.scale(pixelRatio, pixelRatio);
    currentEdit.strokes.forEach(stroke => {
      if (stroke.points.length < 2) return;
      context.beginPath();
      context.moveTo(stroke.points[0].x * bounds.width, stroke.points[0].y * bounds.height);
      stroke.points.slice(1).forEach(point => context.lineTo(point.x * bounds.width, point.y * bounds.height));
      context.lineWidth = Math.max(1, bounds.width * stroke.width);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = stroke.color;
      context.stroke();
    });
    let activeStroke: MediaStroke | null = null;
    const getPoint = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
        y: Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))),
      };
    };
    const down = (event: PointerEvent) => {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      const point = getPoint(event);
      activeStroke = { color: drawingColor, width: drawingSize, points: [point] };
      context.beginPath();
      context.moveTo(point.x * bounds.width, point.y * bounds.height);
      context.lineWidth = Math.max(1, bounds.width * drawingSize);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = drawingColor;
    };
    const move = (event: PointerEvent) => {
      if (!activeStroke) return;
      event.preventDefault();
      const point = getPoint(event);
      activeStroke.points.push(point);
      context.lineTo(point.x * bounds.width, point.y * bounds.height);
      context.stroke();
    };
    const finish = () => {
      if (activeStroke && activeStroke.points.length > 1) {
        const stroke = activeStroke;
        setEdits(previous => previous.map((edit, itemIndex) => itemIndex === index
          ? { ...edit, strokes: [...edit.strokes, stroke] }
          : edit));
      }
      activeStroke = null;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", finish);
      canvas.removeEventListener("pointercancel", finish);
      host.replaceChildren();
    };
  }, [visible, activeTool, isImage, index, drawingColor, drawingSize, currentEdit.strokes, stageSize]);

  const updateEdit = (patch: Partial<MediaEdit>) => {
    setEdits(previous => previous.map((edit, itemIndex) => itemIndex === index ? { ...edit, ...patch } : edit));
  };

  const targetCropAspect = () => {
    if (currentEdit.ratio === "free") return undefined;
    if (currentEdit.ratio === "original") return sourceAspect;
    return currentEdit.ratio === "square" ? 1 : currentEdit.ratio === "portrait" ? 4 / 5 : 16 / 9;
  };

  cropGesture.current = {
    ...cropGesture.current,
    index,
    crop: currentEdit.crop,
    sourceAspect,
    targetAspect: targetCropAspect(),
    size: stageSize,
  };
  textDrag.current = { x: currentEdit.overlayX, y: currentEdit.overlayY, index, size: stageSize };
  textGesture.current = {
    active: !!currentEdit.overlayText.trim() && activeTool !== "crop" && activeTool !== "draw",
    x: currentEdit.overlayX,
    y: currentEdit.overlayY,
    index,
    size: stageSize,
  };

  const cropHandleResponders = useMemo(() => Object.fromEntries(cropHandles.map(handle => [handle, PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      cropDrag.current = { start: { ...cropGesture.current.crop }, index: cropGesture.current.index };
    },
    onPanResponderMove: (_event, gesture) => {
      const state = cropGesture.current;
      const next = resizeCropRect(
        cropDrag.current.start,
        handle,
        gesture.dx / Math.max(1, state.size.width),
        gesture.dy / Math.max(1, state.size.height),
        state.sourceAspect,
        state.targetAspect,
      );
      setEdits(previous => previous.map((edit, itemIndex) => itemIndex === cropDrag.current.index
        ? { ...edit, crop: next }
        : edit));
    },
  })])), []);

  const moveCropResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      cropDrag.current = { start: { ...cropGesture.current.crop }, index: cropGesture.current.index };
    },
    onPanResponderMove: (_event, gesture) => {
      const state = cropGesture.current;
      const next = moveCropRect(
        cropDrag.current.start,
        gesture.dx / Math.max(1, state.size.width),
        gesture.dy / Math.max(1, state.size.height),
      );
      setEdits(previous => previous.map((edit, itemIndex) => itemIndex === cropDrag.current.index
        ? { ...edit, crop: next }
        : edit));
    },
  }), []);

  const textPanResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => textGesture.current.active,
    onMoveShouldSetPanResponder: () => textGesture.current.active,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      textDrag.current = {
        x: textGesture.current.x,
        y: textGesture.current.y,
        index: textGesture.current.index,
        size: textGesture.current.size,
      };
    },
    onPanResponderMove: (_event, gesture) => {
      const origin = textDrag.current;
      const x = Math.max(.08, Math.min(.92, origin.x + gesture.dx / Math.max(1, origin.size.width)));
      const y = Math.max(.08, Math.min(.92, origin.y + gesture.dy / Math.max(1, origin.size.height)));
      setEdits(previous => previous.map((edit, itemIndex) => itemIndex === origin.index
        ? { ...edit, overlayX: x, overlayY: y }
        : edit));
    },
  }), []);

  const enterCrop = () => {
    setCropSnapshot({
      crop: { ...currentEdit.crop },
      ratio: currentEdit.ratio,
      rotation: currentEdit.rotation,
      mirrored: currentEdit.mirrored,
    });
    setActiveTool("crop");
  };
  const cancelCrop = () => {
    if (cropSnapshot) updateEdit(cropSnapshot);
    setCropSnapshot(null);
    setActiveTool("view");
  };
  const finishCrop = () => {
    setCropSnapshot(null);
    setActiveTool("view");
  };
  const resetCrop = () => updateEdit({
    crop: { ...FULL_CROP },
    ratio: "original",
    rotation: 0,
    mirrored: false,
  });
  const chooseRatio = (ratio: CropRatio) => {
    updateEdit({
      ratio,
      crop: ratio === "free" ? currentEdit.crop : cropForRatio(sourceAspect, ratio),
    });
  };
  const rotateImage = () => {
    updateEdit({
      rotation: (currentEdit.rotation + 90) % 360,
      ratio: "original",
      crop: { ...FULL_CROP },
    });
  };
  const changeFile = (nextIndex: number) => {
    setIndex(nextIndex);
    setImageAspect(1.2);
    setActiveTool("view");
    setCropSnapshot(null);
    setError("");
    setVideoPreviewError("");
  };

  const confirm = async () => {
    if (!files.length || sending) return;
    setSending(true);
    setError("");
    try {
      const edited = await Promise.all(files.map(async (file, itemIndex) =>
        file.type.startsWith("image/") ? makeEditedImage(file, edits[itemIndex] || blankEdit()) : file));
      await onConfirm(edited, caption.trim());
    } catch (e: any) {
      const detail = typeof e?.detail === "string" ? e.detail.trim() : "";
      const message = typeof e?.message === "string" ? e.message.trim() : "";
      setError(detail || message || "Préparation des médias impossible.");
      setSending(false);
    }
  };

  const ratioBox = currentEdit.crop;
  const cropLeft = ratioBox.x * stageSize.width;
  const cropTop = ratioBox.y * stageSize.height;
  const cropWidth = ratioBox.width * stageSize.width;
  const cropHeight = ratioBox.height * stageSize.height;
  const handlePosition: Record<Exclude<CropHandle, "move">, [number, number]> = {
    nw: [cropLeft, cropTop],
    n: [cropLeft + cropWidth / 2, cropTop],
    ne: [cropLeft + cropWidth, cropTop],
    e: [cropLeft + cropWidth, cropTop + cropHeight / 2],
    se: [cropLeft + cropWidth, cropTop + cropHeight],
    s: [cropLeft + cropWidth / 2, cropTop + cropHeight],
    sw: [cropLeft, cropTop + cropHeight],
    w: [cropLeft, cropTop + cropHeight / 2],
  };
  const overlayTargetWidth = Math.max(70, stageSize.width * .88);
  const overlayTargetHeight = Math.max(38, stageSize.height * currentEdit.overlaySize * 2.8);
  const overlayAnchorOffset = currentEdit.overlayAlign === "left"
    ? 0
    : currentEdit.overlayAlign === "right" ? overlayTargetWidth : overlayTargetWidth / 2;
  const overlayTargetLeft = Math.max(0, Math.min(
    stageSize.width - overlayTargetWidth,
    currentEdit.overlayX * stageSize.width - overlayAnchorOffset,
  ));
  const overlayTargetTop = Math.max(0, Math.min(
    stageSize.height - overlayTargetHeight,
    currentEdit.overlayY * stageSize.height - overlayTargetHeight / 2,
  ));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="messenger-media-composer">
          <View style={styles.header}>
            <TouchableOpacity
              onPress={onClose}
              disabled={sending}
              accessibilityRole="button"
              accessibilityLabel="Annuler la sélection"
              testID="messenger-media-cancel"
              style={styles.headerSide}
            >
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>{mediaCount > 1 ? `${mediaCount} médias` : "Aperçu du média"}</Text>
            <TouchableOpacity
              onPress={confirm}
              disabled={sending || !files.length}
              style={styles.sendButton}
              accessibilityRole="button"
              testID="messenger-media-confirm"
            >
              {sending
                ? <ActivityIndicator color="#fff" size="small" />
                : <><Text style={styles.sendText}>Envoyer</Text><Ionicons name="send" size={15} color="#fff" /></>}
            </TouchableOpacity>
          </View>

          {currentFile && <>
            <View
              style={[styles.stageArea, { height: maxStageHeight }]}
              onLayout={event => setStageBounds({
                width: Math.max(1, event.nativeEvent.layout.width),
                height: Math.max(1, event.nativeEvent.layout.height),
              })}
            >
              {isImage ? (
                <View
                  style={[styles.imageStage, { width: stageWidth, height: stageHeight }]}
                  onLayout={event => setStageSize({
                    width: Math.max(1, event.nativeEvent.layout.width),
                    height: Math.max(1, event.nativeEvent.layout.height),
                  })}
                  testID="messenger-media-image-stage"
                >
                  {Platform.OS === "web" ? (
                    <View ref={previewHost} pointerEvents="none" style={styles.canvasLayer} />
                  ) : fileObjectUrl ? (
                    <Image
                      source={{ uri: fileObjectUrl }}
                      resizeMode="contain"
                      style={[StyleSheet.absoluteFillObject, {
                        transform: [{ rotate: `${currentEdit.rotation}deg` }, { scaleX: currentEdit.mirrored ? -1 : 1 }],
                      }]}
                    />
                  ) : <ActivityIndicator color="#fff" />}

                  {activeTool === "crop" && <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID="messenger-media-crop-overlay">
                    <View pointerEvents="none" style={[styles.cropShade, { left: 0, top: 0, right: 0, height: cropTop }]} />
                    <View pointerEvents="none" style={[styles.cropShade, { left: 0, top: cropTop + cropHeight, right: 0, bottom: 0 }]} />
                    <View pointerEvents="none" style={[styles.cropShade, { left: 0, top: cropTop, width: cropLeft, height: cropHeight }]} />
                    <View pointerEvents="none" style={[styles.cropShade, { left: cropLeft + cropWidth, top: cropTop, right: 0, height: cropHeight }]} />
                    <View
                      {...moveCropResponder.panHandlers}
                      style={[styles.cropBox, { left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight }]}
                      accessibilityRole="adjustable"
                      accessibilityLabel="Déplacer le cadre de recadrage"
                      testID="messenger-media-crop-frame"
                    >
                      <View pointerEvents="none" style={[styles.gridLineVertical, { left: "33.333%" }]} />
                      <View pointerEvents="none" style={[styles.gridLineVertical, { left: "66.666%" }]} />
                      <View pointerEvents="none" style={[styles.gridLineHorizontal, { top: "33.333%" }]} />
                      <View pointerEvents="none" style={[styles.gridLineHorizontal, { top: "66.666%" }]} />
                    </View>
                    {cropHandles.map(handle => {
                      const [centerX, centerY] = handlePosition[handle];
                      const horizontal = handle === "e" || handle === "w";
                      const vertical = handle === "n" || handle === "s";
                      const handleWidth = horizontal ? 16 : vertical ? 34 : 23;
                      const handleHeight = horizontal ? 34 : vertical ? 16 : 23;
                      const left = Math.max(0, Math.min(stageSize.width - handleWidth, centerX - handleWidth / 2));
                      const top = Math.max(0, Math.min(stageSize.height - handleHeight, centerY - handleHeight / 2));
                      return <View
                        key={handle}
                        {...cropHandleResponders[handle].panHandlers}
                        style={[styles.cropHandle, { left, top, width: handleWidth, height: handleHeight }]}
                        accessible
                        accessibilityRole="adjustable"
                        accessibilityLabel={handleLabels[handle]}
                        testID={`messenger-media-crop-handle-${handle}`}
                      />;
                    })}
                  </View>}

                  {activeTool !== "crop" && activeTool !== "draw" && !!currentEdit.overlayText.trim() && <View
                    {...textPanResponder.panHandlers}
                    style={[
                      styles.textDragTarget,
                      activeTool === "text" ? styles.textDragActive : styles.textDragIdle,
                      { left: overlayTargetLeft, top: overlayTargetTop, width: overlayTargetWidth, height: overlayTargetHeight },
                    ]}
                    accessible
                    accessibilityRole="adjustable"
                    accessibilityLabel="Déplacer le texte sur la photo"
                    testID="messenger-media-text-overlay"
                  />}

                  <View
                    ref={drawingHost}
                    pointerEvents={activeTool === "draw" ? "auto" : "none"}
                    style={[styles.drawingLayer, activeTool === "crop" && styles.hidden]}
                    testID="messenger-media-drawing-layer"
                  />
                </View>
              ) : isVideo ? (
                <View ref={videoHost} style={styles.videoStage}>
                  {!fileObjectUrl && <ActivityIndicator color="#fff" />}
                </View>
              ) : (
                <View style={styles.filePreview}>
                  <Ionicons name="document-text-outline" size={54} color="#d5e1f3" />
                  <Text style={styles.fileName} numberOfLines={2}>{currentFile.name}</Text>
                  <Text style={styles.fileSize}>{Math.max(1, Math.round(currentFile.size / 1024))} Ko · sera envoyé avec les médias</Text>
                </View>
              )}
            </View>
            {isVideo && !!videoPreviewError && <Text
              style={styles.videoPreviewWarning}
              accessibilityRole="alert"
              testID="messenger-video-preview-warning"
            >
              {videoPreviewError}
            </Text>}
            {files.length > 1 && <View style={styles.pager}>
              <TouchableOpacity onPress={() => changeFile(Math.max(0, index - 1))} disabled={index === 0} accessibilityLabel="Média précédent">
                <Ionicons name="chevron-back" size={22} color={index === 0 ? "#566277" : "#fff"} />
              </TouchableOpacity>
              <Text style={styles.pagerLabel}>{index + 1} / {files.length}</Text>
              <TouchableOpacity onPress={() => changeFile(Math.min(files.length - 1, index + 1))} disabled={index === files.length - 1} accessibilityLabel="Média suivant">
                <Ionicons name="chevron-forward" size={22} color={index === files.length - 1 ? "#566277" : "#fff"} />
              </TouchableOpacity>
            </View>}
          </>}

          <ScrollView
            style={styles.editorScroll}
            contentContainerStyle={styles.editorContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {isImage && <MediaEditorControls
              tool={activeTool}
              currentEdit={currentEdit}
              drawingColor={drawingColor}
              drawingSize={drawingSize}
              onToolCrop={() => activeTool === "crop" ? cancelCrop() : enterCrop()}
              onToolText={() => setActiveTool(activeTool === "text" ? "view" : "text")}
              onToolDraw={() => setActiveTool(activeTool === "draw" ? "view" : "draw")}
              onUpdate={updateEdit}
              onChooseRatio={chooseRatio}
              onRotate={rotateImage}
              onResetCrop={resetCrop}
              onCancelCrop={cancelCrop}
              onFinishCrop={finishCrop}
              onDrawingColor={setDrawingColor}
              onDrawingSize={setDrawingSize}
              onTextDone={() => setActiveTool("view")}
              onDrawDone={() => setActiveTool("view")}
            />}

            <TextInput
              value={caption}
              onChangeText={setCaption}
              placeholder="Ajouter une légende…"
              placeholderTextColor="#a6afbd"
              multiline
              maxLength={1000}
              style={styles.caption}
              testID="messenger-media-caption"
            />
            {error ? <Text style={styles.error} accessibilityRole="alert" testID="messenger-media-error">{error}</Text> : null}
            <Text style={styles.privacy}>Rien n’est envoyé avant d’appuyer sur « Envoyer ».</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
