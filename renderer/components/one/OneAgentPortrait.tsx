"use client";

import { useEffect, useRef, useState } from "react";
import type { OneOrgStatusKind } from "@shared/one-org";
import { Alignment, Fit, Layout, Rive, StateMachineInputType } from "@rive-app/canvas";
import styles from "./OneAgentPortrait.module.css";

const RIVE_STATE: Record<OneOrgStatusKind, number> = {
  new: 0,
  quiet: 0,
  working: 1,
  waiting: 2,
  failed: 3,
  // An unconfirmed result is a user-action state, so it shares waiting motion.
  unconfirmed: 2,
  locked: 4,
};

// The accent is a Rive ViewModel color property, not a CSS tint.  All agent
// portraits keep using the one shared binary and only change this property at
// runtime.
const RIVE_ACCENT: Record<string, number> = {
  green: 0xff23a17c,
  blue: 0xff326a9b,
  purple: 0xff7454a3,
  amber: 0xff9a6b1e,
  peach: 0xffa45f4d,
};

function applyRiveTone(rive: Rive | null, tone: string) {
  const accent = rive?.viewModelInstance?.color("accent");
  if (accent) accent.value = RIVE_ACCENT[tone] ?? RIVE_ACCENT.green;
}

export function OneAgentPortrait({
  status,
  label,
  size = "medium",
  tone = "green",
}: {
  status: OneOrgStatusKind;
  label: string;
  size?: "small" | "medium" | "large";
  tone?: string;
}) {
  const initials = Array.from(label.trim()).slice(0, 2).join("").toUpperCase() || "?";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const riveRef = useRef<Rive | null>(null);
  const [riveStatus, setRiveStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    const rive = new Rive({
      src: "/brand/one-agent/one-agent.riv",
      canvas,
      stateMachines: ["OneAgentState"],
      autoplay: true,
      autoBind: true,
      layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
      onLoad: () => {
        if (disposed) return;
        riveRef.current = rive;
        applyRiveTone(rive, tone);
        setRiveStatus("ready");
      },
      onLoadError: () => {
        if (!disposed) setRiveStatus("error");
      },
    });
    riveRef.current = rive;
    return () => {
      disposed = true;
      riveRef.current = null;
      rive.cleanup();
    };
  }, []);

  useEffect(() => {
    const rive = riveRef.current;
    if (!rive || riveStatus !== "ready") return;
    const input = rive
      .stateMachineInputs("OneAgentState")
      .find((candidate) => candidate.name === "state" && candidate.type === StateMachineInputType.Number);
    if (input) input.value = RIVE_STATE[status];
    applyRiveTone(rive, tone);
  }, [riveStatus, status, tone]);

  return (
    <span className={`${styles.root} ${styles[size]}`} data-state={status} data-tone={tone} data-rive-status={riveStatus} aria-label={label}>
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/one-puppy/idle.png" alt="" className={styles.fallback} />
      <span className={styles.initials} aria-hidden="true">{initials}</span>
      <span className={styles.dot} aria-hidden="true" />
    </span>
  );
}
