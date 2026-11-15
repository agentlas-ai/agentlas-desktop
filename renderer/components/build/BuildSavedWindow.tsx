"use client";

/*
 * A saved Build / Edit window (Agentlas 2.0 F-D10, pictures build-v5-preview / build-v5-edit, piece D of desktop-final-pieces).
 * Left: the conversation as words, and the Preview tab (a test chat that is never remembered). Middle: the agent's files.
 * Right: one file, and — for an Edit — the file's "N lines changed" mark with [Undo].
 *
 * Everything is read from / sent to `buildWorkbench` (shared/build-workbench.ts). The screen shows no value the host did not give:
 * no folder guarantee ("only this folder changes" is not claimed - the host cannot stop a runtime from writing elsewhere),
 * no line diff (the host gives counts per file, not the old lines), no temporary folder name of a new build.
 * It does not send a Build turn: continuing a build is the live Build screen's job (store + runtime), reached from the build list.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowLeft, IconRefresh } from "@/components/Icon";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { hasBatchim } from "@/lib/first-run-copy";
import type { BuildFileChange, BuildFileNode, BuildFileRead, BuildOpened, BuildWorkbenchRefusal } from "@shared/build-workbench";
import { BuildCode, BuildFileTree } from "./BuildFilePanes";
import base from "./BuildWorkbench.module.css";
import s from "./BuildSavedWindow.module.css";

type Msg = { role: "user" | "assistant"; text: string };
type Load =
  | { kind: "loading" }
  | { kind: "refused"; code: BuildWorkbenchRefusal | "unavailable"; detail?: string }
  | { kind: "ready"; buildKey: string; opened: BuildOpened };

/** One line per refusal code the open calls can answer. The host sends the code; the words are here, once. */
export function buildRefusalCopy(code: BuildWorkbenchRefusal | "unavailable", name: string, ko: boolean): { title: string; body: string } {
  const who = name || (ko ? "이 에이전트" : "This agent");
  const topic = `${who}${ko ? (hasBatchim(who) ? "은" : "는") : ""}`, subject = `${who}${ko ? (hasBatchim(who) ? "이" : "가") : ""}`;
  switch (code) {
    case "agent_running":
      return { title: ko ? `${subject} 지금 작업 중이에요` : `${who} is working right now`, body: ko ? "이 턴이 끝나면 수정할 수 있어요." : "You can edit when this turn ends." };
    case "root_move_active":
      return { title: ko ? `${who}의 폴더를 이동하는 중이에요` : `${who}'s folder is being moved`, body: ko ? "이동이 끝나면 수정할 수 있어요." : "You can edit when the move finishes." };
    case "agent_not_editable":
      return { title: ko ? `${topic} 여기서 수정할 수 없어요` : `${who} can't be edited here`, body: ko ? "이 데스크탑에 고칠 수 있는 폴더가 없어요." : "There is no editable folder for it on this computer." };
    case "agent_not_found":
      return { title: ko ? "에이전트를 찾을 수 없어요" : "The agent can't be found", body: ko ? "목록에서 사라졌어요." : "It is no longer in your list." };
    case "build_not_found":
      return { title: ko ? "이 빌드를 찾을 수 없어요" : "This build can't be found", body: ko ? "목록에서 사라졌어요." : "It is no longer in the list." };
    case "folder_unavailable":
      return { title: ko ? "폴더를 열 수 없어요" : "The folder isn't available", body: ko ? "폴더가 없거나 연결이 끊겨 있어요." : "The folder is missing or its drive is offline." };
    case "baseline_unavailable":
      return { title: ko ? "아직 수정할 수 없어요" : "Edit can't start yet", body: ko ? "비교할 저장본이 없어서 이 변경은 실행 취소할 수 없어요." : "There is no saved copy to compare with, so a change could not be undone." };
    case "no_linked_agent":
      return { title: ko ? "이 빌드에는 아직 에이전트가 없어요" : "This build has no agent yet", body: ko ? "에이전트가 만들어진 뒤에 수정할 수 있어요." : "You can edit once the agent exists." };
    case "agent_root_unavailable":
      return { title: ko ? "에이전트 폴더를 열 수 없어요" : "The agents folder isn't available", body: ko ? "폴더가 없거나 연결이 끊겨 있어요." : "The folder is missing or its drive is offline." };
    default:
      return { title: ko ? "열 수 없어요" : "Couldn't open it", body: ko ? "잠시 뒤 다시 시도해 주세요." : "Try again in a moment." };
  }
}

