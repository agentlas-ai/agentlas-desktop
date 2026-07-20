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
import styles from "./OneOnboarding.module.css";

type Props = {
  locale: "ko" | "en";
  onComplete: (projectSeed: string) => void;
  onVisibilityChange?: (visible: boolean) => void;
};

type Copy = { ko: string; en: string };
type MascotMood = "idle" | "talking" | "happy" | "thinking" | "cheer" | "gentle" | "point";

const PROVIDERS: Array<{
  id: Exclude<OneOnboardingProvider, null>;
  runtime: RuntimeKind;
  name: string;
  logo: string;
  page: string;
  hint: Copy;
}> = [
  { id: "openai", runtime: "codex", name: "OpenAI · Codex", logo: "/brand/llm/openai.svg", page: "https://chatgpt.com/", hint: { ko: "가장 익숙해요 · Codex 지원 플랜", en: "Most familiar · a Codex-enabled plan" } },
  { id: "anthropic", runtime: "claude-code", name: "Claude", logo: "/brand/llm/claude.svg", page: "https://claude.ai/", hint: { ko: "코딩에 강해요 · Pro/Max 또는 API", en: "Strong at coding · Pro/Max or API" } },
  { id: "kimi", runtime: "kimi", name: "Kimi", logo: "/brand/llm/kimi.svg", page: "https://www.kimi.com/", hint: { ko: "가볍게 시작하기 좋아요", en: "A lightweight place to begin" } },
  { id: "google", runtime: "gemini", name: "Gemini", logo: "/brand/llm/googlegemini.svg", page: "https://gemini.google.com/", hint: { ko: "구글 계정으로 연결해요", en: "Connect with your Google account" } },
];

const EXAMPLE_SEEDS: Copy[] = [
  { ko: "우리 카페 예약 웹사이트를 만들어줘", en: "Build a booking website for my café" },
  { ko: "이번 달 매출을 읽기 쉽게 정리해줘", en: "Turn this month's sales into a clear report" },
  { ko: "새 서비스의 이름과 첫 화면을 같이 만들어줘", en: "Name my new service and design its first screen" },
];

const CONCEPTS = [
  {
    icon: "🗂",
    title: { ko: "정보 창고 (DB)", en: "Information store (DB)" },
    body: { ko: "가게의 장부처럼 정보를 오래 보관해요.", en: "Like a shop ledger, it keeps information safe." },
    examples: "MongoDB · PostgreSQL · Firebase",
  },
  {
    icon: "🧑‍🍳",
    title: { ko: "24시간 엔진 (서버)", en: "Always-on engine (server)" },
    body: { ko: "주방처럼 요청을 받아 실제 일을 처리해요.", en: "Like a kitchen, it receives orders and does the work." },
    examples: "Railway · API",
  },
  {
    icon: "🪟",
    title: { ko: "보이는 매장 (프론트엔드)", en: "Visible storefront (frontend)" },
    body: { ko: "손님이 보는 매장처럼 화면과 버튼을 보여줘요.", en: "Like the storefront, it is the screen people touch." },
    examples: "Web · App · Vercel",
  },
] as const;

