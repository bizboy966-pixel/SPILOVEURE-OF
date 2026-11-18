const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const { randomBytes, randomInt } = require("node:crypto");
const assert = require("node:assert/strict");

(async () => {
  assert.ok(process.env.REPLIT_DEV_DOMAIN, "Development domain required");
  const base = `https://${process.env.REPLIT_DEV_DOMAIN}`;
  const id = "qa-media-" + randomBytes(16).toString("hex");
  const password = randomBytes(24).toString("base64url");
  const phone = "+228" + randomInt(10000000, 99999999);
  const account = mode => execFileSync("python", ["scripts/chat_media_test_user.py"], {
    input: JSON.stringify({ mode, id, password, phone }), stdio: ["pipe", "pipe", "pipe"],
  });
  let browser;
  account("seed");
  try {
    browser = await chromium.launch({
      executablePath: execFileSync("bash", ["-c", "command -v chromium"], { encoding: "utf8" }).trim(),
      args: ["--no-sandbox"], headless: true,
    });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const page = await context.newPage();
    await page.route("**/api/identity/registration-sponsor", route => route.fulfill({ json: { username: "Sponsor_test", source: "official" } }));
    let payload;
    await page.route("**/api/auth/register", async route => {
      payload = route.request().postDataJSON();
      await route.fulfill({ status: 400, json: { detail: "Test de formulaire sans création de compte." } });
    });
    await page.goto(base + "/register?via=landing&flow=2&country=TG&email=qa-registration%40example.com");
    await page.getByTestId("register-password").waitFor({ timeout: 90000 });
    await page.getByTestId("animated-splash").waitFor({ state: "hidden", timeout: 30000 });
    assert.equal(await page.getByTestId("register-email").inputValue(), "qa-registration@example.com");
    assert.equal(await page.getByTestId("register-email").isEditable(), false);
    assert.equal(await page.getByTestId("register-country").getAttribute("aria-disabled"), "true");
    await page.getByTestId("register-username").fill("QaRegistration9");
    await page.getByTestId("register-phone").fill("91000000");
    await page.getByTestId("register-accept").click();
    await page.getByTestId("register-submit").click();
    await page.getByText("Le mot de passe doit contenir au moins 8 caractères.").waitFor();
    assert.equal(payload, undefined);
    await page.getByTestId("register-password").fill(password);
    await page.getByTestId("register-password-confirm").fill("different");
    await page.getByTestId("register-submit").click();
    await page.getByText("Les mots de passe ne correspondent pas.").waitFor();
    assert.equal(payload, undefined);
    await page.getByTestId("register-password-confirm").fill(password);
    assert.equal(await page.getByTestId("register-password").getAttribute("type"), "password");
    await page.screenshot({ path: "/tmp/spv-registration-password.png", fullPage: true });
    await page.getByTestId("register-submit").click();
    await page.getByText("Test de formulaire sans création de compte.").waitFor();
    assert.equal(payload.email, "qa-registration@example.com");
    assert.equal(payload.country, "TG");
    assert.equal(payload.password, password);
    assert.equal(payload.password_confirm, password);
    await context.close();

    for (const identifier of [id + "@example.com", id.replaceAll("-", "_"), phone]) {
      const loginContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
      const loginPage = await loginContext.newPage();
      await loginPage.goto(base + "/login");
      await loginPage.getByTestId("login-email").waitFor({ timeout: 90000 });
      await loginPage.getByTestId("animated-splash").waitFor({ state: "hidden", timeout: 30000 });
      await loginPage.getByTestId("login-email").fill(identifier);
      await loginPage.getByTestId("login-password").fill(password);
      const response = loginPage.waitForResponse(r => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
      await loginPage.getByTestId("login-submit").click();
      assert.equal((await response).status(), 200);
      await loginPage.waitForURL(url => url.pathname.endsWith("/dashboard"), { timeout: 30000 });
      await loginContext.close();
    }
    console.log("PASS: locked prefills, both masked password fields, validation and registration payload; real UI login with email, username and telephone. No signup email or payment sent.");
  } finally {
    if (browser) await browser.close();
    account("cleanup");
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
