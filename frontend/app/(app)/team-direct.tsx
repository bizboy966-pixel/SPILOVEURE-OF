import React, { useEffect, useState, useCallback } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";

import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type TreeNode = {
  id: string;
  username: string;
  status?: string;
  max_level?: number;
  is_spillover?: boolean;
  is_self?: boolean;
  children?: Record<"left" | "right", TreeNode | undefined> | null;
};

type TreeStats = {
  total: number;
  active: number;
  inactive: number;
  spillover: number;
};

// ---------------------------------------------------------------------------
// Node visual
// ---------------------------------------------------------------------------
function NodeCard({ node, isEmpty, leg }: { node?: TreeNode; isEmpty?: boolean; leg?: "left" | "right" }) {
  if (isEmpty || !node) {
    return (
      <View style={[styles.node, styles.nodeEmpty]} testID={`tree-node-empty-${leg ?? ""}`}>
        <Ionicons name="person-add-outline" size={18} color={theme.colors.textSecondary} />
        <Text style={styles.nodeEmptyTxt}>Libre</Text>
        {leg ? <Text style={styles.legTag}>{leg === "left" ? "Gauche" : "Droite"}</Text> : null}
      </View>
    );
  }
  const active = node.status === "active";
  return (
    <View
      style={[
        styles.node,
        active ? styles.nodeActive : styles.nodeInactive,
        node.is_self ? styles.nodeSelf : null,
      ]}
      testID={`tree-node-${node.username}`}
    >
      <View style={[styles.nodeAvatar, active ? styles.avatarActive : styles.avatarInactive]}>
        <Ionicons name={node.is_self ? "star" : "person"} size={14} color="#fff" />
      </View>
      <Text style={styles.nodeName} numberOfLines={1}>
        {node.username}
      </Text>
      <Text style={styles.nodeMeta}>N{node.max_level ?? 0}</Text>
      <View style={styles.badgesRow}>
        {node.is_spillover ? (
          <View style={[styles.badge, styles.badgeSpill]}>
            <Text style={styles.badgeTxt}>↻ Spillover</Text>
          </View>
        ) : null}
        {leg ? (
          <View style={[styles.badge, leg === "left" ? styles.badgeLeft : styles.badgeRight]}>
            <Text style={styles.badgeTxt}>{leg === "left" ? "G" : "D"}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Recursive renderer (depth-bounded)
// ---------------------------------------------------------------------------
function Subtree({
  node,
  leg,
  depth,
  maxDepth,
}: {
  node?: TreeNode;
  leg?: "left" | "right";
  depth: number;
  maxDepth: number;
}) {
  const children = node?.children;
  const hasKids = children && (children.left || children.right);
  const showKids = node && hasKids && depth < maxDepth;

  return (
    <View style={styles.subtree}>
      <NodeCard node={node} isEmpty={!node} leg={leg} />
      {showKids ? (
        <>
          <View style={styles.connectorV} />
          <View style={styles.connectorH} />
          <View style={styles.row}>
            <Subtree
              node={children?.left}
              leg="left"
              depth={depth + 1}
              maxDepth={maxDepth}
            />
            <Subtree
              node={children?.right}
              leg="right"
              depth={depth + 1}
              maxDepth={maxDepth}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Stats walker
// ---------------------------------------------------------------------------
function computeStats(root?: TreeNode): TreeStats {
  let total = 0;
  let active = 0;
  let inactive = 0;
  let spillover = 0;
  function walk(n?: TreeNode | null) {
    if (!n) return;
    if (!n.is_self) {
      total += 1;
      if (n.status === "active") active += 1;
      else inactive += 1;
      if (n.is_spillover) spillover += 1;
    }
    walk(n.children?.left);
    walk(n.children?.right);
  }
  walk(root);
  return { total, active, inactive, spillover };
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
export default function TeamDirect() {
  const router = useRouter();
  const [root, setRoot] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [depth, setDepth] = useState(3); // visual depth toggle (2..4)

  const load = useCallback(async () => {
    try {
      const r = await api.get<TreeNode>(`/team/tree?max_depth=4`);
      setRoot(r);
    } catch {
      setRoot(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const stats = computeStats(root || undefined);
  const hasAny = stats.total > 0;

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Équipe directe</Text>
        <Text style={styles.sub}>Votre matrice binaire — gauche/droite, spillovers inclus.</Text>
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statLbl}>Total</Text>
            <Text style={styles.statVal}>{stats.total}</Text>
          </View>
          <View style={[styles.statBox, { backgroundColor: "rgba(16,185,129,0.25)" }]}>
            <Text style={styles.statLbl}>Actifs</Text>
            <Text style={styles.statVal}>{stats.active}</Text>
          </View>
          <View style={[styles.statBox, { backgroundColor: "rgba(239,68,68,0.25)" }]}>
            <Text style={styles.statLbl}>Inactifs</Text>
            <Text style={styles.statVal}>{stats.inactive}</Text>
          </View>
          <View style={[styles.statBox, { backgroundColor: "rgba(245,158,11,0.25)" }]}>
            <Text style={styles.statLbl}>Spillover</Text>
            <Text style={styles.statVal}>{stats.spillover}</Text>
          </View>
        </View>
      </LinearGradient>

      {/* Depth toggle */}
      <View style={styles.depthBar}>
        <Text style={styles.depthLabel}>Profondeur :</Text>
        {[2, 3, 4].map((d) => (
          <TouchableOpacity
            key={d}
            onPress={() => setDepth(d)}
            style={[styles.depthChip, depth === d && styles.depthChipOn]}
            testID={`tree-depth-${d}`}
          >
            <Text style={[styles.depthChipTxt, depth === d && { color: "#fff" }]}>{d}</Text>
          </TouchableOpacity>
        ))}
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={load} style={styles.refreshBtn} testID="tree-refresh">
          <Ionicons name="refresh" size={16} color={theme.colors.primary} />
        </TouchableOpacity>
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: theme.colors.success }]} />
          <Text style={styles.legendTxt}>Actif</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: theme.colors.textSecondary }]} />
          <Text style={styles.legendTxt}>Inactif</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: theme.colors.warning }]} />
          <Text style={styles.legendTxt}>Spillover</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: theme.colors.primary }]} />
          <Text style={styles.legendTxt}>Vous</Text>
        </View>
      </View>

      <ScrollView
        horizontal
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        <ScrollView
          contentContainerStyle={{ alignItems: "center", paddingHorizontal: 8 }}
        >
          {loading ? (
            <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 40 }} />
          ) : (
            <>
              <Subtree node={root || undefined} depth={0} maxDepth={depth} />
              {!hasAny ? (
                <Card style={{ minWidth: 280, marginTop: 24 }}>
                  <View style={{ alignItems: "center", padding: 16 }}>
                    <Ionicons
                      name="people-outline"
                      size={36}
                      color={theme.colors.textSecondary}
                    />
                    <Text
                      style={{
                        color: theme.colors.textSecondary,
                        marginTop: 8,
                        textAlign: "center",
                        fontSize: 13,
                      }}
                    >
                      Aucun filleul placé dans votre matrice.{"\n"}Partagez
                      votre lien d'invitation pour la remplir !
                    </Text>
                  </View>
                </Card>
              ) : null}
            </>
          )}
        </ScrollView>
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const NODE_W = 110;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, paddingBottom: 20 },
  back: {
    width: 36,
    height: 36,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  title: { color: "#fff", fontSize: 24, fontWeight: "800" },
  sub: { color: "#C7D9FF" },
  statsRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  statBox: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.15)",
    padding: 10,
    borderRadius: 14,
    alignItems: "center",
  },
  statLbl: { color: "#C7D9FF", fontSize: 10 },
  statVal: { color: "#fff", fontSize: 18, fontWeight: "800" },

  depthBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  depthLabel: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: "600" },
  depthChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  depthChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  depthChipTxt: { fontWeight: "700", color: theme.colors.textPrimary, fontSize: 12 },
  refreshBtn: {
    width: 32,
    height: 32,
    borderRadius: 20,
    backgroundColor: "#DBEAFE",
    alignItems: "center",
    justifyContent: "center",
  },

  legend: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
    flexWrap: "wrap",
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 6 },
  legendTxt: { color: theme.colors.textSecondary, fontSize: 11 },

  // tree
  subtree: { alignItems: "center" },
  row: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  connectorV: { width: 2, height: 14, backgroundColor: theme.colors.border },
  connectorH: { height: 2, width: NODE_W + 12, backgroundColor: theme.colors.border, marginBottom: -1 },

  node: {
    width: NODE_W,
    minHeight: 76,
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 6,
    alignItems: "center",
    backgroundColor: "#fff",
    borderWidth: 2,
    marginVertical: 4,
    ...theme.shadow.card,
  },
  nodeActive: { borderColor: theme.colors.success },
  nodeInactive: { borderColor: theme.colors.border },
  nodeSelf: { borderColor: theme.colors.primary, backgroundColor: "#EFF4FF" },
  nodeEmpty: {
    width: NODE_W,
    minHeight: 76,
    borderRadius: 14,
    backgroundColor: "#F1F5F9",
    borderWidth: 2,
    borderColor: theme.colors.border,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 4,
  },
  nodeEmptyTxt: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 4 },
  nodeAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  avatarActive: { backgroundColor: theme.colors.success },
  avatarInactive: { backgroundColor: theme.colors.textSecondary },
  nodeName: {
    fontWeight: "700",
    color: theme.colors.textPrimary,
    fontSize: 11,
    maxWidth: NODE_W - 8,
  },
  nodeMeta: { color: theme.colors.textSecondary, fontSize: 10 },
  badgesRow: { flexDirection: "row", gap: 4, marginTop: 4, flexWrap: "wrap", justifyContent: "center" },
  badge: { borderRadius: 8, paddingHorizontal: 4, paddingVertical: 1 },
  badgeSpill: { backgroundColor: theme.colors.warningBg },
  badgeLeft: { backgroundColor: "#DBEAFE" },
  badgeRight: { backgroundColor: "#E0E7FF" },
  badgeTxt: { fontSize: 9, fontWeight: "700", color: theme.colors.textPrimary },
  legTag: { fontSize: 9, color: theme.colors.textSecondary, marginTop: 2 },
});
