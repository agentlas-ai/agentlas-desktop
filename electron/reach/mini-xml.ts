// A small tolerant XML reader for the two XML formats Reach meets: AppleScript dictionaries (sdef) and D-Bus introspection.
// Both are element-and-attribute documents; neither needs namespaces, schemas or entity definitions, so a dependency is not
// worth loading into the daemon. Bounded on purpose: apps ship these files, the files are data, not trusted code.

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

export class XmlParseError extends Error {
  constructor(public readonly code: "xml-empty" | "xml-too-deep" | "xml-too-large" | "xml-no-root", message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

const MAX_DEPTH = 128;
const MAX_ELEMENTS = 1_500_000;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

// End of a start tag, skipping '>' inside quoted attribute values.
function findTagEnd(source: string, from: number): number {
  let quote = "";
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

export function parseXml(source: string): XmlElement {
  if (!source || !source.trim()) throw new XmlParseError("xml-empty", "The document is empty.");
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let elements = 0;
  let i = 0;
  const length = source.length;
  while (i < length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) {
      const top = stack[stack.length - 1];
      const raw = source.slice(i, lt);
      if (raw.trim()) top.text += decodeEntities(raw.trim());
    }
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      i = end < 0 ? length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      const body = source.slice(lt + 9, end < 0 ? length : end);
      stack[stack.length - 1].text += body.trim();
      i = end < 0 ? length : end + 3;
      continue;
    }
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      i = end < 0 ? length : end + 2;
      continue;
    }
    if (source.startsWith("<!", lt)) {
      // DOCTYPE, possibly with an internal subset in [...]. Entity definitions are deliberately not honored.
      let depth = 0;
      let j = lt + 2;
      for (; j < length; j += 1) {
        const ch = source[j];
        if (ch === "[") depth += 1;
        else if (ch === "]") depth -= 1;
        else if (ch === ">" && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (source[lt + 1] === "/") {
      const end = source.indexOf(">", lt + 2);
      const name = source.slice(lt + 2, end < 0 ? length : end).trim();
      for (let s = stack.length - 1; s > 0; s -= 1) {
        if (stack[s].name === name) {
          stack.length = s;
          break;
        }
      }
      i = end < 0 ? length : end + 1;
      continue;
    }
    const end = findTagEnd(source, lt + 1);
    if (end < 0) break;
    let inner = source.slice(lt + 1, end);
    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    const nameMatch = /^[^\s/>]+/.exec(inner);
    if (!nameMatch) {
      i = end + 1;
      continue;
    }
    elements += 1;
    if (elements > MAX_ELEMENTS) throw new XmlParseError("xml-too-large", "The document has too many elements.");
    const element: XmlElement = { name: nameMatch[0], attrs: parseAttributes(inner.slice(nameMatch[0].length)), children: [], text: "" };
    stack[stack.length - 1].children.push(element);
    if (!selfClosing) {
      if (stack.length > MAX_DEPTH) throw new XmlParseError("xml-too-deep", "The document is nested too deeply.");
      stack.push(element);
    }
    i = end + 1;
  }
  const first = root.children[0];
  if (!first) throw new XmlParseError("xml-no-root", "The document has no root element.");
  return first;
}

export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

export function firstChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}
