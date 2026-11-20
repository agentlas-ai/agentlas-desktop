/*
 * The one approval rule (decision,; repairs). Pure: no imports, so every surface and every gate can load it.
 *
 * A card (chip) is asked for exactly three kinds of action, and only when the host can tell what the action is:
 *   money  - a payment or a transfer. ALWAYS asked, every time; the card has no "always allow" and no "for this task".
 *   delete - removing files, records, messages. Asked the first time in read and write modes; "always allow" is remembered for the
 *            project (a conversation without a project: that conversation) and the tool is not asked there again. Full access
 * does not ask it.
 *   send   - something leaving the machine for other people (mail, message, post, publish, upload). Same as delete.
 * Everything else is not asked, whatever the permission mode. The mode itself is never locked.
 *
 * What the host can read, in this order (one function, one table - classifyApprovalAction):
 *   1. where the tool comes from: a server the app itself registered (exact identity, never a name prefix) is coordination, not an
 *      action toward the outside world;
 *   2. the tool's name: money before delete before send, lookups (list / get / status / history ...) are never asked. Money is read by
 *      RULE, not by a list of reported names: a word for a money thing (funds, usdc, transaction, credits, bet, gift ...) or a money
 *      act (book, renew, upgrade ...) in a name that is not a lookup is a payment, and every non-lookup tool of a payment-only server is
 * one. Over-asking (a payment card for something harmless) is the safe side; missing is not. "Does not change anything"
 *      (`mutating: false`) is believed only when Main resolved the server (`catalogId`); a runtime's own label (an ACP kind read /
 *      search / fetch / think) never removes the card a name earns;
 *   3. for a tool whose name does not tell, what it says about itself (MCP tool annotations the host already holds from the
 *      server's tool list): destructiveHint -> delete, an explicit openWorldHint on a tool that states it writes -> send. Marks only
 *      ADD a card: a tool's own "read only" never takes away the card its name earns (a server cannot grant itself anything).
 * A tool with no mark and no telling name is not asked (three kinds of card only, no new blocker). A shell command line is read by
 * the program it runs (shellCommandDeletes, below: the delete card only;); a network call a CLI makes with its own tools is not
 * classified here: see docs/Agentlas2.0/evidence/d8/fact-table.md.
 * One thing is refused, not asked, in every mode (full access included): registering a job in an OS scheduler from a run (shellCommandRegistersScheduler,
 * below). Agentlas owns scheduling (runtime-builtin-egress-policy.ts, category "schedule"): an app automation is listed, paused and deleted in the
 * app, an OS job is none of that, and a card would let "allow" create exactly that invisible job.
 */
export type ApprovalActionClass = "money" | "delete" | "send" | "other";

/** The MCP tool annotations the host reads (MCP specification, tool `annotations`). Only values the tool states explicitly count. */
export interface ApprovalToolAnnotations {
  readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean;
  /**
   * F3: "this call spends the person's money" as a DECLARATION of the tool's list, not a reading of its name (a server app's `web__request` that sends a keyed POST for a paid
   * video, a tool named `generate` that bills). Only the bridge of the connected apps of the server writes it, and only from the server's own `effects.costsMoney` column. It can only ADD
   * the money card (asked every time, in full access too): a server cannot grant itself anything with it.
   */
  costsMoneyHint?: boolean;
}

/** The hints a tool states as booleans in a server's tool list, or null when it states none. A missing hint is not a statement. */
export function approvalToolAnnotations(raw: unknown): ApprovalToolAnnotations | null {
  if (!raw || typeof raw !== "object") return null;
  const { readOnlyHint, destructiveHint, openWorldHint, costsMoneyHint } = raw as Record<string, unknown>;
  const marks: ApprovalToolAnnotations = {
    ...(costsMoneyHint === true ? { costsMoneyHint: true } : {}),
    ...(typeof readOnlyHint === "boolean" ? { readOnlyHint } : {}),
    ...(typeof destructiveHint === "boolean" ? { destructiveHint } : {}),
    ...(typeof openWorldHint === "boolean" ? { openWorldHint } : {}),
  };
  return Object.keys(marks).length > 0 ? marks : null;
}

export interface ApprovalActionAsk {
  tool: string;
  /** Main-only: the app operation this host-raised ask stands for (app.call / one_app_call run it). The operation's own act decides the class, never a server name. */
  hostOperation?: string;
  kind?: string;
  mutating?: boolean;
  /** The registry identity Main resolved for the server this call goes to (MCP proxy, in-process loop). Absent when only the name is known. */
  catalogId?: string | null;
  annotations?: ApprovalToolAnnotations | null;
  /** The shell command line a shell-tool ask stands for (codex command approval, the in-process `bash`, an ACP execute call), whole. Read by the approval rule alone (shellCommandDeletes). */
  command?: string;
}

/*
 * Servers the app itself registers (their catalog identity, which is also their config key: mcp-config.ts refuses an installed
 * server that takes one of these keys). Their tools are the owner's own team coordination and the host's own controls; the browser
 * has its own approval path (browser/connect.ts). Exact identities only: "agentlasx" or "hephaestus-fake" is somebody else's server.
 * Not here on purpose: `agentlas` (the web service: Hub upload, cloud agent delete), `hephaestus-network` (unpublish), `agent-mail`
 * (sends mail) - their tools are classified like anybody's.
 */
const HOST_OWN_SERVERS: ReadonlySet<string> = new Set([
  "one-team", "agentlas-turn", "agentlas-browser", "agentlas-ui", "agentlas-time", "workspace-preview", "cua-driver",
]);

/* ── The name table ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */

