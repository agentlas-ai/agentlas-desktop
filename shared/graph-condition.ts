/** One vocabulary for authoring, patching and running graph conditions. */
export const CONDITION_OPS = ["truthy", "falsy", "eq", "ne", "gt", "gte", "lt", "lte", "contains"] as const;
/** The condition forms understood by the graph runner, including saved legacy expressions. */
export function parseGraphCondition(config: Record<string, unknown>):
  | { ok: true; variable: string; op: string; value: unknown }
  | { ok: false } {
  let variable = typeof config.var === "string" ? config.var : "";
  let op = typeof config.op === "string" ? config.op : "truthy";
  let value = config.value;
  if (!variable) {
    const expression = typeof config.expression === "string" ? config.expression.trim() : "";
    const comparison = expression.match(/^\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}\s*(===|!==|==|!=)\s*(["'])(.*?)\3$/);
    const numeric = expression.match(/^\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}\s*(>=|<=|>|<)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/);
    const bare = expression.match(/^\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}$/);
    if (comparison) {
      variable = comparison[1];
      op = comparison[2] === "===" || comparison[2] === "==" ? "eq" : "ne";
      value = comparison[4];
    } else if (numeric && Number.isFinite(Number(numeric[3]))) {
      variable = numeric[1];
      op = ({ ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" } as Record<string, string>)[numeric[2]];
      value = Number(numeric[3]);
    } else if (bare) {
      variable = bare[1];
      op = "truthy";
    }
  }
  return variable && variable.trim() && (CONDITION_OPS as readonly string[]).includes(op)
    ? { ok: true, variable, op, value } : { ok: false };
}
