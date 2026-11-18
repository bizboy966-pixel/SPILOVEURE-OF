// Real browser check, limited to a disposable local-development account and its saved messages.
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { PNG } = require("pngjs");

(async () => {
  const base = `https://${process.env.REPLIT_DEV_DOMAIN}`;
  assert.ok(process.env.REPLIT_DEV_DOMAIN, "Development domain required");
  const id = "qa-media-" + randomBytes(16).toString("hex");
  const password = randomBytes(24).toString("base64url");
  const account = mode => execFileSync("python", ["scripts/chat_media_test_user.py"], {
    input: JSON.stringify({ mode, id, password }), stdio: ["pipe", "pipe", "pipe"],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spv-media-check-"));
  let browser;
  try {
    account("seed");
    const executablePath = execFileSync("bash", ["-c", "command -v chromium"], { encoding: "utf8" }).trim();
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const login = await context.request.post(base + "/api/auth/login", { data: { email: id + "@example.com", password } });
    assert.equal(login.status(), 200);
    const token = (await login.json()).access_token;
    const opened = await context.request.post(base + "/api/identity/chat/open", {
      headers: { Authorization: "Bearer " + token, Origin: base },
    });
    assert.equal(opened.status(), 200);
    const saved = await context.request.post(base + "/api/messenger/conversations", {
      headers: { Origin: base }, data: { kind: "saved" },
    });
    assert.equal(saved.status(), 200);
    const page = await context.newPage();
    if (process.argv.includes("--contacts")) {
      const contacts = [0, 1, 2, 3, 4].map(n => ({ id: `contact-qa-${n}`, username: `Contact_test_${n}`, online: false }));
      await page.route("**/api/messenger/contacts", route => route.fulfill({ json: { contacts, blocked: [], requests: [], sent: [] } }));
      let blocked = false;
      await page.route("**/api/messenger/blocks/contact-qa-0", async route => { blocked = true; await route.fulfill({ json: { ok: true } }); });
      await page.goto(base + "/messenger");
      await page.getByTestId("messenger-search-toggle").waitFor({ timeout: 90000 });
      await page.getByTestId("animated-splash").waitFor({ state: "hidden", timeout: 30000 });
      await page.getByText("Contacts", { exact: true }).click();
      await page.getByTestId("messenger-contact-menu-toggle-contact-qa-0").click();
      const menu = page.getByTestId("messenger-contact-menu-contact-qa-0");
      await menu.getByText("Retirer des contacts", { exact: true }).waitFor();
      const box = await menu.boundingBox();
      const onTop = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return !!el?.closest('[data-testid="messenger-contact-menu-contact-qa-0"]');
      }, { x: box.x + box.width / 2, y: box.y + box.height - 8 });
      assert.ok(onTop, "The contact menu must receive clicks instead of a later Save button");
      await page.screenshot({ path: "/tmp/spv-contacts-menu.png" });
      await menu.getByText("Bloquer", { exact: true }).click();
      await menu.waitFor({ state: "hidden" });
      assert.ok(blocked, "The selected menu action must run");
      console.log("PASS: contact menu is above later rows, both options are visible and Block receives the click. Contacts API was mocked; no real contact was modified.");
      return;
    }
    await page.goto(base + "/messenger");
    await page.getByTestId("messenger-search-toggle").waitFor({ timeout: 90000 });
    await page.getByTestId("animated-splash").waitFor({ state: "hidden", timeout: 30000 });
    // An initial splash may cover already-mounted controls; interact before capturing.
    await page.getByText("Messages enregistrés", { exact: true }).first().click();
    await page.getByTestId("messenger-back").click();
    await page.screenshot({ path: "/tmp/spv-chat-header.png" });
    await page.getByText("Messages enregistrés", { exact: true }).first().click();
    const attach = async payload => {
      await page.getByTestId("messenger-composer-actions").click();
      const chooser = page.waitForEvent("filechooser");
      await page.getByText("Photo, vidéo ou fichier", { exact: true }).click();
      await (await chooser).setFiles(payload);
      await page.getByTestId("messenger-media-composer").waitFor();
    };
    const png = new PNG({ width: 400, height: 300 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 30; png.data[i + 1] = 110; png.data[i + 2] = 180; png.data[i + 3] = 255;
    }
    await attach({ name: "qa-photo.png", mimeType: "image/png", buffer: PNG.sync.write(png) });
    await page.getByTestId("messenger-media-tool-crop").click();
    await page.getByTestId("media-crop-square").click();
    const frameBefore = await page.getByTestId("messenger-media-crop-frame").boundingBox();
    const handle = await page.getByTestId("messenger-media-crop-handle-se").boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2 - 24, handle.y + handle.height / 2 - 24, { steps: 8 }); await page.mouse.up();
    const frameAfter = await page.getByTestId("messenger-media-crop-frame").boundingBox();
    assert.ok(frameAfter.width < frameBefore.width - 10, "Dragging the crop handle must really resize the crop");
    await page.getByTestId("messenger-media-crop-done").click();
    await page.getByTestId("messenger-media-tool-text").click();
    await page.getByTestId("messenger-media-overlay-text").fill("Bonjour");
    await page.getByTestId("messenger-media-text-done").click();
    const overlay = await page.getByTestId("messenger-media-text-overlay").boundingBox();
    await page.mouse.move(overlay.x + overlay.width / 2, overlay.y + overlay.height / 2);
    await page.mouse.down(); await page.mouse.move(overlay.x + overlay.width / 2 + 15, overlay.y + overlay.height / 2 - 35, { steps: 8 }); await page.mouse.up();
    const movedOverlay = await page.getByTestId("messenger-media-text-overlay").boundingBox();
    assert.ok(movedOverlay.y < overlay.y - 20, "Dragging text must move its rendered position");
    await page.getByTestId("messenger-media-tool-draw").click();
    const layer = await page.getByTestId("messenger-media-drawing-layer").boundingBox();
    await page.mouse.move(layer.x + 20, layer.y + 20);
    await page.mouse.down(); await page.mouse.move(layer.x + 80, layer.y + 60, { steps: 8 }); await page.mouse.up();
    await page.screenshot({ path: "/tmp/spv-chat-photo-editor.png" });
    const upload = page.waitForResponse(r => /\/files$/.test(r.url()) && r.request().method() === "POST");
    await page.getByTestId("messenger-media-confirm").click();
    const uploaded = await upload; assert.equal(uploaded.status(), 200);
    const media = await uploaded.json();
    const bytes = await context.request.get(base + media.url);
    const edited = PNG.sync.read(await bytes.body());
    assert.equal(edited.width, edited.height, "Square crop must be reflected in the exported image");
    assert.ok(edited.data.some((value, i) => i % 4 === 0 && value > 200), "Text must be baked into the sent photo");
    await page.getByTestId("messenger-media-composer").waitFor({ state: "hidden" });
    const videoPath = path.join(dir, "qa.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath]);
    await attach({ name: "qa-video.M4V", mimeType: "application/octet-stream", buffer: fs.readFileSync(videoPath) });
    const videoUpload = page.waitForResponse(r => /\/files$/.test(r.url()) && r.request().method() === "POST");
    await page.getByTestId("messenger-media-confirm").click();
    const vr = await videoUpload; assert.equal(vr.status(), 200);
    assert.equal((await vr.json()).mime, "video/mp4");
    await page.getByTestId("messenger-media-composer").waitFor({ state: "hidden" });
    await page.goto(base + "/account-access?source=chat");
    await page.getByTestId("account-access-forgot-password").click();
    await page.getByTestId("reset-email").waitFor();
    console.log("PASS: authenticated Chat, photo crop/export with movable text, M4V media preview/upload and Chat password-recovery link.");
  } finally {
    if (browser) await browser.close();
    account("cleanup");
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
