// Input schemas of the reach.* harness operations. Kept apart from ports.ts so that registering the operations loads nothing else:
// capability-ports.ts imports this file at start-up, the handlers are imported lazily on first call.

export const REACH_PORT_SCHEMAS = {
  map: {
    type: "object",
    properties: {
      query: { type: "string", description: "part of an app name, to filter the list" },
      level: { type: "string", enum: ["scriptable", "partial", "unmapped"], description: "scriptable = usable now; partial = something found; unmapped = nothing yet" },
      limit: { type: "integer", minimum: 1, maximum: 60 },
      offset: { type: "integer", minimum: 0 },
    },
  },
  app: {
    type: "object",
    required: ["app"],
    properties: {
      app: { type: "string", description: "an app key from reach.map (bundle:com.apple.Notes) or its name" },
      search: { type: "string", description: "part of a capability name" },
      tier: { type: "string", enum: ["published", "app-protocol", "external-tool", "structure", "explored"] },
      usable: { type: "boolean", description: "only capabilities an agent can rely on" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      offset: { type: "integer", minimum: 0 },
    },
  },
  describe: {
    type: "object",
    required: ["app", "capability"],
    properties: { app: { type: "string" }, capability: { type: "string", description: "a capability id from reach.app, or its exact name" } },
  },
  invoke: {
    type: "object",
    required: ["app", "capability"],
    properties: {
      app: { type: "string" },
      capability: { type: "string" },
      parameters: { type: "object", description: "values for the capability's parameters, exactly as reach.describe lists them" },
    },
  },
  explore: {
    type: "object",
    required: ["app"],
    properties: { app: { type: "string", description: "a RUNNING app; it is brought to the front for a moment and its dialogs are opened and closed again" } },
  },
  verify: {
    type: "object",
    required: ["app", "capability"],
    properties: { app: { type: "string" }, capability: { type: "string" } },
  },
  status: { type: "object", properties: {} },
  learn: {
    type: "object",
    required: ["app", "name", "steps", "succeeded", "check"],
    properties: {
      app: { type: "string", description: "an app key from reach.map or its name" },
      name: { type: "string", description: "a short phrase naming the work, like a function name (3 to 60 characters)" },
      description: { type: "string" },
      succeeded: { type: "boolean", description: "true only if the work really succeeded" },
      check: {
        type: "object",
        required: ["kind", "role"],
        description: "how a later run can tell the work is done: a control that is present, or whose value changed. label may be empty for a control with no caption",
        properties: { kind: { type: "string", enum: ["element-present", "element-value-changed"] }, role: { type: "string" }, label: { type: "string" } },
      },
      steps: {
        type: "array",
        description: "what was done on the screen, in order. Typed text is not stored: it becomes a parameter. Never include a password or card field.",
        items: {
          type: "object",
          required: ["op"],
          properties: {
            op: { type: "string", enum: ["click", "type", "set_value", "key"] },
            role: { type: "string", description: "the control's role from get_app_state" },
            label: { type: "string", description: "the control's caption" },
            key: { type: "string", description: "for op key" },
            path: { type: "array", items: { type: "string" }, description: "captions of the parents, innermost first (optional)" },
            nearby: { type: "array", items: { type: "string" }, description: "captions of neighbouring controls (optional)" },
            nth: { type: "integer", minimum: 0 },
            ok: { type: "boolean" },
          },
        },
      },
    },
  },
} as const;
