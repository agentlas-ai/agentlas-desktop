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
import type { CreateOneTeamAgentResult, OneOrgCollaborationStyle } from "@shared/one-org";
import type { RuntimeSelection, RuntimeStatus } from "@shared/types";
import { runtimeUsesEngineModelSetting } from "@shared/models";
import { runtimeModelFallbackLabel } from "@/components/dashboard/RuntimeModelPicker";
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

/** One 자신의 초상이 사는 주소. 창이 지금 얼굴을 보여줄 때 쓴다. */
const ONE_SELF_AVATAR_SRC = "agentlas://one-avatar/self";

const DRAFT_KEY = "agentlas.one.new-agent-draft.v2";
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MODES = new Set<AvatarMode>(["original", "sketch", "generated", "upload"]);
const CHARACTER_IDS = new Set<string>(ONE_CHARACTER_OPTIONS.map((item) => item.id));

/** 협업 말투 — 문구는 조직원 설정 창에 있던 것을 그대로 옮겼다(사람이 배운 말이 바뀌지 않게). */
const COLLABORATION_STYLE_OPTIONS: Array<{
  id: OneOrgCollaborationStyle;
  ko: string;
  koDetail: string;
  en: string;
  enDetail: string;
}> = [
  { id: "default", ko: "에이전트 기본", koDetail: "원본 역할과 말투를 그대로 사용", en: "Agent default", enDetail: "Keeps the source role and voice" },
  { id: "concise", ko: "간결하게", koDetail: "결론과 다음 행동을 먼저", en: "Concise", enDetail: "Decision and next action first" },
  { id: "warm", ko: "따뜻하게", koDetail: "협업적이되 위험은 숨기지 않음", en: "Warm", enDetail: "Collaborative, still explicit about risk" },
  { id: "direct", ko: "직설적으로", koDetail: "막힘과 선택지를 구체적으로", en: "Direct", enDetail: "Concrete about blockers and choices" },
];

const EMPTY_DRAFT: StoredDraft = {
  mode: "original",
  characterId: "orange-dino",
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
    /*
     * D-7 소급 정리 (2026-08-25): 편집/생성 초안 분리 전에 "One 편집을
     * 취소한 초안"이 새 팀원 초안 키로 누출된 기록이 남아 있을 수 있다.
     * 정확히 그 누출 시그니처(Name="One" + Title="Agentlas One" — One의
     * 고정 정체성 쌍)일 때만 이름/직함 두 칸을 비운다. 사용자가 실제로 그
     * 쌍을 새 팀원 초안으로 쓸 일은 없고(One은 이미 존재), 다른 칸(설명·
     * 캐릭터·런타임)은 보존되므로 오폭 파괴 범위가 없다.
     */
    if (parsed.name?.trim() === "One" && parsed.title?.trim() === "Agentlas One") {
      parsed.name = "";
      parsed.title = "";
      try {
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(parsed));
      } catch { /* 저장 실패 시 다음 읽기에서 다시 정리된다 */ }
    }
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

/**
 * 이미 앉아 있는 팀원을 이 창에서 그대로 편집한다. 만들 때와 고르는 방식이 달라지면
 * 사람은 두 화면을 따로 배워야 하고, 캐릭터를 바꿀 길이 사라진다(오너 지적 2026-08-23).
 */
export interface OneEditMemberTarget {
  memberId: string;
  displayName: string;
  /** 지금 아이콘 — `character:<id>` 면 그 캐릭터를 미리 선택해 준다. */
  icon: string;
  collaborationStyle: OneOrgCollaborationStyle;
  /** 지금 역할 한 줄과 성격 — 창을 열자마자 적혀 있어야 "수정"이 된다. */
  title: string;
  description: string;
  /** 역할·성격까지 고칠 수 있는가(호스트 판정). 밖에서 설치한 패키지는 못 고친다. */
  identityEditable: boolean;
  /** 지금 고정된 모델. 없으면 자동 배정. */
  runtimeSelection: RuntimeSelection | null;
  revision: number;
}

