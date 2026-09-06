"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import styles from "./CodeIdeViewer.module.css";

const KEYWORDS = new Set(
  `const let var function return if else for while do switch case break continue new throw try catch finally class extends implements import export default from as async await yield typeof instanceof void delete this super null true false undefined def lambda pass elif except with global nonlocal fn pub use mut impl struct enum match trait where type interface package func go defer chan range nil and or not is None True False then end local SELECT FROM WHERE INSERT UPDATE DELETE CREATE TABLE ALTER BEGIN COMMIT ROLLBACK async await public private protected static final override fun val var when object data sealed package import require module end do rescue ensure echo set export unset readonly function if elif fi case esac for while in`,
);
const TOKEN = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\w.]*)|([A-Za-z_$][\w$]*)/g;

function languageFromName(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const labels: Record<string, string> = {
    js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JSX",
    ts: "TypeScript", tsx: "TSX", py: "Python", rb: "Ruby", go: "Go",
    rs: "Rust", java: "Java", kt: "Kotlin", swift: "Swift", css: "CSS",
    scss: "SCSS", html: "HTML", htm: "HTML", json: "JSON", yaml: "YAML",
    yml: "YAML", toml: "TOML", sql: "SQL", sh: "Shell", bash: "Shell", zsh: "Shell",
  };
  return (ext && labels[ext]) || ext?.toUpperCase() || "TEXT";
}

function highlight(code: string): ReactNode[] {
  const output: ReactNode[] = [];
  let last = 0;
  let key = 0;
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(code)) !== null) {
    if (match.index > last) output.push(code.slice(last, match.index));
    let color: string | undefined;
    if (match[1]) color = "var(--muted-deep)";
    else if (match[2]) color = "var(--ok)";
    else if (match[3]) color = "var(--warn)";
    else if (match[4]) {
      const word = match[4];
      if (KEYWORDS.has(word)) color = "var(--info)";
      else if (/^[A-Z]/.test(word)) color = "var(--info)";
      else if (code[match.index + word.length] === "(") color = "var(--info)";
    }
    output.push(color ? <span key={key++} style={{ color }}>{match[0]}</span> : match[0]);
    last = match.index + match[0].length;
  }
  if (last < code.length) output.push(code.slice(last));
  return output;
}

export function isCodeArtifactName(name: string): boolean {
  return /\.(?:js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|css|scss|html?|json|ya?ml|toml|sql|sh|bash|zsh|vue|svelte|xml|graphql|gql)$/i.test(name.trim());
}

export function CodeIdeViewer({
  source,
  name,
  path,
  locale,
  initialContent,
  compact = false,
  fill = false,
}: {
  source?: string;
  name: string;
  /** Workspace-relative or provider-supplied location. Never synthesize an absolute path here. */
  path?: string;
  mimeType?: string;
  locale: "ko" | "en";
  initialContent?: string;
  compact?: boolean;
  fill?: boolean;
}) {
  const displayPath = path?.trim() || name;
  const [code, setCode] = useState<string | null>(initialContent ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(initialContent == null && Boolean(source));
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (initialContent != null) {
      setCode(initialContent);
      setLoading(false);
      setError(null);
      return () => { cancelled = true; };
    }
    if (!source) {
      setCode(null);
      setLoading(false);
      setError(locale === "ko" ? "코드 소스를 찾을 수 없습니다." : "The code source is unavailable.");
      return () => { cancelled = true; };
    }
    setCode(null);
    setError(null);
    setLoading(true);
    void fetch(source, { credentials: "omit" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((value) => {
        if (cancelled) return;
        setCode(value);
        setLoading(false);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [initialContent, locale, source]);

  const lines = useMemo(() => (code ?? "").split("\n"), [code]);
  const language = languageFromName(displayPath);
  const copy = async () => {
    if (code == null) return;
    await navigator.clipboard?.writeText(code).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  };
  return (
    <section className={styles.shell} data-code-ide="true" data-fill={fill ? "true" : "false"} data-compact={compact ? "true" : "false"} aria-label={`${displayPath} ${locale === "ko" ? "코드 IDE" : "code IDE"}`}>
      <header className={styles.pathBar}>
        <strong className={styles.path} data-code-path="true" title={displayPath}>{displayPath}</strong>
        <span className={styles.language}>{language}</span>
        <span className={styles.readonly}>{locale === "ko" ? "읽기 전용" : "read only"}</span>
        <button type="button" className={styles.copy} onClick={() => void copy()} disabled={code == null}>{copied ? (locale === "ko" ? "복사됨" : "Copied") : (locale === "ko" ? "복사" : "Copy")}</button>
      </header>
      {loading && <div className={styles.loading} role="status"><span>{locale === "ko" ? "코드 불러오는 중…" : "Loading code…"}</span></div>}
      {!loading && error && <div className={styles.error} role="alert"><strong>{locale === "ko" ? "코드 IDE를 열지 못했습니다" : "Could not open the code IDE"}</strong><span>{error}</span></div>}
      {!loading && !error && code != null && <div className={styles.body}>
        <div className={styles.gutter} aria-hidden="true">{lines.map((_, index) => `${index + 1}\n`)}</div>
        <pre className={styles.code}>{highlight(code)}</pre>
      </div>}
    </section>
  );
}
