# Préparation multi-artefact de SPILOVEURE

## Sauvegarde et inventaire avant adaptation

Le scaffold a archivé le projet dans `.migration-backup/`. Cette sauvegarde est
la référence de comparaison ; elle n'est pas servie par le preview.
Les sources suivies ont été restaurées sans déplacer la logique Python :

| Responsabilité | Chemin conservé | Commande / sortie historique |
| --- | --- | --- |
| Interface web et APK Expo | `frontend/` | Expo Router, SDK 54, React Native 0.81.5 |
| Configuration Android | `frontend/app.json`, `app.config.js` | `com.spilivere.app`, projet EAS conservé |
| Profils EAS | `frontend/eas.json` | `test-apk` et `production-apk`, signature distante |
| Export web | `frontend/` | `expo export --platform web --output-dir build` |
| Backend VPS Python | `backend/` | requirements.txt, pyproject.toml et uv.lock conservés |
| Preview historique | `scripts/start-dev.sh` | mode VPS, Expo Web + dev_gateway.cjs |
| Verrouillage historique | `yarn.lock`, `frontend/yarn.lock` | inchangés, usages locaux/VPS distincts |
| Déploiement VPS | `deploy/` | procédures conservées, non exécutées |

L'ancien workflow « Start application » lançait :
`SPV_PREVIEW_MODE=vps SPV_PREVIEW_API_UPSTREAM=https://spiloveure.org bash scripts/start-dev.sh`.
Il exposait la passerelle sur 5000 et Metro sur 8080.

## Adaptation limitée

Le workflow géré `artifacts/spiloveure-web: web` reprend ce même script et
ces mêmes réglages VPS. Seuls les ports s'adaptent au routage multi-artefact :
la passerelle écoute `PORT` et Metro utilise 19080. Un lancement manuel du
script conserve les valeurs historiques par défaut (5000/8080).

`frontend/` est découvert par pnpm comme package du workspace. Le champ
`packageManager` Yarn du frontend est remplacé par le choix pnpm à la racine ;
les deux lockfiles Yarn ne sont ni supprimés ni réécrits. Les modules natifs de
mise à jour APK, auparavant déclarés à la racine, sont déclarés dans le frontend
qui les utilise. `metro-cache` est explicite car pnpm n'expose pas les dépendances
transitives implicitement comme le faisait l'installation précédente.
Le hook EAS reconnaît désormais le lockfile pnpm et valide son entrée frontend,
sans réécrire les lockfiles Yarn. Son ancien comportement reste disponible dans
un contexte Yarn sans lockfile pnpm.

L'artefact web sert d'adaptateur et ne remplace pas Expo par une interface Vite.
Le serveur API Express du scaffold ne démarre pas et ne capture plus `/api`.
Le script après fusion n'exécute aucun `db push`, seed ou déploiement.

## Vérification

- `pnpm run test:migration-parity` : comparaison ponctuelle des sources avec
  la sauvegarde, à ne pas utiliser comme contrainte des modifications futures.
- `pnpm run test:migration` : identité Android/EAS, profils et garde-fous de démarrage ;
  régressions HTTP/WebSocket, démarrage Android natif, Chat et accueil.
- Vérifier le workflow et ouvrir `/` ; faire uniquement des GET publics via la
  passerelle pour confirmer la connexion VPS. Ne pas créer de compte réel,
  envoyer de message, effectuer de paiement ou lancer le backend Python.
- Le build et l'installation d'un APK signé sur téléphone ne sont pas réalisés
  ici. Une validation statique EAS ne remplace pas ce contrôle avant diffusion.
- Le prototype Capacitor et son propre artefact restent une étape séparée.

Aucune commande de déploiement VPS ni aucune modification de base n'est prévue.

## Résultats constatés

- Workflow web démarré et bundle Metro produit sans erreur.
- GET `/` et `/api/config` via le routage Replit : HTTP 200, réponse VPS JSON.
- Accueil après disparition du splash et formulaire `/login` visibles dans
  Chromium ; aucune exception JavaScript non interceptée. Les écritures API
  étaient bloquées pendant ce contrôle navigateur.
- Tests ciblés réussis : parité des sources, deux profils et hooks EAS,
  passerelle HTTP/WebSocket, quatre contrôles Android, six contrôles Chat et
  trois contrôles de l'accueil. Le simulacre React Native du test Chat a reçu
  `BackHandler`, déjà utilisé par les sources historiques, sans changement métier.
- Configuration publique Expo chargée par la CLI ; identité Android/EAS
  préservée. Vérification TypeScript du scaffold et syntaxe des scripts réussies.
- Les pages authentifiées et l'installation d'un APK sur téléphone ne sont pas
  vérifiées pendant cette préparation ; aucun build EAS distant n'a été lancé.

## Identifiant Firebase historique retiré

Un fichier de compte de service privé figurait dans les sources historiques.
Il a été retiré du backend restauré et de la sauvegarde
présente dans cet état du dépôt ; les dossiers de secrets et les fichiers de
compte de service sont désormais exclus du suivi et des livrables.

Le backend utilise déjà `FIREBASE_SERVICE_ACCOUNT_JSON` comme chemin vers un
fichier fourni au runtime. Ce fichier doit rester hors du dépôt, avec des
permissions restrictives, sur le serveur qui en a besoin. Aucun fichier ni
réglage du VPS n'a été modifié ici.

La suppression du fichier n'efface pas l'historique et ne révoque pas la clé.
Le propriétaire doit révoquer/remplacer la clé dans Google Cloud, mettre à jour
le fichier sécurisé du serveur, puis traiter l'exposition dans l'historique et
les éventuelles copies partagées. Aucun build ou déploiement n'a été effectué
avec cette clé pendant la migration.
