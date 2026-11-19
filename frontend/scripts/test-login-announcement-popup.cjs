const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const popup = fs.readFileSync(path.join(root, "src/components/LoginAnnouncementPopup.tsx"), "utf8");
const layout = fs.readFileSync(path.join(root, "app/(app)/_layout.tsx"), "utf8");
const backend = fs.readFileSync(path.join(root, "../backend/server.py"), "utf8");

test("login announcement popup loads the existing active-announcements endpoint", () => {
  assert.match(popup, /api\.get<Announcement\[\]>\("\/announcements"\)/);
  assert.match(popup, /if \(!Array\.isArray\(result\)\)/);
  assert.match(popup, /if \(result\.length === 0\) finish\(\)/);
});

test("each announcement is fully readable in a bounded, scrollable modal", () => {
  assert.match(popup, /<Modal\s+transparent/);
  assert.match(popup, /minHeight: 380/);
  assert.match(popup, /maxHeight: "84%"/);
  assert.match(popup, /<ScrollView[\s\S]*?testID="login-announcement-message-scroll"/);
  assert.match(popup, /testID="login-announcement-message"[\s\S]*?\{announcement\.message\}/);
  assert.doesNotMatch(popup, /numberOfLines=\{[^}]+\}[\s\S]*?announcement\.message/);
});

test("Merci advances through the announcement queue and closes only after the last item", () => {
  assert.match(popup, /currentIndex \+ 1 < announcements\.length/);
  assert.match(popup, /testID="login-announcement-thanks"/);
  assert.match(popup, /accessibilityLabel="Merci"/);
  assert.match(popup, /onPress=\{acknowledge\}/);
  assert.doesNotMatch(popup, /sessionStorage|AsyncStorage|secureSet/);
});

test("a fresh authenticated session fetches announcements once and waits before other popups", () => {
  assert.match(layout, /<LoginAnnouncementPopup\s+key=\{user\.id\}\s+userId=\{user\.id\}/);
  assert.match(layout, /onDone=\{\(\) => setAnnouncementsDone\(true\)\}/);
  assert.match(layout, /\}, \[user\?\.id\]\)/);
  assert.match(layout, /user && inAppGroup && \([\s\S]*?<LoginAnnouncementPopup/);
  assert.match(layout, /isActivated && announcementsDone && <CommunityPopup/);
  assert.match(layout, /announcementsDone && <SupportGroupPopup/);
  assert.match(layout, /announcementsDone && <PushBootstrap/);
  assert.match(layout, /announcementsDone && <NotificationToaster/);
});

test("inactive, future, expired, or deleted announcements are excluded by the existing API", () => {
  assert.match(backend, /@api\.get\("\/announcements"\)[\s\S]*?db\.announcements\.find\(\s*\{"active": True\}/);
  assert.match(backend, /if a\.get\("starts_at"\) and a\["starts_at"\] > now:\s+continue/);
  assert.match(backend, /if a\.get\("ends_at"\) and a\["ends_at"\] < now:\s+continue/);
  assert.match(backend, /@admin_router\.delete\("\/announcements\/\{aid\}"\)[\s\S]*?db\.announcements\.delete_one/);
});
