/**
 * Admin content management — Formations, E-Books, Premium Apps, Trading.
 *
 * URL-based content: admin pastes external URLs (Google Drive, YouTube, CDN).
 * Each item is creatable / editable / deletable / enable-toggleable.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ScrollView, StyleSheet, Text, View, TextInput, TouchableOpacity, Switch,
  Image, ActivityIndicator, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api, resolveMediaUrl } from "@/src/api";
import { theme } from "@/src/theme";
import { MediaUploader } from "@/src/components/MediaUploader";

type SectionKey = "formations" | "ebooks" | "premium" | "trading";

const SECTIONS: { key: SectionKey; icon: keyof typeof Ionicons.glyphMap; label: string }[] = [
  { key: "formations", icon: "school", label: "Formations" },
  { key: "ebooks", icon: "book", label: "E-Books" },
  { key: "premium", icon: "diamond", label: "Apps Premium" },
  { key: "trading", icon: "trending-up", label: "Trading" },
];

function confirmWeb(msg: string) {
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return window.confirm(msg);
  }
  return false;
}

export default function AdminContent() {
  const router = useRouter();
  const [tab, setTab] = useState<SectionKey>("formations");

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <View style={styles.headerTop}>
          <TouchableOpacity onPress={() => router.back()} style={styles.back} testID="back-btn">
            <Ionicons name="chevron-back" size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Gestion des contenus</Text>
        </View>
        <Text style={styles.headerSub}>Formations, e-books, apps premium et trading — visibles côté utilisateur dès qu'ils sont activés.</Text>
      </LinearGradient>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {SECTIONS.map((s) => {
          const on = tab === s.key;
          return (
            <TouchableOpacity
              key={s.key}
              style={[styles.tab, on && styles.tabOn]}
              onPress={() => setTab(s.key)}
              testID={`content-tab-${s.key}`}
            >
              <Ionicons name={s.icon} size={16} color={on ? "#fff" : theme.colors.primary} />
              <Text style={[styles.tabTxt, on && { color: "#fff" }]}>{s.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 80 }}>
        {tab === "formations" && <FormationsCrud />}
        {tab === "ebooks" && <EbooksCrud />}
        {tab === "premium" && <PremiumAppsCrud />}
        {tab === "trading" && <TradingCrud />}
      </ScrollView>
    </SafeAreaView>
  );
}

// ============================================================================
// Shared UI helpers
// ============================================================================
function Field({
  label, value, onChangeText, placeholder, multiline, testID, keyboardType,
}: {
  label: string; value: string; onChangeText: (v: string) => void; placeholder?: string;
  multiline?: boolean; testID?: string; keyboardType?: "default" | "url";
}) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={styles.lbl}>{label}</Text>
      <TextInput
        value={value} onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textSecondary}
        multiline={multiline}
        autoCapitalize={keyboardType === "url" ? "none" : "sentences"}
        keyboardType={keyboardType === "url" ? "url" : "default"}
        style={[styles.input, multiline && styles.inputMultiline]}
        testID={testID}
      />
    </View>
  );
}

function EnabledRow({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.toggleRow}>
      <View>
        <Text style={styles.lbl}>Statut</Text>
        <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>
          {value ? "Visible côté utilisateur ✅" : "Masqué côté utilisateur ❌"}
        </Text>
      </View>
      <Switch
        value={value} onValueChange={onChange}
        trackColor={{ true: theme.colors.success, false: theme.colors.border }}
        thumbColor="#fff"
      />
    </View>
  );
}

function ListEmpty({ icon, label }: { icon: keyof typeof Ionicons.glyphMap; label: string }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={36} color={theme.colors.textSecondary} />
      <Text style={styles.emptyTxt}>{label}</Text>
    </View>
  );
}

// ============================================================================
// FORMATIONS CRUD
// ============================================================================
type Formation = {
  id: string;
  title: string; description: string;
  image_url: string; video_url: string; pdf_url: string; audio_url: string;
  category: string; enabled: boolean; order: number;
};

function FormationsCrud() {
  const [items, setItems] = useState<Formation[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Formation | null>(null);
  const [open, setOpen] = useState(false);

  const empty: Formation = useMemo(() => ({
    id: "", title: "", description: "", image_url: "", video_url: "",
    pdf_url: "", audio_url: "", category: "", enabled: true, order: 0,
  }), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<Formation[]>("/admin/formations");
      setItems(Array.isArray(r) ? r : []);
    } catch { setItems([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!editing) return;
    if (!editing.title.trim()) {
      Alert.alert("Champs requis", "Le titre est obligatoire.");
      return;
    }
    try {
      if (editing.id) {
        await api.put(`/admin/formations/${editing.id}`, editing);
      } else {
        await api.post("/admin/formations", editing);
      }
      setOpen(false); setEditing(null);
      await load();
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Sauvegarde impossible");
    }
  };

  const remove = async (id: string) => {
    if (!confirmWeb("Supprimer cette formation ?")) return;
    try {
      await api.delete(`/admin/formations/${id}`);
      await load();
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Suppression impossible");
    }
  };

  const toggle = async (it: Formation) => {
    try {
      await api.put(`/admin/formations/${it.id}`, { ...it, enabled: !it.enabled });
      await load();
    } catch {}
  };

  return (
    <View>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Bibliothèque de formations ({items.length})</Text>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => { setEditing({ ...empty }); setOpen(true); }}
          testID="add-formation-btn"
        >
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.addBtnTxt}>Ajouter</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={theme.colors.primary} />
      ) : items.length === 0 ? (
        <ListEmpty icon="school" label="Aucune formation. Cliquez sur Ajouter pour créer la première." />
      ) : (
        items.map((it) => (
          <View key={it.id} style={styles.itemCard}>
            <View style={{ flexDirection: "row", gap: 10 }}>
              {it.image_url ? (
                <Image source={{ uri: resolveMediaUrl(it.image_url) }} style={styles.thumb} />
              ) : (
                <View style={[styles.thumb, styles.thumbPh]}><Ionicons name="school" size={24} color={theme.colors.primary} /></View>
              )}
              <View style={{ flex: 1 }}>
                <View style={styles.titleRow}>
                  <Text style={styles.itemTitle}>{it.title}</Text>
                  <View style={[styles.statusDot, { backgroundColor: it.enabled ? theme.colors.success : theme.colors.border }]} />
                </View>
                {it.category ? <Text style={styles.category}>{it.category.toUpperCase()}</Text> : null}
                {it.description ? <Text style={styles.itemBody} numberOfLines={2}>{it.description}</Text> : null}
                <View style={styles.linksRow}>
                  {it.video_url ? <Mini icon="videocam" /> : null}
                  {it.pdf_url ? <Mini icon="document-text" /> : null}
                  {it.audio_url ? <Mini icon="headset" /> : null}
                </View>
              </View>
            </View>
            <View style={styles.itemActions}>
              <TouchableOpacity style={styles.act} onPress={() => toggle(it)} testID={`toggle-formation-${it.id}`}>
                <Ionicons name={it.enabled ? "eye-off" : "eye"} size={16} color={theme.colors.primary} />
                <Text style={styles.actTxt}>{it.enabled ? "Désactiver" : "Activer"}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.act} onPress={() => { setEditing(it); setOpen(true); }} testID={`edit-formation-${it.id}`}>
                <Ionicons name="create" size={16} color={theme.colors.primary} />
                <Text style={styles.actTxt}>Modifier</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.act, styles.actDanger]} onPress={() => remove(it.id)} testID={`delete-formation-${it.id}`}>
                <Ionicons name="trash" size={16} color={theme.colors.danger} />
                <Text style={[styles.actTxt, { color: theme.colors.danger }]}>Supprimer</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))
      )}

      {open && editing && (
        <View style={styles.formCard}>
          <Text style={styles.formTitle}>{editing.id ? "Modifier la formation" : "Nouvelle formation"}</Text>
          <Field label="Titre" value={editing.title} onChangeText={(v) => setEditing({ ...editing, title: v })} testID="formation-title" />
          <Field label="Description" value={editing.description} onChangeText={(v) => setEditing({ ...editing, description: v })} multiline testID="formation-desc" />
          <Field label="Catégorie" value={editing.category} onChangeText={(v) => setEditing({ ...editing, category: v })} placeholder="Ex: Trading, Marketing..." />
          <Field label="Image de couverture (URL)" value={editing.image_url} onChangeText={(v) => setEditing({ ...editing, image_url: v })} placeholder="https://..." keyboardType="url" />
          <MediaUploader kind="image" url={editing.image_url} onChange={(u) => setEditing({ ...editing, image_url: u })} testID="formation-image-upload" />
          <Field label="Vidéo (URL YouTube ou autre)" value={editing.video_url} onChangeText={(v) => setEditing({ ...editing, video_url: v })} placeholder="https://..." keyboardType="url" />
          <MediaUploader kind="video" url={editing.video_url} onChange={(u) => setEditing({ ...editing, video_url: u })} testID="formation-video-upload" />
          <Field label="PDF (URL)" value={editing.pdf_url} onChangeText={(v) => setEditing({ ...editing, pdf_url: v })} placeholder="https://..." keyboardType="url" />
          <MediaUploader kind="pdf" url={editing.pdf_url} onChange={(u) => setEditing({ ...editing, pdf_url: u })} testID="formation-pdf-upload" />
          <Field label="Audio (URL)" value={editing.audio_url} onChangeText={(v) => setEditing({ ...editing, audio_url: v })} placeholder="https://..." keyboardType="url" />
          <MediaUploader kind="audio" url={editing.audio_url} onChange={(u) => setEditing({ ...editing, audio_url: u })} testID="formation-audio-upload" />
          <EnabledRow value={editing.enabled} onChange={(v) => setEditing({ ...editing, enabled: v })} />
          <View style={styles.formActions}>
            <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => { setOpen(false); setEditing(null); }}>
              <Text style={styles.btnGhostTxt}>Annuler</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={save} testID="save-formation-btn">
              <Ionicons name="save" size={16} color="#fff" />
              <Text style={styles.btnPrimaryTxt}>Enregistrer</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// ============================================================================
// E-BOOKS CRUD
// ============================================================================
type Ebook = { id: string; title: string; description: string; image_url: string; pdf_url: string; enabled: boolean; order: number };

function EbooksCrud() {
  const [items, setItems] = useState<Ebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Ebook | null>(null);
  const [open, setOpen] = useState(false);
  const empty: Ebook = { id: "", title: "", description: "", image_url: "", pdf_url: "", enabled: true, order: 0 };

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await api.get<Ebook[]>("/admin/ebooks"); setItems(Array.isArray(r) ? r : []); }
    catch { setItems([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!editing || !editing.title.trim()) { Alert.alert("Champs requis", "Le titre est obligatoire."); return; }
    try {
      if (editing.id) await api.put(`/admin/ebooks/${editing.id}`, editing);
      else await api.post("/admin/ebooks", editing);
      setOpen(false); setEditing(null); await load();
    } catch (e: any) { Alert.alert("Erreur", e?.detail || "Sauvegarde impossible"); }
  };
  const remove = async (id: string) => {
    if (!confirmWeb("Supprimer cet e-book ?")) return;
    try { await api.delete(`/admin/ebooks/${id}`); await load(); }
    catch (e: any) { Alert.alert("Erreur", e?.detail || "Suppression impossible"); }
  };
  const toggle = async (it: Ebook) => {
    try { await api.put(`/admin/ebooks/${it.id}`, { ...it, enabled: !it.enabled }); await load(); } catch {}
  };

  return (
    <View>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Bibliothèque d'e-books ({items.length})</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => { setEditing({ ...empty }); setOpen(true); }} testID="add-ebook-btn">
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.addBtnTxt}>Ajouter</Text>
        </TouchableOpacity>
      </View>
      {loading ? <ActivityIndicator color={theme.colors.primary} />
        : items.length === 0 ? <ListEmpty icon="book" label="Aucun e-book. Cliquez sur Ajouter." />
        : items.map((it) => (
          <View key={it.id} style={styles.itemCard}>
            <View style={{ flexDirection: "row", gap: 10 }}>
              {it.image_url ? <Image source={{ uri: it.image_url }} style={styles.thumb} /> : <View style={[styles.thumb, styles.thumbPh]}><Ionicons name="book" size={24} color={theme.colors.primary} /></View>}
              <View style={{ flex: 1 }}>
                <View style={styles.titleRow}>
                  <Text style={styles.itemTitle}>{it.title}</Text>
                  <View style={[styles.statusDot, { backgroundColor: it.enabled ? theme.colors.success : theme.colors.border }]} />
                </View>
                {it.description ? <Text style={styles.itemBody} numberOfLines={2}>{it.description}</Text> : null}
                {it.pdf_url ? <Text style={styles.url} numberOfLines={1}>{it.pdf_url}</Text> : null}
              </View>
            </View>
            <View style={styles.itemActions}>
              <TouchableOpacity style={styles.act} onPress={() => toggle(it)}>
                <Ionicons name={it.enabled ? "eye-off" : "eye"} size={16} color={theme.colors.primary} />
                <Text style={styles.actTxt}>{it.enabled ? "Désactiver" : "Activer"}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.act} onPress={() => { setEditing(it); setOpen(true); }}>
                <Ionicons name="create" size={16} color={theme.colors.primary} />
                <Text style={styles.actTxt}>Modifier</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.act, styles.actDanger]} onPress={() => remove(it.id)}>
                <Ionicons name="trash" size={16} color={theme.colors.danger} />
                <Text style={[styles.actTxt, { color: theme.colors.danger }]}>Supprimer</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))
      }
      {open && editing && (
        <View style={styles.formCard}>
          <Text style={styles.formTitle}>{editing.id ? "Modifier l'e-book" : "Nouvel e-book"}</Text>
          <Field label="Titre" value={editing.title} onChangeText={(v) => setEditing({ ...editing, title: v })} testID="ebook-title" />
          <Field label="Description" value={editing.description} onChangeText={(v) => setEditing({ ...editing, description: v })} multiline />
          <Field label="Image (URL)" value={editing.image_url} onChangeText={(v) => setEditing({ ...editing, image_url: v })} placeholder="https://..." keyboardType="url" />
          <MediaUploader kind="image" url={editing.image_url} onChange={(u) => setEditing({ ...editing, image_url: u })} testID="ebook-image-upload" />
          <Field label="Fichier PDF (URL)" value={editing.pdf_url} onChangeText={(v) => setEditing({ ...editing, pdf_url: v })} placeholder="https://..." keyboardType="url" />
          <MediaUploader kind="pdf" url={editing.pdf_url} onChange={(u) => setEditing({ ...editing, pdf_url: u })} testID="ebook-pdf-upload" />
          <EnabledRow value={editing.enabled} onChange={(v) => setEditing({ ...editing, enabled: v })} />
          <View style={styles.formActions}>
            <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => { setOpen(false); setEditing(null); }}><Text style={styles.btnGhostTxt}>Annuler</Text></TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={save} testID="save-ebook-btn">
              <Ionicons name="save" size={16} color="#fff" />
              <Text style={styles.btnPrimaryTxt}>Enregistrer</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// ============================================================================
// PREMIUM APPS CRUD
// ============================================================================
type App = {
  id: string; name: string; description: string; image_url: string;
  apk_url: string; download_url: string; version: string; enabled: boolean; order: number;
};

function PremiumAppsCrud() {
  const [items, setItems] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<App | null>(null);
  const [open, setOpen] = useState(false);
  const empty: App = { id: "", name: "", description: "", image_url: "", apk_url: "", download_url: "", version: "", enabled: true, order: 0 };

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await api.get<App[]>("/admin/premium-apps"); setItems(Array.isArray(r) ? r : []); }
    catch { setItems([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!editing || !editing.name.trim()) { Alert.alert("Champs requis", "Le nom est obligatoire."); return; }
    try {
      if (editing.id) await api.put(`/admin/premium-apps/${editing.id}`, editing);
      else await api.post("/admin/premium-apps", editing);
      setOpen(false); setEditing(null); await load();
    } catch (e: any) { Alert.alert("Erreur", e?.detail || "Sauvegarde impossible"); }
  };
  const remove = async (id: string) => {
    if (!confirmWeb("Supprimer cette application ?")) return;
    try { await api.delete(`/admin/premium-apps/${id}`); await load(); }
    catch (e: any) { Alert.alert("Erreur", e?.detail || "Suppression impossible"); }
  };
  const toggle = async (it: App) => {
    try { await api.put(`/admin/premium-apps/${it.id}`, { ...it, enabled: !it.enabled }); await load(); } catch {}
  };

  return (
    <View>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Applications premium ({items.length})</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => { setEditing({ ...empty }); setOpen(true); }} testID="add-app-btn">
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.addBtnTxt}>Ajouter</Text>
        </TouchableOpacity>
      </View>
      {loading ? <ActivityIndicator color={theme.colors.primary} />
        : items.length === 0 ? <ListEmpty icon="diamond" label="Aucune application. Cliquez sur Ajouter." />
        : items.map((it) => (
          <View key={it.id} style={styles.itemCard}>
            <View style={{ flexDirection: "row", gap: 10 }}>
              {it.image_url ? <Image source={{ uri: resolveMediaUrl(it.image_url) }} style={styles.thumb} /> : <View style={[styles.thumb, styles.thumbPh]}><Ionicons name="diamond" size={24} color={theme.colors.primary} /></View>}
              <View style={{ flex: 1 }}>
                <View style={styles.titleRow}>
                  <Text style={styles.itemTitle}>{it.name}</Text>
                  <View style={[styles.statusDot, { backgroundColor: it.enabled ? theme.colors.success : theme.colors.border }]} />
                </View>
                {it.version ? <Text style={styles.category}>v{it.version}</Text> : null}
                {it.description ? <Text style={styles.itemBody} numberOfLines={2}>{it.description}</Text> : null}
                {(it.apk_url || it.download_url) ? <Text style={styles.url} numberOfLines={1}>{it.apk_url || it.download_url}</Text> : null}
              </View>
            </View>
            <View style={styles.itemActions}>
              <TouchableOpacity style={styles.act} onPress={() => toggle(it)}>
                <Ionicons name={it.enabled ? "eye-off" : "eye"} size={16} color={theme.colors.primary} />
                <Text style={styles.actTxt}>{it.enabled ? "Désactiver" : "Activer"}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.act} onPress={() => { setEditing(it); setOpen(true); }}>
                <Ionicons name="create" size={16} color={theme.colors.primary} />
                <Text style={styles.actTxt}>Modifier</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.act, styles.actDanger]} onPress={() => remove(it.id)}>
                <Ionicons name="trash" size={16} color={theme.colors.danger} />
                <Text style={[styles.actTxt, { color: theme.colors.danger }]}>Supprimer</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))
      }
      {open && editing && (
        <View style={styles.formCard}>
          <Text style={styles.formTitle}>{editing.id ? "Modifier l'application" : "Nouvelle application"}</Text>
          <Field label="Nom" value={editing.name} onChangeText={(v) => setEditing({ ...editing, name: v })} testID="app-name" />
          <Field label="Description" value={editing.description} onChangeText={(v) => setEditing({ ...editing, description: v })} multiline />
          <Field label="Version" value={editing.version} onChangeText={(v) => setEditing({ ...editing, version: v })} placeholder="Ex: 1.0.0" />
          <Field label="Image (URL)" value={editing.image_url} onChangeText={(v) => setEditing({ ...editing, image_url: v })} placeholder="https://..." keyboardType="url" />
          <MediaUploader kind="image" url={editing.image_url} onChange={(u) => setEditing({ ...editing, image_url: u })} testID="app-image-upload" />
          <Field label="Fichier APK (URL)" value={editing.apk_url} onChangeText={(v) => setEditing({ ...editing, apk_url: v })} placeholder="https://..." keyboardType="url" />
          <MediaUploader kind="apk" url={editing.apk_url} onChange={(u) => setEditing({ ...editing, apk_url: u })} testID="app-apk-upload" />
          <Field label="Lien de téléchargement alternatif" value={editing.download_url} onChangeText={(v) => setEditing({ ...editing, download_url: v })} placeholder="https://..." keyboardType="url" />
          <EnabledRow value={editing.enabled} onChange={(v) => setEditing({ ...editing, enabled: v })} />
          <View style={styles.formActions}>
            <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => { setOpen(false); setEditing(null); }}><Text style={styles.btnGhostTxt}>Annuler</Text></TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={save} testID="save-app-btn">
              <Ionicons name="save" size={16} color="#fff" />
              <Text style={styles.btnPrimaryTxt}>Enregistrer</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// ============================================================================
// TRADING — single config
// ============================================================================
function TradingCrud() {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("Trading");
  const [desc, setDesc] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get<any>("/admin/settings/trading");
        setEnabled(!!r.enabled); setUrl(r.telegram_url || "");
        setLabel(r.label || "Trading"); setDesc(r.description || "");
      } catch {}
      setLoading(false);
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.put("/admin/settings/trading", {
        enabled, telegram_url: url.trim(), label, description: desc,
      });
      Alert.alert("✅", "Configuration enregistrée");
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Sauvegarde impossible");
    } finally { setSaving(false); }
  };

  if (loading) return <ActivityIndicator color={theme.colors.primary} />;

  return (
    <View>
      <Text style={styles.sectionTitle}>Configuration Trading</Text>
      <Text style={styles.helper}>
        Lorsque l'utilisateur clique sur le service Trading, il est redirigé directement vers le lien Telegram configuré ici.
        Si vide ou désactivé, la section affiche "Bientôt disponible".
      </Text>

      <View style={styles.formCard}>
        <EnabledRow value={enabled} onChange={setEnabled} />
        <Field label="Lien Telegram" value={url} onChangeText={setUrl} placeholder="https://t.me/votre-canal" keyboardType="url" testID="trading-url" />
        <Field label="Libellé affiché" value={label} onChangeText={setLabel} placeholder="Trading" />
        <Field label="Description (optionnelle)" value={desc} onChangeText={setDesc} multiline placeholder="Ex: Rejoignez notre canal d'analyses quotidiennes" />
        <View style={styles.formActions}>
          <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={save} disabled={saving} testID="save-trading-btn">
            {saving ? <ActivityIndicator color="#fff" /> : <Ionicons name="save" size={16} color="#fff" />}
            <Text style={styles.btnPrimaryTxt}>Enregistrer la configuration</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

function Mini({ icon }: { icon: keyof typeof Ionicons.glyphMap }) {
  return (
    <View style={styles.mini}>
      <Ionicons name={icon} size={12} color={theme.colors.primary} />
    </View>
  );
}

// ============================================================================
// styles
// ============================================================================
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 14, paddingTop: 22, paddingBottom: 18 },
  headerTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  back: { width: 36, height: 36, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  headerTitle: { color: "#fff", fontSize: 22, fontWeight: "800" },
  headerSub: { color: "#C7D9FF", marginTop: 6, fontSize: 12 },

  tabs: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  tab: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 22, backgroundColor: "#fff", borderWidth: 1, borderColor: theme.colors.border },
  tabOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tabTxt: { color: theme.colors.primary, fontWeight: "700", fontSize: 13 },

  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  sectionTitle: { fontSize: 16, fontWeight: "800", color: theme.colors.textPrimary },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 22, backgroundColor: theme.colors.primary },
  addBtnTxt: { color: "#fff", fontWeight: "700", fontSize: 12 },
  helper: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, marginBottom: 10 },

  itemCard: { backgroundColor: theme.colors.surface, borderRadius: 14, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: theme.colors.border },
  thumb: { width: 64, height: 64, borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary },
  thumbPh: { alignItems: "center", justifyContent: "center" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8, justifyContent: "space-between" },
  itemTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 14, flex: 1 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  category: { color: theme.colors.primary, fontWeight: "700", fontSize: 10, marginTop: 2, letterSpacing: 0.5 },
  itemBody: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 16, marginTop: 2 },
  url: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 2 },
  linksRow: { flexDirection: "row", gap: 4, marginTop: 6 },
  mini: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#DBEAFE", alignItems: "center", justifyContent: "center" },
  itemActions: { flexDirection: "row", gap: 6, marginTop: 10, flexWrap: "wrap" },
  act: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#DBEAFE", borderRadius: 16 },
  actDanger: { backgroundColor: "#FEE2E2" },
  actTxt: { color: theme.colors.primary, fontSize: 11, fontWeight: "700" },

  empty: { alignItems: "center", padding: 28, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border, borderStyle: "dashed" },
  emptyTxt: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 8, textAlign: "center" },

  formCard: { marginTop: 12, padding: 14, backgroundColor: theme.colors.surface, borderRadius: 20, borderWidth: 2, borderColor: theme.colors.primary, ...theme.shadow.card },
  formTitle: { fontWeight: "800", fontSize: 16, color: theme.colors.textPrimary, marginBottom: 12 },
  lbl: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: 10, fontSize: 13, color: theme.colors.textPrimary, backgroundColor: theme.colors.surfaceSecondary },
  inputMultiline: { minHeight: 70, textAlignVertical: "top" },
  toggleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8, marginBottom: 6 },
  formActions: { flexDirection: "row", gap: 8, marginTop: 10 },
  btn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 22, flex: 1 },
  btnPrimary: { backgroundColor: theme.colors.primary },
  btnPrimaryTxt: { color: "#fff", fontWeight: "800", fontSize: 13 },
  btnGhost: { backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  btnGhostTxt: { color: theme.colors.textPrimary, fontWeight: "700" },
});
