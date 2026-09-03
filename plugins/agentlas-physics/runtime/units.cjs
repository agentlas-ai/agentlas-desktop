"use strict";

// Dimensional analysis and unit conversion on SI base-exponent vectors
// [m, kg, s, A, K, mol, cd], a curated unit table with SI prefixes, CODATA
// 2018 constants, a natural-units (ħ = c = k_B = 1) helper, and a formula
// dimensional-consistency check driven by the safe expression parser.

const common = require("./analysis-common.cjs");
const expression = require("./expression.cjs");

const { PhysicsError } = common;

const BASE_NAMES = ["m", "kg", "s", "A", "K", "mol", "cd"];
const D = (m = 0, kg = 0, s = 0, A = 0, K = 0, mol = 0, cd = 0) => Object.freeze([m, kg, s, A, K, mol, cd]);
const ONE = D();
const CODATA_REFERENCE = "CODATA 2018, E. Tiesinga, P. J. Mohr, D. B. Newell, B. N. Taylor, Rev. Mod. Phys. 93, 025010 (2021)";

// Exact SI defining constants (2019 revision) used throughout.
const C_LIGHT = 299792458;
const PLANCK = 6.62607015e-34;
const HBAR = PLANCK / (2 * Math.PI);
const E_CHARGE = 1.602176634e-19;
const BOLTZMANN = 1.380649e-23;
const AVOGADRO = 6.02214076e23;
const G_N = 9.80665;

// ---------------------------------------------------------------------------
// Unit table: symbol → { factor to SI, dimension, prefixable, offset?, name }
// ---------------------------------------------------------------------------

const UNITS = {};
function define(symbols, factor, dimension, options = {}) {
  const entry = { symbol: symbols[0], name: options.name ?? symbols[0], factor, dimension, prefixable: options.prefixable ?? false, offset: options.offset ?? 0, aliases: symbols.slice(1) };
  for (const symbol of symbols) UNITS[symbol] = entry;
}
define(["m"], 1, D(1), { prefixable: true, name: "metre" });
define(["g"], 1e-3, D(0, 1), { prefixable: true, name: "gram" });
define(["s"], 1, D(0, 0, 1), { prefixable: true, name: "second" });
define(["A"], 1, D(0, 0, 0, 1), { prefixable: true, name: "ampere" });
define(["K"], 1, D(0, 0, 0, 0, 1), { prefixable: true, name: "kelvin" });
define(["mol"], 1, D(0, 0, 0, 0, 0, 1), { prefixable: true, name: "mole" });
define(["cd"], 1, D(0, 0, 0, 0, 0, 0, 1), { prefixable: true, name: "candela" });
define(["Hz"], 1, D(0, 0, -1), { prefixable: true, name: "hertz" });
define(["N"], 1, D(1, 1, -2), { prefixable: true, name: "newton" });
define(["Pa"], 1, D(-1, 1, -2), { prefixable: true, name: "pascal" });
define(["J"], 1, D(2, 1, -2), { prefixable: true, name: "joule" });
define(["W"], 1, D(2, 1, -3), { prefixable: true, name: "watt" });
define(["C"], 1, D(0, 0, 1, 1), { prefixable: true, name: "coulomb" });
define(["V"], 1, D(2, 1, -3, -1), { prefixable: true, name: "volt" });
define(["F"], 1, D(-2, -1, 4, 2), { prefixable: true, name: "farad" });
define(["ohm", "Ω", "Ohm"], 1, D(2, 1, -3, -2), { prefixable: true, name: "ohm" });
define(["S"], 1, D(-2, -1, 3, 2), { prefixable: true, name: "siemens" });
define(["Wb"], 1, D(2, 1, -2, -1), { prefixable: true, name: "weber" });
define(["T"], 1, D(0, 1, -2, -1), { prefixable: true, name: "tesla" });
define(["H"], 1, D(2, 1, -2, -2), { prefixable: true, name: "henry" });
define(["lm"], 1, D(0, 0, 0, 0, 0, 0, 1), { prefixable: true, name: "lumen (cd·sr, sr dimensionless)" });
define(["lx"], 1, D(-2, 0, 0, 0, 0, 0, 1), { prefixable: true, name: "lux" });
define(["Bq"], 1, D(0, 0, -1), { prefixable: true, name: "becquerel" });
define(["Gy"], 1, D(2, 0, -2), { prefixable: true, name: "gray" });
define(["Sv"], 1, D(2, 0, -2), { prefixable: true, name: "sievert" });
define(["rad"], 1, ONE, { prefixable: true, name: "radian" });
define(["sr"], 1, ONE, { name: "steradian" });
define(["deg", "°"], Math.PI / 180, ONE, { name: "degree of arc" });
define(["arcmin", "′"], Math.PI / 10800, ONE, { name: "arcminute" });
define(["arcsec", "″"], Math.PI / 648000, ONE, { name: "arcsecond" });
define(["L", "l"], 1e-3, D(3), { prefixable: true, name: "litre" });
define(["t"], 1e3, D(0, 1), { prefixable: true, name: "tonne" });
define(["min"], 60, D(0, 0, 1), { name: "minute" });
define(["h", "hr"], 3600, D(0, 0, 1), { name: "hour" });
define(["d", "day"], 86400, D(0, 0, 1), { name: "day" });
define(["yr", "a"], 365.25 * 86400, D(0, 0, 1), { prefixable: true, name: "Julian year" });
define(["AU", "au"], 149597870700, D(1), { name: "astronomical unit (IAU 2012)" });
define(["pc"], 149597870700 * 648000 / Math.PI, D(1), { prefixable: true, name: "parsec" });
define(["ly"], C_LIGHT * 365.25 * 86400, D(1), { prefixable: true, name: "light-year (Julian)" });
define(["eV"], E_CHARGE, D(2, 1, -2), { prefixable: true, name: "electronvolt" });
define(["u", "Da"], 1.66053906660e-27, D(0, 1), { prefixable: true, name: "unified atomic mass unit" });
define(["cal"], 4.184, D(2, 1, -2), { prefixable: true, name: "calorie (thermochemical)" });
define(["atm"], 101325, D(-1, 1, -2), { name: "standard atmosphere" });
define(["bar"], 1e5, D(-1, 1, -2), { prefixable: true, name: "bar" });
define(["mmHg"], 133.322387415, D(-1, 1, -2), { name: "millimetre of mercury" });
define(["Torr"], 101325 / 760, D(-1, 1, -2), { name: "torr" });
define(["psi"], 6894.757293168, D(-1, 1, -2), { name: "pound-force per square inch" });
define(["in"], 0.0254, D(1), { name: "inch" });
define(["ft"], 0.3048, D(1), { name: "foot" });
define(["mi"], 1609.344, D(1), { name: "mile" });
define(["lb"], 0.45359237, D(0, 1), { name: "pound (avoirdupois)" });
define(["oz"], 0.028349523125, D(0, 1), { name: "ounce (avoirdupois)" });
define(["mph"], 1609.344 / 3600, D(1, 0, -1), { name: "mile per hour" });
define(["kn"], 1852 / 3600, D(1, 0, -1), { name: "knot" });
define(["Å", "angstrom"], 1e-10, D(1), { name: "ångström" });
define(["b"], 1e-28, D(2), { prefixable: true, name: "barn" });
define(["G", "Gs"], 1e-4, D(0, 1, -2, -1), { prefixable: true, name: "gauss" });
define(["c"], C_LIGHT, D(1, 0, -1), { name: "speed of light (as a unit)" });
define(["degC", "°C"], 1, D(0, 0, 0, 0, 1), { offset: 273.15, name: "degree Celsius (absolute temperature only)" });
define(["degF", "°F"], 5 / 9, D(0, 0, 0, 0, 1), { offset: 459.67, name: "degree Fahrenheit (absolute temperature only)" });

