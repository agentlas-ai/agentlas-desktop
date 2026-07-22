"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  siFirebase,
  siMongodb,
  siPostgresql,
  siRailway,
  siVercel,
  type SimpleIcon,
} from "simple-icons";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ipc } from "@/lib/ipc";
import {
  ONE_ONBOARDING_STARTER_AGENTS,
  type OneOnboardingProvider,
  type OneOnboardingScene,
  type OneOnboardingState,
  type OneOnboardingSubscription,
  type UpdateOneOnboardingInput,
} from "@shared/one-onboarding";
import type { RuntimeKind, RuntimeStatus, UsageSnapshot } from "@shared/types";
import { tFor } from "@/lib/i18n";
import styles from "./OneOnboarding.module.css";

type Props = {
  locale: "ko" | "en";
  onComplete: (projectSeed: string) => void;
  onVisibilityChange?: (visible: boolean) => void;
};

type MascotMood = "idle" | "talking" | "happy" | "thinking" | "cheer" | "gentle" | "point";

const PUPPY_IMAGE: Record<MascotMood, string> = {
  idle: "/brand/one-puppy/idle.png",
  talking: "/brand/one-puppy/talking.png",
  happy: "/brand/one-puppy/happy.png",
  thinking: "/brand/one-puppy/thinking.png",
  cheer: "/brand/one-puppy/cheer.png",
  gentle: "/brand/one-puppy/gentle.png",
  point: "/brand/one-puppy/point.png",
};

const PROVIDERS: Array<{
  id: Exclude<OneOnboardingProvider, null>;
  runtime: RuntimeKind;
  name: string;
  logo: string;
  page: string;
}> = [
  { id: "openai", runtime: "codex", name: "OpenAI · Codex", logo: "/brand/llm/openai.svg", page: "https://openai.com/chatgpt/pricing/" },
  { id: "anthropic", runtime: "claude-code", name: "Claude", logo: "/brand/llm/claude.svg", page: "https://claude.com/pricing" },
  { id: "kimi", runtime: "kimi", name: "Kimi", logo: "/brand/llm/kimi.svg", page: "https://www.kimi.com/help/membership/membership-overview" },
  { id: "google", runtime: "gemini", name: "Gemini", logo: "/brand/llm/googlegemini.svg", page: "https://one.google.com/about/google-ai-plans/" },
];

const EXAMPLE_SEEDS = ["one.onb.seed.cafe", "one.onb.seed.sales", "one.onb.seed.name"] as const;
const PLACEHOLDER_KEYS = [
  "one.onb.s6.placeholder",
  "one.onb.s6.placeholder_walk",
  "one.onb.s6.placeholder_budget",
] as const;

const HIGHLIGHT_PATTERN = /(바이브 코딩|바이브코딩|뇌|구독|공짜|무료|팀|데이터|서버|화면|vibe coding|brain|subscription|free|team|data|server|screen)/gi;

const CONCEPTS = [
  {
    icon: "DB",
    titleKey: "one.onb.concept.db.title",
    bodyKey: "one.onb.concept.db.body",
    examples: "MongoDB · PostgreSQL · Firebase",
  },
  {
    icon: "API",
    titleKey: "one.onb.concept.server.title",
    bodyKey: "one.onb.concept.server.body",
    examples: "Railway · API",
  },
  {
    icon: "UI",
    titleKey: "one.onb.concept.frontend.title",
    bodyKey: "one.onb.concept.frontend.body",
    examples: "Web · App · Vercel",
  },
] as const;

function errorMessage(_error: unknown, fallback: string): string {
  return fallback;
}

function BrandMark({ icon }: { icon: SimpleIcon }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={icon.path} fill={`#${icon.hex}`} />
    </svg>
  );
}

function useTypewriter(text: string, immediate: boolean) {
  const [visible, setVisible] = useState(immediate ? text : "");
  const [flushed, setFlushed] = useState(immediate);
  useEffect(() => {
    setVisible(immediate ? text : "");
    setFlushed(immediate);
    if (immediate) return;
    let cancelled = false;
    let index = 0;
    let timer = 0;
    const tick = () => {
      if (cancelled) return;
      index += 1;
      setVisible(text.slice(0, index));
      if (index >= text.length) {
        setFlushed(true);
        return;
      }
      const char = text[index - 1] ?? "";
      const delay = char === "\n"
        ? 350
        : /[.!?。！？]/.test(char)
          ? 250
          : /[,，]/.test(char)
            ? 120
            : 30;
      timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, 130);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [immediate, text]);
  return {
    visible,
    complete: flushed,
    flush: () => {
      setVisible(text);
      setFlushed(true);
    },
  };
}

function HighlightedText({ text }: { text: string }) {
  return text.split(HIGHLIGHT_PATTERN).map((part, index) => {
    if (!part) return null;
    return index % 2 === 1
      ? <mark key={`${part}-${index}`} className={styles.keyword}>{part}</mark>
      : <span key={`${part}-${index}`}>{part}</span>;
  });
}

function OnePuppy({
  mood,
  small = false,
  reduced = false,
  label,
}: {
  mood: MascotMood;
  small?: boolean;
  reduced?: boolean;
  label: string;
}) {
  const animation = small || reduced
    ? false
    : mood === "talking"
      ? { y: [0, -3, 0], scale: [1, 1.035, 1] }
      : mood === "thinking"
        ? { x: [-3, 3, -3], rotate: [-2, 2, -2] }
        : mood === "cheer" || mood === "happy"
          ? { y: [0, -16, 0], scale: [1, 1.08, 1] }
          : mood === "point"
            ? { x: [0, 8, 0], rotate: [0, 5, 0] }
            : mood === "gentle"
              ? { y: [0, 2, 0], rotate: [0, -3, 0] }
              : { y: [0, -5, 0], rotate: [0, -0.7, 0.7, 0] };
  return (
    <motion.img
      className={`${styles.puppy} ${small ? styles.puppySmall : ""}`}
      src={PUPPY_IMAGE[mood]}
      alt={label}
      animate={animation}
      transition={reduced ? { duration: 0 } : { duration: mood === "cheer" || mood === "happy" ? 1.3 : 3.2, repeat: Infinity, ease: "easeInOut" }}
      draggable={false}
    />
  );
}

function Dialogue({
  text,
  reduced,
  onNext,
  onType,
  nextLabel,
}: {
  text: string;
  reduced: boolean;
  onNext?: () => void;
  onType?: () => void;
  nextLabel: string;
}) {
  const typed = useTypewriter(text, reduced);
  const ref = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const retainFocus = useCallback((node: HTMLButtonElement | null) => {
    const previous = actionRef.current;
    const shouldMove = !node && previous === document.activeElement;
    actionRef.current = node;
    if (!shouldMove) return;
    window.requestAnimationFrame(() => {
      const scene = ref.current?.closest<HTMLElement>("[data-onboarding-scene]");
      const next = scene?.querySelector<HTMLElement>('button:not([disabled]), textarea:not([disabled]), [href]');
      next?.focus();
    });
  }, []);
  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (parent) parent.dataset.dialogueDone = typed.complete ? "true" : "false";
  }, [typed.complete, text]);
  useEffect(() => {
    if (!typed.complete && typed.visible.length > 0 && typed.visible.length % 9 === 0) onType?.();
  }, [onType, typed.complete, typed.visible.length]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("one-onboarding-talking", { detail: !typed.complete }));
    return () => {
      window.dispatchEvent(new CustomEvent("one-onboarding-talking", { detail: false }));
    };
  }, [typed.complete]);
  const focusNextControl = useCallback(() => {
    const scene = ref.current?.closest<HTMLElement>("[data-onboarding-scene]");
    const next = scene?.querySelector<HTMLElement>(
      `button:not(.${styles.dialogueAction}):not([disabled]), textarea:not([disabled]), [href]`,
    );
    next?.focus();
  }, []);
  const activate = useCallback(() => {
    if (!typed.complete) {
      typed.flush();
      return;
    }
    if (onNext) onNext();
    else focusNextControl();
  }, [focusNextControl, onNext, typed]);
  useEffect(() => {
    const flush = () => {
      if (!typed.complete) typed.flush();
    };
    const advance = () => {
      if (typed.complete) activate();
    };
    window.addEventListener("one-onboarding-flush", flush);
    window.addEventListener("one-onboarding-advance", advance);
    return () => {
      window.removeEventListener("one-onboarding-flush", flush);
      window.removeEventListener("one-onboarding-advance", advance);
    };
  }, [activate, typed.complete, typed.flush]);
  return (
    <div ref={ref} className={styles.dialogue} role="status">
      <button ref={retainFocus} type="button" className={styles.dialogueAction} onClick={activate} aria-label={text}>
        <span className={styles.srOnly}>{text}</span>
        <span aria-hidden="true"><HighlightedText text={typed.visible} />{!typed.complete && <span className={styles.caret}>▌</span>}</span>
        {typed.complete && <span className={styles.dialogueNext}>{nextLabel}</span>}
      </button>
    </div>
  );
}

