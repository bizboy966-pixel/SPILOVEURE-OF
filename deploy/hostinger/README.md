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
cp .env.example .env                 # DOMAIN=test.spiloveure.com (puis spiloveure.com)
cp backend.env.example backend.env   # copier les valeurs depuis Emergent → Re-publish → Secrets
cp frontend.env.example frontend.env # même domaine que DOMAIN + clés Firebase publiques
nano backend.env
```
`MONGO_URL` est déjà réglé dans docker-compose (mongodb://mongo:27017) — ne pas le mettre.
Gardez le **même DB_NAME** et le **même JWT_SECRET** qu'en production.

## 3. Le domaine doit pointer vers le VPS AVANT le démarrage
Cloudflare : enregistrement A `test` → IP du VPS, **nuage gris (DNS only)** pour que le
certificat HTTPS soit délivré. Ports 80 et 443 ouverts dans le pare-feu.

## 4. Démarrer
```bash
docker compose up -d --build
docker compose logs -f backend      # Ctrl+C pour quitter
```
Test : `https://test.spiloveure.com` et `https://test.spiloveure.com/api/config`.

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
2. `.env` et `frontend.env` → `spiloveure.com`, puis `docker compose up -d --build`.
3. Cloudflare : `spiloveure.com` → IP du VPS.
4. Changer l'URL des webhooks chez Biz-transPay, AshTech, SoleasPay, IziChange :
   `https://spiloveure.com/api/webhooks/<fournisseur>`.

## Mises à jour
```bash
cd /opt/spiloveure && git pull && cd deploy/hostinger && docker compose up -d --build
```

## Sauvegarde manuelle de la base
```bash
docker compose exec mongo mongodump --out /dump/backup-$(date +%F)
```