/**
 * One 자신을 이 창에서 고친다.
 *
 * 팀원을 만드는 창, 팀원을 고치는 창, One 을 고치는 창이 서로 달랐다(오너 지적 2026-08-23).
 * 세 가지가 하는 일은 같다 — 이름·얼굴·역할·성격·모델을 정하는 것이다. 그래서 창도 하나다.
 *
 * One 은 설치된 에이전트가 아니라 팀원처럼 쓸 초상 폴더가 없었다. 그래서 One 전용 자리를
 * 따로 만들었다 — 같은 창인데 One 에서만 두 탭이 사라지는 것은 통일이 아니라 구멍이다.
 */
export interface OneEditSelfTarget {
  displayName: string;
  role: string;
  profileContext: string;
  /** 지금 캐릭터 — `character:<id>`. 없으면 기본 얼굴. */
  avatarIcon: string;
  expectedVersion: number;
}

export function OneCreateAgentDialog({
  open,
  locale,
  seed,
  edit,
  editOne,
  onClose,
  onCreated,
  onUpdated,
  onAddExisting,
  onOpenTools,
  onReplaceMember,
  onArchiveMember,
  onOpenPrinciples,
  onSavedOne,
}: {
  open: boolean;
  locale: "ko" | "en";
  seed?: OneCreateAgentSeed | null;
  edit?: OneEditMemberTarget | null;
  /** One 자신을 고치는 모드. `edit` 과 동시에 켜지지 않는다. */
  editOne?: OneEditSelfTarget | null;
  onClose: () => void;
  onCreated: (result: CreateOneTeamAgentResult) => void | Promise<void>;
  onUpdated?: () => void | Promise<void>;
  onAddExisting: () => void;
  /** 편집에서만 쓰는 부가 동작. 없으면 그 버튼을 그리지 않는다. */
  onOpenTools?: (memberId: string) => void;
  onReplaceMember?: (memberId: string) => void;
  onArchiveMember?: (memberId: string) => void | Promise<void>;
  /** One 모드에서만 — "One이 꼭 지킬 것" 목록 창을 연다. */
  onOpenPrinciples?: () => void;
  onSavedOne?: () => void | Promise<void>;
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
  // 협업 말투는 편집에서만 쓴다. 만들 때는 원본 역할을 그대로 쓰는 것이 기본이라 묻지 않는다.
  const [collaborationStyle, setCollaborationStyle] = useState<OneOrgCollaborationStyle>("default");
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
    /*
     * 임시저장은 **새로 만들 때만** 한다.
     *
     * 편집도 같은 칸을 쓰게 되면서, 남의 이름과 성격이 "새 에이전트 초안"으로 저장될 수
     * 있게 됐다. 그러면 다음에 새로 만들기를 열었을 때 방금 고친 팀원의 내용이 적혀 있다.
     */
    if (edit || editOne) return;
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
  }, [draft, edit, editOne]);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  /*
   * 편집을 거친 뒤 생성 모드로 다시 열리면, 화면 상태에 남은 편집 대상의
   * 이름·성격이 New Agent 폼에 그대로 프리필된다(D-7 — 취소해도 남는다).
   * 이 다이얼로그는 상시 마운트 단일 인스턴스라 언마운트 리셋이 없다.
   * 편집 모드를 한 번이라도 지났다면, 생성 모드로 열릴 때 저장된
   * "새 에이전트 초안"만 다시 읽어 편집 잔류를 끊는다.
   */
  const editVisitedRef = useRef(false);
  useEffect(() => {
    if (edit || editOne) {
      editVisitedRef.current = true;
      return;
    }
    if (!open || !editVisitedRef.current) return;
    editVisitedRef.current = false;
    skipNextDraftWriteRef.current = true;
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
    setCollaborationStyle("default");
    setDraftStatus(restored.name || restored.description || restored.generatedSrc || restored.uploadedSrc ? "saved" : "idle");
  }, [open, edit, editOne]);

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
          : runtime.model
            ? [{ model: runtime.model, label: runtime.model, tag: undefined }]
            : runtimeUsesEngineModelSetting(runtime.kind)
              ? [{ model: undefined, label: runtimeModelFallbackLabel(runtime.kind, ko ? "ko" : "en"), tag: undefined }]
              : [];
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
    if (edit || editOne) return;
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

  // 편집으로 열리면 지금 이름과 캐릭터를 그대로 채워 둔다 — 창을 열자마자 "지금 상태"가 보여야 한다.
  const editKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !edit) {
      if (!open) editKeyRef.current = null;
      return;
    }
    const key = `${edit.memberId}:${edit.revision}`;
    if (editKeyRef.current === key) return;
    editKeyRef.current = key;
    skipNextDraftWriteRef.current = true;
    setName(edit.displayName);
    // ★ 여기가 "수정"을 수정으로 만드는 자리다. 지금 값이 적혀 있지 않으면 사람은
    //   고치는 것이 아니라 처음부터 다시 쓰게 된다(오너 지적 2026-08-23).
    setTitle(edit.title);
    setDescription(edit.description);
    setRuntimeSelection(edit.runtimeSelection);
    setCollaborationStyle(edit.collaborationStyle);
    const preset = edit.icon.startsWith("character:") ? edit.icon.slice("character:".length) : null;
    if (preset && CHARACTER_IDS.has(preset)) {
      setCharacterId(preset as OneCharacterId);
      const character = ONE_CHARACTER_OPTIONS.find((option) => option.id === preset);
      setAvatarMode(character?.style === "sketch" ? "sketch" : "original");
      setUploadedSrc(null);
      setGeneratedSrc(null);
    }
  }, [open, edit]);

  // One 도 같은 방식으로 채워 둔다 — 창이 열리면 지금 One 의 모습이 이미 적혀 있다.
  const editOneKeyRef = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !editOne) {
      if (!open) editOneKeyRef.current = null;
      return;
    }
    if (editOneKeyRef.current === editOne.expectedVersion) return;
    editOneKeyRef.current = editOne.expectedVersion;
    skipNextDraftWriteRef.current = true;
    setName(editOne.displayName);
    setTitle(editOne.role);
    setDescription(editOne.profileContext);
    const preset = editOne.avatarIcon.startsWith("character:")
      ? editOne.avatarIcon.slice("character:".length)
      : "";
    if (preset && CHARACTER_IDS.has(preset)) {
      setCharacterId(preset as OneCharacterId);
      const character = ONE_CHARACTER_OPTIONS.find((option) => option.id === preset);
      setAvatarMode(character?.style === "sketch" ? "sketch" : "original");
      setUploadedSrc(null);
      setGeneratedSrc(null);
      return;
    }
    if (editOne.avatarIcon === "one-avatar:self") {
      // 이미 직접 넣은 그림이 있다. 창을 열자마자 그 그림이 보여야 "지금 상태"가 맞는다.
      setAvatarMode("upload");
      setUploadedSrc(ONE_SELF_AVATAR_SRC);
      setUploadedName("");
      setGeneratedSrc(null);
      return;
    }
    setUploadedSrc(null);
    setGeneratedSrc(null);
  }, [open, editOne]);

  const updateOne = async () => {
    if (!editOne) return;
    const cleanName = name.replace(/\s+/g, " ").trim();
    if (!cleanName || !avatarReady || creating) return;
    const api = ipc();
    if (!api?.oneProfile?.update) {
      setError(ko ? "One 프로필 저장 기능을 불러오지 못했습니다. 앱을 다시 열어 주세요." : "One profile storage is unavailable. Reopen the app and try again.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      /*
       * 새로 넣은 그림이면 먼저 그림을 저장하고, 그 결과로 올라간 판 번호로 나머지를 저장한다.
       * 순서를 뒤집으면 글은 저장됐는데 얼굴만 예전 것으로 남는다.
       */
      let version = editOne.expectedVersion;
      const newImage = !selectedStyle && previewSrc && previewSrc !== ONE_SELF_AVATAR_SRC;
      if (newImage) {
        if (!api.oneProfile.setAvatarImage) {
          setError(ko ? "이 버전에서는 One 초상 저장을 지원하지 않습니다." : "Saving a One portrait is unavailable in this version.");
          setCreating(false);
          return;
        }
        const saved = await api.oneProfile.setAvatarImage({ dataUrl: previewSrc, expectedVersion: version });
        version = saved.version;
      }
      await api.oneProfile.update({
        expectedVersion: version,
        patch: {
          displayName: cleanName,
          role: title.trim() || "Agentlas One",
          profileContext: description.trim(),
          avatarIcon: selectedStyle ? `character:${selectedCharacter.id}` : "one-avatar:self",
        },
      });
      await onSavedOne?.();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const updateMember = async () => {
    if (!edit) return;
    const cleanName = name.replace(/\s+/g, " ").trim();
    if (!cleanName || !avatarReady || creating) return;
    const api = ipc();
    if (!api?.oneOrg?.update) {
      setError(ko ? "One Team 저장 기능을 불러오지 못했습니다. 앱을 다시 열어 주세요." : "One Team storage is unavailable. Reopen the app and try again.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await api.oneOrg.update({
        id: edit.memberId,
        displayName: cleanName,
        collaborationStyle,
        avatar: selectedStyle
          ? { kind: "preset", characterId: selectedCharacter.id }
          : { kind: "image", dataUrl: previewSrc! },
        // 역할·성격은 고칠 수 있는 팀원일 때만 보낸다. 보내더라도 실제 허용 여부는
        // 호스트가 다시 판정한다 — 화면의 말을 믿고 남의 패키지를 덮어쓰면 안 된다.
        ...(edit.identityEditable ? { title: title.trim(), description: description.trim() } : {}),
        // null 은 "고정 해제". undefined 와 구분되지 않으면 창을 열었다 닫기만 해도 고정이 풀린다.
        runtimeSelection,
        expectedRevision: edit.revision,
      });
      await onUpdated?.();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
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
    closeLabel={editOne
      ? (ko ? "One 편집 닫기" : "Close edit One")
      : edit ? (ko ? "팀원 편집 닫기" : "Close edit teammate") : (ko ? "새 에이전트 닫기" : "Close new agent")}
    closeDisabled={creating}
    closeOnBackdrop={!creating}
    closeOnEscape={!creating}
    size="wide"
    panelClassName={styles.dialog}
    bodyClassName={styles.body}
    eyebrow={editOne ? "One" : "One Team"}
    title={editOne ? (ko ? "One 편집" : "Edit One") : edit ? (ko ? "팀원 편집" : "Edit Teammate") : "New Agent"}
    titleId="one-create-agent-title"
    ariaLabelledBy="one-create-agent-title"
    description={editOne
      ? (ko
        ? "팀원을 만들 때와 같은 창입니다. 여기에 적고 저장한 내용만 다음 대화에도 사용합니다."
        : "The same window you use to create a teammate. Only what you save here is used in future conversations.")
      : edit
      ? (ko
        ? "만들 때와 같은 창입니다. 지금 값이 적혀 있고, 고쳐서 저장하면 그게 수정입니다."
        : "The same window you used to create it. Everything is filled in with what it is now — change and save.")
      : (ko
        ? "독립 채팅과 기억을 가진 팀원을 One Team 안에서 바로 만듭니다. 창을 닫아도 작성 내용과 생성된 캐릭터는 임시저장됩니다."
        : "Create a teammate with its own chat and memory directly inside One Team. Your form and generated character stay saved if you close this window.")}
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
        {/* 라벨 ko 표기는 웹 New Agent 폼과 통일(D-9) — 이름/제목/설명. */}
        <label>{ko ? "이름" : "Name"}<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="inbox-triage" autoFocus /></label>
        {/* 만들 때와 고칠 때가 같은 칸을 쓴다. 편집이면 지금 값이 이미 적혀 있고, 그것이 곧 수정이다. */}
        {(!edit || edit.identityEditable) && <label>{editOne ? (ko ? "역할" : "Role") : (ko ? "제목" : "Title")}<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={editOne ? 120 : 100} placeholder={editOne ? "Agentlas One" : "e.g. Inbox Triage"} /></label>}
        {(!edit || edit.identityEditable) && <label>{editOne ? (ko ? "말투·성격과 내 선호" : "Voice, personality, and preferences") : (ko ? "설명" : "Description")}<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={editOne ? 4_000 : 1_200} placeholder={ko ? (editOne ? "예: 항상 턴 끝에 진척도를 표로 보여 주고, 내가 결정할 것이 있으면 먼저 말해 줘." : "이 에이전트에게 말투와 성격, 영혼을 부여하세요.") : (editOne ? "e.g. End every turn with a progress table and tell me what needs my decision." : "Give this agent a voice, personality, and soul.")} /></label>}
        {edit && !edit.identityEditable && <p className={styles.lockedIdentity}>
          {ko
            ? "이 팀원은 밖에서 설치한 에이전트라 역할과 성격은 원본 패키지가 정합니다. 이름·캐릭터·모델은 여기서 바꿉니다."
            : "This teammate comes from an installed package, so its role and personality stay as published. Name, character, and model are yours to change here."}
        </p>}

        {/*
          협업 말투 고르기는 뺐다(오너 지시 2026-08-24 "말투 같은거 선택 빼고").
          저장 값(collaborationStyle)은 그대로 유지해 이미 고른 사람의 설정이
          사라지지 않게 한다 — 화면에서만 사라진다.
        */}

        {/*
          One 의 모델은 대화 작성기에서 고른다(그 자리에서 바로 바꾸는 것이 One 의 방식이다).
          여기에 또 두면 두 곳이 서로 다른 값을 보여 주게 된다.
        */}
        {!editOne && <label className={styles.modelPicker}>
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
        </label>}

        <div className={styles.existingPicker}>
          {!edit && <button type="button" className={styles.existingTrigger} onClick={addExisting}>
            <span className={styles.existingIcon} aria-hidden="true"><IconPlus size={15} /></span>
            <span><strong>{ko ? "기존 에이전트 추가" : "Add an existing agent"}</strong><small>{ko ? "에이전트 선택 창 열기" : "Open the agent picker"}</small></span>
          </button>}
        </div>

        {/*
          조직원 설정 창이 따로 갖고 있던 것들이다. 창을 하나로 합치는 이상 여기 없으면
          그 기능들이 도달 불가가 된다 — 화면을 합치면서 기능을 잃는 것이 가장 나쁘다.
        */}
        {editOne && onOpenPrinciples && <div className={styles.editorExtras}>
          <button type="button" onClick={() => { onOpenPrinciples(); onClose(); }}>{ko ? "One이 꼭 지킬 것 관리" : "Manage what One must follow"}</button>
        </div>}
        {edit && (onOpenTools || onReplaceMember || onArchiveMember) && <div className={styles.editorExtras}>
          {onOpenTools && <button type="button" onClick={() => { onOpenTools(edit.memberId); onClose(); }}>{ko ? "도구 설정 열기" : "Open tool settings"}</button>}
          {onReplaceMember && <button type="button" onClick={() => { onReplaceMember(edit.memberId); onClose(); }}>{ko ? "담당 교체" : "Replace staff member"}</button>}
          {onArchiveMember && <button type="button" className={styles.archiveExtra} disabled={creating} onClick={() => { void Promise.resolve(onArchiveMember(edit.memberId)).then(() => onClose()); }}>{ko ? "보관하기" : "Archive"}</button>}
        </div>}

        {!edit && !editOne && draftStatus !== "idle" && <p className={draftStatus === "error" ? styles.draftError : styles.draftStatus} role="status">
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
          <button type="button" className={styles.primaryButton} disabled={!name.trim() || !avatarReady || creating} onClick={() => void (editOne ? updateOne() : edit ? updateMember() : createAgent())}>{creating
            ? (editOne || edit ? (ko ? "저장 중…" : "Saving…") : (ko ? "만드는 중…" : "Creating…"))
            : (editOne || edit ? (ko ? "저장" : "Save") : (ko ? "만들고 채팅 열기" : "Create & open chat"))}</button>
        </div>
      </section>
    </div>
  </OneBottomSheet>;
}