// A word that is the action itself wherever it stands in the name.
const MONEY_VERB = new Set(["pay", "buy", "sell", "purchase", "withdraw", "donate", "remit", "subscribe"]);
// A word that names a money thing; a lookup of it ("payments_list", "refund_policy") is not a payment.
const MONEY_NOUN = new Set([
  "payment", "transfer", "wire", "remittance", "withdrawal", "deposit", "charge", "donation", "payout", "refund", "money",
  "subscription", "invoice", "trade", "swap", "budget", "checkout",
  // What money is made of, wherever it stands in the name (defect 1): the rule is "a money thing + not a lookup", not a list
  // of the names somebody has already reported. "send_funds", "send_usdc" and "place_bet" are payments, not "sending out".
  "funds", "fund", "credit", "credits", "debit", "debits", "billing", "bill", "bills", "transaction", "transactions", "tx", "wallet",
  "wallets", "usd", "usdc", "usdt", "btc", "eth", "bitcoin", "ethereum", "crypto", "coin", "coins", "bet", "bets", "wager", "wagers",
  "stake", "staking", "bid", "bids", "gift", "gifts", "giftcard", "payin", "payroll", "salary", "spend", "spending", "booking", "bookings",
  "settlement", "topup", "tip", "tips",
]);
/** A money act when it is the FIRST word of the name ("book_flight", "tip", "renew", "upgrade_account", "mint_nft"); elsewhere it is an ordinary word ("get_book"). */
const MONEY_FIRST = new Set([
  "book", "topup", "renew", "redeem", "settle", "upgrade", "downgrade", "recharge", "lend", "borrow", "sponsor", "mint",
]);
// A money object that is money only together with an act that changes it ("change_plan", "add_seats", "extend_license", "issue_card"):
// "create_plan" / "update_plan" (a project plan) and "create_card" (a board card) are not.
const PLAN_NOUN = new Set(["plan", "plans", "license", "licence", "tier", "seat", "seats", "membership"]);
const PLAN_ACT = new Set(["upgrade", "downgrade", "change", "switch", "renew", "extend", "cancel", "subscribe", "buy", "select", "add"]);
const CARD_NOUN = new Set(["card", "cards"]);
const CARD_ACT = new Set(["add", "issue", "authorize", "authorise", "charge", "capture", "tokenize"]);
// A token / NFT is a thing that is sent, minted or signed away ("send_token", "sign_nft"); "refresh_token" is not.
const ASSET_NOUN = new Set(["token", "tokens", "nft", "nfts"]);
const ASSET_ACT = new Set(["send", "mint", "burn", "bridge", "sign", "approve", "claim", "airdrop", "sell", "buy"]);
// An order is a purchase when it is placed, cancelled or is the whole name ("order_food"); "set_sort_order" is not.
const ORDER_ACT = new Set(["place", "create", "new", "make", "submit", "confirm", "cancel", "finalize", "capture", "add", "open", "insert", "write", "compose", "complete", "draft"]);
/** Servers whose whole business is moving money (their plain config key): every tool of one that is not a lookup is a money act. A marker that only ADDS a card. */
const PAYMENT_SERVERS: ReadonlySet<string> = new Set([
  "stripe", "paypal", "square", "plaid", "wise", "venmo", "cashapp", "toss", "tosspayments", "kakaopay", "naverpay", "payco", "coinbase",
  "binance", "upbit", "bithumb", "coinone", "kraken", "razorpay", "adyen", "braintree", "paddle", "lemonsqueezy", "mollie", "alpaca",
  "ibkr", "robinhood", "kis", "bank", "banking", "payment", "payments", "pay", "wallet", "crypto", "brokerage", "trading",
]);
const DELETE_VERB = new Set([
  "delete", "destroy", "erase", "purge", "unlink", "rmdir", "wipe", "truncate", "rm", "rimraf", "remove", "drop", "revoke",
  "terminate", "prune", "cleanup", "clear", "unpublish",
]);
const DELETE_NOUN = new Set(["trash"]);
// "format" erases only a disk ("format_disk"); "format_date" does not.
const FORMAT_NOUN = new Set(["disk", "drive", "volume", "partition", "device"]);
const SEND_VERB = new Set([
  "send", "publish", "tweet", "forward", "broadcast", "submit", "dispatch", "deliver", "notify", "invite", "deploy", "push",
]);
const SEND_NOUN = new Set(["post", "reply", "share", "upload", "public", "webhook", "webhooks"]);
// An HTTP request leaves the machine ("http_request"); "request_access" is its own exact entry below.
const HTTP_NOUN = new Set(["http", "https"]);
// Things that go to other people: sending only together with a making verb ("create_issue") or as the whole name ("sms").
const SEND_OBJECT = new Set(["message", "email", "mail", "sms", "comment", "issue", "gist", "dm"]);
const MAKING = new Set(["create", "add", "new", "write", "make", "insert", "open", "compose", "place", "capture", "confirm", "finalize"]);
/** A name that starts with one of these reads. */
const LOOKUP_FIRST = new Set([
  "get", "list", "read", "search", "find", "fetch", "view", "show", "count", "check", "describe", "query", "preview",
  "lookup", "retrieve", "calculate", "calc", "compute", "estimate", "export", "validate", "verify", "compare", "analyze", "inspect",
]);
/** A name that ends with one of these is about the thing, not the act ("payment_status", "transfer_history", "post_stats"). */
const LOOKUP_LAST = new Set([
  ...LOOKUP_FIRST, "status", "history", "stats", "statistics", "info", "log", "logs", "report", "summary", "policy", "funnel", "metadata",
  "details", "price", "balance", "quote", "performance", "overview", "breakdown", "rate", "rates", "forecast", "fees", "fee", "limits",
  "limit", "total", "totals", "balances", "holdings", "available", "options", "methods", "types", "id", "ids", "transactions", "schedule", "schedules",
]);
/** An object that makes the act harmless or not about money at all ("purge_cache", "transfer_learning_run", "buy_item_simulation"). */
const HARMLESS = new Set(["cache", "simulation", "simulate", "learning", "density", "structure", "answer", "mock", "sandbox", "dryrun"]);
/** Of those, the words that only say "pretend": they never take a money card away (money is asked everywhere, every time; asking too much beats missing a payment). */
const PRETEND = new Set(["simulation", "simulate", "mock", "sandbox", "dryrun"]);
const JOINING = new Set(["and", "then", "plus"]);
// "transfer_ownership" hands a file to somebody else: a share, not a payment.
const HANDING_OVER = new Set(["ownership"]);
// A pull request goes to other people when it is made or merged ("create_pull_request", "merge_pull_request").
const PULL = new Set(["pull"]);
const REQUEST = new Set(["request"]);
const MERGING = new Set(["merge"]);
/** What a run-together name is made of besides the action word ("paynow", "deletefile", "sendemail", "batchdelete", "autopay"). */
const GLUE = new Set([
  "now", "file", "files", "message", "messages", "email", "mail", "all", "batch", "bulk", "auto", "re", "pre", "item", "items",
  "user", "data", "sms", "money", "funds", "order", "make", "do",
]);
const ACTION_WORDS: readonly string[] = [...MONEY_VERB, ...MONEY_NOUN, ...MONEY_FIRST, ...DELETE_VERB, ...DELETE_NOUN, ...SEND_VERB, ...SEND_NOUN]
  .filter((word) => word.length >= 3).sort((a, b) => b.length - a.length);
const ACTION_WORD_SET: ReadonlySet<string> = new Set(ACTION_WORDS);

/** Korean tool names carry no separable words: the action is a part of the name (the same table, as name parts). Money first. */
const KOREAN: ReadonlyArray<readonly [ApprovalActionClass, readonly string[]]> = [
  ["money", ["결제", "송금", "이체", "환불", "구독", "주문", "매수", "매도", "출금", "구매", "납부", "기부", "충전", "청구"]],
  ["delete", ["삭제", "지우", "제거", "휴지통", "폐기", "비우"]],
  ["send", ["보내", "전송", "발송", "게시", "올리", "업로드", "공유", "배포", "초대", "답장", "전달"]],
];
const KOREAN_LOOKUP: readonly string[] = ["조회", "목록", "내역", "검색", "보기", "확인", "상태", "통계"];

/*
 * Tools whose name alone does not say what they do, by the family of the server (its plain key) and the exact tool name. These are
 * the real names of the built-in and common connectors (table): a Gmail "modify" moves mail to the trash, a Drive "update"
 * turns sharing on, a Calendar "insert" mails invitations.
 */
const FAMILY_TOOLS: Readonly<Record<string, Readonly<Record<string, ApprovalActionClass>>>> = {
  gmail: { modify: "delete", create_filter: "send", update_message_labels: "delete" },
  drive: { update: "send", create_permission: "send", permissions_create: "send", request_access: "send" },
  calendar: { insert: "send", create_event: "send", events_insert: "send", cancel_event: "delete" },
  notion: { archive_page: "delete", create_page: "send" },
  twilio: { make_call: "send" },
  http: { request: "send" },
  webhook: { trigger: "send" },
  s3: { put_object: "send" },
  venmo: { request: "money" },
};
/** The same for connectors whose server key is an opaque id (a hosted connector): the tool name alone, exact. */
const EXACT_TOOLS: Readonly<Record<string, ApprovalActionClass>> = {
  update_message_labels: "delete", request_access: "send", remoteconfig_update_template: "send",
  send_code_to_figma: "other", weave_upload_asset: "other", create_upload_link: "other",
};

