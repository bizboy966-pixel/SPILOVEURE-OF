const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function createHarness() {
  const states = [];
  const refs = [];
  let stateIndex = 0;
  let refIndex = 0;
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], next => {
        states[index] = typeof next === "function" ? next(states[index]) : next;
      }];
    },
    useRef(initial) {
      const index = refIndex++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index];
    },
    useCallback: callback => callback,
    useEffect: () => {},
  };

  const modules = {
    react: React,
    "react-native": {
      ActivityIndicator: "ActivityIndicator",
      BackHandler: { addEventListener: () => ({ remove() {} }) },
      StyleSheet: { create: value => value, absoluteFillObject: {} },
      Text: "Text",
      TouchableOpacity: "TouchableOpacity",
      View: "View",
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "expo-status-bar": { StatusBar: "StatusBar" },
    "react-native-webview": { __esModule: true, default: "WebView" },
  };

  const source = fs.readFileSync("frontend/src/components/AndroidWebApp.android.tsx", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    React,
    require: name => modules[name] || {},
  });

  return {
    render() {
      stateIndex = 0;
      refIndex = 0;
      return exports.default();
    },
  };
}

function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findNode(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (predicate(node)) return node;
  return findNode(node.props?.children, predicate);
}

test("WebView keeps its first-load indicator off subsequent page navigation", () => {
  const harness = createHarness();
  let tree = harness.render();
  assert.ok(findNode(tree, node => node.props?.testID === "webview-loading"));

  let webView = findNode(tree, node => node.type === "WebView");
  webView.props.onLoadEnd();
  tree = harness.render();
  assert.equal(findNode(tree, node => node.props?.testID === "webview-loading"), null);

  webView = findNode(tree, node => node.type === "WebView");
  webView.props.onLoadStart();
  tree = harness.render();
  assert.equal(findNode(tree, node => node.props?.testID === "webview-loading"), null);
});
