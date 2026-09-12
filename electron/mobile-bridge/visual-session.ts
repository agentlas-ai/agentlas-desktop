import { createHash, randomUUID } from "node:crypto";
import { screen, type BrowserWindow } from "electron";

import {
  MOBILE_BRIDGE_VISUAL_FRAME_MAX_BYTES,
  MOBILE_BRIDGE_VISUAL_SESSION_VERSION,
  type MobileBridgeVisualFrameDto,
  type MobileBridgeJsonValue,
  type MobileBridgeVisualInputActionDto,
  type MobileBridgeVisualInputReceiptDto,
  type MobileBridgeVisualSessionDto,
  type MobileBridgeVisualSessionRefusalCode,
  type MobileBridgeVisualSessionRefusalDto,
  type MobileBridgeVisualSourceDto,
} from "../../shared/mobile-bridge";
import type { MobileBridgeConnectionContext } from "./server";

const VISUAL_SESSION_TTL_MS = 5 * 60_000;
const VISUAL_INPUT_LEASE_MS = 15_000;
const MAX_VISUAL_SESSIONS = 8;
const MAX_VISUAL_SESSIONS_PER_DEVICE = 2;

export interface MobileVisualCapturedFrame {
  source: MobileBridgeVisualSourceDto;
  mimeType: "image/jpeg";
  bytes: Buffer;
}

export interface MobileVisualSessionControl {
  describe(): MobileBridgeVisualSourceDto | null;
  capture(input: {
    maxWidth: number;
    maxHeight: number;
  }): Promise<MobileVisualCapturedFrame>;
  input(action: MobileBridgeVisualInputActionDto): Promise<void>;
}

export interface MobileBridgeVisualBinaryFrame {
  metadata: MobileBridgeVisualFrameDto;
  bytes: Buffer;
}

interface VisualSessionState {
  visualSessionId: string;
  sessionEpoch: string;
  deviceId: string;
  source: MobileBridgeVisualSourceDto;
  inputOwner: "desktop" | "mobile";
  ownerEpoch: number;
  ownerDeviceId: string | null;
  leaseExpiresAtMs: number | null;
  nextInputSeq: number;
  latestFrameId: string | null;
  latestFrameSeq: number;
  compositionText: string | null;
  createdAtMs: number;
  lastAccessAtMs: number;
}

function sourceEqual(a: MobileBridgeVisualSourceDto, b: MobileBridgeVisualSourceDto): boolean {
  return a.sourceId === b.sourceId
    && a.sourceGeneration === b.sourceGeneration
    && a.layoutId === b.layoutId
    && a.width === b.width
    && a.height === b.height
    && a.scaleFactor === b.scaleFactor;
}

function refusal(
  code: MobileBridgeVisualSessionRefusalCode,
  message: string,
  session?: VisualSessionState,
): MobileBridgeVisualSessionRefusalDto {
  return {
    schemaVersion: MOBILE_BRIDGE_VISUAL_SESSION_VERSION,
    status: "refused",
    code,
    message,
    ...(session ? {
      visualSessionId: session.visualSessionId,
      sessionEpoch: session.sessionEpoch,
      sourceGeneration: session.source.sourceGeneration,
      layoutId: session.source.layoutId,
      ownerEpoch: session.ownerEpoch,
      nextInputSeq: session.nextInputSeq,
    } : {}),
  };
}

function sessionDto(session: VisualSessionState): MobileBridgeVisualSessionDto {
  return {
    schemaVersion: MOBILE_BRIDGE_VISUAL_SESSION_VERSION,
    visualSessionId: session.visualSessionId,
    sessionEpoch: session.sessionEpoch,
    status: "live",
    source: session.source,
    inputOwner: session.inputOwner,
    ownerEpoch: session.ownerEpoch,
    leaseExpiresAt: session.leaseExpiresAtMs === null
      ? null
      : new Date(session.leaseExpiresAtMs).toISOString(),
    nextInputSeq: session.nextInputSeq,
    latestFrameId: session.latestFrameId,
    latestFrameSeq: session.latestFrameSeq,
  };
}

export class MobileVisualSessionManager {
  private readonly sessions = new Map<string, VisualSessionState>();
  private disposed = false;

  constructor(private readonly control?: MobileVisualSessionControl) {}

  get supported(): boolean {
    return Boolean(this.control);
  }

