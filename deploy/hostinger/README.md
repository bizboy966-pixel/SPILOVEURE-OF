# Déployer SPILOVEURE sur un VPS Hostinger (Docker)

3 conteneurs : `mongo` (base de données, jamais exposée), `backend` (FastAPI, 1 worker),
`web` (Caddy : site + HTTPS automatique + `/api` → backend).

## 1. Récupérer le code
```bash
cd /opt && git clone -b main https://github.com/<votre-compte>/<votre-depot>.git spiloveure
cd /opt/spiloveure/deploy/hostinger
```

## 2. Créer les 3 fichiers de configuration (jamais dans GitHub)
```bash
   cp .env.example .env                 # DOMAIN=test.spiloveure.org (puis spiloveure.org)
cp backend.env.example backend.env   # copier les valeurs depuis Emergent → Re-publish → Secrets
cp frontend.env.example frontend.env # même domaine que DOMAIN + clés Firebase publiques
nano backend.env
```
`MONGO_URL` est déjà réglé dans docker-compose (mongodb://mongo:27017) — ne pas le mettre.
Le build web prend automatiquement `https://${DOMAIN}` comme adresse API, même si `frontend.env` contient une ancienne URL.
Gardez le **même DB_NAME** et le **même JWT_SECRET** qu'en production.

## 3. Le domaine doit pointer vers le VPS AVANT le démarrage
Cloudflare : enregistrement A `test` → IP du VPS, **nuage gris (DNS only)** pour que le
certificat HTTPS soit délivré. Ports 80 et 443 ouverts dans le pare-feu.

## 4. Démarrer
```bash
docker compose up -d --build
docker compose logs -f backend      # Ctrl+C pour quitter
```
Test : `https://test.spiloveure.org` et `https://test.spiloveure.org/api/config`.

## 5. Importer la base de production (sans perte)
1. Emergent → Re-publish → Database → copier l'URL → https://mongodb-viewer-2.emergent.host/ → **Dump DB** → télécharger.
2. Envoyer le fichier sur le VPS dans `/opt/spiloveure/deploy/hostinger/dump/` puis le décompresser.
3. Restaurer :
```bash
docker compose exec mongo mongorestore --drop /dump
docker compose restart backend
```
(`--drop` remplace les collections déjà créées au premier démarrage.)

## 6. Bascule finale (heure calme)
1. Faire un **dernier Dump DB** juste après avoir mis Emergent hors ligne, puis refaire l'étape 5.
2. `.env` et `frontend.env` → `spiloveure.org`, puis `docker compose up -d --build`.
3. Cloudflare : `spiloveure.org` → IP du VPS.
4. Changer l'URL des webhooks chez Biz-transPay, AshTech, MoneyFusion, IziChange :
   `https://spiloveure.org/api/webhooks/<fournisseur>`.

## Mises à jour
```bash
cd /opt/spiloveure && git pull && cd deploy/hostinger && docker compose up -d --build
```

## Relier le preview Replit à l’API du VPS
Le preview peut appeler l’API HTTPS du VPS par le proxy de développement Replit.
MongoDB reste privé dans Docker ; ne publiez pas le port `27017` et ne configurez
pas de tunnel SSH pour ce flux.

1. Mettre à jour et reconstruire le VPS avec les changements du dépôt, puis vérifier
   que `backend.env` contient `CORS_ORIGINS=https://spiloveure.org`.
2. Dans Replit, définir `SPV_PREVIEW_API_UPSTREAM=https://spiloveure.org` uniquement
   dans l’environnement **Development**, puis redémarrer le workflow `SPILOVEURE`.
   Laisser `EXPO_PUBLIC_BACKEND_URL` vide dans le preview Web : les appels restent
   sur le domaine Replit et le gateway les relaie à l’API VPS.
3. Chaque requête du preview utilisera alors la base réelle et pourra créer ou
   modifier des données de production. Le workflow Replit ne démarre plus de
   MongoDB ni de backend local ; sans `SPV_PREVIEW_API_UPSTREAM`, il s’arrête
   explicitement au lieu de basculer vers une base locale.

## Sauvegarde manuelle de la base
```bash
docker compose exec mongo mongodump --out /dump/backup-$(date +%F)
```
