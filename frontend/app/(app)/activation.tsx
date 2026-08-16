import React, { useEffect, useMemo, useState } from "react";
import {
  ScrollView, StyleSheet, Text, View, TouchableOpacity, Alert, TextInput, Platform, Linking, Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { useFeature } from "@/src/features";
import { theme } from "@/src/theme";
import { formatFCFA } from "@/src/utils/format";

const OPERATORS_BY_COUNTRY: Record<string, string[]> = {
  TG: ["Flooz (Moov)", "T-Money"],
  BJ: ["Moov Money", "MTN Mobile Money"],
  BF: ["Orange Money", "Moov Money"],
  CI: ["MTN Mobile Money", "Moov Money", "Wave", "Orange Money"],
  ML: ["Wave", "Orange Money", "Moov Money"],
  SN: ["Orange Money", "Wave", "Free Money"],
  NE: ["Airtel Money"],
  CM: ["MTN Mobile Money", "Orange Money"],
  GA: ["Moov Money", "Airtel Money"],
  CG: ["Airtel Money", "MTN Mobile Money"],
  CF: ["Orange Money"],
  TD: ["Moov Money", "Airtel Money"],
  CD: ["Vodacom M-Pesa", "Afrimoney", "Orange Money", "Airtel Money"],
  GN: ["MTN Mobile Money", "Orange Money"],
  GQ: ["Orange Money"],
  GW: ["Orange Money"],
  GH: ["MTN Mobile Money", "Vodafone Cash"],
  NG: ["Opay", "PalmPay"],
};

const COUNTRY_LABELS: Record<string, { flag: string; name: string }> = {
  TG: { flag: "🇹🇬", name: "Togo" },
  BJ: { flag: "🇧🇯", name: "Bénin" },
  BF: { flag: "🇧🇫", name: "Burkina Faso" },
  CI: { flag: "🇨🇮", name: "Côte d'Ivoire" },
  ML: { flag: "🇲🇱", name: "Mali" },
  SN: { flag: "🇸🇳", name: "Sénégal" },
  NE: { flag: "🇳🇪", name: "Niger" },
  CM: { flag: "🇨🇲", name: "Cameroun" },
  GA: { flag: "🇬🇦", name: "Gabon" },
  CG: { flag: "🇨🇬", name: "Congo-Brazzaville" },
  CF: { flag: "🇨🇫", name: "Centrafrique" },
  TD: { flag: "🇹🇩", name: "Tchad" },
  CD: { flag: "🇨🇩", name: "RD Congo" },
  GN: { flag: "🇬🇳", name: "Guinée" },
  GQ: { flag: "🇬🇶", name: "Guinée équatoriale" },
  GW: { flag: "🇬🇼", name: "Guinée-Bissau" },
  GH: { flag: "🇬🇭", name: "Ghana" },
  NG: { flag: "🇳🇬", name: "Nigeria" },
  // Afrique de l'Est / Australe / Nord
  KE: { flag: "🇰🇪", name: "Kenya" },
  UG: { flag: "🇺🇬", name: "Ouganda" },
  RW: { flag: "🇷🇼", name: "Rwanda" },
  TZ: { flag: "🇹🇿", name: "Tanzanie" },
  EG: { flag: "🇪🇬", name: "Égypte" },
  ZA: { flag: "🇿🇦", name: "Afrique du Sud" },
  MR: { flag: "🇲🇷", name: "Mauritanie" },
  AO: { flag: "🇦🇴", name: "Angola" },
  MZ: { flag: "🇲🇿", name: "Mozambique" },
  LR: { flag: "🇱🇷", name: "Libéria" },
  SL: { flag: "🇸🇱", name: "Sierra Leone" },
  GM: { flag: "🇬🇲", name: "Gambie" },
  BW: { flag: "🇧🇼", name: "Botswana" },
  NA: { flag: "🇳🇦", name: "Namibie" },
  ZM: { flag: "🇿🇲", name: "Zambie" },
  ZW: { flag: "🇿🇼", name: "Zimbabwe" },
  MG: { flag: "🇲🇬", name: "Madagascar" },
  MU: { flag: "🇲🇺", name: "Maurice" },
  // Europe
  FR: { flag: "🇫🇷", name: "France" },
  BE: { flag: "🇧🇪", name: "Belgique" },
  CH: { flag: "🇨🇭", name: "Suisse" },
  DE: { flag: "🇩🇪", name: "Allemagne" },
  IT: { flag: "🇮🇹", name: "Italie" },
  ES: { flag: "🇪🇸", name: "Espagne" },
  PT: { flag: "🇵🇹", name: "Portugal" },
  GB: { flag: "🇬🇧", name: "Royaume-Uni" },
  NL: { flag: "🇳🇱", name: "Pays-Bas" },
  // Amériques
  CA: { flag: "🇨🇦", name: "Canada" },
  US: { flag: "🇺🇸", name: "États-Unis" },
  BR: { flag: "🇧🇷", name: "Brésil" },
  MX: { flag: "🇲🇽", name: "Mexique" },
  HT: { flag: "🇭🇹", name: "Haïti" },
  // Moyen-Orient
  AE: { flag: "🇦🇪", name: "Émirats Arabes Unis" },
  QA: { flag: "🇶🇦", name: "Qatar" },
  SA: { flag: "🇸🇦", name: "Arabie Saoudite" },
  // Asie
  IN: { flag: "🇮🇳", name: "Inde" },
  PK: { flag: "🇵🇰", name: "Pakistan" },
  BD: { flag: "🇧🇩", name: "Bangladesh" },
  MY: { flag: "🇲🇾", name: "Malaisie" },
  SG: { flag: "🇸🇬", name: "Singapour" },
  PH: { flag: "🇵🇭", name: "Philippines" },
  // Océanie
  AU: { flag: "🇦🇺", name: "Australie" },
  NZ: { flag: "🇳🇿", name: "Nouvelle-Zélande" },
};

type ManualSettings = {
  enabled: boolean;
  payment_url: string;
  title: string;
  instructions: string;
  phone_to_pay: string;
  operator_name: string;
  allowed_countries: string[];
};

export default function Activation() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [level1, setLevel1] = useState<any>(null);
  const [payerName, setPayerName] = useState<string>("");
  const [payerPhone, setPayerPhone] = useState<string>("");
  const [country, setCountry] = useState<string>("TG");
  const [operator, setOperator] = useState<string>("");
  const [otp, setOtp] = useState<string>("");
  const [otpRequired, setOtpRequired] = useState<boolean>(false);
  const [ussdCode, setUssdCode] = useState<string>("");
  const [waveUrl, setWaveUrl] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualCfg, setManualCfg] = useState<ManualSettings | null>(null);

  // Manual payment form (mirrors the secure flow but redirects out)
  const [manualCountry, setManualCountry] = useState<string>("");
  const [manualOperator, setManualOperator] = useState<string>("");
  const [manualPhone, setManualPhone] = useState<string>("");
  const [manualSubmitting, setManualSubmitting] = useState(false);

  // Global on/off switches for payment methods (admin-controlled).
  // ⚠️ Legacy SendavaPay/WestPay were removed 2026-06-15.
  // SoleasPay is now the unique automatic payment gateway.
  const [secureEnabled, setSecureEnabled] = useState(false);
  const secureUIEnabled = false; // ← hard switch to hide legacy form (dead code)
  const [soleasEnabled, setSoleasEnabled] = useState(true);   // ← runtime kill-switch
  const [secureAllowed, setSecureAllowed] = useState<string[]>([]);

  // Countries excluded by SoleasPay merchant policy (RDC excluded by business rule)
  const SOLEAS_EXCLUDED = ["COD"];
  const [soleasCountries, setSoleasCountries] = useState<string[]>([]);
  const [soleasServices, setSoleasServices] = useState<Record<string, any[]>>({});

  // Map phone prefix → ISO country code (auto-detection)
  const PHONE_PREFIX_TO_COUNTRY: Record<string, string> = {
    "228": "TG", "229": "BJ", "226": "BF", "225": "CI",
    "237": "CM", "242": "COG", "241": "GAB", "256": "UGA",
  };
  function detectCountryFromPhone(raw: string): string | null {
    const digits = (raw || "").replace(/\D/g, "");
    if (!digits) return null;
    for (const [pfx, cc] of Object.entries(PHONE_PREFIX_TO_COUNTRY)) {
      if (digits.startsWith(pfx)) return cc;
    }
    return null;
  }
  const [manualEnabled, setManualEnabled] = useState(false);
  const [cryptoEnabled, setCryptoEnabled] = useState(false);
  const [ashtecEnabled, setAshtecEnabled] = useState(false);
  const cryptoAutoEnabled = useFeature("crypto_auto");
  const [cryptoCfg, setCryptoCfg] = useState<{network:string;wallet_address:string;amount_usdt:number;instructions:string} | null>(null);
  // BizTransPay availability — fetched from `/payments/biztranspay/public/status`.
  // Hides the banner when the admin hasn't configured the API key yet, so the
  // user never sees a button that leads nowhere.
  const [btpEnabled, setBtpEnabled] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const r = await api.get<any>("/payments/biztranspay/public/status");
        setBtpEnabled(!!r?.enabled);
      } catch { setBtpEnabled(false); }
    })();
  }, []);

  // Active payment method (user choice)
  const [paymentMode, setPaymentMode] = useState<"soleas" | "manual" | "crypto" | null>(null);

  // SoleasPay flow
  const [soleasCountry, setSoleasCountry] = useState("TG");
  const [soleasServiceId, setSoleasServiceId] = useState<number | null>(null);
  const [soleasPhone, setSoleasPhone] = useState("");
  const [soleasSubmitting, setSoleasSubmitting] = useState(false);
  const [soleasOrderId, setSoleasOrderId] = useState<string | null>(null);
  const [soleasStatus, setSoleasStatus] = useState<string>("");
  const [soleasMessage, setSoleasMessage] = useState<string>("");

  // Crypto form state
  const [cryptoTxHash, setCryptoTxHash] = useState("");
  const [cryptoSubmitting, setCryptoSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.get<{ levels: any[] }>("/config", { auth: false });
        setLevel1(cfg.levels[0]);
      } catch {}
      try {
        const m = await api.get<ManualSettings>("/settings/manual-payment", { auth: false });
        setManualCfg(m);
      } catch {}
      try {
        const flags = await api.get<{
          soleaspay_enabled: boolean;
          soleaspay_excluded_countries: string[];
          soleaspay_countries: string[];
          soleaspay_services_by_country: Record<string, any[]>;
          manual_enabled: boolean;
          crypto_enabled: boolean;
          ashtec_enabled?: boolean;
          soleas_enabled?: boolean;
          crypto?: any;
        }>("/settings/payments", { auth: false });
        // IMPORTANT — read the per-gateway toggle `soleas_enabled` (not the
        // legacy `soleaspay_enabled` which is TRUE whenever *any* auto
        // payment gateway is on, including Ashtech). This was the root
        // cause of "SolesPay disabled but still visible".
        setSoleasEnabled(!!flags.soleas_enabled);
        setSoleasCountries(flags.soleaspay_countries || []);
        setSoleasServices(flags.soleaspay_services_by_country || {});
        setManualEnabled(!!flags.manual_enabled);
        setCryptoEnabled(!!flags.crypto_enabled);
        setAshtecEnabled(!!flags.ashtec_enabled);
        setCryptoCfg(flags.crypto || null);
      } catch {}
    })();
    setPayerName(user?.username || "");
    setPayerPhone(user?.phone || "");
    setCountry(user?.country || "TG");
    setManualCountry(user?.country || "TG");
    setManualPhone(user?.phone || "");
  }, [user?.username, user?.phone, user?.country]);

  // Default manual operator to first operator of selected country
  useEffect(() => {
    const ops = OPERATORS_BY_COUNTRY[manualCountry] || [];
    setManualOperator((cur) => (ops.includes(cur) ? cur : ops[0] || ""));
  }, [manualCountry]);

  useEffect(() => {
    const ops = OPERATORS_BY_COUNTRY[country] || [];
    setOperator(ops[0] || "");
  }, [country]);

  const operators = useMemo(() => OPERATORS_BY_COUNTRY[country] || [], [country]);
  const amount = useMemo(() => level1?.price || 5000, [level1]);
  const canPay = payerPhone.trim().length >= 8 && payerName.trim().length >= 2 && operator.length > 0 && !submitting;

  const startPayment = async () => {
    if (!canPay) {
      Alert.alert("Champs requis", "Nom, opérateur et numéro Mobile Money sont obligatoires.");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await api.post<any>("/payments/secure/initiate", {
        level: 1,
        phone: payerPhone.trim(),
        operator,
        country_code: country,
        otp: otp.trim() || undefined,
      });

      // Persist token/reference so the success page can poll the right payment
      if (typeof window !== "undefined" && window.sessionStorage) {
        try {
          window.sessionStorage.setItem("pay_ref", resp.order_id);
        } catch {}
      }

      if (resp.status === "otp_required") {
        setOtpRequired(true);
        setUssdCode(resp.ussd_code || "");
        Alert.alert(
          "Code OTP requis",
          resp.ussd_code
            ? `Composez ${resp.ussd_code} sur votre téléphone pour recevoir votre code, puis saisissez-le ci-dessous.`
            : "Un SMS contenant un code OTP a été envoyé à votre numéro. Saisissez-le ci-dessous.",
        );
        return;
      }

      if ((resp.flow === "wave" || resp.flow === "redirect") && resp.wave_url) {
        // WestPay (RobotPay) hosted checkout — redirect the user out.
        setWaveUrl(resp.wave_url);
        if (Platform.OS === "web" && typeof window !== "undefined") {
          // Belt-and-braces redirect: try same-tab first, fall back to new tab.
          try {
            window.location.assign(resp.wave_url);
          } catch {}
          setTimeout(() => {
            try {
              if (window.location.href.indexOf("westpay") === -1) {
                window.open(resp.wave_url, "_blank");
              }
            } catch {}
          }, 600);
        } else {
          Linking.openURL(resp.wave_url);
          router.replace({ pathname: "/payment/success", params: { ref: resp.order_id } });
        }
        return;
      }

      // USSD push flow: ask the user to confirm on their phone and go to success page
      Alert.alert(
        "Confirmation requise",
        "Une demande de paiement a été envoyée sur votre téléphone. Confirmez-la pour finaliser l'activation.",
        [
          {
            text: "OK",
            onPress: () =>
              router.replace({ pathname: "/payment/success", params: { ref: resp.order_id } }),
          },
        ],
      );
    } catch (e: any) {
      Alert.alert(
        "Paiement impossible",
        e?.detail || "Le service de paiement n'a pas pu traiter votre demande.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const submitManualPayment = async () => {
    if (!manualCountry || !manualOperator || manualPhone.trim().length < 8) {
      Alert.alert(
        "Champs requis",
        "Pays, opérateur et numéro Mobile Money sont obligatoires.",
      );
      return;
    }
    setManualSubmitting(true);
    try {
      const resp = await api.post<{
        ok: boolean;
        activation_id: string;
        payment_url: string;
        already_pending?: boolean;
      }>("/activations/manual-request", {
        country: manualCountry,
        operator: manualOperator,
        phone: manualPhone.trim(),
      });

      const url = resp.payment_url || manualCfg?.payment_url || "";
      const message = resp.already_pending
        ? "Une demande de paiement manuel est déjà en attente. Vous allez être redirigé pour finaliser votre paiement."
        : "Demande de paiement manuel enregistrée. Vous allez être redirigé pour payer.";

      if (!url) {
        Alert.alert("Lien de paiement manquant", "Contactez l'administrateur. Demande enregistrée.");
        return;
      }

      if (Platform.OS === "web" && typeof window !== "undefined") {
        // Inform briefly then redirect in the same tab.
        try { window.alert(message); } catch {}
        window.location.href = url;
      } else {
        Alert.alert("Redirection", message, [
          { text: "Ouvrir", onPress: () => Linking.openURL(url) },
        ]);
      }
    } catch (e: any) {
      Alert.alert(
        "Demande impossible",
        e?.detail || "Le paiement manuel n'est pas disponible pour le moment.",
      );
    } finally {
      setManualSubmitting(false);
    }
  };

  const manualAvailable =
    !!manualCfg?.enabled &&
    Array.isArray(manualCfg?.allowed_countries) &&
    (manualCfg!.allowed_countries.length === 0 ||
      manualCfg!.allowed_countries.includes(manualCountry || user?.country || "TG"));

  // Extracted for readability + future-proofing: adding a new gateway
  // only requires appending its flag here rather than editing every
  // conditional in the JSX below.
  const anyGatewayEnabled = [
    secureUIEnabled, soleasEnabled, manualEnabled,
    cryptoEnabled, ashtecEnabled, cryptoAutoEnabled,
  ].some(Boolean);

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Image
            source={require("@/assets/images/spiloveure-logo.png")}
            style={{ width: 44, height: 44 }} resizeMode="contain"
          />
          <View>
            <Text style={styles.brand}>Spiloveure</Text>
            <Text style={styles.brandSub}>AFFILIATE SYSTEM</Text>
          </View>
        </View>
        <Text style={styles.title}>Activation du compte</Text>
        <Text style={styles.sub}>Activez votre Niveau 1 et débloquez tout votre potentiel.</Text>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Card>
          <Text style={styles.section}>Informations utilisateur</Text>
          <Row label="Nom d'utilisateur" value={user?.username || "—"} icon="person" />
          <Row label="Téléphone" value={user?.phone || "—"} icon="call" />
          <Row label="E-mail" value={user?.email || "—"} icon="mail" />
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Détails du paiement</Text>
          <View style={styles.lvlBadge}>
            <Ionicons name="ribbon" size={16} color="#F59E0B" />
            <Text style={styles.lvlText}>Niveau à activer : {level1?.name || "Débutant"}</Text>
          </View>
          <View style={styles.amountBox}>
            <Text style={styles.amountLabel}>Montant d'activation</Text>
            <Text style={styles.amount}>{formatFCFA(amount)}</Text>
            <Text style={styles.amountHint}>Montant non modifiable</Text>
            <View style={{ marginTop: 8, gap: 4 }}>
              <Text style={styles.detail}>• {formatFCFA(amount - (level1?.platform_fee || 0))} → Commission</Text>
              <Text style={styles.detail}>• {formatFCFA(level1?.platform_fee || 0)} → Frais plateforme</Text>
            </View>
          </View>
        </Card>

        {/* No payment method available — block activation */}
        {!anyGatewayEnabled && (
          <Card style={{ marginTop: 12, borderWidth: 2, borderColor: theme.colors.warning, backgroundColor: theme.colors.warningBg }}>
            <View style={{ alignItems: "center", padding: 16 }}>
              <Ionicons name="construct" size={42} color={theme.colors.warning} />
              <Text style={[styles.section, { marginTop: 8, textAlign: "center" }]}>
                Aucun moyen de paiement disponible actuellement
              </Text>
              <Text style={[styles.helper, { textAlign: "center", marginTop: 6 }]}>
                Les méthodes de paiement sont temporairement désactivées par l'administrateur.{"\n"}
                Veuillez réessayer plus tard.
              </Text>
              <Text style={[styles.hint, { textAlign: "center", marginTop: 10 }]}>
                💡 Vous pouvez vérifier régulièrement cette page ou nous contacter via le support.
              </Text>
            </View>
          </Card>
        )}

        {/* Payment mode selector — 3 cards */}
        {anyGatewayEnabled && (
          <Card style={{ marginTop: 12 }}>
            <Text style={styles.section}>Choisir un mode de paiement</Text>

            {/* PRIORITY 1: Ashtech Pay AUTO-ACTIVATION (2500 FCFA, 10 min chrono) */}
            {ashtecEnabled && (
            <TouchableOpacity
              style={styles.autoActivateBtn}
              onPress={() => router.push("/(app)/activation-ashtec" as any)}
              testID="btn-auto-activation"
              activeOpacity={0.85}
            >
              <View style={styles.autoActivateHeader}>
                <View style={styles.autoActivateIcon}>
                  <Ionicons name="rocket" size={26} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.autoActivateTitle}>⚡ AUTO-ACTIVATION</Text>
                  <Text style={styles.autoActivateSub}>
                    Mobile Money instantané — 2 500 FCFA, activation en 10 min
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={26} color="#fff" />
              </View>
              <View style={styles.autoActivateFooter}>
                <View style={styles.autoActivateChip}>
                  <Ionicons name="time-outline" size={12} color="#fff" />
                  <Text style={styles.autoActivateChipText}>Chrono 10 min</Text>
                </View>
                <View style={styles.autoActivateChip}>
                  <Ionicons name="shield-checkmark-outline" size={12} color="#fff" />
                  <Text style={styles.autoActivateChipText}>100% automatique</Text>
                </View>
                <View style={styles.autoActivateChip}>
                  <Ionicons name="cash-outline" size={12} color="#fff" />
                  <Text style={styles.autoActivateChipText}>2 500 FCFA</Text>
                </View>
              </View>
            </TouchableOpacity>
            )}

            {ashtecEnabled && (soleasEnabled || manualEnabled || cryptoEnabled || secureUIEnabled) && (
              <Text style={[styles.helper, { textAlign: "center", marginTop: 12, marginBottom: 4 }]}>
                — ou choisissez un autre mode ci-dessous —
              </Text>
            )}

            <View style={styles.modesCol}>
              {soleasEnabled && (
                <TouchableOpacity
                  style={[styles.modeCard, paymentMode === "soleas" && styles.modeCardOn]}
                  onPress={() => setPaymentMode("soleas")}
                  testID="mode-soleas"
                >
                  <View style={[styles.modeIcon, { backgroundColor: theme.colors.primary }]}>
                    <Ionicons name="flash" size={22} color="#fff" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modeTitle}>1️⃣ Paiement Automatique</Text>
                    <Text style={styles.modeBody}>
                      Mobile Money — Recevez la demande sur votre téléphone, confirmez, et votre niveau s'active automatiquement.
                    </Text>
                  </View>
                  {paymentMode === "soleas" ? (
                    <Ionicons name="checkmark-circle" size={22} color={theme.colors.success} />
                  ) : null}
                </TouchableOpacity>
              )}

              {secureUIEnabled && (() => {
                const userCountry = (user?.country || "TG").toUpperCase();
                const allowed = secureAllowed.length === 0 || secureAllowed.includes(userCountry);
                return (
                  <TouchableOpacity
                    style={[styles.modeCard, paymentMode === "auto" && styles.modeCardOn, !allowed && styles.modeCardOff]}
                    onPress={() => allowed && setPaymentMode("auto")}
                    disabled={!allowed}
                    testID="mode-auto"
                  >
                    <View style={styles.modeIcon}><Ionicons name="flash" size={22} color="#fff" /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modeTitle}>1️⃣ Paiement Automatique</Text>
                      <Text style={styles.modeBody}>
                        {allowed
                          ? "Mobile Money instantané — Niveau 1 activé immédiatement."
                          : `Disponible uniquement pour : ${secureAllowed.join(", ")}.`}
                      </Text>
                    </View>
                    {paymentMode === "auto" ? (
                      <Ionicons name="checkmark-circle" size={22} color={theme.colors.success} />
                    ) : !allowed ? (
                      <Ionicons name="lock-closed" size={22} color={theme.colors.textSecondary} />
                    ) : null}
                  </TouchableOpacity>
                );
              })()}

              {manualEnabled && manualAvailable && (
                <TouchableOpacity
                  style={[styles.modeCard, paymentMode === "manual" && styles.modeCardOn]}
                  onPress={() => setPaymentMode("manual")}
                  testID="mode-manual"
                >
                  <View style={[styles.modeIcon, { backgroundColor: "#10B981" }]}><Ionicons name="card" size={22} color="#fff" /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modeTitle}>2️⃣ Paiement Manuel Mobile Money</Text>
                    <Text style={styles.modeBody}>
                      Soumettez votre paiement Mobile Money. Validation par l'admin sous 24h.
                    </Text>
                  </View>
                  {paymentMode === "manual" ? <Ionicons name="checkmark-circle" size={22} color={theme.colors.success} /> : null}
                </TouchableOpacity>
              )}

              {cryptoEnabled && (
                <TouchableOpacity
                  style={[styles.modeCard, paymentMode === "crypto" && styles.modeCardOn]}
                  onPress={() => setPaymentMode("crypto")}
                  testID="mode-crypto"
                >
                  <View style={[styles.modeIcon, { backgroundColor: "#F59E0B" }]}><Ionicons name="logo-bitcoin" size={22} color="#fff" /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modeTitle}>3️⃣ Paiement Manuel Crypto (USDT BEP20)</Text>
                    <Text style={styles.modeBody}>
                      Envoyez {cryptoCfg?.amount_usdt || 5} USDT (BEP20) puis collez le hash TXID.
                    </Text>
                  </View>
                  {paymentMode === "crypto" ? <Ionicons name="checkmark-circle" size={22} color={theme.colors.success} /> : null}
                </TouchableOpacity>
              )}
            </View>

            {/* PRIORITY 3: Auto activation crypto — same visual weight as
                AUTO-ACTIVATION Ashtech (harmonised big banner). Only its
                content + accent colour differ. */}
            {cryptoAutoEnabled && (
              <TouchableOpacity
                style={[styles.autoActivateBtn, styles.autoActivateBtnCrypto]}
                onPress={() => router.push("/(app)/activation-crypto-auto" as any)}
                testID="btn-crypto-auto-activation"
                activeOpacity={0.85}
              >
                <View style={styles.autoActivateHeader}>
                  <View style={[styles.autoActivateIcon, styles.autoActivateIconCrypto]}>
                    <Ionicons name="logo-bitcoin" size={26} color="#fff" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.autoActivateTitle}>⚡ AUTO-ACTIVATION CRYPTO</Text>
                    <Text style={styles.autoActivateSub}>
                      USDT BEP20 — 5 USDT, confirmation automatique via Webhook
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={26} color="#fff" />
                </View>
                <View style={styles.autoActivateFooter}>
                  <View style={[styles.autoActivateChip, styles.autoActivateChipCrypto]}>
                    <Ionicons name="flash-outline" size={12} color="#fff" />
                    <Text style={[styles.autoActivateChipText, styles.autoActivateChipTextCrypto]}>Confirmation on-chain</Text>
                  </View>
                  <View style={[styles.autoActivateChip, styles.autoActivateChipCrypto]}>
                    <Ionicons name="shield-checkmark-outline" size={12} color="#fff" />
                    <Text style={[styles.autoActivateChipText, styles.autoActivateChipTextCrypto]}>100% automatique</Text>
                  </View>
                  <View style={[styles.autoActivateChip, styles.autoActivateChipCrypto]}>
                    <Ionicons name="logo-bitcoin" size={12} color="#fff" />
                    <Text style={[styles.autoActivateChipText, styles.autoActivateChipTextCrypto]}>5 USDT (BEP20)</Text>
                  </View>
                </View>
              </TouchableOpacity>
            )}

            {/* AUTO-ACTIVATION CRYPTO via BizTransPay — extra provider added
                2026-08-16. Non-destructive: displayed in addition to the
                existing crypto_auto (IziChange) banner so the user has both
                options. Rendered ONLY when the admin has enabled BizTransPay
                and set an API key (`/payments/biztranspay/public/status`). */}
            {btpEnabled && (
            <TouchableOpacity
              style={[styles.autoActivateBtn, { backgroundColor: "#0EA5E9" }]}
              onPress={() => router.push("/(app)/activation-biztranspay" as any)}
              testID="btn-biztranspay-activation"
              activeOpacity={0.85}
            >
              <View style={styles.autoActivateHeader}>
                <View style={[styles.autoActivateIcon, { backgroundColor: "rgba(255,255,255,0.18)" }]}>
                  <Ionicons name="diamond" size={26} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.autoActivateTitle}>💎 AUTO-ACTIVATION USDT (BizTransPay)</Text>
                  <Text style={styles.autoActivateSub}>
                    USDT BEP20 — 5 USDT, confirmation automatique par polling
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={26} color="#fff" />
              </View>
              <View style={styles.autoActivateFooter}>
                <View style={[styles.autoActivateChip, { backgroundColor: "rgba(255,255,255,0.18)", borderColor: "rgba(255,255,255,0.28)" }]}>
                  <Ionicons name="qr-code-outline" size={12} color="#fff" />
                  <Text style={[styles.autoActivateChipText, { color: "#fff" }]}>QR + Adresse</Text>
                </View>
                <View style={[styles.autoActivateChip, { backgroundColor: "rgba(255,255,255,0.18)", borderColor: "rgba(255,255,255,0.28)" }]}>
                  <Ionicons name="pulse-outline" size={12} color="#fff" />
                  <Text style={[styles.autoActivateChipText, { color: "#fff" }]}>Polling 15s</Text>
                </View>
                <View style={[styles.autoActivateChip, { backgroundColor: "rgba(255,255,255,0.18)", borderColor: "rgba(255,255,255,0.28)" }]}>
                  <Ionicons name="diamond-outline" size={12} color="#fff" />
                  <Text style={[styles.autoActivateChipText, { color: "#fff" }]}>5 USDT (BEP20)</Text>
                </View>
              </View>
            </TouchableOpacity>
            )}
          </Card>
        )}

        {paymentMode === "soleas" && soleasEnabled && (
          <Card style={{ marginTop: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={styles.mfBadge}>
                <Ionicons name="flash" size={14} color="#fff" />
                <Text style={styles.mfBadgeText}>INSTANTANÉ</Text>
              </View>
              <Text style={styles.section}>Paiement Automatique</Text>
            </View>
            <Text style={styles.helper}>
              Vous recevrez une notification de paiement directement sur votre téléphone Mobile Money.
              Confirmez avec votre code secret, et votre niveau s'active automatiquement.
            </Text>

            {!soleasOrderId ? (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.lblSmall}>Pays</Text>
                <View style={styles.opGrid}>
                  {soleasCountries
                    .filter((c) => !SOLEAS_EXCLUDED.includes(c))
                    .map((c) => (
                      <TouchableOpacity
                        key={c}
                        style={[styles.opChip, soleasCountry === c && styles.opChipOn]}
                        onPress={() => { setSoleasCountry(c); setSoleasServiceId(null); }}
                        testID={`soleas-country-${c}`}
                      >
                        <Text style={[styles.opText, soleasCountry === c && { color: "#fff" }]}>{c}</Text>
                      </TouchableOpacity>
                    ))}
                </View>

                <Text style={styles.lblSmall}>Opérateur Mobile Money</Text>
                <View style={styles.opGrid}>
                  {(soleasServices[soleasCountry] || []).map((s: any) => (
                    <TouchableOpacity
                      key={s.id}
                      style={[styles.opChip, soleasServiceId === s.id && styles.opChipOn]}
                      onPress={() => setSoleasServiceId(s.id)}
                      testID={`soleas-service-${s.id}`}
                    >
                      <Text style={[styles.opText, soleasServiceId === s.id && { color: "#fff" }]}>{s.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.lblSmall}>Numéro Mobile Money</Text>
                <TextInput
                  style={styles.input}
                  value={soleasPhone}
                  onChangeText={(v) => {
                    setSoleasPhone(v);
                    const cc = detectCountryFromPhone(v);
                    if (cc && soleasCountries.includes(cc) && !SOLEAS_EXCLUDED.includes(cc)) {
                      setSoleasCountry(cc);
                    }
                  }}
                  placeholder="Ex: +228 90 00 00 00"
                  placeholderTextColor={theme.colors.textSecondary}
                  keyboardType="phone-pad"
                  testID="soleas-phone"
                />

                <View style={{ marginTop: 14 }}>
                  <Button
                    title={soleasSubmitting ? "ENVOI…" : "📱 ENVOYER LA DEMANDE"}
                    icon={<Ionicons name="send" size={18} color="#fff" />}
                    loading={soleasSubmitting}
                    disabled={soleasSubmitting || !soleasServiceId || !soleasPhone}
                    onPress={async () => {
                      if (!soleasServiceId) {
                        Alert.alert("Erreur", "Choisissez un opérateur");
                        return;
                      }
                      setSoleasSubmitting(true);
                      try {
                        const targetLevel = (user?.max_level || 0) + 1;
                        const res = await api.post<any>("/payments/soleaspay/initiate", {
                          level: targetLevel,
                          phone: soleasPhone,
                          country_code: soleasCountry,
                          service_id: soleasServiceId,
                        });
                        setSoleasOrderId(res.order_id);
                        setSoleasStatus("pending");
                        setSoleasMessage(res.message || "Vérifiez votre téléphone pour confirmer le paiement");
                      } catch (e: any) {
                        Alert.alert("Erreur", e?.detail || "Impossible de démarrer le paiement.");
                      } finally {
                        setSoleasSubmitting(false);
                      }
                    }}
                    testID="soleas-submit"
                  />
                </View>
              </View>
            ) : (
              <SoleasPollingView
                orderId={soleasOrderId}
                initialMessage={soleasMessage}
                onActivated={() => {
                  // Refresh user context so /services sees the new max_level
                  refresh?.().catch(() => {});
                  router.replace("/services");
                }}
                onFailed={(err) => {
                  setSoleasOrderId(null);
                  setSoleasStatus("");
                  if (typeof window !== "undefined") window.alert(`❌ Paiement échoué : ${err}`);
                }}
                onCancel={() => { setSoleasOrderId(null); setSoleasStatus(""); }}
              />
            )}
          </Card>
        )}

        {paymentMode === "auto" && secureUIEnabled && (
        <Card style={{ marginTop: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={styles.mfBadge}>
              <Ionicons name="flash" size={14} color="#fff" />
              <Text style={styles.mfBadgeText}>RAPIDE</Text>
            </View>
            <Text style={styles.section}>Paiement sécurisé Mobile Money</Text>
          </View>
          <Text style={styles.helper}>
            Plateforme d'affiliation sécurisée. Payez via votre opérateur Mobile Money et votre niveau sera activé automatiquement.
          </Text>

          <View style={{ marginTop: 14 }}>
            <Text style={styles.lblSmall}>Pays</Text>
            <View style={styles.opGrid}>
              {Object.keys(OPERATORS_BY_COUNTRY).map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[styles.opChip, country === c && styles.opChipOn]}
                  onPress={() => setCountry(c)}
                  testID={`country-${c}`}
                >
                  <Text style={[styles.opText, country === c && { color: "#fff" }]}>{c}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.lblSmall}>Opérateur Mobile Money</Text>
            <View style={styles.opGrid}>
              {operators.map((op) => (
                <TouchableOpacity
                  key={op}
                  style={[styles.opChip, operator === op && styles.opChipOn]}
                  onPress={() => setOperator(op)}
                  testID={`operator-${op}`}
                >
                  <Text style={[styles.opText, operator === op && { color: "#fff" }]}>{op}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.lblSmall}>Nom du payeur</Text>
            <TextInput
              style={styles.input}
              value={payerName}
              onChangeText={setPayerName}
              placeholder="Ex: Jean Kossi"
              placeholderTextColor={theme.colors.textSecondary}
              autoCapitalize="words"
              testID="pay-name"
            />
            <Text style={styles.lblSmall}>Numéro Mobile Money</Text>
            <TextInput
              style={styles.input}
              value={payerPhone}
              onChangeText={setPayerPhone}
              placeholder="Ex: 22890000000"
              placeholderTextColor={theme.colors.textSecondary}
              keyboardType="phone-pad"
              testID="pay-phone"
            />
            <Text style={styles.hint}>
              Le numéro qui recevra l'invite Mobile Money (USSD ou SMS) pour confirmer.
            </Text>

            {otpRequired && (
              <View style={styles.otpBox}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Ionicons name="key" size={16} color={theme.colors.primary} />
                  <Text style={styles.otpTitle}>Code OTP requis</Text>
                </View>
                {ussdCode ? (
                  <Text style={styles.otpHint}>Composez <Text style={{ fontWeight: "800" }}>{ussdCode}</Text> sur votre téléphone pour recevoir votre OTP.</Text>
                ) : (
                  <Text style={styles.otpHint}>Vous avez reçu un SMS contenant votre code OTP.</Text>
                )}
                <TextInput
                  style={styles.input}
                  value={otp}
                  onChangeText={setOtp}
                  placeholder="Ex: 123456"
                  placeholderTextColor={theme.colors.textSecondary}
                  keyboardType="number-pad"
                  maxLength={8}
                  testID="pay-otp"
                />
              </View>
            )}
          </View>

          <View style={{ marginTop: 16 }}>
            <Button
              title={otpRequired ? "CONFIRMER AVEC OTP" : `PAYER ${formatFCFA(amount)}`}
              icon={<Ionicons name={otpRequired ? "key" : "card"} size={18} color="#fff" />}
              onPress={startPayment}
              loading={submitting}
              disabled={!canPay}
              testID="pay-submit"
            />
            <Text style={styles.notice}>
              🔒 Paiement sécurisé. Plateforme d'affiliation Spiloveure.
            </Text>
          </View>
        </Card>
        )}

        {paymentMode === "manual" && manualEnabled && manualCfg?.enabled && manualAvailable && (
          <>
            {true && (
              <Card style={{ marginTop: 12 }}>
                <Text style={styles.section}>{manualCfg.title || "Paiement manuel"}</Text>
                {manualCfg.instructions ? (
                  <Text style={[styles.helper, { whiteSpace: "pre-wrap" as any }]}>
                    {manualCfg.instructions}
                  </Text>
                ) : null}

                <Text style={styles.lblSmall}>Pays</Text>
                <View style={styles.opGrid}>
                  {(manualCfg.allowed_countries.length > 0
                    ? manualCfg.allowed_countries
                    : Object.keys(OPERATORS_BY_COUNTRY)
                  ).map((c) => {
                    const label = COUNTRY_LABELS[c];
                    return (
                      <TouchableOpacity
                        key={c}
                        style={[styles.opChip, manualCountry === c && styles.opChipOn]}
                        onPress={() => setManualCountry(c)}
                        testID={`manual-country-${c}`}
                      >
                        <Text style={[styles.opText, manualCountry === c && { color: "#fff" }]}>
                          {label ? `${label.flag} ${label.name}` : c}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={styles.lblSmall}>Opérateur Mobile Money</Text>
                <View style={styles.opGrid}>
                  {(OPERATORS_BY_COUNTRY[manualCountry] || []).map((op) => (
                    <TouchableOpacity
                      key={op}
                      style={[styles.opChip, manualOperator === op && styles.opChipOn]}
                      onPress={() => setManualOperator(op)}
                      testID={`manual-operator-${op}`}
                    >
                      <Text style={[styles.opText, manualOperator === op && { color: "#fff" }]}>{op}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.lblSmall}>Numéro de téléphone (Mobile Money)</Text>
                <TextInput
                  style={styles.input}
                  value={manualPhone}
                  onChangeText={setManualPhone}
                  placeholder="Ex: 22890000000"
                  placeholderTextColor={theme.colors.textSecondary}
                  keyboardType="phone-pad"
                  testID="manual-phone"
                />

                <View style={[styles.amountBox, { marginTop: 12 }]}>
                  <Text style={styles.amountLabel}>Montant à payer</Text>
                  <Text style={styles.amount}>{formatFCFA(amount)}</Text>
                  <Text style={styles.amountHint}>Montant fixé — non modifiable</Text>
                </View>

                <View style={{ marginTop: 14 }}>
                  <Button
                    title={`PAYER ${formatFCFA(amount)}`}
                    icon={<Ionicons name="card" size={18} color="#fff" />}
                    onPress={submitManualPayment}
                    loading={manualSubmitting}
                    disabled={manualSubmitting || !manualCountry || !manualOperator || manualPhone.trim().length < 8}
                    testID="manual-pay-submit"
                  />
                  <Text style={[styles.hint, { marginTop: 10 }]}>
                    Après votre clic, votre demande sera enregistrée dans l'admin panel puis vous serez redirigé vers le lien de paiement.
                  </Text>
                </View>
              </Card>
            )}
          </>
        )}

        {paymentMode === "crypto" && cryptoEnabled && cryptoCfg && (
          <Card style={{ marginTop: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons name="logo-bitcoin" size={22} color="#F59E0B" />
              <Text style={styles.section}>Paiement Manuel Crypto</Text>
            </View>
            {cryptoCfg.instructions ? (
              <Text style={[styles.helper, { whiteSpace: "pre-wrap" as any }]}>
                {cryptoCfg.instructions}
              </Text>
            ) : null}

            <View style={styles.amountBox}>
              <Text style={styles.amountLabel}>Réseau</Text>
              <Text style={[styles.rowVal, { fontSize: 16 }]}>{cryptoCfg.network}</Text>
              <Text style={[styles.amountLabel, { marginTop: 10 }]}>Adresse wallet</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text selectable style={[styles.rowVal, { flex: 1, fontFamily: "monospace", fontSize: 12 }]}>
                  {cryptoCfg.wallet_address}
                </Text>
                <TouchableOpacity
                  style={styles.copyBtn}
                  onPress={() => {
                    if (typeof navigator !== "undefined" && (navigator as any).clipboard) {
                      (navigator as any).clipboard.writeText(cryptoCfg.wallet_address);
                      if (typeof window !== "undefined") window.alert("Adresse copiée ✅");
                    }
                  }}
                  testID="crypto-copy-wallet"
                >
                  <Ionicons name="copy" size={16} color="#fff" />
                </TouchableOpacity>
              </View>
              <Text style={[styles.amountLabel, { marginTop: 10 }]}>Montant à envoyer</Text>
              <Text style={styles.amount}>{cryptoCfg.amount_usdt} USDT</Text>
              <Text style={styles.amountHint}>Montant fixé — équivalent à 2 500 FCFA</Text>
            </View>

            <Text style={styles.lblSmall}>Hash de transaction (TXID)</Text>
            <TextInput
              style={styles.input}
              value={cryptoTxHash}
              onChangeText={setCryptoTxHash}
              placeholder="0x..."
              placeholderTextColor={theme.colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              testID="crypto-tx-hash"
            />
            <Text style={styles.hint}>Collez ici le hash de votre transaction USDT BEP20 après l'envoi.</Text>

            <View style={{ marginTop: 14 }}>
              <Button
                title={`SOUMETTRE LA TRANSACTION (${cryptoCfg.amount_usdt} USDT)`}
                icon={<Ionicons name="logo-bitcoin" size={18} color="#fff" />}
                onPress={async () => {
                  if (cryptoTxHash.trim().length < 8) {
                    Alert.alert("Hash invalide", "Le hash TXID est trop court. Vérifiez votre transaction.");
                    return;
                  }
                  setCryptoSubmitting(true);
                  try {
                    await api.post<{ ok: boolean }>("/activations/crypto-request", {
                      country: user?.country || "TG",
                      tx_hash: cryptoTxHash.trim(),
                    });
                    if (typeof window !== "undefined") {
                      window.alert("Demande enregistrée ✅ L'administrateur va vérifier votre transaction. Vous serez activé sous 24h.");
                    } else {
                      Alert.alert("Demande enregistrée", "L'administrateur va vérifier votre transaction.");
                    }
                    setCryptoTxHash("");
                  } catch (e: any) {
                    Alert.alert("Erreur", e?.detail || "Soumission impossible.");
                  } finally {
                    setCryptoSubmitting(false);
                  }
                }}
                loading={cryptoSubmitting}
                disabled={cryptoSubmitting || cryptoTxHash.trim().length < 8}
                testID="crypto-submit"
              />
              <Text style={[styles.hint, { marginTop: 10 }]}>
                Après vérification du hash par l'administrateur, votre compte sera activé.
              </Text>
            </View>
          </Card>
        )}

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Comment ça fonctionne ?</Text>
          <Step n={1} label="Saisie" desc="Choisissez votre pays, opérateur et saisissez votre numéro." />
          <Step n={2} label="Paiement" desc="Confirmez l'invite USSD ou OTP sur votre téléphone." />
          <Step n={3} label="Activation" desc="Votre niveau est activé automatiquement dès confirmation." />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value, icon }: { label: string; value: string; icon: any }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}><Ionicons name={icon} size={16} color={theme.colors.primary} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLbl}>{label}</Text>
        <Text style={styles.rowVal}>{value}</Text>
      </View>
    </View>
  );
}

function Step({ n, label, desc }: { n: number; label: string; desc: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepN}><Text style={styles.stepNT}>{n}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepLbl}>{label}</Text>
        <Text style={styles.stepDesc}>{desc}</Text>
      </View>
    </View>
  );
}

function SoleasPollingView({
  orderId, initialMessage, onActivated, onFailed, onCancel,
}: {
  orderId: string;
  initialMessage: string;
  onActivated: () => void;
  onFailed: (err: string) => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<string>("pending");
  const [message, setMessage] = useState<string>(initialMessage);
  const [tick, setTick] = useState(0);
  const [activatedLevel, setActivatedLevel] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number>(3);

  useEffect(() => {
    let stopped = false;
    let attempts = 0;
    const poll = async () => {
      while (!stopped && attempts < 60) {  // ~5 min max (60 x 5s)
        attempts++;
        setTick(attempts);
        try {
          const r = await api.get<any>(`/payments/soleaspay/status/${orderId}`);
          if (r.status === "paid" && r.activation_done) {
            if (!stopped) {
              setStatus("activated");
              setActivatedLevel(r.level);
            }
            return;
          }
          if (r.status === "failed") {
            if (!stopped) onFailed(r.error || "Échec");
            return;
          }
          if (r.message) setMessage(r.message);
        } catch {}
        await new Promise((res) => setTimeout(res, 5000));
      }
      if (!stopped) setMessage("⏱ Délai d'attente dépassé. Réessayez ou utilisez un autre moyen de paiement.");
    };
    poll();
    return () => { stopped = true; };
  }, [orderId, onFailed]);

  // Once activated → countdown then auto-redirect
  useEffect(() => {
    if (status !== "activated") return;
    if (countdown <= 0) {
      onActivated();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [status, countdown, onActivated]);

  if (status === "activated") {
    return (
      <View
        style={{
          marginTop: 16, padding: 18, borderRadius: 16,
          backgroundColor: theme.colors.successBg || "#D1FAE5",
          borderLeftWidth: 4, borderLeftColor: theme.colors.success,
          alignItems: "center",
        }}
        testID="soleas-activated"
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Ionicons name="checkmark-circle" size={32} color={theme.colors.success} />
          <Text style={{ color: theme.colors.success, fontWeight: "900", fontSize: 18 }}>
            🎉 Mon compte est activé !
          </Text>
        </View>
        <Text style={{ color: theme.colors.textPrimary, marginTop: 8, fontSize: 13, textAlign: "center" }}>
          Niveau {activatedLevel} activé avec succès. Vous avez maintenant accès aux fonctionnalités réservées aux comptes actifs.
        </Text>
        <TouchableOpacity
          style={{
            marginTop: 16, paddingVertical: 13, paddingHorizontal: 24, borderRadius: 22,
            backgroundColor: theme.colors.success, flexDirection: "row", alignItems: "center", gap: 8,
          }}
          onPress={onActivated}
          testID="soleas-go-services"
        >
          <Ionicons name="rocket" size={18} color="#fff" />
          <Text style={{ color: "#fff", fontWeight: "800", fontSize: 14 }}>
            Accéder à mon espace ({countdown}s)
          </Text>
        </TouchableOpacity>
        <Text style={{ color: theme.colors.textSecondary, marginTop: 8, fontSize: 11, fontStyle: "italic" }}>
          Redirection automatique dans {countdown} seconde{countdown > 1 ? "s" : ""}…
        </Text>
      </View>
    );
  }

  return (
    <View style={{ marginTop: 16, padding: 14, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary, borderLeftWidth: 4, borderLeftColor: theme.colors.primary }} testID="soleas-polling">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Ionicons name="phone-portrait" size={24} color={theme.colors.primary} />
        <Text style={{ color: theme.colors.textPrimary, fontWeight: "800", fontSize: 14, flex: 1 }}>
          📱 Vérifiez votre téléphone
        </Text>
      </View>
      <Text style={{ color: theme.colors.textSecondary, marginTop: 8, fontSize: 12, lineHeight: 17 }}>
        {message}
      </Text>
      <Text style={{ color: theme.colors.textSecondary, marginTop: 8, fontSize: 11, fontStyle: "italic" }}>
        Vérification automatique en cours… ({tick}/60)
      </Text>
      <TouchableOpacity
        style={{ marginTop: 12, paddingVertical: 10, borderRadius: 16, alignItems: "center", borderWidth: 1, borderColor: theme.colors.border }}
        onPress={onCancel}
        testID="soleas-cancel"
      >
        <Text style={{ color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 }}>Annuler</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 20, paddingTop: 24 },
  brand: { color: "#fff", fontWeight: "800", letterSpacing: 2 },
  brandSub: { color: "#A5C2FF", fontSize: 9, letterSpacing: 2 },
  title: { color: "#fff", fontSize: 20, fontWeight: "700", marginTop: 16, letterSpacing: -0.3 },
  sub: { color: "#C7D9FF", marginTop: 4 },
  section: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 6, fontSize: 16 },
  helper: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 4, lineHeight: 18 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  rowIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: "#DBEAFE", alignItems: "center", justifyContent: "center" },
  rowLbl: { color: theme.colors.textSecondary, fontSize: 12 },
  rowVal: { color: theme.colors.textPrimary, fontWeight: "600" },
  lvlBadge: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#DBEAFE", paddingVertical: 6, paddingHorizontal: 10, borderRadius: 14, alignSelf: "flex-start",
  },
  lvlText: { color: theme.colors.primary, fontWeight: "700" },
  amountBox: { marginTop: 12, padding: 16, backgroundColor: theme.colors.surfaceSecondary, borderRadius: 20 },
  amountLabel: { color: theme.colors.textSecondary, fontSize: 12 },
  amount: { color: theme.colors.primary, fontSize: 26, fontWeight: "800", letterSpacing: -0.5 },
  amountHint: { color: theme.colors.textSecondary, fontSize: 11 },
  detail: { color: theme.colors.textSecondary, fontSize: 12 },
  mfBadge: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#10B981", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  mfBadgeText: { color: "#fff", fontWeight: "800", fontSize: 9, letterSpacing: 1 },
  opGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4, marginBottom: 4 },
  opChip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  opChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  opText: { color: theme.colors.textPrimary, fontWeight: "600", fontSize: 12 },
  lblSmall: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 10, marginBottom: 4 },
  input: { backgroundColor: theme.colors.surfaceSecondary, padding: 12, borderRadius: 14, color: theme.colors.textPrimary, fontSize: 14 },
  hint: { color: theme.colors.textSecondary, fontSize: 11, fontStyle: "italic", marginTop: 4 },
  notice: { textAlign: "center", color: theme.colors.textSecondary, fontSize: 11, marginTop: 8 },
  otpBox: { marginTop: 14, padding: 12, backgroundColor: "#EFF6FF", borderRadius: 14, borderWidth: 1, borderColor: "#BFDBFE" },
  otpTitle: { color: theme.colors.primary, fontWeight: "800", fontSize: 13 },
  otpHint: { color: theme.colors.textPrimary, fontSize: 12, marginTop: 6, marginBottom: 8 },
  altLink: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 14, paddingVertical: 6 },
  altLinkText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: "600" },
  step: { flexDirection: "row", gap: 12, marginTop: 8, alignItems: "flex-start" },
  stepN: { width: 28, height: 28, borderRadius: 16, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },
  stepNT: { color: "#fff", fontWeight: "800" },
  stepLbl: { fontWeight: "700", color: theme.colors.textPrimary },
  stepDesc: { color: theme.colors.textSecondary, fontSize: 12 },

  modesCol: { gap: 8, marginTop: 8 },
  modeCard: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: 12, borderRadius: 16, backgroundColor: theme.colors.surfaceSecondary,
    borderWidth: 2, borderColor: "transparent",
  },
  modeCardOn: { borderColor: theme.colors.primary, backgroundColor: "#EFF6FF" },
  modeCardOff: { opacity: 0.5 },
  modeIcon: {
    width: 40, height: 40, borderRadius: 14,
    backgroundColor: theme.colors.primary,
    alignItems: "center", justifyContent: "center",
  },
  modeTitle: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 13 },
  modeBody: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2, lineHeight: 15 },
  copyBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: theme.colors.primary },

  // AUTO-ACTIVATION priority CTA (Ashtech Pay)
  autoActivateBtn: {
    marginTop: 8,
    padding: 16,
    borderRadius: 22,
    backgroundColor: "#0F172A",
    borderWidth: 2,
    borderColor: "#F59E0B",
    shadowColor: "#F59E0B",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 8,
  },
  autoActivateHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  autoActivateIcon: {
    width: 48, height: 48, borderRadius: 16,
    backgroundColor: "#F59E0B",
    alignItems: "center", justifyContent: "center",
  },
  autoActivateTitle: { color: "#fff", fontWeight: "700", fontSize: 16, letterSpacing: 0.3 },
  autoActivateSub: { color: "#E2E8F0", fontSize: 12, marginTop: 2 },
  autoActivateFooter: {
    marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 8,
  },
  autoActivateChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(245, 158, 11, 0.18)",
    borderWidth: 1, borderColor: "rgba(245, 158, 11, 0.5)",
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 24,
  },
  autoActivateChipText: { color: "#FBBF24", fontSize: 11, fontWeight: "700" },
  // Harmonised variant for the Crypto Auto-activation banner — same
  // dimensions, radius, spacing and layout as the Ashtech banner, only
  // the accent colour differs (violet crypto vibe instead of gold).
  autoActivateBtnCrypto: {
    borderColor: "#7B61FF",
    shadowColor: "#7B61FF",
    marginTop: 12,
  },
  autoActivateIconCrypto: {
    backgroundColor: "#7B61FF",
  },
  autoActivateChipCrypto: {
    backgroundColor: "rgba(123, 97, 255, 0.18)",
    borderColor: "rgba(123, 97, 255, 0.5)",
  },
  autoActivateChipTextCrypto: {
    color: "#C4B5FD",
  },
});
