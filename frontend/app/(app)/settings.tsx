import React, { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View, TouchableOpacity, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { Input } from "@/src/components/Input";
import { Button } from "@/src/components/Button";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";

export default function Settings() {
  const router = useRouter();
  const { user, refresh, signOut } = useAuth();
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [newPwd2, setNewPwd2] = useState("");
  const [phone, setPhone] = useState(user?.phone || "");
  const [email, setEmail] = useState(user?.email || "");
  const [loadingPwd, setLoadingPwd] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);

  const changePwd = async () => {
    if (newPwd !== newPwd2) return Alert.alert("Erreur", "Les mots de passe ne correspondent pas.");
    setLoadingPwd(true);
    try {
      await api.post("/auth/change-password", { current_password: oldPwd, new_password: newPwd, new_password_confirm: newPwd2 });
      Alert.alert("✅", "Mot de passe modifié.");
      setOldPwd(""); setNewPwd(""); setNewPwd2("");
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Erreur");
    } finally {
      setLoadingPwd(false);
    }
  };

  const saveProfile = async () => {
    setLoadingProfile(true);
    try {
      await api.post("/auth/update-profile", { phone, email });
      Alert.alert("✅", "Profil mis à jour.");
      await refresh();
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Erreur");
    } finally {
      setLoadingProfile(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Paramètres</Text>
      </LinearGradient>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Card>
          <Text style={styles.section}>Modifier les informations</Text>
          <Input label="E-mail" icon="mail-outline" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" testID="settings-email" />
          <Input label="Téléphone" icon="call-outline" value={phone} onChangeText={setPhone} keyboardType="phone-pad" testID="settings-phone" />
          <Button title="Enregistrer" onPress={saveProfile} loading={loadingProfile} testID="settings-save-profile" />
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Modifier le mot de passe</Text>
          <Input label="Ancien mot de passe" icon="lock-closed-outline" secureTextEntry value={oldPwd} onChangeText={setOldPwd} testID="settings-old-pwd" />
          <Input label="Nouveau mot de passe" icon="lock-closed-outline" secureTextEntry value={newPwd} onChangeText={setNewPwd} testID="settings-new-pwd" />
          <Input label="Confirmer le mot de passe" icon="lock-closed-outline" secureTextEntry value={newPwd2} onChangeText={setNewPwd2} testID="settings-new-pwd-2" />
          <Button title="Changer le mot de passe" onPress={changePwd} loading={loadingPwd} testID="settings-change-pwd" />
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Portefeuille de retrait</Text>
          <Text style={{ color: theme.colors.textSecondary, marginBottom: 8 }}>
            Configurez le compte Mobile Money sur lequel vous recevrez vos retraits.
          </Text>
          <Button title="Gérer mon portefeuille" variant="outline" onPress={() => router.push("/(app)/wallet")} testID="settings-wallet" />
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Support</Text>
          <SupportRow icon="logo-whatsapp" label="WhatsApp" url="https://wa.me/22890000000" color="#25D366" />
          <SupportRow icon="paper-plane" label="Telegram" url="https://t.me/spiloveure" color="#26A5E4" />
          <SupportRow icon="mail" label="E-mail" url="mailto:support@spiloveure.com" color={theme.colors.primary} />
        </Card>

        <TouchableOpacity style={styles.dangerBtn} onPress={async () => { await signOut(); router.replace("/(auth)/login"); }} testID="settings-signout">
          <Ionicons name="log-out-outline" size={20} color={theme.colors.danger} />
          <Text style={styles.dangerBtnT}>Se déconnecter</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function SupportRow({ icon, label, url, color }: { icon: any; label: string; url: string; color: string }) {
  return (
    <TouchableOpacity style={styles.supportRow} onPress={() => Linking.openURL(url)}>
      <View style={[styles.supportIcon, { backgroundColor: `${color}20` }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <Text style={styles.supportLbl}>{label}</Text>
      <Ionicons name="open-outline" size={18} color={theme.colors.textSecondary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, paddingBottom: 20 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  title: { color: "#fff", fontSize: 24, fontWeight: "800" },
  section: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 12 },
  supportRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  supportIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  supportLbl: { flex: 1, fontWeight: "600", color: theme.colors.textPrimary },
  dangerBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 24, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.danger },
  dangerBtnT: { color: theme.colors.danger, fontWeight: "800" },
});
