"use client";

/*
 * The running Build screen's two right-hand columns (F-D10, picture build-v5-building): the agent's files as they are written, and the file being written.
 * Files come from `buildWorkbench.files` and the `onFiles(runId)` signal (shared/build-workbench.ts); nothing here is read on a timer.
 * The build's key is found once through `buildWorkbench.list` (only one build can run at a time), never guessed from a folder name.
 */
import { useEffect, useRef, useState } from "react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ipc } from "@/lib/ipc";
import type { BuildFileNode, BuildFileRead } from "@shared/build-workbench";
import { BuildCode, BuildFileTree } from "./BuildFilePanes";
import s from "./BuildSavedWindow.module.css";

/** The saved-build key of the build that is running now (or just ended). null = no Build backend, or no such build. Read when a run starts and when it ends. */
export function useLiveBuildKey(phase: string, runId: string | null): { key: string | null; title: string } {
  const [found, setFound] = useState<{ key: string | null; title: string }>({ key: null, title: "" });
  const active = phase === "running" || phase === "done";
  useEffect(() => {
    if (!active) { setFound({ key: null, title: "" }); return; }
    const api = ipc()?.buildWorkbench;
    if (!api?.list) return;
    let alive = true;
    void Promise.resolve().then(() => api.list({ limit: 5 })).then((answer) => {
      if (!alive || !answer || !answer.ok) return;
      const item = answer.items.find((i) => i.state === "building" || i.state === "question") ?? (phase === "done" ? answer.items[0] : undefined);
      setFound(item ? { key: item.id, title: (item.name ?? "").trim() || item.title } : { key: null, title: "" });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [active, phase, runId]);
  return found;
}

export function LiveBuildFiles({ ko, buildKey, title, runId, running }: { ko: boolean; buildKey: string; title: string; runId: string | null; running: boolean }) {
  const [nodes, setNodes] = useState<BuildFileNode[]>([]);
  const [failed, setFailed] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [file, setFile] = useState<BuildFileRead | null>(null);
  const [fileFailed, setFileFailed] = useState(false);
  const picked = useRef(false);   // the person chose a file: stop following the one being written
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const readTree = async () => {
    const answer = await ipc()?.buildWorkbench?.files(buildKey).catch(() => null);
    if (!alive.current) return;
    if (answer && answer.ok) { setNodes(answer.nodes); setFailed(false); } else { setFailed(true); }
  };
  const readOne = async (target: string) => {
    const answer = await ipc()?.buildWorkbench?.readFile({ buildKey, path: target }).catch(() => null);
    if (!alive.current) return;
    if (answer && answer.ok) { setFile(answer.file); setFileFailed(false); } else { setFile(null); setFileFailed(true); }
  };

  useEffect(() => { void readTree(); }, [buildKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pathRef = useRef<string | null>(null);
  pathRef.current = path;
  useEffect(() => {
    const api = ipc()?.buildWorkbench;
    if (!running || !runId || !api?.onFiles) return;
    return api.onFiles(runId, (event) => {
      if (!alive.current) return;
      if (event.kind === "end") { void readTree(); return; }
      setNodes((current) => {
        const rest = current.filter((n) => n.path !== event.path);
        if (event.state === "removed") return rest;
        const parts = event.path.split("/");
        const dirs = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/")).filter((d) => !rest.some((n) => n.path === d));
        return [...rest, ...dirs.map((d): BuildFileNode => ({ path: d, type: "dir", state: "written", size: 0 })), { path: event.path, type: "file" as const, state: event.state, size: event.size } as BuildFileNode]
          .sort((a, b) => a.path.localeCompare(b.path));
      });
      if (!picked.current && event.state !== "removed") setPath(event.path);
      if (event.state === "written" && pathRef.current === event.path) void readOne(event.path);
    });
  }, [running, runId, buildKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (path) void readOne(path); else setFile(null); }, [path, buildKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const writing = nodes.find((n) => n.path === path)?.state === "writing";
  return (
    <>
      <aside className={s.files} aria-label={ko ? "파일" : "Files"}>
        <div className={s.agentHead}><AgentAvatar name={title || "?"} size={30} /><div><strong>{title}</strong></div></div>
        <BuildFileTree ko={ko} nodes={nodes} failed={failed} path={path} onPick={(p) => { picked.current = true; setPath(p); }} />
      </aside>
      <section className={s.viewer} aria-label={ko ? "파일 내용" : "File"}>
        <div className={s.viewerHead}><strong>{path ?? ""}</strong>{path && writing && <span className={s.chip}>{ko ? "작성 중" : "Writing"}</span>}</div>
        <BuildCode ko={ko} file={file} failed={fileFailed} />
      </section>
    </>
  );
}
