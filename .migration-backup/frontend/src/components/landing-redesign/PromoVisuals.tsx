import React from "react";
import { Image, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";

type PromoVisualsProps = { t: (key: string) => string };

const VISUALS = [
  {
    image: require("@/assets/images/landing-market-clean.jpg"),
    key: "market",
    icon: "storefront-outline" as const,
  },
  {
    image: require("@/assets/images/landing-training-clean.jpg"),
    key: "learning",
    icon: "school-outline" as const,
  },
];

export function PromoVisuals({ t }: PromoVisualsProps) {
  const { width } = useWindowDimensions();
  const compact = width < 400;

  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      {VISUALS.map((visual) => (
        <View
          key={visual.key}
          style={styles.card}
          accessible
          accessibilityLabel={t(`landingRedesign.promo.${visual.key}`)}
          testID={`landing-redesign-promo-${visual.key}`}
        >
          <Image source={visual.image} style={styles.image} resizeMode="cover" />
          <LinearGradient
            pointerEvents="none"
            colors={["transparent", "rgba(3,28,99,0.82)"]}
            locations={[0.2, 1]}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.caption}>
            <View style={styles.captionIcon}>
              <Ionicons name={visual.icon} size={14} color="#FFE064" />
            </View>
            <Text style={styles.captionText}>{t(`landingRedesign.promo.${visual.key}`)}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    maxWidth: 650,
    width: "100%",
    alignSelf: "center",
    flexDirection: "row",
    gap: 10,
    marginTop: 1,
    paddingHorizontal: 4,
  },
  rowCompact: { gap: 7 },
  card: {
    flex: 1,
    height: 94,
    borderRadius: 15,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(216,238,255,0.55)",
    backgroundColor: "#0B47B8",
  },
  image: { width: "100%", height: "100%" },
  caption: {
    position: "absolute",
    bottom: 8,
    left: 9,
    right: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  captionIcon: {
    width: 24,
    height: 24,
    borderRadius: 8,
    backgroundColor: "rgba(2,30,111,0.82)",
    alignItems: "center",
    justifyContent: "center",
  },
  captionText: { flex: 1, color: "#FFFFFF", fontSize: 10, fontWeight: "900" },
});
