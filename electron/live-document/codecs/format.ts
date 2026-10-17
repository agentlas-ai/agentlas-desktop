import type { LiveFormat, LiveFormatPatch } from "../../../shared/live-document";
import { createElement, elements, localName, markDirty, type XmlElement } from "../xml-lite";

/*
 * Shared helpers for writing LiveFormat into office XML: schema-ordered child insertion (Word and Hancom reject
 * property children out of sequence), colour conversions and format diffing.
 */

/** Inserts `child` into `parent` before the first existing child whose local name comes later in `order`. */
export function insertOrdered(parent: XmlElement, child: XmlElement, order: readonly string[]): void {
  const rank = order.indexOf(localName(child));
  const at = parent.children.findIndex((node) => node.type === "el" && order.indexOf(localName(node)) > rank);
  if (at < 0) parent.children.push(child); else parent.children.splice(at, 0, child);
  parent.selfClosing = false;
  markDirty(parent);
}

export function removeChildren(parent: XmlElement, ...names: string[]): void {
  const before = parent.children.length;
  parent.children = parent.children.filter((node) => node.type !== "el" || !names.includes(localName(node)));
  if (parent.children.length !== before) markDirty(parent);
}

export function firstChild(parent: XmlElement, name: string): XmlElement | undefined {
  return elements(parent).find((el) => localName(el) === name);
}

/** What changed from `before` to `after`: new values, and null for an explicit value that was removed. */
export function formatDelta(before: LiveFormat | undefined, after: LiveFormat | undefined): LiveFormatPatch {
  const delta: Record<string, unknown> = {};
  for (const key of Object.keys(after ?? {}) as Array<keyof LiveFormat>) {
    if (after![key] !== undefined && after![key] !== before?.[key]) delta[key] = after![key];
  }
  for (const key of Object.keys(before ?? {}) as Array<keyof LiveFormat>) {
    if (before![key] !== undefined && after?.[key] === undefined) delta[key] = null;
  }
  return delta as LiveFormatPatch;
}

export const isEmptyFormat = (format: LiveFormat | LiveFormatPatch): boolean => Object.keys(format).length === 0;

export const hex6 = (color: string): string => color.replace(/^#/, "").toUpperCase();

export function normColor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.replace(/^#/, "");
  if (/^[0-9a-fA-F]{8}$/.test(value)) return `#${value.slice(2).toLowerCase()}`; // ARGB
  if (/^[0-9a-fA-F]{6}$/.test(value)) return `#${value.toLowerCase()}`;
  return undefined;
}

export function el(markup: string): XmlElement {
  return createElement(markup);
}
