# PRD: Agentlas Mobile Desktop Mirror

- **Project**: agentlas-desktop
- **Slug**: 20260711-agentlas-mobile-desktop-mirror
- **Opened**: 2026-07-11 by ceo/prd-keeper (triggered by: make the Flutter app a real mirror of this Mac's Agentlas Desktop)
- **Status**: shipped
- **Supersedes**: none
- **Superseded by**: none

## 1. Problem

The current Flutter app presents deterministic demo agents, chats, usage, and approvals even when it is not connected to Agentlas Desktop. Its conversation view also uses generic message bubbles and a document-style composer, so it does not faithfully mirror the terminal-oriented Agentlas Desktop/Codex work session.

## 2. Scope

### In
- Render agents, chats, messages, runs, usage, and approvals only from a connected Agentlas Desktop.
- Replace assistant message bubbles with a white-mode terminal transcript that preserves tool calls, progress, final output, and errors.
- Keep the composer visible above the software keyboard and support steering an active run from the same field.
- Surface only approval requests emitted by Desktop; the phone does not invent payment or device-authentication approval flows.
- Implement and document the Desktop bridge, pairing/authentication boundary, snapshot/event protocol, reconnect behavior, and every remaining wiring seam.
- Test against the Agentlas Desktop/runtime running on this Mac with no mock fallback.
- Repair layout clipping, overflow, safe-area, keyboard, sheet, and segmented-control regressions across EN/KO.

### Out
- Running an LLM or agent runtime directly on the phone.
- Reimplementing Desktop business rules, credentials, browser sessions, approvals, or local filesystem access in Flutter.
- Cloud relay, public Internet exposure, store submission, or production deployment.

## 3. Decisions

- **Desktop is authoritative**: Flutter is a projection and command surface, never an independent source of agent state or permissions.
- **Disconnected means disconnected**: production startup must show pairing/reconnect state and must not silently instantiate mock data.
- **Desktop owns approval policy**: mobile may answer a Desktop request but may not add device-authentication or payment semantics that Desktop did not request.
- **Chat is a live work log**: assistant output is rendered as terminal-like transcript blocks; the user composer remains available for steering while a run is active.
- **One versioned bridge contract**: snapshots, ordered events, requests, acknowledgements, replay, and protocol mismatch are explicit and testable.
- **Local-first transport**: this milestone connects to the current Mac on loopback/LAN/Tailscale; remote Cloud relay is not implied.

## 4. Logic & Features (living section)

- Desktop bridge: publishes a secret-free mobile snapshot and ordered runtime events, accepts authenticated read/command requests, and rejects unsupported protocol versions.
- Flutter connection bootstrap: loads a saved Desktop endpoint/pairing credential, connects, displays live connection state, and exposes an explicit retry/pairing flow when unavailable.
- Chat transcript: maps Desktop user, assistant, tool, progress, result, and error events without synthesized demo messages.
- Composer: follows IME insets, scrolls the transcript to the active turn, sends a new prompt while idle, and sends a steering instruction while the Desktop run is active.
- Approvals are a discriminated Desktop-origin union, not one generic mobile action:
  - `chat_question`: Desktop derives unanswered structured questions from the latest assistant message. Mobile submits one composed user reply to that same `chatId`; it does not call an approval resolver and does not add payment or device-authentication meaning.
  - `browser_action`: Desktop emits a live, expiring request with an opaque `requestId` and allowed decisions (`once`, optional `always`, or `deny`). Mobile returns that exact request ID and one allowed decision; an expired, missing, disconnected, or already-resolved request is unavailable and fails closed.
- Browser payment is merely an `actionType` chosen by Desktop policy. Mobile never fabricates an amount, merchant, screenshot, extra authentication requirement, or approval record.
- Wiring ledger: source comments and protocol docs identify Desktop producers, Flutter consumers, authentication, and any intentionally deferred work.

## 5. Acceptance Criteria

- [x] No assistant output is rendered in a chat bubble.
- [x] The composer remains visible and editable with iOS and Android keyboards open.
- [x] A running Desktop chat accepts a steering message and the UI labels the action as steering.
- [x] No mobile-only device-authentication/payment approval path remains.
- [x] A chat question is resolved only by a user reply on its source chat; no generic `approvals.resolve` call is used.
- [x] A browser action can be resolved only while its Desktop-issued opaque request is live, and an expired request fails closed.
- [x] With Desktop stopped, the app shows a disconnected state and zero hardcoded agents/chats/approvals.
- [x] With the current Mac Desktop running, live agents/chats/messages and subsequent stream updates render in Flutter.
- [x] Every mobile command is acknowledged or shown as a recoverable Desktop/transport error.
- [x] Segment controls, tab bar, sheets, EN/KO text, and compact/wide viewport tests have no overflow or clipping.
- [x] Flutter analysis/tests, Desktop typecheck/tests, iOS simulator build, and Android build pass.

## 6. Change Log

### 2026-07-11 — Opened the Desktop mirror contract
- **Actor agents**: ceo, hr-director-mobile-dev, hr-director-platform, hr-director-designer, hr-director-qa
- **Outcome**: partial
- **Files touched**: 3 (`docs/prds/INDEX.md`, this PRD, `docs/sitemap.yaml`)
- **What changed**: fixed Desktop authority, no-fallback behavior, terminal chat, steering, Desktop-origin approval, and bridge acceptance criteria before implementation.
- **Why**: the prior 54-screen demo contract permitted mobile-owned state that contradicts the required mirror role.
- **Residual risk**: the current Desktop's externally reachable bridge and pairing boundary still require source/runtime audit.
- **Tests / verification**: pre-work gate only; implementation verification pending.

### 2026-07-11 — Corrected approval and wiring authority
- **Actor agents**: ceo, hr-director-platform, hr-director-mobile-dev, desktop-product-contract
- **Outcome**: partial
- **Files touched**: documentation contract only
- **What changed**: split Desktop-origin approvals into `chat_question` reply and expiring `browser_action` resolution; prohibited mobile-authored payment and device-authentication semantics; linked the implementation to the versioned Bridge and wiring ledger.
- **Why**: the existing Desktop does not expose one universal approval record. Chat questions continue through chat, while browser actions use an opaque live request broker.
- **Residual risk**: implementation and current-Mac runtime proof remain open until the Desktop Bridge and Flutter production transport are wired.
- **Tests / verification**: documentation consistency checks only; no runtime completion claim.

### 2026-07-11 — Shipped the authenticated Desktop mirror
- **Actor agents**: AppBridge CEO Swarm, mobile-dev, platform, design, risk-assurance, Hub `electron-expert`, Bug Hunter skeptic
- **Outcome**: pass
- **Files touched**: Desktop Mobile Bridge/schema/Settings/tests, Flutter transport/state/chat/UI/l10n/native shells, canonical 54-screen design set, protocol and wiring docs
- **What changed**: added one-time QR pairing and per-device revoke, self-pinned WSS, secret-free bounded projection, durable write idempotency, exact Desktop question/browser approval mapping, up to 32 separately authenticated Desktop sessions, host-exact agent routing, Codex-style transcript and steering composer, EN/KO 54-screen parity, and generated brand launch assets.
- **Why**: Mobile now acts only as a secure command/projection companion for the connected Desktop instead of pretending to own agents, approval policy, or sample runtime state.
- **Residual risk**: real-device LAN/background lifecycle and store signing/submission remain release gates; 32 canonical screen IDs whose Desktop v1 producer does not exist are retained but unreachable behind `hidden-until-wired`.
- **Tests / verification**: Desktop typecheck, production build, bridge contract, Settings lifecycle, zero production npm vulnerabilities, current-Mac live bridge smoke (30 agents, 11 chats, invoke stream, steering replacement, history and archive round-trip), Flutter analyze, 219-test suite plus opt-in live pinned-WSS test, iOS Simulator build/visual inspection, Android release APK, and canonical design validator all passed.

## 7. Residual Risk

- The bridge now authenticates per-device credentials, pins its WSS certificate, rate/size limits requests, redacts projected content, and negotiates protocol v1; Internet/Cloud Relay exposure is still intentionally unsupported.
- iOS Simulator and a same-Mac source run do not prove real-phone LAN/Tailscale discovery, background reconnect, notification delivery, signing, or store review. Those stay explicit release gates.
- Browser approval broker/Bridge/Flutter contract tests pass, but the same-Mac smoke did not force a new real browser action. Capture one user-generated browser request and exact Mobile resolution on a real phone before release.
- 32 canonical design screen IDs do not yet have a Desktop v1 producer. They are preserved for scope parity but production navigation and actions fail closed behind `hidden-until-wired`; no sample success state substitutes for them.
