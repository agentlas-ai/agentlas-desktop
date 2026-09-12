import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ScienceTypesetCatalogEntry } from "agentlas-science/dist/contracts/science-typeset-profile";
import { userDataPath } from "../runtime-paths";
import { probePdfLatexProfile } from "./pdflatex";
import { resolveTectonic } from "./render-pdf";

/** Discovery supplies identities, never executable paths or inferred installation success. */
export async function listScienceTypesetProfileCatalog(): Promise<ScienceTypesetCatalogEntry[]> {
  const supported = process.platform === "darwin";
  const rows: ScienceTypesetCatalogEntry[] = [
    { engine: "tectonic", label: "Tectonic", profile: null, available: supported && Boolean(resolveTectonic()), reason: supported ? "publication_pdf_toolchain_missing" : "publication_pdf_platform_unverified" },
    { engine: "chromium", label: "Browser PDF", profile: null, available: supported, reason: supported ? null : "publication_pdf_platform_unverified" },
  ];
  if (rows[0].available) rows[0].reason = null;
  const cache = userDataPath("science", "typeset-profiles");
  const within = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
  let root: string;
  try { root = await fs.realpath(cache); }
  catch (error) {
    rows.push({ engine: "pdflatex", label: "pdfLaTeX", profile: null, available: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "publication_pdf_profile_missing" : "publication_pdf_profile_catalog_unavailable" });
    return rows;
  }
  try {
    let count = 0;
    for (const id of (await fs.readdir(root)).sort()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(id)) continue;
      const directory = await fs.realpath(path.join(root,id));
      if (!within(root,directory) || !(await fs.stat(directory)).isDirectory()) continue;
      for (const version of (await fs.readdir(directory)).sort()) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(version)) continue;
        if (++count > 16) throw new Error("publication_pdf_profile_catalog_limit");
        const manifestPath = await fs.realpath(path.join(directory,version,"manifest.json"));
        if (!within(root,manifestPath)) continue;
        const stat = await fs.stat(manifestPath);
        if (!stat.isFile() || stat.size > 16_000_000) continue;
        const raw = await fs.readFile(manifestPath), manifest = JSON.parse(raw.toString("utf8"));
        const profile = { id, version, manifestSha256: createHash("sha256").update(raw).digest("hex") };
        const probe = await probePdfLatexProfile(profile);
        const label = typeof manifest.displayName === "string" && /^[\p{L}\p{N} .()-]{1,60}$/u.test(manifest.displayName) ? manifest.displayName : "pdfLaTeX";
        rows.push({ engine: "pdflatex", label, profile, available: probe.available, reason: probe.reason });
      }
    }
  } catch {
    rows.push({ engine: "pdflatex", label: "pdfLaTeX", profile: null, available: false, reason: "publication_pdf_profile_catalog_unavailable" });
  }
  if (!rows.some(row=>row.engine === "pdflatex")) rows.push({ engine: "pdflatex", label: "pdfLaTeX", profile: null, available: false, reason: "publication_pdf_profile_missing" });
  return rows;
}
