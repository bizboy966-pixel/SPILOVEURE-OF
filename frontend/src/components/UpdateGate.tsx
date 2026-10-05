import React, { useEffect, useState, useCallback } from "react";
import { View, Text, TouchableOpacity, Modal, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CLIENT_VERSION } from "../version";
import { api } from "../api";
import { theme } from "../theme";

type Check = {
  client_version: string | null;
  current_version: string;
  minimum_supported_version: string;
  update_available: boolean;
  update_required: boolean;
};

// SPILOVEURE — v27aj : blocking update modal.
// Mounted at the root of (app)/_layout. Polls /api/app/version/check every
// 60s. If backend says the client is below `minimum_supported_version` AND
// `mandatory=true`, shows a non-dismissible modal — the user MUST reload
// to continue. Non-mandatory updates show a dismissible banner (future).
export function UpdateGate({ children }: { children: React.ReactNode }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [reloading, setReloading] = useState(false);

  const fetchCheck = useCallback(async () => {
    try {
      const r = await api.get<Check>(`/app/version/check?client_version=${encodeURIComponent(CLIENT_VERSION)}`);
      setCheck(r);
    } catch {
      /* silent — don't block the app on a transient /version call failure */
    }
  }, []);

  useEffect(() => {
    fetchCheck();
    const t = setInterval(fetchCheck, 60000);
    return () => clearInterval(t);
  }, [fetchCheck]);

  const doReload = useCallback(() => {
    setReloading(true);
    try {
      if (typeof window !== "undefined") {
        // Hard reload — bypasses the SPA router so a new bundle is fetched.
        window.location.reload();
      }
    } catch {
      setReloading(false);
    }
  }, []);

  const blocking = !!(check?.update_required);

  return (
    <>
      {children}
      <Modal
        visible={blocking}
        transparent
        animationType="fade"
        onRequestClose={() => { /* non-dismissible */ }}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.75)",
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 24,
          }}
          testID="update-gate-overlay"
        >
          <View
            style={{
              backgroundColor: theme.colors.surface,
              borderRadius: 20,
              padding: 24,
              maxWidth: 420,
              width: "100%",
              shadowColor: "#000",
              shadowOpacity: 0.3,
              shadowRadius: 20,
            }}
          >
            <View style={{ alignItems: "center", marginBottom: 16 }}>
              <View
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 32,
                  backgroundColor: "#DBEAFE",
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: 12,
                }}
              >
                <Ionicons name="rocket" size={32} color="#1E40AF" />
              </View>
              <Text style={{ fontSize: 20, fontWeight: "800", color: theme.colors.textPrimary, textAlign: "center" }}>
                🚀 Nouvelle mise à jour disponible
              </Text>
            </View>
            <Text style={{ fontSize: 14, color: theme.colors.textSecondary, textAlign: "center", marginBottom: 16, lineHeight: 20 }}>
              Une nouvelle version de SPILOVEURE est disponible. Veuillez mettre à jour pour continuer à utiliser la plateforme.
            </Text>
            <View style={{ backgroundColor: theme.colors.surfaceSecondary, borderRadius: 12, padding: 14, marginBottom: 18 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Version actuelle</Text>
                <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: "700" }}>
                  {check?.client_version || CLIENT_VERSION}
                </Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Nouvelle version</Text>
                <Text style={{ color: "#059669", fontSize: 13, fontWeight: "800" }}>
                  {check?.current_version || "—"}
                </Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={doReload}
              disabled={reloading}
              testID="update-gate-reload"
              style={{
                backgroundColor: "#1E40AF",
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: "center",
                flexDirection: "row",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {reloading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons name="refresh" size={18} color="#fff" />
                  <Text style={{ color: "#fff", fontSize: 15, fontWeight: "800" }}>
                    Mettre à jour maintenant
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}
