# Activation de Resend pour SPILOVEURE

Le domaine `spiloveure.org` a été ajouté dans Resend pour l’envoi uniquement, région Europe, sans suivi des ouvertures ou des clics. La réception existante des e-mails et les DNS du site n’ont pas été modifiés.

**L’envoi réel attend la vérification DNS.** Les serveurs DNS publics observés sont `hermes.dns-parking.com` et `artemis.dns-parking.com`. Ajouter les lignes suivantes dans la zone DNS active du domaine, normalement dans Hostinger avec cette configuration.

| Type | Nom relatif | Valeur / cible | Priorité |
| --- | --- | --- | --- |
| TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC9+870gt+HUduusC6HRd/wf0MSKvmza7f+SImJj2+L/LwWc9Hdb6Sxonge4dWd5wAQgCEimKaoiQmt7wdtoMj6JgPzm8W9lXCHKXNMNXFHsnJC2kVz5gSlgIcUWwxVkXt17oUzcc1+bn8+b7md71s/oIp7k/rQfuV00ajj/pRxvwIDAQAB` | — |
| MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` | 10 |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | — |
| CNAME | `rsend` | `send.forge.rmta.net` | — |

TTL : valeur par défaut / Auto. Ces valeurs sont publiques, notamment la clé publique DKIM ; ce ne sont pas des identifiants d’accès.

## Précautions

- Ne pas changer les A/AAAA/CNAME du site, `@`, `www`, les serveurs de noms, ou les MX du domaine racine.
- Les MX/TXT ci-dessus concernent **le sous-domaine `send`**, pas la messagerie entrante de `spiloveure.org`.
- Si une ligne du même nom existe avec une valeur différente, ne pas la remplacer sans examiner le conflit.
- Après propagation, déclencher ou vérifier la validation du domaine dans Resend. La disponibilité de l’envoi dans l’aperçu est contrôlée automatiquement, avec un cache d’une minute.
- L’aperçu est configuré avec le connecteur autorisé et l’expéditeur `SPILOVEURE <no-reply@spiloveure.org>`. Aucune clé privée n’est exposée.

## Différence pour le VPS

Les autorisations du connecteur Replit ne se transfèrent **pas** avec `git push`. Sur le VPS, conserver toutes les variables existantes et ajouter dans `deploy/hostinger/backend.env` :

```text
MAIL_PROVIDER=resend
MAIL_FROM=SPILOVEURE <no-reply@spiloveure.org>
MAIL_DOMAIN_VERIFIED=1
```

Ajouter également `RESEND_API_KEY` dans le fichier protégé de l’environnement du VPS, sans l’inscrire dans Git ni la communiquer dans le chat. N’activer `MAIL_DOMAIN_VERIFIED=1` qu’après confirmation effective de Resend. Ne pas copier la valeur `resend_connector` vers le conteneur Python du VPS.

Le fichier de configuration doit rester privé et toutes les variables de paiement existantes doivent être conservées.
