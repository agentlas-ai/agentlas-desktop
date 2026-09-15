"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { RuntimeBackend, RuntimeKind, RuntimeSelection, RuntimeStatus } from "@/lib/types";
import { cliModelTagLabel, cliModels, runtimeUsesEngineModelSetting } from "@shared/models";
import { llmLogoSrc } from "@/lib/llm-logo";

export type RuntimeModelPickerOption = {
  key: string;
  model?: string;
  label: string;
  tag?: string;
  runtime: RuntimeStatus;
  isDefault?: boolean;
  unavailable?: boolean;
  /**
   * 이 별칭이 실제로 어느 모델로 풀렸는지 — 실행이 알려준 값(우리가 적은 값이 아니다).
   * claude-code 는 모델 목록 명령이 없어 화면에 별칭 `opus` 만 보였다. 세대가 바뀌면
   * 다음 실행이 새 값으로 덮으므로 하드코딩과 달리 낡지 않는다.
   */
  resolvedId?: string;
};

const RUNTIME_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  kimi: "Kimi Code",
  grok: "Grok",
  cursor: "Cursor Agent",
  byok: "BYOK API",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  mlx: "MLX",
  "agentlas-local": "Agentlas Local · On-device",
  acp: "ACP",
  agentlas: "Agentlas",
};

const BACKEND_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  mlx: "MLX",
  "agentlas-local": "Agentlas Local · On-device",
  upstage: "Upstage",
  custom: "Custom",
  glm: "GLM",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  xai: "xAI",
  openrouter: "OpenRouter",
  cursor: "Cursor",
  agentlas: "Agentlas",
};

/**
 * Older saved selections may omit `backend`. Keep their provider identity
 * honest by deriving the stable built-in provider from the runtime kind; only
 * runtimes whose provider is genuinely user/configuration-defined stay custom.
 */
const DEFAULT_BACKEND_BY_KIND: Record<RuntimeKind, RuntimeBackend> = {
  "claude-code": "anthropic",
  codex: "openai",
  antigravity: "google",
  kimi: "kimi",
  grok: "custom",
  cursor: "cursor",
  byok: "custom",
  ollama: "ollama",
  lmstudio: "lmstudio",
  mlx: "mlx",
  "agentlas-local": "agentlas-local",
  acp: "custom",
  agentlas: "agentlas",
};

export function runtimeBackendForSelection(
  selection: Pick<RuntimeSelection, "kind" | "backend">,
): RuntimeBackend {
  return selection.backend ?? DEFAULT_BACKEND_BY_KIND[selection.kind];
}

export function runtimeProviderLabel(runtime: Pick<RuntimeStatus, "backend">): string {
  return BACKEND_LABEL[runtime.backend] ?? runtime.backend;
}

export function runtimeEngineLabel(runtime: Pick<RuntimeStatus, "kind" | "backend" | "label">): string {
  if (runtime.kind === "byok") return `${runtimeProviderLabel(runtime)} API`;
  return runtime.label ?? RUNTIME_LABEL[runtime.kind] ?? runtime.kind;
}

function runtimeProviderEngineLabel(runtime: Pick<RuntimeStatus, "kind" | "backend" | "label">): string {
  const provider = runtimeProviderLabel(runtime);
  const engine = runtimeEngineLabel(runtime);
  const providerKey = provider.trim().toLocaleLowerCase();
  const engineKey = engine.trim().toLocaleLowerCase();
  if (providerKey === engineKey || engineKey.startsWith(`${providerKey} `)) return engine;
  return `${provider} · ${engine}`;
}

function optionId(prefix: string, index: number): string {
  return `${prefix}-option-${index}`;
}

function optionIsUnavailable(option: RuntimeModelPickerOption): boolean {
  return option.unavailable === true || option.runtime.credentialAccess?.status === "unavailable";
}

function optionModelLabel(option: RuntimeModelPickerOption, locale: "ko" | "en"): string {
  if (option.runtime.credentialAccess?.status === "unavailable") {
    return `${option.label} · ${locale === "ko" ? "API 키 접근 불가" : "API key unavailable"}`;
  }
  if (option.isDefault) return runtimeModelFallbackLabel(option.runtime.kind, locale, option.runtime);
  if (option.unavailable) return `${option.label} · ${locale === "ko" ? "연결 안 됨" : "unavailable"}`;
  return option.label;
}

