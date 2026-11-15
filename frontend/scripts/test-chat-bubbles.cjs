const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const read = name => fs.readFileSync(path.join(__dirname, "../src", name), "utf8");
const exported = {};
vm.runInNewContext(ts.transpileModule(read("components/voiceWaveform.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: exported });
const { voiceWaveform } = exported;

test("sent bubbles use the reference green and received bubbles stay white", () => {
  const source = read("messenger/ConversationThread.tsx");
  assert.match(source, /ownBubble: \{[^}]*backgroundColor: "#efffde"/);
  assert.match(source, /otherBubble: \{[^}]*backgroundColor: "#fff"/);
  assert.match(source, /own \? styles\.ownBubble : styles\.otherBubble/);
  assert.match(source, /own \? styles\.ownBubbleTail : styles\.otherBubbleTail/);
});
test("text stays multiline and wrapping while receipt meanings stay unchanged", () => {
  const source = read("messenger/ConversationThread.tsx");
  assert.match(source, /overflowWrap: "anywhere"/);
  assert.match(source, /receiptRead: \{ color: blue \}/);
  assert.match(source, /read \|\| delivered \? "✓✓" : "✓"/);
  assert.match(source, /maxWidth: "88%"/);
});
test("waveforms reflect actual amplitudes and normalize quiet recordings", () => {
  const samples = Float32Array.from([0, 0, 0.01, -0.01, 0.05, -0.05, 0.1, -0.1]);
  const bars = voiceWaveform(samples, 4);
  assert.equal(bars.length, 4);
  assert.equal(bars[0], 3);
  assert.ok(bars[1] < bars[2] && bars[2] < bars[3]);
  assert.equal(bars[3], 23);
});
test("silence and empty audio remain neutral rather than fabricated peaks", () => {
  for (const samples of [new Float32Array(0), new Float32Array(360)]) {
    const bars = voiceWaveform(samples);
    assert.equal(bars.length, 36);
    assert.ok(bars.every(value => value === 3));
  }
});
test("voice player keeps real playback and seeking with responsive controls", () => {
  const source = read("components/VoiceMessage.tsx");
  assert.match(source, /a\.play\(\)/);
  assert.match(source, /a\.currentTime = ratio \* duration/);
  assert.match(source, /voiceWaveform\(decoded\.getChannelData\(0\)\)/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /decodeContext\.close\(\)\.catch/);
  assert.doesNotMatch(source, /minWidth: 200/);
});
