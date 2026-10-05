import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, TouchableOpacity, ActivityIndicator, StyleSheet,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";

import { Card } from "./Card";
import { theme } from "../theme";
import { api } from "../api";
import { formatFCFA } from "../utils/format";

// v27ap (2026-03-04) — Activity Statistics designed pixel-perfect to the
// user's reference screenshot : header with "ACTIVITÉ / Statistiques",
// period pill, 4 period tabs, gradient bars with value labels + Y-axis
// grid, dark tooltip on selected bar, 4 KPI cards with colored values,
// day detail with expandable categories and transaction rows, and a
// RÉSUMÉ FINANCIER row at the bottom (Total reçu / Total envoyé / Solde
// disponible). Data is REAL only — no fake numbers.

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
  { key: "parrainage", label: "Parrainage - Commission directe", icon: "person-add",  color: "#10B981", bg: "#D1FAE5" },
  { key: "equipe",     label: "Équipe / Spillover",              icon: "git-network", color: "#3B82F6", bg: "#DBEAFE" },
  { key: "ads",        label: "Publicités",                      icon: "megaphone",   color: "#F59E0B", bg: "#FEF3C7" },
  { key: "missions",   label: "Missions",                        icon: "trophy",      color: "#EC4899", bg: "#FCE7F3" },
  { key: "taches",     label: "Tâches",                          icon: "checkbox",    color: "#8B5CF6", bg: "#F3E8FF" },
];

const FR_DAYS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
const FR_DAYS_FULL = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
const FR_MONTHS = ["Janv", "Févr", "Mars", "Avr", "Mai", "Juin", "Juil", "Août", "Sept", "Oct", "Nov", "Déc"];
const FR_MONTHS_FULL = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
                        "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

