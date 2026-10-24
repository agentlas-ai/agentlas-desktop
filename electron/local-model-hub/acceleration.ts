import type { LocalEngineDevice, LocalModelAccelerationEvidence, LocalModelAccelerator } from "../../shared/local-model-hub";

/**
 * Acceleration is never inferred from the host alone. The engine's own
 * `--list-devices` listing and its load log (`--log-jsonl -lv 4`) are the only
 * evidence that a GPU backend was actually loaded and that layers were placed
 * on it. Measured on macOS 2026-09-13: 29/29 layers on "MTL0 (Apple M4 Max)",
 * 294 tokens/s for Qwen3-0.6B Q8_0; the same launch without evidence parsing
 * showed nothing at all.
 */

const DEVICE_LINE = /^\s*([A-Za-z]+[0-9]*):\s+(.+?)\s+\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/;
const USING_DEVICE = /using device ([A-Za-z]+[0-9]*) \((.+?)\)(?: \([^)]*\))? - (\d+) MiB free/;
const OFFLOADED = /offloaded (\d+)\/(\d+) layers to GPU/;
const MAX_TEXT = 1_048_576;

export function acceleratorForDevice(deviceId: string): LocalModelAccelerator | "unknown" {
  const family = /^([A-Za-z]+)/.exec(deviceId)?.[1]?.toLowerCase() ?? "";
  if (family === "mtl" || family === "metal") return "metal";
  if (family === "vulkan") return "vulkan";
  if (family === "cuda") return "cuda";
  if (family === "rocm" || family === "hip") return "rocm";
  if (family === "openvino") return "openvino";
  if (family === "blas" || family === "cpu") return "cpu";
  return "unknown";
}

/** GPU means a backend that places model layers in device memory; BLAS/CPU do not. */
export function deviceIsGpu(deviceId: string): boolean {
  const accelerator = acceleratorForDevice(deviceId);
  return accelerator === "metal" || accelerator === "vulkan" || accelerator === "cuda" || accelerator === "rocm";
}

/** Parses `llama-server --list-devices` output. Unknown lines are ignored; nothing is invented. */
export function parseEngineDeviceList(text: string): LocalEngineDevice[] {
  const devices: LocalEngineDevice[] = [];
  for (const line of text.slice(0, MAX_TEXT).split(/\r?\n/)) {
    const match = DEVICE_LINE.exec(line);
    if (!match) continue;
    const [, id, name, total, free] = match;
    if (!id || !name || devices.length >= 32) continue;
    devices.push({
      id, name: name.slice(0, 120), accelerator: acceleratorForDevice(id), gpu: deviceIsGpu(id),
      memoryBytes: Number(total) * 1_048_576, freeMemoryBytes: Number(free) * 1_048_576,
    });
  }
  return devices;
}

function logMessages(text: string): string[] {
  const messages: string[] = [];
  for (const line of text.slice(0, MAX_TEXT).split(/\r?\n/)) {
    if (!line.startsWith("{")) { messages.push(line); continue; }
    try {
      const row = JSON.parse(line) as { msg?: unknown };
      if (typeof row.msg === "string") messages.push(row.msg);
    } catch { messages.push(line); }
  }
  return messages;
}

/**
 * Parses the resident server's own load log. `gpu` is true only when the log
 * proves at least one layer was placed on a GPU device; a GPU that was listed
 * but received zero layers is reported honestly as CPU execution.
 */
export function parseEngineLoadLog(text: string): LocalModelAccelerationEvidence {
  const devices: LocalEngineDevice[] = [];
  let offloadedLayers: number | null = null;
  let totalLayers: number | null = null;
  for (const message of logMessages(text)) {
    const using = USING_DEVICE.exec(message);
    if (using?.[1] && using[2] && !devices.some(device => device.id === using[1]) && devices.length < 32) {
      devices.push({
        id: using[1], name: using[2].slice(0, 120), accelerator: acceleratorForDevice(using[1]), gpu: deviceIsGpu(using[1]),
        memoryBytes: null, freeMemoryBytes: Number(using[3]) * 1_048_576,
      });
    }
    const offloaded = OFFLOADED.exec(message);
    if (offloaded) { offloadedLayers = Number(offloaded[1]); totalLayers = Number(offloaded[2]); }
  }
  const gpuDevice = devices.find(device => device.gpu) ?? null;
  const gpu = !!gpuDevice && offloadedLayers !== null && offloadedLayers > 0;
  return {
    evidence: "engine-log",
    backend: gpu ? gpuDevice!.accelerator : devices.length || offloadedLayers !== null ? "cpu" : "unknown",
    gpu,
    devices,
    offloadedLayers,
    totalLayers,
  };
}
