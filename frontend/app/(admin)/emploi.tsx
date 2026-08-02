import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, SafeAreaView, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme";
import { api, resolveMediaUrl } from "../../src/api";

/**
 * Admin — Emploi. Full CRUD panel:
 *   • List of every job (active + inactive).
 *   • Right-hand form: create OR edit (in-place — no separate page needed).
 *   • Toggle active flag & delete inline.
 *
 * Only admins can reach this route (guarded by /(admin)/_layout.tsx).
 */

type Job = {
  id: string;
  title: string;
  description: string;
  contact: string;
  country: string;
  salary: string | null;
  image_url: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type Country = { code: string; name: string; flag: string };

const EMPTY = {
  id: "",
  title: "",
  description: "",
  contact: "",
  country: "TG",
  salary: "",
  image_url: "",
  active: true,
};

export default function AdminEmploiScreen() {
  const router = useRouter();
  const [items, setItems] = useState<Job[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<typeof EMPTY>(EMPTY);
  const [editingId, setEditingId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>("");
  const [countryOpen, setCountryOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const [jobs, cfg] = await Promise.all([
        api.get<Job[]>("/admin/jobs"),
        api.get<{ countries: Country[] }>("/config", { auth: false } as any).catch(() => ({ countries: [] })),
      ]);
      setItems(Array.isArray(jobs) ? jobs : []);
      setCountries(Array.isArray(cfg?.countries) ? cfg.countries : []);
    } catch (e: any) {
      window.alert(e?.detail || "Impossible de charger les offres.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const resetForm = () => { setForm(EMPTY); setEditingId(""); setError(""); };

  const startEdit = (j: Job) => {
    setEditingId(j.id);
    setForm({
      id: j.id,
      title: j.title || "",
      description: j.description || "",
      contact: j.contact || "",
      country: j.country || "TG",
      salary: j.salary || "",
      image_url: j.image_url || "",
      active: !!j.active,
    });
    setError("");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const validate = (): string => {
    if (!form.title.trim()) return "Le titre est obligatoire.";
    if (!form.description.trim()) return "La description est obligatoire.";
    if (!form.contact.trim()) return "Le contact est obligatoire.";
    if (!form.country.trim()) return "Le pays est obligatoire.";
    return "";
  };

  const save = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    setSaving(true);
    setError("");
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description.trim(),
        contact: form.contact.trim(),
        country: form.country.trim().toUpperCase(),
        salary: form.salary.trim() || null,
        image_url: form.image_url.trim() || null,
        active: !!form.active,
      };
      if (editingId) {
        await api.put(`/admin/jobs/${editingId}`, payload);
      } else {
        await api.post("/admin/jobs", payload);
      }
      window.alert("✅ Offre publiée. Elle est immédiatement visible pour les utilisateurs.");
      resetForm();
      await load();
    } catch (e: any) {
      setError(e?.detail || "Échec de la sauvegarde.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (j: Job) => {
    if (!window.confirm(`Supprimer définitivement l'offre "${j.title}" ?`)) return;
    try {
      await api.delete(`/admin/jobs/${j.id}`);
      if (editingId === j.id) resetForm();
      await load();
    } catch (e: any) {
      window.alert(e?.detail || "Suppression impossible.");
    }
  };

  const toggle = async (j: Job) => {
    try {
      await api.post(`/admin/jobs/${j.id}/toggle`);
      await load();
    } catch (e: any) {
      window.alert(e?.detail || "Impossible de changer l'état.");
    }
  };

  const pickImage = () => { fileInput.current?.click(); };
  const onFile = async (files: FileList | null) => {
    if (!files || !files[0]) return;
    setUploading(true);
    try {
      const r = await api.upload<{ url: string }>("/admin/uploads", files[0]);
      setForm((f) => ({ ...f, image_url: r.url }));
    } catch (e: any) {
      window.alert(`❌ Upload : ${e?.detail || "échec"}`);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const countryLabel = useMemo(() => {
    const c = countries.find((x) => x.code === form.country);
    return c ? `${c.flag} ${c.name}` : form.country;
  }, [countries, form.country]);

  const renderJob = ({ item }: { item: Job }) => {
    const isEditing = item.id === editingId;
    const country = countries.find((c) => c.code === item.country);
    return (
      <View style={[styles.jobCard, isEditing && styles.jobCardActive]} testID={`admin-job-${item.id}`}>
        <View style={{ flexDirection: "row", gap: 10 }}>
          {item.image_url ? (
            <Image source={{ uri: resolveMediaUrl(item.image_url) }} style={styles.thumb} />
          ) : (
            <View style={[styles.thumb, styles.thumbEmpty]}>
              <Ionicons name="briefcase" size={22} color={theme.colors.textSecondary} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <Text style={styles.jobTitle} numberOfLines={2}>{item.title}</Text>
              <View style={[styles.statusPill, { backgroundColor: item.active ? "#10B98122" : "#EF444422" }]}>
                <Text style={[styles.statusPillT, { color: item.active ? "#059669" : "#DC2626" }]}>
                  {item.active ? "ACTIVE" : "INACTIVE"}
                </Text>
              </View>
            </View>
            <Text style={styles.jobMeta}>
              {country ? `${country.flag} ${country.name}` : item.country}
              {item.salary ? ` · 💰 ${item.salary}` : ""}
            </Text>
            <Text style={styles.jobMeta} numberOfLines={1}>📞 {item.contact}</Text>
            <Text style={styles.jobDesc} numberOfLines={3}>{item.description}</Text>
          </View>
        </View>
        <View style={styles.actionRow}>
          <TouchableOpacity style={[styles.aBtn, { backgroundColor: theme.colors.primary }]} onPress={() => startEdit(item)} testID={`admin-job-edit-${item.id}`}>
            <Ionicons name="create" size={14} color="#fff" />
            <Text style={styles.aBtnT}>Modifier</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.aBtn, { backgroundColor: item.active ? "#F59E0B" : "#10B981" }]}
            onPress={() => toggle(item)}
            testID={`admin-job-toggle-${item.id}`}
          >
            <Ionicons name={item.active ? "eye-off" : "eye"} size={14} color="#fff" />
            <Text style={styles.aBtnT}>{item.active ? "Désactiver" : "Réactiver"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.aBtn, { backgroundColor: theme.colors.danger }]} onPress={() => remove(item)} testID={`admin-job-delete-${item.id}`}>
            <Ionicons name="trash" size={14} color="#fff" />
            <Text style={styles.aBtnT}>Supprimer</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.replace("/(admin)" as any)} style={styles.backBtn} testID="admin-emploi-back">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.htitle}>💼 Gestion des offres d'emploi</Text>
          <Text style={styles.hsub}>{items.length} offre{items.length > 1 ? "s" : ""} au total</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 40 }}>
        {/* ---- Form ---- */}
        <View style={styles.formCard} testID="admin-emploi-form">
          <Text style={styles.section}>
            {editingId ? "✏️ Modifier l'offre" : "📝 Publier une nouvelle offre"}
          </Text>

          <Text style={styles.lbl}>Titre de l'offre <Text style={styles.req}>*</Text></Text>
          <TextInput
            value={form.title}
            onChangeText={(t) => setForm((f) => ({ ...f, title: t }))}
            style={styles.input}
            placeholder="Ex. Développeur Web"
            testID="admin-emploi-title"
          />

          <Text style={styles.lbl}>Description complète <Text style={styles.req}>*</Text></Text>
          <TextInput
            value={form.description}
            onChangeText={(t) => setForm((f) => ({ ...f, description: t }))}
            style={[styles.input, styles.textarea]}
            placeholder="Missions, compétences, horaires, avantages…"
            multiline
            testID="admin-emploi-description"
          />

          <Text style={styles.lbl}>Contact (téléphone, e-mail ou lien) <Text style={styles.req}>*</Text></Text>
          <TextInput
            value={form.contact}
            onChangeText={(t) => setForm((f) => ({ ...f, contact: t }))}
            style={styles.input}
            placeholder="+228 90 00 00 00 · jobs@company.com · https://wa.me/…"
            testID="admin-emploi-contact"
          />

          <Text style={styles.lbl}>Pays <Text style={styles.req}>*</Text></Text>
          <TouchableOpacity
            style={[styles.input, styles.dropdown]}
            onPress={() => setCountryOpen((v) => !v)}
            testID="admin-emploi-country"
          >
            <Text style={styles.dropdownT}>{countryLabel}</Text>
            <Ionicons name={countryOpen ? "chevron-up" : "chevron-down"} size={16} color={theme.colors.textSecondary} />
          </TouchableOpacity>
          {countryOpen ? (
            <View style={styles.dropdownList}>
              <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
                {countries.map((c) => (
                  <TouchableOpacity
                    key={c.code}
                    style={[styles.dropdownItem, form.country === c.code && styles.dropdownItemOn]}
                    onPress={() => { setForm((f) => ({ ...f, country: c.code })); setCountryOpen(false); }}
                    testID={`admin-emploi-country-${c.code}`}
                  >
                    <Text style={styles.dropdownItemT}>{c.flag} {c.name} ({c.code})</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          ) : null}

          <Text style={styles.lbl}>Salaire (facultatif)</Text>
          <TextInput
            value={form.salary}
            onChangeText={(t) => setForm((f) => ({ ...f, salary: t }))}
            style={styles.input}
            placeholder="Ex. 150 000 FCFA / mois — ou une fourchette"
            testID="admin-emploi-salary"
          />

          <Text style={styles.lbl}>Image (facultatif)</Text>
          {form.image_url ? (
            <View style={styles.imgPreviewWrap}>
              <Image source={{ uri: resolveMediaUrl(form.image_url) }} style={styles.imgPreview} />
              <TouchableOpacity
                style={styles.imgRemove}
                onPress={() => setForm((f) => ({ ...f, image_url: "" }))}
                testID="admin-emploi-image-remove"
              >
                <Ionicons name="close" size={14} color="#fff" />
              </TouchableOpacity>
            </View>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
            <TouchableOpacity
              style={[styles.uploadBtn, uploading && { opacity: 0.7 }]}
              onPress={pickImage}
              disabled={uploading}
              testID="admin-emploi-image-upload"
            >
              {uploading ? <ActivityIndicator color="#fff" /> : <Ionicons name="cloud-upload" size={16} color="#fff" />}
              <Text style={styles.uploadBtnT}>{uploading ? "Envoi…" : (form.image_url ? "Changer l'image" : "Téléverser une image")}</Text>
            </TouchableOpacity>
          </View>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e: any) => onFile(e.target.files)}
          />
          <TextInput
            value={form.image_url}
            onChangeText={(t) => setForm((f) => ({ ...f, image_url: t }))}
            style={[styles.input, { marginTop: 6, fontSize: 11, color: theme.colors.textSecondary }]}
            placeholder="… ou collez une URL d'image directement"
            autoCapitalize="none"
            testID="admin-emploi-image-url"
          />

          <View style={styles.switchRow}>
            <TouchableOpacity
              style={styles.switchTouch}
              onPress={() => setForm((f) => ({ ...f, active: !f.active }))}
              testID="admin-emploi-active-toggle"
            >
              <View style={[styles.switch, form.active && styles.switchOn]}>
                <View style={[styles.switchDot, form.active && styles.switchDotOn]} />
              </View>
              <Text style={styles.switchLbl}>{form.active ? "Offre active (visible)" : "Offre désactivée (masquée)"}</Text>
            </TouchableOpacity>
          </View>

          {error ? <Text style={styles.err} testID="admin-emploi-error">⚠️ {error}</Text> : null}

          <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
            <TouchableOpacity
              style={[styles.saveBtn, saving && { opacity: 0.7 }]}
              onPress={save}
              disabled={saving}
              testID="admin-emploi-submit"
            >
              {saving ? <ActivityIndicator color="#fff" /> : <Ionicons name="rocket" size={16} color="#fff" />}
              <Text style={styles.saveBtnT}>{editingId ? "Enregistrer les modifications" : "Publier l'offre"}</Text>
            </TouchableOpacity>
            {editingId ? (
              <TouchableOpacity style={styles.cancelBtn} onPress={resetForm} testID="admin-emploi-cancel">
                <Text style={styles.cancelBtnT}>Annuler</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {/* ---- List ---- */}
        <Text style={styles.listTitle}>📋 Offres publiées</Text>
        {loading ? (
          <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 20 }} />
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="briefcase-outline" size={40} color={theme.colors.textSecondary} />
            <Text style={styles.emptyT}>Aucune offre pour l'instant</Text>
            <Text style={styles.emptyS}>Remplissez le formulaire ci-dessus pour publier la première offre.</Text>
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(i) => i.id}
            renderItem={renderJob}
            scrollEnabled={false}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, backgroundColor: theme.colors.primary },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  htitle: { color: "#fff", fontWeight: "900", fontSize: 17 },
  hsub: { color: "rgba(255,255,255,0.9)", fontSize: 11, fontWeight: "600", marginTop: 2 },

  formCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  section: { fontSize: 15, fontWeight: "900", color: theme.colors.textPrimary, marginBottom: 12 },
  lbl: { fontSize: 12, fontWeight: "800", color: theme.colors.textPrimary, marginTop: 10, marginBottom: 4 },
  req: { color: theme.colors.danger },
  input: {
    backgroundColor: theme.colors.background,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 13,
    color: theme.colors.textPrimary,
  },
  textarea: { minHeight: 130, textAlignVertical: "top" },
  dropdown: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  dropdownT: { fontSize: 13, color: theme.colors.textPrimary },
  dropdownList: {
    marginTop: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  dropdownItem: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  dropdownItemOn: { backgroundColor: "#EEF2FF" },
  dropdownItemT: { fontSize: 12, color: theme.colors.textPrimary },
  imgPreviewWrap: { marginTop: 6, position: "relative", alignSelf: "flex-start" },
  imgPreview: { width: 140, height: 100, borderRadius: 8 },
  imgRemove: {
    position: "absolute", top: -6, right: -6,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: theme.colors.danger,
    alignItems: "center", justifyContent: "center",
  },
  uploadBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8,
  },
  uploadBtnT: { color: "#fff", fontWeight: "800", fontSize: 12 },

  switchRow: { marginTop: 12, flexDirection: "row", alignItems: "center" },
  switchTouch: { flexDirection: "row", alignItems: "center", gap: 8 },
  switch: {
    width: 42, height: 24, borderRadius: 12,
    backgroundColor: theme.colors.border,
    padding: 2, justifyContent: "center",
  },
  switchOn: { backgroundColor: "#10B981" },
  switchDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff" },
  switchDotOn: { transform: [{ translateX: 18 }] },
  switchLbl: { fontSize: 12, fontWeight: "700", color: theme.colors.textPrimary },

  err: { marginTop: 10, color: theme.colors.danger, fontSize: 12, fontWeight: "700" },
  saveBtn: {
    flex: 1,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.colors.primary,
    paddingVertical: 12, borderRadius: 10,
  },
  saveBtnT: { color: "#fff", fontWeight: "900", fontSize: 13 },
  cancelBtn: {
    paddingHorizontal: 16, paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  cancelBtnT: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 12 },

  listTitle: { fontSize: 14, fontWeight: "900", color: theme.colors.textPrimary, marginBottom: 8, marginTop: 4 },
  empty: { alignItems: "center", padding: 30 },
  emptyT: { fontWeight: "800", marginTop: 10, color: theme.colors.textPrimary },
  emptyS: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 4, textAlign: "center" },

  jobCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  jobCardActive: { borderColor: theme.colors.primary, borderWidth: 2 },
  thumb: { width: 60, height: 60, borderRadius: 8, backgroundColor: "#EEF2FF" },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },
  jobTitle: { fontSize: 14, fontWeight: "900", color: theme.colors.textPrimary, flex: 1 },
  statusPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  statusPillT: { fontSize: 9, fontWeight: "900" },
  jobMeta: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 2 },
  jobDesc: { fontSize: 11, color: theme.colors.textPrimary, marginTop: 4, lineHeight: 15 },
  actionRow: { flexDirection: "row", gap: 6, marginTop: 10, flexWrap: "wrap" },
  aBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 7, borderRadius: 6,
  },
  aBtnT: { color: "#fff", fontWeight: "800", fontSize: 11 },
});
