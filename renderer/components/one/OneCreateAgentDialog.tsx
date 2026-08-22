"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  IconCheck,
  IconFileUp,
  IconImage,
  IconPlus,
  IconSparkles,
  IconWand,
} from "@/components/Icon";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import { ipc } from "@/lib/ipc";
import { ONE_CHARACTER_OPTIONS, type OneCharacterId } from "@/lib/one-characters";
import type { CreateOneTeamAgentResult } from "@shared/one-org";
import type { RuntimeSelection, RuntimeStatus } from "@shared/types";
import { OneBottomSheet } from "./OneBottomSheet";
import styles from "./OneCreateAgentDialog.module.css";

type AvatarMode = "original" | "sketch" | "generated" | "upload";
type DraftStatus = "idle" | "saving" | "saved" | "error";

export type OneCreateAgentSeed = {
  token: number;
  name?: string;
  title?: string;
  description?: string;
};

type StoredDraft = {
  mode: AvatarMode;
  characterId: OneCharacterId;
  name: string;
  title: string;
  description: string;
  generatePrompt: string;
  generatedSrc: string | null;
  uploadedSrc: string | null;
  uploadedName: string;
  runtimeSelection: RuntimeSelection | null;
};

type AgentModelOption = {
  key: string;
  label: string;
  detail: string;
  selection: RuntimeSelection;
};

const DRAFT_KEY = "agentlas.one.new-agent-draft.v2";
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MODES = new Set<AvatarMode>(["original", "sketch", "generated", "upload"]);
const CHARACTER_IDS = new Set<string>(ONE_CHARACTER_OPTIONS.map((item) => item.id));

const EMPTY_DRAFT: StoredDraft = {
  mode: "original",
  characterId: "blue-wave",
  name: "",
  title: "",
  description: "",
  generatePrompt: "",
  generatedSrc: null,
  uploadedSrc: null,
  uploadedName: "",
  runtimeSelection: null,
};

function storedRuntimeSelection(value: unknown): RuntimeSelection | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<RuntimeSelection>;
  if (typeof row.kind !== "string") return null;
  return {
    kind: row.kind as RuntimeSelection["kind"],
    ...(typeof row.backend === "string" ? { backend: row.backend } : {}),
    ...(typeof row.source === "string" ? { source: row.source } : {}),
    ...(typeof row.model === "string" && row.model ? { model: row.model } : {}),
    ...(typeof row.effort === "string" && row.effort ? { effort: row.effort } : {}),
    ...(typeof row.longContext === "boolean" ? { longContext: row.longContext } : {}),
    role: "worker",
    inherit: false,
  };
}

function runtimeSelectionKey(selection: RuntimeSelection): string {
  return JSON.stringify({
    kind: selection.kind,
    backend: selection.backend ?? null,
    source: selection.source ?? null,
    model: selection.model ?? null,
  });
}

function readDraft(): StoredDraft {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    const mode = typeof parsed.mode === "string" && MODES.has(parsed.mode as AvatarMode)
      ? parsed.mode as AvatarMode
      : EMPTY_DRAFT.mode;
    const characterId = typeof parsed.characterId === "string" && CHARACTER_IDS.has(parsed.characterId)
      ? parsed.characterId as OneCharacterId
      : EMPTY_DRAFT.characterId;
    return {
      mode,
      characterId,
      name: typeof parsed.name === "string" ? parsed.name.slice(0, 80) : "",
      title: typeof parsed.title === "string" ? parsed.title.slice(0, 100) : "",
      description: typeof parsed.description === "string" ? parsed.description.slice(0, 1_200) : "",
      generatePrompt: typeof parsed.generatePrompt === "string" ? parsed.generatePrompt.slice(0, 600) : "",
      generatedSrc: typeof parsed.generatedSrc === "string" && parsed.generatedSrc.startsWith("data:image/") ? parsed.generatedSrc : null,
      uploadedSrc: typeof parsed.uploadedSrc === "string" && parsed.uploadedSrc.startsWith("data:image/") ? parsed.uploadedSrc : null,
      uploadedName: typeof parsed.uploadedName === "string" ? parsed.uploadedName.slice(0, 180) : "",
      runtimeSelection: storedRuntimeSelection(parsed.runtimeSelection),
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

function dataUrlByteLength(value: string): number {
  const comma = value.indexOf(",");
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const payload = value.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The selected character image could not be read."));
    image.src = source;
  });
}

