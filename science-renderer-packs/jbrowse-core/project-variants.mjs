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

export function projectVariantTrack(payload) {
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
    const rawStart = finiteInteger(variant.start0, 0, 500_000_000, `variant-${index}-start`);
    const rawEnd = finiteInteger(variant.end0, 0, 500_000_000, `variant-${index}-end`);
    const isInsertion = rawStart === rawEnd && Number(variant.end) === Number(variant.start) - 1;
    const overlapsViewport = isInsertion
      ? rawStart >= start0 && rawStart < end
      : rawEnd > start0 && rawStart < end;
    if (rawEnd < rawStart || rawEnd === rawStart && !isInsertion || !overlapsViewport) {
      throw new Error(`agentlas-jbrowse-variant-${index}-coordinates-invalid`);
    }
    const featureStart = Math.max(start0, Math.min(end - 1, rawStart));
    const featureEnd = isInsertion
      ? featureStart + 1
      : Math.max(featureStart + 1, Math.min(end, rawEnd));
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
      coordinate_kind: isInsertion ? "insertion" : "interval",
      ensembl_start_1based: Number(variant.start),
      ensembl_end_1based: Number(variant.end),
    };
  });
  return Object.freeze({ assemblyName, refName, start, end, start0, length, features });
}
