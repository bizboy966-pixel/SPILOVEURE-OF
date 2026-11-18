const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const ts = require("typescript");
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/identity/countrySearch.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: exportsObject });
const { matchesCountry, countryDisplayName } = exportsObject;
const togo = { code: "TG", name: "Togo", dial: "+228" };
const benin = { code: "BJ", name: "Bénin", dial: "+229" };
const congo = { code: "CD", name: "RD Congo", dial: "+243" };

test("dial search accepts plus, digits and the international 00 prefix", () => {
  for (const query of ["228", "+228", "00228", " + 228 "]) {
    assert.equal(matchesCountry(togo, query), true);
    assert.equal(matchesCountry(benin, query), false);
  }
});
test("country names match regardless of capitalization, accents or apostrophe style", () => {
  assert.equal(matchesCountry(benin, "BENIN"), true);
  assert.equal(matchesCountry(togo, "togo"), true);
  assert.equal(matchesCountry(togo, "tg"), true);
  assert.equal(matchesCountry({ code: "CI", name: "Côte d'Ivoire", dial: "+225" }, "cote d’ivoire"), true);
});
test("full country names remain searchable alongside their previous labels", () => {
  assert.equal(countryDisplayName(congo), "République démocratique du Congo");
  assert.equal(matchesCountry(congo, "republique democratique du congo"), true);
  assert.equal(matchesCountry(congo, "RD Congo"), true);
});
test("empty searches retain the catalog and unmatched queries return no results", () => {
  assert.equal(matchesCountry(togo, "  "), true);
  assert.equal(matchesCountry(togo, "pays inexistant"), false);
  assert.equal(matchesCountry(togo, "+999"), false);
});
