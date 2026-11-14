# Inscription et sessions — contrat d’intégration

Le formulaire est conservé avant paiement (choix utilisateur). Nouveau parcours : landing actuelle → `/welcome` → `/choose-country` → `/registration-email` → formulaire `/register?via=landing&flow=2&country=…&email=…&ref=…` prérempli, sans mot de passe → `/pay`. Conserver le parrainage obligatoire actuel ; ne jamais inventer un parrain. Les nouvelles inscriptions sont suspendues explicitement si l’envoi n’est pas configuré ou si `IDENTITY_REGISTRATION_ENABLED=0`, pour éviter de faire payer un nouvel utilisateur qui ne pourrait ensuite pas vérifier son adresse.

Tous les chemins API ci-dessous sont précédés de `/api`. Réponses non mises en cache. Aucun code de vérification n’est renvoyé au navigateur.

## Compte principal

`POST /auth/register` conserve les champs pseudo/e-mail/pays/téléphone/parrain/conditions, mais ne demande plus de mot de passe. Retour `{access_token, user}` : jeton **onboarding uniquement**, conservé dans `auth_token` comme aujourd’hui. Tous les nouveaux comptes sont marqués `auth_flow_version: 2`, sans mot de passe initial. Les comptes historiques et leurs mots de passe restent inchangés.

`user` ajoute `auth_flow_version?: number`, `email_verified?: boolean`, `main_password_created?: boolean`.

Le jeton d’onboarding ne donne accès qu’aux routes de préparation/paiement/activation et d’identité autorisées par le serveur. Ce n’est pas une session de tableau de bord.

## Identité et vérification

Le client général `api` transmet son jeton principal existant. Ajouter `credentials: "include"` aux requêtes d’identité. Les endpoints d’identité acceptent le jeton principal/onboarding ou, à défaut, le cookie Chat valide.

`GET /identity/state` → `{user, email_verified, activated, password_created, chat_authenticated, main_authenticated}`. Sans identité : 401 avec message propre à l’identité. Ajouter `?source=chat` pour sélectionner exclusivement le compte du cookie Chat lors d’un retour du Chat, même si un autre compte principal est ouvert.

`POST /identity/email/request` avec `{email?: string}` → `{challenge_id, expires_in: 600, resend_after: 60}`. Avec une identité connue, utiliser exclusivement son adresse. Sans identité, demander une adresse pour récupérer l’accès au Chat. Une adresse inconnue produit une réponse neutre, sans création ni association de compte. L’absence de service d’envoi configuré ou son échec produit une erreur 503 explicite, jamais un faux succès.

`POST /identity/email/verify` avec `{challenge_id, code: string}` → même état que `/identity/state`, avec cookie Chat établi. Code strictement six chiffres, usage unique, 10 minutes, 5 essais maximum. Après succès, appeler le rafraîchissement du contexte Chat puis ouvrir `/messenger`.

`POST /identity/chat/open` sans corps → état avec cookie Chat établi si un jeton principal complet est valide et l’e-mail déjà vérifié. Un jeton d’onboarding seul ne suffit pas à ouvrir une nouvelle session, même si un autre appareil a entre-temps vérifié cette adresse. Avec un cookie Chat déjà valide pour ce même compte, le jeton d’onboarding peut réutiliser la session. Cela évite le pré-détournement d’un compte inscrit avec l’adresse d’autrui.

## Mot de passe et retour au compte principal

`/account-access` est hors du groupe protégé `(app)`. Appelé depuis Chat avec `?source=chat`.

- Non activé : aller à `/pay`. Si le principal a expiré, `POST /identity/onboarding-session?source=chat` donne `{access_token,user}` limité au paiement ; adopter ce jeton avant `/pay`.
- Activé, e-mail non vérifié : passer par `/verify-email` avec retour vers `/account-access`.
- Activé, mot de passe non créé : afficher deux saisies, `POST /identity/password` avec `{password,password_confirm}` → `{access_token,user}`. La création est autorisée une seule fois, après activation confirmée en base et avec une session Chat vérifiée pour ce même compte sur cet appareil.
- Activé, mot de passe créé : une seule saisie, `POST /identity/unlock` avec `{password}` → `{access_token,user}`.
- Pour les deux POST depuis le Chat, ajouter `?source=chat` afin d’éviter toute confusion de comptes.
- Adopter la réponse dans le contexte Auth principal puis aller au dashboard. Ne pas modifier les règles d’expiration existantes.

Après succès d’un paiement, le guard `(app)` peut rediriger un nouveau compte activé vers `/account-access` au lieu du dashboard, même si une ancienne redirection de paiement cible encore le dashboard. Ne pas modifier les intégrations ou confirmations de paiement.

## Session Chat indépendante

Cookie `spv_chat_session` HttpOnly, Secure sur HTTPS, SameSite=Lax, chemin `/api/`, durée glissante de 30 jours plafonnée à 90 jours. Seul un condensat du secret est conservé en base ; révocation contrôlée à chaque requête et sur WebSocket. Ne jamais placer le secret Chat dans localStorage, une URL ou un bearer principal.

`GET /identity/chat/session` avec credentials → état et utilisateur Chat, ou 401. Le contexte Chat n’utilise pas `useAuth().user` comme autorité.

`GET /identity/chat/sessions` → `[{id,device,created_at,last_seen,expires_at,current}]`.

`DELETE /identity/chat/sessions/{id}` → `{ok:true}` pour une session de ce compte uniquement.

`POST /identity/chat/logout` → `{ok:true}` ; ne modifie pas la session principale.

`POST /identity/chat/push-token` reprend le schéma FCM existant `{token,device_id,platform,user_agent}` avec authentification Chat uniquement. Le token est rattaché à la session Chat et supprimé lors de sa révocation ou déconnexion. Les push du Chat ne ciblent que des sessions Chat encore valides ; les notifications principales gardent leur fonctionnement existant.

Toutes les API `/messenger/**`, y compris fichiers et tickets socket, utilisent **uniquement le cookie Chat**, avec `credentials:"include"`, sans jeton principal. Les erreurs Chat ne doivent ni vider `auth_token` ni déconnecter le compte principal.

Le guard de `/messenger` doit accepter un contexte Chat valide même si le compte principal est absent, expiré ou non activé. Sans Chat valide, rediriger `/verify-email` (ou présenter la récupération par e-mail). Les deux logos et le nom du Chat retournent via l’animation existante vers `/account-access?source=chat`.

Le bouton Chat flottant de `/pay` ouvre `/messenger` si la session Chat de ce même compte est valide, sinon `/verify-email`. Les fenêtres promotionnelles du compte principal ne doivent pas empêcher l’utilisation indépendante du Chat.

## Envoi

Couche fournisseur indépendante, sans journalisation des codes. Adaptateurs SMTP, Resend HTTP portable sur VPS et connecteur Resend du workspace via son SDK officiel Node. Domaine choisi : `spiloveure.org`, expéditeur `SPILOVEURE <no-reply@spiloveure.org>`. L’aperçu utilise désormais l’adaptateur HTTP natif avec la clé personnelle sécurisée de l’utilisateur, après acceptation d’un envoi technique par Resend. L’ancien connecteur ne correspondait pas à la configuration DNS validée par l’utilisateur et n’est plus utilisé pour ces envois. Les essais automatisés utilisent un expéditeur injecté dans un serveur de test isolé, jamais une porte dérobée de production.
