import React, { useCallback, useEffect, useState } from "react";
import {
  Alert, Linking, ScrollView, StyleSheet, Text, View, TouchableOpacity, Modal, Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { Button } from "@/src/components/Button";
import { Input } from "@/src/components/Input";
import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { formatFCFA, formatDateTime } from "@/src/utils/format";

type Section = "account" | "privileges" | "finance" | "network" | "level" | "history" | "notes" | "tree";

export default function ManageUser() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [section, setSection] = useState<Section>("account");

  // Form states
  const [creditAmount, setCreditAmount] = useState("");
  const [creditBucket, setCreditBucket] = useState<"profit" | "upgrade">("profit");
  const [debitAmount, setDebitAmount] = useState("");
  const [debitBucket, setDebitBucket] = useState<"profit" | "upgrade">("profit");
  const [newPassword, setNewPassword] = useState("");
  const [newSponsor, setNewSponsor] = useState("");
  const [moveLevel, setMoveLevel] = useState("1");
  const [moveParent, setMoveParent] = useState("");
  const [moveLeg, setMoveLeg] = useState<"left" | "right">("left");
  const [activateLevel, setActivateLevel] = useState("1");
  const [noteText, setNoteText] = useState("");
  const [treeLevel, setTreeLevel] = useState(1);
  const [tree, setTree] = useState<any>(null);
  const [history, setHistory] = useState<any[] | null>(null);
  const [historyFilter, setHistoryFilter] = useState<"all" | "commission" | "activation" | "withdrawal" | "mission">("all");
  const [historySearch, setHistorySearch] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.get(`/admin/users/${id}`);
      setData(r);
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Impossible de charger l'utilisateur.");
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const loadTree = async (lvl: number) => {
    try {
      const r = await api.get(`/admin/users/${id}/tree?level=${lvl}`);
      setTree(r);
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Erreur arbre.");
    }
  };

  useEffect(() => {
    if (section === "tree") loadTree(treeLevel);
  }, [section, treeLevel]);

  const loadHistory = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.get<any[]>(`/admin/users/${id}/transactions`);
      setHistory(r || []);
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Impossible de charger l'historique.");
    }
  }, [id]);

  useEffect(() => {
    if (section === "history" && history === null) loadHistory();
  }, [section, history, loadHistory]);

  const doAction = async (payload: any, okMsg = "✅ Action effectuée", confirmMsg?: string) => {
    // Confirm on web via window.confirm (Alert.alert is silently a noop on web)
    if (confirmMsg && typeof window !== "undefined" && typeof window.confirm === "function") {
      const ok = window.confirm(confirmMsg);
      if (!ok) return;
    }
    try {
      await api.post(`/admin/users/${id}/action`, payload);
      if (typeof window !== "undefined" && typeof window.alert === "function") {
        window.alert(okMsg);
      } else {
        Alert.alert("Succès", okMsg);
      }
      await load();
    } catch (e: any) {
      const msg = e?.detail || "Échec";
      if (typeof window !== "undefined" && typeof window.alert === "function") {
        window.alert("❌ " + msg);
      } else {
        Alert.alert("Erreur", msg);
      }
    }
  };

  if (!data) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={{ padding: 16 }}><Text>Chargement…</Text></View>
      </SafeAreaView>
    );
  }
  const u = data.user;

  const SECTIONS: { key: Section; label: string; icon: any; color: string }[] = [
    { key: "account", label: "Compte", icon: "person", color: theme.colors.primary },
    { key: "privileges", label: "Privilèges", icon: "shield", color: theme.colors.secondary },
    { key: "finance", label: "Finances", icon: "cash", color: theme.colors.success },
    { key: "network", label: "Réseau", icon: "git-network", color: "#A855F7" },
    { key: "level", label: "Niveaux", icon: "ribbon", color: theme.colors.warning },
    { key: "history", label: "📊 Historique", icon: "time", color: "#10B981" },
    { key: "notes", label: "Notes", icon: "document-text", color: "#0EA5E9" },
    { key: "tree", label: "Arbre", icon: "git-branch", color: "#F97316" },
  ];

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back} testID="manage-back">
          <Ionicons name="chevron-back" size={20} color="#fff" />
          <Text style={styles.backLabel}>Retour</Text>
        </TouchableOpacity>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={styles.avatar}><Ionicons name="person" size={28} color="#fff" /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{u.username}</Text>
            <Text style={styles.sub}>{u.email}</Text>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
              <Badge label={u.role === "admin" ? "ADMIN" : "USER"} color={u.role === "admin" ? "#F59E0B" : "#fff"} />
              {u.is_promoter && <Badge label="PROMOTEUR" color="#A855F7" />}
              <Badge label={`Niveau ${u.max_level}`} color="#22D3EE" />
              <Badge label={u.status?.toUpperCase()} color={u.status === "active" ? "#10B981" : u.status === "banned" ? "#EF4444" : "#F59E0B"} />
            </View>
          </View>
        </View>
      </LinearGradient>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {SECTIONS.map((s) => (
          <TouchableOpacity
            key={s.key}
            style={[styles.tab, section === s.key && { backgroundColor: s.color, borderColor: s.color }]}
            onPress={() => setSection(s.key)}
            testID={`manage-tab-${s.key}`}
          >
            <Ionicons name={s.icon} size={14} color={section === s.key ? "#fff" : s.color} />
            <Text style={[styles.tabT, section === s.key && { color: "#fff" }]}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        {/* Always-visible summary card */}
        <Card>
          <Text style={styles.sectionTitle}>Identité</Text>
          <KV k="ID" v={u.id} />
          <KV k="Username" v={u.username} />
          <KV k="E-mail" v={u.email} />
          <KV k="Téléphone" v={u.phone} />
          <KV k="Pays" v={u.country} />
          <KV k="Parrain" v={u.sponsor_username || "—"} />
          <KV k="Inscription" v={formatDateTime(u.created_at)} />
          <KV k="Solde profit" v={formatFCFA(u.balance_profit)} />
          <KV k="Réserve mise à niveau" v={formatFCFA(u.balance_upgrade)} />
          <KV k="Total retiré" v={formatFCFA(u.total_withdrawn)} />
          <KV k="Retraits désactivés" v={u.withdrawals_disabled ? "Oui" : "Non"} />
        </Card>

        {section === "account" && (
          <Card style={{ marginTop: 12 }}>
            <Text style={styles.sectionTitle}>Gestion du compte</Text>
            <ActionBtn label="Bloquer" icon="ban" color={theme.colors.warning} onPress={() => doAction({ action: "block" }, "Compte bloqué")} testID="act-block" />
            <ActionBtn label="Débloquer" icon="checkmark-circle" color={theme.colors.success} onPress={() => doAction({ action: "unblock" }, "Compte débloqué")} testID="act-unblock" />
            <ActionBtn label="Bannir" icon="hand-left" color={theme.colors.danger} onPress={() => doAction({ action: "ban" }, "Utilisateur banni")} testID="act-ban" />
            <ActionBtn label="Débannir" icon="hand-right" color={theme.colors.success} onPress={() => doAction({ action: "unban" }, "Utilisateur débanni")} testID="act-unban" />
            <Input label="Nouveau mot de passe" secureTextEntry value={newPassword} onChangeText={setNewPassword} placeholder="Min 8 caractères" testID="act-new-pwd" />
            <Button title="Réinitialiser le mot de passe" variant="outline" onPress={() => doAction({ action: "reset_password", new_password: newPassword }, "Mot de passe modifié")} testID="act-reset-pwd" />
            <View style={{ height: 12 }} />
            <ActionBtn
              label="🗑️ Supprimer définitivement"
              icon="trash"
              color={theme.colors.danger}
              onPress={async () => {
                await doAction({ action: "delete" }, "Compte supprimé", "⚠️ Supprimer définitivement ce compte ? Cette action est irréversible.");
                router.back();
              }}
              testID="act-delete"
            />
          </Card>
        )}

        {section === "privileges" && (
          <Card style={{ marginTop: 12 }}>
            <Text style={styles.sectionTitle}>Gestion des privilèges</Text>
            {u.role === "admin" ? (
              <ActionBtn label="Retirer le rôle Administrateur" icon="shield-half" color={theme.colors.warning} onPress={() => doAction({ action: "remove_admin" }, "Admin retiré")} testID="priv-remove-admin" />
            ) : (
              <ActionBtn label="Nommer Administrateur" icon="shield-checkmark" color={theme.colors.primary} onPress={() => doAction({ action: "make_admin" }, "Promu admin")} testID="priv-make-admin" />
            )}
            {u.is_promoter ? (
              <ActionBtn label="Retirer le statut Promoteur" icon="star-half" color={theme.colors.warning} onPress={() => doAction({ action: "remove_promoter" }, "Promoteur retiré")} testID="priv-remove-promo" />
            ) : (
              <ActionBtn label="Marquer comme Promoteur" icon="star" color={theme.colors.secondary} onPress={() => doAction({ action: "make_promoter" }, "Marqué promoteur")} testID="priv-make-promo" />
            )}
          </Card>
        )}

        {section === "finance" && (
          <>
            <Card style={{ marginTop: 12 }}>
              <Text style={styles.sectionTitle}>Retraits</Text>
              {u.withdrawals_disabled ? (
                <ActionBtn label="Débloquer les retraits" icon="lock-open" color={theme.colors.success} onPress={() => doAction({ action: "enable_withdrawals" }, "Retraits débloqués")} testID="fin-enable-wd" />
              ) : (
                <ActionBtn label="Bloquer les retraits" icon="lock-closed" color={theme.colors.warning} onPress={() => doAction({ action: "disable_withdrawals" }, "Retraits bloqués")} testID="fin-disable-wd" />
              )}
            </Card>
            <Card style={{ marginTop: 12 }}>
              <Text style={styles.sectionTitle}>Créditer le portefeuille</Text>
              <BucketSelector value={creditBucket} onChange={setCreditBucket} />
              <Input label="Montant (FCFA)" keyboardType="numeric" value={creditAmount} onChangeText={setCreditAmount} testID="fin-credit-amount" />
              <Button title={`Créditer ${formatFCFA(parseInt(creditAmount || "0", 10))}`} onPress={() => doAction({ action: "credit_wallet", amount: parseInt(creditAmount || "0", 10), bucket: creditBucket }, "Portefeuille crédité")} testID="fin-credit-btn" />
            </Card>
            <Card style={{ marginTop: 12 }}>
              <Text style={styles.sectionTitle}>Débiter le portefeuille</Text>
              <BucketSelector value={debitBucket} onChange={setDebitBucket} />
              <Input label="Montant (FCFA)" keyboardType="numeric" value={debitAmount} onChangeText={setDebitAmount} testID="fin-debit-amount" />
              <Button title={`Débiter ${formatFCFA(parseInt(debitAmount || "0", 10))}`} variant="danger" onPress={() => doAction({ action: "debit_wallet", amount: parseInt(debitAmount || "0", 10), bucket: debitBucket }, "Portefeuille débité")} testID="fin-debit-btn" />
            </Card>
          </>
        )}

        {section === "network" && (
          <>
            <Card style={{ marginTop: 12 }}>
              <Text style={styles.sectionTitle}>Modifier le parrain</Text>
              <Input label="Nouveau parrain (username)" value={newSponsor} onChangeText={setNewSponsor} autoCapitalize="none" testID="net-new-sponsor" />
              <Button title="Changer le parrain" onPress={() => doAction({ action: "change_sponsor", new_sponsor_username: newSponsor }, "Parrain modifié")} testID="net-change-sponsor" />
            </Card>
            <Card style={{ marginTop: 12 }}>
              <Text style={styles.sectionTitle}>Déplacer dans la matrice</Text>
              <Text style={styles.lbl}>Niveau</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 4 }}>
                {Array.from({ length: 12 }).map((_, i) => (
                  <TouchableOpacity key={i + 1} style={[styles.chip, moveLevel === String(i + 1) && styles.chipOn]} onPress={() => setMoveLevel(String(i + 1))}>
                    <Text style={[styles.chipT, moveLevel === String(i + 1) && { color: "#fff" }]}>N{i + 1}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <Input label="Nouveau parent (username)" value={moveParent} onChangeText={setMoveParent} autoCapitalize="none" testID="net-move-parent" />
              <Text style={styles.lbl}>Jambe</Text>
              <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
                <TouchableOpacity style={[styles.chip, moveLeg === "left" && styles.chipOn]} onPress={() => setMoveLeg("left")}>
                  <Text style={[styles.chipT, moveLeg === "left" && { color: "#fff" }]}>← Gauche</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.chip, moveLeg === "right" && styles.chipOn]} onPress={() => setMoveLeg("right")}>
                  <Text style={[styles.chipT, moveLeg === "right" && { color: "#fff" }]}>Droite →</Text>
                </TouchableOpacity>
              </View>
              <Button title="Déplacer" onPress={() => doAction({ action: "move_matrix", level: parseInt(moveLevel, 10), new_parent_username: moveParent, new_leg: moveLeg }, "Position modifiée")} testID="net-move-btn" />
            </Card>
            <Card style={{ marginTop: 12 }}>
              <Text style={styles.sectionTitle}>Positions actuelles dans les matrices</Text>
              {data.placements.length === 0 ? (
                <Text style={{ color: theme.colors.textSecondary }}>Aucune position.</Text>
              ) : (
                data.placements.sort((a: any, b: any) => a.level - b.level).map((p: any) => (
                  <View key={p.level} style={styles.placement}>
                    <Text style={styles.placeLvl}>Niveau {p.level}</Text>
                    <Text style={styles.placeMeta}>Parent: {p.parent_id?.substring(0, 8) || "—"} • Leg: {p.leg || "—"} {p.is_spillover ? "• 🔷 Spillover" : ""}</Text>
                  </View>
                ))
              )}
            </Card>
          </>
        )}

        {section === "level" && (
          <>
            <Card style={{ marginTop: 12 }}>
              <Text style={styles.sectionTitle}>Activation manuelle</Text>
              <Text style={styles.lbl}>Niveau à activer (prochain: {u.max_level + 1})</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 4 }}>
                {Array.from({ length: 12 }).map((_, i) => (
                  <TouchableOpacity key={i + 1} style={[styles.chip, activateLevel === String(i + 1) && styles.chipOn]} onPress={() => setActivateLevel(String(i + 1))}>
                    <Text style={[styles.chipT, activateLevel === String(i + 1) && { color: "#fff" }]}>N{i + 1}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <View style={{ height: 12 }} />
              <Button title={`Activer Niveau ${activateLevel}`} onPress={() => doAction({ action: "activate_level", level: parseInt(activateLevel, 10) }, "Niveau activé")} testID="lvl-activate" />
              <View style={{ height: 8 }} />
              <Button title={`Désactiver Niveau ${u.max_level} (le plus haut)`} variant="danger" onPress={() => doAction({ action: "deactivate_level", level: u.max_level }, "Niveau désactivé")} testID="lvl-deactivate" />
            </Card>
            <Card style={{ marginTop: 12 }}>
              <Text style={styles.sectionTitle}>Historique des activations</Text>
              {data.activations.length === 0 ? (
                <Text style={{ color: theme.colors.textSecondary }}>Aucune activation.</Text>
              ) : (
                data.activations.map((a: any) => (
                  <View key={a.id} style={styles.actItem}>
                    <Text style={{ fontWeight: "700", color: theme.colors.textPrimary }}>Niveau {a.level} — {formatFCFA(a.amount)}</Text>
                    <Text style={styles.meta}>{a.payment_method} {a.operator ? `(${a.operator})` : ""}</Text>
                    <Text style={styles.meta}>{formatDateTime(a.created_at)}</Text>
                    <View style={[styles.pill, { backgroundColor: a.status === "validated" ? theme.colors.successBg : a.status === "rejected" ? theme.colors.dangerBg : theme.colors.warningBg, alignSelf: "flex-start", marginTop: 4 }]}>
                      <Text style={{ fontWeight: "700", fontSize: 11, color: a.status === "validated" ? theme.colors.success : a.status === "rejected" ? theme.colors.danger : theme.colors.warning }}>
                        {a.status}
                      </Text>
                    </View>
                  </View>
                ))
              )}
            </Card>
          </>
        )}

        {section === "history" && (
          <Card style={{ marginTop: 12 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={styles.sectionTitle}>📊 Historique Complet ({history?.length ?? 0})</Text>
              <TouchableOpacity
                onPress={() => { setHistory(null); loadHistory(); }}
                style={{ padding: 6 }}
                testID="history-refresh"
              >
                <Ionicons name="refresh" size={18} color={theme.colors.primary} />
              </TouchableOpacity>
            </View>

            <Input
              label="🔍 Rechercher"
              value={historySearch}
              onChangeText={setHistorySearch}
              placeholder="Nom, ID, type, montant…"
              testID="history-search"
            />

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 4 }}>
              {(["all", "commission", "activation", "withdrawal", "mission"] as const).map((f) => {
                const lbl = f === "all" ? "Tout" : f === "commission" ? "💰 Commissions" : f === "activation" ? "Activations" : f === "withdrawal" ? "Retraits" : "Missions";
                const on = historyFilter === f;
                return (
                  <TouchableOpacity
                    key={f}
                    style={[styles.chip, on && styles.chipOn]}
                    onPress={() => setHistoryFilter(f)}
                    testID={`history-filter-${f}`}
                  >
                    <Text style={[styles.chipT, on && { color: "#fff" }]}>{lbl}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View style={{ height: 10 }} />

            {history === null ? (
              <Text style={{ color: theme.colors.textSecondary }}>Chargement…</Text>
            ) : (() => {
                const q = historySearch.trim().toLowerCase();
                const filtered = history.filter((t: any) => {
                  if (historyFilter === "commission" && !String(t.type).startsWith("commission_")) return false;
                  if (historyFilter === "activation" && t.type !== "activation" && t.type !== "payment") return false;
                  if (historyFilter === "withdrawal" && t.type !== "withdrawal") return false;
                  if (historyFilter === "mission" && t.type !== "mission") return false;
                  if (!q) return true;
                  const hay = [
                    t.label, t.type, t.status, t.from_username, t.from_user_id, t.ref,
                    String(t.amount), String(t.level), t.meta?.operator, t.meta?.transaction_ref,
                  ].filter(Boolean).join(" ").toLowerCase();
                  return hay.includes(q);
                });

                if (filtered.length === 0) {
                  return <Text style={{ color: theme.colors.textSecondary }}>Aucune transaction.</Text>;
                }

                return filtered.map((t: any, idx: number) => {
                  const isCommission = String(t.type).startsWith("commission_");
                  const isWd = t.type === "withdrawal";
                  const isIncoming = isCommission || t.type === "mission";
                  const sign = isWd ? "−" : isIncoming ? "+" : "↓";
                  const color = isIncoming ? theme.colors.success : isWd ? theme.colors.danger : theme.colors.textPrimary;
                  const icon = isCommission ? "trending-up" : t.type === "mission" ? "trophy" : isWd ? "arrow-up-circle" : t.type === "payment" ? "card" : "ribbon";
                  return (
                    <View key={`${t.ref || idx}-${t.type}-${idx}`} style={styles.historyItem}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <View style={[styles.histIcon, { backgroundColor: isCommission ? "#DCFCE7" : isWd ? "#FEE2E2" : t.type === "mission" ? "#FEF3C7" : "#DBEAFE" }]}>
                          <Ionicons name={icon as any} size={14} color={isCommission ? theme.colors.success : isWd ? theme.colors.danger : t.type === "mission" ? theme.colors.warning : theme.colors.primary} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13 }}>{t.label}</Text>
                          <Text style={{ color: theme.colors.textSecondary, fontSize: 10, marginTop: 2 }}>{formatDateTime(t.date)}</Text>
                        </View>
                        <View style={{ alignItems: "flex-end" }}>
                          <Text style={{ color, fontWeight: "800", fontSize: 13 }}>{sign} {formatFCFA(t.amount)}</Text>
                          <Text style={{ color: theme.colors.textSecondary, fontSize: 9 }}>{t.status}</Text>
                        </View>
                      </View>
                      {isCommission && (t.from_username || t.from_user_id) && (
                        <View style={styles.histMeta}>
                          {t.from_username ? (
                            <Text style={styles.histMetaTxt}>👤 Provenance : <Text style={{ fontWeight: "700", color: theme.colors.primary }}>{t.from_username}</Text></Text>
                          ) : null}
                          {t.from_user_id ? (
                            <Text style={[styles.histMetaTxt, { fontFamily: "monospace", fontSize: 9 }]} numberOfLines={1}>🆔 {t.from_user_id}</Text>
                          ) : null}
                          {t.level != null ? (
                            <Text style={styles.histMetaTxt}>📊 Niveau {t.level}</Text>
                          ) : null}
                        </View>
                      )}
                      {t.meta?.transaction_ref ? (
                        <Text style={[styles.histMetaTxt, { fontFamily: "monospace", fontSize: 9, marginTop: 2 }]} numberOfLines={1}>Réf : {t.meta.transaction_ref}</Text>
                      ) : null}
                    </View>
                  );
                });
              })()
            }
          </Card>
        )}

        {section === "notes" && (
          <>
            <Card style={{ marginTop: 12 }}>
              <Text style={styles.sectionTitle}>Ajouter une note administrative</Text>
              <Input label="Note" value={noteText} onChangeText={setNoteText} multiline numberOfLines={4} testID="note-text" />
              <Button title="Enregistrer la note" onPress={async () => {
                await doAction({ action: "add_note", note: noteText }, "Note ajoutée");
                setNoteText("");
              }} testID="note-save" />
            </Card>
            <Card style={{ marginTop: 12 }}>
              <Text style={styles.sectionTitle}>Notes existantes ({data.notes.length})</Text>
              {data.notes.length === 0 ? (
                <Text style={{ color: theme.colors.textSecondary }}>Aucune note.</Text>
              ) : (
                data.notes.map((n: any) => (
                  <View key={n.id} style={styles.noteItem}>
                    <Text style={{ color: theme.colors.textPrimary }}>{n.note}</Text>
                    <Text style={styles.meta}>par {n.admin_username || "admin"} • {formatDateTime(n.at)}</Text>
                  </View>
                ))
              )}
            </Card>
          </>
        )}

        {section === "tree" && (
          <Card style={{ marginTop: 12 }}>
            <Text style={styles.sectionTitle}>Arbre généalogique — Niveau {treeLevel}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 4 }}>
              {Array.from({ length: 12 }).map((_, i) => (
                <TouchableOpacity key={i + 1} style={[styles.chip, treeLevel === i + 1 && styles.chipOn]} onPress={() => setTreeLevel(i + 1)}>
                  <Text style={[styles.chipT, treeLevel === i + 1 && { color: "#fff" }]}>N{i + 1}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={{ height: 12 }} />
            {(!tree || tree.layers.every((l: any[]) => l.length === 0)) ? (
              <Text style={{ color: theme.colors.textSecondary }}>Aucun descendant à ce niveau.</Text>
            ) : (
              tree.layers.map((layer: any[], idx: number) => (
                layer.length > 0 ? (
                  <View key={idx} style={styles.layer}>
                    <Text style={styles.layerLbl}>Couche {idx + 1} ({layer.length})</Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {layer.map((m: any) => (
                        <View key={m.user_id} style={[styles.node, m.user?.status === "active" ? styles.nodeOn : styles.nodeOff]}>
                          <Text style={{ color: "#fff", fontWeight: "700", fontSize: 11 }}>{m.user?.username || "?"}</Text>
                          <Text style={{ color: "#fff", fontSize: 9 }}>N{m.user?.max_level || 0} • {m.leg || "—"}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                ) : null
              ))
            )}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function KV({ k, v }: { k: string; v: any }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvK}>{k}</Text>
      <Text style={styles.kvV} numberOfLines={1}>{String(v ?? "—")}</Text>
    </View>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeT, { color }]}>{label}</Text>
    </View>
  );
}

function ActionBtn({ label, icon, color, onPress, testID }: { label: string; icon: any; color: string; onPress: () => void; testID?: string }) {
  return (
    <TouchableOpacity style={[styles.actionBtn, { borderColor: color }]} onPress={onPress} testID={testID}>
      <Ionicons name={icon} size={18} color={color} />
      <Text style={[styles.actionBtnT, { color }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={color} />
    </TouchableOpacity>
  );
}

function BucketSelector({ value, onChange }: { value: "profit" | "upgrade"; onChange: (v: "profit" | "upgrade") => void }) {
  return (
    <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
      <TouchableOpacity style={[styles.chip, value === "profit" && styles.chipOn]} onPress={() => onChange("profit")}>
        <Text style={[styles.chipT, value === "profit" && { color: "#fff" }]}>💎 Profit</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.chip, value === "upgrade" && styles.chipOn]} onPress={() => onChange("upgrade")}>
        <Text style={[styles.chipT, value === "upgrade" && { color: "#fff" }]}>🔒 Réserve</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, paddingBottom: 16 },
  back: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.25)", alignSelf: "flex-start", marginBottom: 12 },
  backLabel: { color: "#fff", fontWeight: "700", fontSize: 13 },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: theme.colors.secondary, alignItems: "center", justifyContent: "center" },
  title: { color: "#fff", fontSize: 20, fontWeight: "800" },
  sub: { color: "#C7D9FF" },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  badgeT: { fontWeight: "800", fontSize: 10 },
  tabs: { padding: 12, gap: 6 },
  tab: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#fff", borderRadius: 20, borderWidth: 1, borderColor: theme.colors.border },
  tabT: { fontWeight: "700", color: theme.colors.textPrimary, fontSize: 12 },
  sectionTitle: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 10, fontSize: 16 },
  kv: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  kvK: { color: theme.colors.textSecondary, fontSize: 12 },
  kvV: { color: theme.colors.textPrimary, fontWeight: "600", fontSize: 12, maxWidth: "60%" },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 12, borderWidth: 1.5, marginBottom: 8 },
  actionBtnT: { flex: 1, fontWeight: "700" },
  lbl: { color: theme.colors.textPrimary, fontWeight: "600", marginBottom: 6, marginTop: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  chipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipT: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },
  placement: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  placeLvl: { fontWeight: "700", color: theme.colors.textPrimary },
  placeMeta: { color: theme.colors.textSecondary, fontSize: 12 },
  actItem: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  meta: { color: theme.colors.textSecondary, fontSize: 12 },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  noteItem: { padding: 10, backgroundColor: theme.colors.surfaceSecondary, borderRadius: 10, marginBottom: 8 },
  layer: { marginBottom: 12 },
  layerLbl: { fontWeight: "700", color: theme.colors.textSecondary, fontSize: 12, marginBottom: 4 },
  node: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, minWidth: 70, alignItems: "center" },
  nodeOn: { backgroundColor: theme.colors.success },
  nodeOff: { backgroundColor: theme.colors.textSecondary },
  historyItem: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  histIcon: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  histMeta: { marginTop: 4, paddingLeft: 40, gap: 2 },
  histMetaTxt: { color: theme.colors.textSecondary, fontSize: 11 },
});
