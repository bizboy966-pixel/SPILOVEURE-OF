import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { DICTIONARIES, fr, Lang } from "./translations";

export type { Lang } from "./translations";
export { LANG_LABELS } from "./translations";

const STORAGE_KEY = "spiloveure.lang";
const DEFAULT_LANG: Lang = "fr";

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  ready: boolean;
};

const I18nContext = createContext<Ctx>({
  lang: DEFAULT_LANG,
  setLang: async () => {},
  t: (k) => k,
  ready: false,
});

function interpolate(s: string, vars?: Record<string, string | number>) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function I18nProvider({ children, initialLang }: { children: React.ReactNode; initialLang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initialLang || DEFAULT_LANG);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = lang;
  }, [lang]);

  // Boot: read the cached preference from AsyncStorage so the UI doesn't flash.
  useEffect(() => {
    (async () => {
      try {
        const stored = (await AsyncStorage.getItem(STORAGE_KEY)) as Lang | null;
        if (stored === "fr" || stored === "en") setLangState(stored);
      } catch {}
      setReady(true);
    })();
  }, []);

  const setLang = useCallback(async (l: Lang) => {
    setLangState(l);
    try { await AsyncStorage.setItem(STORAGE_KEY, l); } catch {}
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const dict = DICTIONARIES[lang] || fr;
      const raw = dict[key] ?? fr[key] ?? key;
      return interpolate(raw, vars);
    },
    [lang],
  );

  const value = useMemo<Ctx>(() => ({ lang, setLang, t, ready }), [lang, setLang, t, ready]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function useT() {
  return useContext(I18nContext).t;
}

const FORM_TEXT_KEYS: Record<string, string> = {
  "Nom d'utilisateur": "auth.username",
  "E-mail": "auth.email",
  "Mot de passe": "auth.password",
  "Confirmer le mot de passe": "auth.confirm_password",
  "Nouveau mot de passe": "auth.new_password",
  "Mot de passe actuel": "settings.current_password",
  "Téléphone": "auth.phone",
  "Numéro de téléphone": "auth.phone_number",
  "Pays": "auth.country",
  "Montant": "common.amount",
  "Montant à retirer": "withdrawal.amount",
  "Nom complet": "wallet.full_name_placeholder",
  "Nom du titulaire": "wallet.holder_name",
  "Rechercher": "common.search",
  "Enregistrer": "common.save",
  "Annuler": "common.cancel",
  "Modifier": "common.edit",
  "Supprimer": "common.delete",
  "Confirmer": "common.confirm",
  "SE CONNECTER": "auth.login_button",
  "S'INSCRIRE": "auth.signup",
  "ENREGISTRER": "wallet.save",
  "Dépôt": "coming.title.depot",
  "Envoyer": "coming.title.send",
  "Échanger": "coming.title.exchange",
  "IA SPV": "coming.title.spvia",
  "Trading": "coming.title.trading",
  "Retour à l'accueil": "common.return_home",
  "Fonctionnalité désactivée": "common.feature_disabled",
  "Bientôt disponible": "common.coming_soon_title",
};

export function translateFormText(
  value: string | undefined,
  t: Ctx["t"],
): string | undefined {
  if (!value) return value;
  const key = FORM_TEXT_KEYS[value] ??
    Object.keys(fr).find((candidate) => fr[candidate] === value);
  return key ? t(key) : value;
}
