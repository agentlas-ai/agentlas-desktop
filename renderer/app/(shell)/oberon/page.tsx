// Oberon — AI Film Operating System. 상단 게이트 스테퍼 기반 감독실(v2).
//
// 흐름(단계마다 승인해야 다음 잠금 해제):
//   00 소스·모델 → 01 기획안(BYOK CLI) → 02 스토리보드 → 03 고정 에셋(카테고리)
//   → 04 컷 이미지(병렬·머니게이트) → 05 영상(병렬) → 06 편집·납품
"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import {
  OBERON_STEPS,
  INITIAL_STEP_STATE,
  buildEdl,
  buildTitleSpec,
  defaultModelSettings,
  loadProduction,
  planProduction,
  recomputeCost,
  saveProduction,
  scoreTake,
  stepIndex,
  stepById,
  OBERON_STUDIOS,
  type OberonStepDef,
  type FilmBrief,
  type FilmProduction,
  type ModelSettings,
  type OberonStepId,
  type StepState,
  type Take,
  type OberonStudio,
} from "@/lib/oberon";
import {
  clearOberonBackgroundJobsForProduction,
  failOberonBackgroundJob,
  finishOberonPlanJob,
  isOberonBackgroundJobActive,
  listOberonBackgroundJobs,
  removeOberonBackgroundJob,
  startOberonPlanJob,
  subscribeOberonBackgroundJobs,
  trackOberonLiveJob,
  type OberonBackgroundJob,
} from "@/lib/oberon/jobs";
import { ipc } from "@/lib/ipc";
import { BriefWizard } from "@/components/oberon/BriefWizard";
import { StudioLanding } from "@/components/oberon/StudioLanding";
import { ModelSettingsPanel } from "@/components/oberon/ModelSettingsPanel";
import { PlanStep } from "@/components/oberon/PlanStep";
import { ShotBoard } from "@/components/oberon/ShotBoard";
import { AssetBible } from "@/components/oberon/AssetBible";
import { KeyframeStep } from "@/components/oberon/KeyframeStep";
import { MotionGraphicsPanel } from "@/components/oberon/MotionGraphicsPanel";
import { AnimatePanel } from "@/components/oberon/AnimatePanel";
import { TimelineEditor, DeliveryPanel } from "@/components/oberon/panels";
import { Stepper } from "@/components/oberon/Stepper";
import { Glyph, OberonBadge } from "@/components/oberon/icons";
import { OB_GRID, OB_VARS, StatChip, formatCost, formatDuration } from "@/components/oberon/ui";
import type {
  JsonObject,
  OberonKeyframeJob,
  OberonKeyframeRequest,
  OberonAnimateJob,
  OberonAnimateKeyStatus,
  OberonAnimateRequest,
  OberonMotionAdJob,
  OberonMotionAdRequest,
  OberonPlanResult,
  OberonRenderJob,
  OberonRenderRequest,
} from "@/lib/types";