export function BuildRefusalCard({ ko, code, name, agentId, onClose }: { ko: boolean; code: BuildWorkbenchRefusal | "unavailable"; name: string; agentId?: string | null; onClose: () => void }) {
  const copy = buildRefusalCopy(code, name, ko);
  return (
    <div className={s.refusal} role="alert" data-build-refusal={code}>
      {name && <AgentAvatar name={name} agentId={agentId ?? undefined} size={40} />}
      <div className={s.refusalText}>
        <strong>{copy.title}</strong>
        <p>{copy.body}</p>
        <div className={s.refusalActions}>
          <button type="button" className={code === "agent_running" ? s.plainButton : s.darkButton} onClick={onClose}>{ko ? "닫기" : "Close"}</button>
          {code === "agent_running" && agentId && <button type="button" className={s.darkButton} onClick={() => navigate(`/library/agents?agentId=${encodeURIComponent(agentId)}&tab=chats`)}>{ko ? "대화 열기" : "Open the chat"}</button>}
        </div>
      </div>
    </div>
  );
}

/** A line that was replaced counts once (2 lines out, 2 lines in = "2 lines changed"), as the picture reads. */
const changedLines = (c: BuildFileChange): number => Math.max(c.added, c.removed);

const stateText = (opened: BuildOpened, ko: boolean): string => {
  switch (opened.build.state) {
    case "building": return ko ? "만드는 중" : "Building";
    case "question": return ko ? "질문 대기" : "Waiting for you";
    case "created": return ko ? "생성됨" : "Created";
    case "stopped": return ko ? "중지됨" : "Stopped";
    case "unfinished": return ko ? "미완료" : "Unfinished";
  }
};

/** What the page answers when the window hands an Edit over to the live Build screen: "started", or the phase that blocks it ("running", "interview", ...), or "workspace_missing". */
export type EditHandoffAnswer = string;

