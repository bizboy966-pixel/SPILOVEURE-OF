const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function createReact(effects = []) {
  return {
    Fragment: "Fragment",
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: effect => effects.push(effect),
  };
}

function loadTsx(path, stubs) {
  const exports = {};
  const source = fs.readFileSync(path, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText;
  vm.runInNewContext(compiled, {
    exports,
    React: stubs.react,
    require: name => {
      if (name.endsWith(".png")) return {};
      return stubs[name] || {};
    },
  }, { filename: path });
  return exports;
}

function findTestId(node, testId) {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(child => findTestId(child, testId));
  if (node.props?.testID === testId) return true;
  return findTestId(node.props?.children, testId);
}

const styleProxy = new Proxy({}, { get: (_target, key) => String(key) });

function landingPage(showPreview) {
  const react = createReact();
  const stubs = {
    react,
    "react-native": {
      AccessibilityInfo: {},
      Image: "Image",
      Pressable: "Pressable",
      Platform: { OS: "web" },
      ScrollView: "ScrollView",
      Text: "Text",
      useWindowDimensions: () => ({ width: 400, height: 800 }),
      View: "View",
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "expo-linear-gradient": { LinearGradient: "LinearGradient" },
    "@expo/vector-icons": { Ionicons: "Ionicons" },
    "@/src/i18n": { useI18n: () => ({ t: key => key, lang: "fr", setLang: async () => {} }) },
    "./PhoneMockups": { ChatMockup: "ChatMockup", DashboardMockup: "DashboardMockup", PhoneFloat: "PhoneFloat" },
    "./PromoVisuals": { PromoVisuals: "PromoVisuals" },
    "./landingStyles": { styles: styleProxy },
  };
  const component = loadTsx("frontend/src/components/landing-redesign/NewLandingPage.tsx", stubs).default;
  return component({ showPreview, onPreview() {}, onLogin() {}, onRegister() {} });
}

function legacyLanding({ enabled, loading = false }) {
  const effects = [];
  const react = createReact(effects);
  const navigations = [];
  const stubs = {
    react,
    "react-native": { ActivityIndicator: "ActivityIndicator", View: "View" },
    "expo-router": {
      useLocalSearchParams: () => ({ ref: "ref-code" }),
      useRouter: () => ({ replace: path => navigations.push(path) }),
    },
    "@/src/components/LandingPage": "LandingPage",
    "@/src/features": { useFeatures: () => ({ features: { landing_page: enabled }, loading }) },
    "@/src/theme": { theme: { colors: { background: "#fff", primary: "#1b5bff" } } },
  };
  const component = loadTsx("frontend/app/legacy-landing.tsx", stubs).default;
  const rendered = component();
  effects.forEach(effect => effect());
  return { rendered, navigations };
}

test("legacy preview button follows the public landing flag", () => {
  assert.equal(findTestId(landingPage(false), "landing-redesign-preview"), false);
  assert.equal(findTestId(landingPage(true), "landing-redesign-preview"), true);
});

test("disabled direct legacy URL redirects to the new landing and keeps referral", () => {
  const result = legacyLanding({ enabled: false });
  assert.deepEqual(result.navigations, ["/?ref=ref-code"]);
  assert.notEqual(result.rendered.type, "LandingPage");
});

test("enabled legacy URL remains available and loading never flashes it", () => {
  const enabled = legacyLanding({ enabled: true });
  assert.deepEqual(enabled.navigations, []);
  assert.equal(enabled.rendered.type, "LandingPage");

  const loading = legacyLanding({ enabled: false, loading: true });
  assert.deepEqual(loading.navigations, []);
  assert.notEqual(loading.rendered.type, "LandingPage");
});
