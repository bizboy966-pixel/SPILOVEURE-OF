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