function providerMatchesRuntime(provider: Exclude<OneOnboardingProvider, null>, runtime: RuntimeStatus): boolean {
  if (provider === "openai") return runtime.kind === "codex" || runtime.backend === "openai";
  if (provider === "anthropic") return runtime.kind === "claude-code" || runtime.backend === "anthropic";
  if (provider === "kimi") return runtime.kind === "kimi" || runtime.backend === "kimi";
  return runtime.kind === "gemini" || runtime.backend === "google";
}

function moveRadio<T extends string>(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  values: readonly T[],
  current: T | null,
  choose: (value: T) => void,
) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const currentIndex = Math.max(0, values.indexOf(current ?? values[0]));
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? values.length - 1
      : (currentIndex + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + values.length) % values.length;
  const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  buttons?.[nextIndex]?.focus();
  choose(values[nextIndex]);
}

export function OneOnboarding({ locale, onComplete, onVisibilityChange }: Props) {
  const ko = locale === "ko";
  const reduced = Boolean(useReducedMotion());
  const [state, setState] = useState<OneOnboardingState | null>(null);
  const [showResume, setShowResume] = useState(false);
  const [replay, setReplay] = useState(false);
  const [replayScene, setReplayScene] = useState<OneOnboardingScene>("s0");
  const [helperOpen, setHelperOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtimeFacts, setRuntimeFacts] = useState<RuntimeStatus[]>([]);
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [selectedSlugs, setSelectedSlugs] = useState<string[]>([]);
  const [teamHint, setTeamHint] = useState(false);
  const [teamAssist, setTeamAssist] = useState(false);
  const [teamCreated, setTeamCreated] = useState(false);
  const [seed, setSeed] = useState("");
  const [pendingInstall, setPendingInstall] = useState<Exclude<OneOnboardingProvider, null> | null>(null);
  const [previewSubscription, setPreviewSubscription] = useState<Exclude<OneOnboardingSubscription, null> | null>(null);
  const [previewProvider, setPreviewProvider] = useState<Exclude<OneOnboardingProvider, null> | null>(null);
  const [agentHint, setAgentHint] = useState<string | null>(null);
  const [brandTip, setBrandTip] = useState<string | null>(null);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [talking, setTalking] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [starterTeamPresent, setStarterTeamPresent] = useState(true);
  const [loadNonce, setLoadNonce] = useState(0);
  const [dismissRequested, setDismissRequested] = useState(false);
  const [dismissRetryNonce, setDismissRetryNonce] = useState(0);
  const audioRef = useRef<AudioContext | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const originFocusRef = useRef<HTMLElement | null>(null);
  const teamZoneRef = useRef<HTMLDivElement | null>(null);
  const pendingProviderReturnRef = useRef<{ provider: Exclude<OneOnboardingProvider, null>; openedAt: number } | null>(null);
  const pendingProviderReturnTimerRef = useRef<number | null>(null);
  const dismissPersistingRef = useRef(false);
  const dismissRequestedRef = useRef(false);
  const selectionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const selectionPendingRef = useRef(0);
  const providerActionRef = useRef(false);

  const visible = Boolean(state && !dismissRequested && (
    finishing
    || replay
    || !["completed", "dismissed", "migrated"].includes(state.status)
  ));
  const scene = replay ? replayScene : state?.currentScene ?? "s0";
  // Preview state also provides immediate visual acknowledgement while the
  // Main-process CAS write is in flight; persisted state remains authoritative.
  const selectedSubscription = previewSubscription ?? state?.subscription ?? null;
  const selectedProvider = previewProvider ?? state?.provider ?? null;
  const beginnerPath = (state?.experience ?? "new") !== "expert";
  const path = beginnerPath
    ? (["s0", "s1", "s2", "s3", "s4", "s5", "s6"] as OneOnboardingScene[])
    : (["s0", "s3", "s6"] as OneOnboardingScene[]);

  useEffect(() => {
    const api = ipc();
    if (!api?.oneOnboarding) return;
    let cancelled = false;
    api.oneOnboarding.getState().then((next) => {
      if (cancelled) return;
      setState(next);
      setSelectedSlugs(next.selectedStarterSlugs);
      setSeed(next.projectSeed);
      setPreviewSubscription(next.subscription);
      setPreviewProvider(next.provider);
      setShowResume(next.status === "in-progress");
    }).catch((cause) => setError(errorMessage(cause, tFor(locale, "one.onb.err.load"))));
    return () => { cancelled = true; };
  }, [locale, loadNonce]);

  useEffect(() => onVisibilityChange?.(visible), [onVisibilityChange, visible]);

  useEffect(() => {
    setTeamHint(false);
    setTeamAssist(false);
    if (!visible || scene !== "s4" || selectedSlugs.length > 0) return;
    const hintTimer = window.setTimeout(() => setTeamHint(true), 30_000);
    const assistTimer = window.setTimeout(() => setTeamAssist(true), 36_000);
    return () => {
      window.clearTimeout(hintTimer);
      window.clearTimeout(assistTimer);
    };
  }, [scene, selectedSlugs.length, visible]);

  useEffect(() => {
    if (!visible || scene !== "s6" || seed) return;
    setPlaceholderIndex(0);
    const timer = window.setInterval(() => {
      setPlaceholderIndex((current) => (current + 1) % PLACEHOLDER_KEYS.length);
    }, 2_600);
    return () => window.clearInterval(timer);
  }, [scene, seed, visible]);

  useEffect(() => {
    const onTalking = (event: Event) => setTalking(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener("one-onboarding-talking", onTalking);
    return () => window.removeEventListener("one-onboarding-talking", onTalking);
  }, []);

  useEffect(() => {
    if (!visible) {
      originFocusRef.current?.focus?.();
      originFocusRef.current = null;
      return;
    }
    if (!originFocusRef.current) originFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const initial = dialog?.querySelector<HTMLElement>(`.${styles.dialogue} button`)
      ?? dialog?.querySelector<HTMLElement>("h1");
    const focusTimer = window.setTimeout(() => initial?.focus(), 0);
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (replay) {
          setReplay(false);
          return;
        }
        setDismissRequested(true);
        dismissRequestedRef.current = true;
        setShowResume(false);
        setHelperOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )].filter((item) => item.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", trap);
    };
  }, [replay, scene, showResume, visible]);

  useEffect(() => {
    if (!state || visible || !state.starterTeamGroupId) return;
    ipc()?.agentGroups.list().then((groups) => {
      const group = groups.find((item) => item.id === state.starterTeamGroupId);
      const expected = new Set(state.selectedStarterSlugs);
      const actual = new Set<string>();
      const exact = Boolean(group
        && group.members.length === expected.size
        && group.members.every((member) => {
          const slug = member.hubSlug || member.agentSlug || "";
          actual.add(slug);
          const starter = ONE_ONBOARDING_STARTER_AGENTS.find((item) => item.slug === slug);
          return expected.has(slug)
            && member.source === "hub"
            && member.hubEntityKind === starter?.entityKind
            && starter?.packageHash === member.snapshot.packageHash;
        })
        && actual.size === expected.size);
      setStarterTeamPresent(exact);
    }).catch(() => setStarterTeamPresent(false));
  }, [state, visible]);

  const play = useCallback((kind: "tap" | "success") => {
    if (!state?.soundEnabled || reduced) return;
    try {
      const context = audioRef.current ?? new AudioContext();
      audioRef.current = context;
      const tones = kind === "success"
        ? [{ frequency: 523, offset: 0 }, { frequency: 659, offset: 0.08 }, { frequency: 784, offset: 0.16 }]
        : [{ frequency: 420, offset: 0 }];
      for (const tone of tones) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + tone.offset;
        oscillator.type = "sine";
        oscillator.frequency.value = tone.frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(kind === "success" ? 0.035 : 0.025, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.14);
      }
      if (kind === "success") {
        for (const offset of [0.02, 0.11]) {
          const frames = Math.max(1, Math.floor(context.sampleRate * 0.045));
          const buffer = context.createBuffer(1, frames, context.sampleRate);
          const data = buffer.getChannelData(0);
          for (let index = 0; index < frames; index += 1) {
            data[index] = (Math.random() * 2 - 1) * (1 - index / frames);
          }
          const source = context.createBufferSource();
          const clapGain = context.createGain();
          source.buffer = buffer;
          clapGain.gain.value = 0.018;
          source.connect(clapGain).connect(context.destination);
          source.start(context.currentTime + offset);
        }
      }
    } catch {
      // Sound is optional. The visual flow remains authoritative.
    }
  }, [reduced, state?.soundEnabled]);

  const applyPatch = useCallback(async (patch: UpdateOneOnboardingInput["patch"]) => {
    if (!state || replay) return state;
    const api = ipc();
    if (!api?.oneOnboarding) throw new Error("Desktop bridge unavailable");
    try {
      const next = await api.oneOnboarding.update({ expectedVersion: state.version, patch });
      setState(next);
      return next;
    } catch (cause) {
      const latest = await api.oneOnboarding.getState();
      setState(latest);
      throw cause;
    }
  }, [replay, state]);

  const go = useCallback(async (next: OneOnboardingScene, patch: Record<string, unknown> = {}) => {
    play("tap");
    setError(null);
    if (replay) {
      setReplayScene(next);
      return;
    }
    try {
      await applyPatch({ ...patch, currentScene: next });
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.save_progress")));
    }
  }, [applyPatch, locale, play, replay]);

  const enqueueSelectionPatch = useCallback((patch: UpdateOneOnboardingInput["patch"]) => {
    const api = ipc();
    if (!api?.oneOnboarding) return Promise.resolve<OneOnboardingState | null>(null);
    selectionPendingRef.current += 1;
    setBusy(true);
    const task = selectionQueueRef.current.then(async () => {
      const latest = await api.oneOnboarding.getState();
      if (dismissRequestedRef.current || latest.status === "dismissed") return latest;
      const next = await api.oneOnboarding.update({ expectedVersion: latest.version, patch });
      setState(next);
      return next;
    });
    selectionQueueRef.current = task.then(() => undefined, () => undefined);
    return task.finally(() => {
      selectionPendingRef.current = Math.max(0, selectionPendingRef.current - 1);
      if (selectionPendingRef.current === 0 && !providerActionRef.current) setBusy(false);
    });
  }, []);

  const chooseSubscription = async (subscription: Exclude<OneOnboardingSubscription, null>) => {
    setPreviewSubscription(subscription);
    if (replay) {
      play("tap");
      return;
    }
    setError(null);
    try {
      const next = await enqueueSelectionPatch({ subscription });
      setPreviewSubscription(next?.subscription ?? subscription);
      play("tap");
    } catch (cause) {
      setPreviewSubscription(state?.subscription ?? null);
      setError(errorMessage(cause, tFor(locale, "one.onb.err.save_selection")));
    }
  };

  const detectProvider = useCallback(async (provider: Exclude<OneOnboardingProvider, null>, force = true) => {
    const api = ipc();
    if (!api) return false;
    const facts = await api.runtime.detect(force);
    setRuntimeFacts(facts);
    return facts.some((runtime) => providerMatchesRuntime(provider, runtime));
  }, []);

  const selectProvider = async (provider: Exclude<OneOnboardingProvider, null>) => {
    setPreviewProvider(provider);
    if (replay) {
      play("tap");
      return;
    }
    setError(null);
    try {
      const next = await enqueueSelectionPatch({ provider });
      setPreviewProvider(next?.provider ?? provider);
      play("tap");
    } catch (cause) {
      setPreviewProvider(state?.provider ?? null);
      setError(errorMessage(cause, tFor(locale, "one.onb.err.save_provider")));
    }
  };

  const advanceAfterProviderSetup = useCallback(async (current: OneOnboardingState) => {
    const api = ipc();
    if (!api?.oneOnboarding) return current;
    if (current.experience !== "expert") {
      const next = await api.oneOnboarding.update({ expectedVersion: current.version, patch: { currentScene: "s4" } });
      setState(next);
      return next;
    }
    const all = ONE_ONBOARDING_STARTER_AGENTS.map((agent) => agent.slug);
    let next = await api.oneOnboarding.provisionStarterTeam({
      expectedVersion: current.version,
      memberSlugs: all,
      locale,
    });
    next = await api.oneOnboarding.update({ expectedVersion: next.version, patch: { currentScene: "s6" } });
    setSelectedSlugs(all);
    setState(next);
    setSeed(next.projectSeed);
    return next;
  }, [locale]);

  const connectProvider = async (provider: Exclude<OneOnboardingProvider, null>) => {
    if (replay) return go("s4");
    if (providerActionRef.current) return;
    const api = ipc();
    const entry = PROVIDERS.find((item) => item.id === provider);
    if (!api || !entry) return;
    providerActionRef.current = true;
    setBusy(true);
    setError(null);
    setRuntimeMessage(tFor(locale, "one.onb.rt.checking"));
    try {
      await selectionQueueRef.current;
      setBusy(true);
      let current = await api.oneOnboarding.getState();
      if (dismissRequestedRef.current || current.status === "dismissed") return;
      if (current.provider !== provider) {
        current = await api.oneOnboarding.update({ expectedVersion: current.version, patch: { provider } });
        setState(current);
      }
      const installed = await detectProvider(provider);
      if (current.subscription !== "paid") {
        const opened = await api.fs.openPath(entry.page);
        if (!opened.ok) throw new Error(opened.message || tFor(locale, "one.onb.err.open_page"));
        pendingProviderReturnRef.current = { provider, openedAt: Date.now() };
        setRuntimeMessage(current.subscription === "none"
          ? tFor(locale, "one.onb.rt.opened_signup")
          : tFor(locale, "one.onb.rt.opened_service"));
        return;
      }
      if (!installed) {
        setPendingInstall(provider);
        setRuntimeMessage(tFor(locale, "one.onb.rt.install_required", { name: entry.name }));
        return;
      }
      current = await api.oneOnboarding.verifyProvider({ expectedVersion: current.version, provider });
      setState(current);
      if (current.brainStatus === "connected") {
        current = await advanceAfterProviderSetup(current);
        setRuntimeMessage(tFor(locale, "one.onb.rt.connected"));
        play("success");
        return;
      }
      const login = await api.runtime.openCliLogin(entry.runtime as "claude-code" | "codex" | "gemini" | "kimi");
      setRuntimeMessage(provider === "kimi"
        ? tFor(locale, "one.onb.rt.kimi_limited")
        : login.message || tFor(locale, "one.onb.rt.finish_signin"));
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.start_connection")));
    } finally {
      providerActionRef.current = false;
      setBusy(false);
    }
  };

  const approveInstall = async () => {
    if (!pendingInstall || busy) return;
    const api = ipc();
    const entry = PROVIDERS.find((item) => item.id === pendingInstall);
    if (!api || !entry) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.runtime.installCli(entry.runtime as "claude-code" | "codex" | "gemini" | "kimi");
      if (!result.ok) throw new Error(result.message);
      setPendingInstall(null);
      const login = await api.runtime.openCliLogin(entry.runtime as "claude-code" | "codex" | "gemini" | "kimi");
      setRuntimeMessage(login.message || tFor(locale, "one.onb.rt.installed_check"));
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.install")));
    } finally {
      setBusy(false);
    }
  };

  const recheckProvider = useCallback(async () => {
    if (!state?.provider || replay) return;
    setBusy(true);
    setError(null);
    try {
      const installed = await detectProvider(state.provider);
      if (!installed) {
        const entry = PROVIDERS.find((item) => item.id === state.provider);
        setPendingInstall(state.provider);
        setRuntimeMessage(entry
          ? tFor(locale, "one.onb.rt.install_required", { name: entry.name })
          : tFor(locale, "one.onb.rt.not_detected"));
        return;
      }
      setPendingInstall(null);
      let next = await ipc()!.oneOnboarding.verifyProvider({ expectedVersion: state.version, provider: state.provider });
      setState(next);
      if (next.brainStatus !== "connected") {
        setRuntimeMessage(state.provider === "kimi"
          ? tFor(locale, "one.onb.rt.kimi_no_probe")
          : tFor(locale, "one.onb.rt.tool_found_unverified"));
        return;
      }
      next = await advanceAfterProviderSetup(next);
      play("success");
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.verify_status")));
    } finally {
      setBusy(false);
    }
  }, [advanceAfterProviderSetup, detectProvider, locale, play, replay, state]);

  useEffect(() => {
    const recheckAfterProviderReturn = () => {
      const pending = pendingProviderReturnRef.current;
      if (!pending || replay || busy || state?.provider !== pending.provider) return;
      if (pendingProviderReturnTimerRef.current !== null) {
        window.clearTimeout(pendingProviderReturnTimerRef.current);
      }
      const delay = Math.max(0, 750 - (Date.now() - pending.openedAt));
      pendingProviderReturnTimerRef.current = window.setTimeout(() => {
        pendingProviderReturnTimerRef.current = null;
        if (pendingProviderReturnRef.current !== pending) return;
        pendingProviderReturnRef.current = null;
        void recheckProvider();
      }, delay);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") recheckAfterProviderReturn();
    };
    window.addEventListener("focus", recheckAfterProviderReturn);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", recheckAfterProviderReturn);
      document.removeEventListener("visibilitychange", onVisibility);
      if (pendingProviderReturnTimerRef.current !== null) {
        window.clearTimeout(pendingProviderReturnTimerRef.current);
        pendingProviderReturnTimerRef.current = null;
      }
    };
  }, [busy, recheckProvider, replay, state?.provider]);

  const chooseLimited = async () => {
    if (replay) return go("s4");
    if (!state?.provider || busy) {
      if (busy) return;
      setError(tFor(locale, "one.onb.err.choose_provider_first"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const api = ipc();
      if (!api) return;
      let next = await api.oneOnboarding.chooseLimited({ expectedVersion: state.version, provider: state.provider });
      setState(next);
      next = await advanceAfterProviderSetup(next);
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.save_limited")));
    } finally {
      setBusy(false);
    }
  };

  const chooseExpert = async () => {
    if (replay) return go("s3");
    const api = ipc();
    if (!api?.oneOnboarding || !state || busy) return;
    setBusy(true);
    setError(null);
    try {
      let current = await api.oneOnboarding.update({ expectedVersion: state.version, patch: { experience: "expert" } });
      const [runtimes, usage] = await Promise.all([
        api.runtime.detect(true),
        api.usage.snapshot({ force: true }),
      ]);
      setRuntimeFacts(runtimes);
      const readyProvider = (["openai", "anthropic", "google"] as const).find((provider) => {
        const usageProvider = provider === "openai" ? "codex" : provider === "anthropic" ? "claude-code" : "gemini";
        return runtimes.some((runtime) => providerMatchesRuntime(provider, runtime))
          && usage.providers.some((item) => item.provider === usageProvider && item.status !== "error");
      });
      if (readyProvider) current = await api.oneOnboarding.verifyProvider({ expectedVersion: current.version, provider: readyProvider });
      if (current.brainStatus === "connected") {
        const all = ONE_ONBOARDING_STARTER_AGENTS.map((agent) => agent.slug);
        current = await api.oneOnboarding.provisionStarterTeam({ expectedVersion: current.version, memberSlugs: all, locale });
        current = await api.oneOnboarding.update({ expectedVersion: current.version, patch: { currentScene: "s6" } });
        setSelectedSlugs(all);
        setState(current);
        setSeed(current.projectSeed);
        play("success");
      } else {
        current = await api.oneOnboarding.update({ expectedVersion: current.version, patch: { currentScene: "s3" } });
        setState(current);
      }
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.quick_setup")));
    } finally {
      setBusy(false);
    }
  };

  const toggleStarter = async (slug: string) => {
    if (busy) return;
    const next = selectedSlugs.includes(slug)
      ? selectedSlugs.filter((item) => item !== slug)
      : [...selectedSlugs, slug];
    setSelectedSlugs(next);
    play("tap");
    if (!replay) {
      setBusy(true);
      try {
        await applyPatch({ selectedStarterSlugs: next });
      } catch (cause) {
        setError(errorMessage(cause, tFor(locale, "one.onb.err.save_team")));
      } finally {
        setBusy(false);
      }
    }
  };

  const addAllStarters = async () => {
    const all = ONE_ONBOARDING_STARTER_AGENTS.map((agent) => agent.slug);
    setSelectedSlugs(all);
    play("tap");
    if (replay) return;
    setBusy(true);
    try {
      await applyPatch({ selectedStarterSlugs: all });
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.save_team")));
    } finally {
      setBusy(false);
    }
  };

  const provisionTeam = async () => {
    if (selectedSlugs.length < 2) {
      setError(tFor(locale, "one.onb.err.min_two"));
      return;
    }
    const api = ipc();
    if (!api?.oneOnboarding || !state) return;
    if (replay) {
      setTeamCreated(true);
      play("success");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.oneOnboarding.provisionStarterTeam({
        expectedVersion: state.version,
        memberSlugs: selectedSlugs,
        locale,
      });
      setState(next);
      setTeamCreated(true);
      play("success");
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.create_team")));
    } finally {
      setBusy(false);
    }
  };

  const continueAfterTeam = async () => {
    setTeamCreated(false);
    if (replay) {
      setReplayScene("s5");
      return;
    }
    if (!state) return;
    try {
      const next = await ipc()!.oneOnboarding.update({ expectedVersion: state.version, patch: { currentScene: "s5" } });
      setState(next);
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.continue")));
    }
  };

  const finish = async () => {
    if (!seed.trim()) {
      setError(tFor(locale, "one.onb.err.write_request"));
      return;
    }
    if (replay) {
      setReplay(false);
      setHelperOpen(false);
      return;
    }
    const api = ipc();
    if (!api?.oneOnboarding || !state) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.oneOnboarding.complete({
        expectedVersion: state.version,
        projectSeed: seed,
        expertSkip: state.experience === "expert",
        confirmedByUser: true,
      });
      setFinishing(true);
      setState(next);
      play("success");
      window.setTimeout(() => {
        onComplete(next.projectSeed);
        setFinishing(false);
      }, reduced ? 120 : 480);
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.save_final")));
    } finally {
      setBusy(false);
    }
  };

  const toggleSound = async (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (!state || replay) return;
    try {
      await applyPatch({ soundEnabled: !state.soundEnabled });
    } catch {
      // Optional preference: keep the tutorial usable if persistence fails.
    }
  };

  const openReplay = () => {
    setHelperOpen(false);
    setSelectedSlugs(state?.selectedStarterSlugs ?? []);
    setTeamCreated(false);
    setPreviewSubscription(state?.subscription ?? "paid");
    setPreviewProvider(state?.provider ?? null);
    setRuntimeFacts([]);
    setRuntimeMessage(null);
    setReplayScene("s0");
    setReplay(true);
  };

  const dismissTutorial = async (event?: ReactMouseEvent) => {
    event?.stopPropagation();
    if (replay) {
      setReplay(false);
      setHelperOpen(false);
      return;
    }
    setError(null);
    dismissRequestedRef.current = true;
    setDismissRequested(true);
    setShowResume(false);
    setHelperOpen(false);
  };

  useEffect(() => {
    if (!dismissRequested || replay || dismissPersistingRef.current) return;
    const api = ipc();
    if (!api?.oneOnboarding) return;
    dismissPersistingRef.current = true;
    void (async () => {
      try {
        const latest = await api.oneOnboarding.getState();
        const next = latest.status === "dismissed"
          ? latest
          : await api.oneOnboarding.dismiss({ expectedVersion: latest.version });
        setState(next);
        dismissRequestedRef.current = false;
        setDismissRequested(false);
      } catch (cause) {
        setError(errorMessage(cause, tFor(locale, "one.onb.err.close")));
        window.setTimeout(() => setDismissRetryNonce((value) => value + 1), 250);
      } finally {
        dismissPersistingRef.current = false;
      }
    })();
  }, [dismissRequested, dismissRetryNonce, locale, replay]);

  const startOver = async () => {
    const api = ipc();
    if (!api?.oneOnboarding || !state || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.oneOnboarding.reset({ expectedVersion: state.version });
      setState(next);
      setSelectedSlugs([]);
      setSeed("");
      setPreviewSubscription(null);
      setPreviewProvider(null);
      setRuntimeFacts([]);
      setRuntimeMessage(null);
      setPendingInstall(null);
      setTeamCreated(false);
      setShowResume(false);
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.save_progress")));
    } finally {
      setBusy(false);
    }
  };

  const resumeTutorial = async () => {
    const api = ipc();
    if (!api?.oneOnboarding || !state || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.oneOnboarding.resume({ expectedVersion: state.version });
      setState(next);
      setSelectedSlugs(next.selectedStarterSlugs);
      setPreviewSubscription(next.subscription);
      setPreviewProvider(next.provider);
      setShowResume(false);
      setReplay(false);
      setHelperOpen(false);
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.reopen")));
    } finally {
      setBusy(false);
    }
  };

  const reopenProviderSetup = async () => {
    const api = ipc();
    if (!api?.oneOnboarding || !state || state.status !== "completed" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.oneOnboarding.reopenProvider({ expectedVersion: state.version });
      setState(next);
      setPreviewProvider(null);
      setReplay(false);
      setShowResume(false);
      setHelperOpen(false);
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.provider_recovery")));
    } finally {
      setBusy(false);
    }
  };

  const repairStarterTeam = async () => {
    const api = ipc();
    if (!api?.oneOnboarding || !state || state.status !== "completed" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.oneOnboarding.provisionStarterTeam({
        expectedVersion: state.version,
        memberSlugs: state.selectedStarterSlugs,
        locale,
      });
      setState(next);
      setStarterTeamPresent(true);
      setHelperOpen(false);
    } catch (cause) {
      setError(errorMessage(cause, tFor(locale, "one.onb.err.repair_team")));
    } finally {
      setBusy(false);
    }
  };

  const sceneTitle = useMemo(() => tFor(locale, ({
    s0: "one.onb.scene.s0.title",
    s1: "one.onb.scene.s1.title",
    s2: "one.onb.scene.s2.title",
    s3: "one.onb.scene.s3.title",
    s4: "one.onb.scene.s4.title",
    s5: "one.onb.scene.s5.title",
    s6: "one.onb.scene.s6.title",
  } as const)[scene]), [locale, scene]);

  const handleOverlayClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest("button, textarea, input, select, a, label")) return;
    const activeScene = dialogRef.current?.querySelector<HTMLElement>("[data-onboarding-scene]");
    window.dispatchEvent(new Event(activeScene?.dataset.dialogueDone === "true"
      ? "one-onboarding-advance"
      : "one-onboarding-flush"));
  };

  if (!state) return error ? (
    <div className={styles.loadError} role="alert">
      <span>{error}</span>
      <button type="button" onClick={() => { setError(null); setLoadNonce((value) => value + 1); }}>
        {tFor(locale, "one.onb.action.try_again")}
      </button>
    </div>
  ) : null;

  if (!visible) {
    return (
      <>
        {starterTeamPresent && state.starterTeamGroupId && state.selectedStarterSlugs.length > 0 && (
          <div className={styles.starterDock} role="group" aria-label={tFor(locale, "one.onb.dock.aria")}>
            <div className={styles.starterAgents}>
              {state.selectedStarterSlugs.map((slug) => {
                const member = ONE_ONBOARDING_STARTER_AGENTS.find((agent) => agent.slug === slug);
                return <span key={slug} title={ko ? member?.nameKo : member?.nameEn}>{(ko ? member?.nameKo : member?.nameEn)?.slice(0, 2)}</span>;
              })}
            </div>
            <strong>{tFor(locale, "one.onb.dock.orchestrator")}</strong>
            <small>{tFor(locale, "one.onb.dock.starter_team", { count: state.selectedStarterSlugs.length })}</small>
          </div>
        )}
        <div className={styles.helperWrap}>
          <AnimatePresence>
            {helperOpen && (
              <motion.div className={styles.helperBubble} initial={reduced ? false : { opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0, y: -8 }} transition={{ duration: reduced ? 0 : 0.18 }}>
                <strong>{tFor(locale, "one.onb.helper.here")}</strong>
                <span>{state.status === "dismissed"
                  ? tFor(locale, "one.onb.helper.dismissed")
                  : state.status === "migrated"
                    ? tFor(locale, "one.onb.helper.migrated")
                  : starterTeamPresent
                  ? tFor(locale, "one.onb.helper.revisit")
                  : tFor(locale, "one.onb.helper.team_changed")}</span>
                {error && <span role="alert">{error}</span>}
                {(state.status === "dismissed" || state.status === "migrated")
                  ? <button type="button" disabled={busy} onClick={() => void resumeTutorial()}>{state.status === "dismissed" ? tFor(locale, "one.onb.helper.continue") : tFor(locale, "one.onb.helper.start")}</button>
                  : <button type="button" onClick={openReplay}>{tFor(locale, "one.onb.helper.replay")}</button>}
                {state.status === "completed" && <button type="button" disabled={busy} onClick={() => void reopenProviderSetup()}>{tFor(locale, "one.onb.helper.change_ai")}</button>}
                {!starterTeamPresent && state.status === "completed" && <button type="button" disabled={busy} onClick={() => void repairStarterTeam()}>{tFor(locale, "one.onb.helper.repair")}</button>}
              </motion.div>
            )}
          </AnimatePresence>
          <button
            type="button"
            className={styles.helperButton}
            aria-label={tFor(locale, "one.onb.helper.aria")}
            aria-expanded={helperOpen}
            onClick={() => setHelperOpen((open) => !open)}
          >
            <OnePuppy mood="happy" small reduced={reduced} label={tFor(locale, "one.onb.puppy.label")} />
          </button>
        </div>
      </>
    );
  }

  if (showResume && !replay) {
    return (
      <div className={styles.overlay} data-one-onboarding-dialog onClick={handleOverlayClick}>
        <section ref={(node) => { dialogRef.current = node; }} className={styles.resumeCard} role="dialog" aria-modal="true" aria-labelledby="one-resume-title">
          <button type="button" className={styles.close} onClick={(event) => void dismissTutorial(event)} aria-label={tFor(locale, "one.onb.action.close")}>×</button>
          <OnePuppy mood="gentle" reduced={reduced} label={tFor(locale, "one.onb.puppy.label")} />
          <h1 id="one-resume-title" tabIndex={-1}>{tFor(locale, "one.onb.resume.title")}</h1>
          <p>{tFor(locale, "one.onb.resume.body")}</p>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => void startOver()}>
              {tFor(locale, "one.onb.resume.start_over")}
            </button>
            <button type="button" className={styles.primary} onClick={() => setShowResume(false)}>
              {tFor(locale, "one.onb.resume.continue")}
            </button>
          </div>
        </section>
      </div>
    );
  }

  const mood: MascotMood = talking ? "talking" : scene === "s3" && busy ? "thinking" : scene === "s4" ? "point" : scene === "s6" ? "cheer" : scene === "s2" ? "gentle" : "idle";

  return (
    <div className={styles.overlay} data-one-onboarding-dialog data-finishing={finishing ? "true" : "false"} onClick={handleOverlayClick}>
      <section ref={(node) => { dialogRef.current = node; }} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="one-onboarding-title">
        <header className={styles.topbar}>
          <div
            className={styles.progress}
            role="progressbar"
            aria-label={tFor(locale, "one.onb.progress.aria")}
            aria-valuemin={1}
            aria-valuemax={path.length}
            aria-valuenow={Math.max(1, path.indexOf(scene) + 1)}
            aria-valuetext={tFor(locale, "one.onb.progress.step", { current: Math.max(1, path.indexOf(scene) + 1), total: path.length })}
          >
            {path.map((item) => <span key={item} data-current={item === scene ? "true" : "false"} data-done={path.indexOf(item) < path.indexOf(scene) ? "true" : "false"} />)}
          </div>
          <div className={styles.topActions}>
            <button type="button" className={styles.sound} onClick={toggleSound} aria-label={state.soundEnabled ? tFor(locale, "one.onb.sound.mute") : tFor(locale, "one.onb.sound.on")}>
              {state.soundEnabled ? "♪" : "♪̸"}
            </button>
            <button type="button" className={styles.close} onClick={(event) => void dismissTutorial(event)} aria-label={replay ? tFor(locale, "one.onb.action.close_replay") : tFor(locale, "one.onb.action.close")}>
              ×
            </button>
          </div>
        </header>

        <div className={styles.stage}>
          <div className={styles.guideColumn}>
            <OnePuppy mood={mood} reduced={reduced} label={tFor(locale, "one.onb.puppy.label")} />
            <div>
              <p className={styles.eyebrow}>AGENTLAS ONE · {scene.toUpperCase()}</p>
              <h1 id="one-onboarding-title" tabIndex={-1}>{sceneTitle}</h1>
            </div>
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={scene}
              className={styles.scene}
              data-onboarding-scene
              initial={reduced ? false : { opacity: 0, x: 22 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduced ? undefined : { opacity: 0, x: -18 }}
              transition={{ duration: reduced ? 0 : 0.24 }}
            >
              {scene === "s0" && (
                <>
                  <Dialogue
                    reduced={reduced}
                    onType={() => play("tap")}
                    text={tFor(locale, "one.onb.s0.dialogue")}
                    nextLabel={tFor(locale, "one.onb.action.next")}
                  />
                  <div className={styles.choiceGrid}>
                    <button type="button" onClick={() => void go("s1", { experience: "new" })}>
                      <span aria-hidden="true">GUIDE</span><strong>{tFor(locale, "one.onb.s0.guide")}</strong><small>{tFor(locale, "one.onb.s0.guide_sub")}</small>
                    </button>
                    <button type="button" disabled={busy} onClick={() => void chooseExpert()}>
                      <span aria-hidden="true">FAST</span><strong>{tFor(locale, "one.onb.s0.fast")}</strong><small>{tFor(locale, "one.onb.s0.fast_sub")}</small>
                    </button>
                  </div>
                </>
              )}

              {scene === "s1" && (
                <>
                  <Dialogue reduced={reduced} onType={() => play("tap")} text={tFor(locale, "one.onb.s1.dialogue")} nextLabel={tFor(locale, "one.onb.action.next")} />
                  <div className={styles.choiceGridThree}>
                    {([
                      ["new", "NEW", "one.onb.exp.new"],
                      ["chat", "CHAT", "one.onb.exp.chat"],
                      ["cli", "CLI", "one.onb.exp.cli"],
                    ] as const).map(([id, icon, key]) => (
                      <button key={id} type="button" onClick={() => void go("s2", { experience: id })}>
                        <span>{icon}</span><strong>{tFor(locale, key)}</strong>
                      </button>
                    ))}
                  </div>
                  <button type="button" className={styles.back} onClick={() => void go("s0")}>← {tFor(locale, "one.onb.action.back")}</button>
                </>
              )}

              {scene === "s2" && (
                <>
                  <Dialogue
                    reduced={reduced}
                    onType={() => play("tap")}
                    text={state.experience === "cli"
                      ? tFor(locale, "one.onb.s2.dialogue_cli")
                      : state.rephraseUsed
                      ? tFor(locale, "one.onb.s2.dialogue_rephrase")
                      : tFor(locale, "one.onb.s2.dialogue_default")}
                    onNext={() => void go("s3")}
                    nextLabel={tFor(locale, "one.onb.action.next")}
                  />
                  <motion.div
                    className={styles.wallVisual}
                    role="group"
                    aria-label={tFor(locale, "one.onb.s2.wall_aria")}
                    initial={reduced ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: reduced ? 0 : 0.35 }}
                  >
                    <div className={styles.wallFlow} aria-hidden="true">
                      <span className={styles.cloud}>☁</span>
                      <span className={styles.wall}><b>{tFor(locale, "one.onb.s2.legend_firewall")}</b><i /></span>
                      <span className={styles.mac}>▣</span>
                    </div>
                    <div className={styles.wallLegend}>
                      <span><strong>Web chat</strong><small>{tFor(locale, "one.onb.s2.legend_web")}</small></span>
                      <span><strong>{tFor(locale, "one.onb.s2.legend_firewall")}</strong><small>{tFor(locale, "one.onb.s2.legend_firewall_sub")}</small></span>
                      <span><strong>{tFor(locale, "one.onb.s2.legend_one")}</strong><small>{tFor(locale, "one.onb.s2.legend_one_sub")}</small></span>
                    </div>
                  </motion.div>
                  <div className={styles.actionsBetween}>
                    <button type="button" className={styles.back} onClick={() => void go("s1")}>← {tFor(locale, "one.onb.action.back")}</button>
                    <div className={styles.actions}>
                      {!state.rephraseUsed && state.experience !== "cli" && !replay && <button type="button" className={styles.secondary} onClick={() => void applyPatch({ rephraseUsed: true })}>{tFor(locale, "one.onb.s2.simpler")}</button>}
                      <button type="button" className={styles.primary} onClick={() => void go("s3")}>{tFor(locale, "one.onb.s2.got_it")}</button>
                    </div>
                  </div>
                </>
              )}

              {scene === "s3" && (
                <>
                  <Dialogue reduced={reduced} onType={() => play("tap")} text={tFor(locale, "one.onb.s3.dialogue")} nextLabel={tFor(locale, "one.onb.action.next")} />
                  <div className={styles.subscriptionRow} role="radiogroup" aria-label={tFor(locale, "one.onb.s3.sub_aria")}>
                    {([
                      ["paid", "✓", "one.onb.sub.paid"],
                      ["free", "○", "one.onb.sub.free"],
                      ["none", "+", "one.onb.sub.none"],
                    ] as const).map(([id, icon, key]) => (
                      <button
                        key={String(id)}
                        type="button"
                        role="radio"
                        aria-checked={selectedSubscription === id}
                        tabIndex={selectedSubscription === id || (!selectedSubscription && id === "paid") ? 0 : -1}
                        data-selected={selectedSubscription === id ? "true" : "false"}
                        onKeyDown={(event) => moveRadio(event, ["paid", "free", "none"] as const, selectedSubscription, (value) => void chooseSubscription(value))}
                        onClick={() => void chooseSubscription(id as Exclude<OneOnboardingSubscription, null>)}
                      >
                        <span>{icon}</span>{tFor(locale, key)}
                      </button>
                    ))}
                  </div>
                  <div className={styles.providerGrid} role="radiogroup" aria-label={tFor(locale, "one.onb.s3.provider_aria")}>
                    {PROVIDERS.map((provider) => (
                      <button
                        key={provider.id}
                        type="button"
                        role="radio"
                        aria-checked={selectedProvider === provider.id}
                        tabIndex={selectedProvider === provider.id || (!selectedProvider && provider.id === "openai") ? 0 : -1}
                        disabled={!selectedSubscription || busy}
                        data-selected={selectedProvider === provider.id ? "true" : "false"}
                        onKeyDown={(event) => moveRadio(event, PROVIDERS.map((item) => item.id), selectedProvider, (value) => void selectProvider(value))}
                        onClick={() => void selectProvider(provider.id)}
                      >
                        <img src={provider.logo} alt="" /><strong>{provider.name}</strong>
                        <small>{tFor(locale,
                          provider.id === "openai" ? "one.onb.provider.openai.hint"
                          : provider.id === "anthropic" ? "one.onb.provider.anthropic.hint"
                          : provider.id === "kimi" ? "one.onb.provider.kimi.hint"
                          : "one.onb.provider.google.hint")}</small>
                      </button>
                    ))}
                  </div>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={busy || !selectedProvider}
                      onClick={() => {
                        if (selectedProvider) void connectProvider(selectedProvider);
                      }}
                    >
                      {busy
                        ? tFor(locale, "one.onb.s3.checking")
                        : replay
                          ? tFor(locale, "one.onb.s3.confirm_next")
                          : tFor(locale, "one.onb.s3.connect")}
                    </button>
                    {!replay && (
                      <button type="button" className={styles.secondary} disabled={busy || !selectedProvider} onClick={() => void chooseLimited()}>
                        {tFor(locale, "one.onb.s3.explore")}
                      </button>
                    )}
                  </div>
                  {selectedProvider === "kimi" && (
                    <div className={styles.accountGuide} role="note">
                      <strong>{tFor(locale, "one.onb.s3.kimi_title")}</strong>
                      <small>{tFor(locale, "one.onb.s3.kimi_body")}</small>
                    </div>
                  )}
                  {selectedSubscription === "free" && (
                    <div className={styles.accountGuide}>
                      <strong>{tFor(locale, "one.onb.s3.free_title")}</strong>
                      <ol>
                        <li>{tFor(locale, "one.onb.s3.free_step1")}</li>
                        <li>{tFor(locale, "one.onb.s3.free_step2")}</li>
                      </ol>
                    </div>
                  )}
                  {selectedSubscription === "none" && (
                    <div className={styles.accountGuide}>
                      <strong>{tFor(locale, "one.onb.s3.none_title")}</strong>
                      <ol>
                        <li>{tFor(locale, "one.onb.s3.none_step1")}</li>
                        <li>{tFor(locale, "one.onb.s3.none_step2")}</li>
                        <li>{tFor(locale, "one.onb.s3.none_step3")}</li>
                      </ol>
                      <small>{tFor(locale, "one.onb.s3.none_note")}</small>
                    </div>
                  )}
                  {(runtimeMessage || runtimeFacts.length > 0) && (
                    <div className={styles.doctor} role="status">
                      <strong>{tFor(locale, "one.onb.s3.doctor_title")}</strong>
                      <span>{runtimeMessage}</span>
                      <ul>
                        <li data-ok={state.provider ? runtimeFacts.some((item) => providerMatchesRuntime(state.provider!, item)) : false}>{tFor(locale, "one.onb.s3.doctor_installed")}</li>
                        <li data-ok={state.brainStatus === "connected"}>{tFor(locale, "one.onb.s3.doctor_signin")}</li>
                        <li data-ok={state.brainStatus === "connected"}>{tFor(locale, "one.onb.s3.doctor_ready")}</li>
                      </ul>
                      <div className={styles.actions}>
                        {pendingInstall && <button type="button" className={styles.primary} disabled={busy} onClick={() => void approveInstall()}>{tFor(locale, "one.onb.s3.approve_install")}</button>}
                        <button type="button" className={styles.secondary} disabled={busy || !state.provider} onClick={() => void recheckProvider()}>{tFor(locale, "one.onb.s3.check_again")}</button>
                        <button type="button" className={styles.secondary} disabled={busy} onClick={() => void chooseLimited()}>{tFor(locale, "one.onb.s3.continue_limited")}</button>
                      </div>
                    </div>
                  )}
                  <button type="button" className={styles.back} onClick={() => void go(state.experience === "expert" ? "s0" : "s2")}>← {tFor(locale, "one.onb.action.back")}</button>
                </>
              )}

              {scene === "s4" && (
                <>
                  <Dialogue reduced={reduced} onType={() => play("tap")} text={tFor(locale, "one.onb.s4.dialogue")} nextLabel={tFor(locale, "one.onb.action.next")} />
                  <div className={styles.teamBuilder}>
                    <AnimatePresence>
                      {teamCreated && (
                        <motion.div className={styles.teamCelebration} role="status" aria-live="polite" initial={reduced ? false : { opacity: 0, scale: 0.82 }} animate={{ opacity: 1, scale: 1 }} exit={reduced ? undefined : { opacity: 0 }} transition={{ duration: reduced ? 0 : 0.26 }}>
                          <div className={styles.teamBirth} aria-hidden="true">
                            {selectedSlugs.map((slug) => {
                              const member = ONE_ONBOARDING_STARTER_AGENTS.find((agent) => agent.slug === slug);
                              return <span key={slug}>{member?.nameEn.slice(0, 2).toUpperCase()}</span>;
                            })}<b>One</b>
                          </div>
                          <OnePuppy mood="cheer" small reduced={reduced} label={tFor(locale, "one.onb.s4.puppy_label")} />
                          <strong>{replay ? tFor(locale, "one.onb.s4.preview_title") : tFor(locale, "one.onb.s4.ready_title")}</strong>
                          <span>{replay ? tFor(locale, "one.onb.s4.preview_body") : tFor(locale, "one.onb.s4.ready_body")}</span>
                          <button type="button" className={styles.primary} onClick={() => void continueAfterTeam()}>{tFor(locale, "one.onb.s4.see_org")}</button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                    <div className={styles.agentShelf} role="group" aria-label={tFor(locale, "one.onb.s4.shelf_aria")}>
                      {ONE_ONBOARDING_STARTER_AGENTS.map((agent, index) => {
                        const selected = selectedSlugs.includes(agent.slug);
                        return (
                          <motion.button
                            key={agent.slug}
                            type="button"
                            disabled={busy}
                            drag={!selected && !reduced}
                            dragSnapToOrigin
                            whileDrag={{ scale: 1.04, zIndex: 3 }}
                            data-tone={agent.tone}
                            data-selected={selected ? "true" : "false"}
                            data-assist={index === 0 && teamHint && !selected ? "true" : "false"}
                            onDragEnd={(_event, info) => {
                              const zone = teamZoneRef.current?.getBoundingClientRect();
                              if (
                                !selected
                                && zone
                                && info.point.x >= zone.left
                                && info.point.x <= zone.right
                                && info.point.y >= zone.top
                                && info.point.y <= zone.bottom
                              ) void toggleStarter(agent.slug);
                            }}
                            onClick={() => void toggleStarter(agent.slug)}
                            onMouseEnter={() => setAgentHint(ko ? `${agent.nameKo}: ${agent.roleKo}` : `${agent.nameEn}: ${agent.roleEn}`)}
                            onFocus={() => setAgentHint(ko ? `${agent.nameKo}: ${agent.roleKo}` : `${agent.nameEn}: ${agent.roleEn}`)}
                            aria-pressed={selected}
                          >
                            <span className={styles.agentDot}>{selected ? "✓" : "+"}</span>
                            <strong>{ko ? agent.nameKo : agent.nameEn}</strong>
                            <small>{ko ? agent.roleKo : agent.roleEn}</small>
                            <i>{tFor(locale, "one.onb.trust_label")} {agent.trustGrade}</i>
                          </motion.button>
                        );
                      })}
                    </div>
                    {agentHint && <div className={styles.agentHint} role="status" aria-live="polite">{agentHint}</div>}
                    <div ref={teamZoneRef} className={styles.teamZone} role="status" aria-live="polite" aria-busy={busy} data-filled={selectedSlugs.length > 0 ? "true" : "false"}>
                      <strong>{tFor(locale, "one.onb.team.count", { count: selectedSlugs.length })}</strong>
                      <span>{selectedSlugs.length === 0 ? tFor(locale, "one.onb.s4.drop_hint") : selectedSlugs.map((slug) => ko ? ONE_ONBOARDING_STARTER_AGENTS.find((agent) => agent.slug === slug)?.nameKo : ONE_ONBOARDING_STARTER_AGENTS.find((agent) => agent.slug === slug)?.nameEn).join(" · ")}</span>
                      <small>{tFor(locale, "one.onb.s4.pinned_note")}</small>
                    </div>
                  </div>
                  {teamHint && (
                    <div className={styles.hint}>
                      <span>{tFor(locale, "one.onb.s4.stuck_hint")}</span>
                      {teamAssist && <button type="button" disabled={busy} onClick={() => void addAllStarters()}>{tFor(locale, "one.onb.s4.add_all")}</button>}
                    </div>
                  )}
                  <div className={styles.actionsBetween}>
                    <button type="button" className={styles.back} onClick={() => void go("s3")}>← {tFor(locale, "one.onb.action.back")}</button>
                    <button type="button" className={styles.primary} disabled={busy || selectedSlugs.length < 2} onClick={() => void provisionTeam()}>{busy ? tFor(locale, "one.onb.s4.creating") : tFor(locale, "one.onb.s4.start_team")}</button>
                  </div>
                </>
              )}

              {scene === "s5" && (
                <>
                  <Dialogue reduced={reduced} onType={() => play("tap")} text={tFor(locale, "one.onb.s5.dialogue")} nextLabel={tFor(locale, "one.onb.action.next")} />
                  <div className={styles.conceptGrid}>
                    {CONCEPTS.map((concept, index) => (
                      <motion.article
                        key={concept.examples}
                        initial={reduced ? false : { opacity: 0, x: -12 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: reduced ? 0 : 0.22, delay: reduced ? 0 : index * 0.16 }}
                      >
                        <span>{concept.icon}</span><strong>{tFor(locale, concept.titleKey)}</strong><p>{tFor(locale, concept.bodyKey)}</p><small>{concept.examples}</small>
                        {index < CONCEPTS.length - 1 && <i className={styles.conceptArrow} aria-hidden="true">→</i>}
                      </motion.article>
                    ))}
                  </div>
                  <div className={styles.brandBadges} role="group" aria-label={tFor(locale, "one.onb.s5.brands_aria")}>
                    {([
                      ["MongoDB", siMongodb, "one.onb.s5.brand_store"],
                      ["PostgreSQL", siPostgresql, "one.onb.s5.brand_store"],
                      ["Firebase", siFirebase, "one.onb.s5.brand_server_store"],
                      ["Railway", siRailway, "one.onb.s5.brand_deploy"],
                      ["Vercel", siVercel, "one.onb.s5.brand_web_deploy"],
                    ] as const).map(([name, icon, tipKey]) => {
                      const tip = tFor(locale, tipKey);
                      return (
                        <button key={name} type="button" aria-label={`${name} — ${tip}`} onClick={() => setBrandTip(`${name} · ${tip}`)} onFocus={() => setBrandTip(`${name} · ${tip}`)}>
                          <BrandMark icon={icon} />{name}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      aria-label={`Web · App — ${tFor(locale, "one.onb.s5.brand_screen")}`}
                      onClick={() => setBrandTip(`Web · App · ${tFor(locale, "one.onb.s5.brand_screen")}`)}
                      onFocus={() => setBrandTip(`Web · App · ${tFor(locale, "one.onb.s5.brand_screen")}`)}
                    >Web · App</button>
                  </div>
                  {brandTip && <div className={styles.brandTip} role="status" aria-live="polite">{brandTip}</div>}
                  <p className={styles.costNote}>{tFor(locale, "one.onb.s5.cost_note")}</p>
                  <div className={styles.actionsBetween}>
                    <button type="button" className={styles.back} onClick={() => void go("s4")}>← {tFor(locale, "one.onb.action.back")}</button>
                    <button type="button" className={styles.primary} onClick={() => void go("s6")}>{tFor(locale, "one.onb.s5.enough")}</button>
                  </div>
                </>
              )}

              {scene === "s6" && (
                <>
                  <Dialogue reduced={reduced} onType={() => play("tap")} text={tFor(locale, "one.onb.s6.dialogue")} nextLabel={tFor(locale, "one.onb.action.next")} />
                  <label className={styles.seedBox}>
                    <span>{tFor(locale, "one.onb.s6.label")}</span>
                    <textarea value={seed} maxLength={500} onChange={(event) => setSeed(event.target.value)} placeholder={tFor(locale, PLACEHOLDER_KEYS[placeholderIndex])} />
                    <small>{seed.length}/500</small>
                  </label>
                  <div className={styles.examples}>
                    {EXAMPLE_SEEDS.map((key) => { const text = tFor(locale, key); return <button key={key} type="button" onClick={() => setSeed(text)}>{text}</button>; })}
                  </div>
                  <div className={styles.finishNote}>
                    <span>✓</span>
                    <p><strong>{tFor(locale, "one.onb.s6.ready")}</strong>{tFor(locale, "one.onb.s6.ready_note")}</p>
                  </div>
                  <div className={styles.actionsBetween}>
                    <button type="button" className={styles.back} onClick={() => void go(beginnerPath ? "s5" : "s3")}>← {tFor(locale, "one.onb.action.back")}</button>
                    <button type="button" className={styles.primary} disabled={busy || !seed.trim()} onClick={() => void finish()}>{busy ? tFor(locale, "one.onb.s6.finishing") : replay ? tFor(locale, "one.onb.s6.finish_replay") : tFor(locale, "one.onb.s6.start")}</button>
                  </div>
                </>
              )}
            </motion.div>
          </AnimatePresence>
          {error && <div className={styles.error} role="alert">{error}</div>}
        </div>
      </section>
    </div>
  );
}
