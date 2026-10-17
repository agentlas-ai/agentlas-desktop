/*
 * Minimal source-preserving XML tree for office part patching.
 *
 * Every node remembers the exact source slice it came from. Serialising a node nobody touched returns that slice
 * byte-for-byte, so a save rewrites only the paragraphs, cells and shapes that changed and leaves every attribute,
 * namespace declaration and unknown extension of the original part as it was. Not a validating parser: it accepts
 * the well-formed XML office producers write (declarations, comments, CDATA, processing instructions).
 */

export interface XmlText {
  type: "text";
  src: string;
  start: number;
  end: number;
  /** Replacement raw (already escaped) text. */
  raw?: string;
}

export interface XmlElement {
  type: "el";
  name: string;
  src: string;
  start: number;
  end: number;
  /** Raw attribute source of the opening tag (without the name), e.g. ` w:val="1"`. */
  attrs: string;
  selfClosing: boolean;
  children: XmlNode[];
  /** Set when attrs or children changed: the node is re-rendered instead of copied. */
  dirty?: boolean;
}

export interface XmlOther {
  type: "other";
  src: string;
  start: number;
  end: number;
}

export type XmlNode = XmlElement | XmlText | XmlOther;

export interface XmlDocument {
  src: string;
  /** Top-level nodes: prolog, root element, trailing whitespace. */
  nodes: XmlNode[];
  root: XmlElement;
}

function fail(message: string, at: number): never {
  throw new Error(`xml_parse_failed: ${message} at ${at}`);
}

export function parseXml(src: string): XmlDocument {
  const nodes = parseNodes(src, 0, src.length, null);
  const root = nodes.find((node): node is XmlElement => node.type === "el");
  if (!root) fail("no root element", 0);
  return { src, nodes, root };
}

/** Parses a fragment (one or more sibling elements) into standalone nodes. */
export function parseXmlFragment(src: string): XmlNode[] {
  return parseNodes(src, 0, src.length, null);
}

function parseNodes(src: string, from: number, to: number, parent: XmlElement | null): XmlNode[] {
  const out: XmlNode[] = [];
  const stack: XmlElement[] = [];
  const push = (node: XmlNode) => { (stack.length ? stack[stack.length - 1].children : out).push(node); };
  let i = from;
  while (i < to) {
    const lt = src.indexOf("<", i);
    if (lt < 0 || lt >= to) {
      if (i < to) push({ type: "text", src, start: i, end: to });
      break;
    }
    if (lt > i) push({ type: "text", src, start: i, end: lt });
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) fail("unterminated comment", lt);
      push({ type: "other", src, start: lt, end: end + 3 });
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) fail("unterminated CDATA", lt);
      push({ type: "other", src, start: lt, end: end + 3 });
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) fail("unterminated processing instruction", lt);
      push({ type: "other", src, start: lt, end: end + 2 });
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", lt)) {
      const end = src.indexOf(">", lt + 2);
      if (end < 0) fail("unterminated declaration", lt);
      push({ type: "other", src, start: lt, end: end + 1 });
      i = end + 1;
      continue;
    }
    if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt + 2);
      if (end < 0) fail("unterminated end tag", lt);
      const name = src.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) fail(`mismatched </${name}>`, lt);
      open.end = end + 1;
      i = end + 1;
      continue;
    }
    // Opening tag: scan to the closing '>' outside quotes.
    let j = lt + 1;
    let quote = "";
    while (j < to) {
      const ch = src[j];
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === "\"" || ch === "'") quote = ch;
      else if (ch === ">") break;
      j++;
    }
    if (j >= to) fail("unterminated start tag", lt);
    const selfClosing = src[j - 1] === "/";
    const inner = src.slice(lt + 1, selfClosing ? j - 1 : j);
    const nameEnd = inner.search(/[\s]/);
    const name = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
    const attrs = nameEnd < 0 ? "" : inner.slice(nameEnd);
    const element: XmlElement = { type: "el", name, src, start: lt, end: j + 1, attrs, selfClosing, children: [] };
    push(element);
    if (!selfClosing) stack.push(element);
    i = j + 1;
  }
  if (stack.length) fail(`unclosed <${stack[stack.length - 1].name}>`, stack[stack.length - 1].start);
  void parent;
  return out;
}

