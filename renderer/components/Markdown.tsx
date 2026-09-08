// 가벼운 마크다운 렌더 — 의존성 0. LLM 출력을 안전하게 표시.
// 지원: 펜스 코드블록 ```lang\n...```, 인라인 코드 `...`, **bold**, *italic*,
//      # H1 / ## H2 / ### H3, - 또는 * 리스트, 1. 번호 리스트, [link](url), 인용 >,
//      GFM 테이블 (| a | b | + |---|---| 구분자 + 본문),
//      자동 줄바꿈(빈 줄로 단락 구분).
//
// 의도적으로 단순 — HTML 태그는 모두 escape, 사용자 입력 출처 X (LLM 출력만)이지만 안전 우선.
"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { MermaidBlock } from "./MermaidBlock";
import { MathSpan } from "./MathSpan";
import { useT } from "@/lib/i18n";
import { splitStreamingSegments, type SegmentCache } from "@shared/streaming-segments";
import { designOutputSurfaceProps } from "@/lib/design-output-tokens";

export interface CodeArtifact {
  /** 채팅 내 안정적 id — 메시지id + 블록 인덱스 조합 */
  id: string;
  language: string;
  code: string;
  /** 실제 파일로 연결된 경우에만 제공한다. 생성된 fenced block에는 없다. */
  path?: string;
}

export interface MediaArtifact {
  id: string;
  kind: "image" | "video";
  src: string;
  path?: string;
  paths?: string[];
  name: string;
}

export interface LinkedFileArtifact {
  id: string;
  name: string;
  href: string;
  path?: string;
  paths?: string[];
  fileUrl: string;
}

export function Markdown({
  chatId,
  text,
  messageId,
  onOpenArtifact,
  onOpenMedia,
  onOpenLinkedFile,
  mediaBasePaths = [],
}: {
  /** Exact chat scope for links without an owning callback. Unbound links cannot select another task panel. */
  chatId?: string | null;
  text: string;
  /** 안정적 artifact id 생성용 */
  messageId: string;
  /** 우측 패널로 열기 */
  onOpenArtifact?: (a: CodeArtifact) => void;
  /** 이미지/영상 산출물을 우측 패널로 열기 */
  onOpenMedia?: (a: MediaArtifact) => void;
  /** PDF/SVG/HTML 등 로컬 파일 링크를 우측 패널로 열기 */
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void;
  /** 상대 이미지 경로를 해석할 로컬 기준 폴더들. */
  mediaBasePaths?: string[];
}) {
  const { t } = useT();
  const openLinkedFile = useCallback((file: LinkedFileArtifact) => {
    if (onOpenLinkedFile) { onOpenLinkedFile(file); return; }
    if (!chatId || typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("agentlas:in-app-linked-file", { detail: { ...file, chatId } }));
  }, [chatId, onOpenLinkedFile]);
  const resolvedMediaBasePaths = useMemo(
    () => mediaBasePathsWithTextHints(text, mediaBasePaths),
    [text, mediaBasePaths],
  );
  const blocks = useMemo(() => parseBlocks(text, messageId), [text, messageId]);
  return (
    <div
      {...designOutputSurfaceProps("report")}
      style={{ fontSize: 14, lineHeight: 1.65, fontFamily: "var(--design-font-sans)", overflowWrap: "anywhere" }}
    >
      {blocks.map((b, i) => renderBlock(b, i, onOpenArtifact, t, onOpenMedia, openLinkedFile, resolvedMediaBasePaths))}
    </div>
  );
}

// 완결 세그먼트 렌더 — props가 안 바뀌면(텍스트 불변) 재파싱/재렌더를 통째로 건너뛴다.
// ChatStream의 인터리브 본문(SingleRunBody)도 완결 세그먼트에 이걸 써서 매 partial마다
// 전체 본문이 재파싱되는 걸 막는다.
export const MarkdownSegment = memo(function MarkdownSegment({
  text,
  messageId,
  onOpenArtifact,
  onOpenMedia,
  onOpenLinkedFile,
  mediaBasePaths = [],
}: {
  text: string;
  messageId: string;
  onOpenArtifact?: (a: CodeArtifact) => void;
  onOpenMedia?: (a: MediaArtifact) => void;
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void;
  mediaBasePaths?: string[];
}) {
  return (
    <Markdown
      text={text}
      messageId={messageId}
      onOpenArtifact={onOpenArtifact}
      onOpenMedia={onOpenMedia}
      onOpenLinkedFile={onOpenLinkedFile}
      mediaBasePaths={mediaBasePaths}
    />
  );
});

/** 스트리밍 전용 마크다운 — 누적 전문을 빈 줄 경계(펜스 밖)로 세그먼트화해, 완결 세그먼트는
 *  memo로 고정하고 마지막(미완결) 세그먼트만 매 partial마다 재파싱한다. 긴 답변에서
 *  프레임당 O(전체) 재파싱이 O(마지막 세그먼트)로 줄어 스트리밍 끊김을 없앤다. */
