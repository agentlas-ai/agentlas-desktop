/**
 * 에이전트가 "이건 보고서다" 라고 스스로 밝히는 표식.
 *
 * 오너 지시 2026-08-24: 보고서 형태로 쓸지는 **에이전트 판단**이다. 글의
 * 모양(제목 개수·목록 개수)으로 추측하던 방식은 판정자를 하나 더 세우는
 * 일이고, 같은 글이 그날 형식에 따라 문서가 되기도 안 되기도 한다.
 *
 * 표식은 글 맨 앞의 프론트매터 한 덩이다:
 *
 *   ---
 *   document: 보고서 제목
 *   ---
 *   # 보고서 제목
 *   ...
 *
 * `document` 한 줄이면 충분하고, 제목을 비우면 첫 번째 제목 줄을 쓴다.
 */
export interface OneDocumentMark {
  title: string;
  /** 표식을 걷어낸 본문. */
  body: string;
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function readOneDocumentMark(text: string): OneDocumentMark | null {
  if (typeof text !== "string") return null;
  const source = text.replace(/^﻿/, "");
  const match = FRONT_MATTER.exec(source);
  if (!match) return null;

  let declared: string | null = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (key !== "document" && key !== "report") continue;
    declared = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    break;
  }
  if (declared === null) return null;

  const body = source.slice(match[0].length).replace(/^\s*\n/, "");
  const firstHeading = /^#{1,3}[ \t]+(.+?)[ \t]*$/m.exec(body);
  const title = declared || (firstHeading ? firstHeading[1].trim() : "");
  return { title, body };
}

/** 파일 이름으로 쓸 수 있게 다듬는다. 빈 제목도 이름을 얻는다. */
export function documentFileSlug(title: string): string {
  const cleaned = (title || "").trim().replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, "-");
  return cleaned.slice(0, 60) || "document";
}
