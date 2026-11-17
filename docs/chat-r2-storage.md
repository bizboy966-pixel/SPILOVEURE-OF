# Stockage R2 des pièces jointes SPILOVEURE Chat

Les messages, membres et métadonnées restent dans MongoDB sur le VPS. Le contenu binaire des pièces jointes du Chat (photos, vocaux, vidéos, documents, médias du fil et stickers) est stocké dans un bucket Cloudflare R2 privé.

Le navigateur demande un lien PUT présigné au backend, envoie le fichier directement dans R2, puis confirme l’envoi. Pour la lecture, le backend vérifie l’identité et les droits d’accès avant d’émettre un lien GET temporaire. Les messages vocaux à écoute unique restent transmis par le backend afin de préserver l’usage unique. La conversion vidéo des stickers utilise encore un fichier temporaire sur le VPS; le sticker final est enregistré dans R2.

## Configuration à ajouter sur le VPS

Créer un bucket R2 privé et un jeton API R2 limité à la lecture/écriture des objets de ce bucket. Ajouter les variables suivantes à l’environnement du conteneur backend, sans les inscrire dans GitHub ni dans le code :

- `R2_ACCOUNT_ID`
- `R2_BUCKET_NAME`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ALLOWED_ORIGINS` — origines web HTTPS séparées par des virgules, notamment `https://spiloveure.org` et le domaine exact du preview Replit utilisé.
- `R2_ENDPOINT_URL` — optionnel; par défaut `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.

Une fois ces variables présentes, afficher la politique CORS sans rien modifier :

```bash
python backend/scripts/configure_messenger_r2_cors.py
```

Après vérification des origines, l’appliquer explicitement :

```bash
python backend/scripts/configure_messenger_r2_cors.py --apply
```

## Fichiers déjà présents sur le VPS

Le script de migration est en lecture seule par défaut :

```bash
python backend/scripts/migrate_messenger_files_to_r2.py
```

Après sauvegarde et vérification des identifiants R2, `--apply` copie les pièces jointes locales, vérifie leur taille dans R2 et met à jour leur métadonnée MongoDB. Il ne supprime jamais les fichiers locaux :

```bash
python backend/scripts/migrate_messenger_files_to_r2.py --apply
```

Les fichiers envoyés avant migration restent disponibles depuis le disque local tant que leurs métadonnées n’indiquent pas R2.
