import React, { useEffect, useRef } from "react";
import { Animated, View, StyleSheet, Easing } from "react-native";
import Svg, { Circle, G } from "react-native-svg";

// v27ao (2026-03-04) — UnreadRing : composant réutilisable style « statuts
// WhatsApp ». Dessine un anneau SVG segmenté autour d'un enfant. Chaque
// segment reflète un nouveau contenu non consulté (vert) ou déjà consulté
// (gris clair). Au-delà du seuil `maxSegments` (9 par défaut), on bascule
// sur un anneau continu « vert plein » (variante compacte « 9+ »).
//
// Props :
//   • segments : tableau d'objets {seen: boolean}. Longueur ≤ maxSegments
//     pour un rendu segmenté. Peut dépasser maxSegments : la variante
//     compacte s'active automatiquement.
//   • size, thickness, gapAngle : géométrie.
//   • colorUnread / colorSeen : couleurs des segments.
//   • colorIdle : couleur de l'anneau quand il n'y a aucun segment du tout.
//   • children : contenu rendu au centre (icône de la carte).
//   • animated : si true, légère animation d'apparition quand les segments
//     changent — par défaut true.

export type RingSegment = { seen: boolean };

export type UnreadRingProps = {
  segments: RingSegment[];
  size?: number;
  thickness?: number;
  gapAngle?: number;
  colorUnread?: string;
  colorSeen?: string;
  colorIdle?: string;
  maxSegments?: number;
  animated?: boolean;
  children?: React.ReactNode;
  testID?: string;
};

const DEFAULT_SIZE = 60;
const DEFAULT_THICKNESS = 3;
const DEFAULT_GAP = 6; // degrés entre segments
const DEFAULT_MAX = 9;

export function UnreadRing({
  segments,
  size = DEFAULT_SIZE,
  thickness = DEFAULT_THICKNESS,
  gapAngle = DEFAULT_GAP,
  colorUnread = "#22C55E",
  colorSeen = "#D1D5DB",
  colorIdle = "#E5E7EB",
  maxSegments = DEFAULT_MAX,
  animated = true,
  children,
  testID,
}: UnreadRingProps) {
  const count = segments.length;
  const unreadCount = segments.filter((s) => !s.seen).length;
  const compact = count > maxSegments;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.96)).current;

  useEffect(() => {
    if (!animated) {
      opacityAnim.setValue(1);
      scaleAnim.setValue(1);
      return;
    }
    opacityAnim.setValue(0);
    scaleAnim.setValue(0.96);
    Animated.parallel([
      Animated.timing(opacityAnim, {
        toValue: 1, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1, friction: 7, tension: 80, useNativeDriver: true,
      }),
    ]).start();
    // Re-run when the unread count flips to zero so the ring softly fades
    // to gray.
  }, [count, unreadCount, animated, opacityAnim, scaleAnim]);

  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;

  // --- Compact variant (nombre > maxSegments) ---------------------------
  if (compact) {
    return (
      <Animated.View
        style={[
          styles.wrap,
          { width: size, height: size, opacity: opacityAnim, transform: [{ scale: scaleAnim }] },
        ]}
        testID={testID}
      >
        <Svg width={size} height={size}>
          {/* Base cercle gris */}
          <Circle
            cx={cx} cy={cy} r={r}
            stroke={colorSeen}
            strokeWidth={thickness}
            fill="none"
          />
          {/* Anneau vert complet (indicateur « beaucoup de nouveautés ») */}
          <Circle
            cx={cx} cy={cy} r={r}
            stroke={unreadCount > 0 ? colorUnread : colorSeen}
            strokeWidth={thickness}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${circumference * 0.78} ${circumference * 0.22}`}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        </Svg>
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <View style={styles.center}>{children}</View>
        </View>
      </Animated.View>
    );
  }

  // --- Idle (aucun segment du tout) → anneau gris discret ---------------
  if (count === 0) {
    return (
      <Animated.View
        style={[
          styles.wrap,
          { width: size, height: size, opacity: opacityAnim, transform: [{ scale: scaleAnim }] },
        ]}
        testID={testID}
      >
        <Svg width={size} height={size}>
          <Circle
            cx={cx} cy={cy} r={r}
            stroke={colorIdle}
            strokeWidth={thickness}
            fill="none"
          />
        </Svg>
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <View style={styles.center}>{children}</View>
        </View>
      </Animated.View>
    );
  }

  // --- Variante segmentée (1..maxSegments) ------------------------------
  //
  // On calcule la part angulaire de chaque segment : (360 - gaps) / count.
  // Chaque segment est tracé via `strokeDasharray` sur le même cercle, en
  // décalant `strokeDashoffset` segment par segment. L'astuce standard
  // SVG pour obtenir un anneau segmenté sans arcs multiples.
  //
  // Pour 1 seul segment : gap=0 → anneau complet.
  const effectiveGap = count === 1 ? 0 : gapAngle;
  const segmentArc = 360 / count - effectiveGap;
  const segmentArcRad = (segmentArc * Math.PI) / 180;
  const segmentLen = r * segmentArcRad;
  const gapLen = circumference / count - segmentLen;

  return (
    <Animated.View
      style={[
        styles.wrap,
        { width: size, height: size, opacity: opacityAnim, transform: [{ scale: scaleAnim }] },
      ]}
      testID={testID}
    >
      <Svg width={size} height={size}>
        {/* Base — anneau de fond très clair pour la structure visuelle. */}
        <Circle
          cx={cx} cy={cy} r={r}
          stroke={colorIdle}
          strokeWidth={thickness}
          fill="none"
          opacity={0.35}
        />
        <G rotation={-90} origin={`${cx}, ${cy}`}>
          {segments.map((seg, i) => {
            const dashOffset = -i * (segmentLen + gapLen);
            const color = seg.seen ? colorSeen : colorUnread;
            return (
              <Circle
                key={i}
                cx={cx} cy={cy} r={r}
                stroke={color}
                strokeWidth={thickness}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={`${segmentLen} ${circumference - segmentLen}`}
                strokeDashoffset={dashOffset}
              />
            );
          })}
        </G>
      </Svg>
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <View style={styles.center}>{children}</View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
