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

function shellLineDeletes(line: string, depth: number): boolean {
  if (depth > 3 || !line) return false;
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
export type ApprovalRefusalCause = "owner_denied" | "no_answer" | "nobody_to_ask";
export interface ApprovalRefusal { action: Exclude<ApprovalActionClass, "other">; cause: ApprovalRefusalCause }

/**
 * Registered prompt module (docs/PROMPT-COMPOSITION-POLICY.md; ledger formula desktop.approval-rule.refusal-result, channel tool-result).
 * One fixed `key: value` line per fact, closed vocabularies only: nothing of the call, the owner or the machine is in it.
 */
export const APPROVAL_REFUSAL_RESULT_MODULE: { readonly id: string; readonly revision: number; readonly stability: "fixed-policy"; readonly changeTriggers: readonly "release"[]; readonly order: number } = {
  id: "approval.refusal.result", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 0,
};
const REFUSAL_NEXT: Readonly<Record<ApprovalRefusalCause, string>> = {
  owner_denied: "the owner said no to this call; do not repeat it; continue without it or ask the owner in your reply what they want instead",
  no_answer: "nobody answered the approval card before it closed (not a refusal); say in your reply what is waiting for approval, or continue another way; do not repeat this exact call now",
  nobody_to_ask: "this run has nobody to approve it (unattended); leave the payment undone and report it so the owner can do it in a conversation",
};
/** The line appended to a refused tool result. The same text on every surface that can return text to the model. */
export function approvalRefusalResultText(refusal: ApprovalRefusal): string {
  return `approval_refused: action=${refusal.action}; cause=${refusal.cause}; next=${REFUSAL_NEXT[refusal.cause]}`;
}
