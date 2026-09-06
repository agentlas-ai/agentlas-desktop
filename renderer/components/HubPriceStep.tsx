"use client";

// Pricing an agent that was just published to the Hub.
//
// WHY IT APPEARS AFTER THE PUBLISH AND NOT INSIDE IT
//   The listing is already live. Making the price part of the upload would mean
//   a wrong number, a network blip, or a moment's hesitation could fail a
//   publish that had already succeeded on the server — and send someone to
//   re-publish something already published.
//
//   So this is an offer, not a gate. Skipping it leaves the agent callable for
//   free, which is a state the product already handles: it is exactly where
//   every agent published before pricing existed lives.
//
// WHY THREE FIELDS
//   Rent, lease and fork bill different units. Rent is charged per work
//   order, so its ceiling is low — the same work must not cost more because it
//   was split into more pieces. The long-term lease is a day of the agent
//   (account-bound: valid in every project), worth twenty times that; its wire
//   id "INGEST" is only a legacy spelling (owner decision 2026-08-18). A
//   fork is a copy sold once, with no repeat for a ceiling to protect against.
//
// BLANK IS NOT ZERO
//   An empty field means "I do not sell this". Zero would mean "this is free",
//   and an agent that does not sell forks is not giving copies away.

import { useState } from "react";
import type { CSSProperties } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { CloudAgentPricePatch, CloudAgentPriceKind } from "@shared/types";

const KINDS: readonly CloudAgentPriceKind[] = ["RENT", "INGEST", "FORK"];

const BOUNDS: Record<CloudAgentPriceKind, { min: number; max: number | null }> = {
  RENT: { min: 1, max: 100 },
  INGEST: { min: 1, max: 2_000 },
  FORK: { min: 1, max: null },
};

// 24시간 자동 리스는 폐지됐다(오너 결정 2026-08-18) — RENT는 작업(work order) 1건당
// 과금이고, 기간형 사용은 일 단위 장기대여(계정 귀속, 와이어 id "INGEST"는 레거시
// 표기)가 담당한다.
const LABEL: Record<CloudAgentPriceKind, { ko: string; en: string; koUnit: string; enUnit: string }> = {
  RENT: { ko: "빌리기", en: "Rent", koUnit: "작업 1건당", enUnit: "per work order" },
  INGEST: { ko: "장기대여", en: "Long-term lease", koUnit: "에이전트 1일당", enUnit: "per agent · per day" },
  FORK: { ko: "포크", en: "Fork", koUnit: "사본 1개 · 1회", enUnit: "one copy · once" },
};

type Draft = Record<CloudAgentPriceKind, string>;

/** null = not sold, number = the price, undefined = unusable input. */
export function readField(kind: CloudAgentPriceKind, raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return undefined;
  const bounds = BOUNDS[kind];
  if (value < bounds.min) return undefined;
  if (bounds.max !== null && value > bounds.max) return undefined;
  return value;
}

