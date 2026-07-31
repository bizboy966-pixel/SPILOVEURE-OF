/**
 * Admin diagnostic page for AshtecPay production issues.
 * Displays: version, config, /health probe results, and last 20 failures
 * with the RAW response body from Ashtech — so we can pinpoint exactly
 * why the gateway is refusing in prod.
 */
import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View, TouchableOpacity, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

export default function AshtecDiag() {
  const router = useRouter();
  const [diag, setDiag] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [d, h] = await Promise.all([
        api.get<any>("/admin/payments/ashtec/diag?limit=10"),
        api.get<any>("/admin/payments/ashtec/health"),
      ]);
      setDiag(d); setHealth(h);
    } catch (e: any) {
      setError(e?.detail || e?.message || "Erreur");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="dg-back">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>🩺 Diagnostic Ashtech Pay</Text>
        <TouchableOpacity onPress={load} testID="dg-reload">
          <Ionicons name="refresh" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
        {loading && <ActivityIndicator size="large" color="#F59E0B" />}
        {error ? <Text style={styles.err}>{error}</Text> : null}

        {/* Health probe result */}
        {health && (
          <Card style={{ borderWidth: 2, borderColor: health.ok ? "#10B981" : "#EF4444" }}>
            <Text style={styles.section}>
              {health.ok ? "✅" : "❌"} Health check en direct
            </Text>
            <Text style={styles.txt}>Verdict : <Text style={{ fontWeight: "800" }}>{health.conclusion}</Text></Text>
            <Text style={styles.txt}>Base URL : <Text style={styles.mono}>{health.server_env?.base_url}</Text></Text>
            <Text style={styles.txt}>Webhook URL : <Text style={styles.mono}>{health.server_env?.webhook_url}</Text></Text>
            <Text style={styles.txt}>Version code : <Text style={styles.mono}>{health.catalog_version}</Text></Text>
            <Text style={styles.txt}>Clé API : <Text style={styles.mono}>{health.api_key_prefix}</Text></Text>
            <View style={{ marginTop: 8 }}>
              <Text style={styles.subsection}>Probes exécutés :</Text>
              {(health.probes || []).map((p: any, i: number) => (
                <View key={i} style={{ marginTop: 6, padding: 8, backgroundColor: "#F1F5F9", borderRadius: 8 }}>
                  <Text style={styles.txt}>
                    [{p.country}] <Text style={{ fontWeight: "800" }}>{p.operator}</Text> →
                    <Text style={{ color: p.success ? "#10B981" : "#EF4444", fontWeight: "800" }}>
                      {" "}{p.success ? "OK" : `KO (${p.status_code})`}
                    </Text>
                  </Text>
                  <Text style={styles.mono}>{p.message || p.exception || ""}</Text>
                </View>
              ))}
            </View>
          </Card>
        )}

        {/* Config summary */}
        {diag && (
          <Card>
            <Text style={styles.section}>⚙️ Configuration</Text>
            <Text style={styles.txt}>Gateway actif : <Text style={styles.mono}>{diag.gateway_active}</Text></Text>
            <Text style={styles.txt}>Ashtech activé : <Text style={styles.mono}>{String(diag.ashtec_enabled)}</Text></Text>
            <Text style={styles.txt}>Clé configurée : <Text style={styles.mono}>{String(diag.api_key?.configured)} ({diag.api_key?.length} car)</Text></Text>
            <Text style={styles.txt}>
              Source de la clé : <Text style={[styles.mono, {
                color: diag.api_key?.source === "env" ? "#10B981" :
                       diag.api_key?.source === "db" ? "#F59E0B" : "#EF4444",
                fontWeight: "800",
              }]}>{diag.api_key?.source?.toUpperCase() || "MISSING"}</Text>
              {" "}(env: {String(diag.api_key?.env_var_set)} / db: {String(diag.api_key?.db_fallback_set)})
            </Text>
            <Text style={styles.txt}>Prefix clé : <Text style={styles.mono}>{diag.api_key?.prefix}</Text></Text>
            <Text style={styles.txt}>Webhook URL : <Text style={styles.mono}>{diag.webhook_url}</Text></Text>
          </Card>
        )}

        {/* Recent failures */}
        {diag?.recent_failures?.length > 0 && (
          <Card>
            <Text style={styles.section}>❌ Derniers échecs ({diag.recent_failures.length})</Text>
            {diag.recent_failures.map((f: any, i: number) => (
              <View key={i} style={{ paddingVertical: 8, borderBottomWidth: 1, borderColor: "#E2E8F0" }}>
                <Text style={styles.txt}>
                  <Text style={{ fontWeight: "800" }}>{f.reference}</Text> · {f.kind} · {f.amount} {f.currency}
                </Text>
                <Text style={styles.txt}>
                  {f.country_code} · {f.operator} · {f.phone}
                </Text>
                <Text style={[styles.mono, { color: "#EF4444", marginTop: 4 }]}>
                  HTTP {f.ashtecpay_status_code} → {f.activation_error}
                </Text>
              </View>
            ))}
          </Card>
        )}

        {diag && diag.recent_failures?.length === 0 && (
          <Card><Text style={styles.txt}>Aucun échec récent 🎉</Text></Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F1F5F9" },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: "#0F172A", padding: 14,
  },
  title: { color: "#fff", fontWeight: "900", fontSize: 16 },
  section: { fontSize: 15, fontWeight: "800", marginBottom: 8, color: theme.colors.textPrimary },
  subsection: { fontSize: 13, fontWeight: "700", color: theme.colors.textPrimary },
  txt: { fontSize: 12, color: theme.colors.textPrimary, lineHeight: 18 },
  mono: { fontSize: 11, fontFamily: "monospace" as any, color: theme.colors.textSecondary },
  err: { color: "#DC2626", padding: 12, fontSize: 12 },
});
