"use client";

/*
 * The two panes the saved Build window and the running Build screen share (F-D10): the agent's file list and one file's text with line numbers.
 * Values only from `buildWorkbench` (shared/build-workbench.ts); a state the host did not give is not drawn.
 */
import { IconFileText, IconFolder } from "@/components/Icon";
import type { BuildFileNode, BuildFileRead } from "@shared/build-workbench";
import s from "./BuildSavedWindow.module.css";

export function BuildFileTree({ ko, nodes, failed, path, onPick, changedPaths }: {
  ko: boolean; nodes: BuildFileNode[]; failed: boolean; path: string | null; onPick: (path: string) => void; changedPaths?: ReadonlySet<string>;
}) {
  if (failed) return <p className={s.muted} role="status">{ko ? "파일을 읽지 못했어요." : "Couldn't read the files."}</p>;
  const depth = (p: string) => p.split("/").length - 1;
  return (
    <ul>
      {nodes.map((n) => n.type === "dir"
        ? <li key={n.path} className={s.dir} style={{ paddingLeft: 10 + depth(n.path) * 16 }}><IconFolder size={16} /><span>{n.path.split("/").pop()}</span></li>
        : <li key={n.path}><button type="button" className={s.fileRow} aria-current={path === n.path ? "true" : undefined} data-file-state={n.state} style={{ paddingLeft: 10 + depth(n.path) * 16 }} onClick={() => onPick(n.path)}>
          <IconFileText size={16} /><span>{n.path.split("/").pop()}</span>
          {n.state === "writing" ? <i data-dot="blue" aria-label={ko ? "쓰는 중" : "Writing"} /> : changedPaths?.has(n.path) ? <i data-dot="amber" aria-label={ko ? "바뀜" : "Changed"} /> : null}
        </button></li>)}
    </ul>
  );
}

export function BuildCode({ ko, file, failed }: { ko: boolean; file: BuildFileRead | null; failed: boolean }) {
  if (failed) return <p className={s.muted} role="status">{ko ? "파일을 불러오지 못했어요." : "Couldn't read this file."}</p>;
  if (file?.binary) return <p className={s.muted}>{ko ? "미리보기 불가" : "This file can't be previewed."}</p>;
  const lines = file ? file.content.replace(/\n$/, "").split("\n") : [];
  return (
    <>
      <ol className={s.code}>{lines.map((line, i) => <li key={i}><span>{file ? file.startLine + i : i + 1}</span><code>{line || " "}</code></li>)}</ol>
      {file?.truncated && <p className={s.muted}>{ko ? "앞부분만 표시" : "Only the start of this long file is shown."}</p>}
    </>
  );
}
