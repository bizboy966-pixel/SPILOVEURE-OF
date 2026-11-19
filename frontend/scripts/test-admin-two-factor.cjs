const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("admin panel is hidden from Options and reached through the level trigger", () => {
  const menu = read("src/components/SideMenu.tsx");
  assert.doesNotMatch(menu, /testID="menu-admin"/);
  assert.doesNotMatch(menu, /t\("menu\.admin"\)/);
  assert.match(menu, /testID="menu-admin-level-trigger"/);
  assert.match(menu, /levelTaps\.current >= 4/);
  assert.match(menu, /<AdminTwoFactorGate/);
});

test("the verification modal supports setup, TOTP and one-time backup codes", () => {
  const modal = read("src/components/admin/AdminTwoFactorGate.tsx");
  for (const text of ["/auth/admin-2fa/status", "/auth/admin-2fa/setup", "/auth/admin-2fa/confirm", "/auth/admin-2fa/verify", "backup_codes", "admin-2fa-username", "admin-2fa-code"]) {
    assert.ok(modal.includes(text), `${text} must be part of the 2FA flow`);
  }
  assert.match(modal, /Copier les codes/);
});

test("admin entry redirects to the main dashboard until a step-up token exists", () => {
  const layout = read("app/(admin)/_layout.tsx");
  const login = read("app/(auth)/login.tsx");
  const rootRoute = read("app/index.tsx");
  const appLayout = read("app/(app)/_layout.tsx");
  assert.match(layout, /getAdminStepUpToken/);
  assert.match(layout, /else if \(!hasStepUp\) router\.replace\("\/\(app\)\/dashboard"\)/);
  assert.match(login, /router\.replace\("\/\(app\)\/dashboard"\)/);
  assert.match(rootRoute, /router\.replace\("\/\(app\)\/dashboard" as any\)/);
  assert.match(appLayout, /user\.role === "admin"\) return false/);
  assert.match(appLayout, /user\.role !== "admin" && user\.auth_flow_version/);
});

test("API attaches the step-up proof and expires it in memory", () => {
  const api = read("src/api.ts");
  assert.match(api, /X-Admin-Step-Up/);
  assert.match(api, /_adminStepUpExpiresAt/);
  assert.match(api, /ADMIN_2FA_REQUIRED/);
  assert.match(api, /isAdminRequest\(path\) \? getAdminStepUpToken\(\) : null/);
});
