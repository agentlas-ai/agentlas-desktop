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
  // terminals, code runners, IDEs and the system's own tools: a menu command in these runs code or changes disks (independent review 2026-10-24, D6)
  "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp", "com.github.wez.wezterm", "net.kovidgoyal.kitty", "org.alacritty", "co.zeit.hyper", "com.microsoft.VSCode", "com.visualstudio.code", "com.vscodium",
  "com.teamviewer", "com.philandro.anydesk", "com.carriez.rustdesk", "tv.parsec", "com.obsproject", "com.loom", "com.microsoft.rdc", "com.realvnc", "com.splashtop", "com.edovia.screens", "com.p5sys.jump",
  "com.tinyapp.TablePlus", "org.jkiss.dbeaver", "com.sequel-ace", "com.sequelpro", "at.eggerapps", "com.eggerapps", "com.prect", "com.onseven", "com.mongodb", "io.beekeeperstudio", "com.oracle.workbench", "org.pgadmin", "com.azuredatastudio", "com.microsoft.azuredatastudio", "com.araeliumgroup", "com.hankinsoft", "com.apple.VoiceMemos",
  "com.todesktop", "com.jetbrains", "dev.zed", "org.tabby", "com.tabby", "com.termius", "com.naver.Whale", "com.duckduckgo", "com.kagi", "app.zen-browser", "com.cisco", "Cisco-Systems.Spark", "com.webex", "com.apple.QuickTimePlayerX", "com.apple.PhotoBooth", "com.sublimetext", "com.sublimehq", "com.panic.Nova", "com.apple.ScriptEditor", "com.apple.Automator", "com.apple.shortcuts", "com.apple.DiskUtility", "com.apple.ActivityMonitor", "com.apple.Console",
  "com.tinyspeck.slackmacgap", "com.hnc.Discord", "ru.keepcoder.Telegram", "net.whatsapp", "jp.naver.line", "com.kakao", "us.zoom", "com.microsoft.teams",
  "com.microsoft.Outlook", "com.microsoft.OneDrive", "com.dropbox", "com.google.drivefs",
];
const SENSITIVE_APP_WORDS = /(password|passwd|keychain|1password|bitwarden|lastpass|keepass|dashlane|vault|wallet|bank|banking|crypto|ledger|trezor|vpn|firewall|antivirus|security|authenticator|otp|ahnlab|ipinside|touchen|nxkey|veraport|crossex|unisign|nprotect|npki|인증서|보안|공인인증|은행|금융|결제|지갑|비밀번호|암호|키체인|script editor|automator|disk utility|activity monitor|visual studio|iterm|ghostty|wezterm|alacritty|whale|duckduckgo|orion browser|zen browser|termius|webex|quicktime|photo booth|teamviewer|anydesk|rustdesk|parsec|obs studio|loom|splashtop|remote desktop|vnc viewer|jump desktop)/i;

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
  "code", "code-oss", "vscodium", "teamviewer", "anydesk", "rustdesk", "parsec", "obs", "obs64", "loom", "mstsc", "zed", "tabby", "termius", "webex", "whale", "duckduckgo", "orion", "zen", "quicktime", "devenv", "sublime_text", "idea64", "pycharm64", "clion64", "webstorm64", "rider64", "wt", "diskmgmt", "diskpart", "powershell_ise", "wezterm", "ghostty", "warp",
  // database clients: a menu command in them drops, truncates or runs against a live database (independent review 4, S1); and voice recorders (S5)
  "tableplus", "dbeaver", "sequel ace", "sequel-ace", "sequelace", "sequel pro", "sequelpro", "postico", "navicat", "dbvisualizer", "datagrip", "mongodb", "robo 3t", "studio 3t", "robomongo", "beekeeper", "mysql workbench", "pgadmin", "azure data studio", "redis insight", "redisinsight", "querious", "sqlpro", "voice memos", "voicememos",
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
  "delete", "erase", "remove", "trash", "empty", "clear", "reset", "restore", "uninstall", "format(?:ting)? (?:disk|drive|volume|usb|card|partition|storage|device)", "formatier", "formater", "wipe", "quit", "close all", "force", "shut ?down", "restart", "sleep", "lock",
  // leaving the app or the machine, taking things away, and changes that leave the computer (a menu command that is handed out unopened must not be one of these)
  "\\bexit\\b", "log[ -]?off", "\\beject", "unmount", "disconnect", "terminate", "\\bkill\\b", "discard", "overwrite", "purge", "\\bpush\\b", "commit", "deploy", "submit", "\\brebase", "merge",
  // the same kinds of thing in the other languages Agentlas ships in (microphone dictation, autofill, emoji, services, writing tools, leaving, ejecting, restarting, logging out, sending, buying)
  "diktat", "dictée", "dictado", "dettatura", "ditado", "音声入力", "听写", "聽寫", "自動入力", "自动填充", "自動填寫", "automatisch ausfüllen", "remplissage automatique", "autorrelleno", "compilazione automatica", "preenchimento automático",
  "絵文字", "表情", "dienste", "servicios", "servizi", "serviços", "サービス", "服务", "服務", "schreibtools", "outils d.écriture", "herramientas de escritura", "strumenti di scrittura", "ferramentas de escrita",
  "esci\\b", "sair\\b", "끝내기", "終了", "退出", "結束", "꺼내기", "取り出", "弹出", "彈出", "auswerfen", "éjecter", "expulsar", "espelli", "ejetar", "마운트 ?해제", "マウント解除", "卸载", "卸載",
  "재시작", "다시 ?시작", "再起動", "重新启动", "重新啟動", "neu starten", "redémarrer", "reiniciar", "riavvia", "reinicia", "로그 ?오프", "로그 ?아웃", "サインアウト", "ログオフ", "注销", "注銷", "登出",
  "전송", "구입", "购买", "購買", "kaufen", "acheter", "comprar", "acquista", "inviare", "푸시", "커밋", "병합", "배포", "제출", "버리기", "덮어쓰기", "プッシュ", "コミット", "\\bpull\\b", "\\bpublish\\b", "install update", "relaunch",
  "빠른 ?인쇄", "quick print", "move to bin", "移到废纸篓", "移到廢紙簍", "mülleimer", "poubelle", "papelera", "cestino", "lixeira",
  // switching on the microphone, the camera, a recording, a shared screen, or a call (independent review 2, N1): the same in every language
  "\\bmute", "unmute", "video", "screen ?shar", "\\bshare screen", "record", "webcam", "broadcast", "livestream", "go live", "\\bmeeting", "음소거", "비디오", "화면 ?공유", "녹화", "녹음", "회의", "ミュート", "ビデオ", "画面共有", "収録", "録音", "録画", "ミーティング", "静音", "视频", "視頻", "屏幕共享", "录制", "錄製", "录音", "會議", "会议",
  "videoaufnahme", "aufnahme", "stummschalten", "bildschirmfreigabe", "enregistrement", "vidéo", "grabación", "silenciar", "compartir pantalla", "reunión", "registrazione", "gravação", "reunião",
  // the camera, the microphone, the location, and a call / sharing / remote session, in every language (independent review 3, R1)
  "カメラ", "摄像头", "攝影機", "攝像頭", "相机", "相機", "kamera", "caméra", "cámara", "fotocamera", "câmera", "câmara", "マイク", "麦克风", "麥克風", "mikrofon", "micro\\b", "micrófono", "microfono", "microfone",
  "位置情報", "位置", "standort", "position", "ubicación", "posizione", "localização", "localizacao", "\\baudio\\b", "\\bvoice\\b", "\\bcalls?\\b", "sharing", "\\bremote\\b", "remote access", "통화", "원격", "通話", "通话", "遠隔", "远程", "遠端", "fernzugriff", "accès à distance", "acceso remoto", "accesso remoto", "acesso remoto",
  // reloading a page throws away what was not saved, and developer tools run code (review 2, N1)
  "reload", "refresh", "새로 ?고침", "再読み込み", "刷新", "重新载入", "重新載入", "neu laden", "aktualisieren", "recharger", "actualiser", "recargar", "actualizar", "ricarica", "aggiorna", "recarregar", "atualizar", "developer", "개발자", "開発", "开发者", "開發", "entwickler", "développeur", "desarrollador", "sviluppatore", "desenvolvedor", "\\binspect", "dev ?tools", "javascript",
  // Korean
  "암호", "비밀번호", "신용", "카드", "결제", "구매", "구독", "지갑", "계정", "로그인", "로그아웃", "자동 ?완성", "키체인", "인증서", "토큰", "보내기", "답장", "전달", "공유", "초대", "메일", "메시지", "연락처", "게시", "업로드", "동기화", "백업", "받아쓰기", "마이크", "카메라", "위치", "화면 기록", "작문", "글쓰기 ?도구", "서비스", "음성", "말하기", "이모지", "블루투스", "네트워크", "삭제", "지우기", "비우기", "휴지통", "제거", "초기화", "복원", "디스크 ?포맷", "볼륨 ?포맷", "포맷 ?(?:디스크|드라이브|볼륨)", "종료", "재시동", "잠금", "잠자기", "강제",
  // Japanese / Chinese
  "ライティングツール", "书写工具", "寫作工具", "パスワード", "クレジット", "支払い", "購入", "ログイン", "ログアウト", "送信", "共有", "削除", "ゴミ箱", "終了", "回收站", "結束", "密码", "支付", "登录", "退出", "发送", "共享", "删除",
  // German / French / Spanish
  "papierkorb", "corbeille", "papelera", "passwort", "kennwort", "kreditkarte", "zahlung", "anmelden", "abmelden", "senden", "teilen", "löschen", "beenden", "quitter", "salir", "mot de passe", "carte", "paiement", "connexion", "déconnexion", "envoyer", "partager", "supprimer", "contraseña", "tarjeta", "pago", "iniciar sesión", "cerrar sesión", "enviar", "compartir", "eliminar",
  // erasing, in every language the destructive family is checked in (independent review 4, S1): Clear History, Delete Row, Drop Table, Truncate Table
  "消去", "(?<!取り)消す", "取り除", "クリア", "清除", "清空", "刪除", "移除", "清理", "entfernen", "leeren", "zurücksetzen", "verwerfen", "effacer", "\\bvider\\b", "retirer", "réinitialiser", "borrar", "vaciar", "quitar", "restablecer", "elimina\\b", "cancella", "svuota", "rimuovi", "ripristina", "excluir", "apagar", "remover", "limpar", "esvaziar", "redefinir", "drop (?:table|database|index|column|collection|schema|view)", "truncate", "^drop$",
  // discarding, overwriting and resetting, in the other languages (independent review 5, T1) - the languages other than English and Korean also hand out nothing by family
  "破棄", "放弃", "丢弃", "丟棄", "descartar", "scarta", "上書き", "覆盖", "覆蓋", "überschreiben", "écraser", "sobrescribir", "sobrescrever", "sovrascrivi", "リセット", "初期化", "重置", "还原", "還原", "리셋",
  // a phone or tablet used as a camera or scanner (Continuity: Import from iPhone or iPad > Take Photo, Scan Documents, Add Sketch), in every language (S5)
  "iphone", "ipad", "continuity", "from device", "take photo", "take picture", "scan document", "add sketch",
  // what a "show" or "hide" of it would put on screen, in the other languages (independent review 7, V2): passwords, accounts, contacts, debugging, private browsing
  "senha", "密碼", "連絡先", "联系人", "聯絡人", "kontakte", "contactos", "contatti", "contatos", "konto", "compte", "cuenta", "\\bconta\\b", "\\bconto\\b", "アカウント", "账户", "账号", "帳戶", "帳號", "debug", "private browsing", "incognito", "デバッグ", "调试", "調試", "디버그", "시크릿 ?모드", "비공개 ?브라우징",
  // ... whatever the phone or tablet is called, and in the other languages (independent review 5, T2); an unlocalized placeholder is never a command
  "사진 ?찍기", "문서 ?스캔", "스케치", "写真を撮", "書類をスキャン", "文書をスキャン", "スケッチ", "拍照", "拍摄照片", "扫描文稿", "掃描文件", "foto aufnehmen", "dokumente scannen", "skizze", "prendre une photo", "numériser", "esquisse", "tomar foto", "escanear", "boceto", "scatta foto", "scansiona", "schizzo", "tirar foto", "digitalizar", "esboço", "<<",
].join("|"), "i");

