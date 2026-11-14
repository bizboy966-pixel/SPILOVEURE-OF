# SPILOVEURE Android — préparation et publication contrôlée

## État réel

Le projet Expo existant est utilisé : mêmes écrans, mêmes comptes, même API.
Il ne s'agit ni d'un raccourci, ni d'un site renommé en APK. Le bundle JavaScript
Android peut être exporté, mais **ce n'est pas un fichier APK signé**.
La page `/telecharger` reste sans téléchargement tant qu'aucune version validée
n'a été préparée.

À terminer avant de qualifier l'application de production :

- Connecter le projet à un compte Expo/EAS autorisé, et conserver les accès à sa
  clé de signature pour toutes les mises à jour. Ne jamais créer une nouvelle
  clé pour remplacer celle d'une application déjà diffusée.
- Définir l'origine HTTPS officielle du backend et le code de version Android.
- Vérifier/adopter les notifications Android natives. Le projet dispose de
  notifications **Web** Firebase ; elles ne prouvent pas le fonctionnement des
  notifications Android. La configuration FCM Android et les adaptateurs natifs
  restent à réaliser avant publication.
- Tester et terminer les chemins encore spécifiques au navigateur : sélection
  et import de fichiers/photos, enregistrement vocal, liens de paiement,
  affichage des pièces jointes et notifications en arrière-plan.
- Installer l'APK exact sur au moins deux vrais appareils Android compatibles.
- Effectuer une analyse de sécurité du fichier final et traiter les résultats
  bloquants des scans de dépendances et du code existant.

Ne pas diffuser d'APK incomplet. Ne pas promettre l'absence d'avertissements
Android ou contourner Play Protect.

## Compilation

La configuration Android conserve le package existant `com.spilivere.app`.
Si une version a déjà été publiée, vérifier son certificat avant toute nouvelle
compilation. Les secrets et la clé privée restent dans le gestionnaire sécurisé
d'EAS, jamais dans le dépôt ni dans la conversation.

Dans les variables sécurisées/configurées du profil EAS :

- `EXPO_PUBLIC_BACKEND_URL` : origine HTTPS officielle, sans chemin `/api`.
  Ce paramètre est public et sera intégré au binaire.
- `ANDROID_VERSION_CODE` : entier strictement croissant.

Depuis `frontend`, dans un environnement EAS authentifié :

```sh
eas build --platform android --profile production-apk
```

La commande peut engager des quotas/frais de compilation du compte Expo :
elle n'a pas été exécutée par l'agent. Le profil demande un APK release, pas
un development client. La configuration refuse une origine locale/preview.

Pour vérifier le bundle uniquement, sans produire un APK :

```sh
cd frontend
CI=1 ../node_modules/.bin/expo export --platform android --output-dir ../generated-artifacts/android-bundle-check
```

## Validation sur appareils réels

Renseigner un rapport JSON après les essais. Ce schéma est une trame, **pas
une preuve de tests**. Ne remplacer `not_run` que par un résultat réellement
observé sur le binaire dont le SHA-256 est enregistré.

```json
{
  "apk_sha256": "",
  "physical_devices": [
    {
      "physical": true,
      "model": "",
      "android_version": "",
      "checks": {
        "registration": "not_run",
        "login": "not_run",
        "email_verification": "not_run",
        "activation_payment": "not_run",
        "chat": "not_run",
        "notifications": "not_run",
        "navigation": "not_run",
        "performance": "not_run"
      }
    }
  ],
  "security_scan": { "tool": "", "result": "not_run", "report_path": "" },
  "play_protect": "not_run"
}
```

Ajouter au moins deux appareils distincts. Les tests d'activation et de paiement
doivent être coordonnés dans un environnement autorisé ; ce script ne lance
aucun paiement. Faire analyser l'APK localement avant de l'envoyer à un service
tiers : certains scanners partagent les fichiers soumis.

## Vérification et préparation du téléchargement

Outils Android officiels requis sur la machine de validation : `apksigner`
et `aapt`. Le script ne remplace pas ces outils par une simulation.

```sh
python scripts/stage-android-release.py \
  --apk /chemin/SPILOVEURE-release.apk \
  --validation-report /chemin/validation.json \
  --expected-signer-sha256 EMPREINTE_PUBLIQUE_DU_CERTIFICAT \
  --directory /chemin/repertoire-de-publication
```

Ce script :

- vérifie la signature avec `apksigner`, le package, le caractère non débogable,
  le numéro de version et le certificat attendu ;
- exige les preuves déclarées de validation sur appareils et d'analyse de sécurité ;
- vérifie le SHA-256 puis copie l'APK sans écraser les versions anciennes ;
- refuse une nouvelle clé de signature pour les versions ultérieures ;
- conserve le rapport hors des routes de téléchargement publiques ;
- écrit le manifeste de version après la copie complète.

Utiliser un seul opérateur de publication à la fois. Sauvegarder les fichiers
et rapports avant tout changement d'hébergement. Ne pas placer ces fichiers
volumineux dans Git.

## Hébergement Hostinger

Le serveur lit par défaut `UPLOADS_DIR/android-releases`. Le volume existant
`/data/uploads` du VPS peut donc conserver les APK et leur historique.
`ANDROID_RELEASES_DIR` permet de choisir un autre stockage persistant.
Les fichiers préparés doivent être transférés par l'opérateur dans ce répertoire
avec leur manifeste et leurs rapports. Le site ne publie rien automatiquement.

Définir `PUBLIC_APP_URL` (ou `SITE_URL`) sur l'origine HTTPS officielle pour les
liens canoniques, le sitemap `/sitemap-android.xml` et `robots.txt`. Sans cette
configuration, la page reste en `noindex`. Le Caddyfile fourni doit être déployé
pour transmettre `/telecharger`, `/robots.txt` et `/sitemap-android.xml` au backend.
Fusionner cette règle avec tout `robots.txt` ou sitemap personnalisé du VPS
avant déploiement.

Les routes `/api/android/releases` et `/api/android/releases/{version}/download`
ne renvoient que des versions validées et intègres. Le bouton principal utilise
la version au code Android le plus élevé ; les liens des versions précédentes
restent accessibles. Aucune clé privée n'est nécessaire au serveur de téléchargement.

## Parrain officiel

Le parrain par défaut est trouvé par `ADMIN_EMAIL`, la même identité officielle
que celle utilisée au démarrage du serveur. Ce compte doit être administrateur
actif. Il n'y a aucun pseudo administrateur inscrit en dur pour ce défaut.
Un code fourni mais invalide reste une erreur explicite, conformément au plan
accepté ; seul un code absent/blanc déclenche le défaut.

L'attribution est enregistrée lors de la création du compte. Cette modification
n'ajoute aucun moyen utilisateur de changer le parrain après inscription.
Les anciens comptes, la matrice, les commissions et les paiements ne sont pas
modifiés. Les fonctions administratives préexistantes restent inchangées.
