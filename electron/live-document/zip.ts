import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from "fflate";

/*
 * Zip package view for OOXML and HWPX. Entry order is kept (HWPX and ODF-style readers require `mimetype` first,
 * stored), untouched entries keep their bytes, and only parts a codec replaced are re-encoded.
 */
export class ZipPackage {
  private readonly entries = new Map<string, Uint8Array>();
  private readonly order: string[] = [];

  constructor(bytes: Uint8Array) {
    const files = unzipSync(bytes);
    for (const [name, data] of Object.entries(files)) {
      this.entries.set(name, data);
      this.order.push(name);
    }
  }

  has(name: string): boolean { return this.entries.has(name); }
  names(): string[] { return [...this.order]; }

  bytes(name: string): Uint8Array | undefined { return this.entries.get(name); }

  text(name: string): string | undefined {
    const data = this.entries.get(name);
    if (!data) return undefined;
    const text = strFromU8(data);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  setText(name: string, value: string): void { this.setBytes(name, strToU8(value)); }

  setBytes(name: string, value: Uint8Array): void {
    if (!this.entries.has(name)) this.order.push(name);
    this.entries.set(name, value);
  }

  remove(name: string): void {
    if (!this.entries.delete(name)) return;
    this.order.splice(this.order.indexOf(name), 1);
  }

  toBytes(): Uint8Array {
    const files: Zippable = {};
    for (const name of this.order) {
      const data = this.entries.get(name)!;
      files[name] = [data, { level: name === "mimetype" ? 0 : 6 }];
    }
    return zipSync(files);
  }
}

/** Resolves a relationship target against the part that owns the .rels file. */
export function resolvePartPath(ownerPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = ownerPart.includes("/") ? ownerPart.slice(0, ownerPart.lastIndexOf("/")) : "";
  const parts = (base ? `${base}/${target}` : target).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

export function relsPathFor(part: string): string {
  const slash = part.lastIndexOf("/");
  return slash < 0 ? `_rels/${part}.rels` : `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}
