import React, { useEffect, useRef } from "react";
import {
  Animated,
  Image,
  Platform,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { styles } from "./landingStyles";

type IconName = React.ComponentProps<typeof Ionicons>["name"];
type Translate = (key: string) => string;

export function PhoneFloat({
  children,
  delay,
  reduced,
  style,
}: {
  children: React.ReactNode;
  delay: number;
  reduced: boolean;
  style: object;
}) {
  const position = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) {
      position.stopAnimation();
      position.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(position, {
          toValue: 1,
          duration: 1900,
          useNativeDriver: Platform.OS !== "web",
        }),
        Animated.timing(position, {
          toValue: 0,
          duration: 1900,
          useNativeDriver: Platform.OS !== "web",
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [delay, position, reduced]);

  return (
    <Animated.View
      style={[
        style,
        { transform: [{ translateY: position.interpolate({ inputRange: [0, 1], outputRange: [0, -9] }) }] },
      ]}
    >
      {children}
    </Animated.View>
  );
}

export function DashboardMockup({ t, compact }: { t: Translate; compact: boolean }) {
  const items: { name: string; icon: IconName; tone: string }[] = [
    { name: "market", icon: "storefront", tone: "#FFB645" },
    { name: "ads", icon: "megaphone", tone: "#F3669B" },
    { name: "training", icon: "school", tone: "#54B9F0" },
    { name: "ebook", icon: "book", tone: "#8D67DC" },
    { name: "jobs", icon: "briefcase", tone: "#52BBA2" },
    { name: "premium", icon: "diamond", tone: "#8666E9" },
    { name: "jackpot", icon: "trophy", tone: "#F1BA38" },
    { name: "support", icon: "headset", tone: "#4EBB84" },
  ];

  return (
    <DeviceFrame compact={compact}>
      <View style={styles.dashboardScreen}>
      <View style={styles.phoneStatus}>
        <Text style={styles.statusTime}>03:43</Text>
        <View style={styles.statusSignals}>
          <Ionicons name="cellular" size={10} color="#1B2945" />
          <Ionicons name="wifi" size={11} color="#1B2945" />
          <Ionicons name="battery-full" size={12} color="#1B2945" />
        </View>
      </View>
      <View style={styles.dashBrand}>
        <View style={styles.dashLogo}>
          <Image source={require("@/assets/images/spiloveure-logo.png")} style={styles.dashLogoImage} resizeMode="cover" />
        </View>
        <View style={styles.dashBrandText}>
          <Text style={styles.dashBrandName}>SPILOVEURE</Text>
          <Text style={styles.dashBrandSub}>Affiliate System</Text>
        </View>
        <Ionicons name="notifications-outline" size={15} color="#243957" />
      </View>
      <View style={styles.memberCard}>
        <View style={styles.memberHeading}>
          <View style={styles.memberAvatar}><Ionicons name="person" size={13} color="#FFFFFF" /></View>
          <View style={styles.memberTextWrap}>
            <Text style={styles.memberName}>{t("landingRedesign.dashboard.greeting")}</Text>
            <Text style={styles.memberSince}>{t("landingRedesign.dashboard.member")}</Text>
          </View>
          <View style={styles.levelChip}><Text style={styles.levelText}>{t("landingRedesign.dashboard.level")}</Text></View>
        </View>
        <View style={styles.walletBlock}>
          <View style={styles.walletIcon}><Ionicons name="wallet" size={16} color="#FFFFFF" /></View>
          <View style={styles.walletCopy}>
            <Text style={styles.walletLabel}>{t("landingRedesign.dashboard.wallet")}</Text>
            <Text style={styles.walletAmount}>{t("landingRedesign.dashboard.balance")}</Text>
          </View>
          <Ionicons name="chevron-down" size={12} color="#FFFFFF" />
        </View>
        <View style={styles.balanceCells}>
          <BalanceCell label={t("landingRedesign.dashboard.activation")} amount="2 650 XOF" tone="#46C988" />
          <BalanceCell label={t("landingRedesign.dashboard.profit")} amount="4 230 XOF" tone="#5E8FFF" />
          <BalanceCell label={t("landingRedesign.dashboard.available")} amount="2 650 XOF" tone="#FFD65B" />
        </View>
      </View>
      <View style={styles.quickActions}>
        {[
          { icon: "add-circle", label: "deposit", tone: "#45C88A" },
          { icon: "arrow-down-circle", label: "withdraw", tone: "#F06D78" },
          { icon: "send", label: "send", tone: "#4778EF" },
          { icon: "swap-horizontal", label: "exchange", tone: "#F3A738" },
        ].map((action) => (
          <View key={action.label} style={styles.quickAction}>
            <View style={[styles.quickIcon, { backgroundColor: action.tone }]}>
              <Ionicons name={action.icon as IconName} size={14} color="#FFFFFF" />
            </View>
            <Text style={styles.quickLabel}>{t(`landingRedesign.dashboard.${action.label}`)}</Text>
          </View>
        ))}
      </View>
      <View style={styles.dashSectionTitle}>
        <Text style={styles.dashSectionText}>{t("landingRedesign.dashboard.services")}</Text>
        <Text style={styles.seeAllText}>{t("landingRedesign.dashboard.seeAll")}</Text>
      </View>
      <View style={styles.serviceGridMock}>
        {items.map((item) => (
          <View key={item.name} style={styles.mockService}>
            <View style={[styles.mockServiceIcon, { backgroundColor: item.tone }]}>
              <Ionicons name={item.icon} size={13} color="#FFFFFF" />
            </View>
            <Text style={styles.mockServiceLabel} numberOfLines={1}>{t(`landingRedesign.dashboard.${item.name}`)}</Text>
          </View>
        ))}
      </View>
      <View style={styles.phoneTabBar}>
        {[
          ["home", "home"],
          ["sparkles", "ai"],
          ["checkbox", "tasks"],
          ["chatbubbles", "chat"],
          ["person", "profile"],
        ].map(([icon, label], index) => (
          <View key={label} style={styles.phoneTab}>
            <Ionicons name={icon as IconName} size={13} color={index === 0 ? "#1C54D9" : "#718096"} />
            {!compact ? <Text style={[styles.phoneTabLabel, index === 0 && styles.phoneTabActive]}>{t(`landingRedesign.dashboard.${label}`)}</Text> : null}
          </View>
        ))}
      </View>
      </View>
    </DeviceFrame>
  );
}

function BalanceCell({ label, amount, tone }: { label: string; amount: string; tone: string }) {
  return (
    <View style={styles.balanceCell}>
      <View style={[styles.balanceDot, { backgroundColor: tone }]} />
      <Text style={styles.balanceLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.balanceAmount} numberOfLines={1}>{amount}</Text>
    </View>
  );
}

export function ChatMockup({
  t,
  variation,
  small,
}: {
  t: Translate;
  variation: "inbox" | "conversation";
  small: boolean;
}) {
  const conversation = variation === "conversation";
  const names = conversation
    ? ["SPILOVEURE", "Mireille", "Junior", "Support team"]
    : ["SPILOVEURE", "preview_contact_04", "preview_contact_05", "admin", "Brian"];

  return (
    <DeviceFrame small={small} style={styles.chatDevice}>
      <View style={styles.chatHeader}>
        <View style={styles.chatAppMark}>
          <Image source={require("@/assets/images/spiloveure-logo.png")} style={styles.chatMarkImage} resizeMode="cover" />
        </View>
        <View style={styles.chatHeaderCopy}>
          <Text style={styles.chatTitle} numberOfLines={1}>{t("landingRedesign.chat.title")}</Text>
          <Text style={styles.chatOnline}>{t("landingRedesign.chat.online")}</Text>
        </View>
        <Ionicons name={conversation ? "ellipsis-vertical" : "search"} size={15} color="#33445C" />
      </View>
      {conversation ? (
        <View style={styles.conversationBody}>
          <View style={styles.dayChip}><Text style={styles.dayChipText}>{t("landingRedesign.chat.today")}</Text></View>
          <ChatBubble text={t("landingRedesign.chat.message1")} />
          <ChatBubble text={t("landingRedesign.chat.message2")} />
          <ChatBubble text={t("landingRedesign.chat.message3")} outgoing />
          <View style={styles.chatComposer}>
            <Ionicons name="add-circle-outline" size={17} color="#4265D5" />
            <Text style={styles.chatPlaceholder}>{t("landingRedesign.chat.messagePlaceholder")}</Text>
            <Ionicons name="send" size={14} color="#4265D5" />
          </View>
        </View>
      ) : (
        <View style={styles.chatInbox}>
          <View style={styles.chatTabs}>
            <View style={styles.chatTabActive}><Text style={styles.chatTabActiveText}>{t("landingRedesign.chat.all")}</Text></View>
            <Text style={styles.chatTabText}>{t("landingRedesign.chat.messages")}</Text>
          </View>
          {names.map((name, index) => (
            <View key={name} style={styles.contactRow}>
              <View style={[styles.contactAvatar, { backgroundColor: ["#F4C259", "#72A6EF", "#72C9AF", "#EE8FA1", "#9779DA"][index % 5] }]}>
                {index === 0 ? <Ionicons name="people" size={15} color="#FFFFFF" /> : <Text style={styles.contactInitial}>{name.slice(0, 1).toUpperCase()}</Text>}
              </View>
              <View style={styles.contactCopy}>
                <Text style={styles.contactName} numberOfLines={1}>{name}</Text>
                <Text style={styles.contactMessage} numberOfLines={1}>
                  {index === 0 ? t("landingRedesign.chat.message2") : t("landingRedesign.chat.samplePreview")}
                </Text>
              </View>
              <Text style={styles.contactTime}>09:4{index}</Text>
            </View>
          ))}
          <View style={styles.chatFab}><Ionicons name="add" size={20} color="#FFFFFF" /></View>
        </View>
      )}
    </DeviceFrame>
  );
}

function DeviceFrame({
  children,
  compact = false,
  small = false,
  style,
}: {
  children: React.ReactNode;
  compact?: boolean;
  small?: boolean;
  style?: object;
}) {
  return (
    <View style={[styles.device, compact && styles.deviceCompact, small && styles.deviceSmall, style]}>
      <View style={styles.deviceScreen}>
        <View style={styles.dynamicIsland} />
        {children}
      </View>
      <View style={styles.deviceSideButton} />
    </View>
  );
}

function ChatBubble({ text, outgoing = false }: { text: string; outgoing?: boolean }) {
  return (
    <View style={[styles.bubbleRow, outgoing && styles.bubbleRowOutgoing]}>
      <View style={[styles.chatBubble, outgoing && styles.chatBubbleOutgoing]}>
        <Text style={[styles.chatBubbleText, outgoing && styles.chatBubbleTextOutgoing]}>{text}</Text>
        <Text style={[styles.messageTime, outgoing && styles.messageTimeOutgoing]}>09:42</Text>
      </View>
    </View>
  );
}
