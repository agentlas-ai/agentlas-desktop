"use client";

import { IconFilm, IconImage } from "./Icon";
import { useMediaDisplayPreferences, type MediaDisplayKind } from "@/lib/media-display-preferences";
import styles from "./MediaDisplaySettings.module.css";

const OPTIONS: Array<{ kind: MediaDisplayKind; ko: string; en: string; detailKo: string; detailEn: string }> = [
  { kind: "image", ko: "사진", en: "Photos", detailKo: "결과 영역에 이미지를 표시합니다.", detailEn: "Show images in result areas." },
  { kind: "video", ko: "영상", en: "Videos", detailKo: "결과 영역에 영상을 표시합니다.", detailEn: "Show videos in result areas." },
  { kind: "audio", ko: "음성", en: "Audio", detailKo: "결과 영역에 음성 플레이어를 표시합니다.", detailEn: "Show audio players in result areas." },
];

function KindIcon({ kind }: { kind: MediaDisplayKind }) {
  if (kind === "image") return <IconImage size={16} />;
  if (kind === "video") return <IconFilm size={16} />;
  return <span aria-hidden="true" className={styles.audioGlyph}>◖</span>;
}

export function MediaDisplaySettings({ locale, compact = false }: { locale: string; compact?: boolean }) {
  const ko = locale === "ko";
  const { preferences, setPreference } = useMediaDisplayPreferences();
  return (
    <section className={styles.root} data-compact={compact ? "true" : "false"}>
      <div className={styles.heading}>
        <div>
          <h2>{ko ? "결과 미디어" : "Result media"}</h2>
          <p>{ko ? "Work와 One의 결과 영역에서 사진·영상·음성을 보이거나 숨깁니다." : "Choose which photos, videos, and audio appear in Work and One result areas."}</p>
        </div>
      </div>
      <div className={styles.list} role="group" aria-label={ko ? "결과 미디어 표시 설정" : "Result media display settings"}>
        {OPTIONS.map((option) => {
          const visible = preferences[option.kind];
          return (
            <div className={styles.row} key={option.kind}>
              <span className={styles.icon} aria-hidden="true"><KindIcon kind={option.kind} /></span>
              <span className={styles.copy}><strong>{ko ? option.ko : option.en}</strong><small>{ko ? option.detailKo : option.detailEn}</small></span>
              <button
                type="button"
                role="switch"
                aria-checked={visible}
                aria-label={`${ko ? option.ko : option.en} ${ko ? "사이드바에서 표시" : "show in sidebar"}`}
                className={styles.switch}
                data-on={visible ? "true" : "false"}
                onClick={() => setPreference(option.kind, !visible)}
              >
                <span />
              </button>
            </div>
          );
        })}
      </div>
      <p className={styles.note}>{ko ? "기본값은 모두 표시입니다. 끄면 결과 미리보기에서 해당 미디어만 숨겨집니다." : "All media is shown by default. Turning a switch off hides only that media type from result previews."}</p>
    </section>
  );
}
