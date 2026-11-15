# SPILOVEURE Chat — comportements

Cette note décrit les interactions ajoutées pour les conversations, les statuts, les groupes et les canaux. Elles reprennent des conventions courantes de messagerie mobile; l’interface n’est pas une copie pixel par pixel de Telegram ou WhatsApp.

## Statuts

- Un contact ayant un statut actif reçoit un anneau autour de sa photo dans la liste des conversations et l’en-tête d’une conversation privée.
- Toucher l’anneau ouvre le statut. La fermeture ramène à l’écran précédent.
- Maintenir le doigt ou le pointeur sur un statut met sa progression en pause; le relâcher reprend la lecture. Les vidéos sont également mises en pause.
- Les statuts personnels s’affichent de gauche à droite; le balayage horizontal passe au statut précédent ou suivant, y compris au statut d’un autre contact.
- La durée de vie des statuts reste celle déjà définie par le service de statuts.

## Actualités SPILOVEURE

- Seuls les comptes ayant le rôle administrateur peuvent publier une actualité officielle avec du texte, une photo ou une vidéo.
- Les actualités officielles sont visibles à tous les utilisateurs Chat, sans dépendre de leur liste de contacts. Les membres gardent leurs statuts personnels, distincts de ces actualités.
- Un compteur apparaît sur l’onglet **Statuts** lorsqu’une actualité est non lue. L’ouvrir marque comme lues les actualités affichées jusqu’à la plus récente.
- Les anciennes publications communautaires non officielles ne sont pas supprimées, mais ne s’affichent plus dans cette section.

## Conversations

- Les textes longs et les liens sans espaces doivent revenir à la ligne dans les bulles, les réponses citées et les champs de saisie.
- Les photos et vidéos de profil, les messages et les médias gardent leurs parcours existants.

## Groupes

Les administrateurs peuvent régler les droits suivants :

- **Envoi** : tous les membres peuvent écrire, ou seuls les administrateurs.
- **Invitations** : les membres peuvent ou non ajouter des personnes et créer un lien d’invitation.
- **Informations** : les membres peuvent ou non modifier le nom du groupe.

La liste des membres, les rôles administrateur, l’ajout, le retrait et la sortie du groupe restent accessibles selon les droits du compte.

## Canaux

- Les canaux peuvent rester publics ou être privés.
- Les administrateurs publient; les autres membres sont présentés comme abonnés.
- Un administrateur peut créer un lien d’invitation et le révoquer.

## Liens d’invitation

- Le lien mène à `/messenger?invite=…`; son ouverture dans l’application nécessite une session Chat valide.
- Le serveur ne conserve que l’empreinte du code d’invitation, pas le code en clair.
- Créer un nouveau lien désactive le précédent. Un administrateur peut désactiver le lien actif.
- Un lien désactivé ou invalide ne permet pas de rejoindre la conversation.
- La limite actuelle de la conversation reste de 200 membres.

## Références de conception

- Telegram Stories : https://telegram.org/tour/stories?setln=fr
- Telegram — droits des membres et administrateurs : https://core.telegram.org/api/rights
- WhatsApp — paramètres d’administration des groupes : https://faq.whatsapp.com/526742385997912
