---
name: Double authentification admin
description: Règles de sécurité pour l’accès discret au panneau administrateur SPILOVEURE.
---

Le geste caché sur le niveau du profil ne sert qu’à afficher la vérification; il ne remplace jamais l’authentification. Toutes les API administrateur doivent exiger un jeton de vérification renforcée après TOTP. Le secret Authenticator est chiffré au repos, et les codes de secours sont hachés et à usage unique.

**Why:** masquer un lien ne protège ni l’URL admin ni ses API; le panneau contient des opérations sensibles.

**How to apply:** conserver le contrôle côté serveur sur chaque route admin, garder le jeton renforcé en mémoire seulement et ne pas exposer le secret TOTP dans les profils ou réponses utilisateur. La clé de chiffrement est dérivée du `JWT_SECRET`; une rotation de ce secret rend les graines TOTP existantes illisibles et doit être accompagnée d’une procédure de réinscription.
