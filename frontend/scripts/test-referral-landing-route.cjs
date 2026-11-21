const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = relative => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

test("a username referral link forces the landing page before auth routing", () => {
  const referralRoute = read("app/u/[username].tsx");
  const index = read("app/index.tsx");

  assert.match(
    referralRoute,
    /window\.location\.replace\(`\/\?showLanding=1&ref=\$\{encodeURIComponent\(ref\)\}`\)/,
  );
  assert.match(index, /const forceLanding = params\.showLanding === "1" \|\| !!refCode\.trim\(\)/);
  assert.ok(
    index.indexOf("if (forceLanding)") < index.indexOf("if (authLoading || chatLoading"),
    "showLanding must bypass saved login or chat-session redirects",
  );
});

test("landing registration and login actions keep the referral username", () => {
  const index = read("app/index.tsx");
  const register = read("app/(auth)/register.tsx");
  const welcome = read("src/identity/IdentityPages.tsx");

  assert.match(index, /const refQS = refCode \? `\?ref=\$\{encodeURIComponent\(refCode\)\}` : ""/);
  assert.match(index, /onRegister=\{\(\) => router\.push\(`\/welcome\$\{refQS\}` as any\)\}/);
  assert.match(index, /onLogin=\{\(\) => router\.push\(`\/\(auth\)\/login\$\{refQS\}` as any\)\}/);
  assert.match(register, /router\.replace\(`\/\?showLanding=1&ref=\$\{encodeURIComponent\(String\(params\.ref\)\)\}` as any\)/);
  assert.match(welcome, /router\.push\(`\/choose-country\?\$\{paramsQuery\(\{ ref: p\.ref \}\)\}` as any\)/);
});
