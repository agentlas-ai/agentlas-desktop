// 글로벌 환경변수 — 모든 에이전트·회사가 공유하는 외부 API 키 (Notion / Slack / GA4 등).
// 값은 macOS Keychain에만 저장, renderer는 hasValue만 받음.
// 출처(에이전트/도구)별 접고 펴는 섹션. 펴면 각 변수에 edit/delete가 바로 보인다.
// 로컬 .env 파일을 드래그&드롭하면 KEY=VALUE를 파싱해 일괄 등록한다.
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { EnvVarMeta } from "@/lib/types";
import type { CredentialRecoveryFailure, CredentialRecoveryResult } from "../../../../../shared/credential-recovery";
import { CredentialRecoveryPanel } from "@/components/CredentialRecoveryPanel";
import {
  IconCheck,
  IconChevronRight,
  IconClose,
  IconFileUp,
  IconKey,
  IconLock,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@/components/Icon";

type FilterKey = "all" | "set" | "unset";

interface Section {
  id: string;
  title: string;
  vars: EnvVarMeta[];
}

const MANUAL_ID = "__manual__";

export default function LibraryEnvPage() {
  const { t, locale } = useT();
  const [vars, setVars] = useState<EnvVarMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [recoveryRefresh, setRecoveryRefresh] = useState(0);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      setVars(await api.env.list());
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setRecoveryRefresh((value) => value + 1);
    }
  }, []);

  const recovered = useCallback(async (failure: CredentialRecoveryFailure, result: CredentialRecoveryResult) => {
    if (failure.operation === "list") {
      // Listing recovery must not silently turn into reads of all newly found keys.
      return;
    }
    if (failure.kind !== "env" || !result.env) return;
    const updated = result.env;
    setVars((current) => current.map((entry) => entry.key === updated.key
      ? { ...entry, ...updated, credentialAccess: "available" } : entry));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(key: string, value: string) {
    const api = ipc();
    if (!api || !value.trim()) return;
    setBusy(true);
    try {
      await api.env.set(key, value);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(key: string) {
    const api = ipc();
    if (!api) return;
    if (!confirm(t("env.confirm_delete", { key }))) return;
    await api.env.remove(key);
    await refresh();
  }

  // ── 출처별 섹션 빌드 ───────────────────────────────────
  const sections = useMemo<Section[]>(() => {
    const q = search.trim().toLowerCase();
    const matches = (v: EnvVarMeta) => {
      if (filter === "set" && v.hasValue !== true) return false;
      if (filter === "unset" && v.hasValue !== false) return false;
      if (!q) return true;
      return (
        v.key.toLowerCase().includes(q) ||
        v.requiredBy.some(
          (r) =>
            r.agentName.toLowerCase().includes(q) ||
            r.agentNameEn.toLowerCase().includes(q) ||
            (r.label ?? "").toLowerCase().includes(q),
        )
      );
    };
    const visible = vars.filter(matches);

    const map = new Map<string, Section>();
    for (const v of visible) {
      if (v.requiredBy.length === 0) {
        const s = map.get(MANUAL_ID) ?? { id: MANUAL_ID, title: t("env.section.manual"), vars: [] };
        s.vars.push(v);
        map.set(MANUAL_ID, s);
        continue;
      }
      for (const r of v.requiredBy) {
        const title = locale === "en" ? r.agentNameEn || r.agentName : r.agentName;
        const s = map.get(r.agentId) ?? { id: r.agentId, title, vars: [] };
        if (!s.vars.some((x) => x.key === v.key)) s.vars.push(v);
        map.set(r.agentId, s);
      }
    }
    const list = [...map.values()];
    // 에이전트/도구 섹션 먼저(이름순), manual 마지막
    list.sort((a, b) => {
      if (a.id === MANUAL_ID) return 1;
      if (b.id === MANUAL_ID) return -1;
      return a.title.localeCompare(b.title);
    });
    return list;
  }, [vars, search, filter, locale, t]);

  // ── .env 드래그&드롭 ───────────────────────────────────
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    const api = ipc();
    if (!api) return;
    setBusy(true);
    let count = 0;
    try {
      for (const f of files) {
        let text = "";
        try {
          text = await f.text();
        } catch {
          continue;
        }
        for (const [k, v] of parseDotEnv(text)) {
          await api.env.set(k, v);
          count++;
        }
      }
      await refresh();
      setImportNote(t("env.import_done", { n: count }));
      setTimeout(() => setImportNote(null), 4000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      style={{ padding: "24px 32px", maxWidth: 920, margin: "0 auto", position: "relative" }}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <h2
        style={{
          fontFamily: "var(--font-head)",
          fontSize: 18,
          margin: "0 0 4px",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <IconKey size={18} style={{ color: "var(--accent)" }} />
        {t("env.title")}
      </h2>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--muted-deep)" }}>{t("env.subtitle")}</p>

      <div
        className="glass-strong"
        data-tour-id="env.security"
        style={{
          padding: "10px 14px",
          borderRadius: "var(--radius-md)",
          fontSize: 12,
          color: "var(--ink-soft)",
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          marginBottom: 14,
        }}
      >
        <IconLock size={14} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
        <span>
          {t("env.security_note")} <span style={{ color: "var(--muted-deep)" }}>· {t("env.drop_env_hint")}</span>
        </span>
      </div>

      <CredentialRecoveryPanel locale={locale} refreshKey={recoveryRefresh} onRecovered={recovered} />
      {loadError && <p role="alert" style={{ color: "var(--red-deep)", fontSize: 12 }}>
        {locale === "ko" ? "연결 키 상태를 불러오지 못했습니다. 기존 항목은 유지했습니다." : "Connection status could not be loaded. Existing entries were kept."}
      </p>}
      <button type="button" onClick={() => void refresh()} style={{ marginBottom: 10, fontSize: 12 }}>
        {locale === "ko" ? "연결 목록 새로고침" : "Refresh connection list"}
      </button>

      {/* 툴바 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }} data-tour-id="env.toolbar">
        <div style={{ position: "relative", flex: "1 1 200px", minWidth: 160 }}>
          <IconSearch
            size={13}
            style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted-deep)" }}
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("env.search")}
            style={{
              width: "100%",
              padding: "8px 12px 8px 30px",
              border: "1px solid var(--paper-edge)",
              borderRadius: 999,
              background: "var(--paper)",
              fontSize: 12.5,
              outline: "none",
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["all", "set", "unset"] as FilterKey[]).map((f) => {
            const active = filter === f;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 11.5,
                  fontWeight: active ? 700 : 500,
                  background: active ? "var(--paper)" : "var(--paper-2)",
                  color: active ? "var(--ink)" : "var(--ink-soft)",
                  border: "1px solid var(--paper-edge)",
                  boxShadow: active ? "var(--neu-raised)" : "none",
                }}
              >
                {t(`env.filter.${f}` as "env.filter.all")}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setAdding((v) => !v)}
          style={{
            marginLeft: "auto",
            padding: "8px 14px",
            borderRadius: 999,
            background: "var(--paper)",
            color: "var(--ink)",
            fontWeight: 600,
            fontSize: 12,
            border: "1px solid var(--paper-edge)",
            boxShadow: "var(--neu-raised)",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <IconPlus size={13} />
          {t("env.add_new")}
        </button>
      </div>

      {importNote && (
        <div style={{ marginBottom: 12, fontSize: 12, color: "var(--green-deep)", fontWeight: 600 }}>{importNote}</div>
      )}

      {/* 새 변수 추가 */}
      {adding && (
        <div
          className="glass-strong"
          style={{ padding: 14, borderRadius: "var(--radius-md)", marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            placeholder={t("env.field.key.placeholder")}
            autoFocus
            style={{ ...inputStyle, flex: "1 1 200px", fontFamily: "var(--font-mono)" }}
          />
          <input
            type="password"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder={t("env.field.value.placeholder")}
            style={{ ...inputStyle, flex: "1 1 200px", fontFamily: "var(--font-mono)" }}
          />
          <button
            onClick={async () => {
              if (!newKey.trim() || !newValue.trim()) return;
              await save(newKey.trim(), newValue);
              setNewKey("");
              setNewValue("");
              setAdding(false);
            }}
            disabled={!newKey.trim() || !newValue.trim() || busy}
            style={{
              padding: "8px 16px",
              borderRadius: "var(--radius-md)",
              background: newKey.trim() && newValue.trim() ? "var(--paper)" : "var(--paper-2)",
              color: newKey.trim() && newValue.trim() ? "var(--ink)" : "var(--muted-deep)",
              fontWeight: 600,
              fontSize: 12,
              border: "1px solid var(--paper-edge)",
              boxShadow: newKey.trim() && newValue.trim() ? "var(--neu-raised)" : "none",
            }}
          >
            {t("common.save")}
          </button>
        </div>
      )}

      {/* 섹션들 */}
      {sections.length === 0 ? (
        <div
          data-tour-id="env.sections"
          style={{
            padding: 32,
            border: "1px dashed var(--paper-edge)",
            borderRadius: "var(--radius-md)",
            color: "var(--muted-deep)",
            textAlign: "center",
            fontSize: 13,
          }}
        >
          {search.trim() || filter !== "all" ? t("env.no_results") : t("env.empty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-tour-id="env.sections">
          {sections.map((s) => {
            const isCollapsed = collapsed[s.id];
            const setCount = s.vars.filter((v) => v.hasValue).length;
            return (
              <div
                key={s.id}
                style={{ border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)", overflow: "hidden" }}
              >
                <button
                  onClick={() => setCollapsed((c) => ({ ...c, [s.id]: !c[s.id] }))}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "11px 14px",
                    background: "var(--paper-2)",
                    border: "none",
                    borderBottom: isCollapsed ? "none" : "1px solid var(--paper-edge)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <IconChevronRight
                    size={13}
                    style={{ color: "var(--muted-deep)", transform: isCollapsed ? "none" : "rotate(90deg)", transition: "transform .12s" }}
                  />
                  <strong style={{ fontSize: 13, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {s.title}
                  </strong>
                  <span style={{ fontSize: 11, color: setCount === s.vars.length ? "var(--green-deep)" : "var(--muted-deep)", fontWeight: 600 }}>
                    {t("env.section_count", { set: setCount, total: s.vars.length })}
                  </span>
                </button>
                {!isCollapsed && (
                  <ul style={{ listStyle: "none", padding: 10, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                    {s.vars.map((v) => (
                      <EnvRow key={v.key} v={v} locale={locale} busy={busy} onSave={save} onRemove={remove} />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 드래그 오버레이 */}
      {dragOver && (
        <div
          style={{
            position: "absolute",
            inset: 16,
            border: "2px dashed var(--accent)",
            borderRadius: "var(--radius-lg)",
            background: "rgba(168,217,155,0.12)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 8,
            color: "var(--accent)",
            fontWeight: 700,
            pointerEvents: "none",
          }}
        >
          <IconFileUp size={26} />
          {t("env.drop_now")}
        </div>
      )}
    </section>
  );
}

/** .env 텍스트를 [key, value] 배열로 파싱. 주석/빈 줄 무시, 따옴표 제거, export 접두 제거. */
function parseDotEnv(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !val) continue;
    out.push([key, val]);
  }
  return out;
}

const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  fontSize: 12.5,
  outline: "none",
};

function EnvRow({
  v,
  locale,
  busy,
  onSave,
  onRemove,
}: {
  v: EnvVarMeta;
  locale: "ko" | "en";
  busy: boolean;
  onSave: (key: string, value: string) => void | Promise<void>;
  onRemove: (key: string) => void | Promise<void>;
}) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const firstReq = v.requiredBy[0];
  const hint = firstReq ? (locale === "en" ? firstReq.hintEn || firstReq.hint : firstReq.hint) : null;

  return (
    <li
      style={{
        background: "var(--paper-2)",
        border: "1px solid var(--paper-edge)",
        borderRadius: "var(--radius-md)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <code style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 600, color: "var(--ink)", wordBreak: "break-all", flex: 1, minWidth: 0 }}>
          {v.key}
        </code>
        {v.hasValue === null || v.credentialAccess === "unavailable" ? (
          <span role="status" style={{ fontSize: 11, color: "var(--red-deep)" }}>
            {locale === "ko" ? "접근 불가 · 위 복구 항목에서 다시 시도" : "Access unavailable · retry in the recovery list above"}
          </span>
        ) : v.hasValue ? (
          <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: "rgba(168,217,155,0.20)", color: "var(--green-deep)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
            <IconCheck size={10} /> {t("env.saved")}
          </span>
        ) : (
          <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: "var(--paper)", color: "var(--muted-deep)", fontWeight: 600, flexShrink: 0 }}>
            {t("env.not_set")}
          </span>
        )}
        {/* edit / delete — 섹션을 펴면 바로 보임 */}
        <button
          onClick={() => setEditing((e) => !e)}
          style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--paper-edge)", background: "var(--paper)", flexShrink: 0 }}
        >
          {v.hasValue ? t("common.edit") : t("common.save")}
        </button>
        {v.hasValue && (
          <button
            onClick={() => void onRemove(v.key)}
            aria-label={t("common.delete")}
            title={t("common.delete")}
            style={{ color: "var(--red-deep)", background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: 999, padding: "4px 8px", flexShrink: 0 }}
          >
            <IconTrash size={13} />
          </button>
        )}
      </div>
      {v.hasValue && v.preview && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted-deep)" }}>
          <span style={{ flexShrink: 0 }}>{t("env.preview_label")}</span>
          <code
            title={t("env.preview_label")}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              color: "var(--ink-soft)",
              background: "var(--paper)",
              border: "1px solid var(--paper-edge)",
              borderRadius: 6,
              padding: "1px 7px",
              letterSpacing: 0.5,
              wordBreak: "break-all",
            }}
          >
            {v.preview}
          </code>
        </div>
      )}
      {hint && <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>{hint}</div>}
      {editing && (
        <InlineSet
          placeholder={t("env.field.value.placeholder")}
          busy={busy}
          onSave={async (val) => {
            await onSave(v.key, val);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  );
}

function InlineSet({
  placeholder,
  busy,
  onSave,
  onCancel,
}: {
  placeholder: string;
  busy: boolean;
  onSave: (value: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState("");
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
      <input
        type="password"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-mono)" }}
      />
      <button
        onClick={async () => {
          if (!draft.trim()) return;
          await onSave(draft);
          setDraft("");
        }}
        disabled={!draft.trim() || busy}
        style={{
          padding: "6px 14px",
          borderRadius: "var(--radius-md)",
          background: draft.trim() ? "var(--paper)" : "var(--paper-2)",
          color: draft.trim() ? "var(--ink)" : "var(--muted-deep)",
          fontWeight: 600,
          fontSize: 11.5,
          border: "1px solid var(--paper-edge)",
          boxShadow: draft.trim() ? "var(--neu-raised)" : "none",
        }}
      >
        {t("common.save")}
      </button>
      <button
        onClick={onCancel}
        aria-label={t("common.cancel")}
        style={{ color: "var(--muted-deep)", padding: 6, background: "transparent", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)" }}
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}