  capability(): MobileBridgeJsonValue | null {
    if (!this.control) return null;
    return {
      schemaVersion: MOBILE_BRIDGE_VISUAL_SESSION_VERSION,
      sourceKinds: ["agentlas-main-window"],
      frameTransport: "binary-pull",
      frameCodecs: ["image/jpeg"],
      maxFrameBytes: MOBILE_BRIDGE_VISUAL_FRAME_MAX_BYTES,
      inputKinds: ["pointer", "scroll", "key", "shortcut", "composition", "commitText", "focus"],
      leaseMs: VISUAL_INPUT_LEASE_MS,
    };
  }

  create(context: MobileBridgeConnectionContext): MobileBridgeVisualSessionDto | MobileBridgeVisualSessionRefusalDto {
    this.assertOpen();
    this.prune();
    const source = this.control?.describe() ?? null;
    if (!source) {
      return refusal("visual_unavailable", "The Agentlas window is not available for a visual session.");
    }
    this.enforceBounds(context.deviceId);
    const now = Date.now();
    const session: VisualSessionState = {
      visualSessionId: `visual_${randomUUID()}`,
      sessionEpoch: `ve_${randomUUID()}`,
      deviceId: context.deviceId,
      source,
      inputOwner: "desktop",
      ownerEpoch: 0,
      ownerDeviceId: null,
      leaseExpiresAtMs: null,
      nextInputSeq: 1,
      latestFrameId: null,
      latestFrameSeq: 0,
      compositionText: null,
      createdAtMs: now,
      lastAccessAtMs: now,
    };
    this.sessions.set(session.visualSessionId, session);
    return sessionDto(session);
  }

  get(
    visualSessionId: string,
    sessionEpoch: string,
    context: MobileBridgeConnectionContext,
  ): MobileBridgeVisualSessionDto | MobileBridgeVisualSessionRefusalDto {
    this.assertOpen();
    const session = this.resolve(visualSessionId, sessionEpoch, context);
    if (!("deviceId" in session)) return session;
    this.refreshSource(session);
    this.expireLease(session);
    session.lastAccessAtMs = Date.now();
    return sessionDto(session);
  }

  close(
    visualSessionId: string,
    sessionEpoch: string,
    context: MobileBridgeConnectionContext,
  ): MobileBridgeVisualSessionDto | MobileBridgeVisualSessionRefusalDto {
    this.assertOpen();
    const session = this.resolve(visualSessionId, sessionEpoch, context);
    if (!("deviceId" in session)) return session;
    this.sessions.delete(session.visualSessionId);
    session.inputOwner = "desktop";
    session.ownerEpoch += 1;
    session.ownerDeviceId = null;
    session.leaseExpiresAtMs = null;
    session.latestFrameId = null;
    session.compositionText = null;
    return { ...sessionDto(session), status: "stale" };
  }

