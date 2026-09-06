"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { RuntimeBackend, RuntimeKind, RuntimeSelection, RuntimeStatus } from "@/lib/types";
import { cliModelTagLabel, runtimeUsesEngineModelSetting } from "@shared/models";
import { llmLogoSrc } from "@/lib/llm-logo";

export type RuntimeModelPickerOption = {
  key: string;
  model?: string;
  label: string;
  tag?: string;
  runtime: RuntimeStatus;
  isDefault?: boolean;
  unavailable?: boolean;
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
  if (option.isDefault) return runtimeModelFallbackLabel(option.runtime.kind, locale);
  if (option.unavailable) return `${option.label} · ${locale === "ko" ? "연결 안 됨" : "unavailable"}`;
  return option.label;
}

export function runtimeModelFallbackLabel(kind: RuntimeKind, locale: "ko" | "en"): string {
  if (runtimeUsesEngineModelSetting(kind)) {
    return locale === "ko" ? "엔진 설정 사용" : "Use engine setting";
  }
  return locale === "ko" ? "모델 미지정" : "Model not specified";
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
  const instanceId = useId();
  const listId = `runtime-model-picker-${instanceId.replace(/:/g, "")}`;
  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.key === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const selectedProvider = selected ? runtimeProviderLabel(selected.runtime) : "";
  const selectedIdentity = selected ? runtimeProviderEngineLabel(selected.runtime) : "";
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
    const frame = window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
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

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (disabled || options.length === 0) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const onOptionKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
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
      const option = options[index];
      if (option) selectOption(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="dashboard-runtime-model-picker" ref={rootRef} data-open={open ? "true" : "false"}>
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
        onClick={() => {
          if (disabled || options.length === 0) return;
          setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
          setOpen((current) => !current);
        }}
        onKeyDown={onTriggerKeyDown}
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
        <div className="dashboard-runtime-model-picker-popover">
          <div id={listId} role="listbox" aria-label={ariaLabel} className="dashboard-runtime-model-picker-list">
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
                  onKeyDown={(event) => onOptionKeyDown(event, index)}
                >
                  <span className="dashboard-runtime-model-picker-option-mark" aria-hidden="true">
                    {logo ? <img src={logo} alt="" /> : <span>{provider.slice(0, 1).toUpperCase()}</span>}
                  </span>
                  <span className="dashboard-runtime-model-picker-option-copy">
                    <strong>{optionModelLabel(option, locale)}</strong>
                    <small>{identity}</small>
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
