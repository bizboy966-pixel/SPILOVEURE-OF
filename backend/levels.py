"""SPILIVERE 12-level configuration.

Each level defines:
- name: French label
- price: activation cost in FCFA
- invites_required: how many people must come into this level's matrix for full completion
- commission_per_invite: FCFA earned per matrix slot filled
- total_gain: invites_required * commission_per_invite
- upgrade_reserve: FCFA locked aside to fund the next level's activation
- profit: total_gain - upgrade_reserve (withdrawable)
- platform_fee: only Level 1 has a platform fee (cash entry); others are funded by the previous level's upgrade_reserve.
"""

LEVELS = [
    {"level": 1, "name": "Débutant", "price": 2500, "platform_fee": 500,
     "invites_required": 2, "commission_per_invite": 2000,
     "total_gain": 4000, "upgrade_reserve": 1000, "profit": 3000},
    {"level": 2, "name": "Influenceur", "price": 1000, "platform_fee": 0,
     "invites_required": 4, "commission_per_invite": 1000,
     "total_gain": 4000, "upgrade_reserve": 2000, "profit": 2000},
    {"level": 3, "name": "Archiveur", "price": 2000, "platform_fee": 0,
     "invites_required": 8, "commission_per_invite": 2000,
     "total_gain": 16000, "upgrade_reserve": 4000, "profit": 12000},
    {"level": 4, "name": "Ambassadeur", "price": 4000, "platform_fee": 0,
     "invites_required": 16, "commission_per_invite": 4000,
     "total_gain": 64000, "upgrade_reserve": 8000, "profit": 56000},
    {"level": 5, "name": "Pionnier", "price": 8000, "platform_fee": 0,
     "invites_required": 32, "commission_per_invite": 8000,
     "total_gain": 256000, "upgrade_reserve": 16000, "profit": 240000},
    {"level": 6, "name": "Mentor", "price": 16000, "platform_fee": 0,
     "invites_required": 64, "commission_per_invite": 16000,
     "total_gain": 1024000, "upgrade_reserve": 32000, "profit": 992000},
    {"level": 7, "name": "Champion", "price": 32000, "platform_fee": 0,
     "invites_required": 128, "commission_per_invite": 32000,
     "total_gain": 4096000, "upgrade_reserve": 64000, "profit": 4032000},
    {"level": 8, "name": "Directeur", "price": 64000, "platform_fee": 0,
     "invites_required": 256, "commission_per_invite": 64000,
     "total_gain": 16384000, "upgrade_reserve": 128000, "profit": 16256000},
    {"level": 9, "name": "Titan", "price": 128000, "platform_fee": 0,
     "invites_required": 512, "commission_per_invite": 128000,
     "total_gain": 65536000, "upgrade_reserve": 256000, "profit": 65280000},
    {"level": 10, "name": "Icône", "price": 256000, "platform_fee": 0,
     "invites_required": 1024, "commission_per_invite": 256000,
     "total_gain": 262144000, "upgrade_reserve": 512000, "profit": 261632000},
    {"level": 11, "name": "Légende", "price": 512000, "platform_fee": 0,
     "invites_required": 2048, "commission_per_invite": 512000,
     "total_gain": 1048576000, "upgrade_reserve": 1024000, "profit": 1047552000},
    {"level": 12, "name": "Empereur", "price": 1024000, "platform_fee": 0,
     "invites_required": 4096, "commission_per_invite": 1024000,
     "total_gain": 4194304000, "upgrade_reserve": 0, "profit": 4194304000},
]

LEVELS_BY_NUM = {lv["level"]: lv for lv in LEVELS}

