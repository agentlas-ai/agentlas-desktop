"use strict";

// Safe arithmetic expression engine: tokenizer + precedence-climbing parser,
// numeric evaluation, forward-mode dual-number differentiation, and SI
// dimension propagation. No eval/Function; the grammar is closed.
//
//   expr   := term (('+'|'-') term)*
//   term   := unary (('*'|'/') unary)*
//   unary  := '-' unary | power
//   power  := atom ('^' unary)?            (right associative)
//   atom   := number | ident | ident '(' args ')' | '(' expr ')'

const common = require("./analysis-common.cjs");

const { PhysicsError } = common;

const MAX_CHARS = 2000;
const MAX_TOKENS = 500;
const MAX_DEPTH = 64;
const DIMENSION_LENGTH = 7;

const CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E });

// Each function: arity, value, derivative rule (returns partials wrt args), dimension rule.
const FUNCTIONS = Object.freeze({
  sin: { arity: 1, value: ([x]) => Math.sin(x), partials: ([x]) => [Math.cos(x)] },
  cos: { arity: 1, value: ([x]) => Math.cos(x), partials: ([x]) => [-Math.sin(x)] },
  tan: { arity: 1, value: ([x]) => Math.tan(x), partials: ([x]) => [1 / Math.cos(x) ** 2] },
  asin: { arity: 1, value: ([x]) => Math.asin(x), partials: ([x]) => [1 / Math.sqrt(1 - x * x)] },
  acos: { arity: 1, value: ([x]) => Math.acos(x), partials: ([x]) => [-1 / Math.sqrt(1 - x * x)] },
  atan: { arity: 1, value: ([x]) => Math.atan(x), partials: ([x]) => [1 / (1 + x * x)] },
  atan2: { arity: 2, value: ([y, x]) => Math.atan2(y, x), partials: ([y, x]) => [x / (x * x + y * y), -y / (x * x + y * y)] },
  sinh: { arity: 1, value: ([x]) => Math.sinh(x), partials: ([x]) => [Math.cosh(x)] },
  cosh: { arity: 1, value: ([x]) => Math.cosh(x), partials: ([x]) => [Math.sinh(x)] },
  tanh: { arity: 1, value: ([x]) => Math.tanh(x), partials: ([x]) => [1 - Math.tanh(x) ** 2] },
  exp: { arity: 1, value: ([x]) => Math.exp(x), partials: ([x]) => [Math.exp(x)] },
  log: { arity: 1, value: ([x]) => Math.log(x), partials: ([x]) => [1 / x] },
  ln: { arity: 1, value: ([x]) => Math.log(x), partials: ([x]) => [1 / x] },
  log10: { arity: 1, value: ([x]) => Math.log10(x), partials: ([x]) => [1 / (x * Math.LN10)] },
  log2: { arity: 1, value: ([x]) => Math.log2(x), partials: ([x]) => [1 / (x * Math.LN2)] },
  sqrt: { arity: 1, value: ([x]) => Math.sqrt(x), partials: ([x]) => [0.5 / Math.sqrt(x)] },
  cbrt: { arity: 1, value: ([x]) => Math.cbrt(x), partials: ([x]) => [1 / (3 * Math.cbrt(x) ** 2)] },
  abs: { arity: 1, value: ([x]) => Math.abs(x), partials: ([x]) => [x === 0 ? 0 : Math.sign(x)] },
  pow: { arity: 2, value: ([x, y]) => Math.pow(x, y), partials: ([x, y]) => [y * Math.pow(x, y - 1), x > 0 ? Math.pow(x, y) * Math.log(x) : (x === 0 ? 0 : Number.NaN)] },
  hypot: { arity: 2, value: ([x, y]) => Math.hypot(x, y), partials: ([x, y]) => { const h = Math.hypot(x, y); return h === 0 ? [0, 0] : [x / h, y / h]; } },
  min: { arity: 2, value: ([x, y]) => Math.min(x, y), partials: ([x, y]) => (x <= y ? [1, 0] : [0, 1]) },
  max: { arity: 2, value: ([x, y]) => Math.max(x, y), partials: ([x, y]) => (x >= y ? [1, 0] : [0, 1]) },
});

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(text) {
  if (typeof text !== "string") throw new PhysicsError("physics-expression-invalid", "expression must be a string");
  if (text.length === 0 || text.length > MAX_CHARS) throw new PhysicsError("physics-expression-invalid", `expression must have 1..${MAX_CHARS} characters`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new PhysicsError("physics-expression-invalid", "expression contains control characters");
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === " " || char === "\t") { index += 1; continue; }
    if (/[0-9.]/.test(char)) {
      const match = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
      if (!match || match[0] === ".") throw new PhysicsError("physics-expression-number-invalid", `invalid number at position ${index}`);
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new PhysicsError("physics-expression-number-invalid", `non-finite number at position ${index}`);
      tokens.push({ type: "number", value, position: index });
      index += match[0].length;
    } else if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index));
      if (match[0].length > 64) throw new PhysicsError("physics-expression-identifier-invalid", `identifier too long at position ${index}`);
      tokens.push({ type: "identifier", value: match[0], position: index });
      index += match[0].length;
    } else if ("+-*/^(),".includes(char)) {
      tokens.push({ type: "operator", value: char, position: index });
      index += 1;
    } else {
      throw new PhysicsError("physics-expression-character-invalid", `unexpected character "${char}" at position ${index}`);
    }
    if (tokens.length > MAX_TOKENS) throw new PhysicsError("physics-expression-too-long", `expression exceeds ${MAX_TOKENS} tokens`);
  }
  if (tokens.length === 0) throw new PhysicsError("physics-expression-invalid", "expression is empty");
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (precedence climbing)
// ---------------------------------------------------------------------------

