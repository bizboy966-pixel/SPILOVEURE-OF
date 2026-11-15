// Styling fixture: genuine private uploads and saved messages; received sender
// labels are changed only in the browser response, never in the database.
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  assert.ok(process.env.REPLIT_DEV_DOMAIN, "Development domain required");
  const base = `https://${process.env.REPLIT_DEV_DOMAIN}`;
  const id = "qa-media-" + randomBytes(16).toString("hex");
  const password = randomBytes(24).toString("base64url");
  const account = mode => execFileSync("python", ["scripts/chat_media_test_user.py"], {
    input: JSON.stringify({ mode, id, password }), stdio: ["pipe", "pipe", "pipe"],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spv-bubbles-"));
  let browser;
  try {
    account("seed");
    browser = await chromium.launch({
      executablePath: execFileSync("bash", ["-c", "command -v chromium"], { encoding: "utf8" }).trim(),
      args: ["--no-sandbox"], headless: true,
    });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const login = await context.request.post(base + "/api/auth/login", { data: { email: id + "@example.com", password } });
    assert.equal(login.status(), 200);
    const opened = await context.request.post(base + "/api/identity/chat/open", {
      headers: { Authorization: "Bearer " + (await login.json()).access_token, Origin: base },
    });
    assert.equal(opened.status(), 200);
    const saved = await context.request.post(base + "/api/messenger/conversations", { headers: { Origin: base }, data: { kind: "saved" } });
    assert.equal(saved.status(), 200);
    const conversation = await saved.json();
    const url = base + "/api/messenger/conversations/" + conversation.id;
    const send = async (text, attachments = []) => {
      const response = await context.request.post(url + "/messages", {
        headers: { Origin: base }, data: { text, attachments, client_id: randomBytes(16).toString("hex") },
      });
      assert.equal(response.status(), 200);
      return response.json();
    };
    const sentText = "Bonjour !\n\nVoici un message envoyé sur plusieurs lignes.";
    const receivedText = "Bien reçu !\n\nMême forme, avec un fond blanc.";
    const sent = await send(sentText);
    const incomingText = await send(receivedText);
    const received = new Set([incomingText.id]);
    const audioPath = path.join(dir, "voice-note.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-ar", "16000", "-ac", "1", audioPath]);
    const voices = [];
    for (let n = 0; n < 2; n++) {
      const response = await context.request.post(url + "/files", {
        headers: { Origin: base },
        multipart: { file: { name: "voice-note.wav", mimeType: "audio/wav", buffer: fs.readFileSync(audioPath) } },
      });
      assert.equal(response.status(), 200);
      const file = await response.json();
      voices.push(file);
      const message = await send("", [file]);
      if (n) received.add(message.id);
    }
    const page = await context.newPage();
    await page.route("**/api/messenger/conversations/" + conversation.id + "/messages?*", async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.items = body.items.map(message => received.has(message.id)
        ? { ...message, sender_id: "qa-visual-peer", sender_name: "Contact de test" } : message);
      await route.fulfill({ response, json: body });
    });
    await page.goto(base + "/messenger");
    await page.getByTestId("messenger-search-toggle").waitFor({ timeout: 90000 });
    await page.getByTestId("animated-splash").waitFor({ state: "hidden", timeout: 30000 });
    await page.getByText("Messages enregistrés", { exact: true }).click();
    await page.getByText(sentText, { exact: true }).waitFor();
    const outgoing = await page.getByTestId(`messenger-message-bubble-${sent.id}`).evaluate(el => getComputedStyle(el).backgroundColor);
    const incoming = await page.getByTestId(`messenger-message-bubble-${incomingText.id}`).evaluate(el => getComputedStyle(el).backgroundColor);
    const rgb = outgoing.match(/\d+/g).map(Number);
    assert.ok(rgb[1] > rgb[0] && rgb[0] > rgb[2], "Sent bubbles must be pale green");
    assert.equal(incoming, "rgb(255, 255, 255)");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal overflow");
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const toggle = page.getByTestId(`messenger-voice-${voices[0].id}-toggle`);
    await toggle.click();
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label]')].some(el => /pause/i.test(el.getAttribute("aria-label") || "")), { timeout: 10000 });
    const seek = page.getByTestId(`messenger-voice-${voices[0].id}-seek`);
    const seekBox = await seek.boundingBox();
    await seek.click({ position: { x: seekBox.width * .65, y: seekBox.height / 2 } });
    await toggle.click();
    await page.getByTestId(`messenger-voice-${voices[0].id}`).getByText(/^0:0[23]$/).waitFor();
    await page.screenshot({ path: "/tmp/spv-chat-bubbles.png" });
    console.log("PASS: pale-green sent and white received text/voice fixtures, multiline messages, 320/390px containment and genuine audio playback. No real contact or conversation was modified.");
  } finally {
    if (browser) await browser.close();
    account("cleanup");
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
