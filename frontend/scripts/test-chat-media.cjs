const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function loadModule(name) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, "../src/messenger", name), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, File });
  return exports;
}
const files = loadModule("mediaFiles.ts");

test("mobile video MIME omissions still open a media preview", async () => {
  for (const [name, type] of [["clip.MP4", "video/mp4"], ["clip.MOV", "video/quicktime"],
    ["clip.m4v", "video/mp4"], ["clip.3gp", "video/3gpp"], ["clip.webm", "video/webm"]]) {
    const original = new File(["synthetic-media"], name, { type: "", lastModified: 123 });
    const normalized = files.normalizeMediaFile(original);
    assert.equal(normalized.type, type);
    assert.equal(normalized.name, name);
    assert.equal(normalized.lastModified, 123);
    assert.equal(await normalized.text(), "synthetic-media");
  }
  const generic = new File(["video"], "clip.mp4", { type: "application/octet-stream" });
  assert.equal(files.normalizeMediaFile(generic).type, "video/mp4");
});

test("voice recordings and nonmedia never become videos by inference", () => {
  const voice = new File(["voice"], "voice.webm", { type: "audio/webm" });
  assert.equal(files.normalizeMediaFile(voice), voice);
  assert.equal(files.inferredMediaType({ name: "executable.exe", type: "" }), "");
  assert.equal(files.inferredMediaType({ name: "unsafe.svg", type: "image/svg+xml" }), "image/svg+xml");
});

test("empty and oversized files are rejected before any upload", () => {
  assert.throws(() => files.validateChatFiles([{ name: "empty.mp4", size: 0 }]), /est vide/);
  assert.throws(() => files.validateChatFiles([{ name: "large.mp4", size: files.CHAT_FILE_LIMIT + 1 }]), /20 Mo/);
  assert.doesNotThrow(() => files.validateChatFiles([{ name: "boundary.mp4", size: files.CHAT_FILE_LIMIT }]));
});

test("Chat account access offers password recovery, except during initial password setup", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/identity/IdentityPages.tsx"), "utf8");
  assert.match(source, /!mustCreatePassword && <TouchableOpacity[\s\S]*?router\.push\("\/forgot-password"/);
  assert.match(source, /testID="account-access-forgot-password"/);
});

test("account access has a direct Chat return above the password field", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/identity/IdentityPages.tsx"), "utf8");
  const accountPage = source.slice(source.indexOf("export function AccountAccessPage()"));
  assert.match(accountPage, /router\.replace\("\/messenger" as any\)[\s\S]*?testID="account-access-back-chat"/);
  assert.ok(accountPage.indexOf('testID="account-access-back-chat"') < accountPage.indexOf('testID="main-password"'));
  assert.match(accountPage, /accessibilityLabel="Retour au Chat"/);
});

test("an open contact menu raises its entire row above subsequent save buttons", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/messenger/CommunityPanels.tsx"), "utf8");
  assert.match(source, /style=\{\[styles\.personRow, menu === person\.id && styles\.personRowMenuOpen\]\}/);
  assert.match(source, /personRowMenuOpen:\s*\{\s*zIndex:\s*10,\s*overflow:\s*"visible"/);
  assert.match(source, /testID=\{`messenger-contact-menu-\$\{person.id\}`\}/);
});

const editing = loadModule("mediaEditing.ts");
const withinImage = rect => {
  assert.ok(rect.x >= -1e-8 && rect.y >= -1e-8);
  assert.ok(rect.width > 0 && rect.height > 0);
  assert.ok(rect.x + rect.width <= 1 + 1e-8 && rect.y + rect.height <= 1 + 1e-8);
};

test("crop presets preserve the real image aspect, including rotated photos", () => {
  for (const source of [.5, 1, 2, 4]) {
    for (const [name, target] of [["square", 1], ["portrait", .8], ["wide", 16 / 9]]) {
      const crop = editing.cropForRatio(source, name);
      withinImage(crop);
      assert.ok(Math.abs(source * crop.width / crop.height - target) < 1e-8);
    }
  }
  const size = editing.rotatedDimensions(1200, 800, 90);
  assert.equal(size.width, 800);
  assert.equal(size.height, 1200);
});

test("free crop handles resize and move without leaving the photo", () => {
  for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
    for (const dx of [-2, -.15, .2, 2]) {
      for (const dy of [-2, -.15, .2, 2]) {
        withinImage(editing.resizeCropRect({ x: .2, y: .2, width: .6, height: .6 }, handle, dx, dy, 2));
      }
    }
  }
  const crop = editing.moveCropRect({ x: .2, y: .2, width: .5, height: .5 }, 4, -4);
  assert.equal(crop.x, .5);
  assert.equal(crop.y, 0);
  assert.equal(crop.width, .5);
});

test("locked crop ratios survive each edge and cannot jump back to full size when collapsed", () => {
  const original = { x: .2, y: .2, width: .4, height: .4 };
  for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
    const crop = editing.resizeCropRect(original, handle, .03, -.02, 2, 2);
    withinImage(crop);
    assert.ok(Math.abs(2 * crop.width / crop.height - 2) < 1e-8);
  }
  const collapsed = editing.resizeCropRect(original, "se", -.4, -.4, 2, 2);
  assert.ok(collapsed.width < .1, "A collapsed handle must stop at the minimum, not expand again");
});

test("canvas preview and export place drawings and text using the same normalized positions", () => {
  function paint(width, height) {
    const operations = [];
    const context = {
      clearRect() {}, save() {}, restore() {}, translate: (...args) => operations.push(["translate", ...args]),
      scale() {}, rotate() {}, drawImage() {}, beginPath() {}, moveTo: (...args) => operations.push(["move", ...args]),
      lineTo() {}, stroke() {}, measureText: text => ({ width: text.length * 10 }),
      strokeText() {}, fillText: (...args) => operations.push(["text", ...args]),
    };
    editing.paintEditedCanvas(context, { naturalWidth: 1200, naturalHeight: 800 }, {
      rotation: 0, mirrored: false, filter: "none", strokes: [{ color: "#fff", width: .01, points: [{ x: .1, y: .2 }, { x: .5, y: .6 }] }],
      overlayText: "Bonjour", overlayColor: "#fff", overlayX: .7, overlayY: .3, overlaySize: .075,
      overlayStyle: "classic", overlayAlign: "center", overlayBackground: false,
    }, { x: .25, y: 0, width: .5, height: 1 }, width, height, true);
    return operations;
  }
  const preview = paint(300, 400);
  const exported = paint(600, 800);
  const line = preview.find(op => op[0] === "move");
  const line2 = exported.find(op => op[0] === "move");
  assert.equal(line2[1], line[1] * 2);
  assert.equal(line2[2], line[2] * 2);
  const text = preview.find(op => op[0] === "text");
  const text2 = exported.find(op => op[0] === "text");
  assert.equal(text2[2], text[2] * 2);
  assert.equal(text2[3], text[3] * 2);
});