const PREFIXES = Object.freeze({
  Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 1e1,
  d: 1e-1, c: 1e-2, m: 1e-3, "µ": 1e-6, "μ": 1e-6, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18, z: 1e-21, y: 1e-24,
});

function resolveUnitSymbol(symbol) {
  if (Object.prototype.hasOwnProperty.call(UNITS, symbol)) return { entry: UNITS[symbol], prefix: null, prefixFactor: 1 };
  for (const prefix of Object.keys(PREFIXES)) {
    if (symbol.length > prefix.length && symbol.startsWith(prefix)) {
      const rest = symbol.slice(prefix.length);
      if (Object.prototype.hasOwnProperty.call(UNITS, rest) && UNITS[rest].prefixable) return { entry: UNITS[rest], prefix, prefixFactor: PREFIXES[prefix] };
    }
  }
  throw new PhysicsError("physics-units-unknown-unit", `unknown unit "${symbol}"`);
}

// ---------------------------------------------------------------------------
// Unit expression parser: product := factor (('*'|'·'|' '|'/') factor)*
//                         factor  := '(' product ')' | symbol ('^' int)? | number
// ---------------------------------------------------------------------------

function tokenizeUnit(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === " ") { tokens.push({ type: "op", value: " " }); index += 1; while (text[index] === " ") index += 1; continue; }
    if (char === "*" || char === "·" || char === "/" || char === "(" || char === ")" || char === "^") {
      if (char === "*" && text[index + 1] === "*") { tokens.push({ type: "op", value: "^" }); index += 2; continue; }
      tokens.push({ type: "op", value: char }); index += 1; continue;
    }
    const number = /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (number && /[0-9]/.test(char) || (number && (char === "+" || char === "-"))) {
      tokens.push({ type: "number", value: Number(number[0]) }); index += number[0].length; continue;
    }
    const symbol = /^[A-Za-zΩΩµμÅ°′″]+/.exec(text.slice(index));
    if (symbol) { tokens.push({ type: "symbol", value: symbol[0] }); index += symbol[0].length; continue; }
    throw new PhysicsError("physics-units-syntax", `unexpected character "${char}" in unit "${text}"`);
  }
  // Collapse spaces adjacent to explicit operators.
  const cleaned = [];
  tokens.forEach((token, position) => {
    if (token.type === "op" && token.value === " ") {
      const previous = cleaned[cleaned.length - 1];
      const next = tokens[position + 1];
      if (!previous || !next || (previous.type === "op" && previous.value !== ")") || (next.type === "op" && next.value !== "(")) return;
    }
    cleaned.push(token);
  });
  return cleaned;
}

