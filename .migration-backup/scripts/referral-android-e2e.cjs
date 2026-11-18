// Browser-only regression tests. No registration submission, mail or payment.
const { chromium, expect } = require("@playwright/test");
const { execFileSync } = require("child_process");
const assert = require("assert/strict");
const base = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const executablePath = execFileSync("sh", ["-c",
  "command -v chromium || nix-shell -p chromium --run 'command -v chromium'"],
{ encoding: "utf8" }).trim();

(async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(() => sessionStorage.setItem("spilv_splash_seen_v1", "1"));
    const response = await page.request.get(base + "/api/identity/registration-sponsor");
    assert.equal(response.status(), 200);
    const official = await response.json();
    await page.goto(base + "/register?via=landing", { waitUntil: "networkidle", timeout: 90000 });
    await expect(page.getByTestId("register-sponsor")).toHaveValue(official.username, { timeout: 15000 });
    await expect(page.getByTestId("register-ref-invalid")).toHaveCount(0);
    assert.equal(await page.getByTestId("register-sponsor").isEditable(), false);
    console.log("PASS: inscription sans lien, parrain officiel prérempli et non modifiable.");

    await page.goto(base + "/register?via=landing&ref=messenger_test_bob", { waitUntil: "networkidle" });
    await expect(page.getByTestId("register-sponsor")).toHaveValue("messenger_test_bob");
    console.log("PASS: un lien d’invitation valide reste prioritaire.");

    await page.goto(base + "/register?via=landing&ref=missing_sponsor_for_browser_test", { waitUntil: "networkidle" });
    await expect(page.getByTestId("register-ref-invalid")).toBeVisible();
    await expect(page.getByTestId("register-sponsor")).toHaveValue("");
    console.log("PASS: aucun remplacement silencieux d’une invitation invalide.");

    await page.goto(base + "/telecharger", { waitUntil: "networkidle" });
    await expect(page.locator('[aria-disabled="true"]').first()).toBeVisible();
    assert.equal(await page.locator('a[href$="/download"]').count(), 0);
    await expect(page.locator('a[href="/login"]').first()).toBeVisible();
    await expect(page.locator('a[href="/welcome"]').first()).toBeVisible();
    await page.screenshot({ path: "generated-artifacts/android-download-mobile.jpg", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: "generated-artifacts/android-download-desktop.jpg", fullPage: true });
    assert.equal(errors.length, 0, errors.join(" | "));
    console.log("PASS: page Android sur mobile/desktop, liens d’accès présents, aucun faux téléchargement.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
