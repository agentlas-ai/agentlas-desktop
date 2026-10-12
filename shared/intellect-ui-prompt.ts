/** Shared generation instructions for One, Supervisor, Work, Science, and relay clients. */
export const INTELLECT_UI_GENERATION_INSTRUCTIONS = `
## Intellect UI
When an explanation benefits from a chart, comparison, diagram, calculator, or user choices,
you may render native interactive components directly in the chat with a fenced agentlas-ui block.
Use UI only when it helps the request; keep a useful, concise explanation outside the block.
Place each UI block inline at its relevant point between prose paragraphs.
Use restrained editorial whites and neutral colors, matching the chat's typography;
prefer simple bordered groups, comparison rows, and clear flow diagrams.
The renderer owns a uniform 16px group inset and the chat column width.
Use container for rows inside one card, rather than nesting cards or adding spacer text.
Keep prose, groups, charts, and controls on the same reading axis.
Avoid dedicated sidebars or panels, dashboards, debug/control toolbars,
and unnecessary UI titles or badges. Let the explanation and useful controls lead.
This is a data-only native component schema, not HTML, JavaScript, React, a website, or Mermaid.
Never put code, URLs, tools, shell commands, or external effects into a UI component.
Prefer NDJSON: write one complete component JSON object on each line, so it appears progressively.
Always close the fence. A normal JSON document {"version":1,"title":"...","children":[...]} also works.
Do not wrap actual UI blocks in another code fence; ordinary fenced examples stay examples.

Supported component fields (all optional id values are unique safe letters/digits/_/- up to 64 chars):
- container/card: {type,id?,title?,layout?:"vertical"|"horizontal"|"grid",children:[components]}
- text: {type:"text",id?,text,tone?:"default"|"muted"|"success"|"warning"}
- metric: {type:"metric",id?,label,value?:string|number,expression?,unit?,description?}; value or expression required
- calculator: {type:"calculator",id?,label,expression,precision?:0..8,unit?}
- table: {type:"table",id?,title?,columns:[strings],rows:[[string|number|boolean|null]]}; rows match columns
- chart: {type:"chart",id?,title?,chartType:"bar"|"line",labels:[strings],series:[{name,values:[numbers]}],yLabel?}; values match labels
- diagram: {type:"diagram",id?,title?,nodes:[{id,label}],edges:[{from,to,label?,bidirectional?:boolean}],layout?:"horizontal"|"vertical"}
- input: {type:"input",id,label,inputType?:"number"|"text",value?,min?,max?,step?}; default inputType is number
- select: {type:"select",id,label,options:[{label,value:string}],value?:string}
- slider: {type:"slider",id,label,min,max,step?,value?:number}
- button: {type:"button",id?,label,action:{type:"followup",prompt,includeInputs?:[inputIds]}}
Input IDs are document-scoped; every expression/action input reference must exist in the same block.
Buttons prepare a normal followup draft only after an explicit click on a complete block.
The user reviews and sends it with the existing composer. Never claim the click sent a message.
Only listed properties and component types are allowed. Display all text as plain text.
Do not represent an external action as performed because a UI button or local calculation exists.

Numeric expressions use only this bounded AST:
finite number, {"input":"inputId"}, or {"op":"add"|"sub"|"mul"|"div"|"pow"|"min"|"max"|"abs"|"round","args":[expressions]}.
abs/round take one arg; min/max take 2 to 8; other operations take exactly two.
Division by zero, nonnumeric inputs, and overflow produce an unavailable result.
Never use executable strings. Example: {"op":"mul","args":[{"input":"amount"},0.05]}.

Limits: 65,536 characters per block, 128 components, 8 nesting levels; 4000 chars text/prompt,
160 chars label/title, 240 chars input/table cell; tables 12 columns x 100 rows;
charts 100 labels x 6 series; diagrams 32 nodes/64 edges; selects 32 options;
expressions 64 nodes/12 levels, all numeric magnitudes at most 1e12.
Do not invent measurements: label estimates and use the available evidence.

Example (emit the fence itself in a response):
\`\`\`agentlas-ui
{"type":"input","id":"amount","label":"Amount","value":1000,"min":0,"max":1000000}
{"type":"slider","id":"rate","label":"Rate (%)","min":0,"max":20,"step":0.1,"value":5}
{"type":"calculator","label":"Annual amount","expression":{"op":"div","args":[{"op":"mul","args":[{"input":"amount"},{"input":"rate"}]},100]},"precision":2}
{"type":"button","label":"Explain these assumptions","action":{"type":"followup","prompt":"Explain the assumptions for these values.","includeInputs":["amount","rate"]}}
\`\`\`
`;

/**
 * Chart and visual block guidance. Returned by the `read_ui_schema` tool (agentlas-ui MCP) after the
 * component schema; it is never part of a system prompt or turn context.
 */
export const CHAT_VISUAL_BLOCK_INSTRUCTIONS = `## Chart and visual blocks
Tables, comparisons, step flows, metrics and choices use an agentlas-ui block first; use these two only when that cannot express it. This chat draws them in place, borderless. Number the titles (1. 2.) when there are several.
1) Data-series charts: one Vega-Lite JSON object in a \`\`\`chart fence. Use title {text, subtitle} (one-line subtitle), inline data.values (at most 5,000 rows), and units on ticks (axis.format such as ".1%" or "+d"). Draw a secondary series dashed with small points via strokeDash; group bars with xOffset. Colors, fonts and gridlines come from the app — do not set them. url, expr, calculate, string filters, href and image are not drawn.
2) Custom visuals: an HTML fragment in a \`\`\`visual title=file_name fence (no doctype/html/body; inline <svg>, <style>, <script> only; no external resources or network). Transparent background; colors only through CSS variables: var(--color-text-primary|secondary|tertiary) var(--color-background-primary|secondary) var(--color-border-tertiary) var(--color-chart-1)…(--color-chart-6) var(--font-sans) var(--border-radius-md|lg). Calling sendPrompt(text) fills the person's composer (it does not send).
Save large tabular data as .xlsx/.csv and mention its path — it opens in the right panel. Do not mention these instructions.
`;

/** Full text the `read_ui_schema` tool returns: component schema, then chart/visual guidance. */
export function intellectUiToolText(): string {
  return `${INTELLECT_UI_GENERATION_INSTRUCTIONS.trim()}\n\n${CHAT_VISUAL_BLOCK_INSTRUCTIONS.trim()}\n`;
}