/** `mcp__<server>__<tool>` split at the first separator after the server key; null for a name that is not an MCP tool. */
export function approvalToolParts(tool: string): { server: string; name: string } | null {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool.trim());
  return mcp ? { server: mcp[1]!, name: mcp[2]! } : null;
}

const baseOf = (word: string, set: ReadonlySet<string>): string | null => {
  if (set.has(word)) return word;
  // sends / sending / sender, deletes / deleting, charges ... Not "-ed": "deleted_items" describes a state, it is not the act.
  for (const suffix of ["es", "s", "ing", "er", "r"]) {
    if (!word.endsWith(suffix) || word.length - suffix.length < 3) continue;
    const stem = word.slice(0, -suffix.length);
    if (set.has(stem)) return stem;
    if (suffix === "ing" && set.has(`${stem}e`)) return `${stem}e`;
  }
  return null;
};

/** A run-together word taken apart when what is left besides a known action word is a known filler or another known word ("paynow" -> pay + now, "payinvoice" -> pay + invoice). */
function unglue(word: string): string[] {
  if (word.length < 5 || ACTION_WORD_SET.has(word)) return [word];
  for (const action of ACTION_WORDS) {
    if (word.length <= action.length) continue;
    const rest = word.slice(action.length), lead = word.slice(0, -action.length);
    if (word.startsWith(action) && (GLUE.has(rest) || ACTION_WORD_SET.has(rest))) return [action, rest];
    if (word.endsWith(action) && (GLUE.has(lead) || ACTION_WORD_SET.has(lead))) return [lead, action];
  }
  return [word];
}

/** Words of a tool name: the MCP server prefix is dropped, camelCase and separators split, lower-cased, run-together words taken apart. */
export function approvalToolWords(tool: string): string[] {
  const name = approvalToolParts(tool)?.name ?? tool;
  const raw = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const words: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    // "check_out" is a checkout, not a check.
    if (raw[index] === "check" && raw[index + 1] === "out") { words.push("checkout"); index += 1; continue; }
    // "top_up" is a top-up of a balance.
    if (raw[index] === "top" && raw[index + 1] === "up") { words.push("topup"); index += 1; continue; }
    words.push(...unglue(raw[index]!));
  }
  return words;
}

function classifyByName(tool: string, serverKey: string | null): ApprovalActionClass {
  const parts = approvalToolParts(tool);
  const name = (parts?.name ?? tool).toLowerCase();
  if (parts) {
    const family = FAMILY_TOOLS[parts.server.toLowerCase()]?.[name];
    if (family) return family;
  }
  if (Object.prototype.hasOwnProperty.call(EXACT_TOOLS, name)) return EXACT_TOOLS[name]!;
  if (KOREAN_LOOKUP.some((part) => name.includes(part))) return "other";
  for (const [action, parts] of KOREAN) if (parts.some((part) => name.includes(part))) return action;
  const words = approvalToolWords(tool);
  if (words.length === 0) return "other";
  const first = words[0]!, last = words[words.length - 1]!;
  const has = (set: ReadonlySet<string>) => words.some((word) => baseOf(word, set) !== null);
  const verbLast = baseOf(last, MONEY_VERB) ?? baseOf(last, DELETE_VERB) ?? baseOf(last, SEND_VERB);
  const verbFirst = baseOf(first, MONEY_VERB) ?? baseOf(first, DELETE_VERB) ?? baseOf(first, SEND_VERB) ?? (MONEY_FIRST.has(first) ? first : null);
  const joined = words.findIndex((word) => JOINING.has(word));
  // Is the whole name a lookup? It ends with what it reports, or it starts with a reading verb and nothing later turns it into an act.
  const moneyNamed = has(MONEY_VERB) || has(MONEY_NOUN) || MONEY_FIRST.has(first)
    || words.some((word) => PLAN_NOUN.has(word)) && words.some((word) => PLAN_ACT.has(word))
    || words.some((word) => CARD_NOUN.has(word)) && words.some((word) => CARD_ACT.has(word))
    || words.some((word) => ASSET_NOUN.has(word)) && words.some((word) => ASSET_ACT.has(word));
  const lookup = words.some((word) => HARMLESS.has(word) && !(PRETEND.has(word) && moneyNamed))
    // "payment_status" and "delete_log_search" report; "send_report" and "delete_history" act (the act comes first, the thing last).
    || (words.length > 1 && LOOKUP_LAST.has(last) && !verbLast && !(verbFirst && !LOOKUP_FIRST.has(last)))
    || (LOOKUP_FIRST.has(first) && words.length > 1 && !verbLast && joined < 0);
  if (lookup) return "other";
  const making = words.some((word) => MAKING.has(word));
  // A server that only moves money: whatever it is asked to do that is not a lookup is a money act (it can only add a card).
  if (serverKey !== null && PAYMENT_SERVERS.has(serverKey)) return words.some((word) => HANDING_OVER.has(word)) ? "send" : "money";
  // money > delete > send: "send_money" is a transfer, "refund_and_delete" is a refund.
  const named = (set: ReadonlySet<string>) => words.some((word) => set.has(word));
  if (has(MONEY_VERB) || has(MONEY_NOUN) || MONEY_FIRST.has(first)
    || (named(PLAN_NOUN) && named(PLAN_ACT)) || (named(CARD_NOUN) && named(CARD_ACT)) || (named(ASSET_NOUN) && named(ASSET_ACT))) {
    if (words.some((word) => HANDING_OVER.has(word))) return "send";
    return "money";
  }
  // An order is a purchase when it is placed or cancelled ("place_order", "cancel_order", "order_food", "order"); "set_sort_order" and "order_by" are not.
  if (words.some((word) => word === "order" || word === "orders")
    && (words.some((word) => ORDER_ACT.has(word)) || words.length === 1 || (first === "order" && words[1] !== "by"))) return "money";
  if (has(DELETE_VERB) || has(DELETE_NOUN) || (named(new Set(["format"])) && named(FORMAT_NOUN))) return "delete";
  if (named(HTTP_NOUN) && words.some((word) => word === "request" || word === "put" || word === "patch")) return "send";
  if (has(SEND_VERB)) return "send";
  // "posts" is a list of posts; "post" is the act.
  if (words.some((word) => SEND_NOUN.has(word))) return "send";
  if (words.some((word) => SEND_OBJECT.has(word)) && (making || words.length === 1)) return "send";
  if (words.some((word) => PULL.has(word)) && words.some((word) => REQUEST.has(word)) && (making || words.some((word) => MERGING.has(word)))) return "send";
  return "other";
}

/* ── what an app operation DOES ──────────────────────────────────────────────────────────────────────────────────────
 * harness_call app.call and one_app_call run any of the app's operations through a host-own server, whose tool name ("harness_call") says nothing
 * about the act. The host raises the card itself before it runs the operation (harness/app-call-approval.ts) and this reads the act from the
 * operation's own name: its first word is the verb ("removeMember", "forgetEntry", "send", "publishPublic"). A lookup is never asked. */
