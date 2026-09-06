(() => {
  "use strict";

  const bridge = window.agentlasScienceRenderer;
  const status = document.getElementById("status");
  const editor = document.getElementById("editor");
  const representationControl = document.getElementById("representation");
  const colorThemeControl = document.getElementById("color-theme");
  const selectionToggle = document.getElementById("selection-toggle");
  const selectionCount = document.getElementById("selection-count");
  const selectionPanel = document.getElementById("selection-panel");
  const selectionClose = document.getElementById("selection-close");
  const selectionChain = document.getElementById("selection-chain");
  const selectionFrom = document.getElementById("selection-from");
  const selectionTo = document.getElementById("selection-to");
  const selectionPreview = document.getElementById("selection-preview");
  const selectionSummary = document.getElementById("selection-summary");
  const selectionRestoreFocus = document.getElementById("selection-restore-focus");
  const selectionClear = document.getElementById("selection-clear");
  const selectionFocus = document.getElementById("selection-focus");
  const selectionPin = document.getElementById("selection-pin");
  const resetViewButton = document.getElementById("reset-view");
  const saveVersionButton = document.getElementById("save-version");
  const editorNote = document.getElementById("editor-note");
  let viewer = null;
  let sequence = 0;
  let request = null;
  let ready = false;
  let saving = false;
  let baseViewState = null;
  let draftViewState = null;
  let residueCatalog = [];
  let exploratoryResidues = [];
  let selectionSubscription = null;
  let applyingInteraction = false;
  let runtimeDirty = false;

  const REPRESENTATIONS = new Set(["cartoon", "ball-and-stick", "surface"]);
  const COLOR_THEMES = new Set(["chain-id", "element-symbol", "secondary-structure"]);
  const RESIDUE_INTERACTION_SCHEMA = "agentlas.science-residue-interaction/v1";
  const PRESETS = Object.freeze({
    cartoon: "polymer-cartoon",
    "ball-and-stick": "atomic-detail",
    surface: "molecular-surface",
  });

  const report = (phase, summary, extra = {}) => bridge.report({
    instanceId: request?.instanceId || bridge.instanceId,
    renderRequestId: request?.renderRequestId || extra.renderRequestId,
    sequence: ++sequence,
    phase,
    sceneRevision: extra.sceneRevision || null,
    code: extra.code || null,
    summary,
    observation: extra.observation || null,
  });

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function sha256Text(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
  }

  function pdbObservation(text) {
    const atoms = text.split(/\r?\n/).filter((line) => line.startsWith("ATOM  "));
    const residues = new Set();
    const chains = new Set();
    const models = new Set(["1"]);
    for (const line of atoms) {
      const chain = line.slice(21, 22).trim() || "_";
      chains.add(chain);
      residues.add(`${chain}:${line.slice(22, 27).trim()}`);
    }
    return { modelCount: models.size, chainCount: chains.size, residueCount: residues.size, atomCount: atoms.length };
  }

  async function waitUntilIdle(plugin, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (plugin.behaviors?.state?.isBusy?.value) {
      if (performance.now() > deadline) throw new Error("molstar-render-timeout");
      await delay(25);
    }
  }

  function residueKey(value) {
    return [value.modelNum, value.operatorName, value.labelAsymId, value.authAsymId, value.labelSeqId === null ? "~" : value.labelSeqId,
      value.authSeqId, value.insertionCode, value.compId].join("\u001f");
  }

  function displayResidue(value) {
    const chain = value.authAsymId || value.labelAsymId || "_";
    const insertionCode = value.insertionCode ? `:${value.insertionCode}` : "";
    return `${chain}:${value.compId}${value.authSeqId}${insertionCode}`;
  }

  function interactionDigest(interaction) {
    return sha256Text(JSON.stringify({ structureContentSha256: request.input.assetSha256, interaction }));
  }

  function currentStructure() {
    return viewer?.plugin?.managers?.structure?.hierarchy?.current?.structures?.[0]?.cell?.obj?.data || null;
  }

  function locatorFromLocation(location) {
    const properties = window.molstar.lib.structure.StructureProperties;
    const labelSeqId = Number(properties.residue.label_seq_id(location));
    return {
      modelNum: Number(properties.unit.model_num(location)),
      operatorName: String(properties.unit.operator_name(location) || "1_555"),
      labelAsymId: String(properties.chain.label_asym_id(location) || ""),
      authAsymId: String(properties.chain.auth_asym_id(location) || ""),
      labelSeqId: Number.isSafeInteger(labelSeqId) && labelSeqId > 0 ? labelSeqId : null,
      authSeqId: Number(properties.residue.auth_seq_id(location)),
      insertionCode: String(properties.residue.pdbx_PDB_ins_code(location) || ""),
      compId: String(properties.residue.label_comp_id(location) || ""),
    };
  }

  function residuesFromLoci(loci) {
    const structureElement = window.molstar.lib.structure.StructureElement;
    if (!structureElement.Loci.is(loci) || structureElement.Loci.isEmpty(loci)) return [];
    const wholeResidues = structureElement.Loci.extendToWholeResidues(loci);
    const indexed = new Map();
    structureElement.Loci.forEachLocation(wholeResidues, (location) => {
      try {
        const locator = locatorFromLocation(location);
        indexed.set(residueKey(locator), locator);
      } catch {}
    });
    return [...indexed.values()].sort((left, right) => residueKey(left).localeCompare(residueKey(right), "en"));
  }

  function currentSelectionLoci() {
    const structure = currentStructure();
    if (!structure) return null;
    return viewer.plugin.managers.structure.selection.getLoci(structure);
  }

  function currentSelectionResidues() {
    const loci = currentSelectionLoci();
    return loci ? residuesFromLoci(loci) : [];
  }

  function residueSchemaItem(residue) {
    return {
      operator_name: residue.operatorName,
      label_asym_id: residue.labelAsymId,
      auth_asym_id: residue.authAsymId,
      ...(residue.labelSeqId === null ? {} : { label_seq_id: residue.labelSeqId }),
      auth_seq_id: residue.authSeqId,
      pdbx_PDB_ins_code: residue.insertionCode,
      label_comp_id: residue.compId,
    };
  }

  function lociForResidues(residues) {
    const structure = currentStructure();
    const structureElement = window.molstar.lib.structure.StructureElement;
    if (!structure) return null;
    let combined = structureElement.Loci.none(structure);
    for (const residue of residues) {
      const candidate = structureElement.Loci.fromSchema(structure, { items: [residueSchemaItem(residue)] });
      const modelElements = candidate.elements.filter((element) => Number(element.unit.model.modelNum) === residue.modelNum);
      if (modelElements.length > 0) combined = structureElement.Loci.union(combined, structureElement.Loci(structure, modelElements));
    }
    return structureElement.Loci.extendToWholeResidues(combined);
  }

  function selectResidues(residues, focus) {
    if (!viewer) return;
    applyingInteraction = true;
    try {
      viewer.plugin.managers.interactivity.lociSelects.deselectAll();
      const loci = lociForResidues(residues);
      const structureElement = window.molstar.lib.structure.StructureElement;
      if (loci && !structureElement.Loci.isEmpty(loci)) {
        viewer.plugin.managers.interactivity.lociSelects.select({ loci }, false);
        if (focus) viewer.plugin.managers.camera.focusLoci(loci);
      }
    } finally {
      applyingInteraction = false;
    }
  }

  function focusResidues(residues) {
    const loci = lociForResidues(residues);
    const structureElement = window.molstar.lib.structure.StructureElement;
    if (loci && !structureElement.Loci.isEmpty(loci)) viewer.plugin.managers.camera.focusLoci(loci);
  }

  function populateResidueControls() {
    const structure = currentStructure();
    if (!structure) throw new Error("molstar-structure-hierarchy-empty");
    residueCatalog = residuesFromLoci(window.molstar.lib.structure.StructureElement.Loci.all(structure));
    if (residueCatalog.length < 1) throw new Error("molstar-residue-catalog-empty");
    const chains = [...new Set(residueCatalog.map((residue) => residue.authAsymId || residue.labelAsymId))];
    selectionChain.replaceChildren(...chains.map((chain) => {
      const option = document.createElement("option");
      option.value = chain;
      option.textContent = chain;
      return option;
    }));
    syncRangeBounds();
  }

  function syncRangeBounds() {
    const chain = selectionChain.value;
    const numbers = residueCatalog.filter((residue) => (residue.authAsymId || residue.labelAsymId) === chain).map((residue) => residue.authSeqId);
    if (numbers.length < 1) return;
    const minimum = Math.min(...numbers);
    const maximum = Math.max(...numbers);
    selectionFrom.min = String(minimum);
    selectionFrom.max = String(maximum);
    selectionTo.min = String(minimum);
    selectionTo.max = String(maximum);
    selectionFrom.value = String(minimum);
    selectionTo.value = String(maximum);
  }

  function normalizeInteraction(value) {
    const residues = Array.isArray(value?.residues)
      ? value.residues.map((residue) => ({
        modelNum: Number(residue.modelNum),
        operatorName: String(residue.operatorName || ""),
        labelAsymId: String(residue.labelAsymId || ""),
        authAsymId: String(residue.authAsymId || ""),
        labelSeqId: residue.labelSeqId === null ? null : Number(residue.labelSeqId),
        authSeqId: Number(residue.authSeqId),
        insertionCode: String(residue.insertionCode || ""),
        compId: String(residue.compId || ""),
      })).sort((left, right) => residueKey(left).localeCompare(residueKey(right), "en"))
      : [];
    const unique = residues.filter((residue, index) => index === 0 || residueKey(residue) !== residueKey(residues[index - 1])).slice(0, 512);
    const focusKey = value?.focus ? residueKey(value.focus) : null;
    return Object.freeze({
      schema: RESIDUE_INTERACTION_SCHEMA,
      granularity: "residue",
      residues: Object.freeze(unique),
      focus: focusKey ? unique.find((residue) => residueKey(residue) === focusKey) || null : null,
    });
  }

  function emptyInteraction() {
    return normalizeInteraction({ residues: [], focus: null });
  }

  function normalizeViewState(value) {
    const representation = REPRESENTATIONS.has(value?.representation) ? value.representation : "cartoon";
    const defaultColor = representation === "ball-and-stick" ? "element-symbol" : "chain-id";
    const colorTheme = COLOR_THEMES.has(value?.colorTheme) ? value.colorTheme : defaultColor;
    return Object.freeze({ representation, colorTheme, interaction: normalizeInteraction(value?.interaction || emptyInteraction()) });
  }

  function viewStatesEqual(left, right) {
    return left?.representation === right?.representation
      && left?.colorTheme === right?.colorTheme
      && JSON.stringify(left?.interaction) === JSON.stringify(right?.interaction);
  }

  function setControlsDisabled(disabled) {
    representationControl.disabled = disabled;
    colorThemeControl.disabled = disabled;
    selectionToggle.disabled = disabled;
    selectionPreview.disabled = disabled;
    selectionClear.disabled = disabled || exploratoryResidues.length === 0;
    selectionFocus.disabled = disabled || exploratoryResidues.length === 0;
    selectionPin.disabled = disabled || exploratoryResidues.length === 0 || exploratoryResidues.length > 512;
    resetViewButton.disabled = disabled;
    saveVersionButton.disabled = disabled || !ready || viewStatesEqual(baseViewState, draftViewState);
    editor.setAttribute("aria-busy", disabled ? "true" : "false");
  }

  function syncControls() {
    representationControl.value = draftViewState.representation;
    colorThemeControl.value = draftViewState.colorTheme;
    const pinned = draftViewState.interaction.residues.length;
    selectionCount.textContent = String(pinned);
    selectionToggle.dataset.pinned = pinned > 0 ? "true" : "false";
    selectionSummary.textContent = exploratoryResidues.length > 0
      ? `Exploratory selection ${exploratoryResidues.length} · ${exploratoryResidues.slice(0, 4).map(displayResidue).join(", ")}${exploratoryResidues.length > 4 ? ` +${exploratoryResidues.length - 4}` : ""}`
      : pinned > 0
        ? `Saved highlight ${pinned} · ${draftViewState.interaction.residues.slice(0, 4).map(displayResidue).join(", ")}${pinned > 4 ? ` +${pinned - 4}` : ""}`
        : "No exploratory residues selected.";
    const summarizedResidues = exploratoryResidues.length > 0 ? exploratoryResidues : draftViewState.interaction.residues;
    selectionSummary.dataset.firstResidue = summarizedResidues[0] ? JSON.stringify(summarizedResidues[0]) : "";
    selectionSummary.dataset.lastResidue = summarizedResidues.at(-1) ? JSON.stringify(summarizedResidues.at(-1)) : "";
    selectionClear.disabled = saving || !ready || exploratoryResidues.length === 0;
    selectionFocus.disabled = saving || !ready || exploratoryResidues.length === 0;
    selectionPin.disabled = saving || !ready || exploratoryResidues.length === 0 || exploratoryResidues.length > 512;
    saveVersionButton.disabled = saving || !ready || viewStatesEqual(baseViewState, draftViewState);
  }

  async function applyViewState(viewState) {
    const structures = viewer.plugin.managers.structure.hierarchy.current.structures;
    if (structures.length < 1) throw new Error("molstar-structure-hierarchy-empty");
    await viewer.plugin.managers.structure.component.applyPreset(structures, PRESETS[viewState.representation], {
      theme: { globalName: viewState.colorTheme },
    });
    const components = viewer.plugin.managers.structure.hierarchy.current.structures.flatMap((structure) => structure.components || []);
    if (components.length < 1) throw new Error("molstar-representation-empty");
    await viewer.plugin.managers.structure.component.updateRepresentationsTheme(components, { color: viewState.colorTheme });
    await waitUntilIdle(viewer.plugin, 30_000);
    viewer.handleResize();
    viewer.plugin.canvas3d?.commit(true);
    viewer.plugin.canvas3d?.requestDraw();
    await nextFrame();
    await nextFrame();
    await delay(300);
    await nextFrame();
  }

  async function applyDraftFromControls() {
    if (!ready || saving) return;
    const previous = draftViewState;
    const next = normalizeViewState({
      representation: representationControl.value,
      colorTheme: colorThemeControl.value,
      interaction: draftViewState.interaction,
    });
    if (viewStatesEqual(previous, next)) return;
    setControlsDisabled(true);
    status.textContent = "Applying reproducible view state…";
    try {
      await applyViewState(next);
      draftViewState = next;
      await reportDraftState(`Mol* view ${next.representation}, ${next.colorTheme}`);
    } catch (error) {
      draftViewState = previous;
      status.textContent = `View change failed · ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      setControlsDisabled(false);
      syncControls();
    }
  }

  async function reportDraftState(summary) {
    const dirty = !viewStatesEqual(baseViewState, draftViewState);
    editorNote.textContent = dirty
      ? "Unsaved view changes. Representation, color, and saved highlights will become a new immutable version."
      : "Representation, color, and saved highlights match this version. Camera, zoom, hover, and exploratory selection stay in this session.";
    status.textContent = dirty ? "Unsaved view change" : "Observed · interactive";
    if (dirty) {
      runtimeDirty = true;
      await report("dirty", `Unsaved ${summary}`);
    } else if (runtimeDirty) {
      runtimeDirty = false;
      await report("clean", "Mol* view matches the current artifact version");
    }
  }

  async function pinExploratorySelection() {
    if (!ready || saving || exploratoryResidues.length < 1 || exploratoryResidues.length > 512) return;
    const nextInteraction = normalizeInteraction({
      residues: exploratoryResidues,
      focus: selectionRestoreFocus.checked ? exploratoryResidues[0] : null,
    });
    draftViewState = normalizeViewState({ ...draftViewState, interaction: nextInteraction });
    syncControls();
    await reportDraftState(`saved highlight with ${nextInteraction.residues.length} residues`);
  }

  function previewRangeSelection() {
    if (!ready || saving) return;
    const chain = selectionChain.value;
    const start = Number(selectionFrom.value);
    const end = Number(selectionTo.value);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      selectionSummary.textContent = "Enter a valid residue range.";
      return;
    }
    const minimum = Math.min(start, end);
    const maximum = Math.max(start, end);
    const matches = residueCatalog.filter((residue) => (residue.authAsymId || residue.labelAsymId) === chain
      && residue.authSeqId >= minimum && residue.authSeqId <= maximum);
    if (matches.length < 1) {
      selectionSummary.textContent = "No source residues match that chain and range.";
      return;
    }
    if (matches.length > 512) {
      selectionSummary.textContent = `Range resolves to ${matches.length} residues. Saved highlights are limited to 512.`;
      return;
    }
    selectResidues(matches, false);
    exploratoryResidues = currentSelectionResidues();
    syncControls();
    status.textContent = `Selected ${exploratoryResidues.length} residues · session only`;
  }

  function clearExploratorySelection() {
    selectResidues([], false);
    exploratoryResidues = [];
    syncControls();
    status.textContent = "Exploratory selection cleared · saved highlight unchanged";
  }

  async function saveVersion() {
    if (!ready || saving || viewStatesEqual(baseViewState, draftViewState)) return;
    saving = true;
    setControlsDisabled(true);
    status.textContent = "Saving immutable artifact version…";
    editorNote.textContent = "Saving the exact representation and color state. The conversation-origin version remains unchanged.";
    try {
      const result = await bridge.commitMolstar({
        schema: "agentlas.science-molstar-commit/v2",
        instanceId: request.instanceId,
        renderRequestId: request.renderRequestId,
        requestId: crypto.randomUUID(),
        artifactId: request.artifactId,
        artifactVersion: request.artifactVersion,
        artifactContentSha256: request.artifactContentSha256,
        viewState: draftViewState,
      });
      status.textContent = `Version v${result.artifact.currentVersion} saved`;
      editorNote.textContent = `v${result.artifact.currentVersion} saved. The Lab is reopening that immutable version; the conversation card stays on v${request.artifactVersion}.`;
      baseViewState = draftViewState;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = `Save failed · ${message}`;
      editorNote.textContent = message.includes("version-conflict")
        ? "The Lab advanced to another version. This view remains visible, but it was not saved."
        : "Save failed without changing the current artifact version.";
      saving = false;
      setControlsDisabled(false);
      syncControls();
    }
  }

  async function run() {
    setControlsDisabled(true);
    if (!bridge || typeof bridge.handshake !== "function" || typeof bridge.report !== "function" || typeof bridge.commitMolstar !== "function") throw new Error("renderer-preload-missing");
    request = await bridge.handshake();
    if (!request || request.schema !== "agentlas.science-renderer-request/v1" || request.binding?.rendererId !== "agentlas.molstar" || request.input?.kind !== "protein-structure") throw new Error("renderer-request-invalid");
    baseViewState = normalizeViewState(request.input);
    draftViewState = baseViewState;
    syncControls();
    await report("probing", "Checking Mol* and WebGL2");
    status.textContent = "Checking WebGL2…";
    if (!window.molstar?.Viewer || window.molstar.version !== "5.11.0") throw new Error("molstar-engine-version-mismatch");
    viewer = await window.molstar.Viewer.create("viewer", {
      extensions: [],
      layoutIsExpanded: false,
      layoutShowControls: false,
      layoutShowRemoteState: false,
      layoutShowSequence: false,
      layoutShowLog: false,
      viewportShowExpand: false,
      viewportShowToggleFullscreen: false,
      viewportShowSelectionMode: true,
      viewportShowAnimation: false,
      viewportShowControls: true,
      viewportBackgroundColor: "#ffffff",
      volumeStreamingDisabled: true,
      preferWebgl1: false,
      powerPreference: "high-performance",
    });
    await viewer.plugin.canvas3dInitialized;
    const webgl2 = viewer.plugin.canvas3dContext?.webgl?.isWebGL2 === true;
    if (!webgl2) throw new Error("molstar-webgl2-required");
    await report("rendering", "Parsing verified local structure bytes and applying stored view state");
    status.textContent = "Rendering verified structure…";
    const bytes = request.input?.bytes instanceof Uint8Array ? request.input.bytes : new Uint8Array(request.input?.bytes || []);
    if (bytes.byteLength < 1 || bytes.byteLength > 32 * 1024 * 1024) throw new Error("molstar-input-size-invalid");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    await viewer.loadStructureFromData(text, request.input.format, { dataLabel: `Agentlas ${request.artifactId}` });
    await waitUntilIdle(viewer.plugin, 30_000);
    if (viewer.plugin.managers.structure.hierarchy.current.structures.length < 1) throw new Error("molstar-structure-hierarchy-empty");
    await applyViewState(baseViewState);
    populateResidueControls();
    const storedInteractionSha256 = request.input.interactionSha256;
    const actualInteractionSha256 = request.input.interaction ? await interactionDigest(baseViewState.interaction) : null;
    if (actualInteractionSha256 !== storedInteractionSha256) throw new Error("molstar-interaction-hash-conflict");
    if (baseViewState.interaction.residues.length > 0) {
      selectResidues(baseViewState.interaction.residues, false);
      if (baseViewState.interaction.focus) focusResidues([baseViewState.interaction.focus]);
    } else {
      viewer.plugin.canvas3d?.requestCameraReset();
    }
    exploratoryResidues = [];
    selectionSubscription = viewer.plugin.managers.structure.selection.events.changed.subscribe(() => {
      if (applyingInteraction) return;
      exploratoryResidues = currentSelectionResidues();
      syncControls();
    });
    await waitUntilIdle(viewer.plugin, 10_000);
    await nextFrame();
    await nextFrame();
    await delay(250);
    const canvas = document.querySelector("canvas");
    if (!canvas || canvas.width < 1 || canvas.height < 1) throw new Error("molstar-canvas-missing");
    const sourceCounts = request.input.format === "pdb" ? pdbObservation(text) : null;
    const counts = {
      modelCount: sourceCounts?.modelCount || new Set(residueCatalog.map((residue) => residue.modelNum)).size,
      chainCount: new Set(residueCatalog.map((residue) => `${residue.modelNum}:${residue.operatorName}:${residue.authAsymId || residue.labelAsymId}`)).size,
      residueCount: residueCatalog.length,
      atomCount: sourceCounts?.atomCount || viewer.plugin.managers.structure.hierarchy.current.structures[0]?.cell?.obj?.data?.elementCount || 0,
    };
    if (counts.atomCount < 1) throw new Error("molstar-structure-empty");
    const sceneRevision = await sha256Text(JSON.stringify({
      artifact: request.artifactContentSha256,
      representation: baseViewState.representation,
      colorTheme: baseViewState.colorTheme,
      interactionSha256: storedInteractionSha256,
      counts,
    }));
    status.textContent = "Observed · interactive";
    status.dataset.ready = "true";
    ready = true;
    saving = false;
    setControlsDisabled(false);
    syncControls();
    await report("stable", "Mol* scene is stable, observable, and view-editable", {
      sceneRevision,
      observation: {
        kind: "protein-structure",
        engineVersion: window.molstar.version,
        webgl2,
        ...counts,
        representation: baseViewState.representation,
        colorTheme: baseViewState.colorTheme,
        interactionSha256: storedInteractionSha256,
        selectedResidueCount: baseViewState.interaction.residues.length,
        focusResolved: Boolean(baseViewState.interaction.focus),
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      },
    });
  }

  representationControl.addEventListener("change", () => { void applyDraftFromControls(); });
  colorThemeControl.addEventListener("change", () => { void applyDraftFromControls(); });
  selectionToggle.addEventListener("click", () => {
    const opening = selectionPanel.hidden;
    selectionPanel.hidden = !opening;
    selectionToggle.setAttribute("aria-expanded", opening ? "true" : "false");
    if (opening) selectionChain.focus();
  });
  selectionClose.addEventListener("click", () => {
    selectionPanel.hidden = true;
    selectionToggle.setAttribute("aria-expanded", "false");
    selectionToggle.focus();
  });
  selectionChain.addEventListener("change", syncRangeBounds);
  selectionPreview.addEventListener("click", previewRangeSelection);
  selectionClear.addEventListener("click", clearExploratorySelection);
  selectionFocus.addEventListener("click", () => {
    if (exploratoryResidues.length < 1) return;
    focusResidues(exploratoryResidues);
    status.textContent = `Focused ${exploratoryResidues.length} residues · camera only`;
  });
  selectionPin.addEventListener("click", () => { void pinExploratorySelection(); });
  resetViewButton.addEventListener("click", () => {
    viewer?.plugin?.canvas3d?.requestCameraReset();
    status.textContent = viewStatesEqual(baseViewState, draftViewState) ? "View reset · not versioned" : "View reset · saved view changes remain";
  });
  saveVersionButton.addEventListener("click", () => { void saveVersion(); });

  run().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    status.textContent = `Renderer failed · ${message}`;
    editorNote.textContent = "The renderer failed closed. No artifact version was changed.";
    setControlsDisabled(true);
    try { await report("failed", message, { code: message.split(":", 1)[0], renderRequestId: request?.renderRequestId || crypto.randomUUID() }); } catch {}
  });

  addEventListener("beforeunload", () => {
    try { selectionSubscription?.unsubscribe(); } catch {}
    selectionSubscription = null;
    try { viewer?.plugin?.dispose(); } catch {}
    viewer = null;
  });
})();
