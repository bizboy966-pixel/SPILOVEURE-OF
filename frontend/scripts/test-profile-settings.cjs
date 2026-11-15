const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = name => fs.readFileSync(path.join(__dirname, "../src/messenger", name), "utf8");

test("profile menu contains all WhatsApp-inspired sections with real SPILOVEURE styling", () => {
  const home = read("ProfileSettingsHome.tsx");
  for (const section of [
    "Appareils connectés", "Compte", "Confidentialité", "Listes", "Discussions",
    "Apparence", "Diffusions", "Accessibilité", "Langue de l’application",
    "Notifications", "Stockage et données",
  ]) assert.ok(home.includes(`name: "${section}"`), `missing profile section: ${section}`);
  assert.match(home, /profile-settings-row-\$\{section\.slug\}/);
  assert.match(home, /onOpen\(section\.name\)/);
});

test("sessions, personal data, privacy and existing notification controls remain functional", () => {
  const panel = read("ProfileSettingsPanel.tsx");
  assert.match(panel, /\/identity\/chat\/sessions/);
  assert.match(panel, /api\.delete\(`\/identity\/chat\/sessions/);
  assert.match(panel, /api\.patch<Settings>\("\/messenger\/settings"/);
  assert.match(panel, /<NotificationSettingsPanel userId=\{user\.id\}/);
  assert.match(panel, /action\("Réinitialiser le mot de passe"/);
  assert.match(panel, /profile-settings-action-\$\{title\.normalize\("NFD"\)/);
  assert.match(panel, /SPV@\{user\.username\}/);
});

test("lists, private broadcasts, appearance and accessibility have real persisted controls", () => {
  const panel = read("ProfileSettingsPanel.tsx");
  const lists = read("ChatListsManager.tsx");
  assert.match(panel, /<ChatListsManager mode="lists"/);
  assert.match(panel, /<ChatListsManager mode="broadcasts"/);
  assert.match(panel, /\/messenger\/storage/);
  assert.match(panel, /default_disappearing_seconds/);
  assert.match(lists, /\/messenger\/lists/);
  assert.match(lists, /window\.confirm\(prompt\)/);
  assert.match(lists, /Chaque destinataire recevra un message privé distinct/);
});

test("native-only sound and phone-number changes are described honestly", () => {
  const panel = read("ProfileSettingsPanel.tsx");
  assert.match(panel, /n’est pas encore disponible/);
  assert.match(panel, /sonneries système et les appels nécessitent l’application native/);
  assert.match(panel, /vérification nécessaire pour remplacer le numéro/);
  assert.doesNotMatch(panel, /Cette page ne supprime aucun message ni fichier/);
  assert.doesNotMatch(panel, /delete\([^)]*message/);
});

test("language choice persists locally and the user can navigate back", () => {
  const panel = read("ProfileSettingsPanel.tsx");
  assert.match(panel, /setLang\(value\)/);
  assert.match(panel, /testID=\{`profile-language-\$\{value\}`\}/);
  assert.match(panel, /Retour aux paramètres du profil/);
});