export function StreamingMarkdown({
  text,
  messageId,
  onOpenArtifact,
  onOpenMedia,
  onOpenLinkedFile,
  mediaBasePaths = [],
}: {
  text: string;
  messageId: string;
  onOpenArtifact?: (a: CodeArtifact) => void;
  onOpenMedia?: (a: MediaArtifact) => void;
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void;
  mediaBasePaths?: string[];
}) {
  // 콜백 identity를 고정 — 부모가 매 렌더 새 함수를 넘겨도 memo 세그먼트가 깨지지 않게.
  const artifactRef = useRef(onOpenArtifact);
  artifactRef.current = onOpenArtifact;
  const mediaRef = useRef(onOpenMedia);
  mediaRef.current = onOpenMedia;
  const linkedFileRef = useRef(onOpenLinkedFile);
  linkedFileRef.current = onOpenLinkedFile;
  const stableArtifact = useCallback((a: CodeArtifact) => artifactRef.current?.(a), []);
  const stableMedia = useCallback((a: MediaArtifact) => mediaRef.current?.(a), []);
  const stableLinkedFile = useCallback((a: LinkedFileArtifact) => linkedFileRef.current?.(a), []);

  // 타자기 리빌 — partial이 덩어리(메시지 블록·60ms 배치)로 도착해도 글자 단위로 드러낸다.
  // 밀린 분량에 비례해 속도를 올려(백로그/20 per frame) 표시가 스트림보다 계속 뒤처지지 않고,
  // 과대 백로그(재접속 리플레이·자동화 프렐류드 등 한 방 덩어리)는 크롤하지 않고 즉시 스냅한다.
  // 과거 rAF 리빌 제거의 원인이던 "매 프레임 전체 재파싱"은 아래 세그먼트 memo가 이미 해소 —
  // 프레임당 재파싱되는 것은 마지막 미완결 세그먼트뿐이다.
  const [revealLen, setRevealLen] = useState(0);
  const revealKeyRef = useRef(messageId);
  if (revealKeyRef.current !== messageId) {
    // 새 메시지로 전환 — 렌더 중 상태 리셋(React 공식 derived-state 패턴).
    revealKeyRef.current = messageId;
    setRevealLen(0);
  }
  const target = text.length;
  const shownLen = Math.min(revealLen, target);
  useEffect(() => {
    if (revealLen >= target) return;
    if (target - revealLen > 3000) {
      setRevealLen(target);
      return;
    }
    const raf = requestAnimationFrame(() => {
      setRevealLen((len) => {
        const backlog = target - len;
        return backlog <= 0 ? len : len + Math.max(1, Math.ceil(backlog / 20));
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [revealLen, target]);
  const shownText = shownLen === text.length ? text : text.slice(0, shownLen);

  const cacheRef = useRef<{ msgId: string; cache: SegmentCache | null }>({ msgId: messageId, cache: null });
  if (cacheRef.current.msgId !== messageId) cacheRef.current = { msgId: messageId, cache: null };
  const { segments, cache } = splitStreamingSegments(shownText, cacheRef.current.cache);
  cacheRef.current.cache = cache;
  return (
    <>
      {segments.map((seg, i) => (
        <MarkdownSegment
          key={`${messageId}-s${i}`}
          text={seg}
          messageId={`${messageId}-s${i}`}
          onOpenArtifact={stableArtifact}
          onOpenMedia={stableMedia}
          onOpenLinkedFile={stableLinkedFile}
          mediaBasePaths={mediaBasePaths}
        />
      ))}
    </>
  );
}

// ── 파서 ─────────────────────────────────────────────────
type TableAlign = "left" | "center" | "right" | "default";
type Block =
  | { type: "code"; lang: string; code: string; id: string }
  | { type: "math"; tex: string }
  | { type: "h1" | "h2" | "h3"; text: string }
  | { type: "ul" | "ol"; items: ListItem[]; start?: number }
  | { type: "hr" }
  | { type: "quote"; text: string }
  | { type: "table"; header: string[]; align: TableAlign[]; rows: string[][] }
  | { type: "p"; text: string };

/** 리스트 항목 — 본문과, 한 단계 들여쓴 하위 리스트(모델 답변의 "1. … / - …" 구조). */
interface ListItem {
  text: string;
  children?: { ordered: boolean; items: string[] };
}

// 수평선 `---` / `***` / `___` (CommonMark thematic break, 앞 공백 3칸까지, 사이 공백 허용).
// 채팅 답변에서 모델이 문단 사이에 넣는 `---`는 구분선 의도다 — 지원이 없어 "---"가
// 글자로 그려졌다(오너 녹화 2026-08-15 21:25, 프레임 37~44).
const HR_LINE = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const LIST_ITEM = /^([-*]|\d+\.)\s+(.+)$/;
const NESTED_LIST_ITEM = /^ {2,}([-*]|\d+\.)\s+(.+)$/;
const NESTED_CONTINUATION = /^ {2,}(\S.*)$/;

function parseBlocks(input: string, messageId: string): Block[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  let codeIdx = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 펜스 코드 블록
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || "text";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      // closing ```
      if (i < lines.length) i++;
      const code = codeLines.join("\n");
      // A fenced block with nothing inside draws as an empty dark box labelled
      // by its language ("JSON · 1줄" — user report 2026-08-16). Whatever left
      // it empty (a stripped control block, a model that opened a fence and
      // wrote nothing, a partial stream), an empty box is not content — skip it.
      // Content-bearing blocks are never touched here.
      if (code.trim() === "") continue;
      out.push({
        type: "code",
        lang,
        code,
        id: `${messageId}-c${codeIdx++}`,
      });
      continue;
    }

    /*
     * 블록 수식 `$$ ... $$`. 코드 펜스 **다음에** 본다 — 코드블록 안의 $$ 는 수식이
     * 아니라 코드이기 때문이다. 닫는 $$ 가 아직 안 왔으면(스트리밍 중) 수식으로 삼지
     * 않고 평범한 문단으로 흘려보낸다.
     */
    const oneLineMath = line.match(/^\s*\$\$(.+?)\$\$\s*$/);
    if (oneLineMath) {
      out.push({ type: "math", tex: oneLineMath[1].trim() });
      i++;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      const texLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*\$\$\s*$/.test(lines[j])) {
        texLines.push(lines[j]);
        j++;
      }
      if (j < lines.length) {
        out.push({ type: "math", tex: texLines.join("\n") });
        i = j + 1;
        continue;
      }
      // 닫히지 않았다 — 아래 일반 처리로 넘긴다.
    }

    // GFM 테이블 — 헤더 + 구분자 + 1개 이상의 본문 행.
    // 헤더와 구분자가 모두 |로 시작하거나 셀이 2개 이상이고
    // 구분자가 |?\s*:?-+:?\s*(|\s*:?-+:?\s*)+\|? 형태여야 한다.
    if (isTableHeader(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      const align = parseTableAlign(lines[i + 1]);
      // 헤더 셀 수에 맞춰 align을 보정 (모자라면 default로 채움)
      while (align.length < header.length) align.push("default");
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") {
        const row = splitTableRow(lines[i]);
        // 셀 수를 header에 맞춰 패딩/잘라내기
        while (row.length < header.length) row.push("");
        if (row.length > header.length) row.length = header.length;
        rows.push(row);
        i++;
      }
      out.push({ type: "table", header, align, rows });
      continue;
    }

    // 헤딩
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      const lvl = h[1].length as 1 | 2 | 3;
      out.push({ type: (`h${lvl}` as "h1" | "h2" | "h3"), text: h[2] });
      i++;
      continue;
    }

    // 인용
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      const buf: string[] = [q[1]];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push({ type: "quote", text: buf.join("\n") });
      continue;
    }

    // 수평선 — 리스트보다 먼저 본다(`- - -`는 리스트 항목이 아니라 구분선).
    if (HR_LINE.test(line)) {
      out.push({ type: "hr" });
      i++;
      continue;
    }

    // 리스트 (- / * / 1.) — 같은 종류의 연속 항목 + 한 단계 들여쓴 하위 항목/이어지는 줄.
    const listStart = line.match(LIST_ITEM);
    if (listStart) {
      const isOl = /\d/.test(listStart[1]);
      const start = isOl ? Number.parseInt(listStart[1], 10) : undefined;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_ITEM);
        if (!m || /\d/.test(m[1]) !== isOl) break;
        const item: ListItem = { text: m[2] };
        i++;
        while (i < lines.length) {
          const nested = lines[i].match(NESTED_LIST_ITEM);
          if (nested) {
            const ordered = /\d/.test(nested[1]);
            if (!item.children) item.children = { ordered, items: [] };
            item.children.items.push(nested[2]);
            i++;
            continue;
          }
          const continuation = lines[i].match(NESTED_CONTINUATION);
          if (continuation && !HR_LINE.test(lines[i]) && !/^ {2,}```/.test(lines[i])) {
            if (item.children) item.children.items[item.children.items.length - 1] += `\n${continuation[1]}`;
            else item.text += `\n${continuation[1]}`;
            i++;
            continue;
          }
          break;
        }
        items.push(item);
      }
      out.push(isOl && start !== undefined && start !== 1 ? { type: "ol", items, start } : { type: isOl ? "ol" : "ul", items });
      continue;
    }

    // 빈 줄 스킵
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 일반 단락 — 연속된 비어있지 않은 줄을 모음.
    // 줄바꿈은 보존한다. CommonMark의 소프트브레이크(=공백) 규칙을 따랐더니
    // "한 줄에 하나씩 세라"는 답이 "Grape 1 Grape 2 Grape 3 …" 한 덩어리로
    // 벽처럼 흘렀다 — 채팅 답변에서 모델이 낸 개행은 의도다. Codex/Claude 웹 UI
    // 모두 단일 개행을 줄바꿈으로 그린다. 렌더 쪽(case "p")이 "\n"마다 줄을 나눈다.
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push({ type: "p", text: buf.join("\n") });
  }
  return out;
}

function isBlockStart(line: string): boolean {
  return (
    /^```/.test(line) ||
    /^#{1,3}\s/.test(line) ||
    /^>\s?/.test(line) ||
    /^[-*]\s/.test(line) ||
    /^\d+\.\s/.test(line) ||
    HR_LINE.test(line) ||
    isTableHeader(line)
  );
}

// ── 테이블 헬퍼 ──────────────────────────────────────────
function isTableHeader(line: string): boolean {
  // 최소 1개의 파이프와 양옆에 셀이 있어야 함. 코드블록 안은 못 들어옴 (펜스가 먼저 잡힘).
  if (!/\|/.test(line)) return false;
  const cells = splitTableRow(line);
  return cells.length >= 2;
}

function isTableSeparator(line: string): boolean {
  // |---|:---:|---:| 같은 줄. 셀마다 옵션 ':', 최소 1개의 '-', 옵션 ':'.
  const t = line.trim();
  if (!t.includes("-")) return false;
  // 양 끝 파이프 제거 후 셀 split
  const inner = t.replace(/^\|/, "").replace(/\|$/, "");
  const cells = inner.split("|").map((c) => c.trim());
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function splitTableRow(line: string): string[] {
  // 양 끝 파이프 제거 후 split. 셀 안의 escape `\|`는 placeholder 처리.
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const PLACEHOLDER = "\u0000ESC_PIPE\u0000";
  return t
    .replace(/\\\|/g, PLACEHOLDER)
    .split("|")
    .map((c) => c.trim().replace(new RegExp(PLACEHOLDER, "g"), "|"));
}

function parseTableAlign(line: string): TableAlign[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => {
    const t = c.trim();
    const left = t.startsWith(":");
    const right = t.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "default";
  });
}

// ── 렌더 ─────────────────────────────────────────────────
function renderBlock(
  b: Block,
  i: number,
  onOpenArtifact?: (a: CodeArtifact) => void,
  t?: ReturnType<typeof useT>["t"],
  onOpenMedia?: (a: MediaArtifact) => void,
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void,
  mediaBasePaths: string[] = [],
) {
  switch (b.type) {
    case "math":
      return <MathSpan key={i} tex={b.tex} display />;
    case "code":
      // ```mermaid 는 코드가 아니라 그림으로 보여준다. 그리지 못하면(문법 오류·스트리밍
      // 중간·미지원 종류) 원래의 코드블록이 그대로 남는다 — 내용을 잃지 않는다.
      if (b.lang.trim().toLowerCase() === "mermaid") {
        return (
          <MermaidBlock
            key={i}
            code={b.code}
            fallback={<CodeBlock block={b} onOpen={onOpenArtifact} t={t} />}
          />
        );
      }
      return <CodeBlock key={i} block={b} onOpen={onOpenArtifact} t={t} />;
    case "h1":
      return (
        <h1
          key={i}
          style={{
            fontFamily: "var(--font-head)",
            fontSize: 20,
            fontWeight: 700,
            margin: "16px 0 8px",
            color: "var(--ink)",
          }}
        >
          {inline(b.text, onOpenMedia, onOpenLinkedFile, mediaBasePaths)}
        </h1>
      );
    case "h2":
      return (
        <h2
          key={i}
          style={{
            fontFamily: "var(--font-head)",
            fontSize: 17,
            fontWeight: 700,
            margin: "14px 0 6px",
            color: "var(--ink)",
          }}
        >
          {inline(b.text, onOpenMedia, onOpenLinkedFile, mediaBasePaths)}
        </h2>
      );
    case "h3":
      return (
        <h3
          key={i}
          style={{
            fontFamily: "var(--font-head)",
            fontSize: 14,
            fontWeight: 700,
            margin: "12px 0 4px",
            color: "var(--ink)",
          }}
        >
          {inline(b.text, onOpenMedia, onOpenLinkedFile, mediaBasePaths)}
        </h3>
      );
    case "ul":
    case "ol": {
      const renderItem = (it: ListItem, j: number) => {
        const textLines = it.text.split("\n");
        const children = it.children;
        const ChildTag = children?.ordered ? "ol" : "ul";
        return (
          <li key={j} style={{ marginBottom: 2 }}>
            {textLines.map((line, k) => (
              <span key={k}>
                {inline(line, onOpenMedia, onOpenLinkedFile, mediaBasePaths)}
                {k < textLines.length - 1 ? <br /> : null}
              </span>
            ))}
            {children ? (
              <ChildTag style={{ paddingLeft: 20, margin: "2px 0" }}>
                {children.items.map((child, k) => {
                  const childLines = child.split("\n");
                  return (
                    <li key={k} style={{ marginBottom: 2 }}>
                      {childLines.map((line, l) => (
                        <span key={l}>
                          {inline(line, onOpenMedia, onOpenLinkedFile, mediaBasePaths)}
                          {l < childLines.length - 1 ? <br /> : null}
                        </span>
                      ))}
                    </li>
                  );
                })}
              </ChildTag>
            ) : null}
          </li>
        );
      };
      return b.type === "ol"
        ? <ol key={i} start={b.start} style={{ paddingLeft: 22, margin: "6px 0" }}>{b.items.map(renderItem)}</ol>
        : <ul key={i} style={{ paddingLeft: 22, margin: "6px 0" }}>{b.items.map(renderItem)}</ul>;
    }
    case "hr":
      return <hr key={i} style={{ border: 0, borderTop: "var(--hairline, 1px solid var(--paper-3))", margin: "12px 0" }} />;
    case "table":
      return <TableBlock key={i} block={b} onOpenMedia={onOpenMedia} onOpenLinkedFile={onOpenLinkedFile} mediaBasePaths={mediaBasePaths} />;
    case "quote":
      return (
        <blockquote
          key={i}
          style={{
            margin: "8px 0",
            padding: "8px 12px",
            borderLeft: "3px solid var(--accent-soft)",
            background: "var(--paper-2)",
            color: "var(--ink-soft)",
            fontStyle: "italic",
            borderRadius: "0 8px 8px 0",
          }}
        >
          {b.text.split("\n").map((line, j) => (
            <div key={j}>{inline(line, onOpenMedia, onOpenLinkedFile, mediaBasePaths)}</div>
          ))}
        </blockquote>
      );
    case "p": {
      // 파서가 보존한 개행마다 줄을 나눈다 (blockquote와 동일한 규칙).
      const lines = b.text.split("\n");
      return (
        <p key={i} style={{ margin: "6px 0" }}>
          {lines.map((line, j) => (
            <span key={j}>
              {inline(line, onOpenMedia, onOpenLinkedFile, mediaBasePaths)}
              {j < lines.length - 1 ? <br /> : null}
            </span>
          ))}
        </p>
      );
    }
  }
}

// 좁은 컬럼에서도 가로 스크롤. 헤더는 sticky 안 함 — 짧은 표가 압도적이므로 단순함이 낫다.
function TableBlock({
  block,
  onOpenMedia,
  onOpenLinkedFile,
  mediaBasePaths = [],
}: {
  block: { type: "table"; header: string[]; align: TableAlign[]; rows: string[][] };
  onOpenMedia?: (a: MediaArtifact) => void;
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void;
  mediaBasePaths?: string[];
}) {
  const alignToCss = (a: TableAlign): React.CSSProperties["textAlign"] => {
    if (a === "default") return undefined;
    return a;
  };
  return (
    <div
      style={{
        margin: "10px 0",
        overflowX: "auto",
        border: "1px solid var(--paper-edge)",
        borderRadius: "var(--radius-md)",
        background: "var(--paper)",
      }}
    >
      <table
        style={{
          // width:100% 가 minWidth:max-content 를 이겨서, 칸이 좁아지면 셀
          // 글자가 한 글자씩 세로로 쪼개졌다(실측: 결과 패널을 연 폭에서
          // "부/동/산" 처럼 끊김). 내용만큼 넓히고, 좁으면 가로로 민다.
          width: "max-content",
          minWidth: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
          lineHeight: 1.45,
        }}
      >
        <thead>
          <tr>
            {block.header.map((h, j) => (
              <th
                key={j}
                style={{
                  padding: "8px 12px",
                  minWidth: 88,
                  textAlign: alignToCss(block.align[j] ?? "default") ?? "left",
                  fontWeight: 700,
                  fontSize: 12,
                  color: "var(--ink)",
                  background: "var(--paper-2)",
                  borderBottom: "1px solid var(--paper-edge)",
                  whiteSpace: "nowrap",
                }}
                >
                  {inline(h, onOpenMedia, onOpenLinkedFile, mediaBasePaths)}
                </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, ri) => (
            <tr
              key={ri}
              style={{
                background: ri % 2 === 1 ? "var(--paper-2)" : "transparent",
              }}
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  style={{
                    padding: "8px 12px",
                    minWidth: 88,
                    textAlign: alignToCss(block.align[ci] ?? "default") ?? "left",
                    borderTop: "1px solid var(--paper-edge)",
                    color: "var(--ink)",
                    verticalAlign: "top",
                    // 가로 스크롤이 작동하도록 셀은 wrap하지 않음. 긴 셀은 스크롤로.
                    whiteSpace: "nowrap",
                  }}
                >
                  {inline(cell, onOpenMedia, onOpenLinkedFile, mediaBasePaths)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── 경량 신택스 하이라이트 (의존성 0) — 채팅 코드블록용. 언어 무관 공통 토크나이저로
// 주석/문자열/숫자/키워드/타입/함수호출만 칠한다. 부정확해도 가독성은 크게 오른다.
const CODE_KEYWORDS = new Set(
  "const let var function return if else for while do switch case break continue new throw try catch finally class extends implements import export default from as async await yield typeof instanceof void delete this super null true false undefined def lambda pass elif except raise with global nonlocal fn pub use mut impl struct enum match trait where type interface package func go defer chan range nil and or not is None True False then end local".split(
    /\s+/,
  ),
);
const CODE_TOKEN =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\w.]*)|([A-Za-z_$][\w$]*)/g;
function highlightCode(code: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  CODE_TOKEN.lastIndex = 0;
  while ((m = CODE_TOKEN.exec(code)) !== null) {
    if (m.index > last) out.push(code.slice(last, m.index));
    let color: string | undefined;
    if (m[1]) color = "var(--muted-deep)"; // 주석
    else if (m[2]) color = "var(--ok)"; // 문자열
    else if (m[3]) color = "var(--warn)"; // 숫자
    else if (m[4]) {
      const id = m[4];
      if (CODE_KEYWORDS.has(id)) color = "var(--info)"; // 키워드
      else if (/^[A-Z]/.test(id)) color = "var(--info)"; // 타입/클래스
      else if (code[m.index + id.length] === "(") color = "var(--info)"; // 함수 호출
    }
    out.push(color ? <span key={k++} style={{ color }}>{m[0]}</span> : m[0]);
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function CodeBlock({
  block,
  onOpen,
  t,
}: {
  block: { type: "code"; lang: string; code: string; id: string };
  onOpen?: (a: CodeArtifact) => void;
  t?: ReturnType<typeof useT>["t"];
}) {
  const linesCount = block.code.split("\n").length;
  const label = (key: Parameters<NonNullable<typeof t>>[0], vars?: Record<string, string | number>) =>
    t ? t(key, vars) : String(vars?.count ?? "");
  /*
   * ★복사 단추가 **아무 말도 하지 않았다** (실측 2026-09-08): 눌러도 표시가 없고,
   *   실패해도 조용했다. 코드 복사는 이 제품에서 가장 자주 누르는 단추 중 하나다 —
   *   됐는지 안 됐는지 모르면 사람은 한 번 더 누르고, 그래도 모른다.
   */
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed">("idle");
  /* 이 컴포넌트는 locale 을 받지 않는다 — 문서 언어를 본다(전역 i18n 이 <html lang> 을 맞춘다). */
  const ko = typeof document !== "undefined" && (document.documentElement.lang || "").toLowerCase().startsWith("ko");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.code);
      setCopyState("done");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1800);
  };
  return (
    <div
      style={{
        margin: "8px 0",
        border: "none",
        borderRadius: 0,
        overflow: "hidden",
        background: "var(--paper-2)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 0",
          background: "transparent",
          borderBottom: "1px solid var(--paper-3)",
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--ink-soft)",
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          {block.lang}
        </span>
        <span style={{ fontSize: 10, color: "var(--muted-deep)" }}>· {label("chatstream.lines", { count: linesCount })}</span>
        <div style={{ flex: 1 }} />
        {onOpen && (
          <button
            onClick={() =>
              onOpen({ id: block.id, language: block.lang, code: block.code })
            }
            style={{
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 5,
              background: "transparent",
              color: "var(--ink-soft)",
              border: "none",
              fontWeight: 600,
            }}
            title={label("chatstream.open_panel")}
          >
            {label("chatstream.panel")}
          </button>
        )}
        <button
          onClick={() => void copy()}
          aria-live="polite"
          style={{
            fontSize: 10,
            padding: "2px 8px",
            borderRadius: 5,
            background: "transparent",
            color: copyState === "failed" ? "var(--danger)" : "var(--ink-soft)",
            border: "none",
            fontWeight: 600,
          }}
        >
          {copyState === "done"
            ? (ko ? "복사됨" : "Copied")
            : copyState === "failed"
              ? (ko ? "복사 실패" : "Copy failed")
              : label("chatstream.copy")}
        </button>
      </div>
      <div style={{ display: "flex", minWidth: 0 }}>
        <div
          aria-hidden
          style={{
            flex: "none",
            padding: "12px 12px 12px 14px",
            textAlign: "right",
            userSelect: "none",
            color: "var(--muted-deep)",
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            lineHeight: 1.55,
            whiteSpace: "pre",
          }}
        >
          {Array.from({ length: linesCount }, (_, i) => i + 1).join("\n")}
        </div>
        <pre
          style={{
            margin: 0,
            padding: "12px 14px 12px 4px",
            color: "var(--ink)",
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            lineHeight: 1.55,
            overflowX: "auto",
            whiteSpace: "pre",
            flex: 1,
            /*
             * ★minWidth 없이는 overflowX:auto 가 **아무 일도 하지 않는다** (실측 2026-09-08).
             *   flex 항목의 자동 최소 크기는 min-content 라, 긴 코드 한 줄이 그대로
             *   상자를 밀어낸다. One 에서 코드 블록이 대화 열 밖으로 1,971px 나갔고
             *   가로 스크롤도 없어 그 뒤는 읽을 방법이 없었다.
             */
            minWidth: 0,
          }}
        >
          {highlightCode(block.code)}
        </pre>
      </div>
    </div>
  );
}

// ── 인라인 마크다운: code, bold, italic, link ─────────────────
function inline(
  text: string,
  onOpenMedia?: (a: MediaArtifact) => void,
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void,
  mediaBasePaths: string[] = [],
): React.ReactNode {
  // 토큰화 — `code` > **bold** > *italic* > [text](url) 순서대로 처리
  const out: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  // matchers를 while 루프 밖으로 끌어올림 — 매 반복마다 정규식 객체를 재생성하던 비용 제거.
  // render는 key(증가)·onOpenMedia를 클로저로 참조하므로 모듈 상수가 아닌 호출당 1회만 만든다(동작 동일).
  const matchers: Array<{
    regex: RegExp;
    render: (m: RegExpMatchArray) => React.ReactNode;
  }> = [
      {
        // 이미지: ![alt](src) — http/https/data는 그대로, 로컬 경로는 agentlas://localfile로 서빙
        regex: /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
        render: (m) => renderInlineImage(key++, m[2].trim(), m[1], onOpenMedia, mediaBasePaths),
      },
      {
        // 모델/CLI가 "created at /abs/path.png"처럼 plain path만 답해도 즉시 이미지로 보여준다.
        regex: /^((?:file:\/\/[^\s`'"<>)]*?|\/[^\s`'"<>)]*?|(?:\.{1,2}\/)?[A-Za-z0-9_. -]+(?:\/[^\s`'"<>)]*)?)\.(?:png|jpe?g|gif|webp|avif|svg))(?=$|[\s).,;:])/i,
        render: (m) => renderInlineImage(key++, m[1].trim(), imageNameFromSrc(m[1], mediaBasePaths), onOpenMedia, mediaBasePaths),
      },
      {
        /*
         * 인라인 수식 `$...$`. 인라인 코드보다 **뒤에** 둘 수 없어(먼저 매칭돼야 코드 안의
         * $ 가 보호된다) 여기 두되, 판정을 좁게 한다:
         *   - 여는 $ 뒤와 닫는 $ 앞에 공백이 없어야 한다
         *   - 안에 개행이 없어야 한다
         *   - 수식에 쓰이는 글자(\ ^ _ { } 등)나 숫자·연산자가 하나는 있어야 한다
         * 이 제약이 없으면 "$100 에서 $200 으로" 같은 평범한 문장이 통째로 수식이 된다.
         * 실제로 그 오탐이 금액을 지워 버리는 쪽이 수식을 못 그리는 것보다 나쁘다.
         */
        regex: /^\$(?!\s)((?:[^$\n]|\\\$){1,200}?)(?<!\s)\$(?!\d)/,
        render: (m) => {
          const tex = m[1];
          const body = tex.trim();
          const looksMath =
            // 연산자·중괄호·백슬래시 명령이 있으면 수식이다.
            /[\\^_{}=+\-*/<>]|\\[a-zA-Z]+/.test(body)
            // 짧은 변수 하나도 수식이다($m$, $x_1$ 이전 형태, 그리스 문자 포함).
            // 숫자로 시작하는 것은 제외한다 — 그쪽은 거의 항상 금액이다.
            || /^[A-Za-z\u0370-\u03FF][A-Za-z0-9\u0370-\u03FF]{0,2}$/.test(body);
          if (!looksMath) return <span key={key++}>{`$${tex}$`}</span>;
          return <MathSpan key={key++} tex={tex} display={false} />;
        },
      },
      {
        regex: /^`([^`]+)`/,
        render: (m) => {
          const codeText = m[1].trim();
          if (isImageLikePath(codeText)) {
            return renderInlineImage(key++, codeText, imageNameFromSrc(codeText, mediaBasePaths), onOpenMedia, mediaBasePaths);
          }
          return (
            <code
              key={key++}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.9em",
                padding: "1px 5px",
                borderRadius: 4,
                background: "var(--fill-1)",
                color: "var(--accent)",
              }}
            >
              {m[1]}
            </code>
          );
        },
      },
      {
        regex: /^\*\*([^*]+)\*\*/,
        render: (m) => (
          <strong key={key++} style={{ fontWeight: 700 }}>
            {m[1]}
          </strong>
        ),
      },
      {
        regex: /^\*([^*]+)\*/,
        render: (m) => (
          <em key={key++} style={{ fontStyle: "italic" }}>
            {m[1]}
          </em>
        ),
      },
      {
        regex: /^\[([^\]]+)\]\(([^)]+)\)/,
        render: (m) => renderInlineLink(key++, m[1], m[2].trim(), onOpenLinkedFile, mediaBasePaths),
      },
      {
        /*
         * ★맨 주소도 눌러서 열려야 한다 (실측 2026-09-08: 대화에 http 주소를 넣어도
         *   링크가 **하나도 안 만들어졌다**). 모델은 마크다운 링크보다 맨 주소를 훨씬
         *   자주 쓴다 — 그때마다 사용자가 주소를 손으로 복사해야 했다.
         *   ★끝의 문장부호는 주소에서 뺀다: "…/link." 의 마침표까지 삼키면 열리지 않는다.
         */
        regex: /^(https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?])/i,
        render: (m) => renderInlineLink(key++, m[1], m[1], onOpenLinkedFile, mediaBasePaths),
      },
    ];

  while (remaining.length > 0) {
    let matched = false;
    for (const { regex, render } of matchers) {
      const m = remaining.match(regex);
      if (m) {
        out.push(render(m));
        remaining = remaining.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    /*
     * 다음 특수 문자 위치 (! 는 이미지 ![]() 시작용, $ 는 수식).
     *
     * ★여기에 문자를 빠뜨리면 그 문법은 **영영 매칭되지 않는다.** 위 matcher 목록에
     * 수식을 추가하고도 화면에 안 나왔던 이유가 이것이다: 커서가 `$` 로 점프하지 못해
     * matcher 가 시험조차 되지 않았다. 목록과 점프표는 함께 움직여야 한다.
     */
    /* ★맨 주소 matcher 를 넣었으므로 점프표에도 https? 를 함께 넣는다(같은 함정 재발 방지). */
    const next = remaining.search(/file:|https?:\/\/|[`*![\/$]|(?:^|[\s(])(?:\.{1,2}\/)?[A-Za-z0-9_. -]+(?:\/[^\s`'"<>)]*)?\.(?:png|jpe?g|gif|webp|avif|svg)/i);
    if (next < 0) {
      out.push(remaining);
      break;
    }
    if (next === 0) {
      // 매칭 실패한 특수문자 — 그대로
      out.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      out.push(remaining.slice(0, next));
      remaining = remaining.slice(next);
    }
  }
  return out;
}

/** 산출물 자동 패널 오픈용 — 답변 텍스트에서 첫 이미지 산출물을 찾아 MediaArtifact로 만든다.
 *  renderInlineImage와 동일한 매칭(마크다운 이미지 + plain 로컬 이미지 경로)을 전역 1회 수행.
 *  final 답변에 산출물이 있으면 챗 페이지가 우측 패널을 자동으로 열어 보여준다. */
export function firstMediaArtifactInText(text: string, mediaBasePaths: string[] = []): MediaArtifact | null {
  const resolvedMediaBasePaths = mediaBasePathsWithTextHints(text, mediaBasePaths);
  const mdImg = text.match(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
  const plain = text.match(
    /(?:file:\/\/[^\s`'"<>)]*?|\/[^\s`'"<>)]*?|(?:\.{1,2}\/)?[A-Za-z0-9_. -]+(?:\/[^\s`'"<>)]*)?)\.(?:png|jpe?g|gif|webp|avif|svg)(?=$|[\s).,;:])/i,
  );
  const codeImage = text.match(/`([^`]+\.(?:png|jpe?g|gif|webp|avif|svg))`/i);
  let rawSrc: string | null = null;
  let alt = "";
  const mdIdx = mdImg?.index ?? Number.POSITIVE_INFINITY;
  const plainIdx = plain?.index ?? Number.POSITIVE_INFINITY;
  const codeIdx = codeImage?.index ?? Number.POSITIVE_INFINITY;
  if (mdImg && mdIdx <= plainIdx && mdIdx <= codeIdx) {
    alt = mdImg[1];
    rawSrc = mdImg[2].trim();
  } else if (codeImage && codeIdx <= plainIdx) {
    rawSrc = codeImage[1].trim();
  } else if (plain) {
    rawSrc = plain[0].trim();
  }
  if (!rawSrc) return null;
  return mediaArtifactFromImage(rawSrc, alt, resolvedMediaBasePaths);
}

export function linkedFileArtifactsInText(text: string, mediaBasePaths: string[] = []): LinkedFileArtifact[] {
  const resolvedMediaBasePaths = mediaBasePathsWithTextHints(text, mediaBasePaths);
  const out: LinkedFileArtifact[] = [];
  const seen = new Set<string>();
  for (const ref of localFileRefsFromText(text)) {
    const artifact = linkedFileArtifactFromRef(ref, "", resolvedMediaBasePaths);
    const key = artifact.path || artifact.href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(artifact);
  }
  return out;
}

function renderInlineLink(
  key: number,
  label: string,
  rawHref: string,
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void,
  mediaBasePaths: string[] = [],
): React.ReactNode {
  const href = cleanLinkHref(rawHref);
  const localTargets = localPathsFromFileRef(href, mediaBasePaths);
  const isLocalFile = localTargets.length > 0 || looksLikeLocalFileRef(href);
  const isHttpLink = /^https?:\/\//iu.test(href);
  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!isLocalFile && !isHttpLink) return;
    event.preventDefault();
    event.stopPropagation();
    if (onOpenLinkedFile) {
      onOpenLinkedFile(linkedFileArtifactFromRef(href, label, mediaBasePaths));
      return;
    }
    // A link without a scoped owner cannot choose an unrelated task panel.
    // Keep the default navigation prevented; there is no OS-open fallback.
  };
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={handleClick}
      style={{ color: "var(--accent)", textDecoration: "underline", cursor: (isLocalFile || isHttpLink) ? "pointer" : undefined }}
      title={isLocalFile && localTargets[0] ? localTargets[0] : href}
    >
      {label}
    </a>
  );
}

function linkedFileArtifactFromRef(rawRef: string, label: string, mediaBasePaths: string[]): LinkedFileArtifact {
  const href = cleanLinkHref(rawRef);
  const paths = localPathsFromFileRef(href, mediaBasePaths);
  const path = paths[0];
  return {
    id: `file:${path || href}`,
    name: label || fileNameFromRef(path || href),
    href,
    path,
    paths,
    fileUrl: fileUrlForLinkedFile(path || href),
  };
}

function renderInlineImage(
  key: number,
  rawSrc: string,
  alt: string,
  onOpenMedia?: (a: MediaArtifact) => void,
  mediaBasePaths: string[] = [],
): React.ReactNode {
  return <InlineChatImage key={key} rawSrc={rawSrc} alt={alt} onOpenMedia={onOpenMedia} mediaBasePaths={mediaBasePaths} />;
}

/**
 * 채팅 인라인 이미지 — 로드 실패는 빈 박스가 아니라 정직한 에러 카드로 보인다.
 *
 * 배경(2026-08-18 오너 제보): 캡처 파일이 없거나 agentlas://localfile 허용 루트 밖이면
 * 프로토콜이 404를 내는데, onError 없는 <img> 는 테두리만 있는 "빈 이미지"로 렌더됐다.
 * One(OneShell)·Work(ChatStream) 둘 다 이 컴포넌트를 지나므로 여기 한 곳이 정본이다.
 */
function InlineChatImage({
  rawSrc,
  alt,
  onOpenMedia,
  mediaBasePaths,
}: {
  rawSrc: string;
  alt: string;
  onOpenMedia?: (a: MediaArtifact) => void;
  mediaBasePaths: string[];
}) {
  const { locale } = useT();
  const [failed, setFailed] = useState(false);
  const media = mediaArtifactFromImage(rawSrc, alt, mediaBasePaths);
  const { src, name } = media;
  if (failed) {
    const ko = locale === "ko";
    return (
      <span
        role="img"
        aria-label={name}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          margin: "8px 0",
          padding: "10px 12px",
          borderRadius: "var(--radius-md)",
          border: "1px dashed var(--paper-edge)",
          background: "color-mix(in srgb, var(--paper) 88%, transparent)",
          color: "var(--muted-deep)",
          fontSize: 12,
          lineHeight: 1.45,
          maxWidth: "100%",
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 15, flexShrink: 0 }}>⚠︎</span>
        <span style={{ minWidth: 0 }}>
          <strong style={{ display: "block", color: "var(--ink)" }}>
            {ko ? "이미지 파일을 찾을 수 없습니다" : "Image file is missing"}
          </strong>
          <span style={{ display: "block", overflowWrap: "anywhere" }}>
            {media.path || rawSrc}
          </span>
        </span>
      </span>
    );
  }
  const image = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name}
      onError={() => setFailed(true)}
      style={{
        display: "block",
        maxWidth: "100%",
        maxHeight: 420,
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--paper-edge)",
        margin: "8px 0",
        objectFit: "contain",
      }}
    />
  );
  if (!onOpenMedia) return image;
  return (
    <button
      type="button"
      onClick={() => onOpenMedia(media)}
      title={name}
      style={{
        display: "block",
        maxWidth: "100%",
        padding: 0,
        border: "none",
        background: "transparent",
        cursor: "zoom-in",
        textAlign: "left",
      }}
    >
      {image}
    </button>
  );
}

function mediaArtifactFromImage(rawSrc: string, alt: string, mediaBasePaths: string[] = []): MediaArtifact {
  const src = normalizeImageSrc(rawSrc, mediaBasePaths);
  const paths = localPathsFromImageSrc(rawSrc, mediaBasePaths);
  return {
    id: `media:${src}`,
    kind: "image",
    src,
    path: paths[0],
    paths,
    name: alt || imageNameFromSrc(rawSrc, mediaBasePaths),
  };
}

/** 이미지 src 정규화 — 원격(http/data)은 그대로, 로컬 절대경로·file://는 커스텀 프로토콜로 서빙.
 *  (webSecurity:true라 file:// 직접 로드는 차단되므로 agentlas://localfile 경유.) */
function normalizeImageSrc(src: string, mediaBasePaths: string[] = []): string {
  if (/^(https?:|data:|agentlas:|blob:)/i.test(src)) return src;
  const local = localPathsFromFileRef(src, mediaBasePaths)[0];
  if (local) return `agentlas://localfile/?p=${encodeURIComponent(local)}`;
  return src; // 알 수 없는 상대경로 등 — 렌더 못 할 수 있음
}

function localPathFromImageSrc(src: string, mediaBasePaths: string[] = []): string | undefined {
  return localPathsFromImageSrc(src, mediaBasePaths)[0];
}

function localPathsFromImageSrc(src: string, mediaBasePaths: string[] = []): string[] {
  return localPathsFromFileRef(src, mediaBasePaths);
}

function localPathsFromFileRef(src: string, mediaBasePaths: string[] = []): string[] {
  const cleaned = cleanImageSrcCandidate(src);
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const next = value?.trim();
    if (next && !out.includes(next)) out.push(next);
  };
  if (/^agentlas:/i.test(cleaned)) {
    try {
      const url = new URL(cleaned);
      const p = url.searchParams.get("p");
      push(p || undefined);
      return out;
    } catch {
      return out;
    }
  }
  if (cleaned.startsWith("file://")) {
    try {
      push(decodeURIComponent(new URL(cleaned).pathname));
      return out;
    } catch {
      push(cleaned.replace(/^file:\/\//, ""));
      return out;
    }
  }
  if (cleaned.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cleaned)) {
    push(cleaned);
    return out;
  }
  if (looksLikeLocalFileRef(cleaned) && mediaBasePaths.length > 0) {
    for (const base of orderedBasePathsForRef(cleaned, mediaBasePaths)) push(joinLocalPath(base, cleaned));
  }
  return out;
}

function imageNameFromSrc(src: string, mediaBasePaths: string[] = []): string {
  const local = localPathFromImageSrc(src, mediaBasePaths);
  if (local) {
    const part = local.split(/[\\/]/).pop();
    if (part) return part;
  }
  if (/^https?:/i.test(src)) {
    try {
      const part = new URL(src).pathname.split("/").filter(Boolean).pop();
      if (part) return decodeURIComponent(part);
    } catch {
      // ignore
    }
  }
  return "generated image";
}

function fileNameFromRef(ref: string): string {
  const cleaned = cleanImageSrcCandidate(ref);
  if (/^https?:/i.test(cleaned)) {
    try {
      const part = new URL(cleaned).pathname.split("/").filter(Boolean).pop();
      if (part) return decodeURIComponent(part);
    } catch {
      // ignore
    }
  }
  if (cleaned.startsWith("file://")) {
    try {
      const part = decodeURIComponent(new URL(cleaned).pathname).split(/[\\/]/).filter(Boolean).pop();
      if (part) return part;
    } catch {
      // ignore
    }
  }
  const part = cleaned.split(/[\\/]/).filter(Boolean).pop();
  return part || "linked file";
}

function isImageLikePath(value: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(value.trim());
}

/** 앱 안에서 직접 렌더할 수 있는 파일 — 전용 프로토콜로 서빙해야 한다(`file://` 은 차단됨). */
function isInlineServablePath(value: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v|ogv|pdf)$/i.test(value.trim());
}

function cleanImageSrcCandidate(value: string): string {
  return value.trim().replace(/^[\s(]+/, "").replace(/[).,;:]+$/, "");
}

function cleanLinkHref(value: string): string {
  return value.trim().replace(/^<|>$/g, "");
}

const LOCAL_FILE_REF_EXT = /\.(png|jpe?g|gif|webp|avif|svg|pdf|html?|mdx?|jsonl?|txt|csv|tsv|docx?|xlsx?|pptx?|zip|mp4|webm|mov|m4v|ogv|mp3|wav|rtf|pages)$/i;

function looksLikeLocalFileRef(value: string): boolean {
  const cleaned = cleanImageSrcCandidate(value);
  if (!cleaned) return false;
  if (/^(https?:|data:|blob:|mailto:|tel:|#)/i.test(cleaned)) return false;
  if (/^agentlas:\/\/localfile\//i.test(cleaned) || cleaned.startsWith("file://")) return true;
  if (cleaned.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cleaned)) return LOCAL_FILE_REF_EXT.test(cleaned);
  return LOCAL_FILE_REF_EXT.test(cleaned) && !/^[a-z][a-z0-9+.-]*:/i.test(cleaned);
}

function orderedBasePathsForRef(ref: string, mediaBasePaths: string[]): string[] {
  const cleaned = ref.trim().replace(/^\.?[\\/]+/, "");
  const hasDirectory = /[\\/]/.test(cleaned);
  if (hasDirectory) return mediaBasePaths;
  const normalized = mediaBasePaths.map((base) => base.replace(/[\\/]+$/, ""));
  const descendantBases = normalized.filter((base) =>
    normalized.some((other) => base !== other && base.startsWith(`${other}/`)),
  );
  if (descendantBases.length === 0) return mediaBasePaths;
  const descendantSet = new Set(descendantBases);
  return [
    ...descendantBases.sort((a, b) => b.length - a.length),
    ...normalized.filter((base) => !descendantSet.has(base)),
  ];
}

function mediaBasePathsWithTextHints(text: string, mediaBasePaths: string[]): string[] {
  const out = uniqueStrings(mediaBasePaths);
  const pushDir = (value: string | undefined) => {
    const next = value?.trim().replace(/[\\/]+$/, "");
    if (next && !out.includes(next)) out.push(next);
  };
  for (const ref of localDirectoryRefsFromText(text)) {
    for (const dir of localPathsFromDirectoryRef(ref, mediaBasePaths)) pushDir(dir);
  }
  for (const ref of localFileRefsFromText(text)) {
    for (const file of localPathsFromFileRef(ref, mediaBasePaths)) pushDir(parentLocalPath(file));
  }
  return out;
}

function localFileRefsFromText(text: string): string[] {
  const refs: string[] = [];
  const push = (value: string | undefined) => {
    const next = value?.trim();
    if (next && looksLikeLocalFileRef(next) && !refs.includes(next)) refs.push(next);
  };
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) push(match[1]);
  const fileRef = /(?:^|[\s(`])((?:file:\/\/[^\s`'"<>)]*?|\/[^\s`'"<>)]*?|(?:\.{1,2}\/)?[A-Za-z0-9_. -]+(?:\/[^\s`'"<>)]*)?)\.(?:png|jpe?g|gif|webp|avif|svg|pdf|html?|mdx?|jsonl?|txt|csv|tsv|docx?|xlsx?|pptx?|zip|mp4|webm|mov|m4v|ogv|mp3|wav|rtf|pages))(?=$|[\s`).,;:])/gi;
  for (const match of text.matchAll(fileRef)) push(match[1]);
  return refs;
}

/**
 * 답변이 띄웠다고 말한 **로컬 개발 서버** 주소.
 *
 * 에이전트가 앱을 세우면 사람이 다음에 하는 일은 그걸 보는 것이다. 그런데 우리 우측
 * 패널은 로컬 *파일*만 받아서, 서버를 띄운 답변은 볼 것이 하나도 없는 것처럼 보였다
 * (다른 런타임은 이 자리에 실행 중인 앱을 그린다).
 *
 * 로컬 호스트로 한정한다 — 임의의 외부 주소를 답변만 보고 자동으로 여는 것은
 * 프롬프트 인젝션이 원격 요청을 시키는 통로가 된다. 여기서 도는 것만 그린다.
 */
export function localServerUrlsInText(text: string): string[] {
  const out: string[] = [];
  // Tool results can contain JSON-escaped newlines. A backslash terminates the
  // URL; URL() otherwise normalizes `/<backslash>nTest` into a spurious /nTest path.
  const pattern = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{2,5}))?(?:\/[^\\\s`'"<>)\]]*)?/gi;
  for (const match of text.matchAll(pattern)) {
    const url = match[0].replace(/[).,;:]+$/, "");
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

function localDirectoryRefsFromText(text: string): string[] {
  const refs: string[] = [];
  const push = (value: string | undefined) => {
    const next = value?.trim();
    if (next && looksLikeLocalDirectoryRef(next) && !refs.includes(next)) refs.push(next);
  };
  const dirRef = /(?:^|[\s(`])((?:file:\/\/[^\s`'"<>)]*?|\/[^\s`'"<>)]*?|(?:\.{1,2}\/)?[A-Za-z0-9_. -]+(?:\/[A-Za-z0-9_. -]+)+\/)(?=$|[\s`),;:]))/g;
  for (const match of text.matchAll(dirRef)) push(match[1]);
  return refs;
}

function looksLikeLocalDirectoryRef(value: string): boolean {
  const cleaned = value.trim();
  if (!cleaned || /^(https?:|data:|blob:|mailto:|tel:|#)/i.test(cleaned)) return false;
  return cleaned.endsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(cleaned.replace(/^file:\/\//i, ""));
}

function localPathsFromDirectoryRef(ref: string, mediaBasePaths: string[] = []): string[] {
  const cleaned = ref.trim().replace(/[).,;:]+$/, "");
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const next = value?.trim().replace(/[\\/]+$/, "");
    if (next && !out.includes(next)) out.push(next);
  };
  if (cleaned.startsWith("file://")) {
    try {
      push(decodeURIComponent(new URL(cleaned).pathname));
    } catch {
      push(cleaned.replace(/^file:\/\//, ""));
    }
    return out;
  }
  if (cleaned.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cleaned)) {
    push(cleaned);
    return out;
  }
  for (const base of mediaBasePaths) push(joinLocalPath(base, cleaned));
  return out;
}

function parentLocalPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (idx <= 0) return undefined;
  return clean.slice(0, idx);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const value = raw?.trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function fileUrlForLocalPath(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

function fileUrlForLinkedFile(target: string): string {
  if (/^(https?:|data:|blob:|agentlas:)/i.test(target)) return target;
  if (target.startsWith("file://")) return target;
  // 이미지·영상·PDF 는 렌더러가 직접 그린다 — `file://` 은 webSecurity 에 막히므로 전용 프로토콜로.
  if (isInlineServablePath(target)) return `agentlas://localfile/?p=${encodeURIComponent(target)}`;
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)) return fileUrlForLocalPath(target);
  return target;
}

function joinLocalPath(base: string, rel: string): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  const cleanRel = rel.trim().replace(/^\.?[\\/]+/, "");
  return `${cleanBase}/${cleanRel}`;
}
