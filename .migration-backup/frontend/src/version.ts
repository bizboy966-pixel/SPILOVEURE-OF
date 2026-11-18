// SPILOVEURE — client-side version string, compared against the backend's
// `minimum_supported_version` on every app open. Bump this value in the
// SAME commit as any backend `publish_version` call so a reload picks up
// the new client. The server's `current_version` auto-detects "update
// available" when a user's CLIENT_VERSION is below it.
//
// Workflow :
//   1. Dev finishes a feature on branch
//   2. Bumps CLIENT_VERSION here (e.g. "1.0.0" → "1.2.0")
//   3. Deploys backend+frontend
//   4. Admin goes to Admin Panel → Gestion des versions → types "1.2.0"
//      → clicks "Publier la nouvelle version"
//   5. All older clients see the blocking "Mise à jour requise" modal
//      and reload (which pulls the new frontend bundle from the CDN).
export const CLIENT_VERSION = "1.1.0";
