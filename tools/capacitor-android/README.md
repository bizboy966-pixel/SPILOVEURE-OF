# SPILOVEURE Test Capacitor — Android uniquement

Prototype **expérimental**, non validé sur téléphone. Il ne remplace pas
l'application Expo officielle et ne doit pas être annoncé comme un correctif
du crash avant les essais sur l'Infinix Android 15.

## Isolation

- Nom Android : **SPILOVEURE Test Capacitor**, icône de marque avec badge TEST.
- Identifiant : `com.spiloveure.capacitor.test`, différent de `com.spilivere.app`.
- Signature de développement Android uniquement. Aucun accès à la signature Expo.
- Stockage WebView et sessions distincts de l'application officielle.
- Export web distinct dans `www`, inclus dans les assets de l'APK. Pas de
  `server.url`, pas d'ouverture de Chrome pour démarrer.
- Backend conservé sur `https://spiloveure.org`. **Les actions réalisées dans le
  prototype portent sur les vraies données VPS.** Utiliser un compte de test et
  un destinataire consentant ; ne pas lancer de paiement pendant ces essais.
- Aucun changement d'API, de base de données, de configuration Expo, de version
  officielle, de mécanisme de mise à jour ni de déploiement VPS.
- Le web et Expo gardent leurs parcours habituels. Les deux petits branchements
  de navigation ne sont actifs que dans l'export `EXPO_PUBLIC_CAPACITOR_TEST=1`.

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
La caméra et les notifications push natives ne font pas partie de ce prototype.
Les workers PWA/push web ne sont pas enregistrés dans cet APK.

Retour ferme d'abord la modale active, puis la conversation, puis remonte les
routes Expo Router ; à la racine, une confirmation précède la fermeture.
Les barres système restent visibles, avec des marges pour les barres, l'encoche
et le clavier Android 15.

## Reproduire la compilation

Prérequis : Node et pnpm du workspace, **JDK 21**, SDK Android
`platforms;android-35`, `build-tools;35.0.0` (Gradle peut aussi demander 34.0.0),
licences SDK acceptées, `ANDROID_HOME` défini. Pas de commande EAS ou de
`expo prebuild`.

Depuis la racine :

```sh
pnpm install --frozen-lockfile
pnpm --filter @workspace/capacitor-android-test test
pnpm --filter @workspace/capacitor-android-test run apk
```

Résultat :
`tools/capacitor-android/android/app/build/outputs/apk/debug/app-debug.apk`.
L'export fixe explicitement le VPS et désactive la lecture des fichiers `.env`.
Ne pas utiliser `cap init`/`cap add` de nouveau : le projet Android est conservé.
`cap sync` régénère ses références aux dépendances pnpm.

Le téléchargement direct de l'APK pendant le preview du projet est servi par
la passerelle de développement à `/downloads/capacitor-test.apk`, avec le
type MIME Android, un nom `.apk` et la réponse binaire originale. Ce lien de
preview n'est pas un hébergement permanent ni une publication officielle.

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

## Protocole Infinix Android 15 — tous les résultats restent à renseigner

Installer le fichier **de test** sans désinstaller Expo. Si Android propose de
mettre à jour l'application officielle, arrêter : ce n'est pas le bon fichier.

| Essai | Résultat requis | État |
| --- | --- | --- |
| Coexistence | Deux applications présentes ; Expo fonctionne toujours | À tester |
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

**Décision :** aucune recommandation de remplacement, publication officielle ou
mise à jour obligatoire avant réussite de cette grille et accord de l'utilisateur.