function parseExpression(text) {
  const tokens = tokenize(text);
  let cursor = 0;
  const peek = () => tokens[cursor] ?? null;
  const take = () => tokens[cursor++];
  const isOperator = (token, value) => token !== null && token.type === "operator" && token.value === value;
  const guardDepth = (depth) => { if (depth > MAX_DEPTH) throw new PhysicsError("physics-expression-too-deep", `nesting exceeds ${MAX_DEPTH}`); };

  function parseSum(depth) {
    guardDepth(depth);
    let left = parseProduct(depth + 1);
    while (isOperator(peek(), "+") || isOperator(peek(), "-")) {
      const op = take().value;
      const right = parseProduct(depth + 1);
      left = { type: "binary", op, left, right };
    }
    return left;
  }
  function parseProduct(depth) {
    guardDepth(depth);
    let left = parseUnary(depth + 1);
    while (isOperator(peek(), "*") || isOperator(peek(), "/")) {
      const op = take().value;
      const right = parseUnary(depth + 1);
      left = { type: "binary", op, left, right };
    }
    return left;
  }
  function parseUnary(depth) {
    guardDepth(depth);
    if (isOperator(peek(), "-")) { take(); return { type: "negate", operand: parseUnary(depth + 1) }; }
    if (isOperator(peek(), "+")) { take(); return parseUnary(depth + 1); }
    return parsePower(depth + 1);
  }
  function parsePower(depth) {
    guardDepth(depth);
    const base = parseAtom(depth + 1);
    if (isOperator(peek(), "^")) {
      take();
      const exponent = parseUnary(depth + 1);
      return { type: "binary", op: "^", left: base, right: exponent };
    }
    return base;
  }
  function parseAtom(depth) {
    guardDepth(depth);
    const token = peek();
    if (token === null) throw new PhysicsError("physics-expression-syntax", "unexpected end of expression");
    if (token.type === "number") { take(); return { type: "number", value: token.value }; }
    if (token.type === "identifier") {
      take();
      if (isOperator(peek(), "(")) {
        const definition = FUNCTIONS[token.value];
        if (!definition) throw new PhysicsError("physics-expression-function-unknown", `unknown function "${token.value}" at position ${token.position}`);
        take();
        const args = [];
        if (!isOperator(peek(), ")")) {
          args.push(parseSum(depth + 1));
          while (isOperator(peek(), ",")) { take(); args.push(parseSum(depth + 1)); }
        }
        if (!isOperator(peek(), ")")) throw new PhysicsError("physics-expression-syntax", `expected ")" after arguments of ${token.value}`);
        take();
        if (args.length !== definition.arity) throw new PhysicsError("physics-expression-function-arity", `${token.value} expects ${definition.arity} argument(s), received ${args.length}`);
        return { type: "call", name: token.value, args };
      }
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, token.value)) return { type: "constant", name: token.value, value: CONSTANTS[token.value] };
      if (Object.prototype.hasOwnProperty.call(FUNCTIONS, token.value)) throw new PhysicsError("physics-expression-syntax", `function "${token.value}" must be called with parentheses`);
      return { type: "variable", name: token.value };
    }
    if (isOperator(token, "(")) {
      take();
      const inner = parseSum(depth + 1);
      if (!isOperator(peek(), ")")) throw new PhysicsError("physics-expression-syntax", "expected \")\"");
      take();
      return inner;
    }
    throw new PhysicsError("physics-expression-syntax", `unexpected token "${token.value}" at position ${token.position}`);
  }

  const ast = parseSum(0);
  if (cursor !== tokens.length) throw new PhysicsError("physics-expression-syntax", `unexpected token "${tokens[cursor].value}" at position ${tokens[cursor].position}`);
  return ast;
}

