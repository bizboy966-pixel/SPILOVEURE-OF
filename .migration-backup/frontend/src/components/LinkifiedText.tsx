import React from "react";
import { Linking, Platform, StyleSheet, Text, TextStyle } from "react-native";
import { theme } from "../theme";

/**
 * LinkifiedText — renders arbitrary text and turns URLs, phone numbers and
 * email addresses into tappable `<Text>` spans.
 *
 * Detection rules (kept intentionally simple + safe):
 *   • Full URLs         : http(s)://…            → opens in browser
 *   • Bare www.         : www.example.com/…      → opens as https://…
 *   • E-mail addresses  : foo@bar.com            → opens mail app
 *   • Phone numbers     : +228 90 00 00 00, 90 00 00 00 (>= 8 digits)
 *
 * Everything else is rendered as plain text so existing styling (color,
 * fontSize, lineHeight) is preserved by the parent's `style` prop.
 */

type Props = {
  children: string;
  style?: TextStyle | TextStyle[];
  linkStyle?: TextStyle;
  numberOfLines?: number;
  selectable?: boolean;
  testID?: string;
};

// The single regex captures four alternatives so we can walk the string
// once and know exactly which kind of match we have via the capture group.
//   1) email
//   2) http/https URL
//   3) bare www.xxx URL
//   4) phone-like sequence (>= 8 digits, optional leading + and spaces/dashes)
const LINK_REGEX =
  /([\w.+-]+@[\w-]+\.[\w.-]+)|((?:https?:\/\/)[^\s<>"']+)|(\bwww\.[^\s<>"']+)|(\+?\d[\d\s().-]{7,}\d)/gi;

function openUrl(url: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  Linking.openURL(url).catch(() => {});
}

function handlePress(kind: "email" | "url" | "phone", raw: string) {
  if (kind === "email") {
    openUrl(`mailto:${raw}`);
  } else if (kind === "url") {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    openUrl(url);
  } else if (kind === "phone") {
    // Keep only + and digits for the dialer to avoid iOS/Android rejection.
    const clean = raw.replace(/[^\d+]/g, "");
    openUrl(`tel:${clean}`);
  }
}

export function LinkifiedText({
  children, style, linkStyle, numberOfLines, selectable, testID,
}: Props) {
  const source = typeof children === "string" ? children : String(children ?? "");
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  // Reset lastIndex — regex is a shared /g instance.
  LINK_REGEX.lastIndex = 0;
  let key = 0;
  while ((m = LINK_REGEX.exec(source)) !== null) {
    const [full, email, http, www, phone] = m;
    if (m.index > lastIndex) {
      parts.push(source.slice(lastIndex, m.index));
    }
    if (email) {
      parts.push(
        <Text
          key={`k-${key++}`}
          onPress={() => handlePress("email", email)}
          style={[styles.link, linkStyle]}
          testID={testID ? `${testID}-email` : undefined}
        >
          {email}
        </Text>,
      );
    } else if (http) {
      parts.push(
        <Text
          key={`k-${key++}`}
          onPress={() => handlePress("url", http)}
          style={[styles.link, linkStyle]}
          testID={testID ? `${testID}-url` : undefined}
        >
          {http}
        </Text>,
      );
    } else if (www) {
      parts.push(
        <Text
          key={`k-${key++}`}
          onPress={() => handlePress("url", www)}
          style={[styles.link, linkStyle]}
          testID={testID ? `${testID}-url` : undefined}
        >
          {www}
        </Text>,
      );
    } else if (phone) {
      // Guard: require at least 8 digits — this filters out things like
      // years / random numbers glued together.
      const digits = phone.replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 15) {
        parts.push(
          <Text
            key={`k-${key++}`}
            onPress={() => handlePress("phone", phone)}
            style={[styles.link, linkStyle]}
            testID={testID ? `${testID}-phone` : undefined}
          >
            {phone}
          </Text>,
        );
      } else {
        parts.push(phone);
      }
    }
    lastIndex = m.index + full.length;
  }
  if (lastIndex < source.length) {
    parts.push(source.slice(lastIndex));
  }
  return (
    <Text style={style} numberOfLines={numberOfLines} selectable={selectable} testID={testID}>
      {parts}
    </Text>
  );
}

const styles = StyleSheet.create({
  link: {
    color: theme.colors.primary,
    fontWeight: "700",
    textDecorationLine: "underline",
  },
});