export default function OberonPage() {
  const [production, setProduction] = useState<FilmProduction | null>(null);
  const [model, setModel] = useState<ModelSettings>(defaultModelSettings());
  const [stepState, setStepState] = useState<Record<OberonStepId, StepState>>({ ...INITIAL_STEP_STATE });
  const [active, setActive] = useState<OberonStepId>("setup");
  const [planning, setPlanning] = useState(false);
  // 진입 랜딩에서 고른 스튜디오. null이면 랜딩(스튜디오 선택)을 먼저 보여준다.
  const [studio, setStudio] = useState<OberonStudio | null>(null);
  // 스튜디오별 노출 단계(검토 게이트는 건너뜀). 미선택/불러오기 시 전체 7단계로 폴백.
  const studioStepDefs = useMemo<OberonStepDef[]>(() => {
    const ids = (studio && OBERON_STUDIOS.find((s) => s.id === studio)?.steps) || OBERON_STEPS.map((s) => s.id);
    return ids.map((id) => stepById(id));
  }, [studio]);

  // 실제 키프레임 이미지 생성
  const [kfProgress, setKfProgress] = useState(0);
  const [kfGenerating, setKfGenerating] = useState(false);
  const [kfDone, setKfDone] = useState(false);
  const [keyframeJob, setKeyframeJob] = useState<OberonKeyframeJob | null>(null);
  const keyframePoll = useRef<ReturnType<typeof setInterval> | null>(null);

  // 실제 영상 렌더
  const [videoMode, setVideoMode] = useState<"veo" | "motion_ad">("veo");
  const [videoGenerating, setVideoGenerating] = useState(false);
  const [renderJob, setRenderJob] = useState<OberonRenderJob | null>(null);
  const renderPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const [motionGenerating, setMotionGenerating] = useState(false);
  const [motionJob, setMotionJob] = useState<OberonMotionAdJob | null>(null);
  const motionPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  // 애니메이션 스튜디오 i2v
  const [animateGenerating, setAnimateGenerating] = useState(false);
  const [animateJob, setAnimateJob] = useState<OberonAnimateJob | null>(null);
  const animatePoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const [animateKey, setAnimateKey] = useState<OberonAnimateKeyStatus | null>(null);
  const [backgroundJobs, setBackgroundJobs] = useState<OberonBackgroundJob[]>([]);
  const attachedBackgroundJobs = useRef({ keyframe: "", render: "", motion: "", animate: "" });

  useEffect(() => () => {
    if (keyframePoll.current) clearInterval(keyframePoll.current);
    if (renderPoll.current) clearInterval(renderPoll.current);
    if (motionPoll.current) clearInterval(motionPoll.current);
    if (animatePoll.current) clearInterval(animatePoll.current);
  }, []);

  // 애니메이션 스튜디오 진입 시 i2v BYOK 키 상태 조회.
  useEffect(() => {
    if (studio !== "animation") return;
    void ipc()?.oberon
      .animateKeyStatus()
      .then((s) => setAnimateKey(s))
      .catch(() => setAnimateKey({ runway: false, luma: false }));
  }, [studio]);

  const isDone = (id: OberonStepId) => stepState[id] === "done";

  // 단계 완료 → 다음 단계 활성화 + 이동
  const complete = useCallback((id: OberonStepId, goNext = true) => {
    const cur = studioStepDefs.findIndex((s) => s.id === id);
    const nextStep = cur >= 0 ? studioStepDefs[cur + 1] : undefined;
    setStepState((prev) => {
      const next = { ...prev, [id]: "done" as StepState };
      if (nextStep && next[nextStep.id] === "locked") next[nextStep.id] = "active";
      return next;
    });
    if (goNext && nextStep) setActive(nextStep.id);
  }, [studioStepDefs]);

  const buildProductionWithPlanner = useCallback(
    async (brief: FilmBrief, premium: boolean): Promise<FilmProduction> => {
      let planningRun: OberonPlanResult;
      const bridge = ipc();
      if (bridge?.oberon?.planWithCli) {
        try {
          planningRun = await bridge.oberon.planWithCli({
            brief: briefToJson(brief),
            runtime: model.textRuntime,
            runtimeLabel: model.textRuntimeLabel,
            premium,
          });
        } catch (error) {
          planningRun = fallbackPlanResult(model, error instanceof Error ? error.message : String(error));
        }
      } else {
        planningRun = fallbackPlanResult(model, "Electron planner bridge is unavailable. Local deterministic planner was used.");
      }
      const plannedBrief = planningRun.ok ? mergeBriefWithPlan(brief, planningRun.patch) : brief;
      const prod = planProduction(plannedBrief, { premium });
      prod.modelSettings = model;
      prod.planningRun = planningRun;
      return prod;
    },
    [model],
  );

  // 00 → CLI 기획 생성
  const handlePlan = useCallback(
    (brief: FilmBrief, premium: boolean) => {
      const planJob = startOberonPlanJob(brief.title);
      setPlanning(true);
      void buildProductionWithPlanner(brief, premium)
        .then((prod) => {
          setProduction(prod);
          complete("setup");
          saveProduction(prod);
          finishOberonPlanJob(planJob.id, prod.id, prod.brief.title);
        })
        .catch((error) => {
          failOberonBackgroundJob("plan", planJob.id, error instanceof Error ? error.message : String(error));
        })
        .finally(() => setPlanning(false));
    },
    [buildProductionWithPlanner, complete],
  );

  // 저장된 프로젝트 불러오기 — 데이터가 있는 단계까지 잠금 해제
  const loadSaved = useCallback((prod: FilmProduction) => {
    if (keyframePoll.current) clearInterval(keyframePoll.current);
    if (renderPoll.current) clearInterval(renderPoll.current);
    if (motionPoll.current) clearInterval(motionPoll.current);
    if (animatePoll.current) clearInterval(animatePoll.current);
    keyframePoll.current = null;
    renderPoll.current = null;
    motionPoll.current = null;
    animatePoll.current = null;
    setKfGenerating(false);
    setVideoGenerating(false);
    setMotionGenerating(false);
    setAnimateGenerating(false);
    setKeyframeJob(null);
    setRenderJob(null);
    setMotionJob(null);
    setAnimateJob(null);
    if (prod.modelSettings) setModel(prod.modelSettings);
    const hasShots = prod.shots.length > 0;
    const hasKeyframes = (prod.keyframeAssets?.length ?? 0) > 0;
    const hasTakes = prod.takes.length > 0;
    const hasEdl = prod.edl.length > 0;
    const hasMotionOutput = (prod.renderOutputs ?? []).some((file) => file.kind === "motion_mp4");
    const motionFormat = isMotionFormat(prod.brief.format);
    const ss: Record<OberonStepId, StepState> = { ...INITIAL_STEP_STATE, setup: "done" };
    if (hasShots) {
      ss.plan = "done";
      ss.storyboard = "done";
      ss.assets = "done";
      ss.keyframe = motionFormat || hasKeyframes || hasTakes ? "done" : "active";
      if (motionFormat || hasKeyframes || hasTakes) ss.video = hasEdl || hasMotionOutput ? "done" : "active";
      if (hasEdl || hasMotionOutput) ss.delivery = "active";
    } else {
      ss.plan = "active";
    }
    setKfProgress(hasKeyframes ? prod.keyframeAssets?.length ?? 0 : hasTakes ? prod.shots.length : 0);
    setKfDone(hasKeyframes || hasTakes);
    setVideoMode(hasMotionOutput ? "motion_ad" : "veo");
    setProduction(prod);
    setStepState(ss);
    setActive(hasEdl || hasMotionOutput ? "delivery" : motionFormat || hasKeyframes || hasTakes ? "video" : hasShots ? "keyframe" : "plan");
  }, []);

  // 01 기획 편집 영속 (로그라인/트리트먼트 등)
  const patchBrief = useCallback((patch: Partial<FilmBrief>) => {
    setProduction((p) => {
      if (!p) return p;
      const next = { ...p, brief: { ...p.brief, ...patch } };
      saveProduction(next);
      return next;
    });
  }, []);

  // 01 AI로 다시 생성 — 편집된 브리프로 재계획, 하위 단계 리셋
  const replan = useCallback(() => {
    if (!production) return;
    clearOberonBackgroundJobsForProduction(production.id);
    if (keyframePoll.current) clearInterval(keyframePoll.current);
    if (renderPoll.current) clearInterval(renderPoll.current);
    if (motionPoll.current) clearInterval(motionPoll.current);
    if (animatePoll.current) clearInterval(animatePoll.current);
    keyframePoll.current = null;
    renderPoll.current = null;
    motionPoll.current = null;
    animatePoll.current = null;
    setPlanning(true);
    void buildProductionWithPlanner(production.brief, true)
      .then((prod) => {
        setProduction(prod);
        setKfProgress(0);
        setKfGenerating(false);
        setKfDone(false);
        setKeyframeJob(null);
        setVideoGenerating(false);
        setRenderJob(null);
        setMotionGenerating(false);
        setMotionJob(null);
        setAnimateGenerating(false);
        setAnimateJob(null);
        setStepState({ ...INITIAL_STEP_STATE, setup: "done", plan: "active" });
        setActive("plan");
        saveProduction(prod);
      })
      .finally(() => setPlanning(false));
  }, [buildProductionWithPlanner, production]);

  // 02 스토리보드 샷 편집 (프로바이더 스왑·삭제) + 비용 재계산
  const updateShots = useCallback((mutate: (shots: FilmProduction["shots"]) => FilmProduction["shots"]) => {
    setProduction((p) => {
      if (!p) return p;
      const shots = mutate(p.shots);
      const cost = recomputeCost(shots, p.cost.imageCostUsd, p.cost.budgetUsd);
      const totalDur = Number(shots.reduce((a, s) => a + s.durationSec, 0).toFixed(1));
      const next: FilmProduction = {
        ...p,
        shots,
        cost,
        stats: { ...p.stats, shotCount: shots.length, totalDurationSec: totalDur, avgShotLenSec: Number((totalDur / Math.max(1, shots.length)).toFixed(1)), estTotalCostUsd: cost.totalUsd },
      };
      saveProduction(next);
      return next;
    });
  }, []);

  // 05 수동 테이크 선택 — 클릭한 테이크를 selected, EDL 갱신
  const selectTake = useCallback((shotId: string, takeId: string) => {
    setProduction((p) => {
      if (!p) return p;
      const takes = p.takes.map((t) =>
        t.shotId !== shotId
          ? t
          : { ...t, status: t.id === takeId ? ("selected" as const) : t.status === "selected" ? ("ready" as const) : t.status },
      );
      const edl = p.edl.map((e) => (e.shotId === shotId ? { ...e, takeId } : e));
      const next = { ...p, takes, edl };
      saveProduction(next);
      return next;
    });
  }, []);

  const approveAssets = useCallback(() => {
    if (!production || !isMotionFormat(production.brief.format)) {
      complete("assets");
      return;
    }
    setStepState((prev) => ({
      ...prev,
      assets: "done",
      keyframe: "done",
      video: "active",
    }));
    setVideoMode("motion_ad");
    setActive("video");
  }, [complete, production]);

  const materializeRenderJob = useCallback((job: OberonRenderJob) => {
    setProduction((p) => {
      if (!p) return p;
      const liveTakes: Take[] = job.clips
        .filter((clip) => clip.status === "ready" && clip.url)
        .map((clip) => {
          const shot = p.shots.find((s) => s.shotId === clip.shotId);
          const take: Take = {
            id: clip.takeId,
            shotId: clip.shotId,
            attempt: clip.attempt,
            status: "ready",
            providerId: "google-veo",
            providerMode: "text_to_video",
            previewUrl: clip.url,
            thumbnailGradient: "linear-gradient(160deg,#2A2824,#3A3833)",
            costUsd: shot?.estCostUsd ?? 0,
            createdAtMs: clip.createdAtMs,
          };
          if (shot) take.qa = scoreTake(take, shot);
          return take;
        });
      const edl = buildEdl(p.shots, liveTakes);
      const selected = new Set(edl.map((e) => e.takeId));
      const takes = liveTakes.map((take) =>
        selected.has(take.id) ? { ...take, status: "selected" as const } : take,
      );
      const next: FilmProduction = {
        ...p,
        takes,
        edl,
        renderJobId: job.id,
        renderOutputs: job.files,
      };
      saveProduction(next);
      return next;
    });
    setStepState((prev) => {
      const ns = { ...prev, video: "done" as StepState };
      if (ns.delivery === "locked") ns.delivery = "active";
      return ns;
    });
  }, []);

  const pollRenderJob = useCallback(
    (jobId: string) => {
      if (renderPoll.current) clearInterval(renderPoll.current);
      renderPoll.current = setInterval(() => {
        // 탭 숨김 시 이 tick만 skip(타이머·주기 유지) — 백그라운드 폴링 폭주 방지.
        if (typeof document !== "undefined" && document.hidden) return;
        void (async () => {
          const bridge = ipc();
          const job = await bridge?.oberon.getRenderJob(jobId);
          if (!job) return;
          trackOberonLiveJob("render", job);
          setRenderJob(job);
          if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
            if (renderPoll.current) clearInterval(renderPoll.current);
            renderPoll.current = null;
            setVideoGenerating(false);
            if (job.status === "succeeded") materializeRenderJob(job);
          }
        })().catch((error) => {
          if (renderPoll.current) clearInterval(renderPoll.current);
          renderPoll.current = null;
          setVideoGenerating(false);
          failOberonBackgroundJob("render", jobId, error instanceof Error ? error.message : String(error));
          setRenderJob((job) =>
            job
              ? { ...job, status: "failed", progress: { ...job.progress, phase: "failed" }, error: String(error), message: String(error) }
              : null,
          );
        });
      }, 1000);
    },
    [materializeRenderJob],
  );

  const materializeMotionJob = useCallback((job: OberonMotionAdJob) => {
    setProduction((p) => {
      if (!p) return p;
      const next: FilmProduction = {
        ...p,
        renderJobId: job.id,
        renderOutputs: job.files,
      };
      saveProduction(next);
      return next;
    });
    setStepState((prev) => {
      const ns = { ...prev, video: "done" as StepState };
      if (ns.delivery === "locked") ns.delivery = "active";
      return ns;
    });
  }, []);

  const pollMotionJob = useCallback(
    (jobId: string) => {
      if (motionPoll.current) clearInterval(motionPoll.current);
      motionPoll.current = setInterval(() => {
        // 탭 숨김 시 이 tick만 skip(타이머·주기 유지) — 백그라운드 폴링 폭주 방지.
        if (typeof document !== "undefined" && document.hidden) return;
        void (async () => {
          const bridge = ipc();
          const job = await bridge?.oberon.getMotionAdJob(jobId);
          if (!job) return;
          trackOberonLiveJob("motion", job);
          setMotionJob(job);
          if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
            if (motionPoll.current) clearInterval(motionPoll.current);
            motionPoll.current = null;
            setMotionGenerating(false);
            if (job.status === "succeeded") materializeMotionJob(job);
          }
        })().catch((error) => {
          if (motionPoll.current) clearInterval(motionPoll.current);
          motionPoll.current = null;
          setMotionGenerating(false);
          failOberonBackgroundJob("motion", jobId, error instanceof Error ? error.message : String(error));
          setMotionJob((job) =>
            job
              ? { ...job, status: "failed", progress: { ...job.progress, phase: "failed" }, error: String(error), message: String(error) }
              : null,
          );
        });
      }, 1000);
    },
    [materializeMotionJob],
  );

  const materializeKeyframeJob = useCallback((job: OberonKeyframeJob) => {
    setProduction((p) => {
      if (!p) return p;
      const byShot = new Map(job.assets.map((asset) => [asset.shotId, asset]));
      const shots = p.shots.map((shot) => {
        const asset = byShot.get(shot.shotId);
        return asset ? { ...shot, firstFrameAssetId: asset.id } : shot;
      });
      const next: FilmProduction = {
        ...p,
        shots,
        keyframeAssets: job.assets,
      };
      saveProduction(next);
      return next;
    });
    setKfProgress(job.assets.length);
    setKfDone(job.assets.length === job.progress.totalImages);
  }, []);

  const pollKeyframeJob = useCallback(
    (jobId: string) => {
      if (keyframePoll.current) clearInterval(keyframePoll.current);
      keyframePoll.current = setInterval(() => {
        // 탭 숨김 시 이 tick만 skip(타이머·주기 유지) — 백그라운드 폴링 폭주 방지.
        if (typeof document !== "undefined" && document.hidden) return;
        void (async () => {
          const bridge = ipc();
          const job = await bridge?.oberon.getKeyframeJob(jobId);
          if (!job) return;
          trackOberonLiveJob("keyframe", job);
          setKeyframeJob(job);
          setKfProgress(job.progress.completedImages);
          if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
            if (keyframePoll.current) clearInterval(keyframePoll.current);
            keyframePoll.current = null;
            setKfGenerating(false);
            if (job.assets.length > 0) materializeKeyframeJob(job);
          }
        })().catch((error) => {
          if (keyframePoll.current) clearInterval(keyframePoll.current);
          keyframePoll.current = null;
          setKfGenerating(false);
          failOberonBackgroundJob("keyframe", jobId, error instanceof Error ? error.message : String(error));
          setKeyframeJob((job) =>
            job
              ? { ...job, status: "failed", progress: { ...job.progress, phase: "failed" }, error: String(error), message: String(error) }
              : null,
          );
        });
      }, 1000);
    },
    [materializeKeyframeJob],
  );

  // 04 실제 컷 이미지 생성 — Electron main이 Google Imagen 호출과 파일 저장을 담당한다.
  const startKeyframes = useCallback(() => {
    if (!production) return;
    const bridge = ipc();
    if (!bridge?.oberon?.startKeyframes) {
      const failedJob = localKeyframeError(production, "Electron Oberon bridge is unavailable. Desktop app에서 다시 실행해야 실제 이미지 생성이 가능합니다.");
      trackOberonLiveJob("keyframe", failedJob);
      setKeyframeJob(failedJob);
      setKfGenerating(false);
      return;
    }
    const keyframeProvider = model.imageProvider === "google-image" ? "google-imagen" : "codex-imagegen-cli";
    const request: OberonKeyframeRequest = {
      productionId: production.id,
      title: production.brief.title,
      aspectRatio: production.brief.aspect,
      shots: production.shots.map((shot) => ({
        shotId: shot.shotId,
        index: shot.index,
        aspectRatio: production.brief.aspect,
        prompt: shot.generationPrompt,
        negativePrompt: shot.negativePrompt,
        cameraSize: shot.camera.size,
        continuityRefs: shot.continuityRefs,
      })),
      maxShots: production.shots.length,
      provider: keyframeProvider,
      model: keyframeProvider === "google-imagen" ? "imagen-4.0-generate-001" : "image_gen.imagegen",
      imageSize: "1K",
    };
    setKfGenerating(true);
    setKfProgress(0);
    setKfDone(false);
    setKeyframeJob(null);
    void bridge.oberon
      .startKeyframes(request)
      .then((job) => {
        trackOberonLiveJob("keyframe", job);
        setKeyframeJob(job);
        setProduction((p) => {
          if (!p) return p;
          const next = { ...p, keyframeAssets: [] };
          saveProduction(next);
          return next;
        });
        pollKeyframeJob(job.id);
      })
      .catch((error) => {
        const failedJob = localKeyframeError(production, error instanceof Error ? error.message : String(error));
        trackOberonLiveJob("keyframe", failedJob);
        setKfGenerating(false);
        setKeyframeJob(failedJob);
      });
  }, [model.imageProvider, pollKeyframeJob, production]);

  // 05 실제 영상 렌더 — Electron main이 Google Veo 호출과 파일 저장을 담당한다.
  const startVideo = useCallback(() => {
    if (!production) return;
    const bridge = ipc();
    if (!bridge?.oberon) {
      const failedJob = localRenderError(production, "Electron Oberon bridge is unavailable. Desktop app에서 다시 실행해야 실제 생성이 가능합니다.");
      trackOberonLiveJob("render", failedJob);
      setRenderJob(failedJob);
      setVideoGenerating(false);
      return;
    }
    const keyframesByShot = new Map((production.keyframeAssets ?? []).map((asset) => [asset.shotId, asset]));
    const request: OberonRenderRequest = {
      productionId: production.id,
      title: production.brief.title,
      aspectRatio: production.brief.aspect,
      shots: production.shots.map((shot) => ({
        shotId: shot.shotId,
        index: shot.index,
        durationSec: shot.durationSec,
        aspectRatio: production.brief.aspect,
        prompt: shot.generationPrompt,
        negativePrompt: shot.negativePrompt,
        providerId: shot.providerId,
        providerMode: shot.providerMode,
        firstFrame: keyframesByShot.get(shot.shotId)
          ? {
              absPath: keyframesByShot.get(shot.shotId)!.absPath,
              mimeType: keyframesByShot.get(shot.shotId)!.mime,
            }
          : undefined,
      })),
      maxShots: 3,
      takesPerShot: 1,
      provider: "google-enterprise-veo",
      model: "veo-3.1-lite-generate-001",
      resolution: "720p",
      // 타이틀/로어서드/자막 결정적 번인 — 타이포 키트가 있으면 *_titled.mp4 추가 생성
      // (master_mp4는 글자 없는 클린본으로 그대로 유지되므로 항상 additive).
      titles: buildTitleSpec(production),
    };
    setVideoGenerating(true);
    setRenderJob(null);
    void bridge.oberon
      .startRender(request)
      .then((job) => {
        trackOberonLiveJob("render", job);
        setRenderJob(job);
        setProduction((p) => {
          if (!p) return p;
          const next = { ...p, renderJobId: job.id, renderOutputs: [], takes: [], edl: [] };
          saveProduction(next);
          return next;
        });
        pollRenderJob(job.id);
      })
      .catch((error) => {
        const failedJob = localRenderError(production, error instanceof Error ? error.message : String(error));
        trackOberonLiveJob("render", failedJob);
        setVideoGenerating(false);
        setRenderJob(failedJob);
      });
  }, [pollRenderJob, production]);

  const startMotionAd = useCallback(() => {
    if (!production) return;
    const bridge = ipc();
    if (!bridge?.oberon?.startMotionAd) {
      const failedJob = localMotionError(production, "Electron Oberon bridge is unavailable. Desktop app에서 다시 실행해야 모션그래픽 렌더가 가능합니다.");
      trackOberonLiveJob("motion", failedJob);
      setMotionJob(failedJob);
      setMotionGenerating(false);
      return;
    }
    const duration =
      production.brief.format === "motion_graphics_60" || production.brief.format === "commercial_60"
        ? 60
        : 30;
    const request: OberonMotionAdRequest = {
      productionId: production.id,
      title: production.brief.title || "Agentlas Motion Ad",
      brand: production.brief.brandOrProduct || (production.brief.title.toLowerCase().includes("agentlas") ? "Agentlas" : production.brief.title),
      concept: [production.brief.logline, production.brief.synopsis].filter(Boolean).join("\n"),
      aspectRatio: production.brief.aspect === "9:16" ? "9:16" : "16:9",
      logoSource: production.brief.logoSource,
      accentColor: production.brief.accentColor,
      durationSec: duration,
      fps: 24,
    };
    setMotionGenerating(true);
    setMotionJob(null);
    setVideoMode("motion_ad");
    void bridge.oberon
      .startMotionAd(request)
      .then((job) => {
        trackOberonLiveJob("motion", job);
        setMotionJob(job);
        setProduction((p) => {
          if (!p) return p;
          const next = { ...p, renderJobId: job.id, renderOutputs: [] };
          saveProduction(next);
          return next;
        });
        pollMotionJob(job.id);
      })
      .catch((error) => {
        const failedJob = localMotionError(production, error instanceof Error ? error.message : String(error));
        trackOberonLiveJob("motion", failedJob);
        setMotionGenerating(false);
        setMotionJob(failedJob);
      });
  }, [pollMotionJob, production]);

  const resetVideo = useCallback(() => {
    if (renderPoll.current) clearInterval(renderPoll.current);
    renderPoll.current = null;
    if (renderJob && videoGenerating) void ipc()?.oberon.cancelRender(renderJob.id);
    if (renderJob) removeOberonBackgroundJob("render", renderJob.id);
    setVideoGenerating(false);
    setRenderJob(null);
    setProduction((p) => {
      if (!p) return p;
      const next: FilmProduction = { ...p, takes: [], edl: [], renderJobId: undefined, renderOutputs: [] };
      saveProduction(next);
      return next;
    });
    setStepState((prev) => ({ ...prev, video: "active", delivery: "locked" }));
  }, [renderJob, videoGenerating]);

  const resetMotionAd = useCallback(() => {
    if (motionPoll.current) clearInterval(motionPoll.current);
    motionPoll.current = null;
    if (motionJob && motionGenerating) void ipc()?.oberon.cancelMotionAd(motionJob.id);
    if (motionJob) removeOberonBackgroundJob("motion", motionJob.id);
    setMotionGenerating(false);
    setMotionJob(null);
    setProduction((p) => {
      if (!p) return p;
      const next: FilmProduction = { ...p, renderJobId: undefined, renderOutputs: [] };
      saveProduction(next);
      return next;
    });
    setStepState((prev) => ({ ...prev, video: "active", delivery: "locked" }));
  }, [motionGenerating, motionJob]);

  const materializeAnimateJob = useCallback(() => {
    setStepState((prev) => {
      const ns = { ...prev, video: "done" as StepState };
      if (ns.delivery === "locked") ns.delivery = "active";
      return ns;
    });
  }, []);

  const pollAnimateJob = useCallback(
    (jobId: string) => {
      if (animatePoll.current) clearInterval(animatePoll.current);
      animatePoll.current = setInterval(() => {
        // 탭 숨김 시 이 tick만 skip(타이머·주기 유지) — 백그라운드 폴링 폭주 방지.
        if (typeof document !== "undefined" && document.hidden) return;
        void (async () => {
          const bridge = ipc();
          const job = await bridge?.oberon.getAnimateJob(jobId);
          if (!job) return;
          trackOberonLiveJob("animate", job);
          setAnimateJob(job);
          if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
            if (animatePoll.current) clearInterval(animatePoll.current);
            animatePoll.current = null;
            setAnimateGenerating(false);
            if (job.status === "succeeded") materializeAnimateJob();
          }
        })().catch((error) => {
          if (animatePoll.current) clearInterval(animatePoll.current);
          animatePoll.current = null;
          setAnimateGenerating(false);
          failOberonBackgroundJob("animate", jobId, error instanceof Error ? error.message : String(error));
        });
      }, 2000);
    },
    [materializeAnimateJob],
  );

  const attachBackgroundJob = useCallback(
    (snapshot: OberonBackgroundJob) => {
      if (snapshot.kind === "plan" || !snapshot.job) return;
      const running = isOberonBackgroundJobActive(snapshot);
      if (snapshot.kind === "keyframe") {
        const job = snapshot.job as OberonKeyframeJob;
        setKeyframeJob(job);
        setKfProgress(job.progress.completedImages);
        setKfGenerating(running);
        if (running) {
          if (attachedBackgroundJobs.current.keyframe !== job.id) {
            attachedBackgroundJobs.current.keyframe = job.id;
            pollKeyframeJob(job.id);
          }
        } else {
          attachedBackgroundJobs.current.keyframe = "";
          if (job.assets.length > 0) materializeKeyframeJob(job);
        }
        return;
      }
      if (snapshot.kind === "render") {
        const job = snapshot.job as OberonRenderJob;
        setRenderJob(job);
        setVideoGenerating(running);
        if (running) {
          if (attachedBackgroundJobs.current.render !== job.id) {
            attachedBackgroundJobs.current.render = job.id;
            pollRenderJob(job.id);
          }
        } else {
          attachedBackgroundJobs.current.render = "";
          if (job.status === "succeeded") materializeRenderJob(job);
        }
        return;
      }
      if (snapshot.kind === "motion") {
        const job = snapshot.job as OberonMotionAdJob;
        setVideoMode("motion_ad");
        setMotionJob(job);
        setMotionGenerating(running);
        if (running) {
          if (attachedBackgroundJobs.current.motion !== job.id) {
            attachedBackgroundJobs.current.motion = job.id;
            pollMotionJob(job.id);
          }
        } else {
          attachedBackgroundJobs.current.motion = "";
          if (job.status === "succeeded") materializeMotionJob(job);
        }
        return;
      }
      const job = snapshot.job as OberonAnimateJob;
      setAnimateJob(job);
      setAnimateGenerating(running);
      if (running) {
        if (attachedBackgroundJobs.current.animate !== job.id) {
          attachedBackgroundJobs.current.animate = job.id;
          pollAnimateJob(job.id);
        }
      } else {
        attachedBackgroundJobs.current.animate = "";
        if (job.status === "succeeded") materializeAnimateJob();
      }
    },
    [materializeAnimateJob, materializeKeyframeJob, materializeMotionJob, materializeRenderJob, pollAnimateJob, pollKeyframeJob, pollMotionJob, pollRenderJob],
  );

  useEffect(() => {
    const sync = () => {
      const jobs = listOberonBackgroundJobs();
      setBackgroundJobs(jobs);
      if (!production) {
        const loadable = jobs.find((job) => job.productionId);
        if (loadable?.productionId) {
          const saved = loadProduction(loadable.productionId);
          if (saved) loadSaved(saved);
        }
        return;
      }
      for (const job of jobs.filter((item) => item.productionId === production.id)) {
        attachBackgroundJob(job);
      }
    };
    sync();
    return subscribeOberonBackgroundJobs(sync);
  }, [attachBackgroundJob, loadSaved, production]);

  const startAnimate = useCallback(() => {
    if (!production) return;
    const bridge = ipc();
    if (!bridge?.oberon?.startAnimate) {
      const now = Date.now();
      const failedJob: OberonAnimateJob = {
        id: `local-error-${now}`,
        productionId: production.id,
        title: production.brief.title,
        provider: animateKey?.runway ? "runway" : "luma",
        model: "",
        status: "failed",
        outputDir: "",
        progress: { phase: "failed", percent: 0 },
        files: [],
        message: "Electron Oberon bridge is unavailable. Desktop app에서 다시 실행해야 애니메이션 생성이 가능합니다.",
        error: "Electron Oberon bridge is unavailable.",
        warnings: [],
        createdAtMs: now,
        updatedAtMs: now,
      };
      trackOberonLiveJob("animate", failedJob);
      setAnimateJob(failedJob);
      setAnimateGenerating(false);
      return;
    }
    const firstKf = (production.keyframeAssets ?? [])[0];
    const shot = production.shots[0];
    const prompt =
      [shot?.generationPrompt, production.brief.logline, production.brief.synopsis].filter(Boolean).join(" ").slice(0, 400) ||
      production.brief.title;
    const provider = animateKey?.runway ? "runway" : "luma";
    const request: OberonAnimateRequest = {
      productionId: production.id,
      title: production.brief.title || "Oberon Animation",
      provider,
      imagePath: firstKf?.absPath,
      imageUrl: firstKf?.url && /^https:\/\//i.test(firstKf.url) ? firstKf.url : undefined,
      prompt,
      aspectRatio: production.brief.aspect === "9:16" ? "9:16" : production.brief.aspect === "1:1" ? "1:1" : "16:9",
      durationSec: 5,
    };
    setAnimateGenerating(true);
    setAnimateJob(null);
    void bridge.oberon
      .startAnimate(request)
      .then((job) => {
        trackOberonLiveJob("animate", job);
        setAnimateJob(job);
        pollAnimateJob(job.id);
      })
      .catch((error) => {
        const now = Date.now();
        const failedJob: OberonAnimateJob = {
          id: `local-error-${now}`,
          productionId: production.id,
          title: production.brief.title,
          provider,
          model: "",
          status: "failed",
          outputDir: "",
          progress: { phase: "failed", percent: 0 },
          files: [],
          message: "실패",
          error: error instanceof Error ? error.message : String(error),
          warnings: [],
          createdAtMs: now,
          updatedAtMs: now,
        };
        trackOberonLiveJob("animate", failedJob);
        setAnimateGenerating(false);
        setAnimateJob(failedJob);
      });
  }, [animateKey, pollAnimateJob, production]);

  const newProject = useCallback(() => {
    if (keyframePoll.current) clearInterval(keyframePoll.current);
    if (renderPoll.current) clearInterval(renderPoll.current);
    if (motionPoll.current) clearInterval(motionPoll.current);
    keyframePoll.current = null;
    renderPoll.current = null;
    motionPoll.current = null;
    setProduction((p) => {
      if (p) clearOberonBackgroundJobsForProduction(p.id);
      return null;
    });
    setStepState({ ...INITIAL_STEP_STATE });
    setActive("setup");
    setStudio(null);
    setVideoMode("veo");
    setKfProgress(0);
    setKfGenerating(false);
    setKfDone(false);
    setKeyframeJob(null);
    setVideoGenerating(false);
    setRenderJob(null);
    setMotionGenerating(false);
    setMotionJob(null);
    if (animatePoll.current) clearInterval(animatePoll.current);
    animatePoll.current = null;
    setAnimateGenerating(false);
    setAnimateJob(null);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, ...OB_VARS, ...OB_GRID }}>
      {/* 헤더 */}
      <header
        className="titlebar-drag"
        style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 24px", borderBottom: "1px solid var(--ob-edge)", minHeight: 58, flexShrink: 0, background: "var(--ob-paper)" }}
      >
        <Link href="/apps" className="titlebar-nodrag" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--ob-muted)", textDecoration: "none" }}>
          <Glyph name="chevron" size={12} style={{ transform: "rotate(180deg)" }} /> Apps
        </Link>
        <OberonBadge name="film" tone="accent" size={28} glyphSize={15} />
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ob-ink)", fontFamily: "var(--font-display, serif)", letterSpacing: 0, lineHeight: 1 }}>
            Oberon
            {production && <span style={{ color: "var(--ob-muted)", fontWeight: 400, fontStyle: "italic" }}> · {production.brief.title}</span>}
          </div>
          <div style={{ fontSize: 10.5, color: "var(--ob-muted)", marginTop: 2 }}>AI Film Operating System</div>
        </div>
        <div style={{ flex: 1 }} />
        {production && (
          <div className="titlebar-nodrag" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <StatChip label="샷" value={production.stats.shotCount} />
            <StatChip label="씬" value={production.stats.sceneCount} />
            <StatChip label="길이" value={formatDuration(production.stats.totalDurationSec)} />
            <StatChip label="예상" value={formatCost(production.stats.estTotalCostUsd)} />
            <button onClick={newProject} style={newBtn}>
              <Glyph name="plus" size={13} strokeWidth={2.2} /> 새 프로젝트
            </button>
          </div>
        )}
      </header>

      {!production && backgroundJobs.length > 0 ? (
        <main style={{ flex: 1, minWidth: 0, display: "flex", minHeight: 0 }}>
          <OberonBackgroundResume
            jobs={backgroundJobs}
            onOpenProduction={(productionId) => {
              const saved = loadProduction(productionId);
              if (saved) loadSaved(saved);
            }}
          />
        </main>
      ) : !studio && !production ? (
        /* 진입 랜딩 — 모션그래픽 / 애니메이션 스튜디오 선택 */
        <main style={{ flex: 1, minWidth: 0, display: "flex", minHeight: 0 }}>
          <StudioLanding onPick={setStudio} />
        </main>
      ) : (
        <>
          {/* 상단 게이트 스테퍼 — 스튜디오별 단계만 노출 */}
          <Stepper steps={studioStepDefs} state={stepState} active={active} onSelect={setActive} />

          {/* 본문 */}
          <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {renderStep()}
          </main>
        </>
      )}
    </div>
  );

  function renderStep() {
    if (active === "setup" || !production) {
      return (
        <BriefWizard
          initial={production?.brief}
          studio={studio}
          onPlan={handlePlan}
          planning={planning}
          onLoad={loadSaved}
          headerSlot={<ModelSettingsPanel value={model} onChange={setModel} />}
        />
      );
    }
    switch (active) {
      case "plan":
        return (
          <PlanStep
            production={production}
            model={model}
            approved={isDone("plan")}
            planning={planning}
            onApprove={() => complete("plan")}
            onPatchBrief={patchBrief}
            onReplan={replan}
          />
        );
      case "storyboard":
        return (
          <StepFrame>
            <ShotBoard production={production} editable={!isDone("storyboard")} onUpdateShots={updateShots} />
            <ApproveBar
              label={isDone("storyboard") ? "스토리보드 승인됨 — 에셋 단계로" : "스토리보드 승인하고 고정 에셋으로"}
              done={isDone("storyboard")}
              onApprove={() => (isDone("storyboard") ? setActive("assets") : complete("storyboard"))}
            />
          </StepFrame>
        );
      case "assets":
        return <AssetBible production={production} model={model} approved={isDone("assets")} onApprove={approveAssets} />;
      case "keyframe":
        return (
          <KeyframeStep
            production={production}
            model={model}
            progress={kfProgress}
            generating={kfGenerating}
            done={kfDone}
            approved={isDone("keyframe")}
            job={keyframeJob}
            onStart={startKeyframes}
            onApprove={() => complete("keyframe")}
            onOpenOutput={(jobId) => void ipc()?.oberon.openKeyframeOutput(jobId)}
          />
        );
      case "video":
        return (
          <StepFrame>
            {studio === "animation" ? (
              <AnimatePanel
                production={production}
                generating={animateGenerating}
                job={animateJob}
                keyStatus={animateKey}
                hasKeyframe={(production.keyframeAssets?.length ?? 0) > 0}
                onStart={startAnimate}
                onReset={() => {
                  if (animatePoll.current) clearInterval(animatePoll.current);
                  animatePoll.current = null;
                  if (animateJob) removeOberonBackgroundJob("animate", animateJob.id);
                  setAnimateJob(null);
                  setAnimateGenerating(false);
                }}
                onOpenOutput={(jobId) => void ipc()?.oberon.openAnimateOutput(jobId)}
                onSaveKey={async (provider, value) => {
                  const k = provider === "runway" ? "RUNWAYML_API_SECRET" : "LUMAAI_API_KEY";
                  await ipc()?.env.set(k, value);
                  const s = await ipc()?.oberon.animateKeyStatus();
                  if (s) setAnimateKey(s);
                }}
              />
            ) : (
              <MotionGraphicsPanel
                production={production}
                generating={motionGenerating}
                job={motionJob}
                onStart={startMotionAd}
                onReset={resetMotionAd}
                onOpenOutput={(jobId) => void ipc()?.oberon.openMotionAdOutput(jobId)}
              />
            )}
            {isDone("video") && (
              <ApproveBar label="영상 확정 — 편집·납품으로" done onApprove={() => setActive("delivery")} />
            )}
          </StepFrame>
        );
      case "delivery":
        return (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <TimelineEditor production={production} />
            <div style={{ height: 1, background: "var(--ob-edge,#ececf0)", margin: "0 28px" }} />
            <DeliveryPanel production={production} />
          </div>
        );
      default:
        return null;
    }
  }
}