/*
 * 모델 미지정 행의 이름. 예전 이름 "엔진 설정 사용"은 무슨 모델인지 아무도 몰랐다(오너 2026-09-13).
 * 이제 행이 스스로 말한다 — "Claude Code 기본값 · Opus" 처럼 CLI 가 자기 설정 파일에 적어 둔
 * 기본 모델(cliDefaultModel)을, 그것도 없으면 마지막 실행이 실제로 쓴 모델(observedDefaultModel)을
 * 붙인다. 둘 다 모르면 모른다고 적는다. 짐작해서 채우지 않는다.
 */
export function runtimeModelFallbackLabel(
  kind: RuntimeKind,
  locale: "ko" | "en",
  runtime?: Pick<RuntimeStatus, "cliDefaultModel" | "observedDefaultModel" | "label"> | null,
): string {
  if (!runtimeUsesEngineModelSetting(kind)) {
    return locale === "ko" ? "모델 미지정" : "Model not specified";
  }
  const engine = runtime?.label ?? RUNTIME_LABEL[kind] ?? kind;
  const configured = runtime?.cliDefaultModel
    ? (cliModels(kind).find((option) => option.id === runtime.cliDefaultModel)?.label ?? runtime.cliDefaultModel)
    : "";
  const model = configured || runtime?.observedDefaultModel || "";
  if (model) return locale === "ko" ? `${engine} 기본값 · ${model}` : `${engine} default · ${model}`;
  // 좁은 목록에서 잘리지 않게 짧게 — 무엇인지는 첫 실행이 알려 준다.
  return locale === "ko" ? `${engine} 기본값 · 모델 미확인` : `${engine} default · model unknown`;
}

export function RuntimeBrandIdentity({
  runtime,
  selection,
  locale,
}: {
  runtime: RuntimeStatus | null;
  selection: RuntimeSelection;
  locale: "ko" | "en";
}) {
  const backend = runtime?.backend ?? runtimeBackendForSelection(selection);
  const provider = runtime
    ? runtimeProviderLabel(runtime)
    : runtimeProviderLabel({ backend }) || (locale === "ko" ? "알 수 없음" : "Unknown provider");
  const engine = runtime
    ? runtimeEngineLabel(runtime)
    : RUNTIME_LABEL[selection.kind] ?? selection.kind;
  const source = runtime?.source ?? selection.source;
  const logo = llmLogoSrc({
    model: selection.model,
    backend,
    kind: runtime?.kind ?? selection.kind,
  });
  const label = `${provider} · ${engine}${source ? ` · ${source}` : ""}`;

  return (
    <span className="dashboard-runtime-identity" data-runtime-identity="true" aria-label={label}>
      <span className="dashboard-runtime-identity-mark" aria-hidden="true">
        {logo
          ? <img src={logo} alt="" />
          : <span>{provider.slice(0, 1).toUpperCase()}</span>}
      </span>
      <span className="dashboard-runtime-identity-copy">
        <strong>{provider}</strong>
        <small>{engine}{source ? ` · ${source}` : ""}</small>
        {runtime?.credentialAccess?.status === "unavailable" && (
          <small role="status">{locale === "ko"
            ? "저장된 API 키 접근 불가 · 도움말 메뉴에서 다시 시도할 수 있습니다."
            : "Saved API key unavailable · Retry access from the Help menu."}</small>
        )}
      </span>
    </span>
  );
}