function parseUnit(text, label = "physics-units-unit") {
  const normalized = common.text(text, 1, 120, label);
  const tokens = tokenizeUnit(normalized);
  if (tokens.length === 0) throw new PhysicsError("physics-units-syntax", "unit is empty");
  let cursor = 0;
  const peek = () => tokens[cursor] ?? null;
  const take = () => tokens[cursor++];
  const isOp = (token, value) => token !== null && token.type === "op" && token.value === value;
  const parts = [];
  let depth = 0;
  function parseProduct() {
    depth += 1;
    if (depth > 16) throw new PhysicsError("physics-units-syntax", "unit nesting too deep");
    let current = parseFactor(1);
    while (peek() !== null && !isOp(peek(), ")")) {
      let sign = 1;
      if (isOp(peek(), "*") || isOp(peek(), "·") || isOp(peek(), " ")) take();
      else if (isOp(peek(), "/")) { take(); sign = -1; }
      else throw new PhysicsError("physics-units-syntax", `unexpected token in unit "${normalized}"`);
      const factor = parseFactor(sign);
      current = { factor: current.factor * factor.factor, dimension: current.dimension.map((entry, k) => entry + factor.dimension[k]) };
    }
    depth -= 1;
    return current;
  }
  function parseFactor(sign) {
    const token = peek();
    if (token === null) throw new PhysicsError("physics-units-syntax", `unexpected end of unit "${normalized}"`);
    if (isOp(token, "(")) {
      take();
      const inner = parseProduct();
      if (!isOp(peek(), ")")) throw new PhysicsError("physics-units-syntax", "expected \")\" in unit");
      take();
      return apply(inner, sign);
    }
    take();
    let exponent = 1;
    if (isOp(peek(), "^")) {
      take();
      const exponentToken = take();
      if (!exponentToken || exponentToken.type !== "number" || !Number.isInteger(exponentToken.value) || Math.abs(exponentToken.value) > 12) throw new PhysicsError("physics-units-syntax", "unit exponents must be integers with |n| ≤ 12");
      exponent = exponentToken.value;
    }
    if (token.type === "number") {
      if (!(token.value > 0) || !Number.isFinite(token.value)) throw new PhysicsError("physics-units-syntax", "numeric unit factors must be positive");
      return { factor: Math.pow(token.value, sign * exponent), dimension: [...ONE] };
    }
    const resolved = resolveUnitSymbol(token.value);
    parts.push({ symbol: token.value, prefix: resolved.prefix, unit: resolved.entry.symbol, name: resolved.entry.name, exponent: sign * exponent, offset: resolved.entry.offset });
    const factor = Math.pow(resolved.prefixFactor * resolved.entry.factor, sign * exponent);
    return { factor, dimension: resolved.entry.dimension.map((entry) => entry * sign * exponent) };
  }
  function apply(term, sign) { return sign === 1 ? term : { factor: 1 / term.factor, dimension: term.dimension.map((entry) => -entry) }; }
  const parsed = parseProduct();
  if (cursor !== tokens.length) throw new PhysicsError("physics-units-syntax", `unexpected token in unit "${normalized}"`);
  const offsetParts = parts.filter((part) => part.offset !== 0);
  if (offsetParts.length > 0 && (parts.length !== 1 || offsetParts[0].exponent !== 1 || tokens.length !== 1)) {
    throw new PhysicsError("physics-units-offset-in-compound", "offset temperature units (degC, degF) are only allowed as a bare absolute temperature");
  }
  return { text: normalized, factor: parsed.factor, dimension: parsed.dimension, parts, offset: offsetParts.length ? offsetParts[0].offset : 0 };
}

function dimensionOf(unitText, label) { return parseUnit(unitText, label).dimension; }

// ---------------------------------------------------------------------------
// CODATA 2018 constants
// ---------------------------------------------------------------------------

