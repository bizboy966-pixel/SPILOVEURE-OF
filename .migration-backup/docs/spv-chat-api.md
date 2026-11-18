# SPILOVEURE Chat — contrat d’intégration

Module indépendant du support `/api/chat`. Authentification Bearer existante, mêmes comptes et règles d’activation. Préfixe `/api/messenger` (donc `api.get("/messenger/...")`). Les erreurs ont `detail` en français. Ne pas afficher de fonctions non implémentées comme disponibles.

## Types JSON

- `Person`: `{id, username, avatar?: string, online?: boolean, last_seen?: string}`. Aucun email, téléphone ou solde exposé.
- `Conversation`: `{id, kind:"private"|"group"|"channel"|"saved", title, photo?:string, members:string[], admins:string[], owner_id, created_at, updated_at, last_message?:Message, unread:number, muted:boolean, archived:boolean, pinned:boolean, draft:string, read_at?:string, member_profiles:Person[]}`.
- `Message`: `{id, conversation_id, sender_id, sender_name, text, created_at, edited_at?:string, deleted:boolean, attachments:Attachment[], reply_to?:string, reactions:Record<string,string[]>, pinned:boolean, read_by:string[], client_id?:string, forwarded_from?:string}`.
- `Attachment`: `{id,name,mime,size,url}`. URL protégée : ouvrir via fetch Bearer puis object URL, jamais transmettre le JWT dans une URL.
- `Post`: `{id,author_id,author_name,text,attachments:Attachment[],visibility:"contacts"|"public",created_at,reactions:Record<string,string[]>,comments:{id,user_id,username,text,created_at}[]}`.

## Routes REST

- `GET /people?q=...` => `Person[]`, recherche membres (min 2 caractères).
- `GET /contacts` => `{contacts:Person[],blocked:Person[],requests:Person[],sent:string[]}`.
- `POST /contacts/{id}` => `{ok:true}`, demande de contact ; `POST /contacts/{id}/accept`; `DELETE /contacts/{id}`.
- `POST /blocks/{id}`, `DELETE /blocks/{id}`.
- `POST /reports` corps `{user_id,reason}`.
- `GET /conversations?archived=false` => `Conversation[]`.
- `POST /conversations` corps `{kind,title?,member_ids?:string[]}` => `Conversation`. Une privée demande un seul destinataire. saved = messages enregistrés. Groupe/canal = titre obligatoire.
- `GET /conversations/{id}` => `Conversation`.
- `PATCH /conversations/{id}` corps `{title?,photo?,muted?,archived?,pinned?,draft?}` => `Conversation`. Titre/photo admins seulement ; préférences propres à chacun.
- `POST /conversations/{id}/members` corps `{user_id,action:"add"|"remove"|"promote"|"demote"}` => `{ok:true}` (admins seulement).
- `POST /conversations/{id}/leave` => `{ok:true}` ; propriétaire doit supprimer le groupe plutôt que partir.
- `DELETE /conversations/{id}` => `{ok:true}` (propriétaire groupe/canal ; participant conversation privée : archive pour soi).
- `GET /conversations/{id}/messages?before=<message-id>&q=...&limit=50` => `{items:Message[],has_more:boolean}`. Liste ascendante. Recherche texte littérale.
- `POST /conversations/{id}/messages` corps `{text,client_id,attachments?:Attachment[],reply_to?:string,forwarded_from?:string,silent?:boolean}` => `Message`. Conserver le même client_id lors d’une relance réseau.
- `PATCH /conversations/{id}/messages/{mid}` corps `{text}` => `Message`. Auteur seulement.
- `DELETE /conversations/{id}/messages/{mid}` => `{ok:true}`. Auteur ou admin groupe.
- `POST /conversations/{id}/messages/{mid}/reaction` corps `{emoji}` => `Message`. Bascule réaction.
- `POST /conversations/{id}/messages/{mid}/pin` => `Message`. Bascule épingle ; admin groupe/canal seulement.
- `POST /conversations/{id}/read` => `{ok:true}`.
- `POST /conversations/{id}/typing` => `{ok:true}`.
- `POST /conversations/{id}/files` multipart `file` => `Attachment`. 20 Mo max, fichiers HTML/SVG/exécutables refusés.
- `GET /files/{file-id}` => fichier, Bearer + appartenance à la conversation requis (ou visibilité publication).
- `GET /feed` => `Post[]`; `POST /feed` corps `{text,visibility,attachments?:Attachment[]}` => `Post` (fichiers de publications : `POST /feed/files`).
- `POST /feed/{id}/reaction` corps `{emoji}` => `Post`.
- `POST /feed/{id}/comments` corps `{text}` => `Post`.
- `DELETE /feed/{id}` => `{ok:true}` (auteur).
- `GET /settings` => `{show_presence:boolean,allow_contacts:boolean}` ; `PATCH /settings` mêmes champs.

## Temps réel

1. `POST /socket-ticket` => `{ticket}` (éphémère, usage unique).
2. WebSocket même backend `/api/messenger/ws?ticket=...` (ne jamais placer le JWT en query string).
3. Événements JSON `{type:"message"|"updated"|"read"|"typing"|"presence"|"feed",conversation_id?,...}`. Sur événement, rafraîchir les données nécessaires. Une boucle reconnexion avec backoff + rafraîchissement à la reconnexion et au focus garantit le rattrapage.
4. Client peut envoyer `{"type":"ping"}`, réponse pong. Aucun polling agressif.

## Limites actuelles

Les appels WebRTC/TURN, sessions/appareils, localisation et bots ne sont pas livrés. La programmation est implémentée ci-dessous. Les push disposent d’une file d’envoi mais leur réception sur un téléphone hors ligne n’a pas été validée sur le VPS. Ne pas créer de boutons factices.

## Extension : programmation et canaux publics

- Conversation possède désormais `is_public:boolean` ; création et PATCH acceptent ce champ pour un canal uniquement, administrateurs seulement.
- `GET /channels?q=...` => `{id,title,member_count,joined}[]`. Annuaire limité aux canaux explicitement publics ; pas de liste de membres exposée aux non-abonnés.
- `POST /channels/{id}/join` => `Conversation` ; abonnement. Désabonnement par `/conversations/{id}/leave` existant.
- `GET /conversations/{id}/scheduled` => `{id,scheduled_at,status:"pending"|"processing"|"failed",error?,payload:{text,...}}[]`, uniquement les messages de l’utilisateur.
- `POST /conversations/{id}/scheduled` => même objet ; corps `MessageIn` avec `scheduled_at` ISO incluant fuseau horaire. Le worker revalide les autorisations lors de l’envoi, idempotence même après redémarrage.
- `DELETE /conversations/{id}/scheduled/{sid}` => `{ok:true}`, annuler un message non encore en cours d’envoi.
- Envoi silencieux : `silent:true` sur l’envoi habituel empêche les push, mais conserve le message et le compteur.
- `GET /capabilities` => `{scheduled_messages:true,public_channels:true,push_configured:boolean,calls:false,calls_reason:string,end_to_end_encryption:false}`. Le service de notifications existant est réutilisé via une file d’envoi persistante. Sans configuration Firebase effective, ne pas prétendre que les push fonctionnent.
