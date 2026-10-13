"use client";

// 탐색 (Claude): featured hero carousel + bordered card grids.
// 내 항목 (ChatGPT): two-column rows with a right-side action.
import { useState, type ReactNode } from "react";
import { IconCheck, IconChevronLeft, IconChevronRight, IconMoreHorizontal, IconPlus } from "@/components/Icon";
import { IconArrowRightSmall } from "./DetailParts";
import styles from "./ToolsUi.module.css";

export interface HeroSlide { key: string; eyebrow: string; title: string; subtitle?: string; icons: ReactNode[]; onExplore: () => void }

export interface CardItem {
  key: string;
  icon: ReactNode;
  name: string;
  description?: string;
  maker?: string;
  installed: boolean;
  onOpen: () => void;
  onAdd?: () => void;
}

export function Hero({ slides, ko }: { slides: HeroSlide[]; ko: boolean }) {
  const [index, setIndex] = useState(0);
  if (!slides.length) return null;
  const at = Math.min(index, slides.length - 1);
  const slide = slides[at];
  const step = (delta: number) => setIndex((at + delta + slides.length) % slides.length);
  return <>
    <div className={styles.hero}>
      <p className={styles.heroEyebrow}>{slide.eyebrow}</p>
      <h2 className={styles.heroTitle}>{slide.title}</h2>
      {slide.subtitle && <p className={styles.heroSub}>{slide.subtitle}</p>}
      <div className={styles.heroIcons}>{slide.icons.slice(0, 6).map((icon, position) => <span key={position}>{icon}</span>)}</div>
      <button type="button" className={styles.heroCta} onClick={slide.onExplore}>{ko ? "탐색" : "Explore"}</button>
      {slides.length > 1 && <>
        <button type="button" className={styles.heroArrow} data-side="left" aria-label={ko ? "이전" : "Previous"} onClick={() => step(-1)}><IconChevronLeft size={18} /></button>
        <button type="button" className={styles.heroArrow} data-side="right" aria-label={ko ? "다음" : "Next"} onClick={() => step(1)}><IconChevronRight size={18} /></button>
      </>}
    </div>
    {slides.length > 1 && <div className={styles.dots}>{slides.map((entry, position) => <button key={entry.key} type="button" className={styles.dot} data-active={position === at} aria-label={entry.title} onClick={() => setIndex(position)} />)}</div>}
  </>;
}

export function CardSection({ id, title, items, ko, limit = 6 }: { id?: string; title: string; items: CardItem[]; ko: boolean; limit?: number }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, limit);
  return <section id={id}>
    <div className={styles.gridHead}>
      <h2 className={styles.gridTitle}>{title}<span className={styles.countPill}>{items.length}</span></h2>
      {items.length > limit && <button type="button" className={styles.seeAll} onClick={() => setAll((value) => !value)}>{all ? ko ? "접기" : "Show less" : ko ? "모두 보기" : "See all"}<IconArrowRightSmall size={14} /></button>}
    </div>
    <div className={styles.cardGrid}>
      {shown.map((item) => <div key={item.key} role="button" tabIndex={0} className={styles.itemCard} onClick={item.onOpen} onKeyDown={(event) => { if (event.key === "Enter") item.onOpen(); }}>
        {item.icon}
        <span className={styles.itemText}>
          <span className={styles.itemName}>{item.name}</span>
          {item.description && <span className={styles.itemDesc}>{item.description}</span>}
          {item.maker && <span className={styles.itemMaker}>{ko ? `제작: ${item.maker}` : `By ${item.maker}`}</span>}
        </span>
        <button type="button" className={styles.cardAction} data-installed={item.installed} aria-label={item.installed ? ko ? "설치됨" : "Installed" : ko ? "추가" : "Add"} title={item.installed ? ko ? "설치됨" : "Installed" : ko ? "추가" : "Add"}
          onClick={(event) => { event.stopPropagation(); (item.installed ? item.onOpen : item.onAdd ?? item.onOpen)(); }}>
          {item.installed ? <IconCheck size={15} /> : <IconPlus size={15} />}
        </button>
      </div>)}
    </div>
  </section>;
}

export function RowGrid({ items, ko }: { items: CardItem[]; ko: boolean }) {
  return <div className={styles.rowGrid}>
    {items.map((item) => <div key={item.key} role="button" tabIndex={0} className={styles.listRow} onClick={item.onOpen} onKeyDown={(event) => { if (event.key === "Enter") item.onOpen(); }}>
      {item.icon}
      <span className={styles.rowText}><span className={styles.rowName}>{item.name}</span>{item.description && <span className={styles.rowSub}>{item.description}</span>}</span>
      <button type="button" className={styles.listRowAction} data-installed={item.installed} aria-label={item.installed ? ko ? "관리" : "Manage" : ko ? "추가" : "Add"} onClick={(event) => { event.stopPropagation(); (item.installed ? item.onOpen : item.onAdd ?? item.onOpen)(); }}>
        {item.installed ? <IconMoreHorizontal size={18} /> : <IconPlus size={18} />}
      </button>
    </div>)}
  </div>;
}
