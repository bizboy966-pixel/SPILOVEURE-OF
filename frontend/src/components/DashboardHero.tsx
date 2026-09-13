import React from "react";
import { StyleSheet, Text, TouchableOpacity, View, Image } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import Svg, {
  Path, Polyline, Rect, Defs, LinearGradient as SvgLinearGradient, Stop, Circle, Ellipse, G,
} from "react-native-svg";

import { formatFCFA, formatDate } from "@/src/utils/format";

/* ============================================================
 * 3D wallet illustration — SVG replica (v14 dashboard hero)
 * ------------------------------------------------------------
 * Recreated to match the user's mockup: a golden 3D wallet
 * with a stack of blue bank notes peeking out on top and a
 * subtle glow shadow underneath. Fully vectorial, no PNG.
 * ============================================================ */
function Wallet3D({ size = 96 }: { size?: number }) {
  const W = size;
  const H = Math.round(size * 0.86);
  return (
    <Svg width={W} height={H} viewBox="0 0 120 104">
      <Defs>
        <SvgLinearGradient id="wg" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#F9D976" />
          <Stop offset="0.55" stopColor="#F1B939" />
          <Stop offset="1" stopColor="#B87717" />
        </SvgLinearGradient>
        <SvgLinearGradient id="wg2" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#FFE7A1" />
          <Stop offset="1" stopColor="#D89C22" />
        </SvgLinearGradient>
        <SvgLinearGradient id="ng" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#5DA9FF" />
          <Stop offset="1" stopColor="#1B5BFF" />
        </SvgLinearGradient>
        <SvgLinearGradient id="ng2" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#22D3EE" />
          <Stop offset="1" stopColor="#0EA5E9" />
        </SvgLinearGradient>
      </Defs>
      {/* Ground shadow */}
      <Ellipse cx="60" cy="99" rx="42" ry="4" fill="rgba(0,0,0,0.28)" />
      {/* Back wall of wallet (slightly darker) */}
      <Path d="M12 44 Q12 34 22 34 H98 Q108 34 108 44 V88 Q108 98 98 98 H22 Q12 98 12 88 Z" fill="url(#wg)" />
      {/* Notes stacked (peeking out top) */}
      <G>
        {/* Deepest note */}
        <Rect x="24" y="18" width="72" height="26" rx="4" fill="#DBEAFE" />
        <Rect x="26" y="20" width="68" height="22" rx="3" fill="url(#ng)" />
        <Circle cx="60" cy="31" r="6" fill="rgba(255,255,255,0.35)" />
        {/* Middle note */}
        <Rect x="30" y="14" width="60" height="22" rx="4" fill="#E0F2FE" />
        <Rect x="32" y="16" width="56" height="18" rx="3" fill="url(#ng2)" />
        <Circle cx="60" cy="25" r="4.5" fill="rgba(255,255,255,0.4)" />
        {/* Top note */}
        <Rect x="36" y="10" width="48" height="18" rx="4" fill="#F0F9FF" />
        <Rect x="38" y="12" width="44" height="14" rx="3" fill="url(#ng)" />
      </G>
      {/* Front pocket of wallet */}
      <Path d="M12 52 Q12 42 22 42 H98 Q108 42 108 52 V88 Q108 98 98 98 H22 Q12 98 12 88 Z" fill="url(#wg2)" />
      {/* Front horizontal seam */}
      <Path d="M12 60 H108" stroke="rgba(0,0,0,0.12)" strokeWidth="1" />
      {/* Golden button/clasp */}
      <Circle cx="60" cy="76" r="7.5" fill="#B27A11" />
      <Circle cx="60" cy="76" r="5.5" fill="url(#wg)" />
      <Circle cx="58" cy="74" r="1.6" fill="rgba(255,255,255,0.7)" />
      {/* Left highlight */}
      <Path d="M18 46 Q14 60 18 90" stroke="rgba(255,255,255,0.35)" strokeWidth="2" fill="none" />
    </Svg>
  );
}

/* ============================================================
 * Mini sparkline — accepts an array of numbers and paints a
 * smooth polyline + filled gradient area. Used inside each of
 * the 3 stat cards.
 * ============================================================ */