export function isRiskyMenuPath(path: readonly string[]): boolean {
  return path.some((segment) => RISKY_WORDS.test(segment));
}

// A menu item that is handed to an agent as a command WITHOUT being opened first (menu-probe.ts menuCapabilities) is recognised as harmless, not merely
// not recognised as harmful: a word list for "harmful" can never be complete in ten languages (independent review 2026-10-24, D2: 59 harmful names in
// Korean, Japanese, Chinese, German, Spanish, Italian, Portuguese and British English got a body). So a plain command gets a body only when
//   - it is not risky and does not close or revert (the words above stay as a second screen), AND
//   - it sits in a menu that is about how things look (View, Format, Help), or in the Find / Spelling / Substitutions / Transformations / Insert part of
//     Edit, or its own name is one of the plain editing, view and "show / hide" verbs.
// Anything else stays a candidate and counts for nothing: a language that is not listed here hands out fewer commands, never a harmful one.
const CLOSING_WORDS = /(close|revert|닫기|되돌리|閉じる|クローズ|关闭|關閉|schließen|fermer|cerrar|chiudi|fechar)/i;
export const isClosingPath = (path: readonly string[]): boolean => path.some((segment) => CLOSING_WORDS.test(segment));
// "asks for more input before it acts" is the platform's own sign: the label ends in an ellipsis (a Windows label may carry its accelerator after it)
export const labelOpensDialog = (label: string): boolean => /(…|\.{3})(?:\s*\([A-Za-z0-9]\))?\s*$/.test(label.trim());
const plain = (label: string): string => label.replace(/&/g, "").replace(/\s*\([A-Za-z0-9]\)\s*$/, "").replace(/[…]|\.{3}$/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const word = (list: string): RegExp => new RegExp(`^(?:${list})$`, "i");
// Menus whose whole content is about the look of the text: trusted as a family (a harmful name in them is still refused by the words above, and a command that
// opens a dialog is cancelled by the runner). View and Help are NOT trusted as families: a View menu may hold Reload, a Help menu Deactivate License or Install
// Command Line Tool (independent review 2, N1); they hand out their display and help verbs only.
// Menus that hand out their commands as a family, EXCEPT in an app that says it uses the camera, the microphone or the location (independent review 3, R1:
// a word list for "Show Camera" reopens through every language it does not cover, so for those apps the open-ended show / hide / toggle commands are not
// handed out at all, whatever the menu calls them). A harmful name in these menus is still refused by the words above.
export const HELP_MENUS = word("help|도움말|ヘルプ|帮助|說明|hilfe|aide|ayuda|aiuto|ajuda");
export const EDIT_MENUS = word("edit|편집|編集|编辑|編輯|bearbeiten|édition|edición|modifica|editar");
const CLOSED_VERBS = word([
  // new <window | tab | document | file | folder> - a closed list of nouns in every language, so that "New Movie Recording" and "Start New Meeting" are never one of them
  "new(?: window| tab| document| file| folder)?", "신규", "새로 만들기", "새 (?:윈도우|창|탭|문서|파일|폴더)", "新規", "新規(?:ウインドウ|ウィンドウ|タブ|書類|ドキュメント|ファイル|フォルダ)", "新建", "新建(?:窗口|視窗|标签页|標籤頁|文稿|文档|文件|文件夹|文件夾)",
  "neu", "neues fenster", "neuer tab", "neues dokument", "neue datei", "neuer ordner", "nouveau", "nouvelle fenêtre", "nouvel onglet", "nouveau document", "nouveau fichier", "nouveau dossier",
  "nuevo", "nueva ventana", "nueva pestaña", "nuevo documento", "nuevo archivo", "nueva carpeta", "nuovo", "nuova finestra", "nuova scheda", "nuovo documento", "nuovo file", "nuova cartella",
  "novo", "nova janela", "nova aba", "novo documento", "novo arquivo", "nova pasta",
  "select all", "copy", "cut", "paste(?: and match style)?", "undo", "redo", "duplicate", "find next", "find previous", "zoom(?: in| out)?", "actual size", "enter full screen", "bold", "italic", "underline", "about .+",
  "모두 선택", "복사", "복사하기", "오려두기", "붙여넣기", "붙여넣고 스타일 일치", "실행 취소", "다시 실행", "복제", "다음 찾기", "이전 찾기", "확대", "축소", "실제 크기", "전체 화면.*", ".+에 관하여",
  "すべてを選択", "コピー", "カット", "ペースト", "取り消す", "やり直す", "複製", "次を検索", "前を検索", "拡大", "縮小", "実際のサイズ", "フルスクリーン.*", ".+について",
  "全选", "拷贝", "复制", "剪切", "粘贴.*", "撤销", "撤銷", "重做", "拷貝", "放大", "缩小", "实际大小", "進入全螢幕", "进入全屏幕", "关于.+", "關於.+",
  "alles auswählen", "kopieren", "ausschneiden", "einsetzen", "widerrufen", "wiederholen", "duplizieren", "weitersuchen", "vorheriges suchen", "vergrößern", "verkleinern", "originalgröße", "vollbildmodus.*", "über .+",
  "tout sélectionner", "copier", "couper", "coller.*", "annuler", "rétablir", "dupliquer", "rechercher suivant", "rechercher précédent", "zoom avant", "zoom arrière", "taille réelle", "activer le mode plein écran", "à propos .+",
  "seleccionar todo", "copiar", "cortar", "pegar.*", "deshacer", "rehacer", "duplicar", "buscar siguiente", "buscar anterior", "ampliar", "reducir", "tamaño real", "entrar en pantalla completa", "acerca de .+",
  "seleziona tutto", "copia", "taglia", "incolla.*", "annulla", "ripeti", "duplica", "trova successivo", "trova precedente", "ingrandisci", "riduci", "dimensioni effettive", "informazioni su .+",
  "selecionar tudo", "colar.*", "desfazer", "refazer", "localizar próximo", "localizar anterior", "reduzir", "tamanho real", "sobre .+",
  // what the review found the allowlist had taken away from Music, Preview, Numbers and games (English, Korean, Japanese, Chinese)
  "sort(?: by .+| ascending| descending)?", "bring (?:to front|forward)", "send (?:to back|backward)", "group", "ungroup", "play", "pause", "next", "previous", "next track", "previous track", "rotate (?:left|right|clockwise|counterclockwise)", "flip (?:horizontal|vertical)", "(?:next|previous|first|last) page", "go to (?:next|previous|first|last) page", "add (?:row|column)(?: above| below| before| after)?", "new game", "take back move",
  "재생", "일시 ?정지", "다음 트랙", "이전 트랙", "(?:왼쪽|오른쪽)으로 회전", "(?:다음|이전|첫|마지막) 페이지", "새 게임", "再生", "一時停止", "次の(?:トラック|ページ)", "前の(?:トラック|ページ)", "播放", "暂停", "下一(?:首|页)", "上一(?:首|页)",
  // the same navigate / rotate / flip / view-mode names in the other languages (independent review 7, V3: Preview in Japanese lost 27 of 27 down to 9)
  "(?:左|右)に回転", "(?:最初|最後)のページ", "(?:水平|垂直)方向に反転", "コンテンツのみ", "サムネール", "連続スクロール", "スライドショー", "向(?:左|右)旋[转轉]", "第一页", "最后一页", "(?:水平|垂直)翻[转轉]", "仅内容", "缩略图", "连续滚动", "幻灯片",
  "nach (?:links|rechts) drehen", "nächste seite", "vorherige seite", "erste seite", "letzte seite", "(?:horizontal|vertikal) spiegeln", "nur inhalt", "miniaturen", "fortlaufender bildlauf", "diashow",
  "pivoter à (?:gauche|droite)", "page suivante", "page précédente", "première page", "dernière page", "retourner (?:horizontalement|verticalement)", "contenu uniquement", "vignettes", "défilement continu", "diaporama",
  "girar a la (?:izquierda|derecha)", "página siguiente", "página anterior", "primera página", "última página", "voltear (?:horizontal|verticalmente)", "voltear horizontalmente", "solo contenido", "miniaturas", "desplazamiento continuo", "presentación",
  "ruota a (?:sinistra|destra)", "pagina successiva", "pagina precedente", "prima pagina", "ultima pagina", "rifletti (?:orizzontalmente|verticalmente)", "solo contenuto", "miniature", "scorrimento continuo", "presentazione",
  "girar para a (?:esquerda|direita)", "próxima página", "primeira página", "inverter (?:horizontalmente|verticalmente)", "somente conteúdo", "apenas conteúdo", "rolagem contínua", "apresentação de slides",
].join("|"));
// the open-ended forms: "Show <anything>", "Hide <anything>" and their translations - the ones a camera or microphone switch hides in; "Toggle" only for a closed list of display
// nouns, because "Toggle <anything>" is how a setting is switched (Firewall, Proxy, VPN, Hotspot, Airplane Mode: independent review 6, U2)
const OPEN_VERBS = word("(?:show|hide) .+|toggle (?:the )?(?:sidebar|toolbar|tab bar|tab overview|status bar|path bar|ruler|rulers|grid|guides|full screen|word wrap|line numbers|minimap|outline|inspector|navigator|library|thumbnails|bookmarks bar|favorites bar|preview|split view)|.+ (?:show|hide)|.+ 보기|.+ 가리기|.+ 표시|.+ 숨기기|.+を表示|.+を非表示|.+を隠す|显示.+|隐藏.+|顯示.+|隱藏.+|.+ einblenden|.+ ausblenden|.+ anzeigen|afficher .+|masquer .+|mostrar .+|ocultar .+|mostra .+|nascondi .+");

// View: its display verbs and the same show / hide words; Help: help itself and the plain "what is this"
const VIEW_CLOSED = word("zoom(?: in| out)?|actual size|fit .+|enter full screen|sort by .+|as .+|bigger|smaller|larger|확대|축소|실제 크기|전체 화면.*|정렬.*|拡大|縮小|実際のサイズ|フルスクリーン.*|放大|缩小|实际大小|vergrößern|verkleinern|originalgröße|zoom avant|zoom arrière|taille réelle|ampliar|reducir|tamaño real|ingrandisci|riduci|dimensioni effettive|reduzir|tamanho real");
// What Format menus hold, recognised by name in the ten languages (independent review 6, U1 and U4): a menu is no longer trusted as a whole, an item is handed out
// when its own name is one of these, so what nobody listed is withheld in every language.
const FORMAT_VERBS = word([
  "bold", "italic", "underline", "outline", "strikethrough", "subscript", "superscript", "bigger", "smaller", "align (?:left|right|center|justified)", "center", "justify", "(?:increase |decrease )?indent", "outdent", "copy style", "paste style", "copy ruler", "paste ruler",
  "볼드체", "굵게", "이탤릭체", "기울임꼴", "밑줄체", "밑줄", "윤곽체", "크게", "작게", "왼쪽 정렬", "중앙", "가운데 정렬", "좌우 정렬", "양쪽 정렬", "오른쪽 정렬", "스타일 복사하기", "스타일 붙여넣기", "눈금자 복사하기", "눈금자 붙여넣기", "들여쓰기", "내어쓰기", "취소선", "아래 첨자", "위 첨자",
  "太字", "ボールド", "イタリック", "斜体", "下線", "アウトライン", "大きく", "小さく", "左揃え", "中央揃え", "右揃え", "両端揃え", "スタイルをコピー", "スタイルをペースト", "ルーラをコピー", "ルーラをペースト", "取り消し線", "上付き", "下付き",
  "粗体", "下划线", "大纲", "较大", "较小", "左对齐", "居中", "右对齐", "两端对齐", "拷贝样式", "粘贴样式", "拷贝标尺", "粘贴标尺", "粗體", "斜體", "底線", "外框", "較大", "較小", "靠左對齊", "置中", "靠右對齊", "左右對齊", "拷貝樣式", "貼上樣式",
  "fett", "kursiv", "unterstrichen", "kontur", "größer", "kleiner", "linksbündig", "zentriert", "blocksatz", "rechtsbündig", "stil kopieren", "stil einsetzen", "lineal kopieren", "lineal einsetzen",
  "gras", "italique", "souligné", "contour", "plus grand", "plus petit", "aligner à gauche", "centrer", "justifier", "aligner à droite", "copier le style", "coller le style", "copier la règle", "coller la règle",
  "negrita", "cursiva", "subrayado", "contorno", "más grande", "más pequeño", "alinear a la izquierda", "centrar", "justificar", "alinear a la derecha", "copiar estilo", "pegar estilo", "copiar regla", "pegar regla",
  "grassetto", "corsivo", "sottolineato", "più grande", "più piccolo", "allinea a sinistra", "centra", "giustifica", "allinea a destra", "copia stile", "incolla stile", "copia righello", "incolla righello",
  "negrito", "itálico", "sublinhado", "maior", "menor", "alinhar à esquerda", "centralizar", "alinhar à direita", "copiar régua", "colar régua",
  // display modes of an app (Calculator, Preview, Books ...), English and Korean
  "basic", "scientific", "programmer", "rpn(?: mode)?", "content only", "thumbnails", "contact sheet", "single page", "two pages(?: continuous)?", "continuous scroll", "zoom to fit", "slideshow", "table of contents", "highlights and notes",
  "기본형", "공학용", "프로그래머용", "콘텐츠만", "축소판 그림", "슬라이드 쇼", "한 페이지", "두 페이지", "연속 스크롤", "화면에 맞춤",
  // parts of the window an app shows or hides (a bare noun with a check mark on Windows and Linux: Status Bar, Word Wrap ...), in the ten languages
  "status bar", "toolbars?", "sidebar", "rulers?", "word wrap", "line numbers", "gridlines|grid", "guides", "navigation pane", "preview pane", "details pane", "minimap", "breadcrumbs",
  "상태 표시줄", "도구 모음", "사이드바", "눈금자", "자동 줄 바꿈", "줄 번호", "격자", "안내선", "ステータスバー", "ツールバー", "サイドバー", "ルーラ", "右端で折り返し", "行番号", "状态栏", "工具栏", "侧边栏", "标尺", "自动换行", "行号", "狀態列", "工具列", "側邊欄", "尺標", "自動換行", "行號",
  "statusleiste", "symbolleiste", "seitenleiste", "lineal", "zeilenumbruch", "zeilennummern", "barre d.état", "barre d.outils", "barre latérale", "règle", "retour à la ligne", "numéros de ligne", "barra de estado", "barra de herramientas", "barra lateral", "regla", "ajuste de línea", "números de línea",
  "barra di stato", "barra degli strumenti", "righello", "a capo automatico", "numeri di riga", "barra de status", "barra de ferramentas", "régua", "quebra de linha", "números de linha",
].join("|"));
// The standard document-editing items of the Edit menu's Find / Spelling and Grammar / Substitutions / Transformations / Insert parts, by name, in English and Korean
// (independent review 6, U1: the submenu's name used to vouch for anything inside it).
const EDIT_ITEMS = word([
  "find", "find and replace", "find next", "find previous", "use selection for find", "jump to selection", "check document now", "check spelling while typing", "check grammar with spelling", "correct spelling automatically",
  "smart copy/paste", "smart quotes", "smart dashes", "smart links", "data detectors", "text replacement", "make upper case", "make lower case", "capitalize", "line break", "paragraph break", "page break", "section break", "column break",
  "다음 찾기", "이전 찾기", "선택 부분으로 이동", "선택 부분을 찾기에 사용", "지금 문서 검사", "입력하는 동안 맞춤법 검사", "맞춤법 및 문법 검사", "맞춤법 자동 수정", "스마트 복사하기/붙여넣기", "스마트 인용 부호", "스마트 대시", "스마트 링크", "데이터 탐색기", "텍스트 대치",
  "대문자로 만들기", "소문자로 만들기", "대문자로 시작", "줄 바꿈", "단락 바꿈", "페이지 바꿈",
].join("|"));
const HELP_VERBS = word("help|.+ help|search|keyboard shortcuts|release notes|what.s new|도움말|.+ 도움말|검색|단축키.*|ヘルプ|.+ ヘルプ|帮助|.+ 帮助|說明|hilfe|.+ hilfe|aide|.+ aide|ayuda|.+ ayuda|aiuto|.+ aiuto|ajuda|.+ ajuda|about .+|.+에 관하여|.+について|关于.+|über .+|à propos .+|acerca de .+|informazioni su .+|sobre .+");

// What the system adds to every app's menus, wherever the app's own words put them: the end of the macOS Edit menu (AutoFill ▸, Start Dictation…, Emoji &
// Symbols) and everything under Services. Found by SHAPE, not by the word they are called in this language (D3: on German, French, Spanish, Japanese and
// Chinese macOS the explorer pressed "Start Dictation…" and turned the microphone on): a plain item last, an ellipsis item before it, and, before those, a
// submenu. An Edit menu that does not end like that is the app's own and is left alone.
const SERVICES_MENU = word("services|서비스|サービス|服务|服務|dienste|servicios|servizi|serviços");
interface MenuNodeLike { label: string; path: string[]; leaf?: boolean; children: MenuNodeLike[] }
const endsInEllipsis = (label: string): boolean => label.endsWith("…") || label.endsWith("...");
export function systemInsertedPrefixes(nodes: readonly MenuNodeLike[], platform: string = "darwin"): string[][] {
  if (platform !== "darwin") return [];
  const out: string[][] = [];
  for (const top of nodes) {
    const kids = top.children;
    // the system's own tail makes a menu of at least six entries (three of the app's, three of the system's); a shorter Edit menu is the app's
    if (EDIT_MENUS.test(plain(top.label)) && kids.length >= 6) {
      const last = kids[kids.length - 1];
      const before = kids[kids.length - 2];
      if (last.children.length === 0 && before.children.length === 0 && endsInEllipsis(before.label.trim())) {
        out.push(last.path, before.path);
        const third = kids[kids.length - 3];
        if (third && third.children.length > 0) out.push(third.path);
      }
    }
    for (const child of kids) if (SERVICES_MENU.test(plain(child.label))) out.push(child.path);
  }
  return out;
}
export const startsWithPath = (path: readonly string[], prefix: readonly string[]): boolean => prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);

