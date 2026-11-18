// Expo Go uses CDN fonts because Metro can return empty icon-font assets there.
// The Capacitor web bundle must explicitly register Ionicons locally: it has
// neither native autolinking nor the Expo Go CDN loader.
// ICON_VECTOR_VERSION must match @expo/vector-icons in package.json.
// Usage: const [loaded, error] = useIconFonts();

import Constants, { ExecutionEnvironment } from "expo-constants";
import { useFonts } from "expo-font";

const ICON_VECTOR_VERSION = "15.0.3";
// Keep a local copy outside pnpm's hidden .pnpm path: Android's asset packager
// omits hidden directories, which otherwise leaves Ionicons without its font.
const BUNDLED_IONICONS_FONT = require("../../assets/fonts/Ionicons.ttf");

const ICON_FAMILIES = [
  "AntDesign",
  "Entypo",
  "EvilIcons",
  "Feather",
  "FontAwesome",
  "FontAwesome5_Brands",
  "FontAwesome5_Regular",
  "FontAwesome5_Solid",
  "FontAwesome6_Brands",
  "FontAwesome6_Regular",
  "FontAwesome6_Solid",
  "Fontisto",
  "Foundation",
  "Ionicons",
  "MaterialCommunityIcons",
  "MaterialIcons",
  "Octicons",
  "SimpleLineIcons",
  "Zocial",
] as const;

type IconFamily = (typeof ICON_FAMILIES)[number];

const iconFontMap = (): Record<IconFamily, string> =>
  Object.fromEntries(
    ICON_FAMILIES.map((f) => [
      f,
      `https://cdn.jsdelivr.net/npm/@expo/vector-icons@${ICON_VECTOR_VERSION}/build/vendor/react-native-vector-icons/Fonts/${f}.ttf`,
    ]),
  ) as Record<IconFamily, string>;

export const useIconFonts = (): readonly [boolean, Error | null] =>
  useFonts(
    process.env.EXPO_PUBLIC_CAPACITOR_NATIVE === "1"
      ? { Ionicons: BUNDLED_IONICONS_FONT }
      : Constants.executionEnvironment === ExecutionEnvironment.StoreClient
        ? iconFontMap()
        : {},
  );