export function serializeNode(node: XmlNode): string {
  if (node.type === "text") return node.raw ?? node.src.slice(node.start, node.end);
  if (node.type === "other") return node.src.slice(node.start, node.end);
  if (!node.dirty) return node.src.slice(node.start, node.end);
  if (node.children.length === 0 && node.selfClosing) return `<${node.name}${node.attrs}/>`;
  return `<${node.name}${node.attrs}>${node.children.map(serializeNode).join("")}</${node.name}>`;
}

export function serializeXml(doc: XmlDocument): string {
  return doc.nodes.map(serializeNode).join("");
}

/** Marks an element (and so its re-render) dirty. Ancestors must be marked by the caller via markPath. */
export function markDirty(...elements: XmlElement[]): void {
  for (const element of elements) {
    element.dirty = true;
    element.selfClosing = element.selfClosing && element.children.length === 0;
  }
}

export function elements(parent: XmlElement, name?: string): XmlElement[] {
  return parent.children.filter((node): node is XmlElement => node.type === "el" && (name === undefined || node.name === name));
}

export function firstElement(parent: XmlElement, name: string): XmlElement | undefined {
  return parent.children.find((node): node is XmlElement => node.type === "el" && node.name === name);
}

/** Depth-first descendants with the given name (does not descend into matches). */
export function descendants(parent: XmlElement, name: string, options: { into?: boolean } = {}): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (element: XmlElement) => {
    for (const child of element.children) {
      if (child.type !== "el") continue;
      if (child.name === name) {
        out.push(child);
        if (options.into) walk(child);
      } else walk(child);
    }
  };
  walk(parent);
  return out;
}

/** Path from root to target (inclusive) so every ancestor can be re-rendered after a deep change. */
export function pathTo(root: XmlElement, target: XmlElement): XmlElement[] | null {
  if (root === target) return [root];
  for (const child of root.children) {
    if (child.type !== "el") continue;
    const found = pathTo(child, target);
    if (found) return [root, ...found];
  }
  return null;
}

export function markPath(root: XmlElement, target: XmlElement): void {
  const path = pathTo(root, target);
  if (path) markDirty(...path);
}

const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function attr(element: XmlElement, name: string): string | undefined {
  ATTR_RE.lastIndex = 0;
  for (let match = ATTR_RE.exec(element.attrs); match; match = ATTR_RE.exec(element.attrs)) {
    if (match[1] === name) return decodeXml(match[3] ?? match[4] ?? "");
  }
  return undefined;
}

export function setAttr(element: XmlElement, name: string, value: string | null): void {
  const encoded = value === null ? null : escapeXmlAttr(value);
  let found = false;
  const withSpace = /(\s*)([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  const next = element.attrs.replace(withSpace, (whole, space: string, key: string) => {
    if (key !== name) return whole;
    found = true;
    return encoded === null ? "" : `${space}${key}="${encoded}"`;
  });
  element.attrs = found ? next : encoded === null ? next : `${next} ${name}="${encoded}"`;
  element.dirty = true;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

export function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

export function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

/** Decoded concatenation of every text node under the element. */
export function textContent(node: XmlNode): string {
  if (node.type === "text") return decodeXml(node.raw ?? node.src.slice(node.start, node.end));
  if (node.type === "other") {
    const raw = node.src.slice(node.start, node.end);
    return raw.startsWith("<![CDATA[") ? raw.slice(9, -3) : "";
  }
  return node.children.map(textContent).join("");
}

/** Creates a standalone element from markup (one element). */
export function createElement(markup: string): XmlElement {
  const nodes = parseXmlFragment(markup).filter((node): node is XmlElement => node.type === "el");
  if (nodes.length !== 1) throw new Error("createElement expects exactly one element");
  return nodes[0];
}

/** Deep copy through serialisation; the copy is a clean (not dirty) standalone node. */
export function cloneElement(element: XmlElement): XmlElement {
  return createElement(serializeNode(element));
}

/** Local name without the namespace prefix. */
export function localName(element: XmlElement): string {
  const colon = element.name.indexOf(":");
  return colon < 0 ? element.name : element.name.slice(colon + 1);
}
