# Resend pour SPILOVEURE — configuration mise à jour

**Ne pas appliquer les quatre anciens enregistrements DNS du premier rapport.** Ils provenaient de la connexion initiale du workspace, qui ne correspondait pas à la configuration Resend validée par l’utilisateur.

L’utilisateur a configuré les DNS dans Hostinger et validé `spiloveure.org` dans son compte Resend. Sa propre clé a ensuite été enregistrée dans les Secrets du projet, sans être exposée dans le chat ni dans Git.

Un envoi natif depuis `SPILOVEURE <no-reply@spiloveure.org>` vers l’adresse technique de test de Resend a été accepté par l’API (HTTP 200). Cela vérifie l’autorisation de la clé et de l’expéditeur, **pas encore la réception d’un code dans une vraie boîte e-mail**.

L’aperçu utilise désormais `MAIL_PROVIDER=resend`, `MAIL_DOMAIN_VERIFIED=1` et la clé personnelle sécurisée. L’ancien connecteur n’est plus utilisé pour ces envois.

## Précautions et contrôle restant

- Ne pas modifier les DNS actuellement validés, les A/AAAA du site, les serveurs de noms ou les MX de la messagerie existante.
- Si les DNS doivent changer à l’avenir, prendre les valeurs du même compte Resend que celui de la clé utilisée par l’application.
- Une clé limitée à l’envoi suffit ; un refus de lecture de `/domains` ne signifie pas qu’elle est invalide.
- Contrôle restant : demander un code depuis le parcours réel et confirmer sa réception, y compris dans les indésirables.
- Aucun vrai utilisateur n’a été destinataire de l’envoi technique, et aucun paiement n’a été effectué.

## Différence pour le VPS

Les autorisations du connecteur Replit ne se transfèrent **pas** avec `git push`. Sur le VPS, conserver toutes les variables existantes et ajouter dans `deploy/hostinger/backend.env` :

```text
MAIL_PROVIDER=resend
MAIL_FROM=SPILOVEURE <no-reply@spiloveure.org>
MAIL_DOMAIN_VERIFIED=1
```

Ajouter également `RESEND_API_KEY` dans le fichier protégé de l’environnement du VPS, sans l’inscrire dans Git ni la communiquer dans le chat. N’activer `MAIL_DOMAIN_VERIFIED=1` qu’après confirmation effective de Resend. Ne pas copier la valeur `resend_connector` vers le conteneur Python du VPS.

Le fichier de configuration doit rester privé et toutes les variables de paiement existantes doivent être conservées.
