# SPILIVERE — PRD

## Problem Statement (original)
Importer le code depuis ce repo GitHub : https://github.com/bizboy966-pixel/Spiloveure
App Expo Router (Web) + backend FastAPI + MongoDB. Déploiement web sur `spiloveure.com`.
Plateforme MLM matrice binaire 12 niveaux, paiements mobile money (AshTechPay), commissions immédiates à l'activation.

## Architecture
- Frontend: Expo Router (SDK 54) — TypeScript + React Native Web, Metro bundler, port 3000.
- Backend: FastAPI + Motor (MongoDB async) port 8001, préfixe `/api`.
- DB: MongoDB locale (`MONGO_URL`, `DB_NAME=spilivere`).
- Reverse-proxy K8s : `/api/*` → backend:8001, le reste → frontend:3000.
- Preview : `https://spiloveure-deploy.preview.emergentagent.com`.

## Règles MLM critiques
- Matrice binaire forcée 12 niveaux. Niveau N a 2^N positions descendantes (N1=2, N2=4, … N12=4096).
- Activation Niveau N → commission payée **immédiatement** à l'ancêtre **exactement N hops au-dessus** via la chaîne de **parrainage** (sponsor_id).
- Si cet ancêtre n'a pas activé le niveau N → commission **ignorée** (non rétroactive).
- Spillover (parent matrice ≠ sponsor direct) → commission **split 50/50** entre ancêtre N-hops du sponsor et ancêtre N-hops du parent matrice.
- Chaque crédit est split entre `balance_profit` (retirable) et `balance_upgrade` (réserve pour activer le niveau suivant), ratio par niveau dans `levels.py`.

## Implementation Status (à jour 2026-06-19)
### 2026-07-07 (bis) — 🔧 Correction règle « Commission directe » (Spillover-aware)
**Problème remonté** : la première itération n'utilisait que `kind=direct` + `level=1` pour flagger « Commission directe ». Or, quand un filleul direct est placé par Spillover, la commission générée est de `kind=spillover_sponsor` (également au level 1). Résultat : seuls les 2 premiers filleuls directs (avant Spillover) étaient étiquetés « Commission directe » ; les suivants apparaissaient comme « Commission niveau 1 ».

**Règle métier définitive** : « Commission directe » = toute commission provenant d'un utilisateur dont `users.sponsor_id` correspond au bénéficiaire de la commission. Le Spillover ne change JAMAIS le parrain d'origine.

**Fix — `/app/backend/server.py` → `_build_transaction_history()`** :
- Check primaire : `from_user.sponsor_id == recipient.user_id` → « Commission directe » (source de vérité).
- Fallback pour données historiques où le from_user a été supprimé de la DB : `matrix.py` garantit que `kind ∈ {direct, spillover_sponsor}` avec `level=1` signifie que le bénéficiaire EST le parrain direct → « Commission directe ».
- Sinon, avec un `level` (2..12) → « Commission niveau X » (matrix ancestor ou hop supérieur du sponsor chain).

**Vérification empirique (compte admin, DB preview)** : les 8 commissions MLM (2 `direct` + 6 `spillover_sponsor` niveau 1) sont maintenant toutes étiquetées « Commission directe » — cohérent car ces 8 filleuls sont bien parrainés directement par l'admin.

**Régression** : nouveau test `/app/backend/tests/test_transaction_labels.py` couvre 5 cas (parrainage direct multi-kind, ancêtre matrix, from_user supprimé, loterie, absence totale de jargon). Tous verts.


**Contexte** : les libellés utilisateur contenaient du jargon MLM interne (« Spillover », « Parrainage Direct », « Commission Spillover (Parrain) », « Commission Spillover (Bénéficiaire) ») affiché dans `/(app)/transactions` et dans le panneau admin `/api/admin/users/{id}/transactions`.

**Fix — libellés unifiés côté serveur (mapping dynamique à la lecture)** :
- `/app/backend/server.py` → `_build_transaction_history()` (ligne ~750).
- Règle appliquée :
  - `kind=direct` & `level=1` → **« Commission directe »**.
  - Tout autre kind MLM avec un `level` (2..12) ou spillover_sponsor / spillover_beneficiary → **« Commission niveau X »** (X = level).
  - `kind=lottery_win` → « Gain Loterie ».
  - `kind=lottery_entry` → « Participation Loterie ».
  - `kind=lottery_loss` → « Perte Loterie ».
- Le mapping se fait à la **lecture** (GET) → les commissions historiques déjà enregistrées en base sont automatiquement reformatées, sans migration DB.
- Le frontend `/(app)/transactions.tsx` affiche directement `item.label` — aucune modif frontend requise.
- Vérifié par curl : sur le compte admin, 2 « Commission directe », 6 « Commission niveau 1 », 17 « Participation Loterie », 5 « Gain Loterie », **0 mention** de Spillover/Parrain/Bénéficiaire.
- Vérifié visuellement sur la page Historique du preview.


### 2026-07-02 — 🔴 Correctif critique : Applications Premium — page « Not Found » sur téléchargement
**Cause racine** : le disque local `/app/backend/uploads` du container Kubernetes est **éphémère** — les fichiers uploadés par l'admin étaient perdus à chaque redéploiement. La route `/api/uploads/{filename}` (StaticFiles) retournait alors un 404 JSON brut `{"detail":"Not Found"}`.

**Fix — Intégration Emergent Object Storage** :
- Nouveau module `/app/backend/object_storage.py` : `init/put_upload/get_upload/exists` avec cache du `storage_key` + retry sur 403 + normalisation des 500 upstream en `FileNotFoundError` (évite les warnings de log).
- `EMERGENT_LLM_KEY` ajouté à `/app/backend/.env`. Init au startup dans la lifespan.
- `POST /api/admin/uploads` (`digital_content.py`) : dual-write — écrit sur disque local (dev / preview) ET sur object storage (persistant, prod). Retourne désormais `storage_ok: bool`.
- Route `/api/uploads/{filename}` (`server.py`) réécrite : (1) tente object storage, (2) fallback disque local, (3) `410 Gone` avec message français explicite « Ce fichier n'est plus disponible sur le serveur. Veuillez contacter l'administration pour qu'il soit ré-uploadé. »
- Nouveau `GET /api/admin/uploads/diagnostic` : scanne toutes les collections `digital_formations`, `digital_ebooks`, `digital_premium_apps` et liste les items dont les fichiers référencés sont introuvables → aide l'admin à identifier ce qui doit être ré-uploadé.
- Migration : les 3 fichiers legacy déjà présents en local ont été poussés vers object storage → tout est désormais disponible même en cas de redéploiement.

**Frontend `premium-apps.tsx`** : la fonction `openUrl` fait maintenant un `HEAD` préalable sur les URLs `/api/uploads/…` et affiche une alerte française claire si le serveur renvoie 410 (au lieu d'ouvrir un onglet avec le JSON brut).

**Tests** : ✅ 12/12 pytest (`test_uploads_object_storage.py`) — validé par testing_agent_v3_fork iteration 18. Scénario clé validé : upload → suppression du fichier local → GET `/api/uploads/…` retourne toujours 200 avec le contenu (via object storage).

**Déploiement** : bug en PRODUCTION. Correctif appliqué en préview + `EMERGENT_LLM_KEY` ajouté au `.env`. **Redéploiement nécessaire**. Après redéploiement : l'admin devra ré-uploader les fichiers Applications Premium existants qui pointaient vers des URLs `/api/uploads/…` (l'endpoint diagnostic listera exactement lesquels).


### 2026-06-19 — Correctifs sur la nouvelle section « Équipe »
Suite au feedback utilisateur, 3 ajustements livrés :

1. **Bouton Retour** : ajout en haut de la page `/(app)/equipe.tsx` (testID `team-back`), style pill semi-transparent sur le header gradient. Comportement : `router.back()` si historique navigable, sinon retour au dashboard.

2. **Restauration de l'ancien menu « Mon Équipe (arbre) »** : la page `/(app)/team-direct.tsx` (arbre binaire généalogique) est TOUJOURS PRÉSENTE et inchangée. Le sidebar contient désormais 2 entrées séparées :
   - 🌳 **Mon Équipe (arbre)** → `/(app)/team-direct` (testID `menu-team-direct`)
   - 👥 **Équipe** → `/(app)/equipe` (testID `menu-team`)

3. **Dashboard `quick-team` remis à l'ancien comportement** : le bouton « Mon équipe » du dashboard revient sur l'arbre binaire (`/team-direct`), comme avant.

**Résultat** : les 2 fonctionnalités coexistent sans conflit. L'arbre reste accessible via son bouton et son entrée de menu historiques ; la nouvelle liste plate est accessible via le menu « 👥 Équipe » indépendant.


### 2026-06-19 — 👥 Nouvelle section « Équipe » (directe + indirecte spillover)
**Backend**
- Nouveau endpoint `GET /api/team/indirect` : retourne les utilisateurs placés dans l'équipe de l'utilisateur via le système Spillover (`matrix_placements.parent_id == me.id`, `is_spillover=true`, `sponsor_id != me.id`). Chaque membre est dédupliqué par `user_id` (on garde la placement au level le plus bas) et enrichi avec `placement_level` et `placed_at`. Retour : `{members, active, inactive, total}`.
- `GET /api/team/direct` (existant) ajoute désormais `total` (couvre inactifs).

**Frontend**
- Nouvelle page `/(app)/equipe.tsx` avec 2 onglets (`team-tab-direct` / `team-tab-indirect`), bandeau stats (Total / 🟢 Actifs / 🔴 Inactifs), liste enrichie par membre (@username, ID tronqué, téléphone pour direct uniquement, date d'inscription, date d'activation via `level_activated_at['1']`).
- Pull-to-refresh charge les 2 buckets en parallèle (`Promise.all`).
- État vide contextualisé (message + hint).
- `SideMenu.tsx` : item « 👥 Équipe » remplace l'ancien « Équipe directe » (testID `menu-team`).
- `dashboard.tsx` : bouton `quick-team` redirige vers `/(app)/equipe`.

