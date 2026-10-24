import type { ActuatorApp } from "./actuator";

// What exploration will never touch. This is a fail-closed screen, not a classifier: an item or app that MIGHT involve credentials,
// money, messages, sign-in, deletion or the owner's microphone/camera is simply not opened. Missing a safe one costs a capability;
// opening a risky one costs the owner something. (It is deliberately blunt: it matches words, in the languages Agentlas ships in.)

// Apps that are about secrets, security, the OS itself, or that hold the owner's accounts. Matched on bundle id prefix or on the name.
const SENSITIVE_BUNDLE_PREFIXES = [
  "com.apple.keychainaccess", "com.apple.systempreferences", "com.apple.systemsettings", "com.apple.Passwords", "com.apple.ScreenSharing",
  "com.apple.finder", "com.apple.Terminal", "com.apple.dt.Xcode", "com.apple.AppStore", "com.apple.Safari", "com.apple.mail", "com.apple.MobileSMS",
  "com.apple.iChat", "com.apple.FaceTime", "com.apple.Wallet", "com.apple.AddressBook", "com.apple.iCal", "com.apple.reminders", "com.apple.Notes",
  "com.apple.Photos", "com.apple.findmy", "com.apple.Home", "com.apple.systemuiserver",
  "com.1password", "com.agilebits", "com.bitwarden", "com.lastpass", "org.keepassxc", "com.dashlane", "com.nordvpn", "com.expressvpn", "ch.protonvpn",
  "com.agentlas", // Agentlas itself: its own screens are operated through typed operations, never through the GUI
  "com.google.Chrome", "org.mozilla.firefox", "com.microsoft.edgemac", "com.brave.Browser", "com.operasoftware", "company.thebrowser", // browsers hold sessions
  "com.openai", "com.anthropic", // assistant apps
  "com.tinyspeck.slackmacgap", "com.hnc.Discord", "ru.keepcoder.Telegram", "net.whatsapp", "jp.naver.line", "com.kakao", "us.zoom", "com.microsoft.teams",
  "com.microsoft.Outlook", "com.microsoft.OneDrive", "com.dropbox", "com.google.drivefs",
];
const SENSITIVE_APP_WORDS = /(password|passwd|keychain|1password|bitwarden|lastpass|keepass|dashlane|vault|wallet|bank|banking|crypto|ledger|trezor|vpn|firewall|antivirus|security|authenticator|otp|ahnlab|ipinside|touchen|nxkey|veraport|crossex|unisign|nprotect|npki|인증서|보안|공인인증|은행|금융|결제|지갑|비밀번호|암호|키체인)/i;

// The same kinds of app on Linux and Windows, where an app has no bundle id: its desktop id or executable name stands in for it (geany,
// org.mozilla.firefox, gnome-terminal). Terminals, browsers, mail and messaging, password managers, file managers, settings and system tools.
const SENSITIVE_DESKTOP_APPS = new RegExp("(^|[^a-z0-9])(" + [
  "terminal", "gnome-terminal", "konsole", "xterm", "uxterm", "lxterminal", "xfce4-terminal", "terminator", "tilix", "alacritty", "kitty", "wezterm", "qterminal", "guake", "yakuake", "powershell", "pwsh", "cmd", "windowsterminal", "command prompt",
  "firefox", "chromium", "chrome", "brave", "vivaldi", "opera", "epiphany", "falkon", "midori", "librewolf", "msedge", "tor-browser",
  "thunderbird", "evolution", "geary", "kmail", "claws-mail", "outlook", "signal", "signal-desktop", "telegram", "telegram-desktop", "discord", "slack", "element", "teams", "zoom", "skype", "whatsapp",
  "keepass", "keepassxc", "bitwarden", "1password", "seahorse", "kwalletmanager", "gnome-keyring",
  "nautilus", "dolphin", "thunar", "pcmanfm", "nemo", "caja", "explorer", "files",
  "gnome-control-center", "systemsettings", "xfce4-settings-manager", "cinnamon-settings", "nm-connection-editor", "dconf-editor", "gparted", "synaptic", "gnome-disks", "regedit", "mmc", "taskmgr", "settings",
  "gnome-calendar", "gnome-contacts", "korganizer", "kaddressbook", "shotwell", "onedrive", "dropbox", "nextcloud",
].map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")([^a-z0-9]|$)", "i");