function parseBucketKey(key: string, period: Period): Date | null {
  if (!key) return null;
  if (period === "1y") {
    const [y, m] = key.split("-").map((x) => parseInt(x, 10));
    return new Date(Date.UTC(y, (m || 1) - 1, 1));
  }
  if (period === "24h") {
    const [datePart, hourPart] = key.split("T");
    const [y, m, d] = datePart.split("-").map((x) => parseInt(x, 10));
    const h = parseInt((hourPart || "0").split(":")[0], 10);
    return new Date(Date.UTC(y, m - 1, d, h));
  }
  const [y, m, d] = key.split("-").map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

function formatBarLabel(key: string, period: Period): { top: string; bottom: string } {
  const d = parseBucketKey(key, period);
  if (!d) return { top: "", bottom: "" };
  if (period === "1y") return { top: FR_MONTHS[d.getUTCMonth()], bottom: String(d.getUTCFullYear()) };
  if (period === "24h") return { top: `${d.getUTCHours()}h`, bottom: `${d.getUTCDate().toString().padStart(2, "0")} ${FR_MONTHS[d.getUTCMonth()]}` };
  return {
    top: FR_DAYS[d.getUTCDay()],
    bottom: `${d.getUTCDate().toString().padStart(2, "0")} ${FR_MONTHS[d.getUTCMonth()]}`,
  };
}

function formatDayTitle(key: string, period: Period): string {
  const d = parseBucketKey(key, period);
  if (!d) return "";
  if (period === "1y") return `${FR_MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (period === "24h") return `${d.getUTCHours()}h — ${d.getUTCDate().toString().padStart(2, "0")} ${FR_MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${FR_DAYS_FULL[d.getUTCDay()]} ${d.getUTCDate().toString().padStart(2, "0")} ${FR_MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatBarValue(amount: number): string {
  if (!amount || amount <= 0) return "0";
  if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1).replace(".0", "") + " M";
  if (amount >= 1_000) return (amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1).replace(".0", "") + " K";
  return Math.round(amount).toString();
}

// Compute a "nice" Y-axis top so the gridline labels are rounded numbers
// (0, 2k, 4k, 6k, 8k, 10k rather than 0, 2.3k, 4.6k, 6.9k…).
function niceYAxisTop(maxValue: number): number {
  if (maxValue <= 0) return 10_000;
  const pow = Math.pow(10, Math.floor(Math.log10(maxValue)));
  const n = maxValue / pow;
  let round;
  if (n <= 1) round = 1;
  else if (n <= 2) round = 2;
  else if (n <= 5) round = 5;
  else round = 10;
  return round * pow;
}

type Props = {
  stats?: {
    total_profit?: number; total_withdrawn?: number;
    balance_profit?: number;
  } | null;
};

export function ActivityStatsSection({ stats }: Props = {}) {
  const [period, setPeriod] = useState<Period>("7d");
  const [series, setSeries] = useState<Series | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [day, setDay] = useState<DayDetail | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [openCat, setOpenCat] = useState<string | null>("parrainage");
  const [showTooltip, setShowTooltip] = useState(true);

  const fetchSeries = useCallback(async (p: Period) => {
    setLoading(true); setError(null);
    try {
      const r = await api.get<Series>(`/stats/activity?period=${p}`);
      setSeries(r);
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
    } catch { setDay(null); }
    finally { setDayLoading(false); }
  }, []);

  useEffect(() => { fetchSeries(period); }, [period, fetchSeries]);
  useEffect(() => { if (selectedKey) fetchDay(selectedKey); }, [selectedKey, fetchDay]);

  const maxTotal = useMemo(() => {
    if (!series) return 0;
    return series.buckets.reduce((m, b) => Math.max(m, b.total), 0);
  }, [series]);

  const yAxisTop = useMemo(() => niceYAxisTop(maxTotal || 10_000), [maxTotal]);
  const yAxisSteps = useMemo(() => {
    // 6 lignes : 0 / 20% / 40% / 60% / 80% / 100%
    const steps = 5;
    return Array.from({ length: steps + 1 }, (_, i) => (yAxisTop * (steps - i)) / steps);
  }, [yAxisTop]);

  const barCount = series?.buckets.length || 0;
  const chartIsScrollable = period === "30d" || period === "1y" || barCount > 10;
  const barWidth = chartIsScrollable ? 46 : undefined;
  const CHART_HEIGHT = 180;

  const tooltipBucket = useMemo(() => {
    if (!series || !selectedKey) return null;
    return series.buckets.find((b) => b.key === selectedKey) || null;
  }, [series, selectedKey]);

  const onBarClick = useCallback((key: string) => {
    setSelectedKey(key);
    setShowTooltip(true);
  }, []);

  return (
    <Card style={styles.card} testID="activity-stats-section">
      {/* ── Header + period pill ── */}
      <View style={styles.head}>
        <View style={styles.headLeft}>
          <View style={styles.headIcon}>
            <Ionicons name="bar-chart" size={20} color={theme.colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.headKicker}>ACTIVITÉ</Text>
            <Text style={styles.headTitle}>Statistiques</Text>
            <Text style={styles.headSub}>Vos gains et activités sur la plateforme</Text>
          </View>
        </View>
        <View style={styles.pill} testID="activity-period-pill">
          <Ionicons name="calendar" size={13} color={theme.colors.textPrimary} />
          <Text style={styles.pillTxt}>{PERIOD_LABELS.find((p) => p.key === period)?.label}</Text>
          <Ionicons name="chevron-down" size={12} color={theme.colors.textPrimary} />
        </View>
      </View>

      {/* ── Period tabs ── */}
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

      {/* ── Chart with Y-axis grid ── */}
      {loading && !series ? (
        <View style={styles.chartLoader}><ActivityIndicator color={theme.colors.primary} /></View>
      ) : error ? (
        <Text style={styles.errTxt} testID="activity-error">⚠️ {error}</Text>
      ) : series ? (
        <View style={styles.chartOuter} testID="activity-chart">
          {/* Y-axis labels column (fixed, left) */}
          <View style={[styles.yAxisCol, { height: CHART_HEIGHT + 44 }]}>
            {yAxisSteps.map((v, i) => (
              <Text key={i} style={styles.yLabel}>{formatBarValue(v)}</Text>
            ))}
          </View>
          <View style={{ flex: 1 }}>
            <ScrollView
              horizontal={chartIsScrollable}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ flexGrow: 1 }}
            >
              <View style={[styles.chartInner, { height: CHART_HEIGHT + 44 }, !chartIsScrollable && { flex: 1 }]}>
                {/* Gridlines absolute */}
                <View style={styles.gridLayer} pointerEvents="none">
                  {yAxisSteps.map((_, i) => (
                    <View key={i} style={[styles.gridLine, { top: (CHART_HEIGHT / (yAxisSteps.length - 1)) * i }]} />
                  ))}
                </View>
                {/* Bars row */}
                <View style={styles.barsRow}>
                  {series.buckets.map((b) => {
                    const h = yAxisTop > 0 ? Math.max(2, (b.total / yAxisTop) * CHART_HEIGHT) : 2;
                    const active = b.key === selectedKey;
                    const { top, bottom } = formatBarLabel(b.key, period);
                    const barColorStart = active ? "#1E40AF" : "#60A5FA";
                    const barColorEnd = active ? "#1D4ED8" : "#3B82F6";
                    return (
                      <TouchableOpacity
                        key={b.key}
                        onPress={() => onBarClick(b.key)}
                        style={[styles.barCol, barWidth ? { width: barWidth } : { flex: 1 }]}
                        activeOpacity={0.85}
                        testID={`activity-bar-${b.key}`}
                      >
                        <View style={styles.barValueWrap}>
                          <Text
                            style={[styles.barValue, active && { color: "#1E40AF" }]}
                            numberOfLines={1}
                          >
                            {b.total > 0 ? formatBarValue(b.total) : "0"}
                          </Text>
                          {b.total > 0 ? <Text style={styles.barValueSub}>FCFA</Text> : null}
                        </View>
                        <View style={[styles.barTrack, { height: CHART_HEIGHT }]}>
                          <LinearGradient
                            colors={[barColorStart, barColorEnd] as any}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 0, y: 1 }}
                            style={{ width: 24, height: h, borderTopLeftRadius: 6, borderTopRightRadius: 6 }}
                          />
                          {active ? <View style={styles.barDot} /> : null}
                        </View>
                        <Text
                          style={[styles.barLblTop, active && { color: "#1E40AF", fontWeight: "900" }]}
                        >
                          {top}
                        </Text>
                        <Text style={styles.barLblBot}>{bottom}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </ScrollView>
          </View>
        </View>
      ) : null}

      {/* ── Dark inline tooltip (v27ar) — mimics the reference popup
          showing day total + per-category breakdown + top transactions.
          Appears right under the chart as a floating dark card. ── */}
      {showTooltip && tooltipBucket ? (
        <View style={styles.tooltipInline} testID="activity-tooltip">
          <View style={styles.tooltipHead}>
            <View style={{ flex: 1 }}>
              <Text style={styles.tooltipDate}>{formatDayTitle(tooltipBucket.key, period)}</Text>
              <View style={styles.tooltipTotalRow}>
                <Text style={styles.tooltipTotalLbl}>Total reçu :</Text>
                <Text style={styles.tooltipTotalVal}>{formatFCFA(tooltipBucket.total)}</Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={() => setShowTooltip(false)}
              style={styles.tooltipCloseBtn}
              testID="tooltip-close"
            >
              <Ionicons name="close" size={16} color="#CBD5E1" />
            </TouchableOpacity>
          </View>
          {dayLoading ? (
            <ActivityIndicator color="#60A5FA" style={{ marginVertical: 10 }} />
          ) : day && day.grand_total === 0 ? (
            <Text style={styles.tooltipEmpty}>Aucun gain pour cette journée.</Text>
          ) : day ? (
            <View style={{ gap: 10 }}>
              {CATEGORY_META.map((c) => {
                const t = day.totals[c.key];
                if (!t || t <= 0) return null;
                const txs = day.transactions[c.key];
                return (
                  <View key={c.key}>
                    <View style={styles.tooltipCatHead}>
                      <View style={[styles.tooltipCatIcon, { backgroundColor: c.color }]}>
                        <Ionicons name={c.icon} size={13} color="#fff" />
                      </View>
                      <Text style={styles.tooltipCatLbl}>{c.label.split(" - ")[0]}</Text>
                      <Text style={styles.tooltipCatVal}>{formatFCFA(t)}</Text>
                    </View>
                    {txs.slice(0, 4).map((tx, i) => {
                      const name = tx.from_username || tx.platform || tx.label;
                      const sub =
                        c.key === "parrainage" ? "Commission directe" :
                        c.key === "equipe" ? (tx.level ? `Commission niveau ${tx.level}` : "Commission équipe") :
                        c.key === "ads" ? "Gain publicité" :
                        c.key === "missions" ? "Mission validée" :
                        "Récompense";
                      return (
                        <View key={i} style={styles.tooltipTxn}>
                          <View style={styles.tooltipTxnDot} />
                          <Text style={styles.tooltipTxnLbl} numberOfLines={1}>
                            {sub} — {name}
                          </Text>
                          <Text style={styles.tooltipTxnAmt}>+{formatFCFA(tx.amount)}</Text>
                        </View>
                      );
                    })}
                    {txs.length > 4 ? (
                      <Text style={styles.tooltipMore}>+ {txs.length - 4} autres opérations</Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}
          <View style={styles.tooltipFootDivider} />
          <View style={styles.tooltipFoot}>
            <Text style={styles.tooltipFootLbl}>TOTAL</Text>
            <Text style={styles.tooltipFootVal}>{formatFCFA(tooltipBucket.total)}</Text>
          </View>
        </View>
      ) : null}

      {/* ── KPIs ── */}
      {series ? (
        <View style={styles.kpiGrid} testID="activity-kpi-grid">
          <KpiCard
            icon="bar-chart" iconColor="#1E40AF" iconBg="#DBEAFE"
            label="Total sur la période"
            value={formatFCFA(series.summary.total)}
            valueColor="#1E40AF"
            testID="kpi-total"
          />
          <KpiCard
            icon="trending-up" iconColor="#059669" iconBg="#D1FAE5"
            label="Jour le plus élevé"
            value={formatFCFA(series.summary.max_day.total)}
            valueColor="#059669"
            sub={series.summary.max_day.key
              ? formatBarLabel(series.summary.max_day.key, period).bottom
              : "—"}
            testID="kpi-max"
          />
          <KpiCard
            icon="arrow-down" iconColor="#DC2626" iconBg="#FEE2E2"
            label="Jour le plus bas"
            value={formatFCFA(series.summary.min_day.total)}
            valueColor="#DC2626"
            sub={series.summary.min_day.key
              ? formatBarLabel(series.summary.min_day.key, period).bottom
              : "—"}
            testID="kpi-min"
          />
          <KpiCard
            icon="stats-chart" iconColor="#7C3AED" iconBg="#F3E8FF"
            label={period === "1y" ? "Moyenne par mois" : period === "24h" ? "Moyenne par heure" : "Moyenne par jour"}
            value={formatFCFA(series.summary.average)}
            valueColor="#7C3AED"
            testID="kpi-avg"
          />
        </View>
      ) : null}

      {/* ── Day detail ── */}
      {selectedKey ? (
        <View style={styles.detailWrap} testID="activity-day-detail">
          <View style={styles.detailHead}>
            <View style={{ flex: 1 }}>
              <Text style={styles.detailKicker}>DÉTAIL DES GAINS DU JOUR SÉLECTIONNÉ</Text>
              <View style={styles.detailTitleRow}>
                <Ionicons name="calendar" size={14} color="#1E40AF" />
                <Text style={styles.detailTitle}>{formatDayTitle(selectedKey, period)}</Text>
              </View>
            </View>
            <View style={styles.detailTotalBadge} testID="activity-day-total">
              <Text style={styles.detailTotalLbl}>Total : {formatFCFA(day?.grand_total || 0)}</Text>
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
                        ) : txs.map((tx, i) => (
                          <TxnRow key={i} txn={tx} category={c.key} color={c.color} />
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

      {/* ── RÉSUMÉ FINANCIER ── */}
      <View style={styles.summaryWrap} testID="activity-financial-summary">
        <Text style={styles.summaryKicker}>RÉSUMÉ FINANCIER</Text>
        <View style={styles.summaryTitleRow}>
          <Ionicons name="trending-up" size={16} color="#1E40AF" />
          <Text style={styles.summaryTitle}>Statistiques générales</Text>
        </View>
        <View style={styles.summaryGrid}>
          <SummaryCard
            icon="wallet" iconColor="#059669" iconBg="#D1FAE5"
            label="Total reçu (commissions)"
            value={formatFCFA(stats?.total_profit || 0)}
            valueColor="#059669"
            testID="summary-received"
          />
          <SummaryCard
            icon="paper-plane" iconColor="#DC2626" iconBg="#FEE2E2"
            label="Total envoyé"
            value={formatFCFA(stats?.total_withdrawn || 0)}
            valueColor="#DC2626"
            testID="summary-sent"
          />
          <SummaryCard
            icon="wallet" iconColor="#1E40AF" iconBg="#DBEAFE"
            label="Solde disponible"
            value={formatFCFA(stats?.balance_profit || 0)}
            valueColor="#1E40AF"
            testID="summary-balance"
          />
        </View>
      </View>

      {/* ── Dark tooltip (v27ar) — rendered inline above KPIs. ── */}
    </Card>
  );
}

function TxnRow({ txn, category, color }: { txn: Txn; category: string; color: string }) {
  const time = txn.at
    ? new Date(txn.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", hour12: false })
    : "";
  const nameLabel =
    txn.from_username ? txn.from_username :
    txn.platform ? txn.platform.charAt(0).toUpperCase() + txn.platform.slice(1) :
    txn.label;
  const subLabel =
    category === "parrainage" ? "Commission directe" :
    category === "equipe" ? (txn.level ? `Commission niveau ${txn.level}` : "Commission équipe") :
    category === "ads" ? "Gain publicité" :
    category === "missions" ? "Mission validée" :
    "Récompense";
  return (
    <View style={styles.txnRow}>
      <View style={[styles.txnAvatar, { backgroundColor: color + "22" }]}>
        <Ionicons name="person" size={14} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.txnName} numberOfLines={1}>
          {nameLabel} <Text style={styles.txnNameSub}>({subLabel})</Text>
        </Text>
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={styles.txnAmt}>{formatFCFA(txn.amount)}</Text>
        {time ? <Text style={styles.txnTime}>{time}</Text> : null}
      </View>
    </View>
  );
}

function KpiCard({
  icon, iconColor, iconBg, label, value, valueColor, sub, testID,
}: {
  icon: any; iconColor: string; iconBg: string; label: string;
  value: string; valueColor: string; sub?: string; testID?: string;
}) {
  return (
    <View style={styles.kpiCard} testID={testID}>
      <View style={[styles.kpiIcon, { backgroundColor: iconBg }]}>
        <Ionicons name={icon} size={14} color={iconColor} />
      </View>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.kpiValue, { color: valueColor }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? <Text style={styles.kpiSub} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

function SummaryCard({
  icon, iconColor, iconBg, label, value, valueColor, testID,
}: {
  icon: any; iconColor: string; iconBg: string;
  label: string; value: string; valueColor: string; testID?: string;
}) {
  return (
    <View style={styles.summaryCard} testID={testID}>
      <View style={[styles.summaryIcon, { backgroundColor: iconBg }]}>
        <Ionicons name={icon} size={16} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.summaryLbl} numberOfLines={1}>{label}</Text>
        <Text style={[styles.summaryVal, { color: valueColor }]} numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
    </View>
  );
}

// v27ar — TooltipModal removed in favour of inline dark panel rendered
// directly under the chart. See `tooltipInline` block in the main render.

const styles = StyleSheet.create({
  card: { marginTop: 14, padding: 14 },
  head: { flexDirection: "row", alignItems: "flex-start", marginBottom: 14, gap: 10 },
  headLeft: { flexDirection: "row", gap: 10, flex: 1 },
  headIcon: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#DBEAFE",
    alignItems: "center", justifyContent: "center",
  },
  headKicker: { color: theme.colors.textSecondary, fontSize: 10, letterSpacing: 1.8, fontWeight: "800" },
  headTitle: { color: theme.colors.textPrimary, fontSize: 20, fontWeight: "900", letterSpacing: -0.3 },
  headSub: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  pill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.colors.surfaceSecondary,
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  pillTxt: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "700" },

  periodRow: {
    flexDirection: "row", gap: 6, marginBottom: 14,
  },
  periodBtn: {
    flex: 1, paddingVertical: 9, borderRadius: 12,
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  periodBtnActive: { backgroundColor: "#1E40AF", borderColor: "#1E40AF" },
  periodTxt: { color: theme.colors.textPrimary, fontSize: 11, fontWeight: "700" },
  periodTxtActive: { color: "#fff", fontWeight: "900" },

  chartOuter: { flexDirection: "row", marginBottom: 14, paddingRight: 2 },
  yAxisCol: {
    width: 30, justifyContent: "space-between", paddingTop: 22, paddingBottom: 44,
  },
  yLabel: { fontSize: 9, color: theme.colors.textSecondary, textAlign: "right" },
  chartInner: {
    flexDirection: "column",
    paddingHorizontal: 2,
    position: "relative",
  },
  gridLayer: {
    position: "absolute",
    top: 22,
    left: 0, right: 0, bottom: 44,
  },
  gridLine: {
    position: "absolute", left: 0, right: 0, height: 1,
    backgroundColor: "#E5E7EB",
  },
  barsRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingTop: 22,
    gap: 2,
    flex: 1,
  },
  chartLoader: { paddingVertical: 32, alignItems: "center" },
  barCol: { alignItems: "center", gap: 4 },
  barValueWrap: { alignItems: "center", marginBottom: 2, minHeight: 18 },
  barValue: { fontSize: 11, color: theme.colors.textPrimary, fontWeight: "900" },
  barValueSub: { fontSize: 8, color: theme.colors.textSecondary, fontWeight: "700", marginTop: -1 },
  barTrack: {
    width: 24, backgroundColor: "transparent",
    justifyContent: "flex-end", borderRadius: 6, position: "relative",
  },
  barDot: {
    position: "absolute", top: -8, left: 6, right: 6,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: "#fff",
    borderWidth: 3, borderColor: "#1E40AF",
    alignSelf: "center",
  },
  barLblTop: { fontSize: 11, color: theme.colors.textPrimary, marginTop: 4, fontWeight: "700" },
  barLblBot: { fontSize: 9, color: theme.colors.textSecondary },

  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  kpiCard: {
    flexGrow: 1, flexBasis: "47%",
    backgroundColor: theme.colors.surface,
    borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: 14, padding: 10, gap: 4,
  },
  kpiIcon: { width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  kpiLabel: { fontSize: 10, color: theme.colors.textSecondary, fontWeight: "700" },
  kpiValue: { fontSize: 17, fontWeight: "900" },
  kpiSub: { fontSize: 10, color: theme.colors.textSecondary },

  detailWrap: { marginTop: 4, marginBottom: 14 },
  detailHead: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "flex-start", marginBottom: 10, gap: 10,
  },
  detailKicker: { color: theme.colors.textSecondary, fontSize: 10, letterSpacing: 1.2, fontWeight: "800" },
  detailTitleRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  detailTitle: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: "800" },
  detailTotalBadge: {
    backgroundColor: "#FEF3C7",
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6,
  },
  detailTotalLbl: { color: "#92400E", fontSize: 12, fontWeight: "800" },

  catCard: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: 12, overflow: "hidden",
  },
  catHead: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 12, paddingVertical: 11,
  },
  catIcon: { width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  catLbl: { flex: 1, color: theme.colors.textPrimary, fontWeight: "800", fontSize: 12 },
  catVal: { color: theme.colors.textPrimary, fontWeight: "900", fontSize: 13, marginRight: 6 },
  catBody: {
    paddingHorizontal: 12, paddingBottom: 12, gap: 6,
    backgroundColor: theme.colors.surfaceSecondary,
  },

  txnRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: theme.colors.surface,
    borderRadius: 10, padding: 8,
  },
  txnAvatar: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
  },
  txnName: { fontSize: 12, color: theme.colors.textPrimary, fontWeight: "700" },
  txnNameSub: { color: theme.colors.textSecondary, fontWeight: "500" },
  txnAmt: { fontSize: 12, color: "#059669", fontWeight: "800" },
  txnTime: { fontSize: 10, color: theme.colors.textSecondary, marginTop: 1 },

  tooltipInline: {
    backgroundColor: "#0F1A3A",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#1E3A8A",
  },
  tooltipCloseBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center", justifyContent: "center",
  },
  tooltipEmpty: { color: "#CBD5E1", fontSize: 12, textAlign: "center", paddingVertical: 10 },
  tooltipTxnDot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: "#60A5FA",
  },
  tooltipMore: { color: "#94A3B8", fontSize: 10, paddingLeft: 30, marginTop: 2, fontStyle: "italic" },
  tooltipFootDivider: {
    height: 1, backgroundColor: "rgba(255,255,255,0.1)", marginVertical: 10,
  },
  tooltipFoot: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tooltipFootLbl: { color: "#CBD5E1", fontSize: 11, letterSpacing: 1.5, fontWeight: "800" },
  tooltipFootVal: { color: "#FBBF24", fontSize: 18, fontWeight: "900" },

  summaryWrap: {
    marginTop: 6, borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: 14,
  },
  summaryKicker: { color: theme.colors.textSecondary, fontSize: 10, letterSpacing: 1.5, fontWeight: "800" },
  summaryTitleRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4, marginBottom: 10 },
  summaryTitle: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: "900" },
  summaryGrid: { gap: 8 },
  summaryCard: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: theme.colors.surface,
    borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: 14, padding: 12,
  },
  summaryIcon: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  summaryLbl: { fontSize: 10, color: theme.colors.textSecondary, fontWeight: "700" },
  summaryVal: { fontSize: 16, fontWeight: "900", marginTop: 2 },

  tooltipBg: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center", justifyContent: "center", padding: 20,
  },
  tooltipCard: {
    width: "100%", maxWidth: 360,
    backgroundColor: "#0F1A3A",
    borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: "#1E3A8A",
  },
  tooltipHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  tooltipDate: { color: "#fff", fontWeight: "800", fontSize: 13 },
  tooltipTotalRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  tooltipTotalLbl: { color: "#CBD5E1", fontSize: 12 },
  tooltipTotalVal: { color: "#FBBF24", fontWeight: "900", fontSize: 15 },
  tooltipCatHead: {
    flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4,
  },
  tooltipCatIcon: { width: 22, height: 22, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  tooltipCatLbl: { color: "#fff", fontWeight: "800", fontSize: 12, flex: 1 },
  tooltipCatVal: { color: "#fff", fontWeight: "900", fontSize: 12 },
  tooltipTxn: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 30, marginBottom: 3 },
  tooltipTxnLbl: { color: "#CBD5E1", fontSize: 11, flex: 1 },
  tooltipTxnAmt: { color: "#fff", fontWeight: "800", fontSize: 11 },

  emptyBox: { flexDirection: "row", gap: 8, alignItems: "center", padding: 12 },
  emptyTxt: { color: theme.colors.textSecondary, fontSize: 12 },
  errTxt: { color: theme.colors.error, fontSize: 12, textAlign: "center", padding: 12 },
});