export function HubPriceStep({ slug }: { slug: string }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [draft, setDraft] = useState<Draft>({ RENT: "", INGEST: "", FORK: "" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = Object.fromEntries(KINDS.map((k) => [k, readField(k, draft[k])])) as Record<
    CloudAgentPriceKind,
    number | null | undefined
  >;
  const anyBad = KINDS.some((k) => read[k] === undefined);
  const anySet = KINDS.some((k) => typeof read[k] === "number");

  async function save() {
    const api = ipc();
    if (!api || anyBad || !anySet || saving) return;
    setSaving(true);
    setError(null);
    try {
      const patch: CloudAgentPricePatch = {};
      for (const kind of KINDS) {
        const value = read[kind];
        // Only what was actually filled in. Sending null for the untouched
        // fields would delete prices this agent may already have.
        if (typeof value === "number") patch[kind] = value;
      }
      const result = await api.cloudAgents.setPrices({ slug, patch });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const parts = KINDS.filter((k) => typeof result.prices[k] === "number").map(
        (k) => `${ko ? LABEL[k].ko : LABEL[k].en} ${result.prices[k]}`,
      );
      // Read back what the SERVER stored, not what was typed. They can differ,
      // and the one that matters is the server's.
      setSaved(parts.join(" · "));
    } catch (err) {
      setError(err instanceof Error ? err.message : ko ? "저장하지 못했습니다." : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <div style={box}>
        <strong style={{ fontSize: 13 }}>{ko ? "값을 저장했습니다" : "Price saved"}</strong>
        <span style={{ fontSize: 12, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>{saved}</span>
        <span style={hint}>
          {ko
            ? "agentlas.cloud 수익 페이지에서 언제든 바꿀 수 있습니다."
            : "You can change it any time from the earnings page on agentlas.cloud."}
        </span>
      </div>
    );
  }

  return (
    <div style={box}>
      <div>
        <strong style={{ fontSize: 13 }}>{ko ? "값을 정하시겠어요?" : "Set a price?"}</strong>
        <span style={{ ...hint, display: "block", marginTop: 3 }}>
          {ko
            ? "비워 두면 그 항목은 팔지 않습니다. 전부 비워 두면 무료로 불립니다."
            : "Leave a field blank and you do not sell that kind. Leave them all blank and it stays free to call."}
        </span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {KINDS.map((kind) => {
          const bounds = BOUNDS[kind];
          const bad = read[kind] === undefined;
          const range = bounds.max === null ? `${bounds.min}+` : `${bounds.min}–${bounds.max.toLocaleString()}`;
          return (
            <label key={kind} style={{ display: "grid", gap: 3, minWidth: 132 }}>
              <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                {ko ? LABEL[kind].ko : LABEL[kind].en}{" "}
                <span style={{ opacity: 0.7 }}>{ko ? LABEL[kind].koUnit : LABEL[kind].enUnit}</span>
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={bounds.min}
                {...(bounds.max !== null ? { max: bounds.max } : {})}
                step={1}
                value={draft[kind]}
                placeholder={ko ? "안 팔기" : "not sold"}
                onChange={(event) => setDraft((prev) => ({ ...prev, [kind]: event.target.value }))}
                aria-invalid={bad}
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderRadius: 8,
                  border: `1px solid ${bad ? "var(--danger, var(--danger))" : "var(--line, rgba(0,0,0,.14))"}`,
                  background: "var(--surface, var(--paper))",
                  color: "inherit",
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                }}
              />
              {/* The bound is stated with the field, so "you cannot go higher"
                  arrives while it is relevant rather than after a refusal. */}
              <span style={{ fontSize: 10.5, color: bad ? "var(--danger, var(--danger))" : "var(--muted-deep)" }}>
                {bad ? (ko ? `${range} 사이` : `${range} only`) : `${range} cr`}
              </span>
            </label>
          );
        })}
      </div>

      {error && <span style={{ fontSize: 12, color: "var(--danger, var(--danger))" }}>{error}</span>}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          disabled={anyBad || !anySet || saving}
          onClick={() => void save()}
          style={{
            height: 28,
            padding: "0 14px",
            borderRadius: 8,
            border: "1px solid var(--line, rgba(0,0,0,.14))",
            background: anyBad || !anySet ? "transparent" : "var(--accent, var(--black))",
            color: anyBad || !anySet ? "var(--muted-deep)" : "var(--white)",
            fontSize: 12,
            cursor: anyBad || !anySet ? "default" : "pointer",
          }}
        >
          {saving ? (ko ? "저장 중" : "Saving") : ko ? "값 저장" : "Save price"}
        </button>
        <span style={hint}>
          {ko ? "나중에 웹에서 정해도 됩니다." : "You can also do this later on the web."}
        </span>
      </div>
    </div>
  );
}

const box: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  marginTop: 10,
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid var(--line, rgba(0,0,0,.12))",
  background: "var(--surface-2, rgba(0,0,0,.02))",
};

const hint: CSSProperties = { fontSize: 11.5, color: "var(--muted-deep)" };
