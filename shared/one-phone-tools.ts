/** The descriptions are fixed release content; the host owns all device authority. */
export const ONE_PHONE_TOOL_MODULE = {
  id: "one.phone.tools",
  revision: 1,
  stability: "fixed-policy",
  changeTriggers: ["release"],
  order: 0,
} as const;

export const ONE_PHONE_TOOLS = [
  {
    name: "phone_location_get",
    description: "Get the phone's current area, rounded to about 1 km. The phone or permission may be unavailable.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "phone_device_context",
    description: "Get the phone's time zone, language, battery, charging state and network type when available.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

export function personalOnePhoneToolName(name: string): "phone.location.get" | "phone.device.context" | null {
  return name === "phone_location_get" || name === "phone.location.get" ? "phone.location.get"
    : name === "phone_device_context" || name === "phone.device.context" ? "phone.device.context" : null;
}
