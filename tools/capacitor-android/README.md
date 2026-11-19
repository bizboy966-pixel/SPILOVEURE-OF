# SPILOVEURE Android — Capacitor officiel

Cette application Capacitor est destinée à devenir l'application Android
officielle. Elle embarque uniquement le front-end ; aucun back-end ni aucune
base de données ne sont compilés dans l'APK. Toutes les requêtes utilisent le
VPS `https://spiloveure.org`. Elle garde le même identifiant Android que l'application Expo :
`com.spilivere.app`.

La version préparée est **1.1.19 (code 20)**. Elle est signée avec
une nouvelle clé de production, distincte de la clé EAS inaccessible. Pour la
première installation, les utilisateurs devront désinstaller l'ancienne APK
Expo puis installer celle-ci. Les données conservées sur le VPS ne sont pas
supprimées ; la session locale devra être recréée. Toutes les futures versions
doivent réutiliser exactement la nouvelle clé.

## Application et backend

- Nom affiché : **SPILOVEURE**.
- Identifiant Android officiel : `com.spilivere.app`.
- Interface embarquée dans l'APK ; aucun `server.url` ni démarrage dans Chrome.
- Backend conservé sur `https://spiloveure.org`.
- Les requêtes API natives, fichiers/audio, cookies et bouton Retour utilisent
  le pont Capacitor déjà couvert par les tests.
- Cette APK Android ne remplace pas le front-end web ni son fonctionnement.
- La clé de production ne doit jamais être ajoutée au dépôt ou à GitHub.

## Transport et capacités

L'origine locale HTTPS porte le nom du VPS, **mais ses pages sont embarquées**.
Ce choix conserve les cookies SameSite du Chat et l'Origin attendu par son
WebSocket sans modifier les règles du serveur.

`transport.js` dirige les fetch `/api/` vers CapacitorHttp (JSON et multipart).
Capacitor partage les cookies HTTP natifs et le WebView. Les requêtes GET de
médias protégés sont relayées vers le VPS par `VpsMediaClient`, avec Cookie,
Authorization et Range. Pas de cache applicatif ni de redirection API suivie.
Les erreurs réseau restent des erreurs.

Le micro utilise `getUserMedia`/`MediaRecorder` dans le WebView et l'autorisation
Android `RECORD_AUDIO`, limitée à l'origine du Chat. Le refus doit rester
réversible dans les paramètres Android. Les fichiers sont choisis via le
sélecteur Android fourni par Capacitor, sans accès global au stockage.
La caméra et les notifications push natives ne font pas partie de cette version.
Les workers PWA/push web ne sont pas enregistrés dans cet APK.

Retour ferme d'abord la modale active, puis la conversation, puis remonte les
routes Expo Router ; à la racine, une confirmation précède la fermeture.
Les barres système restent visibles, avec des marges pour les barres, l'encoche
et le clavier Android 15.

## Clé de signature et compilation officielle

Le build release exige ces valeurs dans Replit Secrets, jamais dans le dépôt :

- `ANDROID_KEYSTORE_BASE64` : fichier JKS encodé en Base64.
- `ANDROID_KEYSTORE_PASSWORD` : mot de passe du keystore et de l'alias.
- `ANDROID_KEY_ALIAS` : optionnel ; par défaut `spiloveure`.
- `ANDROID_RELEASE_TOKEN` : secret commun utilisé par l’outil de release et le VPS
  pour authentifier la publication automatique.

Prérequis de compilation : Node et pnpm du workspace, **JDK 21**, Android SDK
`platforms;android-35`, `build-tools;35.0.0` (Gradle peut aussi demander 34.0.0),
licences SDK acceptées, et `ANDROID_HOME` défini. Pas de `expo prebuild`.

Depuis la racine du dépôt :

```sh
pnpm install --frozen-lockfile
pnpm --filter @workspace/capacitor-android test
pnpm --filter @workspace/capacitor-android run apk:release
```

`apk:debug` reste réservé aux essais et ne publie jamais. La seule commande de
release officielle vérifie d’abord que la version et le code Android dépassent
la version active, compile en mode release, vérifie le certificat, le package,
la version et l’absence du mode débogage, puis envoie l’APK au VPS. Le VPS
vérifie de nouveau le binaire signé et active automatiquement la mise à jour
obligatoire. Si une étape échoue, la version publique précédente reste active.
Le fichier compilé est conservé sous
`generated-artifacts/spiloveure/SPILOVEURE-<version>.apk`.

Pour que la publication fonctionne après le déploiement initial du backend,
configurer `ANDROID_RELEASE_TOKEN` avec la même valeur dans Replit Secrets et
dans l’environnement sécurisé du VPS. Installer Android SDK Build Tools sur le
VPS et rendre `apksigner` et `aapt` accessibles sur son `PATH` (ou renseigner
`ANDROID_APKSIGNER` et `ANDROID_AAPT`). Le VPS doit aussi disposer du stockage
persistant déjà utilisé par `/api/uploads/`. La première release officielle
enregistre l’empreinte du certificat; toutes les suivantes doivent utiliser
exactement la même clé.

## Compilation de test dans Docker sur le VPS