const CONSTANTS = [
  { id: "c", name: "speed of light in vacuum", value: C_LIGHT, uncertainty: 0, unit: "m/s", exact: true },
  { id: "h", name: "Planck constant", value: PLANCK, uncertainty: 0, unit: "J s", exact: true },
  { id: "hbar", name: "reduced Planck constant", value: HBAR, uncertainty: 0, unit: "J s", exact: true, note: "h/(2π), exact by definition" },
  { id: "e", name: "elementary charge", value: E_CHARGE, uncertainty: 0, unit: "C", exact: true },
  { id: "k_B", name: "Boltzmann constant", value: BOLTZMANN, uncertainty: 0, unit: "J/K", exact: true },
  { id: "N_A", name: "Avogadro constant", value: AVOGADRO, uncertainty: 0, unit: "mol^-1", exact: true },
  { id: "R", name: "molar gas constant", value: 8.314462618, uncertainty: 0, unit: "J/(mol K)", exact: true, note: "N_A·k_B, exact (value rounded to CODATA listing)" },
  { id: "F", name: "Faraday constant", value: 96485.33212, uncertainty: 0, unit: "C/mol", exact: true, note: "N_A·e, exact (value rounded to CODATA listing)" },
  { id: "sigma_SB", name: "Stefan–Boltzmann constant", value: 5.670374419e-8, uncertainty: 0, unit: "W/(m^2 K^4)", exact: true, note: "π²k_B⁴/(60ħ³c²), exact (value rounded to CODATA listing)" },
  { id: "G", name: "Newtonian constant of gravitation", value: 6.67430e-11, uncertainty: 0.00015e-11, unit: "m^3/(kg s^2)", exact: false },
  { id: "epsilon_0", name: "vacuum electric permittivity", value: 8.8541878128e-12, uncertainty: 0.0000000013e-12, unit: "F/m", exact: false },
  { id: "mu_0", name: "vacuum magnetic permeability", value: 1.25663706212e-6, uncertainty: 0.00000000019e-6, unit: "N/A^2", exact: false },
  { id: "m_e", name: "electron mass", value: 9.1093837015e-31, uncertainty: 0.0000000028e-31, unit: "kg", exact: false },
  { id: "m_p", name: "proton mass", value: 1.67262192369e-27, uncertainty: 0.00000000051e-27, unit: "kg", exact: false },
  { id: "m_n", name: "neutron mass", value: 1.67492749804e-27, uncertainty: 0.00000000095e-27, unit: "kg", exact: false },
  { id: "m_u", name: "atomic mass constant", value: 1.66053906660e-27, uncertainty: 0.00000000050e-27, unit: "kg", exact: false },
  { id: "alpha", name: "fine-structure constant", value: 7.2973525693e-3, uncertainty: 0.0000000011e-3, unit: "1", exact: false },
  { id: "a_0", name: "Bohr radius", value: 5.29177210903e-11, uncertainty: 0.00000000080e-11, unit: "m", exact: false },
  { id: "R_infinity", name: "Rydberg constant", value: 10973731.568160, uncertainty: 0.000021, unit: "m^-1", exact: false },
  { id: "eV", name: "electronvolt", value: E_CHARGE, uncertainty: 0, unit: "J", exact: true },
  { id: "g_n", name: "standard acceleration of gravity", value: G_N, uncertainty: 0, unit: "m/s^2", exact: true, note: "conventional value" },
  { id: "atm", name: "standard atmosphere", value: 101325, uncertainty: 0, unit: "Pa", exact: true, note: "conventional value" },
  { id: "hbar_c", name: "reduced Planck constant times c", value: HBAR * C_LIGHT, uncertainty: 0, unit: "J m", exact: true, note: "derived: ħc; 197.3269804 MeV fm" },
  { id: "hbar_c_MeV_fm", name: "reduced Planck constant times c in MeV fm", value: HBAR * C_LIGHT / E_CHARGE / 1e6 / 1e-15, uncertainty: 0, unit: "MeV fm", exact: true, note: "derived from exact constants" },
].map((entry) => ({ ...entry, relativeUncertainty: entry.value !== 0 ? entry.uncertainty / Math.abs(entry.value) : 0, reference: CODATA_REFERENCE }));
const CONSTANT_BY_ID = new Map(CONSTANTS.map((entry) => [entry.id, entry]));

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

