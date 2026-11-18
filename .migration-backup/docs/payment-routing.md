# Affectation exclusive des paiements Mobile Money

Plusieurs prestataires peuvent être actifs simultanément, avec des
destinations différentes. Chaque couple **pays + opérateur physique** est
attribué à **un seul prestataire**, encaissements et retraits confondus.
Un même pays peut donc utiliser deux prestataires pour deux opérateurs
différents. Les codes propres aux prestataires ne créent pas deux opérateurs :
T-Money, Mixx By Yas et les anciens alias correspondants désignent le même
opérateur au Togo.

Pour transférer une destination, désactiver d’abord l’opérateur chez
l’ancien prestataire, puis l’activer chez le nouveau. La désactivation
s’applique également aux alias historiques du même opérateur. Activer un
pays vérifie tous ses opérateurs. Activer un prestataire vérifie les
destinations déjà activées dans son catalogue.

Les écritures administrateur de configuration sont sérialisées en base.
Un conflit préexistant ne déclenche ni suppression d’historique ni choix
arbitraire par priorité : le nouveau paiement est bloqué jusqu’à correction.
Le serveur refait le contrôle avant soumission financière, y compris pour
les points d’entrée directs des prestataires.

Le parcours d’activation commun est **pays → opérateur → téléphone → payer**.
Le serveur sélectionne l’unique prestataire affecté, utilise son code
opérateur et lance son parcours. MoneyFusion retourne sa page hébergée.
Cette page ne permet pas un filtre opérateur documenté : tous les opérateurs
proposés pour ce pays doivent rester affectés à MoneyFusion pour autoriser
ce parcours. La règle ne peut pas imposer un filtre que le prestataire
n’accepte pas.

Les transactions lancées conservent leur prestataire d’origine pour les
notifications et la vérification. Une nouvelle tentative d’activation
retrouve l’intention encore en cours au lieu de lancer un second paiement
chez un prestataire nouvellement sélectionné. Le retour MoneyFusion porte
la référence pour reprendre cette vérification après redirection.

Les identifiants, droits marchands, devises et confirmations propres à chaque
prestataire restent obligatoires. Ces règles ne constituent pas une
validation de paiement réel et n’effectuent aucun déploiement sur le VPS.