const HOST_OPERATION_DELETE = new Set(["delete", "remove", "uninstall", "forget", "discard", "dissolve", "purge", "wipe", "erase", "destroy", "trash", "revoke", "unpublish", "clear", "prune", "drop", "terminate"]);
// "submit" sends out only as the first word of a longer name ("submitBugReport"); the bare "submit" of an in-app form does not. "withdraw" is not money here
// ("toolchains.withdrawAsset" takes a published Toolchain back); no allowed operation moves money (policy.ts keeps them with the owner), so the set is the plain money verbs.
const HOST_OPERATION_SEND = new Set(["send", "publish", "post", "invite", "share", "upload", "forward", "reply", "broadcast", "deploy", "push"]);
const HOST_OPERATION_MONEY = new Set(["purchase", "pay", "buy", "subscribe", "refund", "topup", "charge", "checkout"]);
const HOST_OPERATION_LOOKUP_LAST = new Set(["preview", "status", "state", "list", "get", "history", "summary", "stats", "count", "counts", "info"]);
const camelWords = (segment: string): string[] => segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The class of an app operation by its own name ("agent.uninstall" delete, "agentMail.send" send, "agentLeases.purchase" money, "chats.get" other). */
export function classifyHostOperation(operation: string): ApprovalActionClass {
  const segment = operation.slice(operation.lastIndexOf(".") + 1);
  const words = camelWords(segment);
  if (words.length === 0) return "other";
  const first = words[0]!, last = words[words.length - 1]!;
  // "uninstallPreview", "removePreview": what would happen, not the act.
  if (words.length > 1 && HOST_OPERATION_LOOKUP_LAST.has(last)) return "other";
  if (HOST_OPERATION_MONEY.has(first)) return "money";
  if (HOST_OPERATION_DELETE.has(first)) return "delete";
  if (HOST_OPERATION_SEND.has(first) || (first === "submit" && words.length > 1)) return "send";
  return "other";
}

export function classifyApprovalAction(ask: ApprovalActionAsk): ApprovalActionClass {
  if (typeof ask.hostOperation === "string" && ask.hostOperation) return classifyHostOperation(ask.hostOperation);
  // "Does not change anything" is believed only from the host itself: Main resolved the server (a registry identity) and judged the
  // call a read. A runtime's own label (an ACP tool kind read / search / fetch / think, a codex call with no identity) is not that:
  // the name still counts, so a label can never take away the card the name earns (defect 3; the same rule as the marks).
  if (ask.mutating === false && typeof ask.catalogId === "string") return "other";
  const parts = approvalToolParts(ask.tool);
  // 1. Where it comes from. A known registry identity decides; without one the exact server key in the name does.
  const origin = ask.catalogId ?? parts?.server ?? null;
  if (origin !== null && HOST_OWN_SERVERS.has(origin)) return "other";
  // A shell command line is read by what it runs (its program), not by the tool's name: "bash" says nothing about the act.
  // A payment named by the tool keeps its rank (money before delete).
  if (typeof ask.command === "string" && ask.command && shellCommandDeletes(ask.command)
    && (/\s/.test(ask.tool.trim()) || classifyByName(ask.tool, ask.catalogId ?? approvalToolParts(ask.tool)?.server?.toLowerCase() ?? null) !== "money")) return "delete";
  // A tool "name" with spaces is a sentence an ACP CLI wrote as the call's title ("Fetching post data"): only the ACP kind is trusted there.
  if (/\s/.test(ask.tool.trim())) return ask.kind === "delete" ? "delete" : "other";
  // 2. The name: money before delete before send. What the name earns stands: a server's own "read only" never takes a card away
  // (a tool's own marks are not a grant - the same rule as the read boundary, mcp-tools proxy-server.ts mcpToolIsMutating).
  const named = classifyByName(ask.tool, ask.catalogId ?? parts?.server?.toLowerCase() ?? null);
  if (named !== "other") return named;
  if (ask.kind === "delete") return "delete";
  // 3. What the tool says about itself, for a tool whose name does not tell: marks can only ADD a card.
  const marks = ask.annotations;
  // A declared cost is money whatever else the tool says about itself (it only adds the card; a read-only mark beside it does not take it away).
  if (marks && marks.costsMoneyHint === true) return "money";
  if (marks && marks.readOnlyHint !== true) {
    // The app's own file server works inside the run's folder: overwriting a file there is editing, like the built-in edit tool.
    if (marks.destructiveHint === true && ask.catalogId !== "filesystem") return "delete";
    // "Reaches outside" counts only for a tool that also states it writes (readOnlyHint false, or any destructiveHint, which the
    // specification defines for writers only): a search tool that says openWorld and nothing else is not a send.
    if (marks.openWorldHint === true && (marks.readOnlyHint === false || typeof marks.destructiveHint === "boolean")) return "send";
  }
  return "other";
}

/* ── what a shell command line DOES (defect 7) ────────────────────────────────────────────────────────────────────────────────
 * A shell tool's name ("bash") says nothing about the act, and the executors give no "this deletes" mark for a command (codex marks a patch,
 * ACP marks a tool kind). So the host reads the command LINE as a shell does: it splits it at the unquoted separators, takes each simple command's
 * program (after env assignments, redirections and wrappers such as sudo / env / xargs), looks inside `sh -c '...'` / `cmd /c ...`, `$( )` and
 * backticks, and asks whether that PROGRAM is one that removes files. The program is an exact name (basename, lower case), never a substring of
 * the text: `echo "rm -rf"`, `grep rm file` and `git commit -m rm` are not deletes. Pure; no imports. Over-asking is the safe side (asks the
 * first time and remembers per project); a delete written inside a script the model wrote to a file, or `python -c`, is not visible here. */
const SHELL_DELETE_PROGRAMS = new Set([
  "rm", "rmdir", "unlink", "shred", "srm", "trash", "trash-put", "trash-cli", "rimraf",
  // Windows: cmd and PowerShell (`rm` / `ri` / `del` are PowerShell aliases of Remove-Item).
  "del", "erase", "rd", "ri", "remove-item",
]);
const SHELL_WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "nohup", "exec", "time", "nice", "ionice", "setsid", "caffeinate", "xargs", "stdbuf", "timeout", "chronic"]);
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
const SHELL_SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")", "{", "}"]);

/** Words of one command line, with the unquoted separators as their own words. A quoted word loses its quotes; an escaped character stays as itself. */
function shellWords(line: string): string[] {
  const out: string[] = [];
  let word = "", has = false, quote: "" | "'" | '"' = "";
  const flush = () => { if (has) out.push(word); word = ""; has = false; };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote === "'") { if (ch === "'") quote = ""; else word += ch; continue; }
    if (quote === '"') {
      if (ch === '"') quote = "";
      else if (ch === "\\" && i + 1 < line.length) { i += 1; word += line[i]; }
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < line.length) { i += 1; word += line[i]; has = true; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { flush(); continue; }
    if (ch === "\n" || ch === ";" || ch === "(" || ch === ")" || ch === "{" || ch === "}") { flush(); out.push(ch); continue; }
    if (ch === "&" || ch === "|") {
      flush();
      if (line[i + 1] === ch) { out.push(ch + ch); i += 1; } else out.push(ch);
      continue;
    }
    word += ch; has = true;
  }
  flush();
  return out;
}

const baseProgram = (word: string): string => (word.split(/[\\/]/).pop() ?? word).toLowerCase();