// A command whose purpose is to show a panel (About, Show <something>): the panel it opens is the result, not a dialog to be closed again.
const ABOUT_VERBS = word("about .+|.+에 관하여|.+について|关于.+|關於.+|über .+|à propos .+|acerca de .+|informazioni su .+|sobre .+");
export const opensAPanelByPurpose = (path: readonly string[]): boolean => { const last = plain(path[path.length - 1] ?? ""); return ABOUT_VERBS.test(last) || OPEN_VERBS.test(last); };

export function isDirectMenuCommandPath(path: readonly string[], options: { sensors?: boolean } = {}): boolean {
  if (path.length === 0) return false;
  if (isRiskyMenuPath(path) || path.some((segment) => CLOSING_WORDS.test(segment))) return false;
  const sensors = options.sensors === true;
  const top = plain(path[0]);
  const last = plain(path[path.length - 1]);
  // No whole menu is trusted for what it holds (Format, View, Insert, Arrange, Table were, until independent review 6, U1: the word list that backed that trust was
  // bypassed by an item in another language under an English menu name, and by English and Korean synonyms nobody had listed - Abandon Changes, Throw Away Changes,
  // Drop All Tables, 변경 사항 폐기). An item is handed out when its OWN name is recognised as harmless: the closed verb lists, in every language they cover.
  // A sensor app (camera, microphone, location) gets no open-ended show / hide.
  if (HELP_MENUS.test(top)) return HELP_VERBS.test(last);
  return CLOSED_VERBS.test(last) || VIEW_CLOSED.test(last) || FORMAT_VERBS.test(last) || EDIT_ITEMS.test(last) || (!sensors && OPEN_VERBS.test(last));
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
