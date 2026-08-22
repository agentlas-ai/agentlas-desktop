#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const JSZip = require("jszip");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const sharp = require("sharp");
const XLSX = require("styled-exceljs");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "file-viewers-electron");

async function writeZip(filename, entries) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  fs.writeFileSync(filename, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function createFixtures(directory) {
  const imagePath = path.join(directory, "live-output.png");
  await sharp({
    create: { width: 640, height: 360, channels: 4, background: { r: 23, g: 107, b: 70, alpha: 1 } },
  }).composite([{
    input: Buffer.from(`<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="360" fill="#176b46"/><circle cx="510" cy="88" r="52" fill="#f4c95d"/><text x="54" y="190" fill="white" font-family="Arial" font-size="42" font-weight="700">Agentlas Live Image</text></svg>`),
  }]).png().toFile(imagePath);

  const videoPath = path.join(directory, "live-output.webm");
  const videoBuild = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "2", "-c:v", "libvpx-vp9", "-b:v", "320k", "-c:a", "libopus", videoPath,
  ], { encoding: "utf8" });
  assert.equal(videoBuild.status, 0, `video fixture generation failed: ${videoBuild.stderr}`);

  const audioPath = path.join(directory, "live-output.wav");
  const audioBuild = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=523.25:sample_rate=48000", "-t", "2", audioPath,
  ], { encoding: "utf8" });
  assert.equal(audioBuild.status, 0, `audio fixture generation failed: ${audioBuild.stderr}`);

  const pdfPath = path.join(directory, "live-output.pdf");
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([720, 405]);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdfPage.drawRectangle({ x: 0, y: 0, width: 720, height: 405, color: rgb(0.94, 0.97, 0.95) });
  pdfPage.drawText("Agentlas Live PDF", { x: 64, y: 270, size: 34, font, color: rgb(0.09, 0.42, 0.27) });
  pdfPage.drawText("Rendered inside chat and the Work sidebar", { x: 64, y: 220, size: 18, color: rgb(0.16, 0.22, 0.18) });
  fs.writeFileSync(pdfPath, await pdf.save());

  const docxPath = path.join(directory, "live-output.docx");
  await writeZip(docxPath, {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="44"/><w:color w:val="176B46"/></w:rPr><w:t>Agentlas Live DOCX</w:t></w:r></w:p><w:p><w:r><w:t>Progressive document rendering stays inside the app.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  });

  const xlsxPath = path.join(directory, "live-output.xlsx");
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["Agentlas Live XLSX", "Status", "Latency"],
    ["Chat inline", "LIVE", "smooth"],
    ["Work sidebar", "LIVE", "smooth"],
  ]);
  worksheet["!cols"] = [{ wch: 24 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(workbook, worksheet, "Live output");
  fs.writeFileSync(xlsxPath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

  const pptxPath = path.join(directory, "live-output.pptx");
  await writeZip(pptxPath, {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Live title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="731520" y="1371600"/><a:ext cx="7680960" cy="1828800"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="176B46"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="3200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Agentlas Live PPTX</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    "ppt/slides/_rels/slide1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Agentlas QA</Application><AppVersion>16.0000</AppVersion></Properties>`,
  });

  const hwpxPath = path.join(directory, "live-output.hwpx");
  await writeZip(hwpxPath, {
    "Contents/section0.xml": `<?xml version="1.0" encoding="UTF-8"?><hs:section xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p><hp:run><hp:t>Agentlas Live HWPX</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>Worker-rendered Hangul document</hp:t></hp:run></hp:p></hs:section>`,
  });

  const pagesPath = path.join(directory, "live-output.pages");
  await writeZip(pagesPath, {
    "index.xml": `<?xml version="1.0" encoding="UTF-8"?><document><page name="Agentlas Live Pages"><text-storage kind="body"><p>Agentlas Live Pages</p><p>Apple document rendered in-app</p></text-storage></page></document>`,
  });

  const keyPath = path.join(directory, "live-output.key");
  await writeZip(keyPath, {
    "index.apxl": `<?xml version="1.0" encoding="UTF-8"?><presentation><size w="800" h="450"/><slide-list><slide name="Agentlas Live Keynote"><text-storage><p>Agentlas Live Keynote</p><p>Interactive presentation preview</p></text-storage></slide></slide-list></presentation>`,
  });

  const zipPath = path.join(directory, "live-output.zip");
  await writeZip(zipPath, {
    "hello.txt": "Agentlas Live ZIP\n",
    "results/report.csv": "surface,status\nchat,LIVE\nsidebar,LIVE\n",
  });

  return [
    { id: "image", kind: "image", path: imagePath, mime: "image/png", selector: "[data-testid='live-output-preview-stage'] img", media: true },
    { id: "video", kind: "video", path: videoPath, mime: "video/webm", selector: "[data-testid='live-output-preview-stage'] video", media: true, playback: true },
    { id: "audio", kind: "audio", path: audioPath, mime: "audio/wav", selector: "[data-testid='live-output-preview-stage'] audio", media: true, playback: true },
    { id: "pdf", kind: "pdf", path: pdfPath, mime: "application/pdf", selector: ".pdf-shell .page", text: "Agentlas Live PDF", worker: "vendor/pdf/pdf.worker.mjs" },
    { id: "docx", kind: "document", path: docxPath, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", selector: "[data-docx-worker='self']", text: "Agentlas Live DOCX", worker: "vendor/docx/docx.worker.js" },
    { id: "xlsx", kind: "spreadsheet", path: xlsxPath, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", selector: "[data-file-viewer-spreadsheet-root='true']", text: "3 rows, 3 columns", worker: "vendor/xlsx/sheet.worker.js" },
    { id: "pptx", kind: "presentation", path: pptxPath, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", selector: ".pptx-viewer-shell .slide", text: "Agentlas Live PPTX", worker: "vendor/pptx/pptx.worker.js" },
    { id: "hwpx", kind: "document", path: hwpxPath, mime: "application/x-hwp", selector: ".hangul-page", text: "Agentlas Live HWPX", worker: "vendor/hangul/hangul.worker.js" },
    { id: "pages", kind: "document", path: pagesPath, mime: "application/x-iwork-pages-sffpages", selector: ".iwork-scene", text: "Agentlas Live Pages", worker: "vendor/iwork/iwork.worker.js" },
    { id: "keynote", kind: "presentation", path: keyPath, mime: "application/x-iwork-keynote-sffkey", selector: ".iwork-scene", text: "Agentlas Live Keynote", worker: "vendor/iwork/iwork.worker.js" },
    { id: "archive", kind: "archive", path: zipPath, mime: "application/zip", selector: ".archive-shell", text: "hello.txt", worker: "vendor/libarchive/worker-bundle.js" },
  ];
}

function startFixtureServer(directory) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const name = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname).replace(/^\/+/, "");
      const file = path.join(directory, name);
      if (!file.startsWith(`${directory}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        response.writeHead(404, { "access-control-allow-origin": "*" });
        response.end("Not found");
        return;
      }
      const mime = {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".hwpx": "application/x-hwp",
        ".pages": "application/x-iwork-pages-sffpages",
        ".key": "application/x-iwork-keynote-sffkey",
        ".zip": "application/zip",
        ".png": "image/png",
        ".webm": "video/webm",
        ".wav": "audio/wav",
      }[path.extname(file).toLowerCase()] || "application/octet-stream";
      response.writeHead(200, {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
        "content-length": fs.statSync(file).size,
        "content-type": mime,
      });
      fs.createReadStream(file).pipe(response);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function waitForRenderedText(locator, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let content = "";
  while (Date.now() < deadline) {
    content = await locator.evaluate((element) => element.textContent || "").catch(() => "");
    if (content.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`rendered text was not found: ${expected}; content=${JSON.stringify(content.slice(0, 1_000))}`);
}

async function main() {
  const previewHtml = path.join(distDir, "surface-preview.html");
  assert.ok(fs.existsSync(previewHtml), "dist/renderer is missing; run npm run build:renderer first");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-file-viewer-fixtures-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-file-viewer-electron-"));
  const fixtures = await createFixtures(fixtureDir);
  const { server, baseUrl } = await startFixtureServer(fixtureDir);
  const requestedRuntimeAssets = new Set();
  const results = [];
  const previewUrlFor = (fixture) => {
    const query = new URLSearchParams({
      outputKind: fixture.kind,
      outputSource: `${baseUrl}/${path.basename(fixture.path)}`,
      outputName: path.basename(fixture.path),
      outputMime: fixture.mime,
    });
    return `${pathToFileURL(previewHtml).href}?${query.toString()}`;
  };
  const initialUrl = previewUrlFor(fixtures[0]);
  let desktop;
  try {
    desktop = await electron.launch({
      args: [root, `--user-data-dir=${userData}`],
      cwd: root,
      env: {
        ...process.env,
        AGENTLAS_E2E: "1",
        AGENTLAS_E2E_AUTH: "1",
        NODE_ENV: "development",
        ELECTRON_START_URL: initialUrl,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      timeout: 30_000,
    });
    const page = await desktop.firstWindow({ timeout: 30_000 });
    await page.waitForURL(initialUrl, { timeout: 60_000 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text());
    });
    page.on("request", (request) => {
      if (request.url().includes("/file-viewer/")) requestedRuntimeAssets.add(request.url());
    });

    for (const fixture of fixtures) {
      const url = previewUrlFor(fixture);
      try {
        if (page.url() !== url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (!fixture.media) await page.locator('[data-testid="universal-file-viewer"]').waitFor({ timeout: 30_000 });
        const rendered = page.locator(fixture.selector).first();
        await rendered.waitFor({ state: "visible", timeout: 40_000 });
        if (fixture.text) await waitForRenderedText(rendered, fixture.text);
        if (fixture.media) {
          await page.locator('[data-testid="live-output-preview-stage"] [data-state="ready"]').waitFor({ timeout: 20_000 });
          assert.equal(await page.locator('[data-testid="live-output-preview-stage"] [role="alert"]').count(), 0, `${fixture.id} surfaced a media error`);
        } else {
          assert.equal(await page.locator('[data-testid="universal-file-viewer"] > [role="alert"]').count(), 0, `${fixture.id} surfaced a renderer error`);
        }
        const bounds = await page.locator(fixture.selector).first().boundingBox();
        assert.ok(bounds && bounds.width > 120 && bounds.height > 40, `${fixture.id} rendered unusable bounds: ${JSON.stringify(bounds)}`);
        let playback;
        if (fixture.playback) {
          playback = await rendered.evaluate(async (element) => {
            element.muted = true;
            await element.play();
            await new Promise((resolve) => setTimeout(resolve, 650));
            return { currentTime: element.currentTime, paused: element.paused, readyState: element.readyState };
          });
          assert.ok(playback.currentTime > 0.25 && playback.paused === false && playback.readyState >= 3,
            `${fixture.id} playback did not advance: ${JSON.stringify(playback)}`);
        }
        await page.locator('[data-testid="live-output-preview-stage"]').screenshot({ path: path.join(outDir, `${fixture.id}.png`) });
        results.push({ id: fixture.id, bounds, ...(fixture.worker ? { worker: fixture.worker } : {}), ...(playback ? { playback } : {}) });
      } catch (error) {
        await page.screenshot({ path: path.join(outDir, `${fixture.id}-diagnostic.png`), fullPage: true }).catch(() => undefined);
        const diagnostic = {
          url: page.url(),
          body: (await page.locator("body").innerText().catch(() => "")).slice(0, 4_000),
          alerts: await page.locator('[role="alert"]').allTextContents().catch(() => []),
          runtimeRequests: [...requestedRuntimeAssets],
          errors,
        };
        throw new Error(`${fixture.id} viewer QA failed: ${JSON.stringify(diagnostic)}\n${String(error)}`);
      }
    }

    for (const fixture of fixtures) {
      if (!fixture.worker) continue;
      const expected = path.join(distDir, "file-viewer", fixture.worker);
      assert.ok(fs.existsSync(expected) && fs.statSync(expected).size > 1_000, `missing packaged runtime asset: ${expected}`);
      assert.ok([...requestedRuntimeAssets].some((url) => url.includes(fixture.worker)), `${fixture.id} did not request ${fixture.worker}`);
    }
    assert.deepEqual(errors, [], `renderer errors: ${errors.join("\n")}`);
    const proof = {
      ok: true,
      staticFileRuntime: true,
      formats: results,
      runtimeAssets: [...requestedRuntimeAssets].filter((url) => /(?:worker|wasm)/i.test(url)),
    };
    fs.writeFileSync(path.join(outDir, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, staticFileRuntime: true, rendered: results.map((item) => item.id), workersRequested: new Set(results.map((item) => item.worker).filter(Boolean)).size }));
  } finally {
    if (desktop) {
      let child = null;
      try { child = desktop.process(); } catch {}
      let closed = false;
      await Promise.race([
        desktop.close().then(() => { closed = true; }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 12_000)),
      ]);
      if (!closed && child?.exitCode === null) child.kill("SIGTERM");
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
