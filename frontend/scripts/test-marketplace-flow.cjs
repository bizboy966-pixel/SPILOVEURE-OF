/* global __dirname */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const read = relative => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

function loadTs(relative) {
  const source = read(relative);
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleBox = { exports: {} };
  vm.runInNewContext(compiled, {
    module: moduleBox,
    exports: moduleBox.exports,
    URL,
    URLSearchParams,
    window: { location: { origin: "https://spiloveure.org" } },
  });
  return moduleBox.exports;
}

const flow = loadTs("src/marketplace/marketplaceFlow.ts");
const links = loadTs("src/messenger/userLinks.ts");
const marketplace = read("app/(app)/marketplace.tsx");
const messenger = read("src/messenger/MessengerScreen.tsx");

test("Marketplace contact verification returns to the selected seller action", () => {
  const target = flow.marketplaceReturnRoute("save", "seller-23", "listing-45");
  assert.equal(
    links.safeMessengerReturnTo(target),
    "/marketplace?marketplaceAction=save&sellerId=seller-23&listingId=listing-45",
  );
  assert.equal(
    links.safeMessengerReturnTo("/marketplace?marketplaceAction=chat&sellerId=seller-23&listingId=listing-45&redirect=https://bad.test"),
    "/messenger",
  );
});

test("Chat route opens the exact unique conversation and retains listing context", () => {
  const route = flow.marketplaceConversationRoute("conversation-9", "listing-45");
  assert.equal(route, "/messenger?conversation=conversation-9&marketplaceListingId=listing-45");
  assert.match(messenger, /messengerApi\.conversation\(conversationParam\)/);
  assert.match(messenger, /setSelected\(conversation\)/);
});

test("Marketplace interactions and the existing bottom navigation are wired", () => {
  for (const token of [
    "<BottomNav />", "/messenger/contacts/", "/like`", "/comments`",
    "marketplaceShareMessage(", "marketplaceConversationRoute(",
    "testID={`mk-contact-add-", "testID=\"mk-contact-save\"",
    "testID={`mk-like-", "testID={`mk-comments-", "testID={`mk-share-",
  ]) {
    assert.ok(marketplace.includes(token), `Missing Marketplace interaction: ${token}`);
  }
});

test("Marketplace empty states are white while the media feed remains dark", () => {
  assert.match(marketplace, /<ScreenContainer style=\{\{ flex: 1, backgroundColor: "#fff" \}\}>/);
  assert.match(marketplace, /loadingState: \{[^}]*backgroundColor: "#fff"/);
  assert.match(marketplace, /emptyState: \{[^}]*backgroundColor: "#fff"/);
  assert.match(marketplace, /feedArea: \{ flex: 1, backgroundColor: "#050914" \}/);
  assert.match(marketplace, /emptyTitle: \{ color: theme\.colors\.textPrimary/);
  assert.match(marketplace, /emptyText: \{ color: theme\.colors\.textSecondary/);
});

test("Marketplace media swipes horizontally and details stay folded until requested", () => {
  assert.match(marketplace, /<ScrollView[\s\S]*?horizontal[\s\S]*?pagingEnabled[\s\S]*?nestedScrollEnabled/);
  assert.match(marketplace, /onMomentumScrollEnd=\{event =>/);
  assert.match(marketplace, /testID=\{`mk-media-carousel-/);
  assert.match(marketplace, /media\.length > 1 && \([\s\S]*?mediaCount/);
  assert.doesNotMatch(marketplace, /mk-media-(?:prev|next)-/);
  assert.doesNotMatch(marketplace, /mediaNav:/);
  assert.match(marketplace, /const \[expanded, setExpanded\] = useState<Record<string, boolean>>\(\{\}\)/);
  assert.match(marketplace, /const detailsExpanded = Boolean\(expanded\[item\.id\]\)/);
  assert.match(marketplace, /detailsExpanded \? "Voir moins" : "Voir plus"/);
  assert.match(marketplace, /\{detailsExpanded && \([\s\S]*?testID=\{`mk-desc-/);
});

test("Marketplace actions remain in the bottom row above navigation", () => {
  assert.match(marketplace, /actionRail: \{ minHeight: 68, flexDirection: "row"/);
  for (const action of ["like", "comments", "chat", "share"]) {
    assert.match(marketplace, new RegExp(`testID=\\{\\x60mk-${action}-`));
  }
  assert.match(marketplace, /mediaStageExpanded: \{ minHeight: 170 \}/);
  assert.match(marketplace, /listingDetails: \{ paddingHorizontal:/);
});

test("Shared listing URL identifies the selected product", () => {
  const url = flow.marketplaceListingUrl("listing-45", "https://spiloveure.org");
  assert.equal(url, "https://spiloveure.org/marketplace?listing_id=listing-45");
  assert.match(flow.marketplaceShareMessage("Laptop", 320000, "FCFA", url), /listing_id=listing-45/);
});
