/**
 * 대화 본문 속 로컬 파일 링크(절대 경로) → 패널 파일 탭 항목. 순수 함수.
 *
 * One 에서 실행 산출물과 이름이 안 맞는 로컬 링크는 아무 데도 열리지 않았다(패널은 http(s) 만 받음, 2026-09-29 막다른 길).
 * 여기서는 렌더러가 파일을 읽지 않는다 — 바이너리는 agentlas://localfile(Main 이 루트·종류·realpath 를 확인),
 * 글자 파일은 fs.readTextFile(chat-assets 범위, 역시 Main 확인)로만 읽는다. 상대 경로·원격·폴더는 여기서 다루지 않는다.
 */
import { viewerKindForChatFile, type ChatFileItem } from "./chat-files";

export type LinkedLocalCandidate = { name?: unknown; path?: unknown; paths?: unknown; href?: unknown; fileUrl?: unknown };

const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v|ogv|mp3|mpeg|m4a|wav|ogg|oga|opus|flac|aac|weba|pdf|docx?|docm|dotx?|rtf|odt|pages|hwp|hwpx|pptx?|pptm|potx?|ppsx|odp|key|xlsx?|xlsm|xlsb|xltx?|csv|tsv|ods|numbers|zip)$/i;
const TEXT_KINDS = new Set(["markdown", "json", "text"]);

function asLocalAbsolute(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let candidate = value.trim();
  if (/^file:\/\//i.test(candidate)) {
    try { candidate = decodeURIComponent(new URL(candidate).pathname); } catch { return null; }
    if (/^\/[A-Za-z]:\//.test(candidate)) candidate = candidate.slice(1);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) && !/^[A-Za-z]:[\\/]/.test(candidate)) return null;
  if (!(candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate))) return null;
  if (candidate.split(/[\\/]/).includes("..")) return null;
  return candidate;
}

function shortHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function linkedLocalFileItem(candidate: LinkedLocalCandidate, chatId: string): { item: ChatFileItem; textPath: string | null } | null {
  const paths = [candidate.path, ...(Array.isArray(candidate.paths) ? candidate.paths : []), candidate.href, candidate.fileUrl];
  const absolute = paths.map(asLocalAbsolute).find((value): value is string => Boolean(value));
  if (!absolute) return null;
  const name = (typeof candidate.name === "string" && candidate.name.trim()) || absolute.split(/[\\/]/).pop() || absolute;
  const viewerKind = viewerKindForChatFile(name, "file");
  const isText = TEXT_KINDS.has(viewerKind);
  if (!isText && !MEDIA_EXT.test(absolute)) return null;
  const fileUrl = isText ? null : `agentlas://localfile/?p=${encodeURIComponent(absolute)}`;
  const id = `linked-${shortHash(absolute)}`;
  const item: ChatFileItem = {
    id,
    groupId: "linked-local",
    chatId,
    name,
    mediaType: "",
    size: 0,
    sha256: "",
    kind: "file",
    fileUrl,
    provenance: "linked-file",
    tabId: `chat-file:${chatId}:linked-local:${id}`,
    viewer: {
      path: absolute,
      name,
      size: 0,
      viewerKind,
      fileUrl: fileUrl ?? "",
      openTargets: fileUrl ? [fileUrl] : [],
      content: "",
      truncated: false,
      reason: isText ? "not-read" : "binary",
      available: !isText,
    },
  };
  return { item, textPath: isText ? absolute : null };
}

const ABSOLUTE_REF = /(?:^|[\s(<`'"])((?:file:\/\/)?(?:\/(?:[^\s`'"<>)\]]+\/)+|[A-Za-z]:\\(?:[^\s`'"<>)\]\\]+\\)+)[^\s`'"<>)\]\\/]+\.(?:png|jpe?g|gif|webp|avif|svg|pdf|mdx?|jsonl?|txt|csv|tsv|docx?|xlsx?|xlsm|pptx?|hwpx?|mp4|webm|mov|mp3|wav|rtf|zip))(?=$|[\s`'")>\].,;:])/gi;

/**
 * One 은 답에 보이는 절대 경로를 "[로컬 경로]" 로 가린다(고객 문구 경계 — 게이트가 지킨다). 그래서 에이전트가
 * 만든 파일을 사람이 열 길이 없었다. 가리기 전의 원문에서 파일 참조만 뽑아 **이름만** 칩으로 보인다 — 경로는
 * 화면에 안 나오고, 누르면 Main 이 확인하는 길로 패널에 열린다. 최대 8개, 같은 경로 한 번.
 */
export function localFileRefsFromText(text: string | null | undefined, limit = 8): string[] {
  if (!text || !/[\\/]/.test(text)) return [];
  const out: string[] = [];
  for (const match of text.matchAll(ABSOLUTE_REF)) {
    const absolute = asLocalAbsolute(match[1]);
    if (absolute && !out.includes(absolute)) out.push(absolute);
    if (out.length >= limit) break;
  }
  return out;
}