function variablesOf(ast) {
  const names = new Set();
  const visit = (node) => {
    if (node.type === "variable") names.add(node.name);
    else if (node.type === "negate") visit(node.operand);
    else if (node.type === "binary") { visit(node.left); visit(node.right); }
    else if (node.type === "call") node.args.forEach(visit);
  };
  visit(ast);
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Numeric evaluation
// ---------------------------------------------------------------------------

function lookupVariable(variables, name) {
  if (!variables || !Object.prototype.hasOwnProperty.call(variables, name)) throw new PhysicsError("physics-expression-variable-missing", `variable "${name}" has no value`);
  const value = variables[name];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new PhysicsError("physics-expression-variable-invalid", `variable "${name}" must be a finite number`);
  return value;
}

function evaluate(ast, variables) {
  const visit = (node) => {
    switch (node.type) {
      case "number": case "constant": return node.value;
      case "variable": return lookupVariable(variables, node.name);
      case "negate": return -visit(node.operand);
      case "binary": {
        const left = visit(node.left);
        const right = visit(node.right);
        if (node.op === "+") return left + right;
        if (node.op === "-") return left - right;
        if (node.op === "*") return left * right;
        if (node.op === "/") return left / right;
        return Math.pow(left, right);
      }
      case "call": return FUNCTIONS[node.name].value(node.args.map(visit));
      default: throw new PhysicsError("physics-expression-ast-invalid");
    }
  };
  return visit(ast);
}

// Forward-mode dual numbers: each value carries a gradient vector over the
// declared variable order, so all partials come out of a single pass.
function evaluateDual(ast, variables) {
  const names = variablesOf(ast);
  const index = new Map(names.map((name, position) => [name, position]));
  const size = names.length;
  const zero = () => new Array(size).fill(0);
  const visit = (node) => {
    switch (node.type) {
      case "number": case "constant": return { value: node.value, grad: zero() };
      case "variable": {
        const grad = zero();
        grad[index.get(node.name)] = 1;
        return { value: lookupVariable(variables, node.name), grad };
      }
      case "negate": { const inner = visit(node.operand); return { value: -inner.value, grad: inner.grad.map((g) => -g) }; }
      case "binary": {
        const left = visit(node.left);
        const right = visit(node.right);
        if (node.op === "+") return { value: left.value + right.value, grad: left.grad.map((g, k) => g + right.grad[k]) };
        if (node.op === "-") return { value: left.value - right.value, grad: left.grad.map((g, k) => g - right.grad[k]) };
        if (node.op === "*") return { value: left.value * right.value, grad: left.grad.map((g, k) => g * right.value + left.value * right.grad[k]) };
        if (node.op === "/") return { value: left.value / right.value, grad: left.grad.map((g, k) => (g * right.value - left.value * right.grad[k]) / (right.value * right.value)) };
        const value = Math.pow(left.value, right.value);
        const dBase = right.value * Math.pow(left.value, right.value - 1);
        const exponentConstant = right.grad.every((g) => g === 0);
        const dExponent = exponentConstant ? 0 : (left.value > 0 ? value * Math.log(left.value) : (left.value === 0 ? 0 : Number.NaN));
        return { value, grad: left.grad.map((g, k) => g * dBase + right.grad[k] * dExponent) };
      }
      case "call": {
        const args = node.args.map(visit);
        const values = args.map((entry) => entry.value);
        const definition = FUNCTIONS[node.name];
        const partials = definition.partials(values);
        const grad = zero();
        args.forEach((arg, position) => { for (let k = 0; k < size; k += 1) grad[k] += partials[position] * arg.grad[k]; });
        return { value: definition.value(values), grad };
      }
      default: throw new PhysicsError("physics-expression-ast-invalid");
    }
  };
  const result = visit(ast);
  const gradient = {};
  names.forEach((name, position) => { gradient[name] = result.grad[position]; });
  return { value: result.value, gradient };
}

// ---------------------------------------------------------------------------
// Dimension propagation ([m, kg, s, A, K, mol, cd] exponent vectors)
// ---------------------------------------------------------------------------

const DIMENSIONLESS = Object.freeze(new Array(DIMENSION_LENGTH).fill(0));

function isDimensionVector(value) {
  return Array.isArray(value) && value.length === DIMENSION_LENGTH && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}
function sameDimension(left, right) { return left.every((entry, k) => Math.abs(entry - right[k]) < 1e-9); }
function isDimensionless(vector) { return sameDimension(vector, DIMENSIONLESS); }
function formatDimension(vector) {
  const names = ["m", "kg", "s", "A", "K", "mol", "cd"];
  const parts = vector.map((exponent, k) => (Math.abs(exponent) < 1e-9 ? null : (Math.abs(exponent - 1) < 1e-9 ? names[k] : `${names[k]}^${Number(exponent.toFixed(6))}`))).filter(Boolean);
  return parts.length ? parts.join("·") : "1";
}

// Attempts to fold a subtree to a plain number (used for exponents).
function constantFold(node) {
  switch (node.type) {
    case "number": case "constant": return node.value;
    case "variable": return null;
    case "negate": { const inner = constantFold(node.operand); return inner === null ? null : -inner; }
    case "binary": {
      const left = constantFold(node.left);
      const right = constantFold(node.right);
      if (left === null || right === null) return null;
      if (node.op === "+") return left + right;
      if (node.op === "-") return left - right;
      if (node.op === "*") return left * right;
      if (node.op === "/") return left / right;
      return Math.pow(left, right);
    }
    case "call": {
      const values = node.args.map(constantFold);
      return values.some((value) => value === null) ? null : FUNCTIONS[node.name].value(values);
    }
    default: return null;
  }
}

function evaluateDimension(ast, dimensionOfVariable) {
  const lookup = (name) => {
    const vector = typeof dimensionOfVariable === "function" ? dimensionOfVariable(name) : dimensionOfVariable?.[name];
    if (!isDimensionVector(vector)) throw new PhysicsError("physics-expression-variable-dimension-missing", `variable "${name}" has no declared dimension`);
    return vector;
  };
  const requireDimensionless = (vector, context) => {
    if (!isDimensionless(vector)) throw new PhysicsError("physics-expression-dimension-mismatch", `${context} requires a dimensionless argument, received ${formatDimension(vector)}`);
  };
  const visit = (node) => {
    switch (node.type) {
      case "number": case "constant": return [...DIMENSIONLESS];
      case "variable": return [...lookup(node.name)];
      case "negate": return visit(node.operand);
      case "binary": {
        const left = visit(node.left);
        if (node.op === "^") {
          const exponent = constantFold(node.right);
          if (exponent === null || !Number.isFinite(exponent)) throw new PhysicsError("physics-expression-dimension-mismatch", "exponent must be a constant-foldable dimensionless number");
          requireDimensionless(visit(node.right), "exponent");
          return left.map((entry) => entry * exponent);
        }
        const right = visit(node.right);
        if (node.op === "+" || node.op === "-") {
          if (!sameDimension(left, right)) throw new PhysicsError("physics-expression-dimension-mismatch", `cannot ${node.op === "+" ? "add" : "subtract"} ${formatDimension(left)} and ${formatDimension(right)}`);
          return left;
        }
        if (node.op === "*") return left.map((entry, k) => entry + right[k]);
        return left.map((entry, k) => entry - right[k]);
      }
      case "call": {
        const dims = node.args.map(visit);
        if (node.name === "sqrt") return dims[0].map((entry) => entry / 2);
        if (node.name === "cbrt") return dims[0].map((entry) => entry / 3);
        if (node.name === "pow") {
          const exponent = constantFold(node.args[1]);
          if (exponent === null || !Number.isFinite(exponent)) throw new PhysicsError("physics-expression-dimension-mismatch", "pow exponent must be a constant-foldable dimensionless number");
          requireDimensionless(dims[1], "pow exponent");
          return dims[0].map((entry) => entry * exponent);
        }
        if (node.name === "hypot" || node.name === "min" || node.name === "max" || node.name === "atan2") {
          if (!sameDimension(dims[0], dims[1])) throw new PhysicsError("physics-expression-dimension-mismatch", `${node.name} arguments must share a dimension: ${formatDimension(dims[0])} vs ${formatDimension(dims[1])}`);
          return node.name === "atan2" ? [...DIMENSIONLESS] : dims[0];
        }
        if (node.name === "abs") return dims[0];
        dims.forEach((vector) => requireDimensionless(vector, node.name));
        return [...DIMENSIONLESS];
      }
      default: throw new PhysicsError("physics-expression-ast-invalid");
    }
  };
  return visit(ast);
}

function formatAst(node) {
  switch (node.type) {
    case "number": return String(node.value);
    case "constant": case "variable": return node.name;
    case "negate": return `-(${formatAst(node.operand)})`;
    case "binary": return `(${formatAst(node.left)} ${node.op} ${formatAst(node.right)})`;
    case "call": return `${node.name}(${node.args.map(formatAst).join(", ")})`;
    default: return "?";
  }
}

module.exports = {
  CONSTANTS,
  DIMENSIONLESS,
  DIMENSION_LENGTH,
  FUNCTION_NAMES: Object.freeze(Object.keys(FUNCTIONS)),
  MAX_CHARS,
  MAX_DEPTH,
  MAX_TOKENS,
  evaluate,
  evaluateDimension,
  evaluateDual,
  formatAst,
  formatDimension,
  isDimensionVector,
  isDimensionless,
  parseExpression,
  sameDimension,
  tokenize,
  variablesOf,
};
