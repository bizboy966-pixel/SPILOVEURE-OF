const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");

(async () => {
  assert.ok(process.env.REPLIT_DEV_DOMAIN, "Development domain required");
  const base = `https://${process.env.REPLIT_DEV_DOMAIN}`;
  const id = "qa-media-" + randomBytes(16).toString("hex");
  const peerId = "qa-profile-peer-" + randomBytes(8).toString("hex");
  const conversationId = randomUUID();
  const password = randomBytes(24).toString("base64url");
  const account = mode => execFileSync("python", ["scripts/chat_media_test_user.py"], {
    input: JSON.stringify({ mode, id, password }), stdio: ["pipe", "pipe", "pipe"],
  });
  const fixture = mode => execFileSync("python", ["scripts/profile_settings_test_data.py"], {
    input: JSON.stringify({ mode, owner_id: id, peer_id: peerId, conversation_id: conversationId }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let browser;
  account("seed");
  try {
    fixture("seed");
    browser = await chromium.launch({
      executablePath: execFileSync("bash", ["-c", "command -v chromium"], { encoding: "utf8" }).trim(),
      args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"], headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, serviceWorkers: "block", permissions: ["microphone"],
    });
    const login = await context.request.post(base + "/api/auth/login", { data: { email: id + "@example.com", password } });
    assert.equal(login.status(), 200);
    const opened = await context.request.post(base + "/api/identity/chat/open", {
      headers: { Authorization: "Bearer " + (await login.json()).access_token, Origin: base },
    });
    assert.equal(opened.status(), 200);
    const testConversationResponse = await context.request.get(base + "/api/messenger/conversations");
    assert.equal(testConversationResponse.status(), 200);
    const testConversations = await testConversationResponse.json();
    assert.equal(testConversations.length, 1);
    const testConversation = testConversations[0];

    const messageUrl = base + `/api/messenger/conversations/${testConversation.id}/messages`;
    const oldMessageResponse = await context.request.post(messageUrl, {
      data: { text: "QA message before timer", client_id: "qa-before-" + id.slice(-8) },
    });
    assert.equal(oldMessageResponse.status(), 200);
    const oldMessage = await oldMessageResponse.json();
    assert.equal(oldMessage.expires_at, undefined);
    const timerSet = await context.request.patch(base + `/api/messenger/conversations/${testConversation.id}`, {
      data: { disappearing_seconds: 86400 },
    });
    assert.equal(timerSet.status(), 200);
    const expiringResponse = await context.request.post(messageUrl, {
      data: { text: "QA message with one-day timer", client_id: "qa-expiring-" + id.slice(-8) },
    });
    assert.equal(expiringResponse.status(), 200);
    const expiringMessage = await expiringResponse.json();
    assert.ok(expiringMessage.expires_at);
    const expiryHours = (new Date(expiringMessage.expires_at).getTime() - Date.now()) / 3600000;
    assert.ok(expiryHours > 23.9 && expiryHours <= 24.1, `unexpected expiry: ${expiryHours} hours`);
    await context.request.patch(base + `/api/messenger/conversations/${testConversation.id}`, {
      data: { disappearing_seconds: 0 },
    });
    await context.request.delete(messageUrl + "/" + encodeURIComponent(expiringMessage.id));
    await context.request.delete(messageUrl + "/" + encodeURIComponent(oldMessage.id));
    const page = await context.newPage();
    await page.goto(base + "/messenger");
    await page.getByTestId("messenger-search-toggle").waitFor({ timeout: 90000 });
    await page.getByTestId("animated-splash").waitFor({ state: "hidden", timeout: 30000 });
    await page.getByText("qa_contact_" + peerId.slice(-8), { exact: true }).click();
    await page.getByTestId("messenger-thread-title").waitFor();
    await page.screenshot({ path: "/tmp/spv-chat-surface.png" });
    await page.getByTestId("messenger-thread-search").waitFor();
    await page.getByTestId("messenger-header-more").click();
    await page.getByTestId("messenger-scheduled-open").waitFor();
    await page.getByTestId("messenger-scheduled-open").click();
    await page.getByLabel("Fermer les messages programmés").click();
    await page.getByTestId("messenger-record-voice").click();
    await page.getByText(/Enregistrement ·/).waitFor();
    await page.waitForTimeout(1600);
    const voiceUpload = page.waitForResponse(response =>
      response.request().method() === "POST" && response.url().includes(`/api/messenger/conversations/${testConversation.id}/files`));
    await page.getByTestId("messenger-send-voice").click();
    const voiceUploadResponse = await voiceUpload;
    assert.equal(voiceUploadResponse.status(), 200);
    const voiceAttachment = await voiceUploadResponse.json();
    assert.ok(voiceAttachment.duration_seconds > 1 && voiceAttachment.duration_seconds < 10, "Voice duration must reflect a few seconds, not minutes.");
    const totalVoiceSeconds = Math.round(voiceAttachment.duration_seconds);
    const voiceDurationLabel = `${String(Math.floor(totalVoiceSeconds / 60)).padStart(2, "0")}:${String(totalVoiceSeconds % 60).padStart(2, "0")}`;
    await page.getByTestId(`messenger-voice-${voiceAttachment.id}`).waitFor({ timeout: 15000 });
    await page.getByText("Chargement du vocal", { exact: true }).waitFor({ state: "detached", timeout: 30000 });
    await page.getByText(voiceDurationLabel, { exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/spv-voice-loaded.png" });
    await page.getByTestId("messenger-back").click();
    await page.getByTestId("messenger-tab-Profil").click();
    const sections = [
      "appareils-connectes", "compte", "confidentialite", "listes", "discussions",
      "apparence", "diffusions", "accessibilite", "langue-de-l-application",
      "notifications", "stockage-et-donnees",
    ];
    for (const slug of sections) await page.getByTestId(`profile-settings-row-${slug}`).waitFor();

    await page.getByTestId("profile-settings-row-appareils-connectes").click();
    await page.getByText("Sessions de ce compte", { exact: true }).waitFor();
    await page.getByText(/Mozilla\/5\.0/).waitFor();
    await page.getByLabel("Retour aux paramètres du profil").click();

    await page.getByTestId("profile-settings-row-compte").click();
    await page.getByText("Mon lien personnel SPILOVEURE", { exact: true }).waitFor();
    await page.getByTestId("profile-settings-action-reinitialiser-le-mot-de-passe").waitFor();
    await page.getByText("Copier", { exact: true }).waitFor();
    await page.getByLabel("Retour aux paramètres du profil").click();

    await page.getByTestId("profile-settings-row-confidentialite").click();
    const privacyToggle = page.getByTestId("profile-privacy-show_presence");
    const privacyEndpoint = base + "/api/messenger/settings";
    const before = await (await context.request.get(privacyEndpoint)).json();
    const savedSettings = page.waitForResponse(r => r.url().endsWith("/api/messenger/settings") && r.request().method() === "PATCH");
    await privacyToggle.click();
    assert.equal((await savedSettings).status(), 200);
    assert.notEqual((await (await context.request.get(privacyEndpoint)).json()).show_presence, before.show_presence);
    const restoreSettings = page.waitForResponse(r => r.url().endsWith("/api/messenger/settings") && r.request().method() === "PATCH");
    await privacyToggle.click();
    assert.equal((await restoreSettings).status(), 200);
    assert.equal((await (await context.request.get(privacyEndpoint)).json()).show_presence, before.show_presence);
    const defaultExpirySaved = page.waitForResponse(r => r.url().endsWith("/api/messenger/settings") && r.request().method() === "PATCH");
    await page.getByText("24 h", { exact: true }).click();
    assert.equal((await defaultExpirySaved).status(), 200);
    assert.equal((await (await context.request.get(privacyEndpoint)).json()).default_disappearing_seconds, 86400);
    const restoreExpiry = page.waitForResponse(r => r.url().endsWith("/api/messenger/settings") && r.request().method() === "PATCH");
    await page.getByText("Désactivé", { exact: true }).click();
    assert.equal((await restoreExpiry).status(), 200);
    await page.getByLabel("Retour aux paramètres du profil").click();

    await page.getByTestId("profile-settings-row-apparence").click();
    const darkSaved = page.waitForResponse(r => r.url().endsWith("/api/messenger/settings") && r.request().method() === "PATCH");
    await page.getByText("Sombre", { exact: true }).click();
    assert.equal((await darkSaved).status(), 200);
    assert.equal((await (await context.request.get(privacyEndpoint)).json()).appearance, "dark");
    const lightSaved = page.waitForResponse(r => r.url().endsWith("/api/messenger/settings") && r.request().method() === "PATCH");
    await page.getByText("Clair", { exact: true }).click();
    assert.equal((await lightSaved).status(), 200);
    await page.getByLabel("Retour aux paramètres du profil").click();

    await page.getByTestId("profile-settings-row-accessibilite").click();
    const contrast = page.getByTestId("profile-privacy-high_contrast");
    const beforeContrast = (await (await context.request.get(privacyEndpoint)).json()).high_contrast;
    const contrastSaved = page.waitForResponse(r => r.url().endsWith("/api/messenger/settings") && r.request().method() === "PATCH");
    await contrast.click();
    assert.equal((await contrastSaved).status(), 200);
    assert.notEqual((await (await context.request.get(privacyEndpoint)).json()).high_contrast, beforeContrast);
    const contrastRestored = page.waitForResponse(r => r.url().endsWith("/api/messenger/settings") && r.request().method() === "PATCH");
    await contrast.click();
    assert.equal((await contrastRestored).status(), 200);
    await page.getByText("Grande", { exact: true }).click();
    assert.equal((await (await context.request.get(privacyEndpoint)).json()).font_scale, 1.2);
    await page.getByText("Normale", { exact: true }).click();
    await page.getByLabel("Retour aux paramètres du profil").click();

    await page.getByTestId("profile-settings-row-listes").click();
    await page.getByTestId("chat-lists-manager-lists").waitFor();
    await page.getByTestId("chat-list-create").waitFor();
    const listName = "QA " + id.slice(-8);
    const createdList = await context.request.post(base + "/api/messenger/lists", {
      data: { name: listName, conversation_ids: [testConversation.id] },
    });
    assert.equal(createdList.status(), 200);
    const savedList = await createdList.json();
    assert.equal(savedList.name, listName);
    const duplicateList = await context.request.post(base + "/api/messenger/lists", { data: { name: listName, conversation_ids: [] } });
    assert.equal(duplicateList.status(), 409);
    const emptyListResponse = await context.request.post(base + "/api/messenger/lists", {
      data: { name: "QA empty " + id.slice(-8), conversation_ids: [] },
    });
    assert.equal(emptyListResponse.status(), 200);
    const emptyList = await emptyListResponse.json();
    const emptyBroadcast = await context.request.post(base + `/api/messenger/lists/${emptyList.id}/broadcast`, { data: { text: "QA no-send" } });
    assert.equal(emptyBroadcast.status(), 400);
    assert.equal((await context.request.delete(base + `/api/messenger/lists/${emptyList.id}`)).status(), 200);
    await page.getByTestId("profile-settings-action-gerer-mes-contacts").click();
    await page.getByTestId("messenger-tab-Contacts").waitFor();
    await page.getByTestId("messenger-tab-Profil").click();
    await page.getByTestId("profile-settings-row-langue-de-l-application").click();
    await page.getByTestId("profile-language-en").click();
    await page.waitForFunction(() => document.documentElement.lang === "en");
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    await page.getByLabel("Retour aux paramètres du profil").click();
    await page.getByText("Settings", { exact: true }).waitFor();
    await page.getByTestId("profile-settings-row-langue-de-l-application").click();
    await page.getByTestId("profile-language-fr").click();
    await page.getByLabel("Retour aux paramètres du profil").click();

    await page.getByTestId("profile-settings-row-diffusions").click();
    await page.getByTestId("chat-lists-manager-broadcasts").waitFor();
    await page.getByTestId(`broadcast-open-${savedList.id}`).click();
    await page.getByTestId("broadcast-message").fill("QA broadcast " + id.slice(-8));
    page.once("dialog", dialog => dialog.accept());
    const broadcastSent = page.waitForResponse(r => r.url().endsWith(`/api/messenger/lists/${savedList.id}/broadcast`) && r.request().method() === "POST");
    await page.getByTestId("broadcast-send").click();
    const broadcastResponse = await broadcastSent;
    assert.equal(broadcastResponse.status(), 200);
    assert.equal((await broadcastResponse.json()).sent, 1);
    const delivered = await context.request.get(base + `/api/messenger/conversations/${testConversation.id}/messages`);
    assert.equal(delivered.status(), 200);
    const deliveredData = await delivered.json();
    const deliveredMessages = deliveredData.items || deliveredData.messages || [];
    const qaBroadcast = deliveredMessages.find(message => message.text === "QA broadcast " + id.slice(-8));
    assert.ok(qaBroadcast, "Broadcast should create a one-to-one message for the temporary contact");
    assert.equal((await context.request.delete(base + `/api/messenger/conversations/${testConversation.id}/messages/${encodeURIComponent(qaBroadcast.id)}`)).status(), 200);
    assert.equal((await context.request.delete(base + `/api/messenger/lists/${savedList.id}`)).status(), 200);
    await page.getByLabel("Retour aux paramètres du profil").click();
    await page.getByTestId("profile-settings-row-notifications").click();
    await page.getByTestId("messenger-global-notification-settings-toggle").click();
    await page.getByTestId("messenger-notification-sound-pulse").waitFor();
    const soundSaved = page.waitForResponse(r => r.url().endsWith("/api/messenger/notification-settings") && r.request().method() === "PATCH");
    await page.getByTestId("messenger-notification-sound-pulse").click();
    const soundResponse = await soundSaved;
    assert.equal(soundResponse.status(), 200);
    assert.equal((await soundResponse.json()).sound, "pulse");
    const soundPrefs = await context.request.get(base + "/api/messenger/notification-settings");
    assert.equal((await soundPrefs.json()).sound, "pulse", "the selected sound must be applied to future notifications");
    await page.getByLabel("Retour aux paramètres du profil").click();
    await page.getByTestId("profile-settings-row-stockage-et-donnees").click();
    await page.getByText("Fichiers envoyés par votre compte", { exact: true }).waitFor();
    const autoMedia = page.getByTestId("profile-privacy-auto_load_media");
    await autoMedia.waitFor();
    const beforeAutoMedia = (await (await context.request.get(privacyEndpoint)).json()).auto_load_media;
    const autoMediaSaved = page.waitForResponse(r => r.url().endsWith("/api/messenger/settings") && r.request().method() === "PATCH");
    await autoMedia.click();
    assert.equal((await autoMediaSaved).status(), 200);
    assert.notEqual((await (await context.request.get(privacyEndpoint)).json()).auto_load_media, beforeAutoMedia);
    const autoMediaRestored = page.waitForResponse(r => r.url().endsWith("/api/messenger/settings") && r.request().method() === "PATCH");
    await autoMedia.click();
    assert.equal((await autoMediaRestored).status(), 200);
    await page.screenshot({ path: "/tmp/spv-profile-settings.png" });
    await page.getByLabel("Retour aux paramètres du profil").click();
    await page.screenshot({ path: "/tmp/spv-profile-settings-home.png" });
    console.log("PASS: all 11 profile categories, one-to-one broadcast, saved conversation lists, expiring new messages, appearance/accessibility preferences, privacy, language, sessions, notifications and storage. Only disposable local QA accounts were used.");
    await context.close();
  } finally {
    if (browser) await browser.close();
    account("cleanup");
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
