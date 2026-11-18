# 🔧 SPILOVEURE — Audit & Correction des Réserves d'Upgrade (Production)

## Quand utiliser ?

Après avoir poussé sur la production le **fix du débit de réserve** (commit `manual_upgrade_debit` du 2026-06-14), il faut faire un nettoyage rétroactif des données historiques :

- Utilisateurs sur-crédités : leur `balance_upgrade` est plus élevé qu'il ne devrait, car des upgrades passés (manuels) n'ont pas débité la réserve.
- Utilisateurs bloqués : ils ont accumulé assez de réserve et leur matrice est remplie, mais l'auto-upgrade n'a jamais été déclenché.

## Étape 1 — Redéployer la production

Depuis Emergent → Bouton **Deploy** pour pousser le code preview vers `spiloveure.com`.

## Étape 2 — Récupérer le token admin de production

```bash
# Login admin
curl -X POST https://spiloveure.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"kossikotokou4@gmail.com","password":"@Emma91972006"}' \
  | jq -r '.access_token'
```

→ copier le token retourné. On l'appelle `$TOKEN` ci-dessous.

## Étape 3 — Lancer l'audit READ-ONLY

```bash
TOKEN="<collé ici>"

curl -s https://spiloveure.com/api/admin/upgrade-audit \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

Le JSON retourné contient :

- `summary.over_credited_count` : nombre d'utilisateurs avec écart
- `summary.over_credited_total_fcfa` : montant total à débiter
- `summary.stuck_upgrades_count` : utilisateurs bloqués à auto-upgrader
- `over_credited[]` : détail par utilisateur (id, username, écart)
- `stuck_upgrades[]` : détail des cas bloqués

**📤 Envoyer ce JSON à l'agent IA pour validation.**

## Étape 4 — Simulation (dry-run)

Avant tout débit, simuler la correction :

```bash
curl -X POST "https://spiloveure.com/api/admin/upgrade-audit/apply?dry_run=true" \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

Vérifier dans la sortie que :
- `retroactive_debits[]` montre chaque débit prévu
- `triggered_upgrades[]` montre les upgrades qui seront déclenchés
- `errors[]` est vide

## Étape 5 — Application réelle (après validation)

⚠️ **Étape destructive — backup MongoDB recommandé avant**

```bash
curl -X POST "https://spiloveure.com/api/admin/upgrade-audit/apply?dry_run=false" \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

Cette commande :
1. Débite la réserve des utilisateurs sur-crédités (montant exact = `discrepancy`)
2. Déclenche `try_auto_upgrade` (cascade jusqu'à 12 niveaux) pour les utilisateurs bloqués
3. Persiste chaque action dans la collection `upgrade_audit_log` pour audit ultérieur

## Étape 6 — Vérifier le log

```bash
curl -s https://spiloveure.com/api/admin/upgrade-audit/log \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

## Étape 7 — Re-vérifier l'audit

```bash
curl -s https://spiloveure.com/api/admin/upgrade-audit \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.summary'
```

Doit retourner :
```json
{
  "users_audited": <N>,
  "healthy": <N>,
  "over_credited_count": 0,
  "over_credited_total_fcfa": 0,
  "under_credited_count": <petit nombre toléré>,
  "stuck_upgrades_count": 0
}
```

## Notes de sécurité

- 🔒 Endpoints protégés par `require_admin` (rôle admin obligatoire)
- 🛡 `balance_profit` et `commission_*` ne sont JAMAIS modifiés par cet outil
- 📝 Chaque action est journalisée dans `upgrade_audit_log` (utilisateur, montant avant/après, raison, timestamp)
- ⚛️ Le débit est atomique (`$inc` MongoDB avec condition `$gte`) — pas de race condition

## Formule de détection

Pour chaque utilisateur :
```
expected_balance = sum(commissions.upgrade_share)  -  sum(prix des niveaux 2..max_level)
discrepancy = balance_upgrade_actuel - expected_balance
```

Si `discrepancy > 1 FCFA` → sur-crédité → débit rétroactif de `discrepancy`
