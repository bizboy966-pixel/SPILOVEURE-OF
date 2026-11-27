const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync("src/utils/format.ts", "utf8");
const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS });
const loadedModule = { exports: {} };
vm.runInNewContext(compiled, { module: loadedModule, exports: loadedModule.exports });

const { formatAssetAmount } = loadedModule.exports;

assert.equal(formatAssetAmount(1.428571, "USDT.BEP20"), "1,428571 USDT.BEP20");
assert.equal(formatAssetAmount(1, "USDT.BEP20"), "1 USDT.BEP20");
assert.equal(formatAssetAmount(1234.5, "USDC.POLYGON"), "1\u202f234,5 USDC.POLYGON");
console.log("Dashboard crypto balance formatting tests passed.");
