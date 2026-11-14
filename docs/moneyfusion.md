# MoneyFusion — Mobile Money

## État et limites à connaître avant activation

Les encaissements et retraits sont désactivés par défaut. Aucun paiement réel
n’est effectué par les tests automatisés.

Sources officielles consultées :

- <https://docs.moneyfusion.net/en/webapi>
- <https://docs.moneyfusion.net/en/payout>
- Catalogue des retraits : <https://pay.moneyfusion.net/api/v1/withdraw/methods>

La documentation Pay-in décrit une URL API marchande, `totalPrice`,
`numeroSend`, `nomclient`, `article`, `personal_Info`, `return_url` et
`webhook_url`. Elle ne documente **ni paramètre de devise, ni filtre
d’opérateur, ni filtre Mobile Money uniquement**.

Avant d’activer un encaissement, obtenir auprès de MoneyFusion :

1. La confirmation de la devise attendue par `totalPrice` pour chaque pays.
   L’implémentation actuelle exige une confirmation explicite de facturation
   dans la devise locale. Si le compte facture dans une autre devise, adapter
   le code au contrat confirmé avant activation.
2. La confirmation des pays autorisés en Pay-in pour le compte marchand.
3. Une page hébergée limitée au Mobile Money, sans carte ni autre moyen de
   paiement. Si MoneyFusion ne permet pas cette restriction, ne pas cocher
   la confirmation et ne pas activer le Pay-in.

Le catalogue public des retraits n’est pas une preuve de couverture Pay-in.
Les contrôles d’opérateurs s’appliquent directement au Pay-out. Pour le
Pay-in, si un opérateur du catalogue d’un pays est désactivé, ce pays
est bloqué dans l’application, car la requête hébergée ne permet pas
d’imposer un opérateur précis. Les restrictions sur la page hébergée
elle-même doivent être assurées par MoneyFusion ; l’application ne peut pas
les inventer.

## Configuration administrateur

Dans **Prestataires de paiement → MoneyFusion** :

- Saisir l’URL API marchande Pay-in et/ou la clé privée Pay-out.
- Les champs vides conservent les identifiants déjà enregistrés.
- Pour effacer un identifiant, utiliser le contrôle d’effacement et enregistrer.
- Configurer les confirmations et pays Pay-in seulement après accord de
  MoneyFusion.
- Actualiser le catalogue officiel puis activer les pays et opérateurs utiles
  dans la liste des prestataires. Les nouveaux opérateurs sont désactivés par
  défaut et les désactivations sont conservées lors des synchronisations.
- Pour que MoneyFusion soit choisi pour les retraits avant un autre
  prestataire actif, ajuster sa priorité dans cette même liste.
- Avant d’activer le Pay-out, enregistrer l’**IP publique de sortie fixe du VPS**
  dans le tableau de bord MoneyFusion. Ne pas supposer que l’adresse de sortie
  correspond à une ancienne adresse communiquée.

Les frais d’activation sont de **2 650 XOF**. XOF et XAF sont convertis à parité.
Pour USD, GHS, GNF et KES, saisir un taux exprimant **1 XOF en devise locale**.
Le calcul du montant est automatique à partir du taux enregistré, mais le
taux lui-même est **manuel**, pas un cours de change en direct. Sans taux,
le pays correspondant n’est pas disponible. Chaque transaction conserve
le taux et le montant d’origine. Les montants USD/GHS/KES sont arrondis à
deux décimales ; XOF/XAF/GNF à l’unité.

## Paramètres du serveur

Configurer ces variables sur le serveur cible avant d’y enregistrer les clés :

- `PUBLIC_APP_URL` : URL publique HTTPS du site (ou `SITE_URL` en second choix).
  Ne pas utiliser une adresse d’aperçu pour le VPS de production.
- `SESSION_SECRET` : secret stable, aléatoire, d’au moins 24 caractères.
  Les identifiants MoneyFusion sont chiffrés en base avec AES-GCM à partir
  de ce secret, avec séparation de contexte. **Le conserver dans le gestionnaire
  de secrets du serveur et dans les sauvegardes sécurisées.**

Une rotation de `SESSION_SECRET` exige une migration chiffrée des identifiants.
Ne pas remplacer le secret sans migration : les identifiants enregistrés
deviendraient illisibles. Aucun secret ne doit être ajouté au dépôt Git.
Le secret de l’aperçu Replit n’est pas automatiquement celui du VPS.

Webhooks publics :

- `POST /api/webhooks/moneyfusion/payin`
- `POST /api/webhooks/moneyfusion/payout`

## Vérification et suivi

Le navigateur ne peut pas activer un compte en annonçant un paiement réussi.
Le serveur vérifie la transaction avec MoneyFusion et compare le token,
le montant, la référence, le compte et le téléphone avant activation.

Les retraits sont soumis automatiquement lors de la demande utilisateur si
MoneyFusion est sélectionné par le routeur et que tous les contrôles sont
valides. L’activation du Pay-out autorise donc des envois réels sans
validation individuelle supplémentaire de l’administrateur.

Chaque demande de retrait est réservée avant son envoi. Après une erreur
réseau ambiguë, le transfert n’est jamais renvoyé automatiquement.
Les actions manuelles de validation/remboursement sont bloquées tant que le
transfert peut être en cours. Dans MoneyFusion, récupérer le token de la
demande initiale, puis utiliser **Vérifier un retrait déjà envoyé** dans
les réglages administrateur. Cette action vérifie le statut ; elle ne
soumet pas un nouveau retrait. Un remboursement n’est appliqué qu’après
un échec confirmé par le serveur du prestataire.

Les confirmations Webhook sont vérifiées auprès du prestataire ; la
documentation consultée ne fournit pas de signature Webhook à vérifier.

Les tests locaux et la compilation web ne remplacent pas un contrôle
marchand réel des devises, de la restriction Mobile Money et de l’IP
autorisée. Ne pas activer la production avant ces confirmations.
