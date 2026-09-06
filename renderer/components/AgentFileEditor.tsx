"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";

/**
 * 구성요소 섹션의 편집기 — 에이전트를 이루는 파일을 그 자리에서 열고 고친다.
 *
 * 이 섹션은 지금까지 "무엇이 있다/없다"는 배지와 고정된 설명 카드만 보여줬다. 실제
 * 시스템 프롬프트나 플레이북을 고치려면 앱 밖으로 나가 파일을 찾아야 했고, 어디에
 * 있는지는 화면 어디에도 없었다. 읽기·쓰기 배관(agentFiles.read/write)은 이미 있었으니
 * 없던 것은 화면뿐이다.
 *
 * 지키는 것 셋:
 *  1. 저장하지 않은 편집을 조용히 잃지 않는다 — 다른 파일로 옮길 때 확인한다.
 *  2. 저장 결과를 지어내지 않는다 — 실패하면 실패한 이유를 그대로 보여주고,
 *     성공했을 때만 성공이라고 말한다.
 *  3. 디스크가 정본이다 — 저장 후 다시 읽어 화면과 파일이 어긋나지 않게 한다.
 */

type FileEntry = { name: string; path: string; size?: number };

/**
 * 편집기가 다루는 파일 소스. 에이전트 폴더와 설치된 엔진은 경로 규칙도 안전 경계도
 * 다르지만, 사람이 하는 일(고르고·고치고·저장)은 같다. 그래서 화면은 하나만 두고
 * 소스를 주입한다.
 */
export interface EditorSource {
  list: () => Promise<{ root: string; entries: FileEntry[]; notice?: string; sourceMissing?: boolean }>;
  read: (key: string) => Promise<string>;
  write: (key: string, content: string) => Promise<void>;
}

/** 설치된 엔진의 텍스트 자산(스킬·호스트 훅·어댑터 매니페스트). */
export function runtimeEditorSource(ko: boolean): EditorSource {
  return {
    list: async () => {
      const api = ipc();
      if (!api) return { root: "", entries: [] };
      const listing = await api.runtimeFiles.list();
      return {
        root: String(listing?.root ?? ""),
        entries: (listing?.entries ?? []).map((e) => ({ name: e.relPath, path: e.relPath, size: e.size })),
        // 사라질 수 있다는 걸 알고 고치는 것과 모르고 잃는 것은 다르다.
        notice: listing?.overwrittenByUpdate
          ? (ko
            ? "이 파일들은 엔진 업데이트가 다시 씁니다 — 여기서 한 편집은 다음 업데이트에서 사라질 수 있습니다."
            : "These files are rewritten by engine updates — edits here can disappear on the next update.")
          : undefined,
      };
    },
    read: async (key) => {
      const api = ipc();
      if (!api) return "";
      const r = await api.runtimeFiles.read(key);
      return typeof r === "string" ? r : String(r?.content ?? "");
    },
    write: async (key, content) => {
      const api = ipc();
      if (!api) throw new Error("bridge unavailable");
      await api.runtimeFiles.write(key, content);
    },
  };
}