**Correctif collatéral** appliqué par le testing agent :
- `src/components/Card.tsx` ne forwardait pas le prop `testID` → tous les testIDs posés sur `<Card>` étaient perdus dans le DOM Web. Fix : accepte et propage `testID` sur le `View` racine.

**Tests** : ✅ 7/7 pytest backend (`test_team_indirect.py` — inclut un scénario positif avec seed spillover puis teardown propre). ✅ Frontend 85 % (limité par un popup promo bloquant temporairement les tests Playwright — non lié à cette feature).

**Note UX** : popup « Communauté SPILOVEURE » automatique 5 s après login gêne l'accès aux tabs sur `/equipe` — à réviser plus tard pour ne l'afficher que sur le dashboard.


### 2026-06-19 — 🔎 Outils d'audit d'intégrité (activations & commissions)
**Contexte** : bug rapporté en production — certains utilisateurs sont activés à des niveaux sans avoir payé, et d'autres reçoivent d'importantes commissions sans qu'aucun membre de leur réseau n'ait activé quoi que ce soit. Comme je n'ai pas accès à la DB prod, j'ai livré des outils d'audit qui permettront à l'utilisateur d'identifier concrètement les cas suspects.

**Backend** :
- Nouvelle collection `activation_events` : `matrix.py activate_level()` insère désormais un document `{user_id, level, source, requires_payment, created_at}` à chaque appel — traçabilité complète de toutes les activations futures.
- Nouveau module `/app/backend/integrity_audit.py` avec 3 endpoints READ-ONLY admin :
  - `GET /api/admin/audit/free-activations` — détecte les users avec `max_level >= 1` (hors admin) dont aucun niveau ne peut être expliqué par un paiement (SoleasPay/AshtecPay), une validation admin (Mobile Money) ou une source légitime (auto_upgrade/manual). Retourne `{summary, findings[]}` avec 2 sévérités : `critical` (no_origin) et `warning` (admin_manual L1 uniquement).
  - `GET /api/admin/audit/orphan-commissions` — analyse toutes les commissions MLM (direct, spillover_sponsor, spillover_beneficiary) et signale : `from_user_id` inexistant, `from_user_id.max_level < commission.level`, ou incohérence dans la chaîne des parrains (N-1 sauts).
  - `GET /api/admin/audit/user/{id}/trace` — retour complet pour un utilisateur : profil, classification niveau par niveau, activation_events, payments, activations manuelles, commissions reçues/générées avec origine, totaux.

**Frontend Admin** :
- Nouvelle page `/(admin)/audit.tsx` avec 3 onglets (activations suspectes, commissions orphelines, tracer un user).
- Bouton d'accès rouge « 🔎 Audit d'intégrité » ajouté sur le dashboard admin.
- Depuis un finding « activation suspecte », un bouton « 🔍 Tracer cet utilisateur » pré-remplit et bascule sur l'onglet trace.

**Tests** : ✅ 22/22 pytest passent (`test_integrity_audit.py` nouveau + regression `test_manual_upgrade_debit.py`). ✅ Frontend 100% via testing_agent_v3_fork iteration_16.

**Nettoyage** : 2 users TEST_audit_* résiduels supprimés de la DB préview.

**Comportement du fix admin_manual toujours en place** : level ≥ 2 refuse strictement si `balance_upgrade < price` (auto_upgrade, manual, admin_manual).

