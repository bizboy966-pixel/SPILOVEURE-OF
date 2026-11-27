---
name: Contrat marchand Biz-transPay
description: Source officielle, limites des clés de test et décisions de sécurité financière.
---

Suivre le contrat marchand de https://biz-transpay.com/integration/docs plutôt
que les anciennes suppositions de pays ou les correspondances internes.
Un catalogue d’encaissement ne prouve pas la disponibilité d’un retrait.

**Why:** L’utilisateur a imposé cette documentation comme référence ; les
routes disponibles dépendent de la configuration réelle du compte marchand.

**How to apply:** Les anciens noms restent des alias de compatibilité, jamais
une justification pour proposer ou lancer une opération absente du catalogue
du sens demandé.

Ne pas effectuer de POST financier pour « tester les clés ». Les clés de test
ne simulent pas les écritures financières selon cette documentation.

**Why:** Une clé Live déclenche une vraie opération ; une réponse réseau
incertaine n’établit ni un échec ni la possibilité d’un remboursement.

**How to apply:** Garder les validations automatisées isolées du réseau
marchand et conserver une opération incertaine jusqu’au rapprochement,
sans nouvelle soumission ni remboursement automatique.

Les retraits crypto utilisent `POST /crypto/payouts` et l’actif exact du
catalogue `GET /crypto/assets?direction=payout`; le statut peut être relu par
`GET /crypto/payouts/{id}` et confirmé par `crypto.payout.status_changed`.
Chaque création requiert une clé d’idempotence et les scopes/autorisation
Live adéquats.

**Why:** La disponibilité et les codes réseau varient selon le catalogue de
retrait du compte marchand, même si le profil utilisateur reste fixe.

**How to apply:** N’envoyer que l’actif USDT.BEP20 correspondant au catalogue
actif. Les appels réseau incertains gardent les fonds réservés jusqu’au
rapprochement; ne jamais retenter avec une nouvelle clé ni rembourser sans
échec terminal confirmé.

Pour Wave CI en Pay-in, suivre la réponse du dépôt plutôt que supposer un seul
parcours : ouvrir une URL de paiement HTTPS lorsqu’elle est renvoyée; si le
catalogue/résultat indique un push sans URL, laisser l’utilisateur valider dans
Wave et garder le suivi de statut actif. Ne jamais fabriquer un lien Wave.

**Why:** L’API peut fournir une page hébergée ou une demande Mobile Money selon
le flux du compte marchand; aucun paiement réel n’a été lancé pour confirmer
le comportement d’un compte précis.

**How to apply:** Extraire les champs de redirection explicites des enveloppes
de réponse documentées, préouvrir un onglet Web dans le geste utilisateur pour
éviter le blocage des pop-ups, et proposer un bouton de secours si nécessaire.
