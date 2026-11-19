const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const admin = read("app/(admin)/index.tsx");

function elements(source) {
  const file = ts.createSourceFile("screen.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = [];
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      names.push(node.tagName.getText(file));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return names;
}

test("retired admin panels no longer mount or expose their forms", () => {
  const mounted = elements(admin);
  for (const component of ["PaymentGatewaysCard", "PaymentRouterLogsCard", "AdminSupportTab", "SupportAgentsCard"]) {
    assert.ok(!mounted.includes(component), `${component} must not mount in admin`);
  }
  for (const text of ["Nouveau canal / groupe", "Paiement manuel Crypto (USDT BEP20)", "Configuration paiement manuel", "Aperçu côté utilisateur"]) {
    assert.ok(!admin.includes(`>${text}<`), `${text} must not render`);
  }
  assert.doesNotMatch(admin, /\{tab === "(?:channels|support)" &&/);
});

test("supported payment providers and unrelated admin journeys remain available", () => {
  const mounted = elements(admin);
  assert.ok(mounted.includes("MoneyFusionSettings"));
  assert.ok(mounted.includes("PaymentProvidersRouterCard"));
  assert.ok(mounted.includes("BizTransPayCard"));
  for (const text of ["Frais de retrait", "Publication de l’APK Android", "admin-save-apk-release", "admin-open-content-mgmt", "admin-open-missions-mgmt"]) {
    assert.ok(admin.includes(text), `${text} must remain available`);
  }
  for (const tab of ["users", "admins", "activations", "withdrawals", "providers", "versions", "payment"]) {
    assert.ok(admin.includes(`{tab === "${tab}" &&`), `${tab} must remain available`);
  }
});

test("brand colors remain unchanged by the visual refresh", () => {
  const theme = read("src/theme.ts");
  for (const color of ["#1B5BFF", "#0B2D6F", "#7B61FF", "#10B981", "#EF4444"]) {
    assert.ok(theme.includes(color), `${color} is part of SPILOVEURE identity`);
  }
});