export function AgentFileEditor({ agentId, locale, source, title, subtitle }: {
  agentId?: string;
  locale: "ko" | "en";
  /** 주입하면 그 소스를 쓴다. 없으면 agentId 의 에이전트 폴더. */
  source?: EditorSource;
  title?: string;
  subtitle?: string;
}) {
  const ko = locale === "ko";
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [rootPath, setRootPath] = useState<string>("");
  const [listError, setListError] = useState("");
  const [sourceMissing, setSourceMissing] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string>("");   // 디스크에서 읽은 원본
  const [draft, setDraft] = useState<string>("");     // 편집 중인 내용
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "saved" | "error"; text: string }>({ kind: "idle", text: "" });
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const dirty = draft !== loaded;

  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    if (!api) return;
    if (!source && !agentId) return;
    setListError("");
    setSourceMissing(false);
    const load = source
      ? source.list()
      : api.agentFiles.list(agentId as string).then((l: { path?: string; entries?: FileEntry[]; exists?: boolean; reason?: string } | null) => ({
          root: String(l?.path ?? ""),
          entries: Array.isArray(l?.entries) ? l.entries : [],
          notice: undefined as string | undefined,
          sourceMissing: l?.exists === false && l?.reason === "source-missing",
        }));
    void load
      .then((listing) => {
        if (cancelled) return;
        setRootPath(listing.root);
        setEntries(listing.entries);
        setNotice(listing.notice ?? "");
        setSourceMissing(listing.sourceMissing === true);
        if (listing.sourceMissing) setActivePath(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setListError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [agentId, source]);

  const openFile = useCallback(async (path: string) => {
    const api = ipc();
    if (!api) return;
    if (dirty && activePath && path !== activePath) {
      const proceed = window.confirm(ko
        ? "저장하지 않은 편집이 있습니다. 버리고 다른 파일을 열까요?"
        : "You have unsaved edits. Discard them and open another file?");
      if (!proceed) return;
    }
    setBusy(true);
    setStatus({ kind: "idle", text: "" });
    try {
      const value = source
        ? await source.read(path)
        : await api.agentFiles.read(agentId as string, path)
            .then((t) => (typeof t === "string" ? t : String((t as { content?: string })?.content ?? "")));
      setActivePath(path);
      setLoaded(value);
      setDraft(value);
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [agentId, activePath, dirty, ko, source]);

  const save = useCallback(async () => {
    const api = ipc();
    if (!api || !activePath) return;
    setBusy(true);
    setStatus({ kind: "idle", text: "" });
    try {
      const intended = draftRef.current;
      if (source) await source.write(activePath, intended);
      else await api.agentFiles.write(agentId as string, activePath, intended);
      /*
       * 디스크가 정본이다 — 쓴 값을 그대로 믿지 않고 다시 읽는다.
       *
       * ★그리고 읽은 값을 draft 에까지 덮어쓰면 안 된다. 그렇게 하면 쓰기가 무시돼도
       * draft 와 loaded 가 같아져 "변경 없음 = 저장됨"으로 보인다 — 저장되지 않은 편집을
       * 저장됐다고 말하는 쪽이 저장 실패보다 나쁘다. 돌아온 내용이 의도와 다르면 편집을
       * 화면에 남긴 채 그 사실을 말한다.
       */
      const value = source
        ? await source.read(activePath)
        : await api.agentFiles.read(agentId as string, activePath)
            .then((b) => (typeof b === "string" ? b : String((b as { content?: string })?.content ?? "")));
      setLoaded(value);
      if (value === intended) {
        setDraft(value);
        setStatus({ kind: "saved", text: ko ? "저장했습니다" : "Saved" });
      } else {
        setStatus({
          kind: "error",
          text: ko
            ? "저장했지만 파일 내용이 편집한 것과 다릅니다 — 다른 곳에서 이 파일을 바꾸고 있을 수 있습니다."
            : "Written, but the file does not match what you edited — something else may be rewriting it.",
        });
      }
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [agentId, activePath, ko, source]);

  const lineCount = useMemo(() => draft.split("\n").length, [draft]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (dirty && !busy) void save();
    }
  };

  return (
    <section style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
      <h4 style={{ margin: "0 0 6px", fontSize: 13.5 }}>{title ?? (ko ? "파일 편집" : "Edit files")}</h4>
      <p style={{ margin: "0 0 12px", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5 }}>
        {subtitle ?? (ko
          ? "이 에이전트를 이루는 파일을 여기서 바로 고칩니다. 저장하면 디스크에 그대로 씁니다 — 다음 실행부터 반영됩니다."
          : "Edit the files this agent is made of, right here. Saving writes to disk and takes effect on the next run.")}
      </p>

      {notice && (
        <p style={{ margin: "0 0 10px", padding: "8px 10px", borderRadius: 8, background: "var(--amber-soft, rgba(180,120,0,0.08))", color: "var(--amber-deep, var(--warn))", fontSize: 11.5, lineHeight: 1.5 }}>
          {notice}
        </p>
      )}

      {listError && (
        <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--danger, var(--danger))" }}>
          {ko ? "파일 목록을 불러오지 못했습니다: " : "Could not list files: "}{listError}
        </p>
      )}

      {sourceMissing && (
        <p role="status" style={{ margin: "0 0 10px", padding: "8px 10px", borderRadius: 8, background: "var(--amber-soft, rgba(180,120,0,0.08))", color: "var(--amber-deep, var(--warn))", fontSize: 11.5, lineHeight: 1.5 }}>
          {ko ? "에이전트 원본 폴더를 찾지 못했습니다. 에이전트는 목록에 남아 있습니다. 원본을 다시 연결한 뒤 새로고침하세요." : "The agent source folder is missing. The installed agent remains listed; reconnect the source and refresh."}
      </p>
      )}

      {rootPath && (
        <p style={{ margin: "0 0 10px", fontSize: 11, color: "var(--muted-deep)", wordBreak: "break-all" }}>{rootPath}</p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, 220px) 1fr", gap: 12, minHeight: 320 }}>
        <div style={{ border: "1px solid var(--paper-edge)", borderRadius: 10, overflow: "auto", maxHeight: 420 }}>
          {entries.length === 0 && (
            <p style={{ margin: 0, padding: 12, fontSize: 11.5, color: "var(--muted-deep)" }}>
              {sourceMissing
                ? (ko ? "원본 폴더가 없어 파일을 표시할 수 없습니다." : "The source folder is missing, so its files cannot be shown.")
                : (ko ? "이 에이전트 폴더에서 파일을 찾지 못했습니다." : "No files found in this agent's folder.")}
            </p>
          )}
          {entries.map((entry) => {
            const active = entry.path === activePath;
            return (
              <button
                key={entry.path}
                type="button"
                onClick={() => void openFile(entry.path)}
                style={{
                  display: "block", width: "100%", textAlign: "left", minHeight: 36,
                  padding: "8px 10px", border: 0, borderBottom: "1px solid var(--paper-edge)",
                  background: active ? "var(--fill-1)" : "transparent",
                  fontWeight: active ? 700 : 500, fontSize: 12, cursor: "pointer",
                  color: "var(--ink)",
                }}
              >
                {entry.name}
                {entry.path === activePath && dirty && <span style={{ marginLeft: 6, color: "var(--accent)" }}>●</span>}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          {!activePath && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--muted-deep)" }}>
              {ko ? "왼쪽에서 파일을 고르세요." : "Pick a file on the left."}
            </p>
          )}
          {activePath && (
            <>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                spellCheck={false}
                aria-label={ko ? "파일 내용" : "File contents"}
                style={{
                  flex: 1, minHeight: 300, resize: "vertical", padding: 12,
                  border: "1px solid var(--paper-edge)", borderRadius: 10,
                  fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.55,
                  background: "var(--paper-2)", color: "var(--ink)", whiteSpace: "pre",
                  overflowWrap: "normal", overflowX: "auto",
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!dirty || busy}
                  style={{
                    minHeight: 34, padding: "0 14px", borderRadius: 8,
                    border: "1px solid var(--paper-edge)",
                    background: dirty && !busy ? "var(--accent)" : "var(--paper-2)",
                    color: dirty && !busy ? "var(--white)" : "var(--muted-deep)",
                    fontWeight: 700, fontSize: 12,
                    cursor: dirty && !busy ? "pointer" : "default",
                  }}
                >
                  {busy ? (ko ? "저장 중…" : "Saving…") : (ko ? "저장 (⌘S)" : "Save (⌘S)")}
                </button>
                <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                  {lineCount}{ko ? "줄" : " lines"}
                  {dirty ? (ko ? " · 저장하지 않은 변경" : " · unsaved changes") : ""}
                </span>
                {status.kind !== "idle" && (
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: status.kind === "saved" ? "var(--green-deep)" : "var(--danger, var(--danger))" }}>
                    {status.text}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