const MOOD_POSITION: Record<MascotMood, string> = {
  idle: "0% 0%",
  talking: "33.333% 0%",
  happy: "66.667% 0%",
  thinking: "100% 0%",
  cheer: "0% 100%",
  gentle: "33.333% 100%",
  point: "66.667% 100%",
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
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

function Las({
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
  return (
    <motion.div
      className={`${styles.las} ${small ? styles.lasSmall : ""}`}
      style={{ backgroundPosition: MOOD_POSITION[mood] }}
      animate={small || reduced ? false : { y: [0, -5, 0], rotate: [0, -0.7, 0.7, 0] }}
      transition={reduced ? { duration: 0 } : { duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
      role="img"
      aria-label={label}
    />
  );
}

function Dialogue({
  text,
  reduced,
  onNext,
  onType,
}: {
  text: string;
  reduced: boolean;
  onNext?: () => void;
  onType?: () => void;
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
  useEffect(() => {
    const flush = () => {
      if (!typed.complete) typed.flush();
    };
    window.addEventListener("one-onboarding-flush", flush);
    return () => window.removeEventListener("one-onboarding-flush", flush);
  }, [typed.complete, typed.flush]);
  const activate = () => typed.complete ? onNext?.() : typed.flush();
  const content = (
    <>
      <span className={styles.srOnly}>{text}</span>
      <span aria-hidden="true">{typed.visible}{!typed.complete && <span className={styles.caret}>▌</span>}</span>
    </>
  );
  return (
    <div ref={ref} className={styles.dialogue} role="status">
      {typed.complete && !onNext
        ? content
        : <button ref={retainFocus} type="button" className={styles.dialogueAction} onClick={activate} aria-label={text}>{content}</button>}
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
  const [teamCreated, setTeamCreated] = useState(false);
  const [seed, setSeed] = useState("");
  const [pendingInstall, setPendingInstall] = useState<Exclude<OneOnboardingProvider, null> | null>(null);
  const [previewProvider, setPreviewProvider] = useState<Exclude<OneOnboardingProvider, null> | null>(null);
  const [agentHint, setAgentHint] = useState<string | null>(null);
  const [talking, setTalking] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [starterTeamPresent, setStarterTeamPresent] = useState(true);
  const [loadNonce, setLoadNonce] = useState(0);
  const audioRef = useRef<AudioContext | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const originFocusRef = useRef<HTMLElement | null>(null);

  const t = useCallback((copy: Copy) => ko ? copy.ko : copy.en, [ko]);
  const visible = Boolean(state && (finishing || replay || (state.status !== "completed" && state.status !== "migrated")));
  const scene = replay ? replayScene : state?.currentScene ?? "s0";
  const beginnerPath = (state?.experience ?? "new") !== "expert";
  const path = beginnerPath
    ? (["s1", "s2", "s3", "s4", "s5", "s6"] as OneOnboardingScene[])
    : (["s0", "s3", "s4", "s6"] as OneOnboardingScene[]);

  useEffect(() => {
    const api = ipc();
    if (!api?.oneOnboarding) return;
    let cancelled = false;
    api.oneOnboarding.getState().then((next) => {
      if (cancelled) return;
      setState(next);
      setSelectedSlugs(next.selectedStarterSlugs);
      setSeed(next.projectSeed);
      setPreviewProvider(next.provider);
      setShowResume(next.status === "in-progress");
    }).catch((cause) => setError(errorMessage(cause, ko ? "온보딩을 불러오지 못했어요." : "Could not load onboarding.")));
    return () => { cancelled = true; };
  }, [ko, loadNonce]);

  useEffect(() => onVisibilityChange?.(visible), [onVisibilityChange, visible]);

  useEffect(() => {
    if (!visible || scene !== "s4") return;
    const timer = window.setTimeout(() => setTeamHint(true), 30_000);
    return () => window.clearTimeout(timer);
  }, [scene, visible]);

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
      if (event.key === "Escape" && replay) {
        event.preventDefault();
        setReplay(false);
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
      setError(errorMessage(cause, ko ? "진행 상태를 저장하지 못했어요." : "Could not save progress."));
    }
  }, [applyPatch, ko, play, replay]);

  const chooseSubscription = async (subscription: Exclude<OneOnboardingSubscription, null>) => {
    if (replay) return;
    setError(null);
    try {
      await applyPatch({ subscription });
      play("tap");
    } catch (cause) {
      setError(errorMessage(cause, ko ? "선택을 저장하지 못했어요." : "Could not save the selection."));
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
    if (replay) {
      setPreviewProvider(provider);
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await applyPatch({ provider });
      setPreviewProvider(next?.provider ?? provider);
      play("tap");
    } catch (cause) {
      setError(errorMessage(cause, ko ? "제공자 선택을 저장하지 못했어요." : "Could not save the provider selection."));
    } finally {
      setBusy(false);
    }
  };

  const connectProvider = async (provider: Exclude<OneOnboardingProvider, null>) => {
    if (replay) return go("s4");
    if (busy) return;
    const api = ipc();
    const entry = PROVIDERS.find((item) => item.id === provider);
    if (!api || !entry) return;
    setBusy(true);
    setError(null);
    setRuntimeMessage(ko ? "설치와 로그인을 확인하고 있어요…" : "Checking install and sign-in…");
    try {
      let current = state?.provider === provider ? state : await applyPatch({ provider });
      if (!current) return;
      const installed = await detectProvider(provider);
      if (state?.subscription !== "paid") {
        const opened = await api.fs.openPath(entry.page);
        if (!opened.ok) throw new Error(opened.message || (ko ? "공식 페이지를 열지 못했어요." : "Could not open the official page."));
        setRuntimeMessage(state?.subscription === "none"
          ? (ko ? "공식 가입 페이지를 열었어요. 가입과 구독 뒤 앱으로 돌아오세요." : "Opened the official page. Create an account and subscribe, then return here.")
          : (ko ? "공식 서비스 페이지를 열었어요. 필요한 플랜을 확인한 뒤 앱으로 돌아오세요." : "Opened the official service page. Check the plan you need, then return here."));
        return;
      }
      if (!installed) {
        setPendingInstall(provider);
        setRuntimeMessage(ko
          ? `${entry.name} CLI가 필요해요. 아래 ‘설치 승인’ 버튼을 눌러야만 Mac에 설치합니다.`
          : `${entry.name} CLI is required. It is installed on this Mac only after you press Approve install below.`);
        return;
      }
      current = await api.oneOnboarding.verifyProvider({ expectedVersion: current.version, provider });
      setState(current);
      if (current.brainStatus === "connected") {
        current = await api.oneOnboarding.update({ expectedVersion: current.version, patch: { currentScene: "s4" } });
        setState(current);
        setRuntimeMessage(ko ? "연결됐어요. 이제 팀을 만들어 볼게요." : "Connected. Now let's build your team.");
        play("success");
        return;
      }
      const login = await api.runtime.openCliLogin(entry.runtime as "claude-code" | "codex" | "gemini" | "kimi");
      setRuntimeMessage(provider === "kimi"
        ? (ko ? "Kimi는 로그인 상태를 안전하게 확인할 수 없어 제한 모드로만 계속할 수 있어요." : "Kimi does not expose a safe sign-in probe yet, so continue in limited mode.")
        : login.message || (ko ? "터미널에서 브라우저 로그인을 마쳐 주세요." : "Finish browser sign-in from the terminal."));
    } catch (cause) {
      setError(errorMessage(cause, ko ? "연결을 시작하지 못했어요." : "Could not start the connection."));
    } finally {
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
      setRuntimeMessage(login.message || (ko ? "설치됐어요. 브라우저 로그인을 마친 뒤 다시 확인해 주세요." : "Installed. Finish browser sign-in, then check again."));
    } catch (cause) {
      setError(errorMessage(cause, ko ? "설치를 완료하지 못했어요." : "Could not complete installation."));
    } finally {
      setBusy(false);
    }
  };

  const recheckProvider = async () => {
    if (!state?.provider || replay) return;
    setBusy(true);
    setError(null);
    try {
      const installed = await detectProvider(state.provider);
      if (!installed) {
        setRuntimeMessage(ko ? "아직 런타임이 감지되지 않았어요. 로그인 완료 뒤 다시 확인하세요." : "Runtime not detected yet. Finish sign-in and check again.");
        return;
      }
      let next = await ipc()!.oneOnboarding.verifyProvider({ expectedVersion: state.version, provider: state.provider });
      setState(next);
      if (next.brainStatus !== "connected") {
        setRuntimeMessage(state.provider === "kimi"
          ? (ko ? "Kimi는 로그인 확인 수단이 없어 제한 모드로만 계속할 수 있어요." : "Kimi has no reliable sign-in probe, so continue in limited mode.")
          : (ko ? "도구는 찾았지만 로그인 또는 유료 구독이 아직 확인되지 않았어요." : "The tool is installed, but sign-in or a paid subscription is not verified yet."));
        return;
      }
      next = await ipc()!.oneOnboarding.update({ expectedVersion: next.version, patch: { currentScene: "s4" } });
      setState(next);
      play("success");
    } catch (cause) {
      setError(errorMessage(cause, ko ? "상태를 확인하지 못했어요." : "Could not verify status."));
    } finally {
      setBusy(false);
    }
  };

  const chooseLimited = async () => {
    if (replay) return go("s4");
    if (!state?.provider || busy) {
      if (busy) return;
      setError(ko ? "먼저 사용할 AI 회사를 하나 골라 주세요." : "Choose an AI provider first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const api = ipc();
      if (!api) return;
      let next = await api.oneOnboarding.chooseLimited({ expectedVersion: state.version, provider: state.provider });
      next = await api.oneOnboarding.update({ expectedVersion: next.version, patch: { currentScene: "s4" } });
      setState(next);
    } catch (cause) {
      setError(errorMessage(cause, ko ? "제한 모드를 저장하지 못했어요." : "Could not save limited mode."));
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
        current = await api.oneOnboarding.provisionStarterTeam({ expectedVersion: current.version, memberSlugs: all });
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
      setError(errorMessage(cause, ko ? "빠른 설정을 확인하지 못했어요." : "Could not check quick setup."));
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
        setError(errorMessage(cause, ko ? "팀 선택을 저장하지 못했어요." : "Could not save team selection."));
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
      setError(errorMessage(cause, ko ? "팀 선택을 저장하지 못했어요." : "Could not save team selection."));
    } finally {
      setBusy(false);
    }
  };

  const provisionTeam = async () => {
    if (selectedSlugs.length < 2) {
      setError(ko ? "둘 이상을 골라야 팀이 됩니다." : "Choose at least two agents to make a team.");
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
      });
      setState(next);
      setTeamCreated(true);
      play("success");
    } catch (cause) {
      setError(errorMessage(cause, ko ? "스타터 팀을 만들지 못했어요." : "Could not create the starter team."));
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
      setError(errorMessage(cause, ko ? "다음 단계로 이동하지 못했어요." : "Could not continue."));
    }
  };

  const finish = async () => {
    if (!seed.trim()) {
      setError(ko ? "첫 부탁을 한 줄만 적어 주세요." : "Write your first request in one line.");
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
      setError(errorMessage(cause, ko ? "마지막 설정을 저장하지 못했어요." : "Could not save the final setup."));
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
    setPreviewProvider(state?.provider ?? null);
    setReplayScene("s0");
    setReplay(true);
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
      setError(errorMessage(cause, ko ? "AI 연결 변경을 시작하지 못했어요." : "Could not start provider recovery."));
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
      });
      setState(next);
      setStarterTeamPresent(true);
      setHelperOpen(false);
    } catch (cause) {
      setError(errorMessage(cause, ko ? "스타터 팀을 복구하지 못했어요." : "Could not repair the starter team."));
    } finally {
      setBusy(false);
    }
  };

  const sceneTitle = useMemo(() => ({
    s0: t({ ko: "처음 만나 반가워요", en: "It's good to meet you" }),
    s1: t({ ko: "어디서부터 시작할까요?", en: "Where should we begin?" }),
    s2: t({ ko: "One이 다른 이유", en: "Why One is different" }),
    s3: t({ ko: "One에게 두뇌를 연결해요", en: "Connect One's brain" }),
    s4: t({ ko: "첫 팀을 만들어 볼까요?", en: "Let's build your first team" }),
    s5: t({ ko: "세 단어만 알면 충분해요", en: "Three words are enough" }),
    s6: t({ ko: "이제 첫 부탁을 해보세요", en: "Now make your first request" }),
  })[scene], [scene, t]);

  if (!state) return error ? (
    <div className={styles.loadError} role="alert">
      <span>{error}</span>
      <button type="button" onClick={() => { setError(null); setLoadNonce((value) => value + 1); }}>
        {ko ? "다시 시도" : "Try again"}
      </button>
    </div>
  ) : null;

  if (!visible) {
    return (
      <>
        {starterTeamPresent && state.starterTeamGroupId && state.selectedStarterSlugs.length > 0 && (
          <div className={styles.starterDock} role="group" aria-label={ko ? "저장된 스타터 팀 조직도" : "Saved starter team organization chart"}>
            <div className={styles.starterAgents}>
              {state.selectedStarterSlugs.map((slug) => {
                const member = ONE_ONBOARDING_STARTER_AGENTS.find((agent) => agent.slug === slug);
                return <span key={slug} title={ko ? member?.nameKo : member?.nameEn}>{(ko ? member?.nameKo : member?.nameEn)?.slice(0, 2)}</span>;
              })}
            </div>
            <strong>{ko ? "Las 오케스트레이터" : "Las Orchestrator"}</strong>
            <small>{ko ? `스타터 팀 · ${state.selectedStarterSlugs.length}명` : `Starter team · ${state.selectedStarterSlugs.length}`}</small>
          </div>
        )}
        <div className={styles.helperWrap}>
          <AnimatePresence>
            {helperOpen && (
              <motion.div className={styles.helperBubble} initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0, y: 8 }} transition={{ duration: reduced ? 0 : 0.18 }}>
                <strong>{ko ? "Las가 여기 있어요" : "Las is right here"}</strong>
                <span>{starterTeamPresent
                  ? (ko ? "One 사용법을 언제든 다시 볼 수 있어요." : "You can revisit the One guide anytime.")
                  : (ko ? "스타터 팀이 바뀌었어요. 아래 복구 버튼으로 정확한 팀을 다시 만들 수 있어요." : "Your starter team changed. Use the repair button below to restore the exact team.")}</span>
                {error && <span role="alert">{error}</span>}
                <button type="button" onClick={openReplay}>{ko ? "튜토리얼 다시 보기" : "Replay tutorial"}</button>
                {state.status === "completed" && <button type="button" disabled={busy} onClick={() => void reopenProviderSetup()}>{ko ? "AI 연결 바꾸기" : "Change AI connection"}</button>}
                {!starterTeamPresent && state.status === "completed" && <button type="button" disabled={busy} onClick={() => void repairStarterTeam()}>{ko ? "스타터 팀 복구" : "Repair starter team"}</button>}
              </motion.div>
            )}
          </AnimatePresence>
          <button
            type="button"
            className={styles.helperButton}
            aria-label={ko ? "Las 도움말" : "Las help"}
            aria-expanded={helperOpen}
            onClick={() => setHelperOpen((open) => !open)}
          >
            <Las mood="happy" small reduced={reduced} label={ko ? "민트색 Agentlas 가이드 Las" : "Las, the mint Agentlas guide"} />
          </button>
        </div>
      </>
    );
  }

  if (showResume && !replay) {
    return (
      <div className={styles.overlay} data-one-onboarding-dialog onClick={() => window.dispatchEvent(new Event("one-onboarding-flush"))}>
        <section ref={(node) => { dialogRef.current = node; }} className={styles.resumeCard} role="dialog" aria-modal="true" aria-labelledby="one-resume-title">
          <Las mood="gentle" reduced={reduced} label={ko ? "민트색 Agentlas 가이드 Las" : "Las, the mint Agentlas guide"} />
          <h1 id="one-resume-title" tabIndex={-1}>{ko ? "하던 곳부터 이어갈까요?" : "Continue where you left off?"}</h1>
          <p>{ko ? "선택한 내용은 이 Mac에 안전하게 남아 있어요." : "Your choices are safely stored on this Mac."}</p>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={() => { setShowResume(false); void go("s0"); }}>
              {ko ? "처음부터 다시" : "Start over"}
            </button>
            <button type="button" className={styles.primary} onClick={() => setShowResume(false)}>
              {ko ? "이어하기" : "Continue"}
            </button>
          </div>
        </section>
      </div>
    );
  }

  const mood: MascotMood = talking ? "talking" : scene === "s3" && busy ? "thinking" : scene === "s4" ? "point" : scene === "s6" ? "cheer" : scene === "s2" ? "gentle" : "idle";

  return (
    <div className={styles.overlay} data-one-onboarding-dialog data-finishing={finishing ? "true" : "false"} onClick={() => window.dispatchEvent(new Event("one-onboarding-flush"))}>
      <section ref={(node) => { dialogRef.current = node; }} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="one-onboarding-title">
        <header className={styles.topbar}>
          <div
            className={styles.progress}
            role="progressbar"
            aria-label={ko ? "튜토리얼 진행률" : "Tutorial progress"}
            aria-valuemin={1}
            aria-valuemax={path.length}
            aria-valuenow={Math.max(1, path.indexOf(scene) + 1)}
            aria-valuetext={ko ? `${path.length}단계 중 ${Math.max(1, path.indexOf(scene) + 1)}단계` : `Step ${Math.max(1, path.indexOf(scene) + 1)} of ${path.length}`}
          >
            {path.map((item) => <span key={item} data-current={item === scene ? "true" : "false"} data-done={path.indexOf(item) < path.indexOf(scene) ? "true" : "false"} />)}
          </div>
          <button type="button" className={styles.sound} onClick={toggleSound} aria-label={state.soundEnabled ? (ko ? "소리 끄기" : "Mute sound") : (ko ? "소리 켜기" : "Turn sound on")}>
            {state.soundEnabled ? "♪" : "♪̸"}
          </button>
        </header>

        <div className={styles.stage}>
          <div className={styles.guideColumn}>
            <Las mood={mood} reduced={reduced} label={ko ? "민트색 Agentlas 가이드 Las" : "Las, the mint Agentlas guide"} />
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
                    text={t({ ko: "안녕하세요! 저는 Las예요. 바이브 코딩과 AI 일꾼의 세계에 오신 걸 환영해요. 코딩을 몰라도 괜찮아요. 원하는 결과를 말하면 이 친구들이 대신 만들고, 어려운 말은 제가 번역할게요.", en: "Hello! I'm Las. Welcome to vibe coding and AI workers. You do not need to know code: tell us the result you want, the team will build it, and I'll translate the technical parts." })}
                  />
                  <div className={styles.choiceGrid}>
                    <button type="button" onClick={() => void go("s1", { experience: "new" })}>
                      <span>🌱</span><strong>{ko ? "차근차근 알려줘" : "Guide me step by step"}</strong><small>{ko ? "처음이어도 괜찮아요" : "Perfect if this is new"}</small>
                    </button>
                    <button type="button" disabled={busy} onClick={() => void chooseExpert()}>
                      <span>⚡</span><strong>{ko ? "핵심만 빠르게" : "Just the essentials"}</strong><small>{ko ? "연결부터 바로 확인해요" : "Jump straight to connection"}</small>
                    </button>
                  </div>
                </>
              )}

              {scene === "s1" && (
                <>
                  <Dialogue reduced={reduced} onType={() => play("tap")} text={t({ ko: "좋아요, 천천히 가요. 하나도 안 급해요. 지금 나와 가장 가까운 경험을 골라 주세요. 어떤 답이든 완벽해요.", en: "Great — we'll go slowly. There is no rush. Choose the experience closest to yours; every answer is perfectly fine." })} />
                  <div className={styles.choiceGridThree}>
                    {[
                      ["new", "🌿", { ko: "완전히 처음이에요", en: "I'm completely new" }],
                      ["chat", "💬", { ko: "ChatGPT는 써봤어요", en: "I've used ChatGPT" }],
                      ["cli", "⌨️", { ko: "코딩 도구도 써봤어요", en: "I've used coding tools" }],
                    ].map(([id, icon, copy]) => (
                      <button key={String(id)} type="button" onClick={() => void go("s2", { experience: id })}>
                        <span>{String(icon)}</span><strong>{t(copy as Copy)}</strong>
                      </button>
                    ))}
                  </div>
                  <button type="button" className={styles.back} onClick={() => void go("s0")}>← {ko ? "뒤로" : "Back"}</button>
                </>
              )}

              {scene === "s2" && (
                <>
                  <Dialogue
                    reduced={reduced}
                    onType={() => play("tap")}
                    text={state.experience === "cli"
                      ? t({ ko: "Codex나 Claude Code를 들어보셨다면 이미 감을 잡으셨을 거예요. 이런 도구는 내 컴퓨터에서 허락받은 파일을 직접 고칠 수 있고, One은 그 과정을 더 쉽게 묶어줘요.", en: "If you've heard of Codex or Claude Code, you already know the idea: these tools can edit allowed files on your computer, and One makes that workflow easier." })
                      : state.rephraseUsed
                      ? t({ ko: "ChatGPT는 인터넷 건너편 친구예요. One은 내 Mac 안에 있어서, 내가 허락한 파일과 앱을 직접 도울 수 있어요.", en: "ChatGPT is a friend across the internet. One lives on your Mac, so it can help with files and apps you allow." })
                      : t({ ko: "이게 헷갈리는 건 정말 정상이에요. 일반 웹 챗은 구름 너머 회사 컴퓨터에 있어서 내 Mac 파일에 손을 넣지 못해요. 그래서 앱을 부탁해도 코드 글만 줄 때가 많죠. One은 내 Mac에서, 내가 허락한 파일과 도구로 실제 작업을 이어갑니다.", en: "It is completely normal for this to feel confusing. A web chat runs on a company computer beyond the cloud, so it cannot reach into files on your Mac and often stops at giving you code as text. One works here, using only the files and tools you allow." })}
                    onNext={() => void go("s3")}
                  />
                  <div className={styles.wallVisual} role="group" aria-label={ko ? "웹 챗과 One의 차이" : "Difference between web chat and One"}>
                    <img
                      src="/brand/one-local-firewall-mint.png"
                      alt={ko ? "멀리 있는 클라우드 AI는 투명 방화벽 너머의 내 Mac 파일에 닿지 못하고, 민트색 Las는 Mac 안에서 허락한 파일을 돕는 장면" : "A distant cloud AI cannot reach local Mac files through a transparent firewall, while mint Las helps with allowed files on the Mac"}
                    />
                    <div className={styles.wallLegend}>
                      <span><strong>Web chat</strong><small>{ko ? "인터넷 건너편" : "Across the internet"}</small></span>
                      <span><strong>{ko ? "투명 방화벽" : "Transparent firewall"}</strong><small>{ko ? "내 파일 보호" : "Protects local files"}</small></span>
                      <span><strong>One · My Mac</strong><small>{ko ? "허락한 도구와 파일" : "Allowed tools and files"}</small></span>
                    </div>
                  </div>
                  <div className={styles.actionsBetween}>
                    <button type="button" className={styles.back} onClick={() => void go("s1")}>← {ko ? "뒤로" : "Back"}</button>
                    <div className={styles.actions}>
                      {!state.rephraseUsed && state.experience !== "cli" && !replay && <button type="button" className={styles.secondary} onClick={() => void applyPatch({ rephraseUsed: true })}>{ko ? "한 번만 더 쉽게" : "Explain once more, simply"}</button>}
                      <button type="button" className={styles.primary} onClick={() => void go("s3")}>{ko ? "이해했어요" : "Got it"}</button>
                    </div>
                  </div>
                </>
              )}

              {scene === "s3" && (
                <>
                  <Dialogue reduced={reduced} onType={() => play("tap")} text={t({ ko: "일꾼은 준비됐지만 움직이려면 AI 두뇌가 필요해요. 구독료는 Agentlas가 아니라 OpenAI나 Anthropic 같은 두뇌 회사에 내는 돈이에요. 이미 유료로 쓰고 있다면 추가 비용 없이 연결만 하면 됩니다. 무료 계정도 여기까지 정말 잘 왔어요. 비밀번호와 결제 정보는 One이 받지 않아요.", en: "The workers are ready, but they need an AI brain. That subscription is paid to a model company such as OpenAI or Anthropic, not Agentlas. If you already have a paid plan, just connect it with no duplicate Agentlas model charge. A free account got you this far, too. One never asks for passwords or payment details." })} />
                  <div className={styles.subscriptionRow} role="radiogroup" aria-label={ko ? "현재 구독 상태" : "Current subscription status"}>
                    {[
                      ["paid", "✓", { ko: "유료 구독 있음", en: "I have a paid plan" }],
                      ["free", "○", { ko: "무료 계정만", en: "Free account only" }],
                      ["none", "+", { ko: "아직 계정 없음", en: "No account yet" }],
                    ].map(([id, icon, copy]) => (
                      <button
                        key={String(id)}
                        type="button"
                        role="radio"
                        aria-checked={state.subscription === id}
                        tabIndex={state.subscription === id || (!state.subscription && id === "paid") ? 0 : -1}
                        data-selected={state.subscription === id ? "true" : "false"}
                        onKeyDown={(event) => moveRadio(event, ["paid", "free", "none"] as const, state.subscription, (value) => void chooseSubscription(value))}
                        onClick={() => void chooseSubscription(id as Exclude<OneOnboardingSubscription, null>)}
                      >
                        <span>{String(icon)}</span>{t(copy as Copy)}
                      </button>
                    ))}
                  </div>
                  <div className={styles.providerGrid} role="radiogroup" aria-label={ko ? "AI 제공 회사" : "AI provider"}>
                    {PROVIDERS.map((provider) => (
                      <button
                        key={provider.id}
                        type="button"
                        role="radio"
                        aria-checked={(replay ? previewProvider : state.provider) === provider.id}
                        tabIndex={(replay ? previewProvider : state.provider) === provider.id || (!(replay ? previewProvider : state.provider) && provider.id === "openai") ? 0 : -1}
                        disabled={!state.subscription || busy}
                        data-selected={(replay ? previewProvider : state.provider) === provider.id ? "true" : "false"}
                        onKeyDown={(event) => moveRadio(event, PROVIDERS.map((item) => item.id), replay ? previewProvider : state.provider, (value) => void selectProvider(value))}
                        onClick={() => void selectProvider(provider.id)}
                      >
                        <img src={provider.logo} alt="" /><strong>{provider.name}</strong>
                        <small>{t(provider.hint)}</small>
                      </button>
                    ))}
                  </div>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={busy || !(replay ? previewProvider : state.provider)}
                      onClick={() => {
                        const provider = replay ? previewProvider : state.provider;
                        if (provider) void connectProvider(provider);
                      }}
                    >
                      {ko ? "이 제공자로 연결" : "Connect this provider"}
                    </button>
                  </div>
                  {state.subscription === "free" && (
                    <div className={styles.accountGuide}>
                      <strong>{ko ? "계정은 있으니 한 발만 더 가면 돼요" : "You already have an account — just one more step"}</strong>
                      <ol>
                        <li>{ko ? "고른 회사의 공식 화면에서 코딩 에이전트가 포함된 플랜을 확인해요." : "On the provider's official page, choose a plan that includes its coding agent."}</li>
                        <li>{ko ? "이 앱으로 돌아와 ‘다시 확인’을 누르면 이어서 연결해요." : "Return here and press Check again to finish connecting."}</li>
                      </ol>
                    </div>
                  )}
                  {state.subscription === "none" && (
                    <div className={styles.accountGuide}>
                      <strong>{ko ? "완전 처음이어도 3단계면 돼요" : "Completely new? It only takes three steps"}</strong>
                      <ol>
                        <li>{ko ? "고른 회사의 공식 페이지에서 이메일이나 Google 계정으로 가입해요." : "Create an account on the provider's official page with email or Google."}</li>
                        <li>{ko ? "코딩 에이전트를 쓸 수 있는 플랜을 공식 화면에서 켜요." : "Enable a plan that supports its coding agent on the official page."}</li>
                        <li>{ko ? "One으로 돌아와 ‘다시 확인’을 누르면 자동으로 살펴봐요." : "Return to One and press Check again for automatic verification."}</li>
                      </ol>
                      <small>{ko ? "비밀번호와 결제 정보는 One이 받지 않아요." : "One never receives your password or payment information."}</small>
                    </div>
                  )}
                  {(runtimeMessage || runtimeFacts.length > 0) && (
                    <div className={styles.doctor} role="status">
                      <strong>{ko ? "연결 점검" : "Connection check"}</strong>
                      <span>{runtimeMessage}</span>
                      <ul>
                        <li data-ok={state.provider ? runtimeFacts.some((item) => providerMatchesRuntime(state.provider!, item)) : false}>{ko ? "앱 또는 CLI 설치" : "App or CLI installed"}</li>
                        <li data-ok={state.brainStatus === "connected"}>{ko ? "로그인과 실행 감지" : "Sign-in and execution detected"}</li>
                        <li data-ok={state.brainStatus === "connected"}>{ko ? "One에서 사용 준비" : "Ready for One"}</li>
                      </ul>
                      <div className={styles.actions}>
                        {pendingInstall && <button type="button" className={styles.primary} disabled={busy} onClick={() => void approveInstall()}>{ko ? "CLI 설치 승인" : "Approve CLI install"}</button>}
                        <button type="button" className={styles.secondary} disabled={busy || !state.provider} onClick={() => void recheckProvider()}>{ko ? "다시 확인" : "Check again"}</button>
                        <button type="button" className={styles.secondary} disabled={busy} onClick={() => void chooseLimited()}>{ko ? "제한 모드로 계속" : "Continue in limited mode"}</button>
                      </div>
                    </div>
                  )}
                  <button type="button" className={styles.back} onClick={() => void go(state.experience === "expert" ? "s0" : "s2")}>← {ko ? "뒤로" : "Back"}</button>
                </>
              )}

              {scene === "s4" && (
                <>
                  <Dialogue reduced={reduced} onType={() => play("tap")} text={t({ ko: "세팅 완료! 이 다섯 전문가는 스타터 팀으로 저장할 수 있어요. 카드를 아래 팀 자리로 끌어오세요. 둘이면 팀, 다섯이면 첫 제품을 만들기 좋은 완전체예요.", en: "Setup complete! You can save these five specialists as your starter team. Drag cards into the team area. Two make a team; all five make a strong first product crew." })} />
                  <div className={styles.teamBuilder}>
                    <AnimatePresence>
                      {teamCreated && (
                        <motion.div className={styles.teamCelebration} role="status" aria-live="polite" initial={reduced ? false : { opacity: 0, scale: 0.82 }} animate={{ opacity: 1, scale: 1 }} exit={reduced ? undefined : { opacity: 0 }} transition={{ duration: reduced ? 0 : 0.26 }}>
                          <div className={styles.confetti} aria-hidden="true">✦ · ✧ · ✦</div>
                          <div className={styles.teamBirth} aria-hidden="true">
                            {selectedSlugs.map((slug) => {
                              const member = ONE_ONBOARDING_STARTER_AGENTS.find((agent) => agent.slug === slug);
                              return <span key={slug}>{member?.nameEn.slice(0, 2).toUpperCase()}</span>;
                            })}<b>Las</b>
                          </div>
                          <Las mood="cheer" small reduced={reduced} label={ko ? "팀 생성을 축하하는 민트색 Las" : "Mint Las celebrating the new team"} />
                          <strong>{replay ? (ko ? "이 팀 구성을 미리 봤어요" : "Here is the team preview") : (ko ? "오케스트레이터가 만들어졌어요!" : "Your orchestrator is ready!")}</strong>
                          <span>{replay ? (ko ? "다시 보기는 저장된 팀을 바꾸지 않아요." : "Replay does not change your saved team.") : (ko ? "Las가 팀장으로서 선택한 전문가에게 일을 나눕니다." : "Las will lead the team and divide work among your specialists.")}</span>
                          <button type="button" className={styles.primary} onClick={() => void continueAfterTeam()}>{ko ? "조직도 확인하고 계속" : "See the org chart and continue"}</button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                    <div className={styles.agentShelf} role="group" aria-label={ko ? "스타터 에이전트" : "Starter agents"}>
                      {ONE_ONBOARDING_STARTER_AGENTS.map((agent) => {
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
                            onDragEnd={(_event, info) => { if (!selected && info.offset.y > 55) void toggleStarter(agent.slug); }}
                            onClick={() => void toggleStarter(agent.slug)}
                            onMouseEnter={() => setAgentHint(ko ? `${agent.nameKo}: ${agent.roleKo}` : `${agent.nameEn}: ${agent.roleEn}`)}
                            onFocus={() => setAgentHint(ko ? `${agent.nameKo}: ${agent.roleKo}` : `${agent.nameEn}: ${agent.roleEn}`)}
                            aria-pressed={selected}
                          >
                            <span className={styles.agentDot}>{selected ? "✓" : "+"}</span>
                            <strong>{ko ? agent.nameKo : agent.nameEn}</strong>
                            <small>{ko ? agent.roleKo : agent.roleEn}</small>
                            <i>{ko ? "신뢰" : "Trust"} {agent.trustGrade}</i>
                          </motion.button>
                        );
                      })}
                    </div>
                    {agentHint && <div className={styles.agentHint} role="status" aria-live="polite">{agentHint}</div>}
                    <div className={styles.teamZone} role="status" aria-live="polite" aria-busy={busy} data-filled={selectedSlugs.length > 0 ? "true" : "false"}>
                      <strong>{ko ? `내 스타터 팀 · ${selectedSlugs.length}/5` : `My starter team · ${selectedSlugs.length}/5`}</strong>
                      <span>{selectedSlugs.length === 0 ? (ko ? "여기로 끌거나 카드를 눌러 주세요" : "Drag here or click a card") : selectedSlugs.map((slug) => ko ? ONE_ONBOARDING_STARTER_AGENTS.find((agent) => agent.slug === slug)?.nameKo : ONE_ONBOARDING_STARTER_AGENTS.find((agent) => agent.slug === slug)?.nameEn).join(" · ")}</span>
                      <small>{ko ? "이 고정 권한은 만료되지 않으며, 공개·안전 요건을 만족하는 동안 로그인 계정에서 0크레딧으로 실행됩니다." : "This pinned grant does not expire and runs at zero Hub credits for signed-in accounts while publication and safety requirements remain satisfied."}</small>
                    </div>
                  </div>
                  {teamHint && (
                    <div className={styles.hint}>
                      <span>{ko ? "막히면 다섯 명을 한 번에 담아도 돼요." : "If you're stuck, add all five at once."}</span>
                      <button type="button" disabled={busy} onClick={() => void addAllStarters()}>{ko ? "모두 추가" : "Add all"}</button>
                    </div>
                  )}
                  <div className={styles.actionsBetween}>
                    <button type="button" className={styles.back} onClick={() => void go("s3")}>← {ko ? "뒤로" : "Back"}</button>
                    <button type="button" className={styles.primary} disabled={busy || selectedSlugs.length < 2} onClick={() => void provisionTeam()}>{busy ? (ko ? "팀 만드는 중…" : "Creating team…") : (ko ? "이 팀으로 시작" : "Start with this team")}</button>
                  </div>
                </>
              )}

              {scene === "s5" && (
                <>
                  <Dialogue reduced={reduced} onType={() => play("tap")} text={t({ ko: "앞으로 이 말들이 보여도 겁먹지 마세요. 가게에 비유하면 아주 단순해요. 집에 데이터센터가 없어도 괜찮아요. 저장소와 서버는 처음엔 무료로 빌리고, 사용자가 늘면 그때 비용을 정하면 됩니다.", en: "Don't worry when you see these words. They are simple when you picture a shop. You do not need a data center at home: storage and servers can start free, and you can decide on costs after people arrive." })} />
                  <div className={styles.conceptGrid}>
                    {CONCEPTS.map((concept) => (
                      <article key={concept.examples}>
                        <span>{concept.icon}</span><strong>{t(concept.title)}</strong><p>{t(concept.body)}</p><small>{concept.examples}</small>
                      </article>
                    ))}
                  </div>
                  <div className={styles.brandBadges} role="group" aria-label={ko ? "나중에 고를 수 있는 실제 서비스 예시" : "Real services you can choose later"}>
                    <span title={ko ? "데이터 저장소 · 나중에 골라도 돼요" : "Data store · choose later"}><BrandMark icon={siMongodb} />MongoDB</span>
                    <span title={ko ? "데이터 저장소 · 나중에 골라도 돼요" : "Data store · choose later"}><BrandMark icon={siPostgresql} />PostgreSQL</span>
                    <span title={ko ? "서버와 저장소 · 나중에 골라도 돼요" : "Server and storage · choose later"}><BrandMark icon={siFirebase} />Firebase</span>
                    <span title={ko ? "서버 배포 · 나중에 골라도 돼요" : "Server deployment · choose later"}><BrandMark icon={siRailway} />Railway</span>
                    <span title={ko ? "웹 배포 · 나중에 골라도 돼요" : "Web deployment · choose later"}><BrandMark icon={siVercel} />Vercel</span>
                    <span title={ko ? "화면 · 웹이나 앱은 나중에 골라도 돼요" : "Screen · choose web or app later"}>Web · App</span>
                  </div>
                  <p className={styles.costNote}>{ko ? "처음엔 무료로 시작해도 돼요. 사용자가 많아진 뒤 월 20달러쯤, 치킨 한 마리 값부터 생각하면 충분해요." : "Start free. When people arrive, you can think about plans around $20 a month — roughly one casual meal."}</p>
                  <div className={styles.actionsBetween}>
                    <button type="button" className={styles.back} onClick={() => void go("s4")}>← {ko ? "뒤로" : "Back"}</button>
                    <button type="button" className={styles.primary} onClick={() => void go("s6")}>{ko ? "이 정도면 충분해요" : "That's enough for now"}</button>
                  </div>
                </>
              )}

              {scene === "s6" && (
                <>
                  <Dialogue reduced={reduced} onType={() => play("tap")} text={t({ ko: "축하해요. 이제 준비가 끝났어요. 완벽한 지시문은 필요 없어요. 친구에게 부탁하듯 한 줄만 적으면, 방금 만든 팀과 제가 나머지를 정리할게요.", en: "Congratulations — setup is complete. You don't need a perfect prompt. Ask in one line like you would ask a friend; your new team and I will organize the rest." })} />
                  <label className={styles.seedBox}>
                    <span>{ko ? "One에게 맡길 첫 일" : "Your first request for One"}</span>
                    <textarea value={seed} maxLength={500} onChange={(event) => setSeed(event.target.value)} placeholder={ko ? "예: 우리 가게 예약 웹사이트를 만들어줘" : "Example: Build a booking website for my shop"} />
                    <small>{seed.length}/500</small>
                  </label>
                  <div className={styles.examples}>
                    {EXAMPLE_SEEDS.map((copy) => <button key={copy.en} type="button" onClick={() => setSeed(t(copy))}>{t(copy)}</button>)}
                  </div>
                  <div className={styles.finishNote}>
                    <span>✓</span>
                    <p><strong>{ko ? "준비 완료" : "Ready"}</strong>{ko ? "입력한 문장은 One의 큰 입력창에 그대로 채워집니다. 전송은 직접 눌러 결정하세요." : "This text will be placed in One's main composer. You decide when to send it."}</p>
                  </div>
                  <div className={styles.actionsBetween}>
                    <button type="button" className={styles.back} onClick={() => void go(beginnerPath ? "s5" : "s4")}>← {ko ? "뒤로" : "Back"}</button>
                    <button type="button" className={styles.primary} disabled={busy || !seed.trim()} onClick={() => void finish()}>{busy ? (ko ? "마무리 중…" : "Finishing…") : replay ? (ko ? "다시 보기 끝내기" : "Finish replay") : (ko ? "One 시작하기" : "Start One")}</button>
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
