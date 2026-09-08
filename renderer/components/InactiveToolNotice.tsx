"use client";

/** Optional installed-tool notice, separate from key entry and action approval. */
export function InactiveToolNotice({ name, command, envKeys, locale, onEnable, onDismiss }: {
  name: string;
  command: string;
  envKeys: string[];
  locale: string;
  onEnable: () => void;
  onDismiss: () => void;
}) {
  const ko = locale === "ko";
  const actionStyle = { border: 0, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", padding: "3px 5px", textDecoration: "underline" } as const;
  return <div data-inactive-tool-notice style={{ margin: "2px 16px", color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.5, minWidth: 0 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span aria-hidden="true">○</span>
      <span style={{ overflowWrap: "anywhere" }}>{name} · {ko ? "비활성" : "Inactive"}</span>
      <button type="button" style={actionStyle} onClick={onEnable}>{ko ? "켜기" : "Enable"}</button>
      <button type="button" style={actionStyle} onClick={onDismiss}>{ko ? "나중에" : "Later"}</button>
      <details style={{ display: "contents" }}>
        <summary style={{ cursor: "pointer", padding: "3px 5px" }}>{ko ? "자세히" : "Details"}</summary>
        <div style={{ flexBasis: "100%", padding: "2px 0 6px 18px" }}>
          <div>{ko ? "켜면 다음 대화부터 이 컴퓨터에서 실행됩니다." : "Runs on this computer from the next conversation when enabled."}</div>
          <code style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{command}</code>
          {envKeys.length > 0 && <div>{ko ? "필요한 키: " : "Required keys: "}{envKeys.join(", ")}</div>}
        </div>
      </details>
    </div>
  </div>;
}
