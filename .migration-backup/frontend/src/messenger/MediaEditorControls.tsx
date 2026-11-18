import React from "react";
import { Ionicons } from "@expo/vector-icons";
import { ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { CROP_RATIOS, type CropRatio, type MediaEdit } from "./mediaEditing";
import { mediaComposerStyles as styles } from "./mediaComposerStyles";

export type Tool = "view" | "crop" | "text" | "draw";

type Props = {
  tool: Tool;
  currentEdit: MediaEdit;
  drawingColor: string;
  drawingSize: number;
  onToolCrop: () => void;
  onToolText: () => void;
  onToolDraw: () => void;
  onUpdate: (patch: Partial<MediaEdit>) => void;
  onChooseRatio: (ratio: CropRatio) => void;
  onRotate: () => void;
  onResetCrop: () => void;
  onCancelCrop: () => void;
  onFinishCrop: () => void;
  onDrawingColor: (color: string) => void;
  onDrawingSize: (size: number) => void;
  onTextDone: () => void;
  onDrawDone: () => void;
};

const filters = [
  { value: "normal", label: "Normal", css: "none" },
  { value: "mono", label: "N&B", css: "grayscale(1)" },
  { value: "warm", label: "Chaud", css: "sepia(.5) saturate(1.2)" },
  { value: "vivid", label: "Vif", css: "saturate(1.6) contrast(1.08)" },
];
const colors = ["#ffffff", "#ffdf5d", "#65c8ff", "#ff7474"];

export default function MediaEditorControls({
  tool,
  currentEdit,
  drawingColor,
  drawingSize,
  onToolCrop,
  onToolText,
  onToolDraw,
  onUpdate,
  onChooseRatio,
  onRotate,
  onResetCrop,
  onCancelCrop,
  onFinishCrop,
  onDrawingColor,
  onDrawingSize,
  onTextDone,
  onDrawDone,
}: Props) {
  return <React.Fragment>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tools}>
      <TouchableOpacity
        onPress={onToolCrop}
        style={[styles.toolChip, tool === "crop" && styles.toolSelected]}
        accessibilityRole="button"
        accessibilityLabel="Recadrer la photo"
        testID="messenger-media-tool-crop"
      >
        <Ionicons name="crop-outline" size={15} color="#fff" /><Text style={styles.toolText}>Recadrer</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onToolText}
        style={[styles.toolChip, tool === "text" && styles.toolSelected]}
        accessibilityRole="button"
        accessibilityLabel="Ajouter ou déplacer du texte"
        testID="messenger-media-tool-text"
      >
        <Ionicons name="text-outline" size={15} color="#fff" /><Text style={styles.toolText}>Texte</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onToolDraw}
        style={[styles.toolChip, tool === "draw" && styles.toolSelected]}
        accessibilityRole="button"
        accessibilityLabel="Dessiner sur la photo"
        testID="messenger-media-tool-draw"
      >
        <Ionicons name="brush-outline" size={15} color="#fff" /><Text style={styles.toolText}>Dessiner</Text>
      </TouchableOpacity>
    </ScrollView>

    {tool === "crop" && <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tools}>
        {CROP_RATIOS.map(item => <TouchableOpacity
          key={item.value}
          onPress={() => onChooseRatio(item.value)}
          style={[styles.toolChip, currentEdit.ratio === item.value && styles.toolSelected]}
          accessibilityRole="button"
          accessibilityState={{ selected: currentEdit.ratio === item.value }}
          testID={`media-crop-${item.value}`}
        >
          <Text style={[styles.toolText, currentEdit.ratio === item.value && styles.toolTextSelected]}>{item.label}</Text>
        </TouchableOpacity>)}
        <TouchableOpacity onPress={onRotate} style={styles.toolChip} accessibilityLabel="Tourner de 90 degrés" testID="messenger-media-rotate">
          <Ionicons name="refresh-outline" size={15} color="#fff" /><Text style={styles.toolText}>Tourner</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => onUpdate({ mirrored: !currentEdit.mirrored })} style={[styles.toolChip, currentEdit.mirrored && styles.toolSelected]} accessibilityLabel="Retourner horizontalement" testID="messenger-media-mirror">
          <Ionicons name="swap-horizontal-outline" size={15} color="#fff" /><Text style={styles.toolText}>Miroir</Text>
        </TouchableOpacity>
      </ScrollView>
      <View style={styles.cropActions}>
        <TouchableOpacity onPress={onResetCrop} accessibilityRole="button" testID="messenger-media-crop-reset">
          <Text style={styles.actionText}>Réinitialiser</Text>
        </TouchableOpacity>
        <Text style={styles.cropHint}>Le texte et les traits gardent leur place dans le cadre final.</Text>
        <View style={styles.actionButtons}>
          <TouchableOpacity onPress={onCancelCrop} style={styles.secondaryAction} testID="messenger-media-crop-cancel">
            <Text style={styles.secondaryActionText}>Annuler</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onFinishCrop} style={styles.doneAction} testID="messenger-media-crop-done">
            <Text style={styles.doneActionText}>Terminé</Text>
          </TouchableOpacity>
        </View>
      </View>
    </>}

    {tool !== "crop" && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tools}>
      {filters.map(item => <TouchableOpacity
        key={item.value}
        onPress={() => onUpdate({ filter: item.css })}
        style={[styles.filterChip, currentEdit.filter === item.css && styles.filterSelected]}
        testID={`media-filter-${item.value}`}
      >
        <View style={[styles.filterSwatch, { backgroundColor: item.value === "mono" ? "#727985" : item.value === "warm" ? "#c99b6e" : item.value === "vivid" ? "#ec737f" : "#aac5e8" }]} />
        <Text style={[styles.toolText, currentEdit.filter === item.css && styles.toolTextSelected]}>{item.label}</Text>
      </TouchableOpacity>)}
    </ScrollView>}

    {tool === "text" && <>
      <View style={styles.overlayRow}>
        <TextInput
          value={currentEdit.overlayText}
          onChangeText={overlayText => onUpdate({ overlayText })}
          placeholder="Ajouter du texte sur la photo"
          placeholderTextColor="#a6afbd"
          maxLength={160}
          style={styles.overlayInput}
          testID="messenger-media-overlay-text"
        />
        {colors.map(color => <TouchableOpacity
          key={color}
          onPress={() => onUpdate({ overlayColor: color })}
          style={[styles.colorDot, { backgroundColor: color }, currentEdit.overlayColor === color && styles.colorDotSelected]}
          accessibilityRole="button"
          accessibilityLabel="Couleur du texte"
          testID={`messenger-media-text-color-${color.slice(1)}`}
        />)}
      </View>
      <View style={styles.textStyleRow}>
        <Text style={styles.toolText}>Style</Text>
        {[
          { value: "classic" as const, label: "Classique" },
          { value: "serif" as const, label: "Sérif" },
          { value: "mono" as const, label: "Mono" },
        ].map(item => <TouchableOpacity
          key={item.value}
          onPress={() => onUpdate({ overlayStyle: item.value })}
          style={[styles.toolChip, currentEdit.overlayStyle === item.value && styles.toolSelected]}
          accessibilityRole="button"
          accessibilityState={{ selected: currentEdit.overlayStyle === item.value }}
          testID={`messenger-media-text-style-${item.value}`}
        >
          <Text style={styles.toolText}>{item.label}</Text>
        </TouchableOpacity>)}
      </View>
      <View style={styles.textStyleRow}>
        <Text style={styles.toolText}>Alignement</Text>
        {[
          { value: "left" as const, label: "Gauche" },
          { value: "center" as const, label: "Centre" },
          { value: "right" as const, label: "Droite" },
        ].map(item => <TouchableOpacity
          key={item.value}
          onPress={() => onUpdate({ overlayAlign: item.value })}
          style={[styles.toolChip, currentEdit.overlayAlign === item.value && styles.toolSelected]}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          accessibilityState={{ selected: currentEdit.overlayAlign === item.value }}
          testID={`messenger-media-text-align-${item.value}`}
        >
          <Text style={styles.toolText}>{item.label}</Text>
        </TouchableOpacity>)}
        <TouchableOpacity
          onPress={() => onUpdate({ overlayBackground: !currentEdit.overlayBackground })}
          style={[styles.toolChip, currentEdit.overlayBackground && styles.toolSelected]}
          accessibilityRole="button"
          accessibilityLabel={currentEdit.overlayBackground ? "Retirer le fond du texte" : "Ajouter un fond au texte"}
          accessibilityState={{ checked: currentEdit.overlayBackground }}
          testID="messenger-media-text-background"
        >
          <Ionicons name="square-outline" size={15} color="#fff" /><Text style={styles.toolText}>Fond</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.textEditRow}>
        <Text style={styles.toolText}>Taille</Text>
        <TouchableOpacity onPress={() => onUpdate({ overlaySize: Math.max(.045, currentEdit.overlaySize - .01) })} style={styles.toolChip} accessibilityLabel="Réduire le texte">
          <Ionicons name="remove" size={15} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => onUpdate({ overlaySize: Math.min(.14, currentEdit.overlaySize + .01) })} style={styles.toolChip} accessibilityLabel="Agrandir le texte">
          <Ionicons name="add" size={15} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.dragHint}>{currentEdit.overlayText.trim() ? "Glissez le texte sur la photo pour le déplacer." : "Le texte apparaîtra sur la photo."}</Text>
      </View>
      <TouchableOpacity onPress={onTextDone} style={styles.textDone} testID="messenger-media-text-done">
        <Text style={styles.doneActionText}>Terminé</Text>
      </TouchableOpacity>
    </>}

    {tool === "draw" && <View style={styles.drawControls}>
      <View style={styles.drawColors}>
        {colors.map(color => <TouchableOpacity
          key={color}
          onPress={() => onDrawingColor(color)}
          style={[styles.colorDot, { backgroundColor: color }, drawingColor === color && styles.colorDotSelected]}
          accessibilityRole="button"
          accessibilityLabel="Couleur du dessin"
          testID={`messenger-media-draw-color-${color.slice(1)}`}
        />)}
      </View>
      <View style={styles.drawSizes}>
        <Text style={styles.toolText}>Trait</Text>
        {[{ size: .004, label: "Fin" }, { size: .007, label: "Moyen" }, { size: .013, label: "Épais" }].map(item => <TouchableOpacity
          key={item.label}
          onPress={() => onDrawingSize(item.size)}
          style={[styles.toolChip, drawingSize === item.size && styles.toolSelected]}
          accessibilityRole="button"
          accessibilityState={{ selected: drawingSize === item.size }}
          testID={`messenger-media-draw-size-${item.label.toLowerCase()}`}
        >
          <Text style={styles.toolText}>{item.label}</Text>
        </TouchableOpacity>)}
        <TouchableOpacity
          onPress={() => onUpdate({ strokes: currentEdit.strokes.slice(0, -1) })}
          disabled={!currentEdit.strokes.length}
          style={[styles.toolChip, !currentEdit.strokes.length && styles.disabled]}
          accessibilityLabel="Annuler le dernier trait"
          testID="messenger-media-draw-undo"
        >
          <Ionicons name="arrow-undo-outline" size={15} color="#dce6f5" /><Text style={styles.toolText}>Annuler</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onDrawDone} style={styles.doneAction} testID="messenger-media-draw-done">
          <Text style={styles.doneActionText}>Terminé</Text>
        </TouchableOpacity>
      </View>
    </View>}
  </React.Fragment>;
}
