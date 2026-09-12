import { BrowserWindow, session } from "electron";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { userDataPath } from "../runtime-paths";
import type { ArtifactRenderReceipt } from "../../shared/artifact-build";
import type { ArtifactBundle } from "./artifact-build";
import { artifactBytesDigest } from "./artifact-files";

export const ARTIFACT_PREVIEW_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";
const TYPES: Record<string,string> = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif",".woff":"font/woff",".woff2":"font/woff2",".ttf":"font/ttf",".wasm":"application/wasm"};

/** Observes an isolated candidate. It has neither Desktop preload nor permission/action grants. */
export async function observeArtifactRender(bundle: ArtifactBundle, signal?: AbortSignal): Promise<ArtifactRenderReceipt> {
  signal?.throwIfAborted();
  const files = new Map(bundle.snapshot.files.map(file => [file.path, file.bytes]));
  let origin = "";
  const server = http.createServer((request,response) => {
    if (request.headers.host !== new URL(origin).host || !["GET","HEAD"].includes(request.method ?? "")) {
      response.writeHead(403).end(); return;
    }
    let relative = "";
    try { relative = decodeURIComponent(new URL(request.url ?? "/",origin).pathname).replace(/^\/+/,""); }
    catch { response.writeHead(400).end(); return; }
    const filename = relative || "index.html", bytes = files.get(filename);
    if (!bytes) { response.writeHead(404).end(); return; }
    response.writeHead(200,{"Content-Type":TYPES[path.extname(filename)] ?? "application/octet-stream","Content-Security-Policy":ARTIFACT_PREVIEW_CSP,"X-Content-Type-Options":"nosniff","Cache-Control":"no-store"});
    response.end(request.method === "HEAD" ? undefined : bytes);
  });
  let window: BrowserWindow | undefined;
  const partition = session.fromPartition(`artifact-observation-${randomUUID()}`);
  let abort: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const errors: string[] = [];
  try {
    await new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",()=>resolve()); });
    const address=server.address();
    if (!address || typeof address === "string") throw new Error("artifact_observation_port_failed");
    origin=`http://127.0.0.1:${address.port}`;
    partition.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    partition.setPermissionCheckHandler(()=>false);
    partition.webRequest.onBeforeRequest((details,callback) => {
      const protocol = new URL(details.url).protocol;
      const allowed = details.url.startsWith(`${origin}/`) || protocol === "data:" || protocol === "blob:";
      if (!allowed && errors.length < 20) errors.push("artifact_external_request_refused");
      callback({cancel:!allowed});
    });
    window = new BrowserWindow({show:false,width:1280,height:800,useContentSize:true,
      webPreferences:{session:partition,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false}});
    const contents=window.webContents;
    contents.setWindowOpenHandler(()=>({action:"deny"}));
    contents.on("will-navigate",event=>event.preventDefault());
    contents.on("console-message",(event) => { if (event.level === "error" && errors.length < 20) errors.push(event.message.slice(0,1000)); });
    const interrupted = new Promise<never>((_resolve,reject) => {
      abort=()=>{ reject(new Error("artifact_render_cancelled")); if(window && !window.isDestroyed()) window.destroy(); };
      signal?.addEventListener("abort",abort,{once:true});
      if(signal?.aborted) abort();
      timer=setTimeout(()=>{reject(new Error("artifact_render_timeout"));if(window && !window.isDestroyed()) window.destroy();},15_000);
    });
    const observed = (async () => {
      await contents.loadURL(`${origin}/`);
      const measure = await contents.executeJavaScript(`(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(image => image.decode().catch(()=>{})));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        await new Promise(resolve=>setTimeout(resolve,300));
        const body=document.body;
        const visible=[...document.querySelectorAll('body *')].filter(node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'});
        return {blank:!body || (!body.innerText.trim() && !visible.some(node=>['CANVAS','SVG','IMG','VIDEO','INPUT','TEXTAREA'].includes(node.tagName))),
          brokenImages:[...document.images].filter(image=>!image.complete||image.naturalWidth===0).length,
          horizontalOverflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),
          node:typeof require,ipc:typeof window.agentlas};
      })()`);
      if (measure.blank) throw new Error("artifact_render_blank");
      if (measure.brokenImages) throw new Error("artifact_render_image_decode_failed");
      if (measure.node !== "undefined" || measure.ipc !== "undefined") throw new Error("artifact_render_isolation_failed");
      if (measure.horizontalOverflow > 1) throw new Error(`artifact_render_overflow:${measure.horizontalOverflow}`);
      if (errors.length) throw new Error(`artifact_render_console_failed: ${errors.slice(0,3).join("; ")}`);
      const png=(await contents.capturePage()).toPNG();
      if(!png.length) throw new Error("artifact_render_capture_empty");
      const screenshotDigest=artifactBytesDigest(png);
      const evidenceDirectory=userDataPath("artifact-build","observations");
      await fs.mkdir(evidenceDirectory,{recursive:true,mode:0o700});
      await fs.writeFile(path.join(evidenceDirectory,`${screenshotDigest}.png`),png,{mode:0o600});
      return {schemaVersion:"agentlas.artifact-render-receipt.v1" as const,artifactId:bundle.build.artifactId,
        sourceDigest:bundle.build.sourceDigest,bundleDigest:bundle.build.bundleDigest,viewport:{width:1280,height:800},
        screenshotDigest,observedAt:new Date().toISOString(),consoleFailures:[],
        horizontalOverflow:measure.horizontalOverflow,state:"render_checked" as const,businessVerification:"not_verified" as const};
    })();
    return await Promise.race([observed,interrupted]);
  } finally {
    if(timer)clearTimeout(timer); if(abort)signal?.removeEventListener("abort",abort);
    if(window && !window.isDestroyed())window.destroy();
    partition.webRequest.onBeforeRequest(null);
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await partition.clearStorageData();
  }
}
