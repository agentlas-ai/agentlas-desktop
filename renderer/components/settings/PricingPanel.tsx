"use client";

// Settings -> model price table (owner-entered; the built-in table is empty and nothing here is prefilled).
// Reads harness pricing.list and writes pricing.set (owner UI only). Labels only, no explanatory copy.
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { IconCircleDollar, IconClose, IconPlus } from "@/components/Icon";

interface PriceRow {
  provider: string; model: string; prefix?: boolean; currency: string; effectiveFrom: string; source: string;
  inputPerM: number; cachedReadPerM?: number; cacheWritePerM?: number; outputPerM: number;
}

const EMPTY = { provider: "", model: "", prefix: false, currency: "", effectiveFrom: "", source: "", inputPerM: "", cachedReadPerM: "", cacheWritePerM: "", outputPerM: "" };
type Draft = typeof EMPTY;

const box = { padding: "8px 10px", borderRadius: "var(--radius-md)", border: "1px solid var(--paper-edge)", background: "var(--paper)" } as const;
const field = { fontSize: 12, padding: "4px 6px", borderRadius: "var(--radius-sm)", border: "1px solid var(--paper-edge)", background: "var(--paper)", minWidth: 0 } as const;

export function PricingPanel({ locale }: { locale: string }) {
  const ko = locale !== "en";
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const apply = (result: { data?: unknown } | undefined) => {
    const entries = (result?.data as { entries?: PriceRow[] } | undefined)?.entries;
    if (Array.isArray(entries)) setRows(entries);
  };
  const refresh = useCallback(async () => {
    try { apply(await ipc()?.harness?.call("pricing.list", {})); } catch { /* keeps the last view */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const call = async (args: Record<string, unknown>, onDone?: () => void) => {
    setBusy(true); setRefusal(null);
    try {
      const result = await ipc()?.harness?.call("pricing.set", args) as { status?: string; reason?: string; data?: unknown } | undefined;
      if (result?.status === "ok") { apply(result); onDone?.(); } else setRefusal(result?.reason ?? "failed");
    } catch { setRefusal("failed"); } finally { setBusy(false); }
  };

  if (!ipc()?.harness || rows === null) return null;
  const num = (value: string) => (value.trim() === "" ? undefined : Number(value));
  const set = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const save = () => void call({
    provider: draft.provider.trim(), model: draft.model.trim(), prefix: draft.prefix, currency: draft.currency.trim(),
    effectiveFrom: draft.effectiveFrom.trim(), source: draft.source.trim(),
    inputPerM: num(draft.inputPerM), cachedReadPerM: num(draft.cachedReadPerM), cacheWritePerM: num(draft.cacheWritePerM), outputPerM: num(draft.outputPerM),
  }, () => { setDraft(EMPTY); setOpen(false); });

  const inputs: Array<[keyof Draft, string, string]> = [
    ["provider", ko ? "제공자" : "Provider", "text"], ["model", ko ? "모델" : "Model", "text"],
    ["currency", ko ? "통화" : "Currency", "text"], ["effectiveFrom", ko ? "적용일" : "From", "date"], ["source", ko ? "출처" : "Source", "text"],
    ["inputPerM", ko ? "입력/M" : "Input/M", "number"], ["cachedReadPerM", ko ? "캐시 읽기/M" : "Cache read/M", "number"],
    ["cacheWritePerM", ko ? "캐시 쓰기/M" : "Cache write/M", "number"], ["outputPerM", ko ? "출력/M" : "Output/M", "number"],
  ];

  return (
    <div data-pricing-panel="true" style={{ ...box, display: "grid", gap: 8, margin: "12px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <IconCircleDollar size={14} />
        <span style={{ fontSize: 12, fontWeight: 650, color: "var(--ink)", flex: 1 }}>{ko ? "가격" : "Pricing"}</span>
        <button type="button" data-pricing-add="true" aria-label={ko ? "추가" : "Add"} title={ko ? "추가" : "Add"} onClick={() => setOpen((v) => !v)}
          style={{ ...box, display: "inline-flex", cursor: "pointer" }}>{open ? <IconClose size={14} /> : <IconPlus size={14} />}</button>
      </div>
      {rows.map((row) => (
        <div key={`${row.provider}|${row.model}|${row.prefix ? 1 : 0}|${row.effectiveFrom}`} data-pricing-row="true"
          style={{ ...box, display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.provider} / {row.model}{row.prefix ? "*" : ""} · {row.currency} {row.inputPerM}/{row.outputPerM} · {row.effectiveFrom.slice(0, 10)}
          </span>
          <button type="button" data-pricing-remove="true" aria-label={ko ? "삭제" : "Remove"} title={ko ? "삭제" : "Remove"} disabled={busy}
            onClick={() => void call({ remove: true, provider: row.provider, model: row.model, prefix: row.prefix === true, effectiveFrom: row.effectiveFrom })}
            style={{ ...box, display: "inline-flex", cursor: busy ? "default" : "pointer" }}><IconClose size={12} /></button>
        </div>
      ))}
      {open && (
        <div data-pricing-form="true" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6 }}>
          {inputs.map(([key, label, type]) => (
            <input key={key} type={type} step={type === "number" ? "any" : undefined} min={type === "number" ? 0 : undefined} placeholder={label} aria-label={label}
              value={draft[key] as string} onChange={(event) => set({ [key]: event.target.value } as Partial<Draft>)} style={field} />
          ))}
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={draft.prefix} onChange={(event) => set({ prefix: event.target.checked })} />
            {ko ? "접두" : "Prefix"}
          </label>
          <button type="button" data-pricing-save="true" aria-label={ko ? "저장" : "Save"} title={ko ? "저장" : "Save"} disabled={busy} onClick={save}
            style={{ ...box, display: "inline-flex", justifyContent: "center", cursor: busy ? "default" : "pointer" }}><IconPlus size={14} /></button>
        </div>
      )}
      {refusal && <span data-pricing-refusal="true" style={{ fontSize: 11, color: "var(--ink-soft)" }}>{refusal}</span>}
    </div>
  );
}
