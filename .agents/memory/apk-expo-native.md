---
name: Remplacement APK Android
description: Décision de migrer l’APK officiel Expo vers Capacitor en conservant l’identité et la signature Android.
---

L’utilisateur veut remplacer l’APK officiel Expo par le prototype Capacitor, avec le front-end embarqué et le backend sur le VPS. Le prototype Capacitor a été testé avec succès par l’utilisateur.

**Why:** L’utilisateur a explicitement demandé le remplacement de l’APK officiel par Capacitor après avoir testé le prototype.

**How to apply:** L’APK officiel actuel reste Expo tant que la clé de signature EAS n’est pas récupérée. Pour installer Capacitor comme une mise à jour sans désinstaller Expo, conserver `com.spilivere.app` et signer avec la même clé de production. Ne jamais inclure une clé dans GitHub.

Le prototype Capacitor de test utilise un identifiant et une signature distincts. Il peut coexister avec Expo, mais ne remplace pas l’application installée.

**Why:** Android exige la même signature pour accepter une mise à jour de la même application ; l’APK de test actuel est signé en debug et porte un autre identifiant.

**How to apply:** Tant que la clé officielle n’est pas accessible, garder l’APK Expo officiel inchangé. Si la clé ne peut pas être récupérée, ne proposer qu’un APK Capacitor séparé qui ne met pas à jour les installations Expo.
