"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";
import type { OneSurfaceMapBlock } from "@shared/one-surface";
import styles from "./OneLiveMap.module.css";
import { resolveCssColour } from "@/lib/design-tokens";

type Location = OneSurfaceMapBlock["locations"][number];

const DEFAULT_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const MAPLIBRE_WORKER_PATH = "vendor/maplibre-gl/maplibre-gl-worker.mjs";

function resolveMapLibreWorkerUrl(): string {
  const current = new URL(window.location.href);
  if (current.protocol === "file:") {
    return new URL(`./${MAPLIBRE_WORKER_PATH}`, document.baseURI).href;
  }
  return new URL(`/${MAPLIBRE_WORKER_PATH}`, current.origin).href;
}

function orderedLocations(locations: Location[]): Location[] {
  return [...locations].sort((left, right) => (
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)
  ));
}

function asGeoJson(locations: Location[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = locations.map((location, index) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [location.longitude, location.latitude] },
    properties: {
      locationRef: location.locationRef,
      label: location.label,
      sequence: location.sequence ?? index + 1,
    },
  }));
  if (locations.length > 1) {
    features.unshift({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: locations.map((location) => [location.longitude, location.latitude]),
      },
      properties: { kind: "route" },
    });
  }
  return { type: "FeatureCollection", features };
}

function fitLocations(map: MapLibreMap, locations: Location[], animate: boolean): void {
  if (locations.length === 0) return;
  if (locations.length === 1) {
    map[animate ? "easeTo" : "jumpTo"]({
      center: [locations[0].longitude, locations[0].latitude],
      zoom: 13,
      duration: animate ? 550 : 0,
    });
    return;
  }
  const first = locations[0];
  const bounds: [[number, number], [number, number]] = [
    [first.longitude, first.latitude],
    [first.longitude, first.latitude],
  ];
  for (const location of locations.slice(1)) {
    bounds[0][0] = Math.min(bounds[0][0], location.longitude);
    bounds[0][1] = Math.min(bounds[0][1], location.latitude);
    bounds[1][0] = Math.max(bounds[1][0], location.longitude);
    bounds[1][1] = Math.max(bounds[1][1], location.latitude);
  }
  map.fitBounds(bounds, { padding: 54, maxZoom: 14, duration: animate ? 650 : 0 });
}

