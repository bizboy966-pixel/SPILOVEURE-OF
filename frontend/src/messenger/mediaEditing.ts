export type CropRect = { x: number; y: number; width: number; height: number };
export type CropRatio = "original" | "square" | "portrait" | "wide" | "free";
export type MediaStroke = { color: string; width: number; points: { x: number; y: number }[] };
export type MediaEdit = {
  rotation: number;
  mirrored: boolean;
  ratio: CropRatio;
  crop: CropRect;
  filter: string;
  overlayText: string;
  overlayColor: string;
  overlayX: number;
  overlayY: number;
  overlaySize: number;
  overlayAlign: CanvasTextAlign;
  overlayStyle: "classic" | "serif" | "mono";
  overlayBackground: boolean;
  strokes: MediaStroke[];
};

export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };
export const CROP_RATIOS: { value: CropRatio; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "square", label: "1:1" },
  { value: "portrait", label: "4:5" },
  { value: "wide", label: "16:9" },
  { value: "free", label: "Libre" },
];

const PRESET_RATIO: Partial<Record<CropRatio, number>> = {
  square: 1,
  portrait: 4 / 5,
  wide: 16 / 9,
};

export function rotatedDimensions(width: number, height: number, rotation: number): { width: number; height: number } {
  return Math.abs(rotation % 180) === 90 ? { width: height, height: width } : { width, height };
}

export function cropAspect(crop: CropRect, width: number, height: number, rotation: number): number {
  const oriented = rotatedDimensions(width, height, rotation);
  return Math.max(0.001, (crop.width * oriented.width) / Math.max(0.001, crop.height * oriented.height));
}

export function cropForRatio(sourceAspect: number, ratio: CropRatio): CropRect {
  const target = ratio === "original" ? sourceAspect : PRESET_RATIO[ratio];
  if (!target) return FULL_CROP;
  const normalizedRatio = target / Math.max(0.001, sourceAspect);
  if (normalizedRatio >= 1) {
    const height = 1 / normalizedRatio;
    return { x: 0, y: (1 - height) / 2, width: 1, height };
  }
  const width = normalizedRatio;
  return { x: (1 - width) / 2, y: 0, width, height: 1 };
}

export type CropHandle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export function moveCropRect(crop: CropRect, dx: number, dy: number): CropRect {
  return {
    ...crop,
    x: Math.max(0, Math.min(1 - crop.width, crop.x + dx)),
    y: Math.max(0, Math.min(1 - crop.height, crop.y + dy)),
  };
}

