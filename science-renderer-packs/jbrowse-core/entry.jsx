import React from "react";
import { createRoot } from "react-dom/client";
import {
  createViewState,
  JBrowseLinearGenomeView,
} from "@jbrowse/react-linear-genome-view2";
import { projectVariantTrack } from "./project-variants.mjs";

const roots = new WeakMap();

function createConfiguration(payload) {
  const { assemblyName, refName, start, end, start0, length, features } = projectVariantTrack(payload);
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