  async frame(
    input: {
      visualSessionId: string;
      sessionEpoch: string;
      maxWidth?: number;
      maxHeight?: number;
    },
    context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeVisualBinaryFrame | MobileBridgeVisualSessionRefusalDto> {
    this.assertOpen();
    const session = this.resolve(input.visualSessionId, input.sessionEpoch, context);
    if (!("deviceId" in session)) return session;
    if (!this.control) return refusal("visual_unavailable", "Visual capture is unavailable.", session);
    const frame = await this.control.capture({
      maxWidth: input.maxWidth ?? 1_280,
      maxHeight: input.maxHeight ?? 960,
    });
    if (frame.bytes.byteLength > MOBILE_BRIDGE_VISUAL_FRAME_MAX_BYTES) {
      return refusal("visual_unavailable", "The captured frame exceeded the visual transport budget.", session);
    }
    if (!sourceEqual(session.source, frame.source)) this.replaceSource(session, frame.source);
    this.expireLease(session);
    session.latestFrameSeq += 1;
    session.latestFrameId = `vf_${randomUUID()}`;
    session.lastAccessAtMs = Date.now();
    const metadata: MobileBridgeVisualFrameDto = {
      schemaVersion: MOBILE_BRIDGE_VISUAL_SESSION_VERSION,
      visualSessionId: session.visualSessionId,
      sessionEpoch: session.sessionEpoch,
      frameId: session.latestFrameId,
      frameSeq: session.latestFrameSeq,
      source: session.source,
      mimeType: frame.mimeType,
      byteLength: frame.bytes.byteLength,
      contentSha256: createHash("sha256").update(frame.bytes).digest("hex"),
      capturedAt: new Date().toISOString(),
      inputOwner: session.inputOwner,
      ownerEpoch: session.ownerEpoch,
      leaseExpiresAt: session.leaseExpiresAtMs === null
        ? null
        : new Date(session.leaseExpiresAtMs).toISOString(),
      nextInputSeq: session.nextInputSeq,
    };
    return { metadata, bytes: frame.bytes };
  }

  takeover(
    input: {
      visualSessionId: string;
      sessionEpoch: string;
      sourceGeneration: string;
      layoutId: string;
      frameId: string;
      expectedOwnerEpoch: number;
    },
    context: MobileBridgeConnectionContext,
  ): MobileBridgeVisualSessionDto | MobileBridgeVisualSessionRefusalDto {
    this.assertOpen();
    const session = this.resolve(input.visualSessionId, input.sessionEpoch, context);
    if (!("deviceId" in session)) return session;
    const stale = this.validateObservation(session, input);
    if (stale) return stale;
    this.expireLease(session);
    if (session.ownerEpoch !== input.expectedOwnerEpoch) {
      return refusal("visual_owner_epoch_conflict", "Input ownership changed. Refresh the visual session.", session);
    }
    if (session.inputOwner === "mobile" && session.ownerDeviceId !== context.deviceId) {
      return refusal("visual_owner_conflict", "Another paired phone owns visual input.", session);
    }
    session.inputOwner = "mobile";
    session.ownerDeviceId = context.deviceId;
    session.ownerEpoch += 1;
    session.leaseExpiresAtMs = Date.now() + VISUAL_INPUT_LEASE_MS;
    session.compositionText = null;
    session.lastAccessAtMs = Date.now();
    return sessionDto(session);
  }

  release(
    input: { visualSessionId: string; sessionEpoch: string; ownerEpoch: number },
    context: MobileBridgeConnectionContext,
  ): MobileBridgeVisualSessionDto | MobileBridgeVisualSessionRefusalDto {
    this.assertOpen();
    const session = this.resolve(input.visualSessionId, input.sessionEpoch, context);
    if (!("deviceId" in session)) return session;
    this.expireLease(session);
    if (session.inputOwner !== "mobile" || session.ownerDeviceId !== context.deviceId) {
      return refusal("visual_owner_conflict", "This phone does not own visual input.", session);
    }
    if (session.ownerEpoch !== input.ownerEpoch) {
      return refusal("visual_owner_epoch_conflict", "Input ownership changed before release.", session);
    }
    this.releaseLease(session);
    return sessionDto(session);
  }

  async input(
    input: {
      visualSessionId: string;
      sessionEpoch: string;
      sourceGeneration: string;
      layoutId: string;
      frameId: string;
      ownerEpoch: number;
      inputSeq: number;
      action: MobileBridgeVisualInputActionDto;
    },
    context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeVisualInputReceiptDto | MobileBridgeVisualSessionRefusalDto> {
    this.assertOpen();
    const session = this.resolve(input.visualSessionId, input.sessionEpoch, context);
    if (!("deviceId" in session)) return session;
    const stale = this.validateObservation(session, input);
    if (stale) return stale;
    if (this.leaseExpired(session)) {
      this.releaseLease(session);
      return refusal("visual_lease_expired", "The visual input lease expired.", session);
    }
    if (session.inputOwner !== "mobile" || session.ownerDeviceId !== context.deviceId) {
      return refusal("visual_owner_conflict", "Take over visual input before sending an action.", session);
    }
    if (session.leaseExpiresAtMs === null) {
      return refusal("visual_lease_expired", "The visual input lease expired.", session);
    }
    if (session.ownerEpoch !== input.ownerEpoch) {
      return refusal("visual_owner_epoch_conflict", "The visual input owner epoch is stale.", session);
    }
    if (session.nextInputSeq !== input.inputSeq) {
      return refusal("visual_input_seq_conflict", "The visual input sequence is stale or skipped.", session);
    }
    if (!this.control) return refusal("visual_unavailable", "Visual input is unavailable.", session);

    let hostAction: MobileBridgeVisualInputActionDto | null = input.action;
    let frameInvalidated = true;
    if (input.action.kind === "composition") {
      if (input.action.phase === "start") {
        session.compositionText = "";
        hostAction = null;
        frameInvalidated = false;
      } else if (input.action.phase === "update") {
        if (session.compositionText === null) {
          return refusal("visual_input_unsupported", "Start composition before updating it.", session);
        }
        session.compositionText = input.action.text ?? "";
        hostAction = null;
        frameInvalidated = false;
      } else {
        if (session.compositionText === null) {
          return refusal("visual_input_unsupported", "Start composition before committing it.", session);
        }
        const text = input.action.text ?? session.compositionText;
        session.compositionText = null;
        hostAction = text.length > 0 ? { kind: "commitText", text } : null;
      }
    }
    try {
      if (hostAction) await this.control.input(hostAction);
    } catch {
      return refusal("visual_input_unsupported", "Desktop could not apply this visual input kind.", session);
    }
    session.nextInputSeq += 1;
    session.leaseExpiresAtMs = Date.now() + VISUAL_INPUT_LEASE_MS;
    session.lastAccessAtMs = Date.now();
    if (frameInvalidated) session.latestFrameId = null;
    return {
      schemaVersion: MOBILE_BRIDGE_VISUAL_SESSION_VERSION,
      status: "accepted",
      visualSessionId: session.visualSessionId,
      sessionEpoch: session.sessionEpoch,
      sourceGeneration: session.source.sourceGeneration,
      layoutId: session.source.layoutId,
      consumedFrameId: input.frameId,
      acceptedInputSeq: input.inputSeq,
      nextInputSeq: session.nextInputSeq,
      ownerEpoch: session.ownerEpoch,
      frameInvalidated,
      observedAt: new Date().toISOString(),
    };
  }

  closeDeviceSessions(deviceId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.deviceId === deviceId) this.sessions.delete(id);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.sessions.clear();
  }

  private resolve(
    visualSessionId: string,
    sessionEpoch: string,
    context: MobileBridgeConnectionContext,
  ): VisualSessionState | MobileBridgeVisualSessionRefusalDto {
    this.prune();
    const session = this.sessions.get(visualSessionId);
    if (!session || session.deviceId !== context.deviceId) {
      return refusal("visual_session_not_found", "The visual session is unavailable. Create a new session.");
    }
    if (session.sessionEpoch !== sessionEpoch) {
      return refusal("visual_session_epoch_conflict", "The visual session epoch is stale.", session);
    }
    return session;
  }

  private validateObservation(
    session: VisualSessionState,
    input: { sourceGeneration: string; layoutId: string; frameId: string },
  ): MobileBridgeVisualSessionRefusalDto | null {
    this.refreshSource(session);
    if (session.source.sourceGeneration !== input.sourceGeneration) {
      return refusal("visual_source_changed", "The Desktop visual source changed. Capture a new frame.", session);
    }
    if (session.source.layoutId !== input.layoutId) {
      return refusal("visual_layout_changed", "The Desktop layout changed. Capture a new frame.", session);
    }
    if (session.latestFrameId === null || session.latestFrameId !== input.frameId) {
      return refusal("visual_frame_stale", "The observed Desktop frame is stale. Capture a new frame.", session);
    }
    return null;
  }

  private refreshSource(session: VisualSessionState): void {
    const current = this.control?.describe() ?? null;
    if (!current) {
      session.latestFrameId = null;
      this.releaseLease(session);
      return;
    }
    if (!sourceEqual(session.source, current)) this.replaceSource(session, current);
  }

  private replaceSource(session: VisualSessionState, source: MobileBridgeVisualSourceDto): void {
    session.source = source;
    session.latestFrameId = null;
    session.latestFrameSeq = 0;
    session.nextInputSeq = 1;
    session.compositionText = null;
    this.releaseLease(session);
  }

  private expireLease(session: VisualSessionState): void {
    if (this.leaseExpired(session)) {
      this.releaseLease(session);
    }
  }

  private leaseExpired(session: VisualSessionState): boolean {
    return session.leaseExpiresAtMs !== null && session.leaseExpiresAtMs <= Date.now();
  }

  private releaseLease(session: VisualSessionState): void {
    if (session.inputOwner === "mobile" || session.ownerDeviceId !== null) session.ownerEpoch += 1;
    session.inputOwner = "desktop";
    session.ownerDeviceId = null;
    session.leaseExpiresAtMs = null;
    session.compositionText = null;
  }

  private enforceBounds(deviceId: string): void {
    const sessionsForDevice = [...this.sessions.values()]
      .filter((session) => session.deviceId === deviceId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    while (sessionsForDevice.length >= MAX_VISUAL_SESSIONS_PER_DEVICE) {
      const oldest = sessionsForDevice.shift();
      if (oldest) this.sessions.delete(oldest.visualSessionId);
    }
    const all = [...this.sessions.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
    while (all.length >= MAX_VISUAL_SESSIONS) {
      const oldest = all.shift();
      if (oldest) this.sessions.delete(oldest.visualSessionId);
    }
  }

  private prune(): void {
    const cutoff = Date.now() - VISUAL_SESSION_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.lastAccessAtMs < cutoff) this.sessions.delete(id);
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Mobile visual session manager is disposed");
  }
}

function shortHash(prefix: "vg" | "vl", value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

/**
 * Bounded first X05/X06 producer: one Agentlas BrowserWindow only. External
 * windows, OS capture, audio, and continuous streaming require later adapters.
 */
export function createAgentlasWindowVisualSessionControl(
  getWindow: () => BrowserWindow | null,
): MobileVisualSessionControl {
  const describe = (): MobileBridgeVisualSourceDto | null => {
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null;
    const bounds = window.getContentBounds();
    if (bounds.width < 1 || bounds.height < 1) return null;
    const webContents = window.webContents;
    const scaleFactor = screen.getDisplayMatching(window.getBounds()).scaleFactor || 1;
    const sourceGeneration = shortHash(
      "vg",
      `${window.id}:${webContents.id}:${webContents.getOSProcessId()}:${webContents.getURL()}`,
    );
    const layoutId = shortHash(
      "vl",
      `${sourceGeneration}:${bounds.width}:${bounds.height}:${scaleFactor}:${webContents.getZoomFactor()}`,
    );
    return {
      sourceId: "agentlas-main-window",
      sourceGeneration,
      layoutId,
      width: bounds.width,
      height: bounds.height,
      scaleFactor,
      colorSpace: "srgb",
    };
  };

  return {
    describe,
    async capture({ maxWidth, maxHeight }) {
      const window = getWindow();
      const before = describe();
      if (!window || !before) throw new Error("Agentlas main window is unavailable");
      let image = await window.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      });
      const ratio = Math.min(1, maxWidth / image.getSize().width, maxHeight / image.getSize().height);
      if (ratio < 1) {
        image = image.resize({
          width: Math.max(1, Math.floor(image.getSize().width * ratio)),
          height: Math.max(1, Math.floor(image.getSize().height * ratio)),
          quality: "good",
        });
      }
      let bytes = image.toJPEG(78);
      for (const quality of [65, 50, 35]) {
        if (bytes.byteLength <= MOBILE_BRIDGE_VISUAL_FRAME_MAX_BYTES) break;
        bytes = image.toJPEG(quality);
      }
      const after = describe();
      if (!after || !sourceEqual(before, after)) {
        throw new Error("Agentlas visual source changed during capture");
      }
      return { source: after, mimeType: "image/jpeg", bytes };
    },
    async input(action) {
      const window = getWindow();
      const source = describe();
      if (!window || !source) throw new Error("Agentlas main window is unavailable");
      const contents = window.webContents;
      const modifiers = "modifiers" in action ? action.modifiers : undefined;
      switch (action.kind) {
        case "focus":
          window.show();
          window.focus();
          contents.focus();
          return;
        case "pointer": {
          if (action.x >= source.width || action.y >= source.height) {
            throw new Error("Pointer coordinate is outside the observed layout");
          }
          const x = Math.round(action.x);
          const y = Math.round(action.y);
          const button = action.button ?? "left";
          contents.sendInputEvent({ type: "mouseMove", x, y });
          if (action.phase !== "move") {
            const clickCount = action.phase === "doubleClick" ? 2 : 1;
            contents.sendInputEvent({ type: "mouseDown", x, y, button, clickCount });
            contents.sendInputEvent({ type: "mouseUp", x, y, button, clickCount });
          }
          return;
        }
        case "scroll":
          if (action.x >= source.width || action.y >= source.height) {
            throw new Error("Scroll coordinate is outside the observed layout");
          }
          contents.sendInputEvent({
            type: "mouseWheel",
            x: Math.round(action.x),
            y: Math.round(action.y),
            deltaX: Math.round(action.deltaX),
            deltaY: Math.round(action.deltaY),
            canScroll: true,
          });
          return;
        case "key":
        case "shortcut":
          contents.sendInputEvent({ type: "keyDown", keyCode: action.key, modifiers });
          contents.sendInputEvent({ type: "keyUp", keyCode: action.key, modifiers });
          return;
        case "commitText":
          await contents.insertText(action.text);
          return;
        case "composition":
          throw new Error("Composition must be resolved by the visual session manager");
        default:
          throw new Error("Unsupported visual input action");
      }
    },
  };
}
