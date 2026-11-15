const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const source = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const exported = {};
vm.runInNewContext(ts.transpileModule(source("src/identity/passwordValidation.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: exported });
const validate = exported.registrationPasswordError;

test("the registration password is required, confirmed and bounded by bcrypt's UTF-8 limit", () => {
  assert.match(validate("", ""), /8 caractères/);
  assert.match(validate("short", "short"), /8 caractères/);
  assert.match(validate("Password9!", "different"), /correspondent/);
  assert.match(validate("é".repeat(37), "é".repeat(37)), /72 octets/);
  assert.match(validate("😀".repeat(4), "😀".repeat(4)), /8 caractères/);
  for (const password of ["Password9!", "é".repeat(36), "😀".repeat(18), "a".repeat(72)]) {
    assert.equal(validate(password, password), null);
  }
});

test("registration binds both masked fields and sends them to the server", () => {
  const form = source("app/(auth)/register.tsx");
  assert.match(form, /label="Créer le mot de passe"/);
  assert.match(form, /label="Confirmer le mot de passe"/);
  assert.match(form, /secureTextEntry=\{!showPassword\}/);
  assert.match(form, /secureTextEntry=\{!showPasswordConfirm\}/);
  assert.match(form, /password, password_confirm: passwordConfirm/);
  assert.ok(form.indexOf("registrationPasswordError(password, passwordConfirm)") < form.indexOf("await signUp("));
});

test("prefilled email and country cannot be edited on the account form", () => {
  const form = source("app/(auth)/register.tsx");
  assert.match(form, /editable=\{!params.email\}/);
  assert.match(form, /disabled=\{!!params.country\}/);
  assert.match(form, /if \(params.email\) setEmail\(String\(params.email\)\)/);
  assert.match(form, /params.country && countries.length/);
});

test("the login UI and request accept a username, email or phone identifier", () => {
  assert.match(source("app/(auth)/login.tsx"), /label="E-mail, nom d’utilisateur ou téléphone"/);
  assert.match(source("src/auth.tsx"), /\{ identifier, password \}/);
});