function normalizeInput(input) {
  const value = common.exactObject(input, ["operation", "value", "from", "to", "ids", "unit", "equation", "variables", "label"], "physics-units-input");
  const operation = common.enumText(value.operation, ["convert", "constants", "natural_units", "check_formula"], "physics-units-operation");
  const label = common.optionalText(value.label, 160, "physics-units-label");
  const forbid = (keys) => { for (const key of keys) if (value[key] !== undefined) throw new PhysicsError("physics-units-input-unknown-field", `${key} is not valid for operation ${operation}`); };
  if (operation === "convert") {
    forbid(["ids", "unit", "equation", "variables"]);
    return { operation, label, value: common.finite(value.value, -Number.MAX_VALUE, Number.MAX_VALUE, "physics-units-value"), from: common.text(value.from, 1, 120, "physics-units-from"), to: common.text(value.to, 1, 120, "physics-units-to") };
  }
  if (operation === "constants") {
    forbid(["value", "from", "to", "unit", "equation", "variables"]);
    let ids = null;
    if (value.ids !== undefined) {
      if (!Array.isArray(value.ids) || value.ids.length < 1 || value.ids.length > 64) throw new PhysicsError("physics-units-ids-invalid", "ids must contain 1..64 constant ids");
      ids = value.ids.map((id) => common.enumText(id, CONSTANTS.map((entry) => entry.id), "physics-units-constant-id"));
      if (new Set(ids).size !== ids.length) throw new PhysicsError("physics-units-ids-invalid", "ids must be unique");
    }
    return { operation, label, ids };
  }
  if (operation === "natural_units") {
    forbid(["from", "to", "ids", "equation", "variables"]);
    return { operation, label, value: common.finite(value.value, -Number.MAX_VALUE, Number.MAX_VALUE, "physics-units-value"), unit: common.text(value.unit, 1, 120, "physics-units-unit") };
  }
  forbid(["value", "from", "to", "ids", "unit"]);
  const equation = common.text(value.equation, 3, expression.MAX_CHARS, "physics-units-equation");
  const sides = equation.split("=");
  if (sides.length !== 2 || !sides[0].trim() || !sides[1].trim()) throw new PhysicsError("physics-units-equation-invalid", "equation must have the form \"lhs = rhs\"");
  const variablesRecord = common.isPlainObject(value.variables) ? value.variables : null;
  if (!variablesRecord) throw new PhysicsError("physics-units-variables-invalid", "variables must map names to unit strings");
  const names = Object.keys(variablesRecord);
  if (names.length < 1 || names.length > 64) throw new PhysicsError("physics-units-variables-invalid", "variables must declare 1..64 names");
  const variables = {};
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new PhysicsError("physics-units-variables-invalid", `variable name "${name}" is not an identifier`);
    variables[name] = common.text(variablesRecord[name], 1, 120, "physics-units-variable-unit");
  }
  return { operation, label, equation, lhs: sides[0].trim(), rhs: sides[1].trim(), variables };
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

function dimensionFigure(description, dimension, title) {
  const rows = BASE_NAMES.map((base, k) => ({ base, exponent: dimension[k] }));
  return common.stackedVegaFigure({
    description, width: 680,
    data: [{ name: "exponents", values: rows }, { name: "zeroLine", values: [{ level: 0 }] }],
    panels: [{
      name: "dimensionPanel", height: 220, title,
      scales: [
        { name: "x", type: "band", domain: { data: "exponents", field: "base" }, range: "width", padding: 0.3 },
        { name: "y", type: "linear", domain: { fields: [{ data: "exponents", field: "exponent" }, { data: "zeroLine", field: "level" }] }, range: "height", nice: true, zero: true },
      ],
      axes: [{ orient: "bottom", scale: "x", title: "SI base unit", grid: false }, common.axis("left", "y", "Exponent")],
      marks: [
        { type: "rect", from: { data: "exponents" }, encode: { enter: { x: { scale: "x", field: "base" }, width: { scale: "x", band: 1 }, y: { scale: "y", field: "exponent" }, y2: { scale: "y", value: 0 }, fill: { value: common.PALETTE.data } } } },
        common.horizontalRule("zeroLine", 0, common.PALETTE.neutral, { width: 680 }),
      ],
    }],
  });
}