export function OneLiveMap({
  block,
  locale,
  compact = false,
  fill = false,
}: {
  block: OneSurfaceMapBlock;
  locale: "ko" | "en";
  /** Right-sidebar rendering stacks the map and stops in the narrow rail. */
  compact?: boolean;
  fill?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<{ remove: () => void } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const ordered = useMemo(() => orderedLocations(block.locations), [block.locations]);
  const geoJson = useMemo(() => asGeoJson(ordered), [ordered]);
  const styleUrl = process.env.NEXT_PUBLIC_AGENTLAS_MAP_STYLE_URL?.trim() || DEFAULT_STYLE_URL;

  const selectLocation = useCallback((location: Location) => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ center: [location.longitude, location.latitude], zoom: Math.max(map.getZoom(), 13), duration: 550 });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || ordered.length === 0) {
      setState("error");
      return;
    }
    let disposed = false;
    let styleReady = false;
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeObserver: ResizeObserver | null = null;
    setState("loading");

    void import("maplibre-gl").then((maplibre) => {
      if (disposed) return;
      // Next compiles MapLibre's import.meta.url to its source file URL. In a
      // bundled renderer that makes the library's default worker URL empty,
      // leaving only the WebGL shell alive. Pin the matching worker and shared
      // module copied from the installed package into the app's public assets.
      maplibre.setWorkerUrl(resolveMapLibreWorkerUrl());
      const map = new maplibre.Map({
        container,
        style: styleUrl,
        center: [ordered[0].longitude, ordered[0].latitude],
        zoom: ordered.length === 1 ? 13 : 9,
        cooperativeGestures: false,
        fadeDuration: 120,
      });
      mapRef.current = map;
      map.addControl(new maplibre.NavigationControl({ visualizePitch: true }), "top-right");
      map.addControl(new maplibre.ScaleControl({ maxWidth: 90, unit: "metric" }), "bottom-left");
      loadTimer = setTimeout(() => {
        if (!disposed && !styleReady) setState("error");
      }, 12_000);
      // `load` waits for the initial viewport's source tiles as well. An
      // embedded result should become interactive as soon as the basemap style
      // is ready and let vector tiles continue filling progressively.
      map.once("style.load", () => {
        if (disposed) return;
        styleReady = true;
        if (loadTimer) clearTimeout(loadTimer);
        map.addSource("one-live-locations", { type: "geojson", data: geoJson });
        map.addLayer({
          id: "one-live-route",
          type: "line",
          source: "one-live-locations",
          filter: ["==", ["geometry-type"], "LineString"],
          paint: {
            "line-color": resolveCssColour("var(--ok)"),
            "line-width": 4,
            "line-opacity": 0.84,
          },
          layout: { "line-cap": "round", "line-join": "round" },
        });
        map.addLayer({
          id: "one-live-points",
          type: "circle",
          source: "one-live-locations",
          filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-radius": 10,
            "circle-color": resolveCssColour("var(--white)"),
            "circle-stroke-color": resolveCssColour("var(--ok)"),
            "circle-stroke-width": 4,
          },
        });
        map.addLayer({
          id: "one-live-labels",
          type: "symbol",
          source: "one-live-locations",
          filter: ["==", ["geometry-type"], "Point"],
          layout: {
            "text-field": ["to-string", ["get", "sequence"]],
            "text-size": 12,
            "text-font": ["Noto Sans Regular"],
            "text-allow-overlap": true,
          },
          paint: { "text-color": resolveCssColour("var(--ink)") },
        });
        const showPopup = (event: MapLayerMouseEvent) => {
          const feature = event.features?.[0];
          if (!feature || feature.geometry.type !== "Point") return;
          popupRef.current?.remove();
          const popup = new maplibre.Popup({ closeButton: false, closeOnClick: true, offset: 14 })
            .setLngLat(feature.geometry.coordinates as [number, number])
            .setText(String(feature.properties?.label ?? ""))
            .addTo(map);
          popupRef.current = popup;
        };
        map.on("click", "one-live-points", showPopup);
        map.on("mouseenter", "one-live-points", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "one-live-points", () => { map.getCanvas().style.cursor = ""; });
        fitLocations(map, ordered, false);
        setState("ready");
      });
      // MapLibre emits `error` for recoverable tile/glyph requests while the
      // style is otherwise usable. Treating `!map.loaded()` as fatal here is
      // incorrect because it is also false during ordinary incremental tile
      // loading. The initial style timeout above and WebGL context loss below
      // are the authoritative terminal failures.
      map.on("error", (event) => {
        const error = event.error;
        container.dataset.mapLastError = error instanceof Error ? error.message : String(error ?? "unknown map error");
      });
      map.getCanvas().addEventListener("webglcontextlost", () => {
        if (!disposed) setState("error");
      }, { once: true });
      resizeObserver = new ResizeObserver(() => map.resize());
      resizeObserver.observe(container);
    }).catch(() => {
      if (!disposed) setState("error");
    });

    return () => {
      disposed = true;
      if (loadTimer) clearTimeout(loadTimer);
      resizeObserver?.disconnect();
      popupRef.current?.remove();
      popupRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  // `attempt` intentionally reconstructs the WebGL context after an explicit retry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, styleUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || state !== "ready") return;
    const source = map.getSource("one-live-locations");
    if (source && "setData" in source && typeof source.setData === "function") source.setData(geoJson);
    fitLocations(map, ordered, true);
  }, [geoJson, ordered, state]);

  return (
    <div className={styles.layout} data-map-state={state} data-compact={compact ? "true" : "false"} data-fill={fill ? "true" : "false"}>
      <div className={styles.stage}>
        <div ref={containerRef} className={styles.map} role="application" aria-label={locale === "ko" ? `${block.title} 실시간 지도` : `${block.title} live map`} />
        {state === "loading" && <div className={styles.overlay} role="status"><span />{locale === "ko" ? "실제 지도를 불러오는 중…" : "Loading live map…"}</div>}
        {state === "error" && <div className={styles.overlay} role="alert"><strong>{locale === "ko" ? "지도 연결을 확인해 주세요" : "Check the map connection"}</strong><small>{locale === "ko" ? "좌표 그림으로 대체하지 않습니다. 연결되면 이동·확대 가능한 실제 지도가 열립니다." : "No coordinate drawing fallback. Retry to load the interactive map."}</small><button type="button" onClick={() => setAttempt((value) => value + 1)}>{locale === "ko" ? "다시 연결" : "Retry"}</button></div>}
        {state === "ready" && <span className={styles.liveBadge}><i />{locale === "ko" ? "실시간 지도" : "Live map"}</span>}
      </div>
      <ol className={styles.locations} aria-label={locale === "ko" ? "지도 위치" : "Map locations"}>
        {ordered.map((location, index) => <li key={location.locationRef}>
          <button type="button" onClick={() => selectLocation(location)}>
            <b>{location.sequence ?? index + 1}</b>
            <span><strong>{location.label}</strong><small>{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}</small></span>
          </button>
        </li>)}
      </ol>
    </div>
  );
}
