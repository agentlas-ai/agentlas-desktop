// Webpack normally folds bare import.meta.url into a private build-machine URL.
// Preserve its static new URL asset handling, but resolve vendor fallback bases
// against the installed renderer, where these runtime assets actually live.
const bases = [
  ["/@file-viewer/ppt/index.mjs", "file-viewer/vendor/ppt/index.mjs"],
  ["/@file-viewer/pptx/dist/worker.js", "file-viewer/vendor/pptx/pptx.worker.js"],
  ["/maplibre-gl/dist/maplibre-gl.mjs", "vendor/maplibre-gl/maplibre-gl.mjs"],
  ["/pdfjs-dist/build/pdf.mjs", "file-viewer/vendor/pdf/pdf.mjs"],
  ["/pdfjs-dist/legacy/build/pdf.mjs", "file-viewer/vendor/pdf/pdf.mjs"],
  ["/pdfjs-dist/legacy/build/pdf.worker.mjs", "file-viewer/vendor/pdf/pdf.worker.mjs"],
  ["/@file-viewer/renderer-media/dist/vendor/mp4v/mp4v-decoder.mjs", "file-viewer/vendor/mp4v/mp4v-decoder.mjs"],
];
module.exports = function portableRendererModuleUrl(source) {
  const resource = this.resourcePath.replace(/\\/g, "/");
  const match = bases.find(([suffix]) => resource.endsWith(suffix));
  if (!match) return source;
  const base = `(() => {
    const doc = globalThis.document;
    let href = doc?.baseURI || globalThis.location?.href || "file:///";
    if (href.startsWith("blob:")) href = href.slice(5);
    const current = new URL(href);
    let root = new URL("/", current);
    if (current.protocol === "file:") {
      const script = Array.from(doc?.scripts || []).find(item => item.src?.includes("/_next/static/"));
      root = script ? new URL(script.src.slice(0, script.src.indexOf("/_next/static/") + 1)) : new URL("./", current);
    }
    return new URL(${JSON.stringify(match[1])}, root).href;
  })()`;
  const { parse } = require("next/dist/compiled/acorn");
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const replacements = [];
  function visit(node, parent) {
    if (!node || typeof node !== "object") return;
    if (node.type === "MemberExpression" && !node.computed && node.property.name === "url"
        && node.object.type === "MetaProperty" && node.object.meta.name === "import") {
      const first = parent?.arguments?.[0];
      const staticAsset = parent?.type === "NewExpression" && parent.callee.name === "URL"
        && parent.arguments[1] === node && (typeof first?.value === "string"
          || (first?.type === "TemplateLiteral" && first.expressions.length === 0));
      if (!staticAsset) replacements.push([node.start, node.end]);
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, node));
      else if (value && typeof value === "object") visit(value, node);
    }
  }
  visit(tree, null);
  for (const [start, end] of replacements.reverse()) source = source.slice(0, start) + base + source.slice(end);
  return source;
};
