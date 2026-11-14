// Actual UI + actual identity handlers; isolated local Mongo and private test mailbox.
const { chromium, expect } = require("@playwright/test");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

(async () => {
  const stamp = String(Date.now());
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "spv-identity-e2e-"));
  const outbox = path.join(temporary, "mailbox.jsonl");
  const password = crypto.randomBytes(18).toString("base64url") + "Aa9!";
  const email = `e2e_${stamp}@example.com`;
  const env = { ...process.env, DB_NAME: `spiloveure_identity_e2e_${stamp}`,
    MONGO_URL: "mongodb://127.0.0.1:27017", IDENTITY_TEST_OUTBOX: outbox,
    IDENTITY_TEST_PASSWORD: password };
  const backend = spawn("python", ["scripts/identity-e2e-server.py"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let startupError = "";
  backend.stderr.on("data", chunk => { startupError += chunk.toString(); });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 90; i++) {
      if (backend.exitCode !== null) throw new Error("Isolated test server failed: " + startupError.slice(-1400));
      try { const response = await fetch("http://127.0.0.1:8002/api/"); if (response.ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error("Isolated test server did not start.");
    const executablePath = execFileSync("bash", ["-lc", "command -v chromium || nix-shell -p chromium --run 'command -v chromium'"], { encoding: "utf8" }).trim().split("\n").pop();
    browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport: { width: 402, height: 874 } });
    const base = `https://${process.env.REPLIT_DEV_DOMAIN}`;
    await context.route("**/api/**", async route => {
      const request = route.request(), url = new URL(request.url());
      const response = await context.request.fetch(`http://127.0.0.1:8002${url.pathname}${url.search}`, {
        method: request.method(), headers: { ...request.headers(), host: new URL(base).host },
        data: request.postDataBuffer() || undefined, maxRedirects: 0,
      });
      await route.fulfill({ response });
    });
    await context.routeWebSocket(/\/api\/messenger\/ws/, route => {
      const target = route.url().replace(/^wss?:\/\/[^/]+/, "ws://127.0.0.1:8002");
      const socket = new WebSocket(target), queue = [];
      route.onMessage(message => socket.readyState === 1 ? socket.send(message) : queue.push(message));
      socket.onopen = () => queue.splice(0).forEach(message => socket.send(message));
      socket.onmessage = event => route.send(event.data);
      route.onClose(() => socket.close());
      socket.onclose = () => { try { route.close(); } catch {} };
      socket.onerror = () => {};
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.dismiss());
    await page.goto(`${base}/?ref=E2E_SPONSOR`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("landing-register-btn").filter({ visible: true }).first().click();
    await page.getByTestId("onboarding-welcome-continue").click();
    await page.getByText("Togo", { exact: true }).click();
    await page.getByTestId("onboarding-country-continue").click();
    await page.getByTestId("onboarding-email").fill(email);
    await page.getByTestId("onboarding-email-continue").click();
    await expect(page.getByTestId("register-email")).toHaveValue(email);
    await expect(page.getByTestId("register-password")).toHaveCount(0);
    await page.getByTestId("register-username").fill("E2E_" + stamp);
    await page.getByTestId("register-phone").fill("91111111");
    await page.getByTestId("register-accept").click();
    await page.getByTestId("register-submit").click();
    await page.waitForURL("**/pay");
    console.log("PASS: landing, bienvenue, pays, e-mail et formulaire prérempli sans mot de passe.");
    await page.getByTestId("pay-chat-button").click();
    await page.waitForURL("**/verify-email*");
    await page.getByTestId("email-send-code").click();
    await expect(page.getByTestId("email-code-0")).toBeVisible();
    let code;
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(outbox)) {
        const messages = fs.readFileSync(outbox, "utf8").trim().split("\n").map(line => JSON.parse(line));
        code = messages.find(message => message.recipient === email)?.code;
        if (code) break;
      }
      await page.waitForTimeout(200);
    }
    if (!code) throw new Error("Test mailbox did not receive verification message.");
    const incorrect = code === "999999" ? "000000" : "999999";
    for (let i = 0; i < 6; i++) await page.getByTestId(`email-code-${i}`).fill(incorrect[i]);
    await page.getByTestId("email-code-submit").click();
    await expect(page.getByText(/Code incorrect, expiré ou déjà utilisé/).last()).toBeVisible();
    for (let i = 0; i < 6; i++) await page.getByTestId(`email-code-${i}`).fill(code[i]);
    await page.getByTestId("email-code-submit").click();
    await page.waitForURL("**/messenger");
    await expect(page.getByLabel("Retourner à SPILOVEURE")).toBeVisible();
    const chatCookie = (await context.cookies()).find(cookie => cookie.name === "spv_chat_session");
    if (!chatCookie?.httpOnly || !chatCookie?.secure) throw new Error("Chat cookie protections missing.");
    console.log("PASS: code erroné refusé, six champs, code réel du fournisseur de test et cookie Chat sécurisé.");
    await page.getByLabel("Retourner à SPILOVEURE").click();
    await page.waitForURL("**/pay");
    console.log("PASS: utilisateur non activé renvoyé au paiement, pas au tableau de bord.");
    execFileSync("python", ["scripts/identity-e2e-server.py", "--activate", email], { env, stdio: "pipe" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForURL("**/account-access*");
    await page.getByTestId("main-password").fill(password);
    await page.getByTestId("main-password-confirm").fill(password);
    await page.getByTestId("main-account-submit").click();
    await page.waitForURL("**/dashboard");
    console.log("PASS: après confirmation simulée en base de test, création unique du mot de passe puis tableau de bord.");
    await page.goto(`${base}/messenger`, { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Retourner à SPILOVEURE")).toBeVisible();
    // Simulate principal-session invalidation; real expired JWT semantics are
    // separately covered by backend tests. Keep the HttpOnly Chat cookie intact.
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Retourner à SPILOVEURE")).toBeVisible();
    await page.getByLabel("Retourner à SPILOVEURE").click();
    await page.waitForURL("**/account-access?source=chat");
    await expect(page.getByTestId("main-password-confirm")).toHaveCount(0);
    await page.getByTestId("main-password").fill("incorrect");
    await page.getByTestId("main-account-submit").click();
    await expect(page.getByText("Mot de passe incorrect.", { exact: true })).toBeVisible();
    await page.getByTestId("main-password").fill(password);
    await page.getByTestId("main-account-submit").click();
    await page.waitForURL("**/dashboard");
    console.log("PASS: Chat conservé sans session principale et retour par mot de passe seul.");
    await page.goto(`${base}/messenger`, { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Retourner à SPILOVEURE")).toBeVisible();
    await page.screenshot({ path: "generated-artifacts/identity-chat-mobile.jpg" });
    await page.getByText("Profil", { exact: true }).last().click();
    await page.getByTestId("chat-logout").click();
    await page.waitForURL("**/verify-email*");
    if (errors.length) throw new Error("Browser exceptions: " + errors.join(" | "));
    console.log("PASS: déconnexion Chat indépendante ; aucun vrai e-mail ni paiement effectué.");
  } finally {
    if (browser) {
      for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: "generated-artifacts/identity-final.jpg" }).catch(() => {});
      await browser.close();
    }
    backend.kill("SIGTERM");
    execFileSync("python", ["scripts/identity-e2e-server.py", "--cleanup"], { env, stdio: "pipe" });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