function constantsFigure(rows) {
  const floor = -20;
  const values = rows.map((entry) => ({ id: entry.id, logRelative: entry.exact ? floor : Math.log10(entry.relativeUncertainty), exact: entry.exact ? "exact" : "measured" }));
  return common.stackedVegaFigure({
    description: "log10 of the relative standard uncertainty of each requested CODATA 2018 constant; exact (defined) constants are drawn at the floor value −20.",
    width: 680,
    data: [{ name: "constants", values }],
    panels: [{
      name: "constantsPanel", height: Math.max(80, 22 * values.length), title: "Relative uncertainty (log10); exact constants at floor −20",
      scales: [
        { name: "x", type: "linear", domain: [floor, 0], range: "width", nice: false, zero: false },
        { name: "y", type: "band", domain: { data: "constants", field: "id" }, range: "height", padding: 0.2 },
        { name: "color", type: "ordinal", domain: ["exact", "measured"], range: [common.PALETTE.neutral, common.PALETTE.data] },
      ],
      axes: [common.axis("bottom", "x", "log10(u_r)"), { orient: "left", scale: "y", title: "Constant", grid: false }],
      legends: [{ fill: "color", orient: "right", title: "Status" }],
      marks: [
        { type: "rect", from: { data: "constants" }, encode: { enter: { x: { scale: "x", value: floor }, x2: { scale: "x", field: "logRelative" }, y: { scale: "y", field: "id" }, height: { scale: "y", band: 1 }, fill: { scale: "color", field: "exact" } } } },
      ],
    }],
  });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function convert(normalized) {
  const from = parseUnit(normalized.from, "physics-units-from");
  const to = parseUnit(normalized.to, "physics-units-to");
  if (!expression.sameDimension(from.dimension, to.dimension)) {
    throw new PhysicsError("physics-units-dimension-mismatch", `"${from.text}" has dimension ${expression.formatDimension(from.dimension)} [${from.dimension.join(", ")}] but "${to.text}" has ${expression.formatDimension(to.dimension)} [${to.dimension.join(", ")}]`);
  }
  const siValue = (normalized.value + from.offset) * from.factor;
  const result = siValue / to.factor - to.offset;
  const factor = from.factor / to.factor;
  const usesOffset = from.offset !== 0 || to.offset !== 0;
  if (usesOffset && siValue < 0) throw new PhysicsError("physics-units-temperature-below-zero", "absolute temperature must not be negative");
  const warnings = usesOffset ? ["Offset temperature units are converted as absolute temperatures (not temperature differences)."] : [];
  const publicationTable = common.scienceTable(`Unit conversion · ${normalized.label ?? `${from.text} → ${to.text}`}`, [
    { id: "quantity", label: "Quantity", type: "string" }, { id: "value", label: "Value" }, { id: "unit", label: "Unit", type: "string" }, { id: "note", label: "Note", type: "string" },
  ], [
    ["Input", normalized.value, from.text, from.parts.map((part) => `${part.symbol} = ${part.name}${part.exponent === 1 ? "" : `^${part.exponent}`}`).join("; ")],
    ["SI value", siValue, expression.formatDimension(from.dimension), `factor ${from.factor} to SI${from.offset ? `, offset ${from.offset}` : ""}`],
    ["Result", result, to.text, usesOffset ? "absolute temperature conversion" : `multiply by ${factor}`],
  ]);
  const partsTable = common.scienceTable("Parsed unit factors", [
    { id: "side", label: "Side", type: "string" }, { id: "symbol", label: "Symbol", type: "string" }, { id: "prefix", label: "Prefix", type: "string" }, { id: "name", label: "Name", type: "string" }, { id: "exponent", label: "Exponent" },
  ], [...from.parts.map((part) => ["from", part.symbol, part.prefix, part.name, part.exponent]), ...to.parts.map((part) => ["to", part.symbol, part.prefix, part.name, part.exponent])]);
  return {
    summary: { value: normalized.value, from: from.text, to: to.text, result, factor: usesOffset ? null : factor, siValue, dimension: from.dimension, dimensionText: expression.formatDimension(from.dimension), offsetConversion: usesOffset },
    publicationTable, tables: { parts: partsTable }, warnings,
    figure: dimensionFigure(`SI base exponents of ${from.text} (converted to ${to.text}).`, from.dimension, `Dimension of ${from.text}`),
  };
}

function constants(normalized) {
  const rows = (normalized.ids ?? CONSTANTS.map((entry) => entry.id)).map((id) => CONSTANT_BY_ID.get(id));
  const publicationTable = common.scienceTable(`CODATA 2018 constants${normalized.label ? ` · ${normalized.label}` : ""}`, [
    { id: "id", label: "Id", type: "string" }, { id: "name", label: "Name", type: "string" }, { id: "value", label: "Value" }, { id: "uncertainty", label: "Standard uncertainty" }, { id: "relative", label: "Relative uncertainty" }, { id: "unit", label: "Unit", type: "string" }, { id: "status", label: "Status", type: "string" }, { id: "reference", label: "Reference", type: "string" },
  ], rows.map((entry) => [entry.id, entry.name, entry.value, entry.uncertainty, entry.relativeUncertainty, entry.unit, entry.exact ? `exact${entry.note ? ` (${entry.note})` : ""}` : "measured", entry.reference]));
  const dimensionsTable = common.scienceTable("Constant dimensions (SI base exponents)", [
    { id: "id", label: "Id", type: "string" }, ...BASE_NAMES.map((base) => ({ id: base, label: base })),
  ], rows.map((entry) => [entry.id, ...dimensionOf(entry.unit, "physics-units-constant-unit")]));
  return {
    summary: { count: rows.length, ids: rows.map((entry) => entry.id), exactCount: rows.filter((entry) => entry.exact).length, reference: CODATA_REFERENCE, constants: Object.fromEntries(rows.map((entry) => [entry.id, { value: entry.value, uncertainty: entry.uncertainty, unit: entry.unit }])) },
    publicationTable, tables: { dimensions: dimensionsTable }, warnings: [], figure: constantsFigure(rows),
  };
}

function naturalUnits(normalized) {
  const unit = parseUnit(normalized.unit, "physics-units-unit");
  const [a, b, c, ampere, kelvin, mole, candela] = unit.dimension;
  if (ampere !== 0 || mole !== 0 || candela !== 0) throw new PhysicsError("physics-units-natural-unsupported", `natural units here cover m, kg, s, K only; "${unit.text}" has dimension ${expression.formatDimension(unit.dimension)}`);
  const hbarEvS = HBAR / E_CHARGE;                 // eV s
  const hbarCEvM = HBAR * C_LIGHT / E_CHARGE;      // eV m
  const kgInEv = C_LIGHT * C_LIGHT / E_CHARGE;     // eV per kg (E = m c²)
  const kBEvPerK = BOLTZMANN / E_CHARGE;           // eV / K
  const power = b - a - c + kelvin;
  const siValue = (normalized.value + unit.offset) * unit.factor;
  const chain = [
    { step: "1 m = (ħc)⁻¹ eV⁻¹", factor: Math.pow(1 / hbarCEvM, a), exponent: a, constant: hbarCEvM, constantUnit: "eV m" },
    { step: "1 kg = c²/e eV", factor: Math.pow(kgInEv, b), exponent: b, constant: kgInEv, constantUnit: "eV/kg" },
    { step: "1 s = ħ⁻¹ eV⁻¹", factor: Math.pow(1 / hbarEvS, c), exponent: c, constant: hbarEvS, constantUnit: "eV s" },
    { step: "1 K = k_B eV", factor: Math.pow(kBEvPerK, kelvin), exponent: kelvin, constant: kBEvPerK, constantUnit: "eV/K" },
  ];
  const totalFactor = chain.reduce((product, entry) => product * entry.factor, 1);
  const result = siValue * totalFactor;
  const resultUnit = power === 0 ? "1" : `eV^${power}`;
  const publicationTable = common.scienceTable(`Natural units (ħ = c = k_B = 1) · ${normalized.label ?? unit.text}`, [
    { id: "quantity", label: "Quantity", type: "string" }, { id: "value", label: "Value" }, { id: "unit", label: "Unit", type: "string" }, { id: "note", label: "Note", type: "string" },
  ], [
    ["Input", normalized.value, unit.text, expression.formatDimension(unit.dimension)],
    ["SI value", siValue, expression.formatDimension(unit.dimension), `factor ${unit.factor} to SI`],
    ["Natural-unit value", result, resultUnit, `eV power = kg − m − s + K = ${b} − ${a} − ${c} + ${kelvin} = ${power}`],
    ["Total conversion factor", totalFactor, `${resultUnit} per SI unit`, "product of the chain below"],
  ]);
  const chainTable = common.scienceTable("Conversion chain", [
    { id: "step", label: "Replacement", type: "string" }, { id: "exponent", label: "Exponent" }, { id: "constant", label: "Constant" }, { id: "constantUnit", label: "Constant unit", type: "string" }, { id: "factor", label: "Factor" },
  ], chain.map((entry) => [entry.step, entry.exponent, entry.constant, entry.constantUnit, entry.factor]));
  return {
    summary: { value: normalized.value, unit: unit.text, siValue, dimension: unit.dimension, dimensionText: expression.formatDimension(unit.dimension), eVPower: power, result, resultUnit, totalFactor, constants: { hbarEvS, hbarCEvM, kgInEv, kBEvPerK } },
    publicationTable, tables: { chain: chainTable }, warnings: [],
    figure: dimensionFigure(`SI base exponents of ${unit.text}; natural-unit power eV^${power}.`, unit.dimension, `Dimension of ${unit.text}`),
  };
}

function checkFormula(normalized) {
  const dimensions = {};
  const parsedUnits = {};
  for (const [name, unitText] of Object.entries(normalized.variables)) {
    const parsed = parseUnit(unitText, "physics-units-variable-unit");
    if (parsed.offset !== 0) throw new PhysicsError("physics-units-offset-in-compound", `variable "${name}": use K for temperatures in formulas, not degC/degF`);
    dimensions[name] = parsed.dimension;
    parsedUnits[name] = parsed;
  }
  const lhsAst = expression.parseExpression(normalized.lhs);
  const rhsAst = expression.parseExpression(normalized.rhs);
  const used = new Set([...expression.variablesOf(lhsAst), ...expression.variablesOf(rhsAst)]);
  const missing = [...used].filter((name) => !dimensions[name]);
  if (missing.length) throw new PhysicsError("physics-units-variable-missing", `no unit declared for: ${missing.join(", ")}`);
  const lhsDimension = expression.evaluateDimension(lhsAst, dimensions);
  const rhsDimension = expression.evaluateDimension(rhsAst, dimensions);
  const consistent = expression.sameDimension(lhsDimension, rhsDimension);
  const difference = lhsDimension.map((entry, k) => entry - rhsDimension[k]);
  let hint = null;
  if (!consistent) {
    const nonZero = difference.map((entry, k) => ({ base: BASE_NAMES[k], exponent: entry })).filter((entry) => Math.abs(entry.exponent) > 1e-9);
    hint = nonZero.length === 1
      ? `the left side carries an extra ${nonZero[0].base}^${Number(nonZero[0].exponent.toFixed(6))} relative to the right side`
      : `left/right differ by ${expression.formatDimension(difference)}`;
  }
  const publicationTable = common.scienceTable(`Dimensional consistency · ${normalized.label ?? normalized.equation}`, [
    { id: "side", label: "Side", type: "string" }, { id: "text", label: "Expression", type: "string" }, { id: "dimension", label: "Dimension", type: "string" }, ...BASE_NAMES.map((base) => ({ id: base, label: base })),
  ], [
    ["lhs", normalized.lhs, expression.formatDimension(lhsDimension), ...lhsDimension],
    ["rhs", normalized.rhs, expression.formatDimension(rhsDimension), ...rhsDimension],
    ["lhs − rhs", consistent ? "consistent" : hint, expression.formatDimension(difference), ...difference],
  ]);
  const variablesTable = common.scienceTable("Declared variable units", [
    { id: "name", label: "Variable", type: "string" }, { id: "unit", label: "Unit", type: "string" }, { id: "dimension", label: "Dimension", type: "string" }, { id: "used", label: "Used", type: "string" },
  ], Object.keys(normalized.variables).map((name) => [name, parsedUnits[name].text, expression.formatDimension(dimensions[name]), used.has(name) ? "yes" : "no"]));
  const unused = Object.keys(normalized.variables).filter((name) => !used.has(name));
  return {
    summary: { equation: normalized.equation, consistent, lhsDimension, rhsDimension, lhsDimensionText: expression.formatDimension(lhsDimension), rhsDimensionText: expression.formatDimension(rhsDimension), difference, hint },
    publicationTable, tables: { variables: variablesTable },
    warnings: unused.length ? [`Declared variable(s) not used in the equation: ${unused.join(", ")}.`] : [],
    figure: dimensionFigure(`SI base exponents of the left-hand side of ${normalized.equation}${consistent ? " (consistent with the right-hand side)" : " (right-hand side differs)"}.`, lhsDimension, `Dimension of lhs: ${normalized.lhs}`),
  };
}

function analyzeUnits(input) {
  const normalized = normalizeInput(input);
  const operation = normalized.operation;
  const computed = operation === "convert" ? convert(normalized) : operation === "constants" ? constants(normalized) : operation === "natural_units" ? naturalUnits(normalized) : checkFormula(normalized);
  const result = {
    schema: "agentlas.physics.analysis-result/v1",
    analysisId: "unit-analysis",
    method: {
      id: `si-dimension-vector-${operation.replace(/_/g, "-")}`, version: "1.0.0",
      references: [
        "BIPM, The International System of Units (SI), 9th edition (2019)",
        CODATA_REFERENCE,
        "IAU 2012 Resolution B2 (astronomical unit); NIST SP 811 (2008) conversion factors",
      ],
    },
    input: normalized,
    summary: { operation, ...computed.summary },
    publicationTable: computed.publicationTable,
    tables: computed.tables,
    figure: common.figureReceipt(computed.figure),
    boundaries: [
      "Dimensions are tracked as exponents of the seven SI base units; angles and solid angles are dimensionless, so rad, deg, and sr conversions pass but are not distinguished from pure numbers.",
      "The unit table is curated (SI, accepted non-SI, common imperial and astronomical units); unknown symbols are rejected rather than guessed.",
      "Offset temperature scales (degC, degF) are handled only as bare absolute temperatures; use K for differences and inside compound units.",
      "Natural units cover mechanical and thermal dimensions (m, kg, s, K) with ħ = c = k_B = 1; electric charge, amount, and luminous intensity are not converted.",
      "The figure is an auxiliary dimension/uncertainty chart, not a measurement plot.",
    ],
    warnings: computed.warnings,
  };
  return common.finalizeAnalysis(result);
}

module.exports = { analyzeUnits, parseUnit, dimensionOf, CONSTANTS, UNITS, PREFIXES, BASE_NAMES };
