import React from "react";
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from "react-native-svg";

const motifs = [
  [28, 150, 1.0, "flower"], [97, 188, 0.72, "spark"], [194, 148, 1.15, "snow"],
  [315, 174, 0.92, "flower"], [54, 265, 0.72, "snow"], [147, 256, 0.92, "flower"],
  [260, 263, 0.72, "spark"], [355, 286, 0.94, "snow"], [24, 365, 0.92, "flower"],
  [108, 354, 0.86, "snow"], [216, 370, 1.02, "flower"], [315, 385, 0.78, "spark"],
  [62, 456, 0.78, "spark"], [165, 454, 1.1, "snow"], [277, 460, 0.88, "flower"],
  [365, 480, 0.86, "flower"], [20, 556, 0.78, "snow"], [110, 550, 1.05, "flower"],
  [229, 563, 0.76, "spark"], [332, 565, 1.0, "snow"], [54, 654, 1.12, "flower"],
  [175, 656, 0.78, "snow"], [280, 654, 1.0, "flower"], [370, 674, 0.7, "spark"],
  [24, 764, 0.72, "spark"], [128, 755, 0.98, "flower"], [235, 762, 0.92, "snow"],
  [342, 770, 1.08, "flower"], [76, 842, 0.9, "snow"], [196, 846, 0.76, "spark"],
] as const;

function Doodle({ x, y, scale, kind }: { x: number; y: number; scale: number; kind: string }) {
  return (
    <G transform={`translate(${x} ${y}) scale(${scale})`} fill="none" stroke="#6d98ad" strokeWidth={1.35} opacity={0.17}>
      {kind === "flower" ? (
        <>
          {[0, 60, 120, 180, 240, 300].map(angle => (
            <Path key={angle} d="M0 -3 C-8 -11 -7 -19 0 -23 C7 -19 8 -11 0 -3Z" transform={`rotate(${angle})`} />
          ))}
          <Circle r={4} />
          <Path d="M8 9 C15 7 19 10 21 16 M-10 8 C-18 5 -21 9 -21 14" />
        </>
      ) : kind === "snow" ? (
        <>
          <Path d="M0 -24 V24 M-21 -12 L21 12 M21 -12 L-21 12 M0 -24 L-5 -17 M0 -24 L5 -17 M0 24 L-5 17 M0 24 L5 17 M-21 -12 L-12 -12 M-21 -12 L-18 -4 M21 12 L12 12 M21 12 L18 4 M21 -12 L12 -12 M21 -12 L18 -4 M-21 12 L-12 12 M-21 12 L-18 4" />
          <Circle r={4} />
        </>
      ) : (
        <>
          <Path d="M0 -22 L4 -5 L19 -13 L8 0 L23 5 L6 8 L13 22 L0 12 L-13 22 L-6 8 L-23 5 L-8 0 L-19 -13 L-4 -5Z" />
          <Circle r={3} />
        </>
      )}
      <Ellipse cx={25} cy={-22} rx={4} ry={7} transform="rotate(35 25 -22)" />
      <Circle cx={-24} cy={22} r={2} />
    </G>
  );
}

export default function ChatWallpaper() {
  return (
    <Svg
      pointerEvents="none"
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
      viewBox="0 0 390 844"
      preserveAspectRatio="xMidYMid slice"
      testID="messenger-chat-wallpaper"
    >
      <Defs>
        <LinearGradient id="spv-chat-wallpaper-gradient" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#c8f1e7" />
          <Stop offset="0.48" stopColor="#c4e9e9" />
          <Stop offset="1" stopColor="#aebbe7" />
        </LinearGradient>
      </Defs>
      <Rect width="390" height="844" fill="url(#spv-chat-wallpaper-gradient)" />
      {motifs.map(([x, y, scale, kind], index) => (
        <Doodle key={`${kind}-${index}`} x={x} y={y} scale={scale} kind={kind} />
      ))}
    </Svg>
  );
}
