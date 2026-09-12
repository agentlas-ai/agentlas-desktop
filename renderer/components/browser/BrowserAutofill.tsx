"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconClose, IconEdit, IconPlus, IconTrash, IconWand } from "@/components/Icon";
import type {
  BrowserAutofillAPI,
  BrowserAutofillSnapshot,
  BrowserContactField,
  BrowserContactValues,
} from "@shared/browser-autofill";
import type { BrowserUiTarget } from "@shared/browser-ui";
import menu from "@/components/PanelPopover.module.css";
import styles from "./BrowserAutofill.module.css";

type Mode = "passwords" | "contacts";
const EMPTY: BrowserAutofillSnapshot = { schemaVersion: "agentlas.browser-autofill.v1", state: "ready", credentials: [], contacts: [] };
const CONTACT_FIELDS: BrowserContactField[] = ["name", "email", "phone", "organization", "addressLine1", "addressLine2", "city", "region", "postalCode", "country"];

function api(): BrowserAutofillAPI | undefined {
  return (window.agentlas as typeof window.agentlas & { browserAutofill?: BrowserAutofillAPI })?.browserAutofill;
}

function currentOrigin(url: string | undefined): string {
  try { return url ? new URL(url).origin : ""; } catch { return ""; }
}

export function BrowserAutofill({ open, mode, target, ko, onClose, onPrepareOverlay, onOverlayClosed }: {
  open: boolean;
  mode: Mode;
  target: BrowserUiTarget | null;
  ko: boolean;
  onClose: () => void;
  onPrepareOverlay: () => Promise<void>;
  onOverlayClosed: () => void;
}) {
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [removePending, setRemovePending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [originHint, setOriginHint] = useState("");
  const [busy, setBusy] = useState(false);
  const lifecycle = useRef(0);
  const pending = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLInputElement>(null);
  const origin = useRef<HTMLInputElement>(null);
  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const contactInputs = useRef<Partial<Record<BrowserContactField, HTMLInputElement>>>({});

  const clearPlaintext = useCallback(() => {
    for (const ref of [label, origin, username, password]) if (ref.current) ref.current.value = "";
    for (const field of CONTACT_FIELDS) if (contactInputs.current[field]) contactInputs.current[field]!.value = "";
  }, []);
  const close = useCallback(() => {
    lifecycle.current++; pending.current = false; setBusy(false);
    clearPlaintext(); setEditing(null); setRemovePending(null); setNotice(null); onOverlayClosed(); onClose();
  }, [clearPlaintext, onClose, onOverlayClosed]);
  const refresh = useCallback(async (generation: number) => {
    const result = await api()?.snapshot();
    if (result && lifecycle.current === generation) setSnapshot(result);
  }, []);
  const runAction = async (action: (client: BrowserAutofillAPI, current: () => boolean, generation: number) => Promise<void>) => {
    const client = api(); if (!client || pending.current) return;
    const generation = lifecycle.current;
    const current = () => lifecycle.current === generation;
    pending.current = true; setBusy(true);
    try { await action(client, current, generation); }
    catch { if (current()) setNotice(ko ? "작업을 완료하지 못했습니다. 다시 시도해 주세요." : "Could not complete this action. Try again."); }
    finally { if (current()) { pending.current = false; setBusy(false); } }
  };

  useEffect(() => {
    if (!open) return;
    const generation = ++lifecycle.current;
    pending.current = false; setBusy(false);
    let active = true;
    void onPrepareOverlay().then(async () => {
      const [state, history] = await Promise.all([
        api()?.snapshot(),
        target ? window.agentlas?.browserUi.history({ ...target, limit: 1 }) : undefined,
      ]);
      if (!active) return;
      if (state) setSnapshot(state);
      setOriginHint(currentOrigin(history?.ok ? history.entries.find((entry) => entry.current)?.url : undefined));
      root.current?.focus();
    }).catch(() => { if (active) setNotice(ko ? "자동 완성 저장소를 열지 못했습니다." : "Could not open autofill storage."); });
    return () => { active = false; if (lifecycle.current === generation) lifecycle.current++; clearPlaintext(); };
  }, [open, mode, target?.viewId, target?.taskScopeId, ko, onPrepareOverlay, clearPlaintext]);

  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    let waitingForRelease = false;
    const outside = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation(); waitingForRelease = true;
    };
    const release = () => { if (waitingForRelease) { waitingForRelease = false; close(); } };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
    };
  }, [open, close]);

  const beginCredential = (id: string | "new") => {
    clearPlaintext(); setEditing(id); setNotice(null);
    const current = id === "new" ? undefined : snapshot.credentials.find((item) => item.id === id);
    queueMicrotask(() => {
      if (label.current) label.current.value = current?.label ?? "";
      if (origin.current) origin.current.value = current?.origin ?? originHint;
      username.current?.focus();
    });
  };
  const beginContact = (id: string | "new") => {
    clearPlaintext(); setEditing(id); setNotice(null);
    const current = id === "new" ? undefined : snapshot.contacts.find((item) => item.id === id);
    queueMicrotask(() => { if (label.current) label.current.value = current?.label ?? ""; label.current?.focus(); });
  };
  const saveCredential = () => runAction(async (client, current, generation) => {
    const result = await client.saveCredential({ id: editing === "new" ? undefined : editing ?? undefined,
      label: label.current?.value ?? "", origin: origin.current?.value ?? "",
      username: username.current?.value ?? "", password: password.current?.value ?? "" });
    if (!current()) return;
    if (!result.ok) { setNotice(ko ? "모든 값을 확인한 뒤 다시 저장하세요." : "Check every value and save again."); return; }
    clearPlaintext();
    setEditing(null); setNotice(ko ? "비밀번호를 안전하게 저장했습니다." : "Password saved securely."); await refresh(generation);
  });
  const saveContact = () => runAction(async (client, current, generation) => {
    const fields = Object.fromEntries(CONTACT_FIELDS.map((field) => [field, contactInputs.current[field]?.value ?? ""])) as BrowserContactValues;
    const result = await client.saveContact({ id: editing === "new" ? undefined : editing ?? undefined, label: label.current?.value ?? "", fields });
    if (!current()) return;
    if (!result.ok) { setNotice(ko ? "이름과 채울 정보를 확인해 주세요." : "Check the label and contact values."); return; }
    clearPlaintext();
    setEditing(null); setNotice(ko ? "연락처를 안전하게 저장했습니다." : "Contact saved securely."); await refresh(generation);
  });
  const fill = (id: string) => runAction(async (client, current) => {
    if (!target) return;
    const result = mode === "passwords"
      ? await client.fillCredential({ ...target, credentialId: id, userConfirmed: true })
      : await client.fillContact({ ...target, contactId: id, userConfirmed: true });
    if (!current()) return;
    if (!result.ok) setNotice(result.reason === "origin-mismatch"
      ? (ko ? "저장한 사이트와 현재 페이지가 다릅니다." : "This password belongs to a different site.")
      : (ko ? "현재 페이지에서 채울 입력칸을 찾지 못했습니다." : "Could not fill this page."));
    else setNotice(ko ? "현재 페이지에 채웠습니다. 전송 전 내용을 확인하세요." : "Filled this page. Review it before submitting.");
  });
  const remove = (id: string) => runAction(async (client, current, generation) => {
    const result = mode === "passwords" ? await client.removeCredential({ id }) : await client.removeContact({ id });
    if (!current()) return;
    if (result.ok) { setRemovePending(null); setEditing(null); await refresh(generation); }
    else setNotice(ko ? "삭제하지 못했습니다." : "Could not delete this item.");
  });

  if (!open) return null;
  const unavailable = snapshot.state !== "ready";
  const rows = mode === "passwords"
    ? snapshot.credentials.map((item) => ({ id: item.id, label: item.label,
      summary: `${item.origin} · ${item.maskedUsername ?? (ko ? "사용자 이름 없음" : "No username")}` }))
    : snapshot.contacts.map((item) => ({ id: item.id, label: item.label,
      summary: `${item.availableFields.length}${ko ? "개 항목" : " fields"}${item.maskedEmail ? ` · ${item.maskedEmail}` : ""}` }));
  return <div ref={root} className={`${menu.panelPopover} ${styles.panel}`} role="dialog" tabIndex={-1}
    aria-label={ko ? (mode === "passwords" ? "비밀번호" : "연락처 자동 완성") : mode === "passwords" ? "Passwords" : "Contact autofill"}>
    <div className={styles.header}><strong>{ko ? (mode === "passwords" ? "비밀번호" : "연락처") : mode === "passwords" ? "Passwords" : "Contacts"}</strong><button className={styles.iconButton} type="button" onClick={close} title={ko ? "닫기" : "Close"} aria-label={ko ? "닫기" : "Close"}><IconClose size={15}/></button></div>
    {unavailable && <p className={styles.notice}>{ko ? "보안 저장소를 사용할 수 없습니다." : "Secure storage is unavailable."}</p>}
    {!unavailable && rows.map((item) => <div className={styles.item} key={item.id}>
      <div><strong>{item.label}</strong><span>{item.summary}</span></div>
      {removePending === item.id ? <div className={styles.actions}><button type="button" disabled={busy} onClick={() => setRemovePending(null)}>{ko ? "취소" : "Cancel"}</button><button type="button" disabled={busy} onClick={() => void remove(item.id)}>{ko ? "삭제 확인" : "Delete"}</button></div>
        : <div className={styles.actions}><button className={styles.iconButton} type="button" disabled={busy || !target} onClick={() => void fill(item.id)} title={ko ? "채우기" : "Fill"} aria-label={ko ? "채우기" : "Fill"}><IconWand size={15}/></button><button className={styles.iconButton} type="button" disabled={busy} onClick={() => mode === "passwords" ? beginCredential(item.id) : beginContact(item.id)} title={ko ? "전체 교체" : "Replace"} aria-label={ko ? "전체 교체" : "Replace"}><IconEdit size={15}/></button><button className={styles.iconButton} type="button" disabled={busy} onClick={() => setRemovePending(item.id)} title={ko ? "삭제" : "Delete"} aria-label={ko ? "삭제" : "Delete"}><IconTrash size={15}/></button></div>}
    </div>)}
    {!unavailable && rows.length === 0 && <p className={styles.notice}>{ko ? "저장된 항목이 없습니다." : "No saved items."}</p>}
    {!unavailable && editing === null && <button className={menu.panelMenuRow} type="button" disabled={busy} onClick={() => mode === "passwords" ? beginCredential("new") : beginContact("new")}>{ko ? "새로 저장" : "Save new"}<IconPlus size={15}/></button>}
    {!unavailable && editing !== null && <div className={styles.form}>
      <p>{editing === "new" ? (ko ? "새 항목" : "New item") : (ko ? "기존 값은 표시하지 않습니다. 새 값으로 전체 교체합니다." : "Saved values stay hidden. Enter a complete replacement.")}</p>
      <label>{ko ? "이름" : "Label"}<input disabled={busy} ref={label} maxLength={120} autoComplete="off" /></label>
      {mode === "passwords" ? <>
        <label>{ko ? "사이트" : "Site"}<input disabled={busy} ref={origin} maxLength={2048} inputMode="url" autoComplete="off" /></label>
        <label>{ko ? "사용자 이름" : "Username"}<input disabled={busy} ref={username} maxLength={512} autoComplete="off" /></label>
        <label>{ko ? "비밀번호" : "Password"}<input disabled={busy} ref={password} type="password" maxLength={4096} autoComplete="new-password" /></label>
      </> : CONTACT_FIELDS.map((field) => <label key={field}>{ko ? ({ name: "이름", email: "이메일", phone: "전화번호", organization: "회사", addressLine1: "주소", addressLine2: "상세 주소", city: "도시", region: "지역", postalCode: "우편번호", country: "국가" }[field]) : field}<input disabled={busy} ref={node => { if (node) contactInputs.current[field] = node; else delete contactInputs.current[field]; }} maxLength={512} autoComplete="off" /></label>)}
      <div className={styles.formActions}><button type="button" disabled={busy} onClick={() => { clearPlaintext(); setEditing(null); }}>{ko ? "취소" : "Cancel"}</button><button type="button" disabled={busy} onClick={() => void (mode === "passwords" ? saveCredential() : saveContact())}>{ko ? "안전하게 저장" : "Save securely"}</button></div>
    </div>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
  </div>;
}