function simpleCommandDeletes(words: string[], depth: number): boolean {
  let i = 0;
  // Leading env assignments, redirections and wrappers (with their own flags / assignments) do not change the program.
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^\d*[<>]/.test(w)) { i += 1; continue; }
    if (SHELL_WRAPPERS.has(baseProgram(w))) {
      i += 1;
      while (i < words.length && (words[i]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || /^\d+(\.\d+)?[smhd]?$/.test(words[i]!))) i += 1;
      continue;
    }
    break;
  }
  const head = words[i];
  if (!head) return false;
  const program = baseProgram(head);
  const rest = words.slice(i + 1);
  if (SHELL_DELETE_PROGRAMS.has(program)) return true;
  if (program === "git") {
    // `git -C <dir> rm a`, `git -c k=v clean -f`: the global options that take a value are skipped with it.
    let sub: string | undefined;
    for (let k = 0; k < rest.length; k += 1) {
      const word = rest[k]!;
      if (word === "-C" || word === "-c" || word === "--git-dir" || word === "--work-tree" || word === "--namespace") { k += 1; continue; }
      if (word.startsWith("-")) continue;
      sub = word; break;
    }
    return sub === "clean" || sub === "rm";
  }
  if (program === "find" || program === "gfind") {
    if (rest.includes("-delete")) return true;
    const exec = rest.findIndex((word) => word === "-exec" || word === "-execdir" || word === "-ok" || word === "-okdir");
    return exec >= 0 && simpleCommandDeletes(rest.slice(exec + 1), depth + 1);
  }
  if (depth >= 3) return false;
  // `sh -c '...'`, `bash -lc "..."`: the script is the word after the flag cluster that carries `c`.
  if (SHELL_INTERPRETERS.has(program)) {
    const flag = rest.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
    return flag >= 0 && rest[flag + 1] !== undefined && shellLineDeletes(rest[flag + 1]!, depth + 1);
  }
  if (program === "cmd" || program === "cmd.exe") {
    const flag = rest.findIndex((word) => /^\/[ck]$/i.test(word));
    return flag >= 0 && shellLineDeletes(rest.slice(flag + 1).join(" "), depth + 1);
  }
  if (program === "pwsh" || program === "powershell" || program === "powershell.exe") {
    const flag = rest.findIndex((word) => /^-(c|command)$/i.test(word));
    return flag >= 0 && shellLineDeletes(rest.slice(flag + 1).join(" "), depth + 1);
  }
  return false;
}

/**
 * A here-document body is data handed to a program (a file the model writes, a script it prints), not commands the shell runs: `cat > f.py <<'EOF' ... os.remove ... EOF`
 * writes a file. The body is cut out of the line before it is read. The one thing a body can still run is a `$( )` / backtick substitution, and only when the
 * delimiter is unquoted (the shell expands the body then); those pieces are returned to be read as commands. Quote-aware at the operator (`echo "<<EOF"` is text;
 * `<<<` is a here-string, whose word stays on the line). An unterminated body runs to the end of the text, as the shell reads it.
 */
function stripHeredocs(line: string): { line: string; substitutions: string[] } {
  if (!line.includes("<<")) return { line, substitutions: [] };
  let out = "";
  const substitutions: string[] = [];
  const pending: Array<{ delimiter: string; tabs: boolean; expands: boolean; runsBody: boolean }> = [];
  let quote: "" | "'" | '"' = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (quote === "'") { out += ch; if (ch === "'") quote = ""; i += 1; continue; }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < line.length) { out += ch + line[i + 1]; i += 2; continue; }
      out += ch; if (ch === '"') quote = ""; i += 1; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; i += 1; continue; }
    if (ch === "\\" && i + 1 < line.length) { out += ch + line[i + 1]; i += 2; continue; }
    if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<" && line[i - 1] !== "<") {
      let j = i + 2;
      const tabs = line[j] === "-";
      if (tabs) j += 1;
      while (line[j] === " " || line[j] === "\t") j += 1;
      let delimiter = "", expands = true;
      while (j < line.length && !/[\s;&|()<>]/.test(line[j]!)) {
        const c = line[j]!;
        if (c === "'" || c === '"') {
          expands = false;
          const end = line.indexOf(c, j + 1);
          const stop = end < 0 ? line.length : end;
          delimiter += line.slice(j + 1, stop);
          j = end < 0 ? line.length : end + 1;
        } else if (c === "\\") { expands = false; delimiter += line[j + 1] ?? ""; j += 2; }
        else { delimiter += c; j += 1; }
      }
      if (delimiter) {
        // A shell that reads its commands from the here-document (`bash <<EOF`, `cat <<EOF | sh`) runs the body: that body stays on the line.
        const eol = line.indexOf("\n", j);
        const tail = line.slice(j, eol < 0 ? line.length : eol);
        const receiver = shellWords((out.split(/&&|\|\||[;|&(){}\n]/).pop() ?? "")).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !SHELL_WRAPPERS.has(baseProgram(w)) && !w.startsWith("-"))[0];
        const runsBody = (receiver !== undefined && SHELL_INTERPRETERS.has(baseProgram(receiver)))
          || /\|\s*(?:(?:sudo|doas|env|exec|command)\s+)*(?:\S*\/)?(?:ba|z|da|k|a)?sh(?:\s|$)/.test(tail);
        pending.push({ delimiter, tabs, expands, runsBody });
        out += line.slice(i, j); i = j; continue;
      }
    }
    if (ch === "\n" && pending.length > 0) {
      out += "\n";
      i += 1;
      for (const doc of pending) {
        let body = "";
        while (i < line.length) {
          const eol = line.indexOf("\n", i);
          const text = line.slice(i, eol < 0 ? line.length : eol);
          i = eol < 0 ? line.length : eol + 1;
          if ((doc.tabs ? text.replace(/^\t+/, "") : text) === doc.delimiter) break;
          body += text + "\n";
        }
        if (doc.runsBody) out += body + doc.delimiter + "\n";
        else if (doc.expands) {
          for (const match of body.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) substitutions.push(match[1] ?? match[2] ?? "");
        }
      }
      pending.length = 0;
      continue;
    }
    out += ch; i += 1;
  }
  return { line: out, substitutions };
}

function shellLineDeletes(rawLine: string, depth: number): boolean {
  if (depth > 3 || !rawLine) return false;
  const { line, substitutions } = stripHeredocs(rawLine);
  if (substitutions.some((inner) => shellLineDeletes(inner, depth + 1))) return true;
  // `$( ... )` and backticks run a command wherever they stand, quoted or not.
  // (A single-quoted `$(...)` is text, not a command.)
  for (const match of line.replace(/'[^']*'/g, "''").matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    if (shellLineDeletes(match[1] ?? match[2] ?? "", depth + 1)) return true;
  }
  let current: string[] = [];
  for (const word of shellWords(line)) {
    if (SHELL_SEPARATORS.has(word)) {
      if (current.length > 0 && simpleCommandDeletes(current, depth)) return true;
      current = [];
    } else current.push(word);
  }
  return current.length > 0 && simpleCommandDeletes(current, depth);
}

/** Does this shell command line remove files (rm, rmdir, unlink, shred, trash, git clean / rm, find -delete / -exec rm, Remove-Item, del ...)? Read by what the line runs, never by a word of the text. */
export function shellCommandDeletes(command: string): boolean {
  return shellLineDeletes(command.slice(0, 20_000), 0);
}

/** The classes whose card offers "always allow" (everything the rule asks about except money). */
export const approvalAllowsAlways = (action: ApprovalActionClass): boolean => action === "delete" || action === "send";

