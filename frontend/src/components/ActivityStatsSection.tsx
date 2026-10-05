import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { Card } from "./Card";
import { theme } from "../theme";
import { api } from "../api";
import { formatFCFA } from "../utils/format";

// v27ap (2026-03-04) — Activity Statistics section mounted on the user
// Dashboard, strictly below the Commissions duo cards. Reads from the
// `/api/stats/activity` + `/api/stats/activity/day` endpoints which
// aggregate ONLY real transactions (commissions, ads rewards, mission
// completions). No deposits are counted. The design mirrors the user's
// reference screenshot : 4-period selector, bar chart, 4 KPI cards and
// a collapsible day-detail panel.

type Period = "24h" | "7d" | "30d" | "1y";
type Bucket = {
  key: string;
  parrainage: number; equipe: number; ads: number; missions: number; taches: number;
  total: number;
};
type Summary = {
  total: number;
  max_day: { key: string | null; total: number };
  min_day: { key: string | null; total: number };
  average: number;
  bucket_count: number;
};
type Series = {
  period: Period;
  start: string; end: string;
  bucket_format: string;
  buckets: Bucket[];
  summary: Summary;
};
type Txn = {
  amount: number; label: string;
  from_username?: string; from_user_id?: string;
  level?: number | null; kind?: string; at?: string | null;
  ad_id?: string; mission_id?: string; platform?: string;
};
type DayDetail = {
  date: string;
  totals: { parrainage: number; equipe: number; ads: number; missions: number; taches: number };
  grand_total: number;
  transactions: {
    parrainage: Txn[]; equipe: Txn[]; ads: Txn[]; missions: Txn[]; taches: Txn[];
  };
};

const PERIOD_LABELS: { key: Period; label: string }[] = [
  { key: "24h", label: "24 heures" },
  { key: "7d",  label: "7 jours" },
  { key: "30d", label: "30 jours" },
  { key: "1y",  label: "1 an" },
];

const CATEGORY_META: {
  key: keyof DayDetail["totals"]; label: string; icon: any; color: string; bg: string;
}[] = [
  { key: "parrainage", label: "Parrainage",       icon: "person-add",      color: "#10B981", bg: "#D1FAE5" },
  { key: "equipe",     label: "Équipe / Spillover", icon: "git-network",   color: "#3B82F6", bg: "#DBEAFE" },
  { key: "ads",        label: "Publicités",       icon: "megaphone",       color: "#F59E0B", bg: "#FEF3C7" },
  { key: "missions",   label: "Missions",         icon: "trophy",          color: "#EC4899", bg: "#FCE7F3" },
  { key: "taches",     label: "Tâches",           icon: "checkbox",        color: "#8B5CF6", bg: "#F3E8FF" },
];

function formatBucketLabel(key: string, period: Period): { top: string; bottom: string } {
  // 24h → "14h / 04 Mar"
  // 7d / 30d → "Mar / 01 Oct"
  // 1y → "Mars / 2026"
  if (!key) return { top: "", bottom: "" };
  if (period === "1y") {
    const [y, m] = key.split("-");
    const names = ["Janv","Févr","Mars","Avr","Mai","Juin","Juil","Août","Sept","Oct","Nov","Déc"];
    const idx = Math.max(0, Math.min(11, (parseInt(m, 10) || 1) - 1));
    return { top: names[idx], bottom: y };
  }
  if (period === "24h") {
    // key is YYYY-MM-DDTHH:00
    const hour = parseInt((key.split("T")[1] || "0").split(":")[0], 10) || 0;
    const [yy, mm, dd] = key.split("T")[0].split("-");
    const d = new Date(Date.UTC(parseInt(yy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10)));
    return { top: `${hour}h`, bottom: `${d.getUTCDate().toString().padStart(2, "0")}/${(d.getUTCMonth() + 1).toString().padStart(2, "0")}` };
  }
  // daily (7d / 30d)
  const [y, m, d] = key.split("-");
  const date = new Date(Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10)));
  const dayNames = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
  const monNames = ["Janv","Févr","Mars","Avr","Mai","Juin","Juil","Août","Sept","Oct","Nov","Déc"];
  const dayLabel = dayNames[date.getUTCDay()];
  const dayNum = parseInt(d, 10);
  const monLabel = monNames[parseInt(m, 10) - 1];
  return { top: dayLabel, bottom: `${dayNum.toString().padStart(2, "0")} ${monLabel}` };
}

function formatBucketTitle(key: string, period: Period): string {
  const { top, bottom } = formatBucketLabel(key, period);
  if (!top && !bottom) return "";
  if (period === "1y") return `${top} ${bottom}`;
  if (period === "24h") return `${top} — ${bottom}`;
  return `${top} ${bottom}`;
}

