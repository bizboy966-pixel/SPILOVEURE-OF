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

## Implementation Status (à jour 2026-06-15)
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
