import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { formatVoiceDuration } from "./voiceDuration";

type Props = {
  seconds: number;
  waveform: number[];
  paused: boolean;
  viewOnce: boolean;
  darkMode?: boolean;
  sending?: boolean;
  onCancel: () => void;
  onTogglePause: () => void;
  onToggleViewOnce: () => void;
  onSend: () => void;
};

export default function VoiceRecorderControls({
  seconds, waveform, paused, viewOnce, darkMode = false, sending = false,
  onCancel, onTogglePause, onToggleViewOnce, onSend,
}: Props) {
  return (
    <View
      style={[styles.shell, darkMode && styles.shellDark]}
      testID="messenger-voice-recorder"
      accessibilityLabel={sending ? "Envoi du message vocal" : "Enregistrement du message vocal"}
    >
      {sending ? (
        <View style={styles.sendingRow}>
          <Ionicons name="cloud-upload-outline" size={20} color="#1769e8" />
          <Text style={[styles.sendingText, darkMode && styles.textDark]}>Envoi du vocal…</Text>
        </View>
      ) : <>
        <View style={styles.waveRow}>
          <Text style={[styles.duration, darkMode && styles.textDark]} testID="messenger-voice-recording-duration">
            {formatVoiceDuration(seconds)}
          </Text>
          <View style={styles.waveform} accessibilityLabel="Forme d’onde du microphone">
            {waveform.map((height, index) => (
              <View
                key={index}
                style={[styles.waveBar, {
                  height: Math.max(4, Math.min(38, height)),
                  backgroundColor: paused ? "#a8b2bd" : "#68727e",
                  opacity: paused ? 0.65 : 0.95,
                }]}
              />
            ))}
          </View>
          <TouchableOpacity
            onPress={onToggleViewOnce}
            accessibilityRole="button"
            accessibilityState={{ selected: viewOnce }}
            accessibilityLabel={viewOnce ? "Désactiver l’écoute unique" : "Activer l’écoute unique"}
            testID="messenger-voice-view-once"
            style={[styles.onceButton, viewOnce && styles.onceButtonActive]}
          >
            <Ionicons name="timer-outline" size={22} color={viewOnce ? "#fff" : "#495463"} />
            <Text style={[styles.onceLabel, viewOnce && styles.onceLabelActive]}>1</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.controlsRow}>
          <TouchableOpacity
            onPress={onCancel}
            style={styles.deleteButton}
            accessibilityRole="button"
            accessibilityLabel="Supprimer l’enregistrement vocal"
            testID="messenger-voice-discard"
          >
            <Ionicons name="trash" size={21} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onTogglePause}
            style={[styles.pauseButton, darkMode && styles.pauseButtonDark]}
            accessibilityRole="button"
            accessibilityLabel={paused ? "Reprendre l’enregistrement vocal" : "Mettre l’enregistrement vocal en pause"}
            testID="messenger-voice-pause"
          >
            <Ionicons name={paused ? "play" : "pause"} size={21} color={darkMode ? "#f6f8fb" : "#202833"} />
            <Text style={[styles.pauseText, darkMode && styles.textDark]}>{paused ? "Reprendre" : "Pause"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onSend}
            style={styles.sendButton}
            accessibilityRole="button"
            accessibilityLabel="Envoyer le message vocal"
            testID="messenger-send-voice"
          >
            <Ionicons name="send" size={22} color="#082c1d" />
          </TouchableOpacity>
        </View>
      </>}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    marginHorizontal: 10, marginBottom: 10, padding: 13, borderRadius: 28,
    backgroundColor: "#f8fafb", borderWidth: 1, borderColor: "#e5ebee",
    gap: 12, shadowColor: "#102042", shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12, shadowRadius: 10, elevation: 6,
  },
  shellDark: { backgroundColor: "#1b2635", borderColor: "#344153" },
  waveRow: { minHeight: 43, flexDirection: "row", alignItems: "center", gap: 11 },
  duration: { minWidth: 46, color: "#202833", fontSize: 18, fontVariant: ["tabular-nums"], fontWeight: "600" },
  waveform: { flex: 1, height: 42, minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 2, overflow: "hidden" },
  waveBar: { width: 3, minWidth: 2, borderRadius: 3 },
  onceButton: { width: 42, height: 42, borderRadius: 21, flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#e9edf1" },
  onceButtonActive: { backgroundColor: "#148c55" },
  onceLabel: { marginLeft: -6, marginTop: 5, color: "#495463", fontSize: 10, fontWeight: "900" },
  onceLabelActive: { color: "#fff" },
  controlsRow: { minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  deleteButton: { width: 48, height: 48, borderRadius: 24, backgroundColor: "#b61c48", alignItems: "center", justifyContent: "center" },
  pauseButton: { flex: 1, height: 48, borderRadius: 24, backgroundColor: "#e6e9ec", flexDirection: "row", gap: 12, alignItems: "center", justifyContent: "center" },
  pauseButtonDark: { backgroundColor: "#303b48" },
  pauseText: { color: "#202833", fontSize: 15, fontWeight: "700" },
  sendButton: { width: 54, height: 54, borderRadius: 27, backgroundColor: "#20c66a", alignItems: "center", justifyContent: "center" },
  sendingRow: { minHeight: 65, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  sendingText: { color: "#202833", fontSize: 14, fontWeight: "700" },
  textDark: { color: "#f6f8fb" },
});
