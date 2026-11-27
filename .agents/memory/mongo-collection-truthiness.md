---
name: Collections Mongo non booléennes
description: Règle de présence et de test pour les collections PyMongo et Motor.
---

Ne jamais tester directement la valeur booléenne d’une collection PyMongo ou Motor. Pour une collection facultative obtenue avec `getattr`, utiliser `collection is not None`.

**Why:** Les collections réelles lèvent une erreur lorsqu’on les convertit en booléen; dans un flux de retrait, cela peut interrompre la confirmation, la comptabilité et la notification après un paiement réussi.

**How to apply:** Appliquer cette règle aux chemins de webhook, de rapprochement périodique et de règlement; utiliser un faux objet de collection qui refuse `bool()` dans les tests de régression.