// A compact FCFA label used inside the chart (K/M suffix for narrow bars).
function compact(amount: number): string {
  if (!Number.isFinite(amount)) return "0";
  if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1).replace(".0", "") + "M";
  if (amount >= 1_000) return (amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1).replace(".0", "") + "K";
  return Math.round(amount).toString();
}

export function ActivityStatsSection() {
  const [period, setPeriod] = useState<Period>("7d");
  const [series, setSeries] = useState<Series | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [day, setDay] = useState<DayDetail | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [openCat, setOpenCat] = useState<string | null>("parrainage");

  const fetchSeries = useCallback(async (p: Period) => {
    setLoading(true); setError(null);
    try {
      const r = await api.get<Series>(`/stats/activity?period=${p}`);
      setSeries(r);
      // Auto-select the latest bucket with a total > 0, else the last one.
      const nonZero = [...(r.buckets || [])].reverse().find((b) => b.total > 0);
      const next = nonZero?.key || r.buckets?.[r.buckets.length - 1]?.key || null;
      setSelectedKey(next);
    } catch (err: any) {
      setError(String(err?.message || err || "Erreur de chargement"));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDay = useCallback(async (key: string) => {
    setDayLoading(true);
    try {
      const r = await api.get<DayDetail>(`/stats/activity/day?date=${encodeURIComponent(key)}`);
      setDay(r);
    } catch {
      setDay(null);
    } finally {
      setDayLoading(false);
    }
  }, []);

  useEffect(() => { fetchSeries(period); }, [period, fetchSeries]);
  useEffect(() => { if (selectedKey) fetchDay(selectedKey); }, [selectedKey, fetchDay]);

  const maxTotal = useMemo(() => {
    if (!series) return 0;
    return series.buckets.reduce((m, b) => Math.max(m, b.total), 0);
  }, [series]);

  const barCount = series?.buckets.length || 0;
  // For 30d/1y we horizontally scroll — bars 36px wide, else fit 7 bars.
  const chartIsScrollable = period === "30d" || period === "1y" || barCount > 10;
  const barWidth = chartIsScrollable ? 36 : undefined;

  return (
    <Card style={styles.card} testID="activity-stats-section">
      {/* ── Header ── */}
      <View style={styles.head}>
        <View style={styles.headLeft}>
          <View style={styles.headIcon}>
            <Ionicons name="bar-chart" size={18} color={theme.colors.primary} />
          </View>
          <View>
            <Text style={styles.headKicker}>ACTIVITÉ</Text>
            <Text style={styles.headTitle}>Statistiques</Text>
            <Text style={styles.headSub}>Vos gains et activités sur la plateforme</Text>
          </View>
        </View>
      </View>

      {/* ── Period selector ── */}
      <View style={styles.periodRow} testID="activity-period-selector">
        {PERIOD_LABELS.map((p) => {
          const active = p.key === period;
          return (
            <TouchableOpacity
              key={p.key}
              onPress={() => setPeriod(p.key)}
              style={[styles.periodBtn, active && styles.periodBtnActive]}
              testID={`activity-period-${p.key}`}
              activeOpacity={0.85}
            >
              <Text style={[styles.periodTxt, active && styles.periodTxtActive]}>{p.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Chart ── */}
      {loading && !series ? (
        <View style={styles.chartLoader}><ActivityIndicator color={theme.colors.primary} /></View>
      ) : error ? (
        <Text style={styles.errTxt} testID="activity-error">⚠️ {error}</Text>
      ) : series ? (
        <View style={styles.chartWrap} testID="activity-chart">
          <ScrollView
            horizontal={chartIsScrollable}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ flexGrow: 1 }}
          >
            <View style={[styles.chartInner, !chartIsScrollable && { flex: 1 }]}>
              {series.buckets.map((b) => {
                const h = maxTotal > 0 ? Math.max(2, (b.total / maxTotal) * 140) : 2;
                const active = b.key === selectedKey;
                const { top, bottom } = formatBucketLabel(b.key, period);
                const label = compact(b.total);
                return (
                  <TouchableOpacity
                    key={b.key}
                    onPress={() => setSelectedKey(b.key)}
                    style={[styles.barCol, barWidth ? { width: barWidth } : { flex: 1 }]}
                    activeOpacity={0.85}
                    testID={`activity-bar-${b.key}`}
                  >
                    <Text
                      style={[styles.barValue, active && { color: theme.colors.primary }]}
                      numberOfLines={1}
                    >
                      {b.total > 0 ? label : "0"}
                    </Text>
                    <View style={styles.barTrack}>
                      <View
                        style={[
                          styles.barFill,
                          { height: h, backgroundColor: active ? theme.colors.primary : "#93C5FD" },
                        ]}
                      />
                    </View>
                    <Text style={[styles.barLblTop, active && { color: theme.colors.primary, fontWeight: "900" }]}>{top}</Text>
                    <Text style={styles.barLblBot}>{bottom}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
        </View>
      ) : null}

      {/* ── Summary KPIs ── */}
      {series ? (
        <View style={styles.kpiGrid} testID="activity-kpi-grid">
          <KpiCard
            icon="trending-up" color="#1B5BFF" bg="#DBEAFE"
            label="Total sur la période"
            value={formatFCFA(series.summary.total)}
            testID="kpi-total"
          />
          <KpiCard
            icon="arrow-up" color="#10B981" bg="#D1FAE5"
            label="Jour le plus élevé"
            value={formatFCFA(series.summary.max_day.total)}
            sub={series.summary.max_day.key ? formatBucketTitle(series.summary.max_day.key, period) : "—"}
            testID="kpi-max"
          />
          <KpiCard
            icon="arrow-down" color="#EF4444" bg="#FEE2E2"
            label="Jour le plus bas"
            value={formatFCFA(series.summary.min_day.total)}
            sub={series.summary.min_day.key ? formatBucketTitle(series.summary.min_day.key, period) : "—"}
            testID="kpi-min"
          />
          <KpiCard
            icon="stats-chart" color="#8B5CF6" bg="#F3E8FF"
            label={period === "1y" ? "Moyenne / mois" : period === "24h" ? "Moyenne / heure" : "Moyenne / jour"}
            value={formatFCFA(series.summary.average)}
            testID="kpi-avg"
          />
        </View>
      ) : null}

      {/* ── Day detail ── */}
      {selectedKey ? (
        <View style={styles.detailWrap} testID="activity-day-detail">
          <View style={styles.detailHead}>
            <View>
              <Text style={styles.detailKicker}>DÉTAIL DES GAINS DU JOUR SÉLECTIONNÉ</Text>
              <Text style={styles.detailTitle}>{formatBucketTitle(selectedKey, period)}</Text>
            </View>
            <View style={styles.detailTotalBadge} testID="activity-day-total">
              <Text style={styles.detailTotalLbl}>Total</Text>
              <Text style={styles.detailTotalVal}>{formatFCFA(day?.grand_total || 0)}</Text>
            </View>
          </View>

          {dayLoading ? (
            <View style={styles.chartLoader}><ActivityIndicator color={theme.colors.primary} /></View>
          ) : day && day.grand_total === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="information-circle" size={18} color={theme.colors.textSecondary} />
              <Text style={styles.emptyTxt}>Aucun gain pour cette période.</Text>
            </View>
          ) : day ? (
            <View style={{ gap: 8 }}>
              {CATEGORY_META.map((c) => {
                const t = day.totals[c.key];
                const txs = day.transactions[c.key];
                if (!t || t <= 0) return null;
                const open = openCat === c.key;
                return (
                  <View key={c.key} style={styles.catCard} testID={`activity-cat-${c.key}`}>
                    <TouchableOpacity
                      style={styles.catHead}
                      onPress={() => setOpenCat(open ? null : c.key)}
                      activeOpacity={0.85}
                      testID={`activity-cat-${c.key}-toggle`}
                    >
                      <View style={[styles.catIcon, { backgroundColor: c.bg }]}>
                        <Ionicons name={c.icon} size={16} color={c.color} />
                      </View>
                      <Text style={styles.catLbl}>{c.label}</Text>
                      <Text style={styles.catVal}>{formatFCFA(t)}</Text>
                      <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={theme.colors.textSecondary} />
                    </TouchableOpacity>
                    {open ? (
                      <View style={styles.catBody}>
                        {txs.length === 0 ? (
                          <Text style={styles.emptyTxt}>Aucune transaction.</Text>
                        ) : txs.map((t, i) => (
                          <TxnRow key={i} txn={t} color={c.color} />
                        ))}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function TxnRow({ txn, color }: { txn: Txn; color: string }) {
  const hint =
    txn.from_username ? `@${txn.from_username}` :
    txn.platform ? txn.platform :
    txn.level ? `Niveau ${txn.level}` : "";
  const time = txn.at ? new Date(txn.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <View style={styles.txnRow}>
      <View style={styles.txnIcon}>
        <View style={[styles.txnDot, { backgroundColor: color }]} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.txnLabel} numberOfLines={1}>{txn.label}</Text>
        {hint ? <Text style={styles.txnHint}>{hint}</Text> : null}
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={styles.txnAmt}>{formatFCFA(txn.amount)}</Text>
        {time ? <Text style={styles.txnTime}>{time}</Text> : null}
      </View>
    </View>
  );
}

function KpiCard({
  icon, color, bg, label, value, sub, testID,
}: {
  icon: any; color: string; bg: string; label: string; value: string; sub?: string; testID?: string;
}) {
  return (
    <View style={styles.kpiCard} testID={testID}>
      <View style={[styles.kpiIcon, { backgroundColor: bg }]}>
        <Ionicons name={icon} size={14} color={color} />
      </View>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.kpiValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      {sub ? <Text style={styles.kpiSub} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 14 },
  head: { flexDirection: "row", alignItems: "flex-start", marginBottom: 12 },
  headLeft: { flexDirection: "row", gap: 10, flex: 1 },
  headIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#DBEAFE",
    alignItems: "center", justifyContent: "center",
  },
  headKicker: { color: theme.colors.textSecondary, fontSize: 10, letterSpacing: 1.5, fontWeight: "800" },
  headTitle: { color: theme.colors.textPrimary, fontSize: 18, fontWeight: "900", letterSpacing: -0.3 },
  headSub: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },

  periodRow: {
    flexDirection: "row",
    backgroundColor: theme.colors.surfaceSecondary,
    borderRadius: 12,
    padding: 4,
    marginBottom: 14,
  },
  periodBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 10,
    alignItems: "center",
  },
  periodBtnActive: { backgroundColor: theme.colors.primary },
  periodTxt: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: "700" },
  periodTxtActive: { color: "#fff", fontWeight: "900" },

  chartWrap: { marginBottom: 14 },
  chartInner: {
    flexDirection: "row",
    alignItems: "flex-end",
    minHeight: 190,
    paddingHorizontal: 2,
    gap: 4,
  },
  chartLoader: { paddingVertical: 32, alignItems: "center" },
  barCol: { alignItems: "center", gap: 4 },
  barValue: { fontSize: 10, color: theme.colors.textPrimary, fontWeight: "800" },
  barTrack: { height: 140, width: 20, backgroundColor: "transparent", justifyContent: "flex-end", borderRadius: 6 },
  barFill: { width: 20, borderRadius: 6 },
  barLblTop: { fontSize: 10, color: theme.colors.textSecondary, marginTop: 4, fontWeight: "700" },
  barLblBot: { fontSize: 9, color: theme.colors.textSecondary },

  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  kpiCard: {
    flexGrow: 1, flexBasis: "47%",
    backgroundColor: theme.colors.surfaceSecondary,
    borderRadius: 12,
    padding: 10,
    gap: 4,
  },
  kpiIcon: { width: 24, height: 24, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  kpiLabel: { fontSize: 10, color: theme.colors.textSecondary, fontWeight: "700" },
  kpiValue: { fontSize: 15, color: theme.colors.textPrimary, fontWeight: "900" },
  kpiSub: { fontSize: 10, color: theme.colors.textSecondary },

  detailWrap: { marginTop: 4 },
  detailHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  detailKicker: { color: theme.colors.textSecondary, fontSize: 9, letterSpacing: 1.2, fontWeight: "800" },
  detailTitle: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: "800", marginTop: 2 },
  detailTotalBadge: {
    backgroundColor: "#FEF3C7",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: "flex-end",
  },
  detailTotalLbl: { color: "#92400E", fontSize: 9, fontWeight: "700" },
  detailTotalVal: { color: "#92400E", fontSize: 13, fontWeight: "900" },

  catCard: {
    backgroundColor: theme.colors.surfaceSecondary,
    borderRadius: 12,
    overflow: "hidden",
  },
  catHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  catIcon: { width: 28, height: 28, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  catLbl: { flex: 1, color: theme.colors.textPrimary, fontWeight: "800", fontSize: 12 },
  catVal: { color: theme.colors.textPrimary, fontWeight: "900", fontSize: 12, marginRight: 6 },
  catBody: { paddingHorizontal: 10, paddingBottom: 10, gap: 6 },

  txnRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    padding: 8,
  },
  txnIcon: { width: 20, alignItems: "center" },
  txnDot: { width: 8, height: 8, borderRadius: 4 },
  txnLabel: { fontSize: 12, color: theme.colors.textPrimary, fontWeight: "700" },
  txnHint: { fontSize: 10, color: theme.colors.textSecondary, marginTop: 1 },
  txnAmt: { fontSize: 12, color: "#059669", fontWeight: "800" },
  txnTime: { fontSize: 10, color: theme.colors.textSecondary, marginTop: 1 },

  emptyBox: { flexDirection: "row", gap: 8, alignItems: "center", padding: 12 },
  emptyTxt: { color: theme.colors.textSecondary, fontSize: 12 },
  errTxt: { color: theme.colors.error, fontSize: 12, textAlign: "center", padding: 12 },
});