COUNTRIES = [
    # === Afrique de l'Ouest francophone (existants — Mobile Money supporté) ===
    {"code": "BJ", "name": "Bénin", "dial": "+229", "flag": "🇧🇯"},
    {"code": "BF", "name": "Burkina Faso", "dial": "+226", "flag": "🇧🇫"},
    {"code": "CI", "name": "Côte d'Ivoire", "dial": "+225", "flag": "🇨🇮"},
    {"code": "GH", "name": "Ghana", "dial": "+233", "flag": "🇬🇭"},
    {"code": "GN", "name": "Guinée", "dial": "+224", "flag": "🇬🇳"},
    {"code": "GW", "name": "Guinée-Bissau", "dial": "+245", "flag": "🇬🇼"},
    {"code": "ML", "name": "Mali", "dial": "+223", "flag": "🇲🇱"},
    {"code": "NE", "name": "Niger", "dial": "+227", "flag": "🇳🇪"},
    {"code": "NG", "name": "Nigeria", "dial": "+234", "flag": "🇳🇬"},
    {"code": "SN", "name": "Sénégal", "dial": "+221", "flag": "🇸🇳"},
    {"code": "TG", "name": "Togo", "dial": "+228", "flag": "🇹🇬"},
    {"code": "CM", "name": "Cameroun", "dial": "+237", "flag": "🇨🇲"},
    # === Afrique Centrale / Australe ===
    {"code": "CD", "name": "RD Congo", "dial": "+243", "flag": "🇨🇩"},
    {"code": "CG", "name": "Congo-Brazzaville", "dial": "+242", "flag": "🇨🇬"},
    {"code": "GA", "name": "Gabon", "dial": "+241", "flag": "🇬🇦"},
    {"code": "CF", "name": "Centrafrique", "dial": "+236", "flag": "🇨🇫"},
    {"code": "TD", "name": "Tchad", "dial": "+235", "flag": "🇹🇩"},
    {"code": "AO", "name": "Angola", "dial": "+244", "flag": "🇦🇴"},
    {"code": "MZ", "name": "Mozambique", "dial": "+258", "flag": "🇲🇿"},
    # === Afrique de l'Est ===
    {"code": "KE", "name": "Kenya", "dial": "+254", "flag": "🇰🇪"},
    {"code": "UG", "name": "Ouganda", "dial": "+256", "flag": "🇺🇬"},
    {"code": "RW", "name": "Rwanda", "dial": "+250", "flag": "🇷🇼"},
    {"code": "TZ", "name": "Tanzanie", "dial": "+255", "flag": "🇹🇿"},
    # === Afrique du Nord & Sud ===
    {"code": "EG", "name": "Égypte", "dial": "+20", "flag": "🇪🇬"},
    {"code": "ZA", "name": "Afrique du Sud", "dial": "+27", "flag": "🇿🇦"},
    {"code": "MR", "name": "Mauritanie", "dial": "+222", "flag": "🇲🇷"},
    # === Autres Afrique ===
    {"code": "LR", "name": "Libéria", "dial": "+231", "flag": "🇱🇷"},
    {"code": "SL", "name": "Sierra Leone", "dial": "+232", "flag": "🇸🇱"},
    {"code": "GM", "name": "Gambie", "dial": "+220", "flag": "🇬🇲"},
    {"code": "BW", "name": "Botswana", "dial": "+267", "flag": "🇧🇼"},
    {"code": "NA", "name": "Namibie", "dial": "+264", "flag": "🇳🇦"},
    {"code": "ZM", "name": "Zambie", "dial": "+260", "flag": "🇿🇲"},
    {"code": "ZW", "name": "Zimbabwe", "dial": "+263", "flag": "🇿🇼"},
    {"code": "MG", "name": "Madagascar", "dial": "+261", "flag": "🇲🇬"},
    {"code": "MU", "name": "Maurice", "dial": "+230", "flag": "🇲🇺"},
    # === Europe ===
    {"code": "FR", "name": "France", "dial": "+33", "flag": "🇫🇷"},
    {"code": "BE", "name": "Belgique", "dial": "+32", "flag": "🇧🇪"},
    {"code": "CH", "name": "Suisse", "dial": "+41", "flag": "🇨🇭"},
    {"code": "DE", "name": "Allemagne", "dial": "+49", "flag": "🇩🇪"},
    {"code": "IT", "name": "Italie", "dial": "+39", "flag": "🇮🇹"},
    {"code": "ES", "name": "Espagne", "dial": "+34", "flag": "🇪🇸"},
    {"code": "PT", "name": "Portugal", "dial": "+351", "flag": "🇵🇹"},
    {"code": "GB", "name": "Royaume-Uni", "dial": "+44", "flag": "🇬🇧"},
    {"code": "NL", "name": "Pays-Bas", "dial": "+31", "flag": "🇳🇱"},
    # === Amériques ===
    {"code": "CA", "name": "Canada", "dial": "+1", "flag": "🇨🇦"},
    {"code": "US", "name": "États-Unis", "dial": "+1", "flag": "🇺🇸"},
    {"code": "BR", "name": "Brésil", "dial": "+55", "flag": "🇧🇷"},
    {"code": "MX", "name": "Mexique", "dial": "+52", "flag": "🇲🇽"},
    {"code": "HT", "name": "Haïti", "dial": "+509", "flag": "🇭🇹"},
    # === Moyen-Orient ===
    {"code": "AE", "name": "Émirats Arabes Unis", "dial": "+971", "flag": "🇦🇪"},
    {"code": "QA", "name": "Qatar", "dial": "+974", "flag": "🇶🇦"},
    {"code": "SA", "name": "Arabie Saoudite", "dial": "+966", "flag": "🇸🇦"},
    # === Asie ===
    {"code": "IN", "name": "Inde", "dial": "+91", "flag": "🇮🇳"},
    {"code": "PK", "name": "Pakistan", "dial": "+92", "flag": "🇵🇰"},
    {"code": "BD", "name": "Bangladesh", "dial": "+880", "flag": "🇧🇩"},
    {"code": "MY", "name": "Malaisie", "dial": "+60", "flag": "🇲🇾"},
    {"code": "SG", "name": "Singapour", "dial": "+65", "flag": "🇸🇬"},
    {"code": "PH", "name": "Philippines", "dial": "+63", "flag": "🇵🇭"},
    # === Océanie ===
    {"code": "AU", "name": "Australie", "dial": "+61", "flag": "🇦🇺"},
    {"code": "NZ", "name": "Nouvelle-Zélande", "dial": "+64", "flag": "🇳🇿"},
]

OPERATORS_BY_COUNTRY = {
    "TG": ["Mixx By Yas", "Moov Money"],
    "BJ": ["MTN Mobile Money", "Moov Money"],
    "CI": ["Orange Money", "MTN Mobile Money", "Moov Money", "Wave"],
    "BF": ["Orange Money", "Moov Money"],
    "SN": ["Orange Money", "Free Money", "Wave"],
    "ML": ["Orange Money", "Moov Money"],
    "NE": ["Orange Money", "Moov Money"],
    "GH": ["MTN Mobile Money", "Vodafone Cash"],
    "GN": ["Orange Money", "MTN Mobile Money"],
    "GW": ["Orange Money"],
    "NG": ["Opay", "PalmPay"],
    "CM": ["Orange Money", "MTN Mobile Money"],
}
