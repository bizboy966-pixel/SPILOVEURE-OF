# Biz-transPay — configuration Mobile Money

Documentation de référence : https://biz-transpay.com/integration/docs

## Trois identifiants dans l’administration

Dans **Prestataires de paiement → Configuration des clés → Biz-transPay** :

1. **Clé publique** : envoyée dans `X-Public-Key`.
2. **Clé secrète** : envoyée comme jeton `Authorization: Bearer`.
3. **Secret webhook** : utilisé pour vérifier la signature HMAC-SHA256 des
   notifications sur le corps brut, précédé du timestamp et d’un point.

Les deux clés API doivent appartenir au même environnement et au même compte.
Les champs ne sont jamais préremplis avec les secrets enregistrés et les
réponses administrateur ne contiennent que des valeurs masquées.
Ne jamais les mettre dans Git, un message ou une capture.
Les champs vides conservent les valeurs actuelles ; « Effacer » les supprime
de la configuration en base. Un identifiant fourni par l’environnement serveur
reste prioritaire en dernier recours ; le supprimer aussi du gestionnaire de
secrets du serveur si l’on veut le révoquer.

L’URL webhook est affichée dans cette section ; renseigner une URL HTTPS
publique du serveur cible et le même secret dans Biz-transPay. L’absence de
secret fait refuser les notifications, elle ne désactive jamais leur sécurité.
Les clés de test ne simulent pas les écritures financières chez Biz-transPay.
Les retraits Live exigent les droits `payouts:write`, l’autorisation explicite
des retraits API et le KYC marchand validé.

## Catalogue

Enregistrer les deux clés puis cliquer **Actualiser le catalogue**.
Deux onglets distincts interrogent la configuration effective du compte :

- Encaissements : `GET /mobile-money/operators?direction=deposit`.
- Retraits : `GET /mobile-money/operators?direction=payout`.

Les pays, devises, codes exacts et parcours OTP/USSD viennent de ces réponses,
pas d’une liste supposée. Les interrupteurs pays/opérateur agissent sur la
configuration locale commune ; ils ne rendent jamais disponible un opérateur
absent du catalogue du sens demandé. Une actualisation conserve les
désactivations. Une erreur de chargement est affichée explicitement.
Les anciennes correspondances de noms d’opérateurs restent utilisables pour
les portefeuilles déjà enregistrés.

## Paiement et activation

Le montant de base est de **2 650 XOF**. Les frais sont supportés par le
marchand (`fee_bearer=receiver`), pour ne pas les ajouter au montant du client.
Un devis `/deposits/quote` est requis avant le dépôt. Un devis indisponible
ou ne correspondant pas au montant attendu bloque la création.

Les parcours documentés sont conservés : demande OTP préalable, OTP généré par
USSD, autorisation USSD préalable, et redirection HTTPS retournée notamment
pour Wave. La confirmation du paiement active le compte côté serveur.
Une notification dupliquée n’est pas une nouvelle activation.

Un paiement déjà en cours retourne sa référence existante. Une soumission
incertaine conserve son intention et n’est pas remplacée par un nouveau débit.
Les retraits sont réservés en base avant le POST, avec une clé d’idempotence
stable dérivée de leur identifiant. Après un résultat incertain, ne pas
rembourser, renvoyer ou valider manuellement avant rapprochement marchand.

## Déploiement et contrôles réels

Aucun changement sur Hostinger n’est appliqué depuis l’aperçu.
Configurer les clés et le webhook sur le serveur de production après
sauvegarde et mise à jour manuelle. Les tests automatisés isolent HTTP et MongoDB :
ils n’envoient pas d’argent. L’affichage du catalogue réel et un parcours
marchand contrôlé restent à vérifier avec les identifiants autorisés.
