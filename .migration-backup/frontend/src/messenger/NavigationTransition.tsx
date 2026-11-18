import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { Animated, Image, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

type Direction = "toChat" | "toHome";
type NavigationTransition = {
  active: boolean;
  toChat: (navigate: () => void) => void;
  toHome: (navigate: () => void) => void;
};
const Context = createContext<NavigationTransition>({
  active: false, toChat: navigate => navigate(), toHome: navigate => navigate(),
});
const logo = require("../../assets/images/spiloveure-logo.png");

export function useNavigationTransition() {
  return useContext(Context);
}

export function NavigationTransitionProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState(false);
  const [direction, setDirection] = useState<Direction>("toChat");
  const progress = useRef(new Animated.Value(0)).current;
  const running = useRef(false);
  const run = useCallback((next: Direction, navigate: () => void) => {
    if (running.current) return;
    running.current = true;
    setDirection(next);
    setActive(true);
    progress.setValue(0);
    navigate();
    requestAnimationFrame(() => {
      Animated.timing(progress, { toValue: 1, duration: 330, useNativeDriver: true }).start(() => {
        running.current = false;
        setActive(false);
      });
    });
  }, [progress]);
  const toChat = useCallback((navigate: () => void) => run("toChat", navigate), [run]);
  const toHome = useCallback((navigate: () => void) => run("toHome", navigate), [run]);
  const context = { active, toChat, toHome };
  const mainTranslate = progress.interpolate({
    inputRange: [0, 1], outputRange: direction === "toChat" ? [0, 115] : [115, 0],
  });
  const chatTranslate = progress.interpolate({
    inputRange: [0, 1], outputRange: direction === "toChat" ? [-115, 0] : [0, -115],
  });

  return <Context.Provider value={context}>
    {children}
    {active && <View pointerEvents="none" style={styles.overlay}>
      <Animated.View style={[styles.positioned, { transform: [{ translateY: mainTranslate }] }]}>
        <View style={styles.mainBar}>
          <View style={styles.mainItem}><Ionicons name="home" size={22} color={theme.colors.primary} /><Text style={styles.mainLabel}>Accueil</Text></View>
          <View style={styles.mainItem}><Ionicons name="sparkles" size={22} color="#8FA6C4" /><Text style={styles.mainLabel}>IA SPV</Text></View>
          <View style={styles.taskSlot}><View style={styles.task}><Ionicons name="clipboard" size={25} color="#fff" /></View><Text style={styles.taskLabel}>Tâches</Text></View>
          <View style={styles.mainItem}><Ionicons name="chatbubbles" size={22} color={theme.colors.primary} /><Text style={styles.mainLabelActive}>Chat</Text></View>
          <View style={styles.mainItem}><Ionicons name="person" size={22} color="#8FA6C4" /><Text style={styles.mainLabel}>Profil</Text></View>
        </View>
      </Animated.View>
      <Animated.View style={[styles.positioned, { transform: [{ translateY: chatTranslate }] }]}>
        <View style={styles.chatBar}>
          <View style={styles.chatItem}><Ionicons name="chatbubbles" size={23} color={theme.colors.primary} /><Text style={styles.chatActive}>Échanges</Text></View>
          <View style={styles.chatItem}><Ionicons name="people" size={23} color="#9ca8b8" /><Text style={styles.chatLabel}>Contacts</Text></View>
          <View style={styles.chatLogoWrap}><View style={styles.chatLogo}><Image source={logo} style={styles.chatImage} resizeMode="contain" /></View></View>
          <View style={styles.chatItem}><Ionicons name="megaphone" size={22} color="#9ca8b8" /><Text style={styles.chatLabel}>Actus</Text></View>
          <View style={styles.chatItem}><Ionicons name="person" size={22} color="#9ca8b8" /><Text style={styles.chatLabel}>Profil</Text></View>
        </View>
      </Animated.View>
    </View>}
  </Context.Provider>;
}

const styles = StyleSheet.create({
  overlay: { position: "absolute", left: 0, right: 0, bottom: 0, height: 100, zIndex: 10000 },
  positioned: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 12, paddingBottom: 10 },
  mainBar: { height: 76, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-around", backgroundColor: theme.colors.surface, borderRadius: 26, borderWidth: 1, borderColor: theme.colors.border, paddingHorizontal: 8, paddingBottom: 9, shadowColor: "#0B2D6F", shadowOffset: { width: 0, height: 10 }, shadowOpacity: .15, shadowRadius: 18, elevation: 12 },
  mainItem: { flex: 1, alignItems: "center", gap: 2, paddingBottom: 2 }, mainLabel: { color: "#8FA6C4", fontSize: 10, fontWeight: "700" }, mainLabelActive: { color: theme.colors.primary, fontSize: 10, fontWeight: "900" },
  taskSlot: { width: 62, alignItems: "center", marginTop: -30 }, task: { width: 58, height: 58, borderRadius: 30, borderWidth: 5, borderColor: theme.colors.surface, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center", elevation: 10 }, taskLabel: { color: theme.colors.primary, fontSize: 10, fontWeight: "900", marginTop: 3 },
  chatBar: { height: 75, borderRadius: 37, backgroundColor: "#fff", borderWidth: 1, borderColor: "#edf0f4", shadowColor: "#244067", shadowOffset: { width: 0, height: 6 }, shadowOpacity: .12, shadowRadius: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-around", paddingHorizontal: 4 },
  chatItem: { flex: 1, alignItems: "center", justifyContent: "center", gap: 2 }, chatLabel: { color: "#9ca8b8", fontSize: 10, fontWeight: "700" }, chatActive: { color: theme.colors.primary, fontSize: 10, fontWeight: "700" },
  chatLogoWrap: { width: 67, alignItems: "center", marginTop: -21 }, chatLogo: { width: 58, height: 58, borderRadius: 30, backgroundColor: "#fff", borderWidth: 4, borderColor: "#fff", elevation: 5, alignItems: "center", justifyContent: "center", shadowColor: theme.colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: .2, shadowRadius: 8 }, chatImage: { width: 52, height: 52, borderRadius: 27 },
});
