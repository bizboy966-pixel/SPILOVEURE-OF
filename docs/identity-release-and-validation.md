# Inscription, vérification e-mail et sessions — validation et livraison

## Parcours livré

Landing existante → bienvenue animée → choix du pays → adresse e-mail → formulaire existant prérempli (pseudo, téléphone, parrainage et conditions, sans mot de passe) → paiement existant.

Le bouton Chat de la page de paiement permet une vérification par six chiffres et l’ouverture du Chat sans activation. Un lien Chat existe également sur la connexion pour un utilisateur revenant avec uniquement sa session Chat.

Après confirmation de l’activation en base, les nouveaux comptes créent et confirment leur mot de passe une fois. Les retours ultérieurs depuis le Chat demandent uniquement le mot de passe. Les comptes historiques ne subissent pas de réinitialisation de mot de passe.

## Droits et sessions

- Nouveaux comptes marqués `auth_flow_version=2` ; jeton d’onboarding limité aux étapes d’identité et d’activation.
- Aucun tableau de bord pour ce jeton, même après qu’un autre appareil a terminé l’activation.
- Session Chat HttpOnly/Secure sur HTTPS/SameSite=Lax, 30 jours glissants, limite absolue de 90 jours, révocable par appareil.
- Vérification e-mail persistée, mais nouveau code autorisé si un appareil non autorisé doit récupérer une session expirée.
- Les autorisations Chat ne donnent jamais un jeton principal sans vérification du mot de passe ou création initiale autorisée.
- Une session principale et un cookie Chat de comptes différents restent explicitement distingués par `source=chat`.
- Les sessions principales conservent leur réglage JWT existant. Aucun délai d’inactivité n’a été ajouté ou modifié. Le code importé utilise `JWT_ACCESS_EXP_MINUTES` ; les tests d’expiration ci-dessous ne constituent pas une mesure chronométrée d’un éventuel système d’inactivité externe.
- Codes : 10 minutes, cinq essais, usage unique, renvoi après 60 secondes et limites de demandes ; HMAC en base, pas de code en journal ou réponse publique.

## Résultats vérifiés

**58 tests serveur réussis** : identité, Chat existant, garde d’activation existante et transport Resend.

```bash
PYTHONPATH=backend python -m pytest \
  backend/tests/test_identity.py backend/tests/test_messenger.py \
  backend/tests/test_activation_guard.py backend/tests/test_email_delivery.py -q
```

Le navigateur a parcouru réellement :

1. Landing, bienvenue, pays, e-mail et formulaire prérempli sans mot de passe.
2. Paiement → vérification, saisie en six champs, refus d’un mauvais code, acceptation du code de la boîte de test.
3. Chat sans activation, puis retour vers le paiement au lieu du tableau de bord.
4. Confirmation de paiement **simulée uniquement en base de test**, création initiale du mot de passe et accès au tableau de bord.
5. Suppression de la session principale locale, maintien du Chat, retour au compte avec un seul mot de passe et refus d’un mauvais mot de passe.
6. Déconnexion propre au Chat.

Une seconde suite a vérifié deux comptes sur mobile et ordinateur : messages dans les deux sens, WebSocket, historique après rechargement, fichier, vocal avec microphone simulé, programmation/annulation et retour au compte par mot de passe unique.

```bash
node scripts/identity-e2e.cjs
node scripts/messenger-e2e.cjs
```

Le premier test utilise un serveur avec les vrais handlers de l’application, mais une base locale jetable et un expéditeur injecté. Aucun vrai e-mail ni paiement n’est envoyé ; aucun contournement n’est ajouté aux routes de production. La base jetable est supprimée à la fin.

Export Expo web réussi. Le contrôle TypeScript global reste en échec sur **31 diagnostics antérieurs hors de ce périmètre**, sans diagnostic dans les fichiers de ce parcours. Les avertissements web préexistants de styles/animation restent présents.

## Configuration Resend et contrôle restant

La clé du compte Resend de l’utilisateur est maintenant configurée dans les Secrets de l’aperçu. Un envoi depuis l’expéditeur officiel vers l’adresse de test de Resend a été accepté par l’API. Voir `resend-spiloveure-dns.md` : les anciennes instructions de remplacement DNS sont abandonnées ; les DNS validés dans Hostinger restent inchangés.

Les nouvelles inscriptions disposent désormais d’un expéditeur configuré. Il reste à vérifier la réception d’un vrai code dans la boîte d’un utilisateur. En cas de pause nécessaire, `IDENTITY_REGISTRATION_ENABLED=0` reste disponible.

La réception réelle d’un e-mail, un vrai paiement chez les prestataires et les push hors ligne sur téléphone ne sont pas certifiés par ces essais.

## Sauvegarde et migration avant livraison sur VPS

Aucune donnée de production n’a été modifiée ici. Le schéma est additif :

- Nouvelles collections d’identité pour sessions, codes, réservations d’identifiants et limites de demandes.
- Champs de version, vérification et création du mot de passe sur les nouveaux comptes.
- Statut e-mail ajouté à un ancien compte uniquement après vérification réelle.
- Aucun ancien mot de passe, solde, lien de parrainage, paiement ou historique de support n’est supprimé.
- Aucun index unique imposé brutalement à toutes les anciennes adresses ; les nouveaux identifiants sont réservés séparément pour gérer les créations concurrentes.

Avant la mise à jour, sauvegarder MongoDB et les fichiers de configuration dans un emplacement privé du VPS :

```bash
cd /opt/spiloveure/deploy/hostinger
umask 077
mkdir -p /root/spiloveure-backups
BACKUP="/root/spiloveure-backups/before-identity-$(date +%Y%m%d-%H%M%S).archive.gz"
docker compose exec -T mongo mongodump --archive --gzip > "$BACKUP" && test -s "$BACKUP"
```

Cette commande convient au Mongo local sans authentification décrit pour ce déploiement. Si l’authentification Mongo est activée, employer les paramètres déjà configurés sans les publier. Vérifier aussi que la sauvegarde est lisible et conserver les anciennes images ainsi qu’une copie privée de la configuration.

Configurer Resend sur le VPS, conserver toutes les variables de paiement, puis reconstruire les deux services :

```bash
cd /opt/spiloveure
git pull
cd deploy/hostinger
docker compose up -d --build backend web
docker compose logs --tail=80 backend web
```

Ne pas lancer `down -v`, ne pas réimporter la base et ne pas remplacer la configuration complète par un exemple.

## Retour arrière

`IDENTITY_REGISTRATION_ENABLED=0` suspend uniquement les nouvelles inscriptions si nécessaire, en conservant l’accès existant et les sessions déjà délivrées. Cette mesure ne désactive pas les paiements déjà engagés.

Avant toute nouvelle inscription, les anciennes images peuvent être conservées comme retour de code, les ajouts de collections n’altérant pas les anciens documents. **Après création de comptes avec le nouveau parcours, un retour brut à l’ancien backend n’est pas compatible** : ces comptes n’ont volontairement pas encore de mot de passe. Conserver alors les endpoints d’identité compatibles, ou mettre les nouvelles inscriptions en pause et examiner les changements intervenus.

Ne jamais restaurer aveuglément la sauvegarde : cela pourrait effacer des utilisateurs, messages ou paiements arrivés depuis sa création. Toute restauration de données exige une fenêtre contrôlée, une comparaison et une décision explicite.
