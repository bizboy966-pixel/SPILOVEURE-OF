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

La documentation publique ne donne pas la devise facturée par pays, la liste
des pays Pay-in autorisés pour chaque compte marchand, ni un paramètre pour
imposer un opérateur. Ces éléments doivent être confirmés dans le compte
marchand MoneyFusion. N’activez que des pays réellement autorisés par ce compte.

Le catalogue fourni par `/api/v1/withdraw/methods` est un catalogue de retrait,
pas une preuve indépendante de couverture Pay-in. Les interrupteurs du panneau
administrateur servent à affecter les pays et opérateurs après vérification du
compte marchand. Le formulaire Pay-in hébergé ne reçoit pas l’opérateur choisi :
un pays n’est proposé dans l’application que si tous ses opérateurs du catalogue
sont activés et attribués à MoneyFusion. Vérifiez également dans le tableau de
bord marchand que le checkout ne propose que les moyens de paiement souhaités.

## Configuration administrateur

Dans **Prestataires de paiement → MoneyFusion** :

- Saisir l’URL API marchande Pay-in et/ou la clé privée Pay-out. Le bouton
  **Enregistrer** apparaît quand une valeur ou un interrupteur change.
- Les champs vides conservent les identifiants déjà enregistrés.
- Activer ou désactiver les dépôts et les retraits séparément.
- Actualiser le catalogue puis activer les pays et opérateurs utiles dans la
  liste des prestataires. Les nouveaux opérateurs sont désactivés par défaut et
  les désactivations sont conservées lors des synchronisations.
- Pour que MoneyFusion soit choisi pour les retraits avant un autre
  prestataire actif, ajuster sa priorité dans cette même liste.
- L’**IP publique fixe de sortie du VPS** doit être autorisée dans le tableau de
  bord MoneyFusion avant le premier retrait. Le prestataire refuse les requêtes
  provenant d’une autre adresse.

Les frais d’activation restent fixés à **2 650 XOF**. XOF et XAF sont convertis
à parité ; les autres devises MoneyFusion sont converties automatiquement avec
les taux de référence publics de Frankfurter. Ce sont des taux de référence,
pas des cotations de marché instantanées. Le serveur tente une actualisation
automatique au moins toutes les 12 heures et conserve la date du taux utilisé
sur chaque paiement et retrait. Si aucun taux valide de moins de cinq jours
n’est disponible, le pays ou l’envoi concerné est bloqué : aucun montant
approximatif ni taux saisi manuellement n’est utilisé.

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

Le total payé pour l’activation est **2 650 XOF, frais inclus**. Selon la
réponse vérifiée de MoneyFusion, `Montant` représente le brut ou le net :
le rapprochement exige `Montant = total` ou `Montant + frais = total`.
Un montant net inférieur ne bloque donc pas l’activation si les frais expliquent
exactement la différence. Aucun supplément n’est ajouté au prix client.
Les anciens paiements en revue pour écart de montant sont revérifiés par le
statut ou un nouveau webhook, sans nouvelle demande de débit.
Le statut `no paid` signifie « non encore payé », pas un échec définitif.

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
