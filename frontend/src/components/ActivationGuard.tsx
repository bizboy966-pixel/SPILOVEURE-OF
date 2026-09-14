/**
 * ActivationGuard — centralised access control for "protected" actions.
 *
 * Post-refactor v16 : a pending user can now browse the entire platform
 * without being redirected. The activation modal only pops when the user
 * tries to run a protected action (retrait, publier une annonce, etc.).
 *
 * Usage :
 *   1) Wrap `<AppLayout>` with `<ActivationProvider>`.
 *   2) Any component can call the hook:
 *        const { isActive, guardAction, showModal } = useActivationGuard();
 *      Then wrap the sensitive callback:
 *        onPress={() => guardAction(() => router.push("/(app)/withdrawal"))}
 *      or explicitly:
 *        if (!isActive) return showModal();
 *
 * Exceptions listed by the product spec (Dépôt, Envoyer, Échange, Tâches
 * participate) MUST NOT be wrapped — they stay accessible while pending.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { useAuth } from "@/src/auth";
import { setActivationRequiredHandler } from "@/src/api";

type Ctx = {
  isActive: boolean;
  isPending: boolean;
  guardAction: (fn: () => void) => void;
  showModal: (reason?: string) => void;
  hideModal: () => void;
};

const ActivationCtx = createContext<Ctx>({
  isActive: false,
  isPending: true,
  guardAction: () => {},
  showModal: () => {},
  hideModal: () => {},
});

export function useActivationGuard() {
  return useContext(ActivationCtx);
}

export const ActivationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | undefined>(undefined);

  // Same rule as the layout guard : a user is fully active if EITHER of
  // the two activation markers is set. Both must be at their initial
  // values (pending + max_level=0) to be considered pending.
  const isPending = !user || (user.status === "pending" && (user.max_level || 0) === 0);
  const isActive = !isPending;

  const showModal = useCallback((r?: string) => {
    setReason(r);
    setOpen(true);
  }, []);
  const hideModal = useCallback(() => setOpen(false), []);

  // v23 (2026-02-14) — wire the global 403 ACTIVATION_REQUIRED interceptor.
  // Any protected backend endpoint (POST /ads, /marketplace, /special-tasks,
  // /me/mission-withdrawals, /withdrawals, /ads/{id}/comment...) that
  // rejects a pending user opens the modal automatically, no matter which
  // screen fired the request.
  useEffect(() => {
    setActivationRequiredHandler(() => setOpen(true));
    return () => setActivationRequiredHandler(null);
  }, []);

  const guardAction = useCallback(
    (fn: () => void) => {
      if (isActive) { fn(); return; }
      setReason(undefined);
      setOpen(true);
    },
    [isActive]
  );

  const value = useMemo<Ctx>(() => ({
    isActive, isPending, guardAction, showModal, hideModal,
  }), [isActive, isPending, guardAction, showModal, hideModal]);

  const goToPay = () => {
    setOpen(false);
    router.push("/(app)/pay" as any);
  };

  return (
    <ActivationCtx.Provider value={value}>
      {children}
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={hideModal}
      >
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={hideModal}
        />
        <View style={styles.sheetWrap} pointerEvents="box-none">
          <View style={styles.sheet} testID="activation-required-modal">
            <View style={styles.iconCircle}>
              <Ionicons name="shield-checkmark" size={40} color="#F59E0B" />
            </View>
            <Text style={styles.title}>Compte non activé</Text>
            <Text style={styles.body}>
              {reason ||
                "Activez votre compte pour effectuer cette action. Vous accéderez à toutes les fonctionnalités de SPILOVEURE."}
            </Text>

            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={goToPay}
              testID="activation-required-primary"
              activeOpacity={0.88}
            >
              <Ionicons name="flash" size={16} color="#fff" />
              <Text style={styles.primaryBtnTxt}>Activer mon compte</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={hideModal}
              testID="activation-required-close"
              activeOpacity={0.88}
            >
              <Text style={styles.secondaryBtnTxt}>Plus tard</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ActivationCtx.Provider>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(11,45,111,0.55)",
  },
  sheetWrap: {
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderRadius: 22,
    padding: 24,
    alignItems: "center",
    shadowColor: "#0B2D6F",
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.28,
    shadowRadius: 40,
    elevation: 12,
  },
  iconCircle: {
    width: 78, height: 78, borderRadius: 39,
    backgroundColor: "#FEF3C7",
    alignItems: "center", justifyContent: "center",
    borderWidth: 6, borderColor: "#FFFBEB",
    marginBottom: 14,
  },
  title: {
    fontSize: 20, fontWeight: "900",
    color: theme.colors.textPrimary,
    letterSpacing: -0.3,
    marginBottom: 8,
  },
  body: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: 20,
  },
  primaryBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 24, paddingVertical: 14,
    borderRadius: 14,
    alignSelf: "stretch",
    ...theme.shadow.button,
  },
  primaryBtnTxt: { color: "#fff", fontWeight: "900", fontSize: 14, letterSpacing: 0.3 },
  secondaryBtn: {
    paddingVertical: 12,
    alignSelf: "stretch",
    alignItems: "center",
    marginTop: 4,
  },
  secondaryBtnTxt: {
    color: theme.colors.textSecondary,
    fontWeight: "700",
    fontSize: 13,
  },
});

export default ActivationProvider;