/** Grants whose source is the host handing a session a blanket allow, not the owner pressing a card: they never answer this rule. */
export const NOT_OWNER_ANSWER_SOURCES: readonly string[] = ["one-delegation"];

/* ── What the model is told when a card ends without a "yes" (item 5) ─────────────────────────────────────────────── */

/** Why a call the rule asks about did not run. */
export type ApprovalRefusalCause = "owner_denied" | "no_answer" | "nobody_to_ask" | "app_owns_schedules";
/** `os_scheduler` is not a card: it is refused outright in every mode, so no one is asked (shellCommandRegistersScheduler, below). */
export interface ApprovalRefusal { action: Exclude<ApprovalActionClass, "other"> | "os_scheduler"; cause: ApprovalRefusalCause }

/**
 * Registered prompt module (docs/PROMPT-COMPOSITION-POLICY.md; ledger formula desktop.approval-rule.refusal-result, channel tool-result).
 * One fixed `key: value` line per fact, closed vocabularies only: nothing of the call, the owner or the machine is in it.
 */
export const APPROVAL_REFUSAL_RESULT_MODULE: { readonly id: string; readonly revision: number; readonly stability: "fixed-policy"; readonly changeTriggers: readonly "release"[]; readonly order: number } = {
  id: "approval.refusal.result", revision: 2, stability: "fixed-policy", changeTriggers: ["release"], order: 0,
};
const REFUSAL_NEXT: Readonly<Record<ApprovalRefusalCause, string>> = {
  owner_denied: "the owner said no to this call; do not repeat it; continue without it or ask the owner in your reply what they want instead",
  no_answer: "nobody answered the approval card before it closed (not a refusal); say in your reply what is waiting for approval, or continue another way; do not repeat this exact call now",
  nobody_to_ask: "this run has nobody to approve it (unattended); leave the payment undone and report it so the owner can do it in a conversation",
  app_owns_schedules: "OS schedulers (launchd, cron, at, systemd timers, Windows tasks) are not set up from a run; make the schedule as an app automation (read_automation_protocol, then the ## Automation block) so the owner can see and pause it, or give the owner the exact command to run themselves",
};
/** The line appended to a refused tool result. The same text on every surface that can return text to the model. */
export function approvalRefusalResultText(refusal: ApprovalRefusal): string {
  return `approval_refused: action=${refusal.action}; cause=${refusal.cause}; next=${REFUSAL_NEXT[refusal.cause]}`;
}

/* ── what a shell command line REGISTERS in an OS scheduler ─────────────────────────────────────────────────────────────────────────
 * Agentlas owns scheduling: a recurring or one-time job is an app automation, which the app lists, pauses, edits and deletes. A job a run puts in
 * launchd, cron, at, a systemd timer or the Windows Task Scheduler is none of that - the app cannot see or stop it (a "remind me at 14:00" turned into a
 * LaunchAgent in the person's home that the app never listed). Full access does not make it the owner's choice: the person asked for a reminder, not for a
 * system job, and One runs at full access by default. So this is refused in every mode, with a line that sends the model to the app automation.
 *
 * Read like the delete rule (shellCommandDeletes): the line is split at the unquoted separators, each simple command's PROGRAM is taken after env
 * assignments, redirections and wrappers, `sh -c '...'` / `cmd /c` / `powershell -Command` / `-EncodedCommand` / `$( )` / backticks / `eval` / `osascript do
 * shell script` are opened, and the program and its arguments decide - never a word of the text (`echo "launchctl load"`, `man crontab`, `launchctl list`,
 * `crontab -l` and `launchctl bootout` are not registrations). A file that puts a job in place counts too: a redirection, `cp`/`mv`/`tee`/`install`/`ln`,
 * `sed -i`, `plutil -convert`, `defaults write` or an interpreter's inline code that names a scheduler folder (LaunchAgents / LaunchDaemons, cron folders,
 * systemd unit folders - anchored at the root or the person's home, so a repository's own `Library/LaunchAgents` is not one). A script FILE the model wrote and
 * then runs, or `python -c` that spawns launchctl, is not visible here; the model is not an adversary, the aim is the accidental job. Pure; no imports. */
export type OsSchedulerKind = "launchd" | "cron" | "at" | "systemd" | "windows-task";

const LAUNCHCTL_REGISTERING = new Set(["load", "bootstrap", "enable", "kickstart", "submit"]);
const SYSTEMCTL_ENABLING = new Set(["enable", "reenable", "link", "preset", "preset-all"]);
const SYSTEMCTL_STARTING = new Set(["start", "restart", "reload-or-restart", "try-restart", "try-reload-or-restart"]);
const SYSTEMD_RUN_TIMER_FLAG = /^--(?:on-(?:active|boot|startup|unit-active|unit-inactive|calendar|clock-change|timezone-change)|timer-property)(?:=|$)/i;
const POWERSHELL_SCHEDULER_CMDLETS = new Set([
  "register-scheduledtask", "set-scheduledtask", "enable-scheduledtask", "register-scheduledjob", "set-scheduledjob", "enable-scheduledjob",
]);
/** Wrapper flags that take the next word as their value (`sudo -u me launchctl load x`). */
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "-R", "-T"]);
const CODE_INTERPRETERS = new Set(["python", "python2", "python3", "node", "nodejs", "deno", "bun", "perl", "ruby", "php", "lua", "osascript", "jxa"]);
/** Programs that put a file at their LAST operand (`cp a b`, `mv a b`, `ln -s a b`, `install -m 644 a b`, `rsync a b`, `ditto a b`). */
const DEST_LAST_WRITERS = new Set(["cp", "mv", "install", "ln", "rsync", "ditto", "gcp", "gmv", "ginstall", "gln"]);
/** Programs whose every operand is a file they write. */
const ALL_OPERAND_WRITERS = new Set(["tee", "touch", "truncate", "gtee", "gtouch"]);
const PLUTIL_WRITING_FLAGS = new Set(["-convert", "-insert", "-replace", "-remove", "-create"]);
const DEFAULTS_WRITING_SUBCOMMANDS = new Set(["write", "delete", "remove", "rename", "import"]);
const PLISTBUDDY_WRITING_VERB = /^(?:add|set|delete|merge|import|save|copy|clear)\b/i;
const AT_TIME_WORD = /^(?:now|noon|midnight|teatime|today|tomorrow|\d)/i;

/** The person's home written the ways a shell line spells it, or nothing (an absolute path from the root). */
const HOME_FORMS = String.raw`(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+|\/var\/root|\/root)?`;
/** The folders a scheduler reads its jobs from, anchored (the kind each belongs to is the index's second part). */
const SCHEDULER_FOLDERS: ReadonlyArray<readonly [RegExp, OsSchedulerKind]> = [
  [new RegExp(`^${HOME_FORMS}\\/Library\\/Launch(?:Agents|Daemons)(?:\\/|$)`, "i"), "launchd"],
  [/^\/etc\/(?:crontab|cron\.(?:d|daily|hourly|weekly|monthly))(?:\/|$)/i, "cron"],
  [/^\/var\/spool\/cron(?:\/|$)/i, "cron"],
  [/^\/var\/(?:spool\/)?at(?:\/|$)/i, "at"],
  [new RegExp(`^${HOME_FORMS}\\/\\.config\\/systemd\\/user(?:\\/|$)`, "i"), "systemd"],
  [/^\/(?:etc|usr\/lib|lib)\/systemd\/(?:system|user)(?:\/|$)/i, "systemd"],
];
/** The same folders named inside an interpreter's code (a quoted path: not anchored). */
const SCHEDULER_FOLDERS_IN_CODE: ReadonlyArray<readonly [RegExp, OsSchedulerKind]> = [
  [/\/Library\/Launch(?:Agents|Daemons)\b/i, "launchd"],
  [/\/etc\/cron(?:tab|\.(?:d|daily|hourly|weekly|monthly))\b|\/var\/spool\/cron\b/i, "cron"],
  [/\.config\/systemd\/user\b|\/etc\/systemd\/(?:system|user)\b/i, "systemd"],
];