async function normalizeImage(blob: Blob): Promise<string> {
  if (!blob.type.startsWith("image/")) throw new Error("Choose a PNG, JPEG, or WebP image.");
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImage(objectUrl);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight) throw new Error("The selected character image is empty.");

    for (const maxDimension of [512, 448, 384, 320, 256]) {
      const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image processing is unavailable.");
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      const png = canvas.toDataURL("image/png");
      if (dataUrlByteLength(png) <= MAX_AVATAR_BYTES) return png;
      for (const quality of [0.92, 0.82, 0.72, 0.62]) {
        const webp = canvas.toDataURL("image/webp", quality);
        if (webp.startsWith("data:image/webp;") && dataUrlByteLength(webp) <= MAX_AVATAR_BYTES) return webp;
      }
    }
    throw new Error("The character image is too large. Choose a simpler image and try again.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function normalizeImageSource(source: string): Promise<string> {
  const response = await fetch(source);
  if (!response.ok) throw new Error("The generated character image could not be loaded.");
  return normalizeImage(await response.blob());
}

function modeStyle(mode: AvatarMode): "original" | "sketch" | null {
  if (mode === "original" || mode === "sketch") return mode;
  return null;
}

export function OneCreateAgentDialog({
  open,
  locale,
  seed,
  onClose,
  onCreated,
  onAddExisting,
}: {
  open: boolean;
  locale: "ko" | "en";
  seed?: OneCreateAgentSeed | null;
  onClose: () => void;
  onCreated: (result: CreateOneTeamAgentResult) => void | Promise<void>;
  onAddExisting: () => void;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const generationRequestRef = useRef(0);
  const draftHydratedRef = useRef(false);
  const appliedSeedRef = useRef<number | null>(null);
  const skipNextDraftWriteRef = useRef(false);
  const [mode, setAvatarMode] = useState<AvatarMode>(EMPTY_DRAFT.mode);
  const [characterId, setCharacterId] = useState<OneCharacterId>(EMPTY_DRAFT.characterId);
  const [name, setName] = useState(EMPTY_DRAFT.name);
  const [title, setTitle] = useState(EMPTY_DRAFT.title);
  const [description, setDescription] = useState(EMPTY_DRAFT.description);
  const [generatePrompt, setGeneratePrompt] = useState(EMPTY_DRAFT.generatePrompt);
  const [generatedSrc, setGeneratedSrc] = useState<string | null>(EMPTY_DRAFT.generatedSrc);
  const [uploadedSrc, setUploadedSrc] = useState<string | null>(EMPTY_DRAFT.uploadedSrc);
  const [uploadedName, setUploadedName] = useState(EMPTY_DRAFT.uploadedName);
  const [runtimeSelection, setRuntimeSelection] = useState<RuntimeSelection | null>(EMPTY_DRAFT.runtimeSelection);
  const [modelOptions, setModelOptions] = useState<AgentModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const ko = locale === "ko";

  const draft = useMemo<StoredDraft>(() => ({
    mode,
    characterId,
    name,
    title,
    description,
    generatePrompt,
    generatedSrc,
    uploadedSrc,
    uploadedName,
    runtimeSelection,
  }), [characterId, description, generatePrompt, generatedSrc, mode, name, runtimeSelection, title, uploadedName, uploadedSrc]);

  useEffect(() => {
    if (draftHydratedRef.current) return;
    const restored = readDraft();
    setAvatarMode(restored.mode);
    setCharacterId(restored.characterId);
    setName(restored.name);
    setTitle(restored.title);
    setDescription(restored.description);
    setGeneratePrompt(restored.generatePrompt);
    setGeneratedSrc(restored.generatedSrc);
    setUploadedSrc(restored.uploadedSrc);
    setUploadedName(restored.uploadedName);
    setRuntimeSelection(restored.runtimeSelection);
    draftHydratedRef.current = true;
    setDraftStatus(restored.name || restored.description || restored.generatedSrc || restored.uploadedSrc ? "saved" : "idle");
  }, []);

  useEffect(() => {
    if (!draftHydratedRef.current) return;
    if (skipNextDraftWriteRef.current) {
      skipNextDraftWriteRef.current = false;
      return;
    }
    setDraftStatus("saving");
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        setDraftStatus("saved");
      } catch {
        setDraftStatus("error");
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const api = ipc();
    if (!api?.runtime) return;
    let cancelled = false;
    setModelsLoading(true);
    void api.runtime.detect().then(async (runtimes) => {
      const rows = await Promise.all(runtimes.map(async (runtime: RuntimeStatus) => {
        const models = await api.runtime.listModels({
          kind: runtime.kind,
          backend: runtime.backend,
          availableModels: runtime.availableModels,
        }).catch(() => []);
        const provider = runtime.label || runtime.backend || runtime.kind;
        const selections = models.length > 0
          ? models.map((model) => ({ model: model.id, label: model.label, tag: model.tag }))
          : [{ model: runtime.model ?? undefined, label: runtime.model || (ko ? "기본 모델" : "Default model"), tag: undefined }];
        return selections.map((model) => {
          const selection: RuntimeSelection = {
            kind: runtime.kind,
            backend: runtime.backend,
            source: runtime.source,
            ...(model.model ? { model: model.model } : {}),
            role: "worker",
            inherit: false,
          };
          const key = runtimeSelectionKey(selection);
          return {
            key,
            label: model.label,
            detail: [model.tag, provider].filter(Boolean).join(" · "),
            selection,
          } satisfies AgentModelOption;
        });
      }));
      if (!cancelled) setModelOptions(rows.flat());
    }).catch(() => {
      if (!cancelled) setModelOptions([]);
    }).finally(() => {
      if (!cancelled) setModelsLoading(false);
    });
    return () => { cancelled = true; };
  }, [ko, open]);

  useEffect(() => {
    if (!open || !seed || !draftHydratedRef.current || appliedSeedRef.current === seed.token) return;
    appliedSeedRef.current = seed.token;
    // A One-authored build draft replaces only textual definition fields. The
    // person's selected/generated/uploaded character remains untouched, so
    // opening a result card can never discard minutes of image work.
    if (typeof seed.name === "string") setName(seed.name.slice(0, 80));
    if (typeof seed.title === "string") setTitle(seed.title.slice(0, 100));
    if (typeof seed.description === "string") setDescription(seed.description.slice(0, 1_200));
    setError(null);
  }, [open, seed]);

  const selectedStyle = modeStyle(mode);
  const visibleCharacters = useMemo(
    () => ONE_CHARACTER_OPTIONS.filter((character) => character.style === selectedStyle),
    [selectedStyle],
  );
  const selectedCharacter = visibleCharacters.find((item) => item.id === characterId) ?? visibleCharacters[0] ?? ONE_CHARACTER_OPTIONS[0];
  const previewSrc = selectedStyle
    ? selectedCharacter.src
    : mode === "generated"
      ? generatedSrc
      : uploadedSrc;
  const avatarReady = Boolean(selectedStyle || previewSrc);

  const persistDraftNow = () => {
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      setDraftStatus("saved");
    } catch {
      setDraftStatus("error");
    }
  };

  const chooseMode = (nextMode: AvatarMode) => {
    setAvatarMode(nextMode);
    setError(null);
    if (nextMode === "original" || nextMode === "sketch") {
      const current = ONE_CHARACTER_OPTIONS.find((item) => item.id === characterId);
      if (current?.style !== nextMode) {
        const first = ONE_CHARACTER_OPTIONS.find((item) => item.style === nextMode);
        if (first) setCharacterId(first.id);
      }
    }
  };

  const generateCharacter = async () => {
    const prompt = generatePrompt.replace(/\s+/g, " ").trim();
    const api = ipc();
    if (!prompt || !api?.multimodal?.generateImage || generating) return;
    const requestId = generationRequestRef.current + 1;
    generationRequestRef.current = requestId;
    setGenerating(true);
    setGenerationStartedAt(Date.now());
    setError(null);
    try {
      const result = await api.multimodal.generateImage({
        model: "auto",
        prompt: `Create one original friendly AI teammate character for a white productivity app. ${prompt}. Match a simple Grok Bot-like 2D hand-drawn mascot language without copying a specific character: one bold rounded geometric silhouette, tiny expressive eyes, slightly imperfect sketch character, saturated solid color, centered full body, transparent alpha background. No words, no logo, no scene, no square image background, no badge, no enclosing frame, no surrounding border, no drop shadow, no glossy 3D rendering, and no gradient-heavy pastel treatment.`,
      });
      if (generationRequestRef.current !== requestId) return;
      if (!result.ok || !result.src) throw new Error(result.message || "Image generation did not return an image.");
      const normalized = await normalizeImageSource(result.src);
      if (generationRequestRef.current !== requestId) return;
      setGeneratedSrc(normalized);
      setAvatarMode("generated");
    } catch (cause) {
      if (generationRequestRef.current === requestId) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generationRequestRef.current === requestId) {
        setGenerating(false);
        setGenerationStartedAt(null);
      }
    }
  };

  const chooseUpload = async (file: File | null) => {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const normalized = await normalizeImage(file);
      setUploadedSrc(normalized);
      setUploadedName(file.name);
      setAvatarMode("upload");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  const resetAfterCreation = () => {
    generationRequestRef.current += 1;
    skipNextDraftWriteRef.current = true;
    setAvatarMode(EMPTY_DRAFT.mode);
    setCharacterId(EMPTY_DRAFT.characterId);
    setName(EMPTY_DRAFT.name);
    setTitle(EMPTY_DRAFT.title);
    setDescription(EMPTY_DRAFT.description);
    setGeneratePrompt(EMPTY_DRAFT.generatePrompt);
    setGeneratedSrc(EMPTY_DRAFT.generatedSrc);
    setUploadedSrc(EMPTY_DRAFT.uploadedSrc);
    setUploadedName(EMPTY_DRAFT.uploadedName);
    setRuntimeSelection(EMPTY_DRAFT.runtimeSelection);
    setGenerating(false);
    setGenerationStartedAt(null);
    setDraftStatus("idle");
    try { window.localStorage.removeItem(DRAFT_KEY); } catch { /* in-memory reset still succeeds */ }
  };

  const createAgent = async () => {
    const cleanName = name.replace(/\s+/g, " ").trim();
    if (!cleanName || !avatarReady || creating) return;
    const api = ipc();
    if (!api?.oneOrg?.createAgent) {
      setError(ko ? "One Team 저장 기능을 불러오지 못했습니다. 앱을 다시 열어 주세요." : "One Team storage is unavailable. Reopen the app and try again.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const result = await api.oneOrg.createAgent({
        name: cleanName,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        avatar: selectedStyle
          ? { kind: "preset", characterId: selectedCharacter.id }
          : { kind: "image", dataUrl: previewSrc! },
        ...(runtimeSelection ? { runtimeSelection } : {}),
      });
      resetAfterCreation();
      await onCreated(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const addExisting = () => {
    persistDraftNow();
    onAddExisting();
  };

  const tabs: Array<{ id: AvatarMode; label: string; icon: ReactNode }> = [
    { id: "original", label: "Original", icon: <IconImage size={14} /> },
    { id: "sketch", label: "2D Sketch", icon: <IconSparkles size={14} /> },
    { id: "generated", label: "Generated", icon: <IconWand size={14} /> },
    { id: "upload", label: "Upload", icon: <IconFileUp size={14} /> },
  ];

  return <OneBottomSheet
    open={open}
    onClose={() => {
      if (creating) return;
      persistDraftNow();
      onClose();
    }}
    closeLabel={ko ? "새 에이전트 닫기" : "Close new agent"}
    closeDisabled={creating}
    closeOnBackdrop={!creating}
    closeOnEscape={!creating}
    size="wide"
    panelClassName={styles.dialog}
    bodyClassName={styles.body}
    eyebrow="One Team"
    title={"New Agent"}
    titleId="one-create-agent-title"
    ariaLabelledBy="one-create-agent-title"
    description={ko
      ? "독립 채팅과 기억을 가진 팀원을 One Team 안에서 바로 만듭니다. 창을 닫아도 작성 내용과 생성된 캐릭터는 임시저장됩니다."
      : "Create a teammate with its own chat and memory directly inside One Team. Your form and generated character stay saved if you close this window."}
  >
    <div className={styles.layout}>
      <section className={styles.avatarPanel}>
        <div className={styles.heroPreview} data-empty={!previewSrc && !generating ? "true" : "false"} aria-busy={generating || uploading ? "true" : "false"}>
          {generating
            ? <div className={styles.generationState} role="status" aria-live="polite"><span className={styles.spinner} aria-hidden="true" /><strong>{ko ? "캐릭터를 그리고 있어요" : "Drawing your character"}</strong><small>{ko ? "닫아도 생성은 계속되고, 완성된 그림은 임시저장됩니다." : "You can close this window. Generation continues and the result is saved."}</small><LoadingEstimate locale={locale} operationKey="one-character-generation" startedAt={generationStartedAt} expectedSeconds={[60, 300]} /></div>
            : uploading
              ? <div className={styles.generationState} role="status" aria-live="polite"><span className={styles.spinner} aria-hidden="true" /><strong>{ko ? "이미지를 준비하고 있어요" : "Preparing your image"}</strong><LoadingEstimate locale={locale} operationKey="one-character-upload" expectedSeconds={[1, 8]} /></div>
              : previewSrc
                ? <img src={previewSrc} alt={ko ? "선택한 에이전트 캐릭터" : "Selected agent character"} />
                : <IconImage size={28} />}
        </div>

        <div className={styles.tabs} role="tablist" aria-label={ko ? "캐릭터 방식" : "Character method"}>
          {tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={mode === tab.id} data-active={mode === tab.id ? "true" : "false"} onClick={() => chooseMode(tab.id)}>{tab.icon}{tab.label}</button>)}
        </div>

        {selectedStyle && <div className={styles.characterLibrary} aria-label={selectedStyle === "original" ? "Original characters" : "2D Sketch characters"}>
          <div className={styles.characterGrid} role="list">
            {visibleCharacters.map((character) => <button key={character.id} type="button" role="listitem" data-active={selectedCharacter.id === character.id ? "true" : "false"} onClick={() => setCharacterId(character.id)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={character.src} alt={character.label} />
              <span>{character.label}</span>
              {selectedCharacter.id === character.id && <i aria-hidden="true"><IconCheck size={11} /></i>}
            </button>)}
          </div>
        </div>}

        {mode === "generated" && <div className={styles.generator}>
          <label>{ko ? "캐릭터 묘사" : "Describe the character"}<textarea value={generatePrompt} onChange={(event) => setGeneratePrompt(event.target.value)} maxLength={600} placeholder={ko ? "예: 차분하지만 단호한 리서치 리드, 짙은 청록색" : "e.g. A calm but decisive research lead in deep teal"} /></label>
          <button type="button" className={styles.secondaryButton} disabled={!generatePrompt.trim() || generating} onClick={() => void generateCharacter()}><IconWand size={14} />{generating ? (ko ? "생성 중…" : "Generating…") : generatedSrc ? (ko ? "다시 생성" : "Generate again") : (ko ? "캐릭터 생성" : "Generate character")}</button>
        </div>}

        {mode === "upload" && <div className={styles.uploader}>
          <input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void chooseUpload(event.target.files?.[0] ?? null)} />
          <button type="button" className={styles.secondaryButton} disabled={uploading} onClick={() => uploadRef.current?.click()}><IconFileUp size={14} />{uploadedSrc ? (ko ? "다른 이미지 선택" : "Choose another image") : (ko ? "이미지 선택" : "Choose image")}</button>
          <small>{uploadedName || (ko ? "PNG, JPG 또는 WebP · 자동 크기 조정" : "PNG, JPG, or WebP · resized automatically")}</small>
        </div>}
      </section>

      <section className={styles.fields}>
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="inbox-triage" autoFocus /></label>
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} placeholder="e.g. Inbox Triage" /></label>
        <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1_200} placeholder={ko ? "이 에이전트에게 말투와 성격, 영혼을 부여하세요." : "Give this agent a voice, personality, and soul."} /></label>

        <label className={styles.modelPicker}>
          <span>{ko ? "LLM 모델" : "LLM model"}</span>
          <select
            value={runtimeSelection ? runtimeSelectionKey(runtimeSelection) : ""}
            disabled={modelsLoading}
            onChange={(event) => {
              const option = modelOptions.find((item) => item.key === event.target.value);
              setRuntimeSelection(option?.selection ?? null);
            }}
          >
            <option value="">{modelsLoading
              ? (ko ? "연결된 모델을 불러오는 중…" : "Loading connected models…")
              : (ko ? "자동 · Worker 런타임 우선" : "Automatic · worker runtime first")}</option>
            {modelOptions.map((option) => <option key={option.key} value={option.key}>{option.label}{option.detail ? ` · ${option.detail}` : ""}</option>)}
          </select>
          <small>{ko
            ? "선택한 모델이 안 되면 Worker 런타임, 그다음 연결된 정상 런타임을 사용합니다."
            : "If this model is unavailable, One uses the worker runtime, then another connected working runtime."}</small>
        </label>

        <div className={styles.existingPicker}>
          <button type="button" className={styles.existingTrigger} onClick={addExisting}>
            <span className={styles.existingIcon} aria-hidden="true"><IconPlus size={15} /></span>
            <span><strong>{ko ? "기존 에이전트 추가" : "Add an existing agent"}</strong><small>{ko ? "에이전트 선택 창 열기" : "Open the agent picker"}</small></span>
          </button>
        </div>

        {draftStatus !== "idle" && <p className={draftStatus === "error" ? styles.draftError : styles.draftStatus} role="status">
          {draftStatus === "saving"
            ? (ko ? "임시저장 중…" : "Saving draft…")
            : draftStatus === "error"
              ? (ko ? "이 기기에서 임시저장하지 못했습니다." : "This draft could not be saved on this device.")
              : (ko ? "자동 임시저장됨 · 창을 닫아도 이어집니다." : "Draft saved automatically · close and continue later.")}
        </p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {creating && <div className={styles.creatingState} role="status" aria-live="polite"><span className={styles.spinner} aria-hidden="true" /><span><strong>{ko ? "One Team에 팀원을 만들고 있어요" : "Creating your One Team teammate"}</strong><small>{ko ? "로컬 정체성, 조직도 자리, 독립 채팅을 함께 저장합니다." : "Saving its local identity, organisation seat, and independent chat."}</small><LoadingEstimate locale={locale} operationKey="one-agent-create" expectedSeconds={[1, 12]} /></span></div>}
        <div className={styles.actions}>
          <button type="button" disabled={creating} onClick={() => { persistDraftNow(); onClose(); }}>{ko ? "취소" : "Cancel"}</button>
          <button type="button" className={styles.primaryButton} disabled={!name.trim() || !avatarReady || creating} onClick={() => void createAgent()}>{creating ? (ko ? "만드는 중…" : "Creating…") : (ko ? "만들고 채팅 열기" : "Create & open chat")}</button>
        </div>
      </section>
    </div>
  </OneBottomSheet>;
}