export function isSensitiveApp(app: Pick<ActuatorApp, "name" | "bundleId">): boolean {
  const bundle = app.bundleId ?? "";
  if (SENSITIVE_BUNDLE_PREFIXES.some((prefix) => bundle === prefix || bundle.startsWith(`${prefix}.`) || bundle.startsWith(prefix))) return true;
  return SENSITIVE_APP_WORDS.test(app.name) || SENSITIVE_APP_WORDS.test(bundle) || SENSITIVE_DESKTOP_APPS.test(app.name) || SENSITIVE_DESKTOP_APPS.test(bundle);
}

// Menu items that are the platform's own features injected into every app (AutoFill, Dictation, Writing Tools, Emoji, Services, Share) or whose
// name says they touch secrets, money, people, accounts, the network, hardware sensors, or destroy things.
const RISKY_WORDS = new RegExp([
  // credentials, payment, identity
  "password", "passcode", "credit", "debit", "card", "payment", "pay\\b", "purchase", "buy", "subscribe", "wallet", "billing", "invoice", "checkout", "account", "sign[ -]?in", "sign[ -]?out", "log[ -]?in", "log[ -]?out", "login", "logout", "autofill", "keychain", "certificate", "token", "api key",
  // messages and people
  "send", "reply", "forward", "share", "invite", "mail", "message", "contact", "address book", "publish", "post\\b", "tweet", "upload", "sync", "backup", "airdrop",
  // sensors and system
  "dictation", "microphone", "camera", "location", "screen record", "capture", "writing tools", "services", "speech", "emoji", "siri", "bluetooth", "wi-?fi", "network",
  // destruction and irreversible
  "delete", "erase", "remove", "trash", "empty", "clear", "reset", "restore", "uninstall", "format", "wipe", "quit", "close all", "force", "shut ?down", "restart", "sleep", "lock",
  // Korean
  "암호", "비밀번호", "신용", "카드", "결제", "구매", "구독", "지갑", "계정", "로그인", "로그아웃", "자동 ?완성", "키체인", "인증서", "토큰", "보내기", "답장", "전달", "공유", "초대", "메일", "메시지", "연락처", "게시", "업로드", "동기화", "백업", "받아쓰기", "마이크", "카메라", "위치", "화면 기록", "작문", "서비스", "음성", "이모지", "블루투스", "네트워크", "삭제", "지우기", "비우기", "휴지통", "제거", "초기화", "복원", "포맷", "종료", "재시동", "잠금", "잠자기", "강제",
  // Japanese / Chinese
  "パスワード", "クレジット", "支払い", "購入", "ログイン", "ログアウト", "送信", "共有", "削除", "ゴミ箱", "回收站", "密码", "支付", "登录", "退出", "发送", "共享", "删除",
  // German / French / Spanish
  "papierkorb", "corbeille", "papelera", "passwort", "kennwort", "kreditkarte", "zahlung", "anmelden", "abmelden", "senden", "teilen", "löschen", "mot de passe", "carte", "paiement", "connexion", "déconnexion", "envoyer", "partager", "supprimer", "contraseña", "tarjeta", "pago", "iniciar sesión", "cerrar sesión", "enviar", "compartir", "eliminar",
].join("|"), "i");

export function isRiskyMenuPath(path: readonly string[]): boolean {
  return path.some((segment) => RISKY_WORDS.test(segment));
}

// A dialog control the explorer may describe. Content areas (lists, outlines, tables, rows, cells, static text) carry the owner's data
// (file names in Open/Save panels, folder names in the sidebar) and are never read into anything that is kept.
export const DIALOG_CONTROL_ROLES: ReadonlySet<string> = new Set([
  "AXTextField", "AXSecureTextField", "AXTextArea", "AXComboBox", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
  "AXSlider", "AXIncrementor", "AXStepper", "AXButton", "AXSegmentedControl", "AXSwitch",
]);

// A menu item that opens a file picker. Such a dialog can only ever be refused (it lists the owner's files), and on Linux it is also the one
// that stalls the app when its accessibility tree is read (measured with the GTK3 file chooser of Mousepad and Geany: the app stopped
// answering and neither Cancel nor Escape closed the dialog). Where that has been measured it is not opened at all. macOS opens and refuses
// them after reading, which is measured to be safe there.
const FILE_PICKER_START = /^(open|save|import|attach|browse|load)\b/i;
const FILE_PICKER_WORDS = /열기|저장|다른 이름|가져오기|불러오기|첨부|찾아보기|開く|保存|名前を付けて|インポート|打开|另存|导入|öffnen|speichern|ouvrir|enregistrer|abrir|guardar/i;
export function opensFilePicker(path: readonly string[]): boolean {
  const last = (path[path.length - 1] ?? "").trim();
  return FILE_PICKER_START.test(last) || FILE_PICKER_WORDS.test(last);
}