**Déploiement** : bug en PRODUCTION → l'utilisateur peut redéployer pour accéder aux outils d'audit sur prod et identifier concrètement les comptes suspects. Il pourra ensuite me fournir des exemples précis (via l'endpoint `/trace`) pour toute correction manuelle.


### 2026-06-19 — 🔴 Correctif critique : Système de mise à niveau (admin_manual)
**Bug constaté** : l'activation `admin_manual` (admin force un niveau via `/api/admin/users/{id}/action` action=`activate_level`) permettait à l'admin d'activer un niveau ≥ 2 d'un utilisateur **sans vérifier ni débiter `balance_upgrade`**. Le code logguait juste un warning et avançait `max_level` gratuitement — incohérent avec `auto_upgrade` et `manual` (côté user) qui exigeaient bien la réserve.

**Fichier touché** : `/app/backend/matrix.py` lignes 264-289 (`activate_level`).

**Comportement avant** :
```python
if level >= 2 and source in (..., "admin_manual"):
    if balance_upgrade < price:
        if source in ("auto_upgrade", "manual"):
            raise ValueError(...)
        # admin_manual: log + proceed without debit ← BUG
```

**Comportement après** :
```python
if level >= 2 and source in ("auto_upgrade", "manual", "admin_manual"):
    if balance_upgrade < price:
        raise ValueError("Réserve de mise à niveau insuffisante : X FCFA disponible, Y FCFA requis pour le niveau Z.")
    await db.users.update_one({"id": user_id}, {"$inc": {"balance_upgrade": -price}})
```

**Règles confirmées (conformément à la spec utilisateur)** :
- **Niveau 1 (`admin_manual`)** : pas de check `balance_upgrade`, pas de débit (comportement conservé).
- **Niveau ≥ 2 (toutes sources internes : `auto_upgrade`, `manual`, `admin_manual`)** : rejet strict si réserve insuffisante, débit obligatoire sur succès.
- **Paiements externes** (SoleasPay, AshtecPay, manual Mobile Money/Crypto validés par admin via `admin_validate`, `secure_pay`, `gateway_return`, `sendavapay`, `manual_reprocess`) : continuent à ne PAS toucher `balance_upgrade` (payés out-of-band).

**Tests** : ✅ 12/12 pytest passent (`tests/test_manual_upgrade_debit.py`) — l'ancien test obsolète `test_admin_manual_insufficient_reserve_still_activates` a été remplacé par `test_admin_manual_insufficient_reserve_now_refuses` + `test_admin_manual_sufficient_reserve_debits`. E2E curl confirmé : rejet avec message explicite quand vide, succès + débit quand suffisant.

**Déploiement** : bug en PRODUCTION. Correctif appliqué en préview — redéploiement nécessaire.


### 2026-06-19 — 🔴 Correctif critique : Système de parrainage à l'inscription
**Bug constaté en production** : tous les utilisateurs s'inscrivant sans `?ref=…` dans l'URL étaient automatiquement rattachés au parrain `admin`, causant des erreurs dans la structure du réseau, les commissions et le placement matrice.

**Cause racine** (frontend uniquement) : `/app/frontend/app/(auth)/register.tsx` ligne 32 :
```js
const [sponsor, setSponsor] = useState((params.ref as string) || "admin");
```
→ Le fallback `"admin"` envoyait silencieusement `admin` comme sponsor au backend, qui validait l'inscription (admin est un utilisateur existant).

**Correctifs livrés** :
1. Suppression du fallback `"admin"`. Le parrain provient EXCLUSIVEMENT de `?ref=…`.
2. Vérification du parrain via `GET /api/sponsor/:username` au chargement du formulaire. Si le ref est manquant ou invalide :
   - Bandeau d'avertissement jaune affichant « ⚠️ Lien de parrainage invalide ou introuvable. Veuillez utiliser un lien de recommandation valide avant de poursuivre votre inscription. »
   - Champ Parrain vide avec placeholder « Lien de parrainage requis » et 🔒
   - Bouton S'INSCRIRE désactivé (`disabled={!sponsorValid || sponsorChecking}`)
3. Pendant la vérification, affichage d'un message « Vérification du parrain en cours… »
4. Le champ Parrain est toujours `editable={false}` (verrouillé). Le hint affiche « 🔒 Code parrain verrouillé (transmis via votre lien d'invitation : @username) »
5. Côté backend (`/api/auth/register`), la validation existante du parrain est suffisante (refuse 400 si introuvable). Selon décision utilisateur (1.b), `admin` reste un parrain valide pour les inscriptions explicites via `?ref=admin`.

**Statut de l'audit existant** : skip pour le moment (décision utilisateur 2.c) — sera traité dans une session ultérieure si besoin.

**Déploiement** : le bug est observable en PRODUCTION (https://spiloveure.com). Code corrigé en préview ; l'utilisateur doit redéployer pour pousser le correctif en prod.

**Tests** : ✅ 3 états UI validés visuellement (no-ref, invalid-ref, valid-ref). ✅ Endpoint `GET /api/sponsor/:username` testé (existant 200, inexistant 404, espaces 404).


### 2026-06-19 — Triplet : Gating d'activation strict, ajout du pays Haïti 🇭🇹, système i18n FR/EN
**Phase 1 — Gating activation strict** (`/app/frontend/app/(app)/_layout.tsx`, `settings.tsx`)
- `isPending = !user || user.status === "pending" || max_level === 0` calculé au niveau du layout.
- Floating widgets gated : `CommunityPopup`, `SupportFab`, `LotteryFab` ne sont rendus QUE si `!isPending`.
- Dans `settings.tsx`, la carte « Support & Réseaux sociaux » est cachée pour les pending users (le fetch `/settings/support` est aussi skippé).
- La redirection vers `/activation` pour les routes hors `ALLOWED_FOR_PENDING` (activation, profile, settings) était déjà en place.

**Phase 2 — Ajout du pays Haïti 🇭🇹**
- Backend : ajout dans `/app/backend/levels.py` COUNTRIES → `{code: HT, name: Haïti, dial: +509, flag: 🇭🇹}`. Apparaît automatiquement dans `GET /api/config`.
- Frontend : ajout dans `/app/frontend/app/(app)/activation.tsx` `COUNTRY_LABELS`. Toutes les listes pays utilisent désormais le backend `/config` countries.

**Phase 3a — Système i18n FR/EN**
- Nouveau module `/app/frontend/src/i18n/` : `translations.ts` (~140 clés FR + 140 clés EN couvrant common, auth, dashboard, activation, settings, lottery, missions, withdrawal) + `index.tsx` (Provider + `useT()` + `useI18n()` avec interpolation `{var}` et fallback FR si clé manquante).
- Persistance : AsyncStorage (`spiloveure.lang`) + DB user field `preferred_language`.
- Backend : nouvel endpoint `PUT /api/auth/language` body `{language: 'fr'|'en'}` (refuse autre code avec 400).
- Sync automatique : `(app)/_layout.tsx` synchronise `user.preferred_language` → `setLang()` à chaque login/refresh pour s'appliquer sur un nouvel appareil sans repassage par Settings.
- UI : sélecteur dans `settings.tsx` (testID `settings-language-btn`) qui ouvre un modal (testID `language-picker-modal`) avec les options `language-option-fr` / `language-option-en`. Sur échec PUT, la langue locale est revertée pour éviter une désynchro UI/DB.
- Root layout enveloppe l'app dans `I18nProvider` avant `AuthProvider`.
- Admin : `/(admin)/user/[id].tsx` affiche maintenant la langue préférée (🇫🇷 Français / 🇬🇧 English).
- ⚠️ Phase 3b (à faire) : traduction du reste des écrans (dashboard complet, admin panel, services, ebooks, formations, applications premium, popup community, notifications backend, e-mails) — le scaffolding est en place, il suffit d'ajouter `const { t } = useI18n()` puis de remplacer les chaînes hardcodées par `t('clé')`.
- ✅ Tests : 9/9 backend (`test_i18n_haiti_gating.py`), frontend 100% via testing_agent_v3_fork iteration_15. Pending user créé via register confirmé : `status=pending`, `max_level=0`.


### 2026-06-19 — Lottery Jackpot Phase 4 : sélection manuelle des gagnants AVANT le lancement
- 🆕 **Nouveau endpoint** `POST /api/admin/lottery/draws/{id}/select-winners` body `{winners:[{rank, user_id, prize}, ...]}` qui stocke les gagnants pré-sélectionnés sur le draw (`preset_winners`). Validations strictes côté backend :
  - status doit être `open` (sinon 400)
  - exactement `winners_count` gagnants requis (sinon 400)
  - tous les rangs 1..N doivent être attribués sans doublon
  - aucun doublon de `user_id`
  - chaque `user_id` doit appartenir à un participant inscrit au tirage
- 🔒 **`/launch` durci** : refuse maintenant si `preset_winners` est vide ou incomplet — message « Vous devez d'abord sélectionner et valider les N gagnant(s) avant de lancer le tirage. »
- 🤖 **Auto-completion utilise désormais `preset_winners`** : à expiration du countdown, `_auto_complete_if_due` publie EXACTEMENT les gagnants pré-sélectionnés et crédite leurs `balance_profit` selon les montants choisis (pas de tirage au sort). Fallback random conservé uniquement comme filet de sécurité pour données legacy.
- 🎨 **Frontend Admin** : nouveau bouton « 🎯 Sélectionner les gagnants » (ou « ✏️ Modifier les gagnants » si déjà fait) sur les draws `open`. Modal repensé : (a) liste récapitulative des participants (nom + montant payé + date d'inscription), (b) un input prize + un sélecteur par rang, (c) les participants déjà attribués à un autre rang sont grisés et désactivés, (d) bouton de soumission « ✅ Valider les gagnants ». Le bouton « 🚀 Lancer le tirage » est désormais désactivé (`disabled` + opacity 0.5) tant que les gagnants n'ont pas été validés.
- 📋 **Affichage** : un nouveau bloc « 🎯 Gagnants pré-sélectionnés » est rendu sur la carte du draw une fois la validation effectuée, listant @username + prize par rang.
- ✅ **Tests** : 11/11 pytest backend (`test_lottery_jackpot_flow.py` réécrit), frontend 100% via testing_agent_v3_fork iteration_14, E2E manuel validé (admin → join → select-winners → launch 1 min → auto-publication → soldes crédités exactement selon preset).


### 2026-06-19 — Lottery Jackpot Phase 3 : refonte du flux (open → running → announced)
- 🔄 **Nouveau cycle de vie** : `draft` et `closed` supprimés du flow. Les statuts utilisés sont désormais `open` → `running` → `announced` uniquement.
- 🆕 **Création immédiate** : `POST /api/admin/lottery/draws` ne demande plus `starts_at`/`ends_at`. Le payload est `{name, description, entry_amount, winners_count, max_participants, min_participants, prizes}`. Le draw est créé directement en statut `open` et visible aux users.
- 🆕 **Nouvel endpoint** `POST /api/admin/lottery/draws/{id}/launch` body `{duration_minutes: N}` : transitionne `open → running`, pose `ends_at = now + N min`, bloque ensuite tout nouveau join. Refuse si statut ≠ open ou aucun participant inscrit.
- 🔒 **Cap strict** sur les participations : `POST /api/lottery/draws/{id}/join` refuse explicitement quand `participants >= max_participants` ou si le statut est ≠ `open`.
- 🤖 **Auto-completion** : à chaque appel `GET /api/lottery/active` ou `GET /api/admin/lottery/draws`, si un draw `running` a passé `ends_at`, le helper `_auto_complete_if_due` (a) tire les gagnants au hasard parmi les participants (cap à `min(winners_count, len(prizes), len(participants))`), (b) crédite `balance_profit` + insère `db.commissions` (kind=lottery_win, meta.auto=True), (c) notifie gagnants/perdants, (d) passe en `announced` avec `results_visible_until`.
- 🎨 **Frontend Admin `(admin)/lottery.tsx`** : modal de création nettoyé (plus de champs "Démarre dans" / "Durée"). Nouveau bouton "🚀 Lancer le tirage" + modal dédié avec champ `duration_minutes` et 6 chips préréglés (5 min, 10 min, 30 min, 1 h, 3 h, 12 h). Le compte à rebours est affiché en direct sur chaque draw `running`. Status-pills traduites (OUVERT / EN COURS / ANNONCÉ).
- 🎨 **Frontend User `(app)/lottery.tsx`** : bouton "Rejoindre le Jackpot" visible uniquement si `status='open'` & non plein. Badge "Nombre maximal de participants atteint" si plein. Compte à rebours en direct si `status='running'`. Polling raccourci à 5 s pour suivre l'auto-completion.
- ✅ **Tests** : 8/8 backend pytest passent (`test_lottery_jackpot_flow.py`), frontend smoke tests OK (testing agent iteration 13), E2E manuel validé (join → launch 1 min → auto-announce + crédit confirmé en DB).


### 2026-06-19 — Lottery Phase 1 (fix create) + Phase 2 (Recharger mon compte)
- 🐛 **Fix bouton "Créer un tirage"** : remplacé l'enchaînement `window.prompt` peu fiable par un vrai **modal de création** dans `(admin)/lottery.tsx` avec champs (Nom, démarre dans Xh, durée, # gagnants, # max participants, montant participation) et bouton "✅ Créer le tirage". UX nettement améliorée.
- 🆕 **Phase 2 — Module Recharger mon compte** :
  - Backend `recharge.py` (nouveau) : collection `recharges` (méthode manuelle), wallet `balance_recharge` ajouté à users
  - Endpoints public : `GET /me/recharge-balance`, `POST /me/recharge/manual` (création demande pending), `GET /me/recharge-history`
  - Endpoints admin : `GET /admin/recharges` (filtre par statut), `POST /admin/recharges/{id}/validate` (crédit `balance_recharge` + notification), `POST /admin/recharges/{id}/reject` (avec motif + notification)
  - Frontend user `(app)/recharger.tsx` : hero gradient vert/bleu avec solde rechargé, formulaire (montant, opérateur en chips, numéro, référence, note), historique avec badges (🟡/🟢/🔴)
  - Frontend admin `(admin)/recharges.tsx` : liste filtrée (pending/validated/rejected), valider/rejeter avec motif, infos complètes (montant, opérateur, ref, date, note)
  - **Intégration Lottery** : si `balance_profit` insuffisant pour rejoindre un tirage, le système tente `balance_recharge` en fallback. Sinon redirection vers `/recharger` via confirm dialog.
  - **Notifications** : `recharge_validated` + `recharge_rejected` envoyées au user
- ✅ **Liens admin ajoutés** : "🎰 Lottery Jackpot" + "💳 Demandes de Recharge" dans le dashboard admin
- ✅ **Testé curl** : POST recharge manuelle → status="pending" enregistré → visible côté admin avec compte 1 pending. Backend fonctionne.

### 2026-06-19 — Module Lottery Jackpot (Phase 1)
- 🎯 **Objectif** : système complet de tirages aléatoires (admin choisit manuellement les gagnants). Activation/désactivation, tirages, participations payantes, gagnants, paiements auto sur balance_profit, notifications, stats, export CSV.
- ✅ **Backend `lottery.py` (nouveau)** : 3 collections isolées (`lottery_settings`, `lottery_draws`, `lottery_participants`). Statuts tirage : draft → open → closed → announced. Au moment de l'annonce, les gagnants reçoivent leur prize sur `balance_profit` + entrée dans `db.commissions` (kind="lottery_win") + notification. Les participants débitent leur balance_profit + entrée commissions (kind="lottery_entry", montant négatif) au moment de la participation. Remboursement automatique si le tirage est supprimé en draft/open/closed.
- ✅ **Endpoints public (user)** : `GET /lottery/settings`, `GET /lottery/active` (retourne tirage en cours + tirage récemment annoncé encore visible), `POST /lottery/draws/{id}/join` (vérif solde + capacité + idempotence).
- ✅ **Endpoints admin** : settings GET/PUT (enabled, floating_icon_visible, results_display_duration_minutes), draws CRUD + participants list + announce winners + stats agrégées + export CSV par tirage.
- ✅ **Frontend `(app)/lottery.tsx`** : page user avec hero gradient, compte à rebours live (jours/heures/min/sec), participants count, cagnotte par rang, bouton "🎰 Rejoindre" qui vérifie solde + confirmation, badges "déjà participé" / "clôturé" / module désactivé, affichage des derniers résultats avec 🥇🥈🥉🏅.
- ✅ **Frontend `(admin)/lottery.tsx`** : 3 onglets (Tirages / Réglages / Stats). Création via prompts (nom, durée, # gagnants, # max participants, montant participation). Edition récompense par rang. Boutons changement de statut (Ouvrir/Clôturer/Lancer & Annoncer). Modal sélection des gagnants par rang avec liste des participants. Toggle activation module, toggle icône flottante, durée affichage résultats.
- ✅ **Composant `LotteryFab.tsx`** : carré flottant en bas-gauche (z-index 9998, ne collide pas avec SupportFab à droite). Affiché uniquement si `enabled=true AND floating_icon_visible=true` côté admin. Refresh auto toutes les 60s.
- ✅ **Liens** : raccourci admin dans le dashboard `(admin)/index.tsx`. Page user accessible via `/app/lottery` ou via le FAB.
- ✅ **Testé curl** : GET settings (defaults), GET active (null si aucun), POST draws (création), tous les endpoints répondent correctement. UI confirmée par screenshot.
- ⚠️ **Phase 2 (à venir)** : module "💳 Recharger mon compte" pour permettre les dépôts manuels/automatiques quand le solde est insuffisant.

### 2026-06-18 — Correction synchronisation passerelles (suite intégration AshtecPay)
- 🎯 **Bug rapporté** : changer la passerelle active dans l'admin ne se répercute pas côté utilisateur. Le user voit toujours "SoleasPay" même quand AshtecPay est actif.
- 🐛 **Root cause** : 2 problèmes distincts.
  1. `/api/settings/payments` (endpoint user-facing) lisait UNIQUEMENT le legacy `app_settings.soleaspay` + `soleaspay.is_configured()` env-var ; il ignorait totalement la nouvelle config `payment_gateway` (avec `active`, `ashtec_enabled`, etc.). Si SoleasPay n'avait pas de clé en .env mais AshtecPay était configuré via admin, le bouton "Paiement Automatique" était caché.
  2. Le titre `"Paiement Automatique SoleasPay"` dans `activation.tsx` exposait le nom de la passerelle à l'utilisateur final, ce que le user ne voulait jamais voir.
- ✅ **Fix backend `/settings/payments`** : lit maintenant `payment_gateway` config, résout `active_gateway` (avec fallback inter-passerelles), calcule `auto_enabled` selon (gateway enabled + sa propre config). Expose `auto_enabled` + `active_gateway` (nouveaux champs) + maintient `soleaspay_enabled` synchronisé pour backward-compat avec le frontend existant.
- ✅ **Fix frontend `activation.tsx`** : titre changé de "Paiement Automatique SoleasPay" → "Paiement Automatique" (générique). L'utilisateur ne voit JAMAIS le nom de la passerelle.
- ✅ **Testé curl** : active=ashtec → `/settings/payments` retourne `active_gateway: "ashtec"`, `auto_enabled: true`. Test d'initiation avec active=ashtec → `db.payments.provider = "ashtecpay"` + vrai `transaction_id` reçu de l'API AshtecPay. Le dispatcher fonctionne parfaitement.
- ✅ **Screenshot user-side** : affiche uniquement "1️⃣ Paiement Automatique" avec description neutre "Mobile Money — Recevez la demande sur votre téléphone".
- ⚠️ **Aucun impact sur les paiements existants** : tous les paiements en `db.payments` conservent leur `provider` original ; le status polling dispatche bien selon ce champ.

### 2026-06-18 — Intégration AshtecPay (2e passerelle) + dispatcher admin-configurable
- 🎯 **Objectif** : ajouter AshtecPay comme 2e passerelle automatique sans toucher à SoleasPay. L'admin gère les 2 indépendamment (activer/désactiver + clé API + choix actif). Côté user : aucun changement — l'interface affiche toujours "Paiement Automatique".
- ✅ **Backend `ashtecpay.py` (nouveau)** : module miroir de `soleaspay.py` avec `initiate_payment()`, `verify_payment()`, `normalize_status()`. Implémente `POST /v1/collect`, `GET /v1/transaction/:id`, gère les 4 flows (USSD Push, OTP SMS, OTP USSD, Wave) et tous les codes d'erreur. Base URL configurable via `ASHTECPAY_BASE_URL` (defaults `https://ashtechpay.top`).
- ✅ **Backend `server.py` — dispatcher** :
  - `_load_payment_gateway(db)` lit `app_settings.payment_gateway` (defaults : active=soleas, ashtec_enabled=false)
  - `_mask_key(k)` pour ne jamais exposer la clé en clair côté admin GET
  - `/api/payments/soleaspay/initiate` réécrit en `dispatcher` : selon `active` + `enabled`, dispatche vers `_initiate_via_soleas()` (code original préservé verbatim) OU `_initiate_via_ashtec()`. Stocke `provider="soleaspay"|"ashtecpay"` dans `db.payments`.
  - `/api/payments/soleaspay/status/{order_id}` lit le `provider` stocké et dispatche vers `_verify_soleas_payment()` ou `_verify_ashtec_payment()`. Active activate_level avec `source="ashtecpay"` quand AshtecPay confirme. Idempotence préservée.
- ✅ **Backend endpoints admin `/api/admin/payment-gateways`** (GET + PUT) :
  - GET retourne `active`, `soleas.{enabled,configured}`, `ashtec.{enabled,configured,api_key_masked}`
  - PUT accepte `active`, `soleas_enabled`, `ashtec_enabled`, `ashtec_api_key` (avec "DELETE" pour effacer)
  - Garde-fous : au moins 1 passerelle activée, fallback auto si la `active` est désactivée
- ✅ **Frontend `(admin)/index.tsx` — onglet Réglages** : nouveau composant `PaymentGatewaysCard` en haut. Affichage par passerelle : titre, badge "PASSERELLE ACTIVE" (bordure verte), badges 🟢 Activé / ⚙️ Configuré, bouton Activer/Désactiver, bouton "⭐ Rendre active". AshtecPay : champ clé masquée + input nouvelle clé + bouton sauvegarde dédié.
- ✅ **Testé curl** : GET initial OK (soleas=active, ashtec=disabled/unconfigured) → PUT avec clé `ak_5c0a...6678` + enabled=true → GET retourne ashtec configured=true, masked key, configurable. Frontend UI confirmée par screenshot.
- ✅ **ZÉRO impact** : utilisateurs, commissions, retraits, activations, historique inchangés. Backward-compat totale : si aucune config n'est dans la DB, le système retombe automatiquement sur SoleasPay (defaults).

### 2026-06-17 — Rotation hebdomadaire 1 jour = 1 catégorie de mission
- 🎯 **Objectif** : sur 7 jours de la semaine, chaque jour ne montre QU'UNE seule catégorie (Lun→YouTube, Mar→TikTok, Mer→Instagram, Jeu→Facebook, Ven→Questionnaire). À chaque visite l'utilisateur voit AU MAX une mission — la plus ancienne non encore validée de la catégorie du jour. File de 100 missions par catégorie pour rotation sur tout l'été sans intervention admin.
- ✅ **Backend `missions.py`** :
  - `DEFAULT_SCHEDULE.day_type_map` : `{"0":"youtube", "1":"tiktok", "2":"instagram", "3":"facebook", "4":"questionnaire", "5":"", "6":""}` (admin-overridable)
  - `_today_mission_type(cfg)` : retourne le type de la catégorie du jour ou `""`
  - `_today_label(cfg)` : renvoie "Mercredi → 📸 Instagram" pour le banner
  - `list_missions` retravaillé : filtre par `type == today_type`, ignore les missions déjà complétées par l'utilisateur (idempotence LIFETIME et non plus par jour), retourne AU MAX 1 mission (la plus ancienne disponible) + `queue_remaining` pour l'admin
  - `complete_mission` : vérifie le type du jour avant validation + idempotence per-mission (vie entière)
  - `ScheduleIn.day_type_map: Optional[dict]` + validation `value ∈ MISSION_TYPES ∪ {""}`
  - GET/PUT `/admin/missions-schedule` retournent aussi `today_type` + `today_label`
- ✅ **Frontend admin `(admin)/missions.tsx`** : section "🔄 Rotation hebdomadaire" avec bannière "📍 Aujourd'hui : Mercredi → 📸 Instagram" + grille 7 lignes (Lun..Dim) × 6 chips (YouTube/TikTok/IG/FB/Quiz/Aucun) cliquables pour réassigner.
- ✅ **Frontend user `(app)/missions.tsx`** : bannière "📍 Aujourd'hui : Mercredi → 📸 Instagram" affichée + message convivial quand 0 mission disponible ("🎉 Aucune mission disponible pour vous aujourd'hui").
- ✅ **Testé curl** : Mer→Instagram + 0 mission IG en base → 0 items, message convivial. Test temporaire Mer→YouTube → 1 mission YouTube retournée + queue_remaining=1. Logic OK.

### 2026-06-17 — Retraits Missions : config admin + frais + identification claire
- 🎯 **Objectifs** : (1) Admin configure min de retrait + frais% depuis le panel. (2) Le calcul frais/net est appliqué automatiquement à chaque demande. (3) Les retraits missions apparaissent dans la **même liste admin** que les retraits commissions, avec un badge distinctif. (4) L'historique utilisateur identifie clairement "🎥 Retrait Mission" vs "🤝 Retrait Commissions".
- ✅ **Backend `missions.py`** :
  - `_load_payout_config(db)` : lit `app_settings.mission_payout` (defaults : 500 FCFA min, 10% frais)
  - `request_mission_withdrawal` : applique le min + calcule `fee` et `net_payout`, stocke `fee_percent` + `withdrawal_type="mission"` dans `db.mission_withdrawals`
  - `GET /me/mission-payout-config` (user) : retourne config pour preview UI
  - `GET /admin/mission-payout` : retourne config + stats (total, pending, validated, rejected, montants)
  - `PUT /admin/mission-payout` : validation 0 ≤ fee_percent ≤ 100, 0 ≤ min_withdrawal
  - `admin_mission_withdrawal_action` : supporte `reason` au rejet (stocké dans `reject_reason`)
- ✅ **Backend `server.py` /admin/withdrawals**: fusionne maintenant `db.withdrawals` (commissions) + `db.mission_withdrawals` (mission), chaque item porte `withdrawal_type` ∈ {"commissions", "mission"}. Tri par `created_at` desc.
- ✅ **`/admin/withdrawals/{id}/validate` & `/reject`** : extendus pour gérer les deux collections (lookup db.withdrawals d'abord, fallback db.mission_withdrawals). Refund automatique du wallet mission lors d'un rejet.
- ✅ **`/admin/stats`** : ajout sous-compteurs `withdrawals_pending_commissions` + `withdrawals_pending_missions` + bloc complet `mission_withdrawals` (total/pending/validated/rejected counts + montants brut/net).
- ✅ **`_build_transaction_history`** : inclut désormais aussi `db.mission_withdrawals` avec label "🎥 Retrait Mission (wallet)" et `meta.withdrawal_type="mission"`.
- ✅ **Frontend admin missions (nouvel onglet "💸 Config Retraits")** : bannière config actuelle, stats cards (total/pending/validated/rejected), bloc info montants, inputs min + fee%, info pédagogique, bouton sauvegarde.
- ✅ **Frontend admin retraits (`(admin)/index.tsx`)** : carte de retrait avec badge **🏆 MISSION** (jaune + bordure gauche) ou **💰 COMMISSIONS** (vert), libellé "Type de retrait" explicite ("🎥 Retrait Mission (youtube)" / "🤝 Retrait Commissions"), motif de rejet affiché.
- ✅ **Frontend user `(app)/missions.tsx`** : modal retrait avec preview en temps réel (Montant demandé / Frais (X%) / Montant net), bloc info "Minimum X • Frais Y%", bouton désactivé si < min, alerte montre montant brut + frais + net après envoi.
- ✅ **Testé curl + screenshot** : GET payout OK (config + stats agrégées), PUT 1000/12% OK, /admin/withdrawals retourne 27 items (23 mission + 4 commissions), badges visibles, distinction parfaite.

### 2026-06-16 — Missions : programmation admin + reset périodique automatique
- 🎯 **Objectif** : (1) Chaque mission ne peut être effectuée qu'une fois par utilisateur **par période** (et non plus une fois pour toujours). (2) L'admin configure les jours + heures de disponibilité depuis le panel — pas besoin de republier les vidéos chaque jour.
- ✅ **Backend `missions.py`** : helper `_load_schedule(db)` lit la config admin depuis `db.app_settings.mission_schedule` (fallback : Mon-Fri 08:00-16:00 Africa/Lome). `_window_open_for_schedule(cfg)` calcule l'état du window (jour autorisé + heure dans plage + enabled).
- ✅ **`_current_period_key(cfg)`** : retourne la date ISO dans le TZ configuré → utilisée comme clé d'idempotence par mission complétion. Reset auto à minuit dans le TZ admin.
- ✅ **`mission_completions`** stocke maintenant `period_key`. L'unicité passe de `(user_id, mission_id)` à `(user_id, mission_id, period_key)`. Quand le jour change → la mission redevient disponible.
- ✅ **`/api/missions`** retourne `window_open`, `window_label`, `period_key`, et `completed_by_user` est calculé pour la période courante uniquement.
- ✅ **`/api/missions/{id}/complete`** vérifie l'idempotence par période et retourne un 409 explicite « Mission déjà validée aujourd'hui. Revenez à la prochaine période programmée. » sinon.
- ✅ **Endpoints admin `/api/admin/missions-schedule`** (GET + PUT) avec validation : jours 0-6, format HH:MM, TZ valide via zoneinfo. ⚠️ Route nommée `-schedule` (et non `/schedule`) pour éviter le conflit avec `PUT /missions/{mission_id}`.
- ✅ **Frontend `(admin)/missions.tsx`** : nouvel onglet "⏰ Programmation" avec bannière d'état (🟢/🔴 + label complet + période active), chips jours cliquables (Lun..Dim), inputs heure début/fin, fuseau horaire, toggle activation, info bleue explicative, bouton sauvegarde.
- ✅ **Testé curl + screenshot** : GET defaults OK. PUT all-days 00:00-23:59 → window_open=true, period_key=2026-06-16, mission listée. UI admin entièrement fonctionnelle.

### 2026-06-16 — Historique complet des transactions (Admin + User)
- 🎯 **Objectif** : transparence totale. L'admin doit pouvoir voir toutes les opérations financières d'un utilisateur (commissions niveaux 1-12, parrainage direct, spillover, activations, paiements, retraits, missions). L'utilisateur doit voir ses propres commissions avec leur origine exacte.
- ✅ **Backend `_build_transaction_history(db, user_id)`** : nouvelle fonction helper qui agrège `db.commissions` + `db.activations` + `db.payments` + `db.withdrawals` + `db.mission_claims` en un format unifié, trié par date desc. Chaque commission résout `from_user_id` → `from_username` via une lookup en `db.users`.
- ✅ **Backend `/api/transactions`** (user) : réécrit pour utiliser le helper et inclure désormais les commissions et missions (auparavant seulement activations + paiements + retraits).
- ✅ **Backend `/api/admin/users/{user_id}/transactions`** : nouvel endpoint admin qui retourne la même shape pour n'importe quel utilisateur.
- ✅ **Labels intelligents** : `direct` → "Parrainage Direct", `spillover_sponsor` → "Commission Spillover (Parrain)", `spillover_beneficiary` → "Commission Spillover (Bénéficiaire)", chaque label suffixé par "— Niveau N".
- ✅ **Frontend `(app)/transactions.tsx`** : ajout du filtre 💰 Commissions et 🏆 Missions. Carte commission affiche Provenance (username + ID), Niveau concerné, Solde profit, Réserve mise à niveau.
- ✅ **Frontend `(admin)/user/[id].tsx`** : nouvel onglet "📊 Historique" avec recherche (nom/ID/montant/type) + filtres + carte détaillée pour chaque transaction (label, date, montant, statut, provenance, niveau).
- ✅ **Testé curl + screenshot** : 14 transactions correctement agrégées (6 spillover_sponsor + 2 direct + 5 payment + 1 withdrawal). UI admin + user OK.

### 2026-06-16 — Compteur "Activations à valider" inclut maintenant les auto + manuel
- 🎯 **Objectif** : la statistique du dashboard admin doit comptabiliser **toutes** les activations non validées (manuelles + automatiques), pas seulement les manuelles.
- ✅ **Backend `/admin/stats`** : `activations_pending` est maintenant la somme de `db.activations(status=pending)` + `db.payments(provider=soleaspay, status=pending OR (status=paid AND activation_done!=true))`. Ajout aussi des sous-compteurs `activations_pending_manual` et `activations_pending_auto` pour le debug/futur split UI.
- ✅ **Backend `total_activations_amount`** : inclut désormais aussi les paiements auto validés (`db.payments.activation_done=true`) en plus de `db.activations(status=validated)`.
- ✅ **Frontend** : aucun changement requis — la StatCard "Activations à valider" lit `stats.activations_pending` qui inclut maintenant les deux types.
- ✅ **Testé curl** : avant insertion → 8 manuel + 0 auto = 8. Après insertion de 2 auto pending (1 status=pending, 1 status=paid+activation_done=false) → 8 manuel + 2 auto = **10**. Bingo.

### 2026-06-16 — Valider/Rejeter universel + Suppression d'utilisateurs
- 🎯 **Objectif** : (1) Permettre à l'admin de valider/rejeter aussi les paiements automatiques (pas seulement les bloqués). (2) Pouvoir supprimer des utilisateurs de test proprement (DB preview + endpoint pour la prod).
- ✅ **Backend `/admin/activations/{id}/validate`** : étendu pour gérer aussi `db.payments.reference` (SoleasPay). Si l'id correspond à un paiement auto pending : appelle `activate_level`, marque `status="paid"`, `activation_done=true`, `validated_at`, `validated_by`. Idempotent : si l'utilisateur est déjà au niveau requis, réconcilie le flag sans erreur.
- ✅ **Backend `/admin/activations/{id}/reject`** : étendu pour gérer aussi `db.payments.reference`. Marque le paiement auto comme `status="failed"`, ajoute `activation_error="Rejeté par l'admin <username>"`. Refuse si `activation_done=true`.
- ✅ **Backend `DELETE /admin/users/{user_id}`** : nouvel endpoint qui hard-delete un user + ses données reliées (payments, activations, withdrawals, matrix positions, mission_claims, notifications). Garde-fous : interdit pour admin, interdit si max_level>0 (intégrité matrice). Réassigne les filleuls (sponsor_id) à l'admin pour éviter les références orphelines. Log dans `admin_logs` avec métadonnées détaillées.
- ✅ **Frontend `(admin)/index.tsx`** : carte d'activation auto affiche maintenant **Valider** + **Rejeter** en plus du bandeau d'attente + bouton "🚨 FORCER L'ACTIVATION" (si bloqué). Tous les paiements (auto/manuel/crypto) ont la même UX de validation.
- ✅ **Nettoyage preview** : `teste1` et `alice3f5618` supprimés. 4 paiements + 1 activation effacés. Le filleul `bob3f5618` a été réassigné à l'admin (`sponsor_id` mis à jour).
- ✅ **Tests curl E2E** : Validate auto payment → user max_level passe à 1 et statut "active", payment.activation_done=true. Reject auto payment → payment.status="failed", activation_error populated.
- 📝 **Pour la prod** : appeler `DELETE /api/admin/users/{user_id}` avec le token admin. Récupérer l'id via `GET /api/admin/users?q=teste1` ou `q=alice3f5618`.

### 2026-06-16 — Vue unifiée admin (Auto + Manuel + Crypto) + correction "Invalid Transaction informations"
- 🎯 **Objectif** : aucun paiement ne doit être perdu. Les paiements automatiques SoleasPay doivent apparaître dans la même liste admin que les paiements manuels/crypto, avec un badge distinctif et un bouton "Forcer l'activation" si l'auto-activation a échoué.
- ✅ **Backend `/admin/activations` (server.py L1403)** : endpoint réécrit pour **fusionner** `db.activations` (manual + crypto) + `db.payments` (provider='soleaspay'). Chaque entrée porte `payment_method` ∈ {automatic, manual, crypto}, `is_stuck` (auto payé mais non activé), `reference`, `transaction_ref`. Mapping statut : pending=pending, paid+activation_done=validated, paid+!activation_done=pending (bouton force-activate), failed=rejected.
- ✅ **Frontend `(admin)/index.tsx`** : nouveau composant `MethodBadge` (AUTO ⚡ bleu / MANUEL 💳 vert / CRYPTO ₿ orange). Card d'activation enrichie : libellé "Automatique (SoleasPay)", référence interne, bandeau "En attente de confirmation sur le téléphone du client…" pour les auto pending, bouton "🚨 FORCER L'ACTIVATION" pour les auto bloqués (POST `/admin/payments/{ref}/reprocess`).
- 🐛 **Bug corrigé "Invalid Transaction informations"** : SoleasPay renvoie ce message en anglais (`{success:False, message:'Invalid Transaction informations'}`) tant que la transaction n'est pas encore reconnue côté serveur (transient pendant le polling). Notre code l'expédiait au client via le champ `message` du status polling, et l'utilisateur voyait ce texte au lieu du message français. Fix : on n'envoie plus le message brut de SoleasPay quand `new_status="pending"`, on force "Confirmation en attente sur le téléphone du client…" (server.py L2336).
- ✅ **Testé curl** : `/api/admin/activations` retourne 12 items (2 auto + 4 manual + 4 crypto + 2 legacy mobile_money) avec tous les champs nécessaires. UI confirmée par screenshot (badge AUTO visible, libellé français, référence affichée).

### 2026-06-15 — UX success SoleasPay : redirection automatique fluide vers `/services`
- 🎯 **Objectif** : après confirmation du paiement SoleasPay, l'utilisateur voit un écran de succès clair puis est redirigé automatiquement vers `/services` sans aucune popup bloquante.
- ✅ **Frontend `activation.tsx` (SoleasPollingView lignes 1007-1045)** : nouvelle carte de succès (icône check verte, "🎉 Mon compte est activé !", niveau activé, CTA "Accéder à mon espace (Xs)") avec **countdown 3→2→1** et texte "Redirection automatique dans X seconde…".
- 🐛 **Bug corrigé (callback `onActivated`)** : remplacé `window.alert(...) + window.location.href = "/services"` par `refresh()` + `router.replace("/services")`. L'ancien `window.alert` était **bloquant** : la popup empêchait l'auto-redirection de s'exécuter avant un clic OK manuel de l'utilisateur.
- ⚠️ **Note opérationnelle** : Metro bundler peut servir un bundle obsolète après modification d'`activation.tsx` (1133 lignes). Toujours `rm -rf /app/frontend/.metro-cache /app/frontend/.expo && sudo supervisorctl restart frontend` après une édition majeure de ce fichier.
- ✅ **Tests E2E (iteration_10→12)** : countdown OK, dialog_count=0, redirection vers `/services` confirmée en ~3.5s. Success rate 100%.

### 2026-06-15 — Fix activation automatique après paiement SoleasPay
- 🐛 **Bug corrigé** : après paiement SoleasPay confirmé, le statut utilisateur restait "pending". Cause racine identifiée :
  - `normalize_status` ne reconnaissait que 3 mots-clés stricts (`SUCCESS`/`SUCCÈS`/`VALIDATED`) ; or l'API peut renvoyer d'autres synonymes (`COMPLETED`, `APPROVED`, `PAID`, etc.).
  - Aucune idempotence dans le polling : si `activate_level` levait "niveau déjà activé" (suite à un précédent appel partiel), le `payments.activation_done` restait `false` pour toujours.
- ✅ **Fix dans `soleaspay.py::normalize_status`** : étendu à 12 mots-clés de succès + 8 d'échec, **mode permissif** activé : si `success=true` + `code=200` + statut textuel inconnu → traité comme `paid`.
- ✅ **Fix dans `/payments/soleaspay/status/{order_id}`** : avant d'appeler `activate_level`, on vérifie si `user.max_level >= payment.level` (idempotence). Si oui → on reconcilie `activation_done=true` + force `status="active"` (défensif). Après `activate_level`, double-check que `user.status` est bien "active". Logs détaillés ajoutés.
- ✅ **Tests** : `tests/test_soleaspay_activation.py` 6/6 PASS (normalize permissif + activation directe via source='soleaspay'). Total : 19/19 PASS.

### 2026-06-15 — Migration SendavaPay → SoleasPay v3 (polling, sans webhook)
- 🎯 **Architecture** : SoleasPay envoie un **prompt Mobile Money sur le téléphone** de l'utilisateur (pas de redirection). Backend poll `/api/agent/verif-pay` toutes les 5s jusqu'à `status=SUCCESS` → activation automatique.
- ✅ **Backend `/app/backend/soleaspay.py`** : module avec `initiate_payment()`, `verify_payment()`, mapping pays→services (TG/BJ/CI/BF/CM/COG/GAB/UGA), exclusion RDC (`COD`) selon règle métier.
- ✅ **Endpoints** : `POST /api/payments/soleaspay/initiate` (déclenche USSD), `GET /api/payments/soleaspay/status/{order_id}` (poll → activate au passage SUCCESS).
- ✅ **Suppressions** : fichier `sendava_pay.py` supprimé, toutes les routes SendavaPay (`/payments/sendava/*`, `/sendavapay-webhook`, `/webhooks`), variables `.env` `SENDAVAPAY_*`.
- ✅ **Frontend `/activation.tsx`** : nouveau UI avec sélecteur pays + opérateur (services chargés dynamiquement depuis `/api/settings/payments`), saisie téléphone, bouton "📱 Envoyer la demande". Composant `SoleasPollingView` qui poll toutes les 5s pendant 5 min, affiche "Vérifiez votre téléphone", redirige vers `/services` à confirmation.
- ✅ **`.env`** : `SOLEASPAY_API_KEY=cBtrxQKGJa...`, `SOLEASPAY_SUCCESS_URL=https://spiloveure.com/services`, `SOLEASPAY_FAILURE_URL=https://spiloveure.com/activation`.
- ✅ **E2E réel contre l'API SoleasPay** : initiate retourne `transaction_id=MLS...` réel, status poll fonctionne, exclusion COD vérifiée (400), 36/36 tests pytest PASS.
- ℹ️ **Pas de clé secrète requise** : architecture polling-based (pas de webhook → pas de vérification HMAC nécessaire).

### 2026-06-15 — Page admin "Paiements SendavaPay" + idempotence reprocess
- ✅ **Backend `GET /api/admin/payments`** : liste paginée avec filtres (`status`, `stuck_only`, `q` recherche par référence/username/transaction_id). Retourne `{items, count, counts:{total,pending,paid,failed,stuck}}` pour les badges UI.
- ✅ **Frontend `/(admin)/payments.tsx`** : grille de stats (5 compteurs), 5 chips de filtre, barre de recherche temps réel, cards par paiement avec badge de statut, bouton "🚨 FORCER L'ACTIVATION" sur les paiements bloqués, lien "Ouvrir la page de paiement" pour les pendants. Bouton d'accès `admin-open-payments-mgmt` ajouté au dashboard admin.
- 🐛 **Bug corrigé — idempotence** : `place_in_matrix` lève désormais une placement existante au lieu de raise `E11000 duplicate key`. Le endpoint `reprocess` détecte aussi le cas où `user.max_level >= payment.level` (activation déjà faite ailleurs) et reconcilie le flag `activation_done=true` sans relancer `activate_level`.
- ✅ **Tests** : 36/36 PASS (2 nouveaux dans `test_reprocess_idempotency.py` : placement idempotent + reprocess reconciliation).

### 2026-06-15 — Migration totale vers SendavaPay (suppression WestPay / SecurePay)
- 🎯 **Objectif** : remplacer toutes les passerelles automatiques (WestPay, SecurePay) par la nouvelle intégration SendavaPay avec les credentials fournis par l'utilisateur.
- ✅ **Backend — suppressions** :
  - Fichier `secure_pay.py` supprimé.
  - 515 lignes retirées de `server.py` : routes `/payments/secure/initiate`, `/payments/secure/status`, `/payments/secure/webhook`, `/payments/secure/verify/{ref}`, `/payments/westpay/initiate`, `/westpay-webhook`, `/settings/westpay` (public), admin `/settings/secure-payment`, admin `/settings/westpay`, classes `InitiatePaymentIn`/`WestpayAutoSettings`/`SecurePaymentSettings`/`WestpayInitiateIn`, fonctions `_process_payment_event`. Conservés : `_new_order_id`, `_record_payment_event`, `/payments/{ref}/status` (utilisés par SendavaPay).
  - `.env` : retiré `WESTPAY_*` (8 clés) et `SECURE_PAY_*` (2 clés).
- ✅ **Backend — nouvelles credentials SendavaPay** : `SENDAVAPAY_API_KEY=pk_live_4RPwLobC1oMuOXdEmlo0DoPk7plpL9wt`, `SENDAVAPAY_WEBHOOK_SECRET=whsec_7d1cd59d560fc9e4cb38b1b3ee9a873fbe682c45fa948807`, `SENDAVAPAY_SUCCESS_URL=https://spiloveure.com/services`.
- ✅ **Backend — schéma `/api/settings/payments` mis à jour** : retourne `{sendava_enabled, sendava_excluded_countries, manual_enabled, crypto_enabled, crypto?}`. Plus de `secure_*` / `westpay_*`.
- ✅ **Frontend `/activation.tsx`** : `paymentMode` union passée de `westpay|manual|crypto` à `sendava|manual|crypto`. Tous les `westpay*` state/JSX/testIDs renommés `sendava*` (testIDs : `mode-sendava`, `sendava-country-{CC}`, `sendava-phone`, `sendava-submit`). L'appel POST cible `/payments/sendava/initiate`. L'appel obsolète à `/settings/westpay` est retiré.
- ✅ **Frontend `/(admin)/index.tsx`** : retrait du card `Paiement sécurisé Mobile Money (WestPay)` (avec `sp-toggle-enabled`/`sp-save-btn`), retrait du card `admin-westpay-card` (avec `wp-enabled-toggle`/`wp-save`), retrait des appels `/admin/settings/secure-payment` et `/admin/settings/westpay` dans `load()`, retrait des states `spEnabled/spSaving/wpEnabled/wpSaving`.
- ✅ **E2E validé** :
  - `POST /api/payments/sendava/initiate` retourne une URL réelle `https://sendavapay.com/pay/api/pay_...` (testé contre l'API SendavaPay en sandbox/prod).
  - Webhook HMAC-SHA256 : signature invalide → 401, signature valide → 200 + dispatch.
  - Toutes les anciennes routes `/payments/secure/*`, `/payments/westpay/*`, `/settings/westpay`, admin secure/westpay → 404.
  - 34/34 tests pytest PASS (régression complète OK).
- ⚠️ **Action côté SendavaPay dashboard** : l'utilisateur a configuré le webhook URL à `https://spiloveure.com/webhooks/sendavapay`, mais le k8s ingress ne route que `/api/*` vers le backend. **L'utilisateur doit changer le webhook URL dans son dashboard SendavaPay vers `https://spiloveure.com/api/sendavapay-webhook`** (ou alternativement `https://spiloveure.com/api/webhooks`, les deux fonctionnent).

### 2026-06-15 — Outil d'audit & correction rétroactive des réserves d'upgrade (production-ready)
- 🎯 **Objectif** : permettre la correction rétroactive des utilisateurs déjà impactés par le bug "manual upgrade ne débite pas la réserve" (qui a sévi avant le fix du 14/06).
- ✅ **Module backend** `/app/backend/upgrade_audit.py` :
  - Calcul d'écart par user : `balance_upgrade_attendu = Σ(commissions.upgrade_share) − Σ(prix niveaux 2..max_level)`. Si écart > 1 FCFA → sur-crédité.
  - Détection des utilisateurs bloqués (réserve suffisante + matrice remplie mais non upgradés).
  - Correction : débit atomique conditionnel (`$gte` + `$inc`) + `try_auto_upgrade` cascadé. Persistance dans `upgrade_audit_log`.
- ✅ **3 endpoints admin-only (sans UI, appelables via curl/Postman)** :
  - `GET /api/admin/upgrade-audit` → rapport read-only (JSON)
  - `POST /api/admin/upgrade-audit/apply?dry_run=true|false&fix_over_credited=&trigger_stuck=` → simulation puis application
  - `GET /api/admin/upgrade-audit/log?limit=200` → historique des corrections appliquées
- ✅ **Guide opérationnel production** : `/app/memory/UPGRADE_AUDIT_PROD_GUIDE.md` — workflow étape-par-étape avec curl, pour exécution sur `spiloveure.com` après redéploiement.
- ✅ **Validation E2E preview** :
  - Cas sur-crédité (7000 FCFA réserve, max_level=3 avec 7 commissions = upgrade_share 7000) → détecté + débité de 3000 → balance final 4000 ✅
  - Cas bloqué (1000 réserve, matrice remplie au L1, niveau L1) → détecté + auto-upgradé vers L2, réserve 0 ✅
  - Audit final : 0 anomalies ✅
- ✅ **Tests** : 15/15 PASS (`test_upgrade_audit.py` 4 nouveaux + `test_manual_upgrade_debit.py` 11 régression).
- ✅ **Backup automatique** : `/app/backups/dump_20260615_080632`.
- 🔒 **Garanties** : `balance_profit`, `commission_*`, `commissions[]`, `activations[]` ne sont JAMAIS modifiés. Seul `balance_upgrade` est ajusté + `max_level` augmenté via `try_auto_upgrade`. Toute action est journalisée.

### 2026-06-14 (correctif missions + cleanup audit)
- 🐛 **Bug corrigé — Enregistrer une mission ne fonctionnait pas** : sur la page Admin → Gestion des Missions, le formulaire de création échouait silencieusement. Cause racine : (a) `Alert.alert()` de React Native ne fonctionne pas sur Web, donc les erreurs Pydantic (422) étaient invisibles ; (b) les champs `duration_seconds` et `reward` vides envoyaient `""` au backend, échouant `int_parsing`.
- ✅ **Fix dans `/(admin)/missions.tsx`** : validation frontend (titre obligatoire, durée 0-3600, récompense ≥ 0), coercion stricte avec `parseInt`/`parseFloat` + `Number.isFinite`, et toutes les notifications passent par `window.alert` (visible sur Web) avec fallback `Alert.alert` natif.
- ✅ **Cleanup — Page Audit supprimée** : suppression du panneau Audit & Correction (était une mauvaise interprétation de la demande utilisateur). Fichiers supprimés : `audit_admin.py`, `audit.py`, `tests/test_audit.py`, `frontend/app/(admin)/audit.tsx`. Bouton `admin-open-audit` retiré du dashboard admin. Routes `/api/admin/audit*` désormais 404.
- ✅ **Tests** : 8/8 PASS backend (iteration_7) + Playwright E2E confirmé pour les 3 cas (titre vide, formulaire valide, durée vide).

### 2026-06-14 (correctif critique) — Débit de la réserve sur upgrade manuel utilisateur
- 🐛 **Bug corrigé** : quand l'utilisateur cliquait « Activer Niveau N » depuis `/matrices` (endpoint `/api/activations/request` → `activate_level(source="manual")`), le niveau s'activait MAIS `balance_upgrade` n'était PAS débité. La réserve constituée pour cet upgrade restait dans le compte.
- ✅ **Fix dans `matrix.py::activate_level`** : la liste des sources qui consomment la réserve est élargie à `("auto_upgrade", "manual", "admin_manual")`. Sources strictes (raise si insuffisant) : `auto_upgrade` + `manual`. Source permissive (admin override) : `admin_manual`. Sources externes (`secure_pay`, `gateway_return`, `sendavapay`, `manual_reprocess`, `admin_validate`) continuent de ne PAS toucher la réserve.
- ✅ **Tests** : `/app/backend/tests/test_manual_upgrade_debit.py` 11/11 PASS (ajout de 2 cas user manual). E2E HTTP : user avec `balance_upgrade=1000, max_level=1` → après `POST /api/activations/request {level:2}` → `balance_upgrade=0, max_level=2`.

### 2026-06-14 (suite) — [SUPPRIMÉ] Audit & Correction Plateforme
- ❌ Le panneau d'audit ajouté précédemment a été retiré le 2026-06-14 sur demande de l'utilisateur (mauvaise interprétation : l'utilisateur voulait juste que les bugs soient corrigés, pas un outil dédié dans l'admin panel). Voir bloc « cleanup audit » ci-dessus.

### 2026-06-14 — Missions Rémunérées Phase 2 (retraits par portefeuille + admin)
- ✅ **User /missions** : 5 cartes de portefeuilles (YouTube / TikTok / Instagram / Facebook / Questionnaire) avec bouton « Retirer » désactivé si solde 0. Modal de retrait propre à chaque portefeuille (`mission-withdraw-modal`) avec contrôle de solde immédiat. Onglet « Historique » : liste des demandes de retrait (statut En attente / Validé / Rejeté) + missions validées.
- ✅ **Admin /(admin)/missions** : refonte en 3 onglets — `Missions` (CRUD + recherche + MediaUploader vidéo intégré au formulaire), `Retraits` (filtres pending/validated/rejected/toutes + actions ✓/✗ inline), `Stats` (totaux + ventilation par type).
- ✅ **Backend** : endpoints publics `/api/me/mission-wallets|mission-withdrawals|mission-history` et admin `/api/admin/mission-withdrawals[?status=]` + `/api/admin/mission-withdrawals/{id}/action` (validate/reject). Rejet → remboursement automatique du portefeuille. Validate → conservation des fonds réservés. Idempotence (double action → 400).
- ✅ **Sécurité concurrence** : update atomique conditionnel (`$gte` + `modified_count`) pour la décrémentation du solde → pas de race-condition sur requêtes simultanées.
- ✅ **Tests** : `/app/backend/tests/test_mission_withdrawals.py` 19/19 PASS (testing_agent_v3_fork iteration_5). UI admin validée e2e via Playwright. UI user code-reviewed (pas de user non-admin seedé).

### 2026-06-11 (suite 3) — Intégration SendavaPay (dépôt automatique)
- ✅ Nouveau module `/app/backend/sendava_pay.py` : `create_payment`, `verify_payment`, `verify_webhook_signature` (HMAC-SHA256 hex avec support multi-format `sha256=…` et stripe-style `t=…,v1=…`), `parse_webhook_event`
- ✅ Endpoints backend :
  - `POST /api/payments/sendava/initiate` (user auth) — bloque RDC Congo, crée le paiement SendavaPay, retourne `payment_url`
  - `POST /api/sendavapay-webhook` — HMAC sécurisé + persistance `webhook_logs` + activation idempotente
  - `GET /api/sendavapay-webhook` — probe JSON (preuve backend)
- ✅ `.env` : `SENDAVAPAY_BASE_URL`, `SENDAVAPAY_API_KEY`, `SENDAVAPAY_WEBHOOK_SECRET` (whsec_…)
- ✅ Frontend `activation.tsx` : nouvelle carte 1️⃣ "Paiement Automatique (SendavaPay)" avec sélecteur pays (16 pays, RDC Congo exclu) + numéro de téléphone + bouton "PAYER MAINTENANT" → redirige sur l'URL SendavaPay
- ✅ Tests E2E backend : RDC bloquée 400, payment created (URL réelle SendavaPay), webhook 401 sans signature, 200 + activation niveau avec signature valide, idempotence OK

### 2026-06-11 (suite 2) — Upload de médias depuis l'appareil admin
- ✅ **Backend** : `POST /api/admin/uploads` (multipart) + static mount `/api/uploads/<file>` via FastAPI StaticFiles. Allowlist d'extensions (image, vidéo, audio, PDF, APK). Limite 100 MB. Audit dans `media_uploads` MongoDB.
- ✅ **Composant `MediaUploader`** : bouton "Importer" + aperçu instantané (miniature image ou icône typée) + bouton "Effacer". Web-only via `<input type="file">`.
- ✅ **Admin Panel /content** : Formations (image, vidéo, PDF, audio), E-Books (image, PDF), Apps Premium (logo, APK) — chaque champ URL conserve aussi sa saisie manuelle (lien externe).
- ✅ **Helper `resolveMediaUrl`** : convertit les URL relatives `/api/uploads/...` en absolues avec le `EXPO_PUBLIC_BACKEND_URL`. Appliqué côté admin (thumbs) et user (Formations, E-Books, Premium Apps).
- ✅ Test E2E : upload PNG 64×64 → URL retournée + image affichée + URL persistée + servable via CDN backend.

### 2026-06-11 (suite) — Webhook WestPay sécurisé + auditable
- ✅ **Nouvel alias `/api/westpay-webhook`** (POST + GET) en plus de `/api/webhook` et `/api/payments/secure/webhook`. GET retourne JSON pour prouver le routage backend.
- ✅ **Log MongoDB `webhook_logs`** : chaque hit (body, headers, IP, signature, statut traitement) persisté pour audit.
- ✅ **Endpoint admin `/api/admin/webhook-logs`** pour consulter les 50 derniers webhooks.
- ✅ **Sécurité HMAC-SHA256** déjà en place via `WESTPAY_WEBHOOK_SECRET`. Rejet 401 si signature invalide.
- ✅ **Idempotence** : `_process_payment_event` ignore les ré-envois (statut final paid/failed inchangé).
- ✅ **Activation auto** : à `payment.confirmed`, `activate_level()` est appelé une seule fois (`activation_done=true`).
- ⚠️ **Le webhook actuel reçu par l'utilisateur retourne HTML** → URL configurée chez WestPay est INCORRECTE. À corriger côté dashboard WestPay.

### 2026-06-11 — Popup Communauté + FAB Service Client
- ✅ **Popup Communauté Officielle** : modal centré qui s'affiche automatiquement après login utilisateur. Logo, bannière image, titre, description, bouton CTA "🚀 REJOINDRE MAINTENANT" → ouvre Telegram. Countdown auto-close + bouton ✕. Vu 1×/session (sessionStorage).
- ✅ **FAB Service Client** : bulle ronde bleue (gradient + icône casque) bottom-right, visible sur toutes les pages `(app)`. Click ouvre menu vertical avec WhatsApp / Telegram / Email (n'affiche que les canaux configurés). Animation slide + fade.
- ✅ **Admin Panel** : section "📢 Popup Communauté Officielle" (toggle, titre, description, image, telegram, libellé bouton, durée). Réutilise les champs support_links existants pour le FAB.
- ✅ Backend endpoints `/api/settings/community-popup` (public GET) + `/api/admin/settings/community-popup` (GET/PUT)

### 2026-06-10 — Plage horaire des retraits + Recherche admin
- ✅ **Plage horaire des retraits** : admin configure jours (Lun-Dim) + heure d'ouverture/fermeture (HH:MM, fuseau Africa/Lomé). Backend bloque automatiquement les requêtes hors plage avec message FR détaillé. WithdrawalSettings étendu (allowed_days, open_time, close_time, timezone). UI utilisateur affiche "💳 Horaires de retrait" sur `/withdrawal` + bouton désactivé + bannière 🚫 si fermé.
- ✅ **Recherche instantanée Admin** : barres de recherche dans Activations + Retraits (nom, ID, téléphone, référence, hash TXID, adresse wallet). Bouton ✖️ pour effacer.
- ✅ **Bouton Retour ⬅️** dans l'en-tête Admin (revient au Dashboard si onglet ≠ dashboard, sinon back/services)

### 2026-06-09 — 3 correctifs validés (testing agent iteration_4: 17/17 PASS)
- ✅ Auto-upgrade en cascade fixé : boucle `for _ in range(12)` dans `distribute_commission` (matrix.py l.190-198), passe N→N+1→… tant que balance_upgrade suffit et matrice remplie
- ✅ Hash TXID crypto visible dans Admin Panel : section dédiée + bouton copier (admin/index.tsx l.413-430, testID `admin-copy-tx-{id}`)
- ✅ Wallet UI dynamique Mobile Money ↔ Crypto USDT BEP20 : 2 modes commutables (testID `wallet-method-mobile`/`wallet-method-crypto`), `WalletIn` étendu (method, network, wallet_address), `/api/wallet` valide & nettoie champs de l'autre méthode, `/api/withdrawals` propage `method/network/wallet_address` en DB pour vue admin

### Historique
- ✅ Auth complet + cache token in-memory (fix race-condition login 401)
- ✅ Matrice binaire 12 niveaux + auto-upgrade en cascade
- ✅ Activations manuelles (admin) + automatiques (AshTechPay)
- ✅ Wallet + retraits
- ✅ Tableau de bord financier complet
- ✅ Logique commission (4/4 tests + 12/12 testing agent)
- ✅ Paiement manuel restrict par pays + flow d'enregistrement automatique
- ✅ Équipe directe (arbre binaire visuel) + Détails d'équipe (tabs N1..N12)
- ✅ Historique transactions unifié, Admin panel complet
- ✅ Logo Spiloveure intégré partout (login, register, dashboard, activation, icon, splash, favicon)
- ✅ backend/.env unquoted + .gitignore corrigé
- ✅ **Nouvelle page d'accueil `/services` après login** (post-activation):
    - Profile card (avatar initiales colorées 2 lettres ou avatar_url, username, statut, niveau)
    - 4 tiles services orange (Formation, E-Book, App Premium, Trading) + badge "Bientôt"
    - Hero bleu "Nos services supplémentaires" → bouton DÉCOUVRIR NOS SERVICES → /dashboard
    - Section présentation avec mission
- ✅ **4 modules digital_content** (URLs externes):
    - GET/POST/PUT/DELETE /api/admin/formations|ebooks|premium-apps
    - PUT /api/admin/settings/trading (telegram_url + enabled + label + description)
    - Public endpoints filtrent enabled=true uniquement
    - PUT /api/users/me/avatar (avatar_url)
- ✅ **Pages user** /formations, /ebooks, /premium-apps, /trading
- ✅ **Page admin** `/(admin)/content` avec 4 onglets CRUD + bouton orange "Gestion des contenus" sur dashboard admin
- ✅ Auto-availability : section apparaît dès qu'admin ajoute du contenu enabled ; sinon EmptySoon "🚧 Bientôt disponible"
- ✅ Indexes MongoDB

## API Key Endpoints
- `POST /api/auth/login|register|change-password|confirm-password`
- `GET /api/dashboard|team/direct|team/tree|team/level?level=N`
- `POST /api/activations/request` (L1 manuel admin, L2+ auto)
- `POST /api/payments/secure/initiate|webhook|verify/{ref}` (AshTechPay)
- `POST /api/withdrawals` + `GET /api/withdrawals/mine`
- Admin: `/api/admin/users|activations|withdrawals|settings/*|stats|logs`

## DB Schema clés
- `users`: id, email, username, role, status, max_level, sponsor_id, sponsor_username, balance_profit, balance_upgrade, commission_direct, commission_spillover, total_earned, total_withdrawn
- `matrix_placements`: user_id, parent_id (placement matrice), leg (left/right), sponsor_id, level, is_spillover (parent_id ≠ sponsor_id)
- `payments`: reference (SPV-...), transaction_id, status (pending/paid/failed), amount, currency, level, events[], activation_done
- `commissions`: user_id, from_user_id, level, kind (direct/spillover_sponsor/spillover_beneficiary), amount, upgrade_share, profit_share
- `app_settings`: _id ∈ {manual_payment, withdrawal_settings, support_links}

## Test credentials
Voir `/app/memory/test_credentials.md`. Admin: `kossikotokou4@gmail.com` / `@Emma91972006`.

## Roadmap / Backlog
- **P1** : Test E2E du flux de paiement automatique WestPay (RobotPay) avec clés pays réelles.
- **P1** : Test E2E complet du flux dépôt + retrait Crypto USDT BEP20 (admin valide → user reçoit).
- **P1** : Restaurer `admin.max_level=12` en prod (actuellement 2 — bloque tests commissions L3+).
- **P2** : Notifications (email/push) sur validations admin.
- **P2** : Déploiement public sur `*.emergent.host` + DNS `spiloveure.com`.
- **P3** : Localisation EN + autres langues.
- **P3** : (Optionnel) Harmoniser le label admin "Réglages" ↔ "Paramètres" si exigence stricte.

## Known caveats
- Metro tourne en `CI=1` mode (pas de watch). Un changement de code peut nécessiter `supervisorctl restart frontend` pour purger le cache de bundle SSR.
- AsyncStorage web v2 stocke dans `localStorage` (clé `auth_token`, valeur JSON.stringified).
- React Native `Alert.alert` ne fonctionne pas sur Expo Web — utiliser `window.confirm`/`window.alert` côté web.
