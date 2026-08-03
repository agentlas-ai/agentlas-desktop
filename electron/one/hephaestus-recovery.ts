import { shell } from "electron";
import type {
  HephaestusCommandResult,
  HephaestusRecoveryResult,
  HephaestusStatus,
  HephaestusUpdateResult,
} from "../../shared/types";
import { hephaestusAvailable, hephaestusDoctor, runHephaestusRuntimeUpdate } from "../hephaestus/engine";
import { judgeRequiredAction, secretValueFloor, type RequiredActionOption } from "../system-agents/judgment";
import type { RuntimeLocale } from "../runtime/status-i18n";

const OFFICIAL_DESKTOP_INSTALL_URL = "https://agentlas.cloud/desktop";

type RecoveryActionId = "repair_runtime" | "retry_probe" | "open_official_installer";

interface RecoveryDependencies {
  inspect: (locale?: RuntimeLocale) => Promise<HephaestusStatus>;
  update: () => Promise<HephaestusUpdateResult>;
  doctor: () => Promise<HephaestusCommandResult>;
  judge: typeof judgeRequiredAction;
  openInstaller: () => Promise<void>;
}

const defaults: RecoveryDependencies = {
  inspect: (locale) => hephaestusAvailable(locale),
  update: () => runHephaestusRuntimeUpdate(),
  doctor: () => hephaestusDoctor(),
  judge: judgeRequiredAction,
  openInstaller: async () => { await shell.openExternal(OFFICIAL_DESKTOP_INSTALL_URL); },
};

function privateObservation(input: {
  status: HephaestusStatus;
  update: HephaestusUpdateResult | null;
  doctor: HephaestusCommandResult | null;
  attempt: number;
}): string {
  return secretValueFloor(JSON.stringify({
    surface: "agentlas-os-readiness",
    attempt: input.attempt,
    status: {
      available: input.status.available,
      source: input.status.source,
      version: input.status.version,
      pythonVersion: input.status.pythonVersion,
      observedFailure: input.status.reason ?? null,
    },
    update: input.update && {
      ok: input.update.ok,
      outcome: input.update.outcome,
      error: input.update.error ?? null,
      journalStatus: input.update.journal?.status ?? null,
    },
    doctor: input.doctor && {
      ok: input.doctor.ok,
      exitCode: input.doctor.exitCode,
      error: input.doctor.error ?? null,
    },
  })).redacted.slice(0, 8_000);
}

function capabilities(status: HephaestusStatus): RequiredActionOption[] {
  return [
    ...(status.root
      ? [{
          id: "repair_runtime",
          evidence: "Run the existing digest-verified Agentlas OS updater, then probe the exact runtime and self-check it again.",
          authority: "local-reversible" as const,
        }]
      : []),
    {
      id: "retry_probe",
      evidence: "Probe the exact installed Agentlas OS runtime again without changing user data.",
      authority: "observe" as const,
    },
    {
      id: "open_official_installer",
      evidence: "Open the official Agentlas Desktop installer page. The person remains in control of downloading and replacing app files; opening the page does not modify local user data.",
      authority: "external-or-destructive" as const,
    },
  ];
}

async function verifiedStatus(
  locale: RuntimeLocale,
  dependencies: RecoveryDependencies,
): Promise<{ status: HephaestusStatus; doctor: HephaestusCommandResult | null; verified: boolean }> {
  const status = await dependencies.inspect(locale);
  if (!status.available) return { status, doctor: null, verified: false };
  const doctor = await dependencies.doctor().catch(() => null);
  return { status, doctor, verified: doctor?.ok === true };
}

/**
 * One owns the meaning and customer copy. This service supplies only private
 * observations plus exact executable capabilities, then verifies the same OS.
 */
export async function recoverHephaestusRuntime(
  input: { locale?: RuntimeLocale; actionId?: string } = {},
  injected: Partial<RecoveryDependencies> = {},
): Promise<HephaestusRecoveryResult> {
  const locale = input.locale ?? "en";
  const dependencies = { ...defaults, ...injected };
  let checked = await verifiedStatus(locale, dependencies);
  if (checked.verified) {
    return { status: checked.status, verified: true, attempted: false, presentation: null };
  }

  let update: HephaestusUpdateResult | null = null;
  let selectedAction = input.actionId as RecoveryActionId | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const actions = capabilities(checked.status);
    if (selectedAction) {
      if (!actions.some((action) => action.id === selectedAction)) {
        return { status: checked.status, verified: false, attempted: false, presentation: null };
      }
    } else {
      const decision = await dependencies.judge({
        kind: "agentlas-os-runtime-recovery",
        observation: privateObservation({ status: checked.status, update, doctor: checked.doctor, attempt }),
        actions,
        locale,
      });
      if (decision.source !== "llm") {
        return { status: checked.status, verified: false, attempted: attempt > 1, presentation: null };
      }
      if (!decision.actionId) {
        return {
          status: checked.status,
          verified: false,
          attempted: attempt > 1,
          presentation: { summary: decision.summary, question: decision.question, options: decision.options },
        };
      }
      selectedAction = decision.actionId as RecoveryActionId;
    }

    if (selectedAction === "open_official_installer") {
      await dependencies.openInstaller();
      checked = await verifiedStatus(locale, dependencies);
      return { status: checked.status, verified: checked.verified, attempted: true, presentation: null };
    }
    if (selectedAction === "repair_runtime") update = await dependencies.update();
    checked = await verifiedStatus(locale, dependencies);
    if (checked.verified) {
      return { status: checked.status, verified: true, attempted: true, presentation: null };
    }
    selectedAction = undefined;
  }

  const finalDecision = await dependencies.judge({
    kind: "agentlas-os-runtime-recovery-decision",
    observation: privateObservation({ status: checked.status, update, doctor: checked.doctor, attempt: 3 }),
    actions: capabilities(checked.status),
    locale,
  });
  return {
    status: checked.status,
    verified: false,
    attempted: true,
    presentation: finalDecision.source === "llm"
      ? { summary: finalDecision.summary, question: finalDecision.question, options: finalDecision.options }
      : null,
  };
}
