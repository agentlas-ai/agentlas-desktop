import React, { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChemicalMimeType } from "ketcher-core";
import { Editor } from "ketcher-react";
import { StandaloneStructServiceProvider } from "ketcher-standalone/dist/binaryWasm";
import { StandaloneStructServiceProvider as StandaloneValidatorServiceProvider } from "ketcher-standalone/dist/binaryWasmNoRender";
import "ketcher-react/dist/index.css";
import "./style.css";

const bridge = window.agentlasScienceRenderer;

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function countsFromMolfile(molfile) {
  const lines = molfile.replace(/\r\n/g, "\n").split("\n");
  const counts = lines[3] || "";
  const atomCount = Number.parseInt(counts.slice(0, 3).trim(), 10);
  const bondCount = Number.parseInt(counts.slice(3, 6).trim(), 10);
  if (!Number.isSafeInteger(atomCount) || atomCount < 1 || !Number.isSafeInteger(bondCount) || bondCount < 0) throw new Error(`indigo-molfile-counts-invalid:${JSON.stringify(molfile.slice(0, 600))}`);
  return { atomCount, bondCount };
}

function App() {
  const editorProvider = useMemo(() => new StandaloneStructServiceProvider(), []);
  // Ketcher's binaryWasm package owns a module-level worker. Reusing that
  // module for validation lets a validator replace or terminate the editor's
  // worker. The no-render bundle is a separate module/worker boundary and is
  // kept alive for the lifetime of this artifact view.
  const validatorProvider = useMemo(() => new StandaloneValidatorServiceProvider(), []);
  const validatorRef = useRef(null);
  const editorRef = useRef(null);
  const requestRef = useRef(null);
  const initStartedRef = useRef(false);
  const sequenceRef = useRef(0);
  const draftRevisionRef = useRef(0);
  const changeSubscriptionRef = useRef(null);
  const [phase, setPhase] = useState("launching");
  const [, setMessage] = useState("Loading the signed chemistry runtime…");
  const [receipt, setReceipt] = useState(null);
  const [, setSavedVersion] = useState(null);
  const [error, setError] = useState(null);
  const [errorKind, setErrorKind] = useState(null);

  const report = useCallback(async (phaseName, summary, extra = {}) => {
    const request = requestRef.current;
    return bridge.report({
      instanceId: request?.instanceId || bridge.instanceId,
      renderRequestId: request?.renderRequestId || crypto.randomUUID(),
      sequence: ++sequenceRef.current,
      phase: phaseName,
      sceneRevision: extra.sceneRevision || null,
      code: extra.code || null,
      summary,
      observation: extra.observation || null,
    });
  }, []);

  const validateCurrent = useCallback(async () => {
    if (!editorRef.current) throw new Error("ketcher-editor-not-ready");
    const draftRevision = draftRevisionRef.current;
    setPhase("validating");
    setMessage("Exporting KET and validating it with a separate Indigo service…");
    setError(null);
    setErrorKind(null);
    const ket = await editorRef.current.getKet();
    if (!ket.trim()) throw new Error("ketcher-ket-empty");
    if (!validatorRef.current) {
      validatorRef.current = validatorProvider.createStructService({});
      validatorRef.current.addKetcherId(`agentlas-validator-${requestRef.current.instanceId}`);
    }
    const validator = validatorRef.current;
    try {
      // Indigo's standalone provider multiplexes one worker. Parallel requests
      // can be delivered to the wrong Promise, so every operation is ordered.
      const info = await validator.info();
      const checked = await validator.check({ struct: ket, types: ["radicals", "pseudoatoms", "stereo", "query", "overlapping_atoms", "overlapping_bonds", "rgroups", "chiral", "3d", "chiral_flag", "valence"] });
      const smilesResult = await validator.convert({ struct: ket, input_format: ChemicalMimeType.KET, output_format: ChemicalMimeType.DaylightSmiles });
      const molResult = await validator.convert({ struct: ket, input_format: ChemicalMimeType.KET, output_format: ChemicalMimeType.Mol });
      if (!info?.isAvailable || !/^1\.45\.1(?:\.|$)/.test(String(info.indigoVersion))) throw new Error(`indigo-version-mismatch:${JSON.stringify(info)}`);
      const canonicalSmiles = String(smilesResult?.struct || "").trim();
      if (!canonicalSmiles) throw new Error("indigo-canonical-smiles-empty");
      const { atomCount, bondCount } = countsFromMolfile(String(molResult?.struct || ""));
      const warnings = Object.entries(checked || {}).filter(([, value]) => String(value).trim()).map(([key, value]) => `${key}: ${String(value).trim()}`);
      if (warnings.length > 0) throw new Error(`indigo-structure-check-failed:${warnings.join(" | ")}`);
      const ketSha256 = await digest(ket);
      const canonicalSmilesSha256 = await digest(canonicalSmiles);
      if (draftRevisionRef.current !== draftRevision) throw new Error("ketcher-draft-changed-during-validation");
      const validation = {
        schema: "agentlas.science-chemistry-validation/v1",
        engine: "Ketcher",
        engineVersion: "3.17.2",
        validator: "Indigo",
        validatorVersion: info.indigoVersion,
        ketSha256,
        canonicalSmilesSha256,
        atomCount,
        bondCount,
        warnings,
        code: "structure-valid",
      };
      const nextReceipt = {
        draftRevision,
        document: { format: "ket", ket, ketSha256, canonicalSmiles, canonicalSmilesSha256 },
        validation,
      };
      setReceipt(nextReceipt);
      setPhase("ready-to-save");
      setMessage("Independent Indigo validation passed. A new immutable version can be saved.");
      return nextReceipt;
    } catch (validationError) {
      // A failed worker is not silently reused for a later save attempt.
      validator.destroy?.();
      validatorRef.current = null;
      throw validationError;
    }
  }, [validatorProvider]);

  const saveVersion = useCallback(async () => {
    if (!receipt || !requestRef.current) return;
    setPhase("saving");
    setMessage("Writing a new immutable artifact version…");
    setError(null);
    setErrorKind(null);
    try {
      const request = requestRef.current;
      if (draftRevisionRef.current !== receipt.draftRevision) throw new Error("science-chemistry-validation-stale");
      const currentKet = await editorRef.current.getKet();
      if (await digest(currentKet) !== receipt.document.ketSha256 || draftRevisionRef.current !== receipt.draftRevision) throw new Error("science-chemistry-validation-stale");
      const result = await bridge.commitChemistry({
        schema: "agentlas.science-chemistry-commit/v1",
        instanceId: request.instanceId,
        renderRequestId: request.renderRequestId,
        requestId: crypto.randomUUID(),
        artifactId: request.artifactId,
        artifactVersion: request.artifactVersion,
        artifactContentSha256: request.artifactContentSha256,
        document: receipt.document,
        validation: receipt.validation,
      });
      setSavedVersion(result.artifact.currentVersion);
      setReceipt(null);
      setPhase("version-saved");
      setMessage(`Version v${result.artifact.currentVersion} saved. Reopen the artifact to continue from the new immutable base.`);
    } catch (saveError) {
      setPhase("validation-failed");
      setError(String(saveError));
      setErrorKind("save");
      setMessage("Save failed without changing the current artifact version.");
    }
  }, [receipt]);

  const onInit = useCallback(async (ketcher) => {
    if (initStartedRef.current) return;
    initStartedRef.current = true;
    editorRef.current = ketcher;
    try {
      if (!bridge || typeof bridge.handshake !== "function" || typeof bridge.report !== "function" || typeof bridge.commitChemistry !== "function") throw new Error("renderer-preload-missing");
      const request = await bridge.handshake();
      requestRef.current = request;
      if (request?.schema !== "agentlas.science-renderer-request/v1" || request.binding?.rendererId !== "agentlas.ketcher" || request.input?.kind !== "chemistry-document") throw new Error("renderer-request-invalid");
      setPhase("probing");
      setMessage("Checking exact Ketcher and Indigo versions…");
      await report("probing", "Checking Ketcher 3.17.2 and Indigo 1.45.1");
      await ketcher.setMolecule(request.input.ket);
      setPhase("rendering");
      setMessage("Rendering the verified KET document…");
      await report("rendering", "Rendering verified KET document");
      const initial = await validateCurrent();
      // Ketcher normalizes KET serialization when it loads a document, so the
      // editor export is not byte-identical to the stored source. Chemical
      // identity is checked through Indigo's canonical SMILES instead.
      if (initial.document.canonicalSmilesSha256 !== request.input.canonicalSmilesSha256) throw new Error("ketcher-input-validation-mismatch");
      const host = document.querySelector(".ketcher-host");
      const rect = host?.getBoundingClientRect();
      if (!rect || rect.width < 240 || rect.height < 200) throw new Error("ketcher-canvas-missing");
      const sceneRevision = await digest(JSON.stringify({ artifact: request.artifactContentSha256, document: initial.document.ketSha256, width: Math.round(rect.width), height: Math.round(rect.height) }));
      setReceipt(null);
      changeSubscriptionRef.current = ketcher.editor.subscribe("change", () => {
        draftRevisionRef.current += 1;
        setReceipt(null);
        setSavedVersion(null);
        setError(null);
        setErrorKind(null);
        setPhase("edit-dirty");
        setMessage("Structure changed. Validate this exact draft before saving a new version.");
        void report("dirty", "Unsaved chemistry draft is active").catch(() => {});
      });
      setPhase("edit-clean");
      setMessage("Verified structure loaded. Edit, validate, then save a new version.");
      await report("stable", "Ketcher editor is stable and observable", {
        sceneRevision,
        observation: {
          kind: "chemistry-document",
          engineVersion: "3.17.2",
          validatorVersion: initial.validation.validatorVersion,
          editable: true,
          documentSha256: request.input.ketSha256,
          canonicalSmilesSha256: request.input.canonicalSmilesSha256,
          atomCount: initial.validation.atomCount,
          bondCount: initial.validation.bondCount,
          canvasWidth: Math.round(rect.width),
          canvasHeight: Math.round(rect.height),
        },
      });
    } catch (launchError) {
      const summary = launchError instanceof Error ? launchError.message : String(launchError);
      setPhase("failed");
      setError(summary);
      setErrorKind("load");
      setMessage("The chemistry renderer failed closed.");
      try { await report("failed", summary, { code: summary.split(":", 1)[0] }); } catch {}
    }
  }, [report, validateCurrent]);

  const errorNotice = errorKind === "save"
    ? { title: "The new version could not be saved.", guidance: "Validate again to retry. If another version was saved, reopen the latest version first." }
    : errorKind === "validation"
      ? { title: "The structure could not be validated.", guidance: "Correct the structure, then validate it again." }
      : { title: "This structure could not be loaded.", guidance: "Reopen the artifact. If it still fails, return to its source and replace the invalid structure." };
  const phaseLabel = {
    launching: "Loading",
    probing: "Loading",
    rendering: "Loading",
    validating: "Validating",
    saving: "Saving",
    "edit-dirty": "Validation required",
    "ready-to-save": "Ready to save",
    "version-saved": "Version saved",
  }[phase] || "";

  return (
    <main className="pack-shell">
      <header className="artifact-bar">
        <div>
          <span className="eyebrow">CHEMISTRY DOCUMENT</span>
          <strong>Ketcher structure editor</strong>
          <small>Ketcher 3.17.2 · Indigo 1.45.1 · offline signed pack</small>
        </div>
        <div className="actions">
          {phaseLabel && <span className={`phase phase-${phase}`}>{phaseLabel}</span>}
          <button onClick={() => validateCurrent().catch((validationError) => { setPhase("validation-failed"); setError(String(validationError)); setErrorKind("validation"); setMessage("Validation failed. No version can be saved."); })} disabled={["launching", "probing", "rendering", "validating", "saving", "version-saved", "failed"].includes(phase)}>Validate structure</button>
          <button className="primary" onClick={saveVersion} disabled={phase !== "ready-to-save"}>Save new version</button>
        </div>
      </header>
      <section className="editor-frame">
        <div className="ketcher-host">
          <Editor
            staticResourcesUrl="./"
            structServiceProvider={editorProvider}
            disableMacromoleculesEditor
            errorHandler={(value) => { setPhase("failed"); setError(String(value)); setErrorKind("load"); setMessage("Ketcher reported a runtime error."); }}
            onInit={onInit}
          />
        </div>
      </section>
      {error && <footer className="receipt-bar error-notice" role="alert" aria-live="assertive">
        <div><span className="dot error"></span><strong>{errorNotice.title}</strong></div>
        <p>{errorNotice.guidance}</p>
        <details><summary>Technical details</summary><code className="error-copy">{error}</code></details>
      </footer>}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