Le backend Docker conserve seulement les outils de vérification `apksigner` et
`aapt`. Le conteneur séparé `android-builder` fournit Node, JDK 21, Android SDK
35 et Gradle pour compiler sans installer ces outils dans le service backend.
Il signe l’APK avec le keystore configuré, vérifie le package, la version et le
même certificat que les APK officielles déjà installées, puis enregistre le
binaire dans `generated-artifacts/spiloveure/`. Cette commande ne
téléverse ni ne publie l’APK aux utilisateurs.

Sur le VPS, après avoir récupéré le commit GitHub qui contient la version voulue :

1. Copier `deploy/hostinger/android-builder.env.example` vers
   `deploy/hostinger/android-builder.env`.
2. Renseigner `ANDROID_KEYSTORE_BASE64` et `ANDROID_KEYSTORE_PASSWORD` dans ce
   fichier par le canal sécurisé Hostinger, puis appliquer `chmod 600`.
   Ne jamais committer ou envoyer ces valeurs dans le chat.
3. Depuis la racine du dépôt, lancer :

   ```sh
   docker compose --env-file deploy/hostinger/android-builder.env \
     -f deploy/hostinger/docker-compose.android.yml build android-builder
   docker compose --env-file deploy/hostinger/android-builder.env \
     -f deploy/hostinger/docker-compose.android.yml run --rm android-builder
   ```

L’APK de test signée sera dans
`generated-artifacts/spiloveure/SPILOVEURE-1.1.19.apk`. Le fichier
`android-builder.env` est ignoré par Git. Le conteneur de compilation est séparé
du lancement normal de Docker Compose et n’est pas démarré au redémarrage du VPS.

Avant une nouvelle release, augmenter `versionName` et `versionCode` dans
`android/app/build.gradle`. La commande ne publie pas les builds debug et ne
redémarre ni ne déploie le VPS. Android demandera toujours à chaque utilisateur
de confirmer l’installation.

## Icône Android

L'icône conserve une illustration nette en arrière-plan, sans flou, et place le
logo complet dans une zone sûre, afin que le nom SPILOVEURE et les cinq symboles
restent visibles après le masque arrondi du lanceur Android. Pour régénérer les
ressources après une modification de `branding/app-icon-source.png` ou
`branding/app-icon-background.png`, lancer
`pnpm --filter @workspace/capacitor-android run icons:generate`.

L'export fixe explicitement le VPS et désactive la lecture des fichiers `.env`.
Ne pas utiliser `cap init`/`cap add` de nouveau : le projet Android est conservé.
`cap sync` régénère ses références aux dépendances pnpm.

La passerelle de développement peut servir la version release à
`/downloads/spiloveure.apk`. Le lien de preview n'est pas un hébergement
permanent ; la diffusion officielle doit pointer vers un fichier signé publié
sur l'hébergement de la plateforme.

Vérifications complémentaires :

```sh
cd tools/capacitor-android/android
./gradlew :app:lintDebug :app:assembleDebugAndroidTest
# Avec un téléphone branché, déverrouillé et le débogage USB autorisé :
adb devices
./gradlew :app:connectedDebugAndroidTest
```

Le test instrumenté vérifie l'identité distincte et les fichiers embarqués.
Il **ne remplace pas** les essais de connexion et de Chat.

## Vérifications sur Infinix Android 15

La première installation de l'APK Capacitor officielle exige de désinstaller
l'APK Expo, car les signatures sont différentes. Après cela, les futures
versions doivent garder le même identifiant Android et la même clé de signature.

| Essai | Résultat requis | État |
| --- | --- | --- |
| Installation initiale | Expo retirée, Capacitor installée sous le nom SPILOVEURE | À tester |
| Premier lancement | Aucun passage par Chrome, barres système visibles | À tester |
| Ressources locales | En mode avion, après fermeture forcée, l'interface démarre et signale l'absence réseau | À tester |
| Connexion | Connexion avec un compte de test sur le VPS | À tester |
| Session Chat | Vérification e-mail si demandée, accès au Chat, réouverture après fermeture forcée | À tester |
| Stabilité | Dix ouvertures du Chat, plusieurs conversations, au moins dix minutes sans fermeture inattendue | À tester |
| Messages | Envoyer/recevoir avec un second appareil et vérifier les mises à jour en direct | À tester |
| Pièces jointes | Photo, PDF et fichier ; réception, affichage/téléchargement, annulation du sélecteur | À tester |
| Audio | Refuser puis autoriser le micro ; enregistrer, annuler, envoyer et écouter des deux côtés | À tester |
| Retour | Modale → conversation → liste → page précédente ; confirmation à la racine | À tester |
| Clavier/barres | Champ et bouton d'envoi accessibles, clavier fermé sans quitter l'application | À tester |
| Reprise réseau | Mode avion puis reconnexion, reprise du Chat sans fermeture inattendue | À tester |
| Déconnexion | Sortie du Chat, session réellement fermée, nouvelle connexion possible | À tester |

Noter la version Android, la version Android System WebView, le scénario et
l'heure d'une éventuelle fermeture. Ne jamais joindre de mot de passe, cookie
ou jeton aux comptes rendus. Un journal `adb logcat` peut contenir des données
personnelles : le filtrer avant partage.

Ne jamais publier la clé, ni la placer dans GitHub. Conserver une sauvegarde
chiffrée hors du dépôt. Si la clé est perdue, les versions suivantes ne pourront
pas mettre à jour cette installation sans une nouvelle désinstallation.