const normalizedPath = (word: string): string => word.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/)/g, "");

/** The scheduler a path (an operand or a redirection target) puts a job in, or null. */
function schedulerFolderKind(word: string): OsSchedulerKind | null {
  const path = normalizedPath(word);
  for (const [folder, kind] of SCHEDULER_FOLDERS) if (folder.test(path)) return kind;
  return null;
}

/** Does a file tool's path (Write / Edit / an ACP edit / a patch) put a file in a scheduler folder? Anchored: a repository's own `Library/LaunchAgents` is not one. */
export function osSchedulerFilePath(path: string): boolean {
  return typeof path === "string" && path.length > 0 && path.length <= 4096 && schedulerFolderKind(path) !== null;
}

function schedulerFolderKindInCode(code: string): OsSchedulerKind | null {
  for (const [folder, kind] of SCHEDULER_FOLDERS_IN_CODE) if (folder.test(code)) return kind;
  return null;
}

/** `schtasks.exe` and `schtasks` are one program; `.cmd` / `.bat` / `.com` likewise. */
const programName = (word: string): string => baseProgram(word).replace(/\.(?:exe|cmd|bat|com)$/, "");
const operandsOf = (rest: string[]): string[] => rest.filter((word) => word === "-" || !word.startsWith("-"));
const isRelativeOperand = (word: string): boolean => !/^[/~$-]/.test(word) && !/^[A-Za-z]:[\\/]/.test(word);

/** Words that follow a heredoc operator's receiver: the body of one the receiving program does not run as shell is data (or code for an interpreter), not commands. */
function splitHeredocs(text: string): { text: string; interpreterBodies: string[] } {
  const lines = text.split("\n");
  const bodies: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opener = /<<(?!<)-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[index]!);
    if (!opener) continue;
    const before = lines[index]!.slice(0, opener.index).split(/&&|\|\||[;|&(){}]/).pop() ?? "";
    const words = shellWords(before);
    let head = 0;
    while (head < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[head]!) || SHELL_WRAPPERS.has(programName(words[head]!)) || words[head]!.startsWith("-"))) head += 1;
    const receiver = programName(words[head] ?? "");
    let end = index + 1;
    while (end < lines.length && lines[end]!.trim() !== opener[2]) end += 1;
    if (!SHELL_INTERPRETERS.has(receiver)) {
      if (CODE_INTERPRETERS.has(receiver) || /^python[0-9.]*$/.test(receiver)) bodies.push(lines.slice(index + 1, end).join("\n"));
      for (let body = index + 1; body < end && body < lines.length; body += 1) lines[body] = "";
    }
    index = end;
  }
  return { text: lines.join("\n"), interpreterBodies: bodies };
}

/** The file operands a known writer program puts a file at, for the programs that can put a job file in place. */
function writerTargets(program: string, rest: string[]): string[] {
  const operands = operandsOf(rest);
  if (DEST_LAST_WRITERS.has(program)) {
    const dirFlag = rest.findIndex((word) => word === "-t" || word === "--target-directory");
    if (dirFlag >= 0 && rest[dirFlag + 1]) return [rest[dirFlag + 1]!];
    const attached = rest.find((word) => word.startsWith("--target-directory="));
    if (attached) return [attached.slice("--target-directory=".length)];
    return operands.length >= 2 ? [operands[operands.length - 1]!] : [];
  }
  if (ALL_OPERAND_WRITERS.has(program)) return operands;
  if (program === "dd") return rest.filter((word) => word.startsWith("of=")).map((word) => word.slice(3));
  if (program === "curl") {
    const out: string[] = [];
    for (let k = 0; k < rest.length; k += 1) {
      if ((rest[k] === "-o" || rest[k] === "--output") && rest[k + 1]) out.push(rest[k + 1]!);
      else if (rest[k]!.startsWith("--output=")) out.push(rest[k]!.slice("--output=".length));
    }
    return out;
  }
  if (program === "wget") {
    const out: string[] = [];
    for (let k = 0; k < rest.length; k += 1) {
      if ((rest[k] === "-O" || rest[k] === "--output-document" || rest[k] === "-P" || rest[k] === "--directory-prefix") && rest[k + 1]) out.push(rest[k + 1]!);
      else if (rest[k]!.startsWith("--output-document=") || rest[k]!.startsWith("--directory-prefix=")) out.push(rest[k]!.slice(rest[k]!.indexOf("=") + 1));
    }
    return out;
  }
  if (program === "sed" || program === "gsed" || program === "perl") {
    return rest.some((word) => /^-[A-Za-z]*i/.test(word) || word.startsWith("--in-place")) ? operands : [];
  }
  if (program === "plutil") return rest.some((word) => PLUTIL_WRITING_FLAGS.has(word)) ? operands : [];
  if (program === "defaults") {
    const sub = operands[0];
    return sub !== undefined && DEFAULTS_WRITING_SUBCOMMANDS.has(sub) ? operands.slice(1) : [];
  }
  if (program === "plistbuddy") return rest.some((word) => PLISTBUDDY_WRITING_VERB.test(word)) ? operands : [];
  return [];
}

interface SchedulerWalkState { cdKind: OsSchedulerKind | null }