function MiniSparkline({
  data, color, id,
}: { data: number[]; color: string; id: string }) {
  const W = 68;
  const H = 26;
  const safe = data && data.length ? data : [0, 0, 0, 0, 0, 0, 0];
  const max = Math.max(...safe, 1);
  const min = Math.min(...safe, 0);
  const range = max - min || 1;
  const step = safe.length > 1 ? W / (safe.length - 1) : W;
  const pts = safe.map((v, i) => {
    const x = i * step;
    const y = H - ((v - min) / range) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const areaD = `M0,${H} L${pts.join(" L")} L${W},${H} Z`;
  return (
    <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <Defs>
        <SvgLinearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity="0.55" />
          <Stop offset="1" stopColor={color} stopOpacity="0" />
        </SvgLinearGradient>
      </Defs>
      <Path d={areaD} fill={`url(#spark-${id})`} />
      <Polyline
        points={pts.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/* ============================================================ */
type MiniStatProps = {
  icon: any;
  iconColor: string;
  accent: string;
  bg: string;
  border: string;
  label: string;
  value: string;
  hint: string;
  trendPct: number;
  series: number[];
  seriesId: string;
  testID?: string;
  onPress?: () => void;
};

function MiniStat({
  icon, iconColor, accent, bg, border,
  label, value, hint, trendPct, series, seriesId, testID, onPress,
}: MiniStatProps) {
  const up = trendPct >= 0;
  const Wrapper: any = onPress ? TouchableOpacity : View;
  return (
    <Wrapper
      style={[styles.miniStat, { backgroundColor: bg, borderColor: border }]}
      onPress={onPress}
      activeOpacity={0.85}
      testID={testID}
    >
      <View style={styles.miniStatHead}>
        <Ionicons name={icon} size={16} color={iconColor} />
        <View
          style={[
            styles.trendBadge,
            { backgroundColor: up ? "rgba(16,185,129,0.28)" : "rgba(239,68,68,0.28)" },
          ]}
        >
          <Ionicons name={up ? "trending-up" : "trending-down"} size={9} color={up ? "#34D399" : "#F87171"} />
          <Text style={[styles.trendBadgeTxt, { color: up ? "#D1FAE5" : "#FECACA" }]}>
            {up ? "+" : ""}{trendPct.toFixed(1)}%
          </Text>
        </View>
      </View>
      <Text style={styles.miniStatLabel}>{label}</Text>
      <Text style={styles.miniStatValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <View style={styles.sparkRow}>
        <MiniSparkline data={series} color={accent} id={seriesId} />
      </View>
      <Text style={styles.miniStatHint}>{hint}</Text>
    </Wrapper>
  );
}

/* ============================================================ */
type Props = {
  user: any;
  stats: any;
  balanceHidden: boolean;
  onToggleHidden: () => void;
  onAvatarPress: () => void;
  onBalancePress?: () => void;
};

export const DashboardHero: React.FC<Props> = ({
  user, stats, balanceHidden, onToggleHidden, onAvatarPress, onBalancePress,
}) => {
  const trend = stats?.trend || {};
  const total_profit = stats?.total_profit || 0;
  const balance_profit = stats?.balance_profit || 0;
  const level = user?.max_level ?? 0;

  return (
    <LinearGradient
      colors={["#0E1F4F", "#1B5BFF", "#0B2D6F"] as any}
      start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      style={styles.premiumCard}
      testID="dashboard-hero-card"
    >
      {/* Row : avatar + user info + eye toggle */}
      <View style={styles.premiumTopRow}>
        <TouchableOpacity
          style={styles.avatar}
          onPress={onAvatarPress}
          activeOpacity={0.85}
          testID="dashboard-avatar-btn"
        >
          {user?.profile_photo ? (
            <Image source={{ uri: user.profile_photo }} style={styles.avatarImg} resizeMode="cover" />
          ) : (
            <Ionicons name="person" size={22} color="#fff" />
          )}
          <View style={styles.avatarEditBadge}>
            <Ionicons name="pencil" size={10} color="#fff" />
          </View>
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={styles.username} numberOfLines={1}>{user?.username}</Text>
            <Ionicons name="checkmark-circle" size={15} color="#22D3EE" />
          </View>
          <View style={styles.lvlPill}>
            <Ionicons name="ribbon" size={11} color="#F59E0B" />
            <Text style={styles.lvlText}>Niveau {level}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 }}>
            <Ionicons name="calendar-outline" size={11} color="#C7D9FF" />
            <Text style={styles.memberSince}>Membre depuis : {formatDate(user?.created_at)}</Text>
          </View>
        </View>
      </View>

      {/* Wallet row: 3D SVG + inline balance + eye + XOF chip */}
      <View style={styles.walletBlock}>
        <View style={styles.walletIllustration}>
          <Wallet3D size={92} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.walletLabel}>PORTEFEUILLE</Text>
          <View style={styles.walletInline}>
            <Text
              style={styles.walletValue}
              numberOfLines={1}
              adjustsFontSizeToFit
              testID="dashboard-wallet-amount"
            >
              {balanceHidden ? "••••••" : formatFCFA(balance_profit)}
            </Text>
            <TouchableOpacity
              style={styles.eyeBtn}
              onPress={onToggleHidden}
              testID="dashboard-eye-btn"
            >
              <Ionicons name={balanceHidden ? "eye-off" : "eye"} size={16} color="#fff" />
            </TouchableOpacity>
            <View style={styles.currencyPill}>
              <Text style={styles.currencyPillTxt}>XOF</Text>
              <Ionicons name="chevron-down" size={11} color="#fff" />
            </View>
          </View>
          <Text style={styles.walletHint}>Solde disponible</Text>
        </View>
      </View>

      {/* 3 stats : Activation | Profit total | Solde disponible */}
      <View style={styles.statsGrid}>
        <MiniStat
          icon="shield-checkmark"
          iconColor="#34D399"
          accent="#34D399"
          bg="rgba(16,185,129,0.18)"
          border="rgba(16,185,129,0.45)"
          label="Activation"
          value={balanceHidden ? "•••" : "2 500 FCFA"}
          hint={level >= 1 ? `Niveau ${level} activé` : "Non activé"}
          trendPct={trend.activation_pct ?? 0}
          series={trend.activation_series || [0, 0, 0, 0, 0, 0, 0]}
          seriesId="act"
          testID="dashboard-activation-amount"
        />
        <MiniStat
          icon="stats-chart"
          iconColor="#A78BFA"
          accent="#A78BFA"
          bg="rgba(139,92,246,0.20)"
          border="rgba(139,92,246,0.45)"
          label="Profit Total"
          value={balanceHidden ? "•••" : formatFCFA(total_profit)}
          hint="Cumul historique"
          trendPct={trend.profit_pct ?? 0}
          series={trend.profit_series || [0, 0, 0, 0, 0, 0, 0]}
          seriesId="prf"
          testID="dashboard-total-profit"
        />
        <MiniStat
          icon="wallet"
          iconColor="#FBBF24"
          accent="#FBBF24"
          bg="rgba(245,158,11,0.20)"
          border="rgba(245,158,11,0.55)"
          label="Solde dispo."
          value={balanceHidden ? "•••" : formatFCFA(balance_profit)}
          hint="au retrait"
          trendPct={trend.balance_pct ?? 0}
          series={trend.balance_series || [0, 0, 0, 0, 0, 0, 0]}
          seriesId="bal"
          testID="dashboard-balance-profit"
          onPress={onBalancePress}
        />
      </View>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  premiumCard: {
    borderRadius: 26,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    shadowColor: "#0B2D6F",
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.28,
    shadowRadius: 30,
    elevation: 8,
    overflow: "hidden",
  },
  premiumTopRow: { flexDirection: "row", alignItems: "flex-start" },
  avatar: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center", justifyContent: "center",
    overflow: "hidden", position: "relative",
    borderWidth: 1.5, borderColor: "rgba(255,255,255,0.25)",
  },
  avatarImg: { width: 46, height: 46, borderRadius: 23 },
  avatarEditBadge: {
    position: "absolute", right: -2, bottom: -2, width: 18, height: 18, borderRadius: 9,
    backgroundColor: "#F59E0B",
    alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: "#0B2D6F",
  },
  username: { color: "#fff", fontSize: 15, fontWeight: "800", letterSpacing: -0.1 },
  lvlPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(245,158,11,0.25)",
    borderWidth: 1, borderColor: "rgba(245,158,11,0.5)",
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10,
    alignSelf: "flex-start", marginTop: 3,
  },
  lvlText: { color: "#FDE68A", fontWeight: "800", fontSize: 11 },
  memberSince: { color: "#C7D9FF", fontSize: 10 },

  walletBlock: {
    marginTop: 14, flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 20, padding: 12,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.14)",
  },
  walletIllustration: {
    width: 96, height: 84, alignItems: "center", justifyContent: "center",
  },
  walletLabel: {
    color: "#A5C2FF", fontSize: 10, fontWeight: "800", letterSpacing: 1.2,
  },
  walletInline: {
    flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4,
    flexWrap: "wrap",
  },
  walletValue: {
    color: "#fff", fontSize: 22, fontWeight: "900", letterSpacing: -0.5,
  },
  eyeBtn: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: "rgba(255,255,255,0.16)",
    alignItems: "center", justifyContent: "center",
  },
  currencyPill: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: "rgba(255,255,255,0.18)",
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.15)",
  },
  currencyPillTxt: { color: "#fff", fontWeight: "800", fontSize: 11 },
  walletHint: { color: "#C7D9FF", fontSize: 11, marginTop: 4, fontWeight: "500" },

  statsGrid: { flexDirection: "row", gap: 8, marginTop: 14 },
  miniStat: {
    flex: 1, borderRadius: 16, padding: 10, borderWidth: 1,
    alignItems: "flex-start",
    minHeight: 130,
  },
  miniStatHead: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    width: "100%",
  },
  trendBadge: {
    flexDirection: "row", alignItems: "center", gap: 2,
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 8,
  },
  trendBadgeTxt: { fontSize: 9, fontWeight: "800" },
  miniStatLabel: { color: "rgba(255,255,255,0.85)", fontSize: 10, fontWeight: "700", marginTop: 6, letterSpacing: 0.2 },
  miniStatValue: { color: "#fff", fontSize: 13, fontWeight: "900", marginTop: 3, letterSpacing: -0.4 },
  sparkRow: { marginTop: 6, height: 26, alignSelf: "stretch" },
  miniStatHint: { color: "rgba(255,255,255,0.7)", fontSize: 9, marginTop: 2 },
});

export default DashboardHero;