export function RuntimeModelPicker({
  options,
  value,
  locale,
  disabled = false,
  ariaLabel,
  placeholder,
  onSelect,
}: {
  options: RuntimeModelPickerOption[];
  value: string;
  locale: "ko" | "en";
  disabled?: boolean;
  ariaLabel: string;
  placeholder?: string;
  onSelect: (option: RuntimeModelPickerOption) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  /*
   * ★목록을 뷰포트에 고정한다 — 조상 상자가 잘라내지 못하게.
   *
   * 오너 실사용 2026-09-07: "왜 멀티모달 드롭다운은 섹션안에 나와서 잘리냐".
   * 목록은 `position: absolute` 였고 조상 `.dashboard-runtime-control` 에
   * `overflow: hidden` 이 걸려 있다(globals.css). absolute 는 z-index 와 무관하게
   * overflow 를 가진 조상에게 **잘린다.** 그리고 멀티모달은 역할 줄의 **마지막**이라
   * 목록이 아래로 열리며 정확히 그 경계를 넘는다 — 그래서 이 줄에서만 눈에 띈다.
   *
   * fixed 로 띄우고 좌표를 트리거의 실제 사각형에서 계산하면 조상이 무엇을 하든
   * 잘리지 않는다. 아래 공간이 모자라면 위로 뒤집는다(마지막 줄의 실제 상황).
   */
  const [popover, setPopover] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const placePopover = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 6;
    const margin = 12;
    const width = Math.min(Math.max(rect.width, 250), Math.max(240, window.innerWidth - margin * 2));
    const below = window.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    // 아래가 좁으면 위로 뒤집는다. 둘 다 좁으면 넓은 쪽에 붙이고 높이를 그만큼만 준다.
    const flip = below < 180 && above > below;
    const maxHeight = Math.max(120, Math.min(320, flip ? above : below));
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
    setPopover({
      top: flip ? Math.max(margin, rect.top - gap - maxHeight) : rect.bottom + gap,
      left,
      width,
      maxHeight,
    });
  }, []);
  useLayoutEffect(() => {
    if (!open) { setPopover(null); return; }
    placePopover();
    // 스크롤·리사이즈로 트리거가 움직이면 목록도 따라간다. capture 로 어떤 조상이
    // 스크롤하든 받는다 — 안 그러면 목록만 제자리에 떠 있는다.
    const onMove = () => placePopover();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, placePopover]);
  const instanceId = useId();
  const listId = `runtime-model-picker-${instanceId.replace(/:/g, "")}`;
  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.key === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const selectedProvider = selected ? runtimeProviderLabel(selected.runtime) : "";
  const identityWithModel = (option: RuntimeModelPickerOption, base: string): string => (
    // 별칭이 어느 세대로 풀렸는지 아는 경우에만 덧붙인다. 모르면 아무 말도 하지 않는다.
    option.resolvedId ? (base ? `${base} · ${option.resolvedId}` : option.resolvedId) : base
  );
  const selectedIdentity = selected
    ? identityWithModel(selected, runtimeProviderEngineLabel(selected.runtime))
    : "";
  const selectedLogo = selected
    ? llmLogoSrc({
        model: selected.model,
        backend: selected.runtime.backend,
        kind: selected.runtime.kind,
      })
    : null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const nextIndex = selectedIndex >= 0 ? selectedIndex : 0;
    setActiveIndex(nextIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const element = optionRefs.current[activeIndex];
      element?.focus();
      // 포커스가 어떤 이유로든 실패해도 활성 줄은 눈에 보여야 한다.
      element?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const selectOption = (option: RuntimeModelPickerOption) => {
    if (optionIsUnavailable(option)) return;
    onSelect(option);
    closeAndRestoreFocus();
  };

  const moveActive = (delta: number) => {
    if (options.length === 0) return;
    setActiveIndex((current) => (current + delta + options.length) % options.length);
  };

  /*
   * ★키는 **고른 자리(root)에서** 받는다 (QA 실측 2026-09-08: "방향키로 목록이
   *   스크롤되지 않는다", "Esc 가 가끔 안 닫힌다").
   *
   *   증상은 둘이었지만 원인은 하나다. 예전에는 방향키·Escape 를 **항목(option)** 에서만
   *   처리했다. 그래서 열린 뒤 포커스가 항목까지 못 갔을 때 — 포커스는 트리거에 남는다 —
   *     · ArrowDown → 트리거 핸들러가 잡아 activeIndex 를 **선택값으로 되돌리고** 다시 연다
   *       → 목록이 한 칸도 안 움직인다("스크롤이 안 된다"로 보인다)
   *     · Escape    → 트리거 핸들러가 아예 안 보는 키라 아무 일도 안 일어난다
   *   "가끔"인 이유가 이것이다: 포커스가 항목에 닿았는지에 따라 갈렸다.
   *
   *   그래서 root 에서 한 번만 처리한다. 포커스가 트리거에 있든 항목에 있든 같은 답이 된다.
   *   (측정: focus() 자체는 목록을 스크롤시킨다 — 0 → 560px. 스크롤 배관이 아니라
   *    포커스가 도달하지 못한 것이 원인이었다.)
   */
  const onPickerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || options.length === 0) return;
    if (!open) {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
      setOpen(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, options.length - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      // 손으로 받은 index 가 아니라 **지금 활성인 것**을 고른다 — 포커스가 항목에 없을 때도
      // 사람이 화면에서 보고 있는 그 줄이 선택된다.
      const option = options[activeIndex];
      if (option) selectOption(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div
      className="dashboard-runtime-model-picker"
      ref={rootRef}
      data-open={open ? "true" : "false"}
      onKeyDown={onPickerKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        className="dashboard-runtime-model-picker-trigger"
        data-testid="runtime-model-picker"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled || options.length === 0}
        /*
         * ★좁은 창에서 모델 이름이 말줄임으로 잘리는데 **전문을 볼 곳이 없었다**
         *   (실측 2026-09-08, 1180px: "GPT-5.1 Codex" 가 62px 자리에 83px).
         *   그리고 고를 모델이 하나도 없어 회색일 때도 이유가 없었다.
         */
        title={options.length === 0
          ? (locale === "ko" ? "고를 수 있는 모델이 없습니다. 설정에서 런타임을 먼저 연결하세요." : "No models to choose from. Connect a runtime in Settings first.")
          : selected
            ? `${optionModelLabel(selected, locale)} · ${selectedIdentity}`
            : undefined}
        onClick={() => {
          if (disabled || options.length === 0) return;
          setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
          setOpen((current) => !current);
        }}
      >
        {selected ? (
          <>
            <span className="dashboard-runtime-model-picker-trigger-mark" aria-hidden="true">
              {selectedLogo
                ? <img src={selectedLogo} alt="" />
                : <span>{selectedProvider.slice(0, 1).toUpperCase()}</span>}
            </span>
            <span className="dashboard-runtime-model-picker-value">
              <strong>{optionModelLabel(selected, locale)}</strong>
              <small>{selectedIdentity}</small>
            </span>
          </>
        ) : (
          <span className="dashboard-runtime-model-picker-value">
            {placeholder ?? (locale === "ko" ? "사용 가능한 모델 없음" : "No models available")}
          </span>
        )}
        <span className="dashboard-runtime-model-picker-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          className="dashboard-runtime-model-picker-popover"
          style={popover
            ? { position: "fixed", top: popover.top, left: popover.left, width: popover.width }
            : { visibility: "hidden" }}
        >
          <div
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="dashboard-runtime-model-picker-list"
            style={popover ? { maxHeight: popover.maxHeight } : undefined}
          >
            {options.map((option, index) => {
              const provider = runtimeProviderLabel(option.runtime);
              const identity = runtimeProviderEngineLabel(option.runtime);
              const logo = llmLogoSrc({ model: option.model, backend: option.runtime.backend, kind: option.runtime.kind });
              return (
                <div
                  key={option.key}
                  ref={(element) => { optionRefs.current[index] = element; }}
                  id={optionId(listId, index)}
                  role="option"
                  tabIndex={activeIndex === index ? 0 : -1}
                  aria-selected={option.key === value}
                  aria-disabled={optionIsUnavailable(option) ? "true" : undefined}
                  data-unavailable={optionIsUnavailable(option) ? "true" : "false"}
                  className="dashboard-runtime-model-picker-option"
                  onClick={() => selectOption(option)}
                >
                  <span className="dashboard-runtime-model-picker-option-mark" aria-hidden="true">
                    {logo ? <img src={logo} alt="" /> : <span>{provider.slice(0, 1).toUpperCase()}</span>}
                  </span>
                  <span className="dashboard-runtime-model-picker-option-copy">
                    <strong>{optionModelLabel(option, locale)}</strong>
                    <small>{identityWithModel(option, identity)}</small>
                    {option.tag && <em>{cliModelTagLabel(option.tag, locale)}</em>}
                  </span>
                  {option.key === value && <span className="dashboard-runtime-model-picker-check" aria-hidden="true">✓</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