export function resizeCropRect(
  crop: CropRect,
  handle: Exclude<CropHandle, "move">,
  dx: number,
  dy: number,
  sourceAspect: number,
  targetAspect?: number,
): CropRect {
  const leftSide = handle.includes("w");
  const rightSide = handle.includes("e");
  const topSide = handle.includes("n");
  const bottomSide = handle.includes("s");
  const corner = (leftSide || rightSide) && (topSide || bottomSide);
  const fixedRatio = targetAspect ? targetAspect / Math.max(0.001, sourceAspect) : undefined;
  const minSize = 0.035;
  let left = crop.x;
  let right = crop.x + crop.width;
  let top = crop.y;
  let bottom = crop.y + crop.height;

  if (corner && fixedRatio) {
    const anchorX = leftSide ? right : left;
    const anchorY = topSide ? bottom : top;
    const movedX = Math.max(0, Math.min(1, (leftSide ? left : right) + dx));
    const movedY = Math.max(0, Math.min(1, (topSide ? top : bottom) + dy));
    let width = Math.max(0, leftSide ? anchorX - movedX : movedX - anchorX);
    let height = Math.max(0, topSide ? anchorY - movedY : movedY - anchorY);
    if (width / Math.max(height, 0.0001) > fixedRatio) height = width / fixedRatio;
    else width = height * fixedRatio;
    const maxWidth = leftSide ? anchorX : 1 - anchorX;
    const maxHeight = topSide ? anchorY : 1 - anchorY;
    width = Math.min(width, maxWidth, maxHeight * fixedRatio);
    height = width / fixedRatio;
    if (width < minSize || height < minSize) {
      width = Math.min(maxWidth, maxHeight * fixedRatio, Math.max(minSize, minSize * fixedRatio));
      height = width / fixedRatio;
    }
    left = leftSide ? anchorX - width : anchorX;
    right = leftSide ? anchorX : anchorX + width;
    top = topSide ? anchorY - height : anchorY;
    bottom = topSide ? anchorY : anchorY + height;
  } else if (fixedRatio && (leftSide || rightSide || topSide || bottomSide)) {
    if (leftSide || rightSide) {
      const anchorX = leftSide ? right : left;
      let width = Math.max(minSize, Math.abs((leftSide ? left : right) + dx - anchorX));
      const centerY = (top + bottom) / 2;
      let height = width / fixedRatio;
      const maxWidth = leftSide ? anchorX : 1 - anchorX;
      height = Math.min(height, 2 * centerY, 2 * (1 - centerY), maxWidth / fixedRatio);
      width = height * fixedRatio;
      left = leftSide ? anchorX - width : anchorX;
      right = leftSide ? anchorX : anchorX + width;
      top = centerY - height / 2;
      bottom = centerY + height / 2;
    } else {
      const anchorY = topSide ? bottom : top;
      let height = Math.max(minSize, Math.abs((topSide ? top : bottom) + dy - anchorY));
      const centerX = (left + right) / 2;
      let width = height * fixedRatio;
      height = Math.min(height, 2 * centerX, 2 * (1 - centerX), (topSide ? anchorY : 1 - anchorY));
      width = height * fixedRatio;
      left = centerX - width / 2;
      right = centerX + width / 2;
      top = topSide ? anchorY - height : anchorY;
      bottom = topSide ? anchorY : anchorY + height;
    }
  } else {
    if (leftSide) left = Math.max(0, Math.min(right - minSize, left + dx));
    if (rightSide) right = Math.min(1, Math.max(left + minSize, right + dx));
    if (topSide) top = Math.max(0, Math.min(bottom - minSize, top + dy));
    if (bottomSide) bottom = Math.min(1, Math.max(top + minSize, bottom + dy));
  }

  left = Math.max(0, Math.min(1 - minSize, left));
  top = Math.max(0, Math.min(1 - minSize, top));
  right = Math.max(left + minSize, Math.min(1, right));
  bottom = Math.max(top + minSize, Math.min(1, bottom));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

export function paintEditedCanvas(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  edit: MediaEdit,
  crop: CropRect,
  width: number,
  height: number,
  includeAnnotations: boolean,
): void {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const oriented = rotatedDimensions(sourceWidth, sourceHeight, edit.rotation);
  const scaleX = width / Math.max(1, crop.width * oriented.width);
  const scaleY = height / Math.max(1, crop.height * oriented.height);
  const cropLeftFromCenter = -oriented.width / 2 + crop.x * oriented.width;
  const cropTopFromCenter = -oriented.height / 2 + crop.y * oriented.height;

  context.clearRect(0, 0, width, height);
  context.save();
  context.filter = edit.filter || "none";
  context.translate(-cropLeftFromCenter * scaleX, -cropTopFromCenter * scaleY);
  context.scale(scaleX, scaleY);
  context.rotate(edit.rotation * Math.PI / 180);
  context.scale(edit.mirrored ? -1 : 1, 1);
  context.drawImage(image, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
  context.restore();
  context.filter = "none";

  if (!includeAnnotations) return;
  edit.strokes.forEach(stroke => {
    if (stroke.points.length < 2) return;
    context.beginPath();
    context.moveTo(stroke.points[0].x * width, stroke.points[0].y * height);
    stroke.points.slice(1).forEach(point => context.lineTo(point.x * width, point.y * height));
    context.lineWidth = Math.max(1, width * stroke.width);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = stroke.color;
    context.stroke();
  });

  if (!edit.overlayText.trim()) return;
  const fontSize = Math.max(12, height * edit.overlaySize);
  const fontFamily = edit.overlayStyle === "serif" ? "Georgia, serif"
    : edit.overlayStyle === "mono" ? "ui-monospace, monospace"
      : "system-ui, sans-serif";
  context.font = `800 ${fontSize}px ${fontFamily}`;
  context.textAlign = edit.overlayAlign;
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.lineWidth = Math.max(1, fontSize * .11);
  context.strokeStyle = "rgba(0,0,0,.76)";
  context.fillStyle = edit.overlayColor;
  const maxTextWidth = width * .84;
  const lines = wrapText(context, edit.overlayText, maxTextWidth);
  const lineHeight = fontSize * 1.18;
  const centerY = edit.overlayY * height;
  const anchorX = edit.overlayX * width;
  if (edit.overlayBackground) {
    const textWidth = Math.max(1, ...lines.map(line => context.measureText(line).width));
    const paddingX = fontSize * .34;
    const paddingY = fontSize * .18;
    const backgroundWidth = Math.min(width * .92, textWidth + paddingX * 2);
    const backgroundLeft = edit.overlayAlign === "center"
      ? anchorX - backgroundWidth / 2
      : edit.overlayAlign === "right" ? anchorX - backgroundWidth : anchorX;
    const backgroundTop = centerY - ((lines.length - 1) * lineHeight) / 2 - fontSize / 2 - paddingY;
    context.save();
    context.fillStyle = "rgba(0,0,0,.56)";
    context.beginPath();
    if (typeof context.roundRect === "function") {
      context.roundRect(backgroundLeft, backgroundTop, backgroundWidth, lineHeight * lines.length + paddingY * 2, fontSize * .16);
    } else {
      context.rect(backgroundLeft, backgroundTop, backgroundWidth, lineHeight * lines.length + paddingY * 2);
    }
    context.fill();
    context.restore();
  }
  lines.forEach((line, index) => {
    const y = centerY + (index - (lines.length - 1) / 2) * lineHeight;
    context.strokeText(line, anchorX, y, maxTextWidth);
    context.fillText(line, anchorX, y, maxTextWidth);
  });
}

export async function makeEditedImage(file: File, edit: MediaEdit): Promise<File> {
  if (typeof document === "undefined") return file;
  const needsEdit = edit.rotation !== 0 || edit.mirrored || edit.crop.x !== 0 || edit.crop.y !== 0
    || edit.crop.width !== 1 || edit.crop.height !== 1 || edit.filter !== "none"
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
    const oriented = rotatedDimensions(image.naturalWidth, image.naturalHeight, edit.rotation);
    const outputWidth = edit.crop.width * oriented.width;
    const outputHeight = edit.crop.height * oriented.height;
    const outputScale = Math.min(1, 2200 / Math.max(outputWidth, outputHeight));
    const width = Math.max(1, Math.round(outputWidth * outputScale));
    const height = Math.max(1, Math.round(outputHeight * outputScale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("L’éditeur d’image n’est pas disponible.");
    paintEditedCanvas(context, image, edit, edit.crop, width, height, true);
    const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error("Impossible d’exporter l’image.")), mime, .92);
    });
    const base = file.name.replace(/\.[^.]+$/, "");
    const extension = mime === "image/png" ? ".png" : ".jpg";
    return new File([blob], `${base}-modifiee${extension}`, { type: mime, lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
