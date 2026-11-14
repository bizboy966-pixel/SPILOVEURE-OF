# SPILOVEURE Chat

## Périmètre

Module ajouté à la plateforme Expo / FastAPI / MongoDB existante. Il ne remplace ni les comptes, ni le support utilisateur–administrateur, ni les paiements. Seule l’entrée Trading de la navigation principale devient Chat ; la page Trading et sa carte existante restent présentes.

Le logo officiel existant est réutilisé sans retouche. Les conversations et compteurs de l’image de référence ne sont pas utilisés comme données fictives.

## Fonctionnement

- Route de l’interface : `/messenger`, soumise aux règles d’authentification et d’activation existantes.
- Routes REST et WebSocket : `/api/messenger/*`.
- Collections nouvelles : préfixe `spv_`, indépendantes de `chat_messages` / `chat_conversations` du support et de leur purge automatique.
- Identités : références aux identifiants des comptes existants ; les routes de recherche ne renvoient ni emails, ni téléphones, ni soldes.
- Temps réel : WebSockets authentifiés par tickets de 30 secondes, à usage unique. Le JWT n’est pas placé dans les URLs.
- Les événements passent par MongoDB : plusieurs processus peuvent les consulter, sans dépendre d’une liste de connexions en mémoire. Rattrapage d’historique après reconnexion et retour au premier plan.
- Les messages ont un identifiant client ; la contrainte unique inclut conversation et auteur pour éviter les doublons sur relance.
- Historique paginé, recherche littérale, réponses, transferts textuels, réactions, épingles, modification et suppression avec contrôles d’auteur/rôle.
- Les groupes et canaux sont limités à 200 membres dans cette version. Les canaux publics disposent d’une découverte et d’un abonnement. Seuls leurs administrateurs publient.
- Messages programmés : worker toutes les deux secondes, attribution par bail, droits revérifiés à l’envoi et idempotence en cas de reprise. Annulation avant traitement.
- Contacts : demandes, acceptation, retrait, blocage et signalement enregistré. Publications : visibilité publique ou contacts, commentaires et réactions.

## Fichiers et médias

Les fichiers du Chat sont placés dans `UPLOADS_DIR/messenger`, dans le volume persistant déjà prévu sur le VPS. Ils sont servis exclusivement par la route authentifiée du module ; aucun répertoire statique public n’est ajouté.

Limites : 20 Mo par fichier, 100 Mo et 100 fichiers par utilisateur sur 24 heures. Formats HTML, SVG et exécutables refusés. Les métadonnées transmises par le client ne font pas autorité : le serveur utilise celles enregistrées lors de l’upload. Les fichiers ne sont pas analysés par un antivirus ; cette protection n’est pas revendiquée.

Le navigateur télécharge les médias avec un en-tête Bearer puis utilise une URL Blob locale. Images, audio et vidéo ont une consultation locale ; les vocaux utilisent MediaRecorder lorsque le navigateur et l’autorisation microphone le permettent. Le partage de contacts est textuel, sans exposer de numéro privé.

## Notifications et limites de sécurité

Les nouveaux messages alimentent une file persistante, qui réutilise le fournisseur Firebase et les jetons d’appareils existants. Les messages silencieux et les conversations en sourdine ne produisent pas de push. Le contenu du message n’est pas inclus dans la notification.

Sans Firebase configuré, une notification n’est pas déclarée envoyée : son statut devient `unconfigured`. La réception sur un véritable téléphone hors ligne doit être validée sur l’installation cible. L’interface Profil affiche les capacités réellement configurées.

Le chiffrement de transport dépend de HTTPS sur Caddy. **Aucun chiffrement de bout en bout n’est implémenté ni revendiqué.** Les fichiers stockés restent lisibles par l’administrateur de l’infrastructure.

Les appels audio/vidéo, la signalisation WebRTC et TURN ne sont pas implémentés. Aucun bouton ne les présente comme disponibles. Les appels de groupe, bots, localisation, gestion des appareils/sessions et commentaires spécifiques aux canaux ne sont pas livrés dans cette version.

La boîte d’envoi en échec se conserve dans l’écran ouvert, avec relance manuelle et identifiant idempotent. Elle n’est pas une boîte d’envoi persistante hors ligne après fermeture de l’onglet.

## Déploiement Hostinger

Effectuer une sauvegarde habituelle avant toute mise à jour. Ne pas réimporter la base et ne pas supprimer les volumes.

```sh
cd /opt/spiloveure
git pull
cd deploy/hostinger
docker compose up -d --build backend web
docker compose logs --tail=80 backend web
```

Le backend doit être reconstruit également : le Chat ajoute des fichiers Python et nécessite la bibliothèque WebSocket ajoutée aux dépendances. Le routage Caddy existant `/api/*` accepte les upgrades WebSocket. Les index nouveaux sont créés au démarrage.

Conserver les variables MongoDB, le nom de base, les secrets JWT, le domaine et la configuration Firebase existants du VPS. Aucun transfert de données de production vers l’environnement de test n’est nécessaire.

## Développement et vérification

Le workflow Replit lance une base MongoDB **locale distincte** et le site existant, avec une passerelle de développement sur le port 5000. Les lanceurs de tests refusent une adresse MongoDB ou un nom de base ne correspondant pas à cette base locale.

```sh
PYTHONPATH=backend python -m pytest backend/tests/test_messenger.py backend/tests/test_activation_guard.py -q
node scripts/messenger-e2e.cjs
yarn typecheck
```

Les tests serveur du module utilisent MongoDB simulé en mémoire ; les vérifications navigateur et d’activation utilisent la vraie base MongoDB locale. Les deux comptes de test sont explicitement nommés `messenger_test_*` et ne sont créés que localement.

La vérification TypeScript globale signale des erreurs préexistantes en dehors du Chat. Le rapport de validation distingue ces erreurs des résultats du module et ne prétend pas à une validation exhaustive des paiements ou des intégrations externes.

## Références fonctionnelles

- https://telegram.org/faq
- https://telegram.org/faq_channels
- https://telegram.org/blog/group-video-calls

Les fonctions documentées de Telegram servent de référence, pas de promesse de parité. La consultation directe de certaines pages et la vérification de l’application Telegram actuelle n’ont pas pu être réalisées intégralement.