function VideoModeSwitch({
  value,
  onChange,
}: {
  value: "veo" | "motion_ad";
  onChange: (value: "veo" | "motion_ad") => void;
}) {
  const items: Array<{ id: "veo" | "motion_ad"; label: string; sub: string; icon: "video" | "layers" }> = [
    { id: "veo", label: "Veo Clips", sub: "실사/시네마틱", icon: "video" },
    { id: "motion_ad", label: "Motion Ad", sub: "코드 렌더", icon: "layers" },
  ];
  return (
    <div style={{ flexShrink: 0, display: "flex", gap: 8, alignItems: "center", padding: "14px 32px 0", background: "var(--ob-bg)" }}>
      {items.map((item) => {
        const active = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              minHeight: 42,
              padding: "0 14px",
              borderRadius: 10,
              border: `1px solid ${active ? "var(--ob-accent)" : "var(--ob-edge)"}`,
              background: active ? "var(--ob-accent-soft)" : "var(--ob-paper)",
              color: active ? "var(--ob-accent-text)" : "var(--ob-ink-soft)",
              cursor: "pointer",
            }}
          >
            <Glyph name={item.icon} size={15} strokeWidth={2.1} />
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.15 }}>
              <span style={{ fontSize: 13, fontWeight: 800 }}>{item.label}</span>
              <span style={{ fontSize: 10.5, color: active ? "var(--ob-accent-text)" : "var(--ob-muted)", fontWeight: 600 }}>{item.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function StepFrame({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>{children}</div>;
}

function OberonBackgroundResume({
  jobs,
  onOpenProduction,
}: {
  jobs: OberonBackgroundJob[];
  onOpenProduction: (productionId: string) => void;
}) {
  const job = jobs.find(isOberonBackgroundJobActive) ?? jobs[0];
  if (!job) return null;
  const active = isOberonBackgroundJobActive(job);
  const failed = job.status === "failed" || job.status === "cancelled";
  const tone = failed ? "var(--red-deep)" : active ? "var(--ob-accent)" : "var(--green-deep)";
  const title = active ? "Oberon 만들기가 계속 진행 중입니다" : failed ? "Oberon 작업을 확인해야 합니다" : "Oberon 작업이 완료됐습니다";
  const canOpen = !!job.productionId && !active;

  return (
    <section
      className="titlebar-nodrag"
      style={{
        flex: 1,
        minHeight: 0,
        display: "grid",
        placeItems: "center",
        padding: 28,
        background: "var(--ob-bg)",
      }}
    >
      <div
        style={{
          width: "min(520px, 100%)",
          border: "1px solid var(--ob-edge)",
          borderRadius: 14,
          background: "var(--ob-paper)",
          boxShadow: "0 18px 46px rgba(38,35,30,0.10)",
          padding: 24,
        }}
      >
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <span
            style={{
              width: 68,
              height: 68,
              borderRadius: "50%",
              display: "inline-grid",
              placeItems: "center",
              background: `conic-gradient(${tone} ${job.percent}%, var(--ob-edge) 0)`,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: 50,
                height: 50,
                borderRadius: "50%",
                display: "inline-grid",
                placeItems: "center",
                background: "var(--ob-paper)",
                color: "var(--ob-ink)",
                fontSize: 13,
                fontWeight: 850,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {job.percent}%
            </span>
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 760, color: "var(--ob-ink)", letterSpacing: 0 }}>{title}</div>
            <div style={{ marginTop: 5, color: "var(--ob-muted)", fontSize: 13, lineHeight: 1.45 }}>
              {job.label} · {job.title}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 20, height: 8, borderRadius: 999, background: "var(--ob-edge)", overflow: "hidden" }}>
          <div
            style={{
              width: `${job.percent}%`,
              height: "100%",
              background: tone,
              borderRadius: 999,
              transition: "width 0.3s ease",
            }}
          />
        </div>
        <div style={{ marginTop: 14, color: "var(--ob-ink-soft)", fontSize: 12.5, lineHeight: 1.5 }}>
          뒤로가기를 해도 작업은 앱 안에서 계속 이어집니다. 완료되면 이 화면이 저장된 프로젝트로 다시 연결합니다.
        </div>
        <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            disabled={!canOpen}
            onClick={() => job.productionId && onOpenProduction(job.productionId)}
            style={{
              minHeight: 38,
              padding: "0 15px",
              borderRadius: 999,
              border: `1px solid ${canOpen ? "var(--ob-ink)" : "var(--ob-edge)"}`,
              background: canOpen ? "var(--ob-ink)" : "var(--ob-surface)",
              color: canOpen ? "var(--ob-paper)" : "var(--ob-muted)",
              fontSize: 12.5,
              fontWeight: 750,
              cursor: canOpen ? "pointer" : "default",
            }}
          >
            프로젝트 열기
          </button>
        </div>
      </div>
    </section>
  );
}

function ApproveBar({ label, onApprove, done }: { label: string; onApprove: () => void; done?: boolean }) {
  return (
    <div
      style={{
        flexShrink: 0,
        borderTop: "1px solid var(--ob-edge,#ececf0)",
        background: "rgba(255,255,255,0.92)",
        backdropFilter: "blur(6px)",
        padding: "12px 28px",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <button onClick={onApprove} style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 44, padding: "0 22px", borderRadius: 999, fontSize: 14, fontWeight: 700, background: "var(--ob-accent)", color: "#fff", border: "none", cursor: "pointer" }}>
        {label} <Glyph name="chevron" size={14} strokeWidth={2.3} />
      </button>
    </div>
  );
}

function localRenderError(production: FilmProduction, message: string): OberonRenderJob {
  const now = Date.now();
  return {
    id: `local-error-${now}`,
    productionId: production.id,
    title: production.brief.title,
    provider: "google-enterprise-veo",
    model: "veo-3.1-lite-generate-001",
    status: "failed",
    outputDir: "",
    progress: {
      phase: "failed",
      totalClips: Math.min(3, production.shots.length),
      completedClips: 0,
      percent: 0,
    },
    clips: [],
    files: [],
    message,
    error: message,
    warnings: [],
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function localMotionError(production: FilmProduction, message: string): OberonMotionAdJob {
  const now = Date.now();
  const durationSec = production.brief.format === "motion_graphics_60" || production.brief.format === "commercial_60" ? 60 : 30;
  const fps = 15;
  return {
    id: `local-error-${now}`,
    productionId: production.id,
    title: production.brief.title,
    brand: production.brief.brandOrProduct || production.brief.title,
    status: "failed",
    outputDir: "",
    progress: {
      phase: "failed",
      totalFrames: durationSec * fps,
      completedFrames: 0,
      percent: 0,
    },
    files: [],
    message,
    error: message,
    warnings: [],
    durationSec,
    fps,
    width: production.brief.aspect === "9:16" ? 720 : 1280,
    height: production.brief.aspect === "9:16" ? 1280 : 720,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function localKeyframeError(production: FilmProduction, message: string): OberonKeyframeJob {
  const now = Date.now();
  return {
    id: `local-error-${now}`,
    productionId: production.id,
    title: production.brief.title,
    provider: "codex-imagegen-cli",
    model: "image_gen.imagegen",
    status: "failed",
    outputDir: "",
    progress: {
      phase: "failed",
      totalImages: production.shots.length,
      completedImages: 0,
      percent: 0,
    },
    assets: [],
    message,
    error: message,
    warnings: [],
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function briefToJson(brief: FilmBrief): JsonObject {
  return JSON.parse(JSON.stringify(brief)) as JsonObject;
}

function fallbackPlanResult(model: ModelSettings, message: string): OberonPlanResult {
  return {
    ok: false,
    runtime: model.textRuntime,
    runtimeLabel: model.textRuntimeLabel || model.textRuntime,
    error: message,
    warnings: [message],
    createdAtMs: Date.now(),
  };
}

function isMotionFormat(format: FilmBrief["format"]): boolean {
  return format === "motion_graphics_30" || format === "motion_graphics_60";
}

const FORMATS = new Set<FilmBrief["format"]>([
  "commercial_30",
  "commercial_60",
  "motion_graphics_30",
  "motion_graphics_60",
  "trailer",
  "short_drama",
  "music_video",
  "cinematic_short",
  "social_short",
]);
const GENRES = new Set<FilmBrief["genre"]>([
  "commercial",
  "drama",
  "action",
  "thriller",
  "romance",
  "scifi",
  "documentary",
  "fantasy",
  "horror",
  "comedy",
]);
const ASPECTS = new Set<FilmBrief["aspect"]>(["16:9", "9:16", "1:1", "2.39:1", "4:5"]);

function mergeBriefWithPlan(brief: FilmBrief, patch?: JsonObject): FilmBrief {
  if (!patch) return brief;
  const next: FilmBrief = {
    ...brief,
    tone: [...brief.tone],
    visualReferences: [...brief.visualReferences],
    characters: brief.characters.map((character) => ({ ...character })),
    mustInclude: [...brief.mustInclude],
    mustAvoid: [...brief.mustAvoid],
  };

  const strings: Array<keyof Pick<FilmBrief, "title" | "logline" | "synopsis" | "audience" | "setting" | "brandOrProduct">> = [
    "title",
    "logline",
    "synopsis",
    "audience",
    "setting",
    "brandOrProduct",
  ];
  for (const key of strings) {
    const value = patch[key];
    if (typeof value === "string" && value.trim()) {
      next[key] = value.trim() as never;
    }
  }

  if (typeof patch.format === "string" && FORMATS.has(patch.format as FilmBrief["format"])) {
    next.format = patch.format as FilmBrief["format"];
  }
  if (typeof patch.genre === "string" && GENRES.has(patch.genre as FilmBrief["genre"])) {
    next.genre = patch.genre as FilmBrief["genre"];
  }
  if (typeof patch.aspect === "string" && ASPECTS.has(patch.aspect as FilmBrief["aspect"])) {
    next.aspect = patch.aspect as FilmBrief["aspect"];
  }
  if (typeof patch.durationSec === "number" && Number.isFinite(patch.durationSec)) {
    next.durationSec = Math.max(5, Math.min(900, Math.round(patch.durationSec)));
  }
  if (patch.language === "ko" || patch.language === "en") next.language = patch.language;

  const tone = stringArray(patch.tone, 8);
  if (tone.length) next.tone = tone;
  const visualReferences = stringArray(patch.visualReferences, 12);
  if (visualReferences.length) next.visualReferences = visualReferences;
  const mustInclude = stringArray(patch.mustInclude, 16);
  if (mustInclude.length) next.mustInclude = mustInclude;
  const mustAvoid = stringArray(patch.mustAvoid, 16);
  if (mustAvoid.length) next.mustAvoid = mustAvoid;

  const characters = Array.isArray(patch.characters)
    ? patch.characters
        .filter((item): item is JsonObject => !!item && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({
          name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "Character",
          role: typeof item.role === "string" && item.role.trim() ? item.role.trim() : "등장인물",
          description: typeof item.description === "string" ? item.description.trim() : "",
        }))
        .filter((item) => item.name)
        .slice(0, 8)
    : [];
  if (characters.length) next.characters = characters;

  return next;
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))).slice(0, limit);
}

const newBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 13px",
  borderRadius: 10,
  fontSize: 12.5,
  fontWeight: 700,
  background: "var(--ob-paper,#fff)",
  color: "var(--ob-ink-soft,#3a3d47)",
  border: "1px solid var(--ob-edge,#e2e3e8)",
  cursor: "pointer",
};
