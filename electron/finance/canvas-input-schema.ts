/**
 * The JSON schema of the result-card input, shared by every port that draws a card (ui.canvas and its alias finance.present). The 12 block
 * types are the canvas's (shared/canvas/schema.ts); only the `guide` property differs by port, so the caller passes it.
 * `assets` (ui.canvas only) adds the open entry for asset blocks (shared/canvas/blocks, read from ui.asset.catalog) and makes `sources`
 * optional: a card of assets alone names none. Without it the schema is byte for byte the one finance.present has always sent.
 */
const BASE_TYPES = ['kpis', 'bars', 'ranges', 'chart', 'leans', 'table', 'heatmap', 'allocation', 'timeline', 'checklist', 'gauge', 'note'];
const schema = (required: string[], properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required, properties });
const key = { type: 'string', minLength: 1, maxLength: 200 };

export function canvasInputJsonSchema(guide: Record<string, unknown>, options: { assets?: boolean } = {}): Record<string, unknown> {
    const s = (maxLength: number) => ({ type: 'string', maxLength }), amount = { type: ['number', 'string'] }, units = { enum: ['usd', 'usd_per_share', 'percent', 'count', 'x', 'bp', 'krw', 'eur', 'jpy', 'gbp', 'cny', 'text'] }, tones = { enum: ['up', 'down', 'warn', 'info', 'neutral'] };
    const common = { title: s(80), width: { enum: ['full', 'two_thirds', 'half', 'third'] } }, day = { type: 'string', format: 'date' };
    const blockOf = (type: string, required: string[], properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: ['type', ...required], properties: { type: { const: type }, ...common, ...properties } });
    const assetBlock = { type: 'object', additionalProperties: true, required: ['type'], properties: { type: { type: 'string', not: { enum: BASE_TYPES }, description: 'An asset type from ui.asset.catalog (documents, file thumbnails, charts, tables, diagrams, motion stills, slides); its fields are the sample there.' }, ...common } };
    return { type: 'object', additionalProperties: false, required: options.assets ? ['title', 'blocks'] : ['title', 'blocks', 'sources'], properties: {
      title: s(80), badge: { ...s(12), description: 'A ticker or region.' }, meta: s(120),
      chips: { type: 'array', maxItems: 4, items: schema(['text'], { text: s(60), tone: tones, icon: { enum: ['up', 'down', 'clock', 'alert', 'target', 'check', 'none'] } }) },
      guide,
      lead: { ...schema([], { asked: { ...s(60), description: 'The owner\'s word for the entity, when it differs (Halo).' }, matched: { ...s(120), examples: ['Halozyme Therapeutics · HALO'] } }), description: 'What the owner\'s words were matched to; omit when nothing was resolved.' },
      blocks: { type: 'array', minItems: 1, maxItems: 12, items: { oneOf: [
        blockOf('kpis', ['items'], { items: { type: 'array', minItems: 1, maxItems: 6, items: schema(['label', 'value'], { label: s(40), value: amount, unit: units, prior: amount, change: { type: 'number', description: 'Percent; computed from prior when omitted.' }, note: s(60), tone: tones }) } }),
        blockOf('bars', ['rows'], { unit: units, series: { type: 'array', maxItems: 2, items: s(30) }, rows: { type: 'array', minItems: 1, maxItems: 12, items: schema(['label', 'values'], { label: s(40), values: { type: 'array', minItems: 1, maxItems: 2, items: amount }, note: s(40) }) } }),
        blockOf('ranges', ['items'], { unit: units, change: { enum: ['raised', 'maintained', 'lowered', 'new', null] }, items: { type: 'array', minItems: 1, maxItems: 5, items: schema(['label', 'low', 'high'], { label: s(40), low: amount, high: amount, unit: units, marker: amount, markerLabel: s(24) }) } }),
        blockOf('chart', ['series'], { series: { type: 'array', minItems: 1, maxItems: 4, items: schema([], { assetId: { ...key, description: 'price_history: an asset finance.search returned or a saved one.' }, metric: { enum: ['price_history', 'macro_series', 'fx_rates'] }, query: { ...s(80), description: 'macro_series: a FRED id; fx_rates: BASE/QUOTE.' }, label: s(40) }) }, period: { enum: ['1M', '3M', '1Y', '5Y', 'all'] }, mode: { enum: ['level', 'change'] }, from: day, annotations: { type: 'array', maxItems: 4, items: schema(['date', 'label'], { date: day, label: s(36) }) } }),
        blockOf('leans', ['rows'], { rows: { type: 'array', minItems: 1, maxItems: 10, items: schema(['name', 'direction', 'low', 'high', 'reason'], { name: s(48), direction: { enum: ['supportive', 'pressure', 'mixed', 'unclear', 'depends'] }, low: { type: 'number', minimum: -2, maximum: 2 }, high: { type: 'number', minimum: -2, maximum: 2 }, reason: s(160) }) } }),
        blockOf('table', ['columns', 'rows'], { columns: { type: 'array', minItems: 1, maxItems: 8, items: schema(['label'], { label: s(30), format: { enum: ['text', 'number', 'usd', 'percent', 'change', 'multiple'] } }) }, rows: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'array', maxItems: 8, items: { type: ['string', 'number', 'null'] } } } }),
        blockOf('heatmap', ['rows', 'columns', 'values'], { rows: { type: 'array', maxItems: 12, items: s(30) }, columns: { type: 'array', maxItems: 12, items: s(16) }, values: { type: 'array', maxItems: 12, items: { type: 'array', maxItems: 12, items: { type: ['number', 'null'] } } }, format: { enum: ['percent', 'change', 'number', 'correlation'] } }),
        blockOf('allocation', ['items'], { items: { type: 'array', minItems: 1, maxItems: 12, items: schema(['label', 'weight'], { label: s(30), weight: { type: 'number' }, target: { type: 'number' }, note: s(30) }) } }),
        blockOf('timeline', ['items'], { items: { type: 'array', minItems: 1, maxItems: 10, items: schema(['date', 'label'], { date: day, label: s(48), detail: s(120), tone: tones }) } }),
        blockOf('checklist', ['items'], { items: { type: 'array', minItems: 1, maxItems: 10, items: schema(['text', 'state'], { text: s(90), state: { enum: ['pass', 'fail', 'watch', 'unknown'] }, detail: s(140) }) } }),
        blockOf('gauge', ['label', 'value', 'min', 'max'], { label: s(40), value: amount, min: amount, max: amount, unit: units, low: s(20), high: s(20), note: s(120) }),
        blockOf('note', ['text'], { badge: s(12), verdict: schema(['text'], { text: s(30), tone: tones }), text: { ...s(400), description: '**bold** marks a key phrase.' } }),
        ...(options.assets ? [assetBlock] : []),
      ] } },
      sources: { type: 'array', ...(options.assets ? {} : { minItems: 1 }), maxItems: 8, items: schema(['title', 'url'], { title: s(160), url: { type: 'string', format: 'uri' } }) },
    } };
}
