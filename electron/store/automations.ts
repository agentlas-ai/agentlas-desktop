// 자동화 — SQLite 영속 + 스케줄 next-run 계산. (이전 M0 in-memory stub 대체)
// targetType: agent(개별 에이전트) | firm(CEO 호출). createdBy: user(폼) | agent(채팅 emitter).
// 실제 실행은 automation-scheduler.ts가 dueAutomations()를 폴링해 백그라운드 chat으로 돌린다.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type { Automation } from "../../shared/types";

interface AutomationRow {
  id: string;
  name: string;
  schedule: string;
  target_type: "agent" | "firm";
  target_id: string;
  prompt_template: string;
  enabled: number;
  created_by: "user" | "agent";
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    scheduleHuman: row.schedule,
    targetType: row.target_type,
    targetId: row.target_id,
    promptTemplate: row.prompt_template,
    enabled: !!row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
  };
}

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// 스케줄 문자열("daily-09:00" | "weekday-09:00" | "weekly-mon-10:00" | "monthly-1-09:00")
// → from 이후 다음 실행 시각(ISO, 로컬). 모르면 from + 24h.
export function computeNextRun(schedule: string, from: Date = new Date()): string {
  const parts = (schedule || "").split("-");
  const kind = parts[0];
  const time = parts[parts.length - 1] || "09:00";
  if (kind === "hourly") {
    return new Date(from.getTime() + 60 * 60 * 1000).toISOString();
  }
  if (kind === "every") {
    const raw = parts[1] ?? "";
    const match = raw.match(/^(\d+)(m|h)$/);
    if (match) {
      const amount = parseInt(match[1], 10);
      const unit = match[2];
      if (amount > 0) {
        const minutes = unit === "h" ? amount * 60 : amount;
        return new Date(from.getTime() + minutes * 60 * 1000).toISOString();
      }
    }
  }
  const [hh, mm] = time.split(":").map((n) => parseInt(n, 10));
  const fallback = new Date(from.getTime() + 24 * 3600 * 1000).toISOString();
  if (Number.isNaN(hh) || Number.isNaN(mm)) return fallback;

  const c = new Date(from);
  c.setHours(hh, mm, 0, 0);

  if (kind === "daily") {
    if (c <= from) c.setDate(c.getDate() + 1);
  } else if (kind === "weekday") {
    if (c <= from) c.setDate(c.getDate() + 1);
    while (c.getDay() === 0 || c.getDay() === 6) c.setDate(c.getDate() + 1);
  } else if (kind === "weekly") {
    const dow = DOW[parts[1]];
    if (dow === undefined) return fallback;
    const add = (dow - c.getDay() + 7) % 7;
    c.setDate(c.getDate() + add);
    if (c <= from) c.setDate(c.getDate() + 7);
  } else if (kind === "monthly") {
    const day = parseInt(parts[1], 10);
    if (Number.isNaN(day)) return fallback;
    c.setDate(day);
    if (c <= from) {
      c.setMonth(c.getMonth() + 1);
      c.setDate(day);
    }
  } else {
    return fallback;
  }
  return c.toISOString();
}

export function listAutomations(): Automation[] {
  const rows = getDb()
    .prepare("SELECT * FROM automations ORDER BY created_at DESC")
    .all() as AutomationRow[];
  return rows.map(toAutomation);
}

export function getAutomation(id: string): Automation | null {
  const row = getDb().prepare("SELECT * FROM automations WHERE id = ?").get(id) as AutomationRow | undefined;
  return row ? toAutomation(row) : null;
}

export function createAutomation(input: {
  name: string;
  scheduleHuman: string;
  targetType: "agent" | "firm";
  targetId: string;
  promptTemplate: string;
  createdBy?: "user" | "agent";
}): Automation {
  const id = randomUUID();
  const now = new Date();
  const nextRunAt = computeNextRun(input.scheduleHuman, now);
  getDb()
    .prepare(
      `INSERT INTO automations
         (id, name, schedule, target_type, target_id, prompt_template, enabled, created_by, last_run_at, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      input.name.trim() || "Automation",
      input.scheduleHuman,
      input.targetType,
      input.targetId,
      input.promptTemplate,
      input.createdBy ?? "user",
      nextRunAt,
      now.toISOString(),
    );
  return getAutomation(id) as Automation;
}

export function toggleAutomation(id: string, enabled: boolean): Automation {
  const existing = getAutomation(id);
  if (!existing) throw new Error(`Automation not found: ${id}`);
  // 다시 켤 때는 과거 시각으로 즉시 발화하지 않도록 next_run_at을 지금 기준으로 재계산.
  const nextRunAt = enabled ? computeNextRun(existing.scheduleHuman, new Date()) : existing.nextRunAt;
  getDb()
    .prepare("UPDATE automations SET enabled = ?, next_run_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, nextRunAt, id);
  return getAutomation(id) as Automation;
}

export function removeAutomation(id: string): void {
  getDb().prepare("DELETE FROM automations WHERE id = ?").run(id);
}

// 스케줄러가 호출 — 실행 직후 lastRunAt 기록 + 다음 실행 시각 재계산.
export function markAutomationRun(id: string, at: Date = new Date()): void {
  const existing = getAutomation(id);
  if (!existing) return;
  getDb()
    .prepare("UPDATE automations SET last_run_at = ?, next_run_at = ? WHERE id = ?")
    .run(at.toISOString(), computeNextRun(existing.scheduleHuman, at), id);
}

// enabled이고 next_run_at이 지난(due) 자동화들.
export function dueAutomations(now: Date = new Date()): Automation[] {
  const rows = getDb()
    .prepare("SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC")
    .all(now.toISOString()) as AutomationRow[];
  return rows.map(toAutomation);
}
