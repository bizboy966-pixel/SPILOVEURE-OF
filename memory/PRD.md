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

## Implementation Status (à jour 2026-06-11)
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
