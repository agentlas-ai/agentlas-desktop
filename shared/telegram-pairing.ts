// Telegram deep-link pairing (owner decision OD-3, 2026-10-16). A manual-token connection offers
// https://t.me/<bot>?start=<bindingId>; Telegram's Start button then sends "/start <bindingId>", the exact
// pairing proof both hosts accept (desktop telegram/connect.ts tryPairBindingWithToken, terminal
// engine/telegram/connect.cjs pairByPolling). One rule for the Main message and the renderer card.

// Bot usernames: 5-32 characters of letters, digits and underscores. Deep-link start parameters: up to
// 64 characters of A-Z, a-z, 0-9, "_" and "-" (Telegram Bot API, "Deep linking").
const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/u;
const START_PARAMETER = /^[A-Za-z0-9_-]{1,64}$/u;

export function telegramPairingLink(botUsername: string | null | undefined, bindingId: string): string | null {
  const bot = String(botUsername ?? "").replace(/^@/u, "");
  if (!BOT_USERNAME.test(bot) || !START_PARAMETER.test(bindingId)) return null;
  return `https://t.me/${bot}?start=${bindingId}`;
}

export function telegramPairingCommand(bindingId: string): string {
  return `/start ${bindingId}`;
}