function schedulerOfSimpleCommand(words: string[], depth: number, state: SchedulerWalkState): OsSchedulerKind | null {
  // Redirection targets anywhere in the command (`cat > ~/Library/LaunchAgents/x.plist`, `echo x >> /etc/crontab`).
  for (let k = 0; k < words.length; k += 1) {
    const word = words[k]!;
    let target: string | undefined;
    const bare = /^\d*>>?\|?$|^&>>?$/.exec(word);
    if (bare) target = words[k + 1];
    else { const attached = /^(?:\d*>>?\|?|&>>?)(.+)$/.exec(word); if (attached) target = attached[1]; }
    if (target) {
      const kind = schedulerFolderKind(target) ?? (state.cdKind && isRelativeOperand(target) ? state.cdKind : null);
      if (kind) return kind;
    }
  }
  let i = 0;
  let queryOnly = false;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^\d*[<>]/.test(w) || /^&>/.test(w)) { i += 1; continue; }
    const wrapper = programName(w);
    if (SHELL_WRAPPERS.has(wrapper)) {
      i += 1;
      while (i < words.length && (words[i]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || /^\d+(\.\d+)?[smhd]?$/.test(words[i]!))) {
        // `command -v x` / `command -V x` look a program up; they do not run it.
        if ((wrapper === "command" || wrapper === "builtin") && /^-[vV]$/.test(words[i]!)) queryOnly = true;
        if ((wrapper === "sudo" || wrapper === "doas") && WRAPPER_VALUE_FLAGS.has(words[i]!)) i += 1;
        i += 1;
      }
      continue;
    }
    break;
  }
  const head = words[i];
  if (!head || queryOnly) return null;
  const program = programName(head);
  const rest = words.slice(i + 1);
  const operands = operandsOf(rest);

  if (program === "cd" || program === "pushd") {
    const kind = operands[0] ? schedulerFolderKind(operands[0]) : null;
    state.cdKind = kind;
    return null;
  }
  if (program === "launchctl") {
    const sub = operands[0];
    if (sub !== undefined && LAUNCHCTL_REGISTERING.has(sub)) return "launchd";
    // `launchctl asuser <uid> launchctl load x`: what follows the uid runs as that user.
    if (sub === "asuser" && depth < 3 && operands.length > 2) return schedulerOfSimpleCommand(rest.slice(rest.indexOf(operands[1]!) + 1), depth + 1, state);
    return null;
  }
  if (program === "crontab") return rest.some((word) => /^-[A-Za-z]*[lr][A-Za-z]*$/.test(word)) ? null : "cron";
  if (program === "batch") return "at";
  if (program === "at") {
    if (rest.some((word) => /^-[A-Za-z]*[lrdcV][A-Za-z]*$/.test(word))) return null;
    return rest.some((word) => AT_TIME_WORD.test(word) || word === "-f" || word === "-t") ? "at" : null;
  }
  if (program === "systemctl") {
    const sub = operands.find((word) => SYSTEMCTL_ENABLING.has(word) || SYSTEMCTL_STARTING.has(word));
    if (sub === undefined) return null;
    const timer = operands.some((word) => /\.timer$/i.test(word));
    if (SYSTEMCTL_STARTING.has(sub)) return timer ? "systemd" : null;
    return timer || rest.includes("--user") ? "systemd" : null;
  }
  if (program === "systemd-run") return rest.some((word) => SYSTEMD_RUN_TIMER_FLAG.test(word)) ? "systemd" : null;
  // A Windows path in double quotes loses its backslashes in shellWords ("C:\\Windows\\System32\\schtasks.exe" -> one word), so these two are matched by the end of the word.
  const nameEnds = (name: string): boolean => program === name || program.endsWith(name);
  if (nameEnds("schtasks")) return rest.some((word) => /^\/(?:create|change)$/i.test(word)) ? "windows-task" : null;
  if ([...POWERSHELL_SCHEDULER_CMDLETS].some(nameEnds)) return "windows-task";

  // Files that put a job in place.
  for (const target of writerTargets(program, rest)) {
    const kind = schedulerFolderKind(target) ?? (state.cdKind && isRelativeOperand(target) ? state.cdKind : null);
    if (kind) return kind;
  }

  if (depth >= 3) return null;
  // `eval "launchctl load x"`: its words are a command line.
  if (program === "eval") return schedulerOfLine(rest.join(" "), depth + 1, state);
  // `sh -c '...'`, `bash -lc "..."`, `su -c '...'`: the script is the word after the flag cluster that carries `c`.
  if (SHELL_INTERPRETERS.has(program) || program === "su") {
    const flag = rest.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
    return flag >= 0 && rest[flag + 1] !== undefined ? schedulerOfLine(rest[flag + 1]!, depth + 1, state) : null;
  }
  if (program === "cmd") {
    const flag = rest.findIndex((word) => /^\/[ck]$/i.test(word));
    return flag >= 0 ? schedulerOfLine(rest.slice(flag + 1).join(" "), depth + 1, state) : null;
  }
  if (program === "pwsh" || program === "powershell") {
    const flag = rest.findIndex((word) => /^-(?:c|command)$/i.test(word));
    if (flag >= 0) return schedulerOfLine(rest.slice(flag + 1).join(" "), depth + 1, state);
    const encoded = rest.findIndex((word) => /^-e(?:nc(?:odedcommand)?)?$/i.test(word));
    if (encoded >= 0 && rest[encoded + 1]) {
      try { return schedulerOfLine(Buffer.from(rest[encoded + 1]!, "base64").toString("utf16le"), depth + 1, state); } catch { return null; }
    }
    return null;
  }
  if (program === "osascript" || program === "jxa") {
    // AppleScript: `do shell script "launchctl load x"` runs the quoted text as a shell line.
    for (const word of rest) {
      for (const match of word.matchAll(/do shell script\s+"((?:[^"\\]|\\.)*)"/gi)) {
        const inner = schedulerOfLine(match[1]!.replace(/\\(["\\])/g, "$1"), depth + 1, state);
        if (inner) return inner;
      }
    }
  }
  // An interpreter's inline code that names a scheduler folder (`python3 -c "open('/Users/me/Library/LaunchAgents/x.plist','w')..."`).
  if (CODE_INTERPRETERS.has(program) || /^python[0-9.]*$/.test(program)) {
    for (const word of rest) { const kind = schedulerFolderKindInCode(word); if (kind) return kind; }
  }
  return null;
}

function schedulerOfLine(line: string, depth: number, state: SchedulerWalkState = { cdKind: null }): OsSchedulerKind | null {
  if (depth > 3 || !line) return null;
  const { text, interpreterBodies } = splitHeredocs(line);
  // `$( ... )` and backticks run a command wherever they stand, quoted or not (a single-quoted `$(...)` is text).
  for (const match of text.replace(/'[^']*'/g, "''").matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const inner = schedulerOfLine(match[1] ?? match[2] ?? "", depth + 1, state);
    if (inner) return inner;
  }
  let current: string[] = [];
  for (const word of shellWords(text)) {
    if (SHELL_SEPARATORS.has(word)) {
      if (current.length > 0) { const kind = schedulerOfSimpleCommand(current, depth, state); if (kind) return kind; }
      current = [];
    } else current.push(word);
  }
  if (current.length > 0) { const kind = schedulerOfSimpleCommand(current, depth, state); if (kind) return kind; }
  for (const body of interpreterBodies) { const kind = schedulerFolderKindInCode(body); if (kind) return kind; }
  return null;
}

/** Which OS scheduler does this shell command line register a job in (launchctl load / bootstrap / enable / kickstart / submit, crontab install, at, systemctl enable of a timer or a user unit, schtasks /create, Register-ScheduledTask, a file put in a scheduler folder)? null when it registers none. */
export function shellCommandRegistersScheduler(command: string): OsSchedulerKind | null {
  return typeof command === "string" && command ? schedulerOfLine(command.slice(0, 20_000), 0) : null;
}

/**
 * The ask-shaped question the arbiter and the hooks share: a shell command line, or a file tool's path (an ACP / builtin edit, a patch), that puts a job in an OS scheduler.
 * `detail` is read for an edit only (it is the path there); a shell ask is read by its `command`, never by its display detail.
 */
export function askRegistersOsScheduler(ask: { command?: unknown; kind?: unknown; detail?: unknown; arguments?: unknown }): OsSchedulerKind | null {
  if (typeof ask.command === "string" && ask.command) { const kind = shellCommandRegistersScheduler(ask.command); if (kind) return kind; }
  if (ask.kind === "edit") {
    const paths: unknown[] = [ask.detail];
    if (ask.arguments && typeof ask.arguments === "object" && !Array.isArray(ask.arguments)) {
      const args = ask.arguments as Record<string, unknown>;
      for (const key of ["path", "file_path", "filePath", "file", "target", "destination", "notebook_path"]) paths.push(args[key]);
    }
    for (const value of paths) {
      const kind = typeof value === "string" && value.length <= 4096 ? schedulerFolderKind(value.trim()) : null;
      if (kind) return kind;
    }
  }
  return null;
}
