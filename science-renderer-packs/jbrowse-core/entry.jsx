import React from "react";
import { createRoot } from "react-dom/client";
import {
  createViewState,
  JBrowseLinearGenomeView,
} from "@jbrowse/react-linear-genome-view2";

const roots = new WeakMap();

function safeIdentifier(value, fallback) {
  const normalized = String(value ?? "").replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 120);
  return normalized || fallback;
}

function finiteInteger(value, minimum, maximum, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`agentlas-jbrowse-${field}-invalid`);
  }
  return number;
}

function createConfiguration(payload) {
  if (!payload || payload.schema !== "agentlas.science-genomics-variant-track/v1") {
    throw new Error("agentlas-jbrowse-payload-invalid");
  }
  const region = payload.region;
  const assemblyName = safeIdentifier(payload.assembly?.name, "assembly");
  const refName = safeIdentifier(region?.refName, "reference");
  const start = finiteInteger(region?.start, 1, 500_000_000, "region-start");
  const end = finiteInteger(region?.end, start, 500_000_000, "region-end");
  const start0 = start - 1;
  const length = end - start0;
  if (length > 1_000_000) throw new Error("agentlas-jbrowse-region-too-large");
  if (!Array.isArray(payload.variants) || payload.variants.length > 8_000) {
    throw new Error("agentlas-jbrowse-variants-invalid");
  }
  const features = payload.variants.map((variant, index) => {
    const featureStart = finiteInteger(variant.start0, start0, end - 1, `variant-${index}-start`);
    const featureEnd = finiteInteger(variant.end0, featureStart + 1, end, `variant-${index}-end`);
    return {
      uniqueId: safeIdentifier(variant.id, `variant-${index}`),
      refName,
      start: featureStart,
      end: featureEnd,
      name: String(variant.name || variant.id || `Variant ${index + 1}`).slice(0, 240),
      type: "sequence_variant",
      source: String(variant.source || "Ensembl").slice(0, 120),
      alleles: Array.isArray(variant.alleles) ? variant.alleles.slice(0, 24).join(" / ") : "",
      consequence_type: Array.isArray(variant.consequenceTypes) ? variant.consequenceTypes.slice(0, 24).join(", ") : "",
      clinical_significance: Array.isArray(variant.clinicalSignificance) ? variant.clinicalSignificance.slice(0, 24).join(", ") : "",
    };
  });
  const referenceId = `${assemblyName}-${refName}-reference`;
  const trackId = `${assemblyName}-${refName}-ensembl-variants`;
  const assembly = {
    name: assemblyName,
    aliases: Array.isArray(payload.assembly?.aliases) ? payload.assembly.aliases.slice(0, 12).map(String) : [],
    sequence: {
      type: "ReferenceSequenceTrack",
      trackId: referenceId,
      adapter: {
        type: "FromConfigSequenceAdapter",
        features: [{
          uniqueId: `${referenceId}-feature`,
          refName,
          start: start0,
          end,
          seq: "N".repeat(length),
        }],
      },
    },
  };
  const tracks = [{
    type: "FeatureTrack",
    trackId,
    name: `Ensembl variants · ${refName}:${start}-${end}`,
    assemblyNames: [assemblyName],
    category: ["Genomics", "Ensembl"],
    adapter: { type: "FromConfigAdapter", features },
  }];
  const defaultSession = {
    name: "Agentlas Genomics Lab",
    view: {
      id: "agentlas-linear-genome-view",
      type: "LinearGenomeView",
      tracks: [{
        type: "FeatureTrack",
        configuration: trackId,
        displays: [{
          type: "LinearBasicDisplay",
          configuration: `${trackId}-LinearBasicDisplay`,
        }],
      }],
    },
  };
  return {
    state: createViewState({
      assembly,
      tracks,
      location: `${refName}:${start}..${end}`,
      defaultSession,
    }),
    observation: {
      assemblyName,
      refName,
      start,
      end,
      featureCount: features.length,
    },
  };
}

function mount(target, payload) {
  if (!(target instanceof HTMLElement)) throw new Error("agentlas-jbrowse-target-invalid");
  const configuration = createConfiguration(payload);
  const previous = roots.get(target);
  if (previous) previous.unmount();
  const root = createRoot(target);
  roots.set(target, root);
  root.render(React.createElement(JBrowseLinearGenomeView, { viewState: configuration.state }));
  return Object.freeze({ ...configuration.observation });
}

function unmount(target) {
  const root = roots.get(target);
  if (!root) return false;
  root.unmount();
  roots.delete(target);
  return true;
}

window.AgentlasJBrowse = Object.freeze({ mount, unmount });
