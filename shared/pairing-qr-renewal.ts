/**
 * The pairing QR lives two minutes (electron/mobile-bridge/pairing.ts, a credential). When it ran out while the person was still
 * looking at the Settings card, the card went blank with "Create a new one" - a dead end for someone fumbling with a phone camera
 * (catalog mobile-session.md R10). While the window is visible the Desktop makes the next one itself, at most this many times per manual
 * request, so an unattended card cannot show a live credential for ever; after that the card ends as before.
 */
export const PAIRING_QR_AUTO_RENEWALS = 3;

export function pairingQrShouldRenew(input: { visible: boolean; renewals: number }): boolean {
  return input.visible && Number.isInteger(input.renewals) && input.renewals >= 0 && input.renewals < PAIRING_QR_AUTO_RENEWALS;
}
