// Browser regression checks against local test accounts, never the public VPS.
const { chromium, expect } = require("@playwright/test");
const { execFileSync } = require("child_process");
const { randomBytes } = require("crypto");
const fs = require("fs");
const assert = require("assert/strict");
const password = randomBytes(24).toString("hex");
const base = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const executablePath = execFileSync("sh", ["-c", "command -v chromium || nix-shell -p chromium --run 'command -v chromium'"], { encoding: "utf8" }).trim();

(async () => {
  execFileSync("python", ["scripts/seed-messenger-test-users.py"], { input: JSON.stringify({ password }) });
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const errors = [];
  try {
    async function login(name, width) {
      const context = await browser.newContext({ viewport: { width, height: 874 }, permissions: ["microphone"] });
      const page = await context.newPage();
      page.on("pageerror", e => errors.push(e.message));
      await page.addInitScript(() => sessionStorage.setItem("spilv_splash_seen_v1", "1"));
      await page.goto(base + "/login", { waitUntil: "networkidle", timeout: 90000 });
      await page.getByTestId("login-email").fill(`messenger_test_${name}@example.com`);
      await page.getByTestId("login-password").fill(password);
      await page.getByTestId("login-submit").click();
      await page.waitForURL("**/dashboard", { timeout: 30000 });
      await page.getByTestId("bottom-nav").waitFor({ state: "visible" });
      await page.waitForTimeout(3000);
      await page.getByTestId("community-popup-close").click({ timeout: 4000 }).catch(() => {});
      await page.getByTestId("support-group-popup-later").click({ timeout: 1000 }).catch(() => {});
      // Enter through the actual main navigation, including the shared transition.
      await page.getByTestId("bottom-nav-chat").click();
      await expect(page.getByLabel("Nouvelle conversation")).toBeVisible();
      return page;
    }
    fs.mkdirSync("generated-artifacts", { recursive: true });
    const alice = await login("alice", 402);
    const bob = await login("bob", 1200);
    await alice.getByLabel("Nouvelle conversation").click();
    await alice.getByPlaceholder("Rechercher des membres").fill("messenger_test_bob");
    await alice.getByPlaceholder("Rechercher des membres").locator("..").getByText("messenger_test_bob", { exact: true }).click();
    await expect(alice.getByPlaceholder("Message", { exact: true })).toBeVisible();
    const text = "Vérification temps réel " + Date.now();
    await alice.getByPlaceholder("Message", { exact: true }).fill(text);
    await alice.getByTestId("messenger-send").click();
    await expect(alice.getByText(text, { exact: true })).toBeVisible();
    await expect(bob.getByLabel("Ouvrir la conversation messenger_test_alice")).toBeVisible({ timeout: 12000 });
    await bob.getByLabel("Ouvrir la conversation messenger_test_alice").click();
    await expect(bob.getByText(text, { exact: true }).last()).toBeVisible({ timeout: 12000 });
    const reply = "Réponse navigateur " + Date.now();
    await bob.getByPlaceholder("Message", { exact: true }).fill(reply);
    await bob.getByTestId("messenger-send").click();
    await expect(alice.getByText(reply, { exact: true })).toBeVisible({ timeout: 12000 });
    console.log("PASS: login existant, entrée Chat, création privée, aller-retour temps réel mobile/desktop.");
    // Refresh must restore the server-backed conversation, not local mock state.
    await bob.reload({ waitUntil: "networkidle" });
    await bob.getByLabel("Ouvrir la conversation messenger_test_alice").click();
    await expect(bob.getByText(text, { exact: true }).last()).toBeVisible();
    console.log("PASS: historique conservé après rechargement.");
    const chooser = alice.waitForEvent("filechooser");
    await alice.getByLabel("Joindre un fichier").click();
    await (await chooser).setFiles({ name: "verification-chat.txt", mimeType: "text/plain", buffer: Buffer.from("Pièce jointe de test navigateur.") });
    await expect(bob.getByText("verification-chat.txt", { exact: true }).last()).toBeVisible({ timeout: 12000 });
    console.log("PASS: envoi réel d’une pièce jointe entre deux navigateurs.");
    await alice.getByTestId("messenger-scheduled-open").click();
    const scheduledText = "Programmation navigateur " + Date.now();
    await alice.getByLabel("Texte du message programmé").fill(scheduledText);
    await alice.getByTestId("messenger-schedule-submit").click();
    await expect(alice.getByText(scheduledText, { exact: true })).toBeVisible();
    await alice.getByLabel("Annuler ce message programmé").last().click();
    await expect(alice.getByText(scheduledText, { exact: true })).toHaveCount(0);
    await alice.getByLabel("Fermer les messages programmés").click();
    console.log("PASS: programmation et annulation depuis l’interface.");
    const voice = alice.getByLabel("Enregistrer ou envoyer un message vocal");
    await voice.click();
    await expect(alice.getByText(/Enregistrement ·/)).toBeVisible();
    await alice.waitForTimeout(1200);
    await voice.click();
    await expect(alice.getByText(/Vocal prêt ·/)).toBeVisible();
    await voice.click();
    await expect(bob.getByText(/message-vocal-\d+\.(webm|ogg|m4a)/).last()).toBeVisible({ timeout: 12000 });
    console.log("PASS: enregistrement vocal simulé par le navigateur et envoi entre deux comptes.");
    await alice.screenshot({ path: "generated-artifacts/chat-thread-mobile.jpg" });
    await bob.screenshot({ path: "generated-artifacts/chat-desktop.jpg" });
    await alice.getByTestId("messenger-back").click();
    await alice.screenshot({ path: "generated-artifacts/chat-mobile.jpg" });
    await alice.getByLabel("Retourner à SPILOVEURE").click();
    await alice.waitForURL("**/dashboard");
    await expect(alice.getByTestId("bottom-nav").filter({ visible: true }).last()).toBeVisible();
    assert.equal(errors.length, 0, "Unexpected browser errors: " + errors.join(" | "));
    console.log("PASS: retour accueil par logo, aucune erreur JavaScript.");
  } finally {
    for (const [i, context] of browser.contexts().entries()) {
      for (const page of context.pages()) await page.screenshot({ path: `generated-artifacts/final-browser-${i}.jpg` }).catch(() => {});
    }
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