export function BuildSavedWindow({ ko, buildKey, agentId, agentName, onBack, onContinueEdit }: { ko: boolean; buildKey?: string; agentId?: string; agentName?: string; onBack: () => void; onContinueEdit?: (input: { request: string; workspaceGrant: unknown }) => EditHandoffAnswer }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [tab, setTab] = useState<"build" | "preview">("build");
  const [nodes, setNodes] = useState<BuildFileNode[]>([]);
  const [changes, setChanges] = useState<BuildFileChange[]>([]);
  const [filesFailed, setFilesFailed] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [file, setFile] = useState<BuildFileRead | null>(null);
  const [fileFailed, setFileFailed] = useState(false);
  const [undoNote, setUndoNote] = useState<string | null>(null);
  const [previewMsgs, setPreviewMsgs] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [previewText, setPreviewText] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editNote, setEditNote] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Open once; the window's own commands re-read what they changed.
  useEffect(() => {
    const api = ipc()?.buildWorkbench;
    if (!api) { setLoad({ kind: "refused", code: "unavailable" }); return; }
    let live = true;
    void (async () => {
      try {
        const answer = agentId ? await api.openForAgent(agentId) : buildKey ? await api.open(buildKey) : null;
        if (!live) return;
        if (!answer) { setLoad({ kind: "refused", code: "build_not_found" }); return; }
        if (!answer.ok) { setLoad({ kind: "refused", code: answer.code, detail: answer.detail }); return; }
        const key: string = agentId ? String((answer as { buildKey?: unknown }).buildKey ?? "") : (buildKey ?? "");
        setLoad({ kind: "ready", buildKey: key, opened: answer.opened });
      } catch { if (live) setLoad({ kind: "refused", code: "unavailable" }); }
    })();
    return () => { live = false; };
  }, [agentId, buildKey]);

  const key = load.kind === "ready" ? load.buildKey : null;
  const readTree = useCallback(async (k: string) => {
    const api = ipc()?.buildWorkbench;
    if (!api) return;
    const [tree, diff] = await Promise.all([api.files(k).catch(() => null), api.changes(k).catch(() => null)]);
    if (!alive.current) return;
    if (tree && tree.ok) {
      setNodes(tree.nodes); setFilesFailed(false);
      setPath((current) => current ?? (tree.nodes.find((n) => n.type === "file" && /^(AGENTS?\.md)$/i.test(n.path))?.path ?? tree.nodes.find((n) => n.type === "file")?.path ?? null));
    } else { setNodes([]); setFilesFailed(true); }
    setChanges(diff && diff.ok ? diff.changes : []);
  }, []);
  useEffect(() => { if (key) void readTree(key); }, [key, readTree]);
  useEffect(() => {
    if (!key) return;
    void ipc()?.buildWorkbench?.previewMessages(key).then((answer) => { if (alive.current && answer?.ok) setPreviewMsgs(answer.messages.map((m) => ({ role: m.role, text: m.text }))); }).catch(() => undefined);
  }, [key]);

  useEffect(() => {
    if (!key || !path) { setFile(null); return; }
    let live = true;
    setFileFailed(false);
    void Promise.resolve().then(() => ipc()?.buildWorkbench?.readFile({ buildKey: key, path })).then((answer) => {
      if (!live) return;
      if (answer && answer.ok) setFile(answer.file); else { setFile(null); setFileFailed(true); }
    }).catch(() => { if (live) { setFile(null); setFileFailed(true); } });
    return () => { live = false; };
  }, [key, path]);

  const undo = async (target: string) => {
    if (!key) return;
    setUndoNote(null);
    const answer = await ipc()?.buildWorkbench?.undo({ buildKey: key, path: target }).catch(() => null);
    if (!alive.current) return;
    if (!answer || !answer.ok) {
      setUndoNote(answer && !answer.ok && answer.code === "build_turn_active" ? (ko ? "생성 중에는 실행 취소할 수 없어요." : "You can undo when the build turn ends.") : (ko ? "실행 취소하지 못했어요. 파일은 그대로예요." : "Couldn't undo. The file is unchanged."));
      return;
    }
    await readTree(key);
    setFile(null); setPath(null); setTimeout(() => { if (alive.current) setPath(target); }, 0);
  };

  const sendPreview = async () => {
    const text = previewText.trim();
    if (!key || !text || previewBusy) return;
    setPreviewBusy(true); setPreviewNote(null);
    const answer = await ipc()?.buildWorkbench?.previewSend({ buildKey: key, text }).catch(() => null);
    if (!alive.current) return;
    setPreviewBusy(false);
    if (answer && answer.ok) { setPreviewMsgs(answer.messages.map((m) => ({ role: m.role, text: m.text }))); setPreviewText(""); return; }
    const code = answer && !answer.ok ? answer.code : null;
    setPreviewNote(code === "preview_busy" ? (ko ? "앞선 테스트 답을 기다리는 중이에요." : "The last test message is still running.")
      : code === "no_prompt" ? (ko ? "이 에이전트에는 아직 지침이 없어 테스트할 수 없어요." : "This agent has no instructions yet, so there is nothing to test.")
      : code === "runtime_unavailable" ? (ko ? "테스트에 쓸 모델이 없어요. 연결을 확인해 주세요." : "No model is available for the test. Check your connections.")
      : code === "preview_cancelled" ? (ko ? "테스트를 멈췄어요." : "The test was stopped.")
      : (ko ? "테스트 답을 받지 못했어요. 다시 보내 보세요." : "The test didn't answer. Send it again."));
  };
  const restartPreview = async () => {
    if (!key) return;
    await ipc()?.buildWorkbench?.previewRestart(key).catch(() => null);
    if (alive.current) { setPreviewMsgs([]); setPreviewNote(null); }
  };

  // An Edit continues in the live Build screen (it owns the session, the approvals and the runtime): this window only hands the request over.
  const sendEdit = () => {
    const text = editText.trim();
    if (!text || !onContinueEdit || load.kind !== "ready") return;
    const answer = onContinueEdit({ request: text, workspaceGrant: load.opened.workspaceGrant });
    if (answer === "started") return;
    setEditNote(answer === "workspace_missing" ? (ko ? "이 에이전트의 폴더 권한을 받지 못해 이어서 수정할 수 없어요." : "The agent's folder access was not granted, so the edit can't continue.")
      : (ko ? "다른 빌드가 진행 중이에요. 그 빌드가 끝나면 이어서 수정할 수 있어요." : "Another build is in progress. Continue the edit when it ends."));
  };

  const back = () => { if (key) void ipc()?.buildWorkbench?.previewClose(key).catch(() => null); onBack(); };

  if (load.kind === "loading") return <div className={s.center} role="status">{ko ? "여는 중…" : "Opening…"}</div>;
  if (load.kind === "refused") {
    return <div className={s.center}><BuildRefusalCard ko={ko} code={load.code} name={agentName ?? ""} agentId={agentId} onClose={onBack} /></div>;
  }

  const { opened } = load;
  const title = (opened.build.name ?? "").trim() || opened.build.title;
  const folderLabel = opened.build.agentId ? `agents/${opened.folder.split(/[\\/]/).filter(Boolean).pop() ?? ""}` : null;
  const changeOf = (p: string) => changes.find((c) => c.path === p);
  const current = path ? changeOf(path) : undefined;
  const changedSet = new Set(changes.map((c) => c.path));
  const messages: Msg[] = opened.messages;

  return (
    <div className={s.window} data-build-window={tab}>
      <header className={base.toolbar}>
        <button type="button" className={base.quietButton} onClick={back}><IconArrowLeft size={16} />{opened.build.agentId && opened.build.kind === "edit" ? title : (ko ? "에이전트" : "Agents")}</button>
        <div className={base.toolbarActions}><span className={base.phase}>{stateText(opened, ko)}</span></div>
      </header>
      <div className={s.columns}>
        <section className={s.chat} aria-label={ko ? "대화" : "Conversation"}>
          <div className={s.chatTabs}>
            <div className={s.segment} role="tablist">
              <button type="button" role="tab" aria-selected={tab === "build"} onClick={() => setTab("build")}>{ko ? "빌드" : "Build"}</button>
              <button type="button" role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>{ko ? "미리보기" : "Preview"}</button>
            </div>
            {tab === "preview" && <span className={s.previewNote}>{ko ? "테스트 · 기억하지 않아요" : "Test · not remembered"}</span>}
            {tab === "preview" && <button type="button" className={base.quietButton} onClick={() => void restartPreview()}><IconRefresh size={14} />{ko ? "다시 시작" : "Restart"}</button>}
          </div>
          <div className={s.thread}>
            {tab === "build" ? (
              <>
                {opened.messagesTruncated && <p className={s.muted}>{ko ? "앞부분은 줄여서 보여 드려요." : "The earliest messages are not shown."}</p>}
                {messages.map((m, i) => m.role === "user"
                  ? <div key={i} className={base.requestBubble}>{m.text}</div>
                  : <div key={i} className={s.assistant}><div className={s.assistantName}><img src="/brand/agentlas-mark.png" alt="" /><span>Agentlas</span></div><p>{m.text}</p></div>)}
              </>
            ) : (
              <>
                {previewMsgs.map((m, i) => m.role === "user"
                  ? <div key={i} className={base.requestBubble}>{m.text}</div>
                  : <div key={i} className={s.assistant}><div className={s.assistantName}><AgentAvatar name={title} agentId={opened.build.agentId ?? undefined} size={22} /><span>{title}</span></div><p>{m.text}</p></div>)}
                {previewBusy && <p className={s.muted} role="status">{ko ? "답하는 중…" : "Answering…"}</p>}
              </>
            )}
          </div>
          {tab === "build" && onContinueEdit && load.opened.turnDefaults.mode === "package" && load.opened.continuable && (
            <form className={s.composer} onSubmit={(event) => { event.preventDefault(); sendEdit(); }}>
              <textarea rows={1} value={editText} aria-label={ko ? "수정할 내용" : "What to change"} placeholder={ko ? "수정할 내용을 적어 주세요" : "Describe the change"} onChange={(event) => setEditText(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendEdit(); } }} />
              <button type="submit" className={s.darkButton} disabled={!editText.trim()}>{ko ? "이어서 수정" : "Continue editing"}</button>
            </form>
          )}
          {tab === "build" && editNote && <p className={s.error} role="alert">{editNote}</p>}
          {tab === "build" && load.opened.turnDefaults.mode === "package" && !load.opened.continuable && (
            <p className={s.muted}>{load.opened.continuableReason === "another_build_active" ? (ko ? "다른 빌드가 진행 중이라 지금은 이어서 수정할 수 없어요." : "Another build is running, so this can't be continued now.") : (ko ? "폴더를 찾을 수 없어 이어서 수정할 수 없어요." : "The folder can't be found, so this can't be continued.")}</p>
          )}
          {tab === "preview" && (
            <form className={s.composer} onSubmit={(event) => { event.preventDefault(); void sendPreview(); }}>
              <textarea rows={1} value={previewText} aria-label={ko ? "테스트 메시지" : "Test message"} placeholder={ko ? "이 에이전트에게 말해 보세요" : "Say something to this agent"} onChange={(event) => setPreviewText(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendPreview(); } }} />
              <button type="submit" className={s.darkButton} disabled={!previewText.trim() || previewBusy}>{ko ? "보내기" : "Send"}</button>
            </form>
          )}
          {previewNote && tab === "preview" && <p className={s.error} role="alert">{previewNote}</p>}
        </section>

        <aside className={s.files} aria-label={ko ? "파일" : "Files"}>
          <div className={s.agentHead}><AgentAvatar name={title} agentId={opened.build.agentId ?? undefined} size={30} /><div><strong>{title}</strong>{folderLabel && <span>{folderLabel}</span>}</div></div>
          <BuildFileTree ko={ko} nodes={nodes} failed={filesFailed} path={path} onPick={setPath} changedPaths={changedSet} />
        </aside>

        <section className={s.viewer} aria-label={ko ? "파일 내용" : "File"}>
          <div className={s.viewerHead}>
            <strong>{path ?? ""}</strong>
            {current && !current.binary && <span className={s.chip}>{ko ? `${changedLines(current)}줄 변경` : `${changedLines(current)} line${changedLines(current) === 1 ? "" : "s"} changed`}</span>}
            {current && <button type="button" className={s.plainButton} onClick={() => void undo(current.path)}>{ko ? "실행 취소" : "Undo"}</button>}
            {opened.build.agentId && <button type="button" className={s.plainButton} data-build-open-manage onClick={() => navigate(`/library/agents?agentId=${encodeURIComponent(opened.build.agentId ?? "")}`)}>{ko ? "에이전트 관리에서 열기" : "Open in Manage agents"}</button>}
          </div>
          {undoNote && <p className={s.error} role="alert">{undoNote}</p>}
          <BuildCode ko={ko} file={file} failed={fileFailed} />
        </section>
      </div>
    </div>
  );
}
