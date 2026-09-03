"use strict";

// ODE simulation catalogue on an adaptive Dormand–Prince RK5(4) integrator.
//
// Integrator: DP5(4) tableau (Dormand & Prince 1980) with FSAL, the mixed
// absolute/relative error norm and the step-size controller of Hairer,
// Nørsett & Wanner, "Solving Ordinary Differential Equations I" (1993)
// §II.4 (safety 0.9, factor bounds [0.2, 10], initial step by the heuristic
// of §II.4 as well). Accepted steps are stored with their derivatives and the
// output grid is produced by cubic Hermite interpolation (fourth-order local
// error), so output_points does not influence the integration.
//
// Every catalogue system declares its parameters, state names and units; the
// conserved quantities and closed-form checks are diagnostics, not proofs.

const common = require("./analysis-common.cjs");

const { PhysicsError } = common;
const MAX_STEPS = 200_000;

// Points the phase panel is drawn from. Wider than the time panel's 500 because a state-space
// curve folds back on itself: its resolution is set by how fast the path turns, not by the plot
// width.
const PHASE_FIGURE_POINTS = 2_000;

// ---------------------------------------------------------------------------
// Dormand–Prince 5(4)
// ---------------------------------------------------------------------------

const DP_C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
const DP_A = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
];
const DP_B = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
const DP_E = [71 / 57600, 0, -71 / 16695, 71 / 1920, -17253 / 339200, 22 / 525, -1 / 40];

function integrate(derivative, t0, y0, t1, options) {
  const { rtol, atol, maxSteps } = options;
  const dimension = y0.length;
  const norm = (error, yOld, yNew) => {
    let sum = 0;
    for (let i = 0; i < dimension; i += 1) {
      const scale = atol + rtol * Math.max(Math.abs(yOld[i]), Math.abs(yNew[i]));
      sum += (error[i] / scale) ** 2;
    }
    return Math.sqrt(sum / dimension);
  };
  const evaluate = (t, y) => {
    const dy = derivative(t, y);
    if (dy.length !== dimension || dy.some((value) => !Number.isFinite(value))) throw new PhysicsError("physics-ode-derivative-non-finite", `the derivative is not finite at t = ${t}`);
    return dy;
  };
  let t = t0;
  let y = y0.slice();
  let f = evaluate(t, y);
  // Hairer's initial step heuristic.
  const scaledNorm = (vector, reference) => Math.sqrt(vector.reduce((sum, value, i) => sum + (value / (atol + rtol * Math.abs(reference[i]))) ** 2, 0) / dimension);
  const d0 = scaledNorm(y, y);
  const d1 = scaledNorm(f, y);
  let h0 = d0 < 1e-5 || d1 < 1e-5 ? 1e-6 : 0.01 * d0 / d1;
  h0 = Math.min(h0, t1 - t0);
  const y1 = y.map((value, i) => value + h0 * f[i]);
  const f1 = evaluate(t + h0, y1);
  const d2 = scaledNorm(f1.map((value, i) => value - f[i]), y) / h0;
  const h1 = Math.max(d1, d2) <= 1e-15 ? Math.max(1e-6, h0 * 1e-3) : Math.pow(0.01 / Math.max(d1, d2), 1 / 5);
  // Cap the step so that the cubic Hermite output interpolation (O(h⁴)) stays
  // small for smooth problems integrated at loose tolerances.
  const hMax = (t1 - t0) / 200;
  let h = Math.min(100 * h0, h1, hMax);
  const steps = [{ t, y: y.slice(), dy: f.slice() }];
  let accepted = 0;
  let rejected = 0;
  const k = new Array(7);
  let event = null;
  while (t < t1) {
    if (accepted + rejected >= maxSteps) throw new PhysicsError("physics-ode-max-steps-exceeded", `the integrator did not reach t = ${t1} within ${maxSteps} steps`);
    if (h > hMax) h = hMax;
    if (t + h > t1) h = t1 - t;
    if (!(h > 0) || t + h === t) throw new PhysicsError("physics-ode-step-underflow", `step size underflow at t = ${t}`);
    k[0] = f;
    for (let stage = 1; stage < 7; stage += 1) {
      const coefficients = DP_A[stage];
      const yStage = y.map((value, i) => {
        let sum = value;
        for (let j = 0; j < coefficients.length; j += 1) sum += h * coefficients[j] * k[j][i];
        return sum;
      });
      k[stage] = evaluate(t + DP_C[stage] * h, yStage);
    }
    const yNew = y.map((value, i) => {
      let sum = value;
      for (let j = 0; j < 7; j += 1) if (DP_B[j] !== 0) sum += h * DP_B[j] * k[j][i];
      return sum;
    });
    const error = new Array(dimension).fill(0).map((_, i) => {
      let sum = 0;
      for (let j = 0; j < 7; j += 1) if (DP_E[j] !== 0) sum += h * DP_E[j] * k[j][i];
      return sum;
    });
    const errorNorm = norm(error, y, yNew);
    if (errorNorm <= 1) {
      const tNew = t + h;
      const fNew = k[6]; // FSAL
      const previous = { t, y, dy: f };
      t = tNew; y = yNew; f = fNew;
      accepted += 1;
      steps.push({ t, y: y.slice(), dy: f.slice() });
      if (options.event) {
        const crossing = options.event(previous, { t, y, dy: f });
        if (crossing) {
          event = crossing;
          steps.pop();
          steps.push({ t: crossing.t, y: crossing.y, dy: evaluate(crossing.t, crossing.y) });
          break;
        }
      }
      const factor = errorNorm === 0 ? 10 : Math.min(10, Math.max(0.2, 0.9 * Math.pow(errorNorm, -1 / 5)));
      h *= factor;
    } else {
      rejected += 1;
      h *= Math.max(0.2, 0.9 * Math.pow(errorNorm, -1 / 5));
    }
  }
  return { steps, accepted, rejected, event };
}

// Cubic Hermite interpolation between two accepted steps.
function hermite(left, right, t) {
  const h = right.t - left.t;
  if (h === 0) return left.y.slice();
  const s = (t - left.t) / h;
  const s2 = s * s; const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1; const h10 = s3 - 2 * s2 + s; const h01 = -2 * s3 + 3 * s2; const h11 = s3 - s2;
  return left.y.map((value, i) => h00 * value + h10 * h * left.dy[i] + h01 * right.y[i] + h11 * h * right.dy[i]);
}

function interpolateGrid(steps, times) {
  let cursor = 0;
  return times.map((t) => {
    while (cursor < steps.length - 2 && steps[cursor + 1].t < t) cursor += 1;
    const left = steps[cursor];
    const right = steps[Math.min(cursor + 1, steps.length - 1)];
    if (t <= left.t) return left.y.slice();
    if (t >= right.t) return right.y.slice();
    return hermite(left, right, t);
  });
}

// Root of component `index` on the interpolant between two steps by bisection.
function bisectCrossing(left, right, index, targetSign) {
  let lo = left.t; let hi = right.t;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = (lo + hi) / 2;
    const value = hermite(left, right, mid)[index];
    if (Math.abs(hi - lo) <= 1e-10 * Math.max(1, Math.abs(mid))) return { t: mid, y: hermite(left, right, mid) };
    if ((value < 0) === (targetSign < 0)) hi = mid; else lo = mid;
  }
  const t = (lo + hi) / 2;
  return { t, y: hermite(left, right, t) };
}

function crossings(steps, index, direction) {
  const out = [];
  for (let i = 0; i + 1 < steps.length; i += 1) {
    const a = steps[i].y[index]; const b = steps[i + 1].y[index];
    if (direction === "up" ? (a < 0 && b >= 0) : (a > 0 && b <= 0)) out.push(bisectCrossing(steps[i], steps[i + 1], index, direction === "up" ? 1 : -1).t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

const PARAM = (fallback, min, max, unit, description) => ({ fallback, min, max, unit, description });

const SYSTEMS = {
  projectile_drag: {
    defaultSpan: 10,
    title: "Projectile with drag",
    timeUnit: "s",
    parameters: {
      m: PARAM(1, 1e-12, 1e12, "kg", "mass"),
      g: PARAM(9.80665, 0, 1e6, "m/s^2", "gravitational acceleration"),
      drag: { enum: ["none", "linear", "quadratic"], fallback: "quadratic", description: "drag law: none, linear (F = −k v), quadratic (F = −c |v| v)" },
      drag_coefficient: PARAM(0.01, 0, 1e6, "kg/s or kg/m", "k for linear drag, c for quadratic drag"),
    },
    state: [{ name: "x", unit: "m", fallback: 0 }, { name: "y", unit: "m", fallback: 0 }, { name: "vx", unit: "m/s", fallback: 20 }, { name: "vy", unit: "m/s", fallback: 20 }],
    derivative: (p) => (t, [x, y, vx, vy]) => {
      const speed = Math.hypot(vx, vy);
      const factor = p.drag === "none" ? 0 : p.drag === "linear" ? p.drag_coefficient / p.m : p.drag_coefficient * speed / p.m;
      return [vx, vy, -factor * vx, -p.g - factor * vy];
    },
    event: (previous, current) => (previous.y[1] >= 0 && current.y[1] < 0 ? bisectCrossing(previous, current, 1, -1) : null),
    phase: { x: 0, y: 1, label: ["x (m)", "y (m)"] },
    conserved: (p) => (p.drag === "none" ? [{ name: "mechanical energy per mass", unit: "J/kg", value: (t, [, y, vx, vy]) => 0.5 * (vx * vx + vy * vy) + p.g * y }] : []),
  },
  damped_driven_oscillator: {
    defaultSpan: 60,
    title: "Damped driven harmonic oscillator",
    timeUnit: "s",
    parameters: {
      m: PARAM(1, 1e-12, 1e12, "kg", "mass"),
      omega0: PARAM(2 * Math.PI, 1e-9, 1e9, "rad/s", "natural angular frequency"),
      zeta: PARAM(0.05, 0, 100, null, "damping ratio"),
      F0: PARAM(1, 0, 1e12, "N", "drive amplitude"),
      omega_drive: PARAM(2 * Math.PI * 0.9, 0, 1e9, "rad/s", "drive angular frequency"),
    },
    state: [{ name: "x", unit: "m", fallback: 0 }, { name: "v", unit: "m/s", fallback: 0 }],
    derivative: (p) => (t, [x, v]) => [v, (p.F0 / p.m) * Math.cos(p.omega_drive * t) - 2 * p.zeta * p.omega0 * v - p.omega0 * p.omega0 * x],
    phase: { x: 0, y: 1, label: ["x (m)", "v (m/s)"] },
    conserved: (p) => (p.zeta === 0 && p.F0 === 0 ? [{ name: "mechanical energy", unit: "J", value: (t, [x, v]) => 0.5 * p.m * v * v + 0.5 * p.m * p.omega0 * p.omega0 * x * x }] : []),
  },
  nonlinear_pendulum: {
    defaultSpan: 10,
    title: "Nonlinear pendulum",
    timeUnit: "s",
    parameters: {
      g: PARAM(9.80665, 1e-9, 1e6, "m/s^2", "gravitational acceleration"),
      L: PARAM(1, 1e-9, 1e9, "m", "length"),
      m: PARAM(1, 1e-12, 1e12, "kg", "bob mass (energy scale only)"),
      b: PARAM(0, 0, 1e6, "1/s", "angular damping coefficient"),
    },
    state: [{ name: "theta", unit: "rad", fallback: 1 }, { name: "omega", unit: "rad/s", fallback: 0 }],
    derivative: (p) => (t, [theta, omega]) => [omega, -(p.g / p.L) * Math.sin(theta) - p.b * omega],
    phase: { x: 0, y: 1, label: ["θ (rad)", "ω (rad/s)"] },
    conserved: (p) => (p.b === 0 ? [{ name: "mechanical energy", unit: "J", value: (t, [theta, omega]) => 0.5 * p.m * p.L * p.L * omega * omega + p.m * p.g * p.L * (1 - Math.cos(theta)) }] : []),
  },
  rlc_series: {
    defaultSpan: 0.005,
    title: "Series RLC circuit",
    timeUnit: "s",
    parameters: {
      R: PARAM(10, 0, 1e12, "Ω", "resistance"),
      L: PARAM(1e-3, 1e-15, 1e6, "H", "inductance"),
      C: PARAM(1e-6, 1e-18, 1e3, "F", "capacitance"),
      V0: PARAM(1, 0, 1e9, "V", "source amplitude (step when omega = 0)"),
      omega: PARAM(0, 0, 1e12, "rad/s", "source angular frequency (0 = DC step)"),
    },
    state: [{ name: "q", unit: "C", fallback: 0 }, { name: "i", unit: "A", fallback: 0 }],
    derivative: (p) => (t, [q, i]) => [i, ((p.omega === 0 ? p.V0 : p.V0 * Math.cos(p.omega * t)) - p.R * i - q / p.C) / p.L],
    phase: { x: 0, y: 1, label: ["q (C)", "i (A)"] },
    conserved: (p) => (p.R === 0 && p.V0 === 0 ? [{ name: "stored energy", unit: "J", value: (t, [q, i]) => 0.5 * p.L * i * i + 0.5 * q * q / p.C }] : []),
  },
  lorenz: {
    defaultSpan: 20,
    title: "Lorenz system",
    timeUnit: "dimensionless",
    parameters: {
      sigma: PARAM(10, 0, 1e4, null, "σ"),
      rho: PARAM(28, 0, 1e4, null, "ρ"),
      beta: PARAM(8 / 3, 0, 1e4, null, "β"),
    },
    state: [{ name: "x", unit: null, fallback: 1 }, { name: "y", unit: null, fallback: 1 }, { name: "z", unit: null, fallback: 1 }],
    derivative: (p) => (t, [x, y, z]) => [p.sigma * (y - x), x * (p.rho - z) - y, x * y - p.beta * z],
    phase: { x: 0, y: 2, label: ["x", "z"] },
    conserved: () => [],
  },
  two_body_orbit: {
    defaultSpan: 20,
    title: "Two-body orbit (planar relative motion)",
    timeUnit: "s",
    parameters: {
      preset: { enum: ["none", "earth_satellite"], fallback: "none", description: "earth_satellite sets μ = 3.986004418e14 m³/s² and a 400 km circular default state" },
      mu: PARAM(1, 1e-30, 1e30, "m^3/s^2", "gravitational parameter G(M+m)"),
    },
    state: [{ name: "x", unit: "m", fallback: 1 }, { name: "y", unit: "m", fallback: 0 }, { name: "vx", unit: "m/s", fallback: 0 }, { name: "vy", unit: "m/s", fallback: 1 }],
    derivative: (p) => (t, [x, y, vx, vy]) => {
      const r = Math.hypot(x, y);
      if (!(r > 0)) throw new PhysicsError("physics-ode-orbit-singular", "the orbit passed through r = 0");
      const r3 = r * r * r;
      return [vx, vy, -p.mu * x / r3, -p.mu * y / r3];
    },
    phase: { x: 0, y: 1, label: ["x (m)", "y (m)"] },
    conserved: (p) => [
      { name: "specific orbital energy", unit: "J/kg", value: (t, [x, y, vx, vy]) => 0.5 * (vx * vx + vy * vy) - p.mu / Math.hypot(x, y) },
      { name: "specific angular momentum", unit: "m^2/s", value: (t, [x, y, vx, vy]) => x * vy - y * vx },
    ],
  },
  decay_chain: {
    defaultSpan: 300,
    title: "Radioactive decay chain",
    timeUnit: "s",
    parameters: {
      decay_constants: { array: true, min: 0, max: 1e12, unit: "1/s", description: "λ_i for species 1..k (last may be 0 for a stable end)" },
      half_lives: { array: true, min: 1e-12, max: 1e30, unit: "s", description: "alternative to decay_constants; null for a stable species" },
    },
    state: null, // generated from the chain length
    timeUnitFromParameters: true,
    phase: { x: 0, y: 1, label: ["N1", "N2"] },
  },
  logistic: {
    defaultSpan: 10,
    title: "Logistic growth",
    timeUnit: "dimensionless",
    parameters: {
      r: PARAM(1, 0, 1e6, "1/time", "growth rate"),
      K: PARAM(100, 1e-12, 1e30, "count", "carrying capacity"),
    },
    state: [{ name: "N", unit: "count", fallback: 1 }],
    derivative: (p) => (t, [N]) => [p.r * N * (1 - N / p.K)],
    phase: { x: 0, derivative: 0, label: ["N", "dN/dt"] },
    conserved: () => [],
  },
  sir: {
    defaultSpan: 160,
    title: "SIR epidemic",
    timeUnit: "day",
    parameters: {
      beta: PARAM(0.3, 0, 1e3, "1/day", "transmission rate"),
      gamma: PARAM(0.1, 1e-12, 1e3, "1/day", "recovery rate"),
      N: PARAM(1000, 1e-9, 1e15, "count", "population size (used in β S I / N)"),
    },
    state: [{ name: "S", unit: "count", fallback: 990 }, { name: "I", unit: "count", fallback: 10 }, { name: "R", unit: "count", fallback: 0 }],
    derivative: (p) => (t, [S, I]) => [-p.beta * S * I / p.N, p.beta * S * I / p.N - p.gamma * I, p.gamma * I],
    phase: { x: 0, y: 1, label: ["S", "I"] },
    conserved: () => [{ name: "total population", unit: "count", value: (t, [S, I, R]) => S + I + R }],
  },
};

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

function normalizeParameters(system, definition, raw) {
  const record = raw === undefined ? {} : common.exactObject(raw, Object.keys(definition.parameters), `physics-ode-${system}-parameters`);
  const out = {};
  for (const [name, spec] of Object.entries(definition.parameters)) {
    const label = `physics-ode-${system}-parameter-${name}`;
    if (spec.enum) { out[name] = record[name] === undefined ? spec.fallback : common.enumText(record[name], spec.enum, label); continue; }
    if (spec.array) {
      if (record[name] === undefined) continue;
      if (!Array.isArray(record[name]) || record[name].length < 2 || record[name].length > 8) throw new PhysicsError(`${label}-invalid`, `${name} must list 2..8 species`);
      out[name] = record[name].map((value, index) => {
        if (value === null) { if (name === "half_lives") return null; throw new PhysicsError(`${label}-invalid`); }
        return common.finite(value, spec.min, spec.max, `${label}-${index}`);
      });
      continue;
    }
    out[name] = common.optionalFinite(record[name], spec.min, spec.max, label, spec.fallback);
  }
  return out;
}

function normalizeInput(input) {
  const value = common.exactObject(input, ["system", "parameters", "initial_state", "time_span", "options"], "physics-ode-input");
  const system = common.enumText(value.system, Object.keys(SYSTEMS), "physics-ode-system");
  const definition = SYSTEMS[system];
  const parameters = normalizeParameters(system, definition, value.parameters);
  // Resolve derived definitions (presets, chain length).
  let stateDefinition = definition.state;
  let timeUnit = definition.timeUnit;
  if (system === "two_body_orbit" && parameters.preset === "earth_satellite") {
    if (value.parameters && value.parameters.mu !== undefined) throw new PhysicsError("physics-ode-two_body_orbit-preset-conflict", "mu cannot be combined with the earth_satellite preset");
    parameters.mu = 3.986004418e14;
    const r = 6371e3 + 400e3;
    stateDefinition = [{ name: "x", unit: "m", fallback: r }, { name: "y", unit: "m", fallback: 0 }, { name: "vx", unit: "m/s", fallback: 0 }, { name: "vy", unit: "m/s", fallback: Math.sqrt(parameters.mu / r) }];
  } else if (system === "two_body_orbit") {
    stateDefinition = definition.state.map((entry) => ({ ...entry, unit: entry.unit === "m" ? "length (normalized)" : "length/time (normalized)" }));
    timeUnit = "time (normalized)";
  }
  if (system === "decay_chain") {
    if (parameters.decay_constants !== undefined && parameters.half_lives !== undefined) throw new PhysicsError("physics-ode-decay_chain-parameters-conflict", "give decay_constants or half_lives, not both");
    let lambdas;
    if (parameters.decay_constants !== undefined) lambdas = parameters.decay_constants;
    else if (parameters.half_lives !== undefined) lambdas = parameters.half_lives.map((halfLife) => (halfLife === null ? 0 : Math.LN2 / halfLife));
    else lambdas = [Math.LN2 / 10, Math.LN2 / 100, 0];
    if (lambdas.slice(0, -1).some((lambda) => !(lambda > 0))) throw new PhysicsError("physics-ode-decay_chain-lambda-invalid", "only the last species may be stable (λ = 0)");
    parameters.lambdas = lambdas;
    stateDefinition = lambdas.map((_, index) => ({ name: `N${index + 1}`, unit: "count", fallback: index === 0 ? 1 : 0 }));
  }
  const stateInput = value.initial_state === undefined ? {} : common.exactObject(value.initial_state, stateDefinition.map((entry) => entry.name), `physics-ode-${system}-initial-state`);
  const initialState = stateDefinition.map((entry) => common.optionalFinite(stateInput[entry.name], -1e300, 1e300, `physics-ode-${system}-initial-state-${entry.name}`, entry.fallback));
  if (system === "decay_chain" && initialState.some((count) => count < 0)) throw new PhysicsError("physics-ode-decay_chain-initial-state-invalid", "populations must be non-negative");
  if (system === "sir" && initialState.some((count) => count < 0)) throw new PhysicsError("physics-ode-sir-initial-state-invalid", "compartments must be non-negative");
  if (system === "logistic" && !(initialState[0] > 0)) throw new PhysicsError("physics-ode-logistic-initial-state-invalid", "N must be positive");
  const spanInput = value.time_span === undefined ? {} : common.exactObject(value.time_span, ["start", "end"], "physics-ode-time-span");
  const start = common.optionalFinite(spanInput.start, -1e9, 1e9, "physics-ode-time-span-start", 0);
  const defaultSpan = system === "two_body_orbit" && parameters.preset === "earth_satellite" ? 6000 : definition.defaultSpan;
  const end = common.optionalFinite(spanInput.end, -1e9, 1e9, "physics-ode-time-span-end", start + defaultSpan);
  if (!(end > start)) throw new PhysicsError("physics-ode-time-span-invalid", "time_span.end must exceed time_span.start");
  const optionsInput = value.options === undefined ? {} : common.exactObject(value.options, ["rtol", "atol", "output_points", "max_steps"], "physics-ode-options");
  const options = {
    rtol: common.optionalFinite(optionsInput.rtol, 1e-12, 1e-2, "physics-ode-rtol", 1e-8),
    atol: common.optionalFinite(optionsInput.atol, 0, 1e6, "physics-ode-atol", 1e-10),
    outputPoints: common.optionalInteger(optionsInput.output_points, 10, 5_000, "physics-ode-output-points", 1_000),
    maxSteps: common.optionalInteger(optionsInput.max_steps, 100, MAX_STEPS, "physics-ode-max-steps", 100_000),
  };
  return { system, definition, parameters, stateDefinition, initialState, timeSpan: { start, end }, defaultSpan, options, timeUnit };
}

// ---------------------------------------------------------------------------
// System-specific derivative and diagnostics
// ---------------------------------------------------------------------------

function derivativeFor(normalized) {
  const { system, parameters } = normalized;
  if (system === "decay_chain") {
    const lambdas = parameters.lambdas;
    return (t, N) => N.map((count, index) => -lambdas[index] * count + (index > 0 ? lambdas[index - 1] * N[index - 1] : 0));
  }
  return normalized.definition.derivative(parameters);
}

function conservedFor(normalized) {
  const { system, parameters } = normalized;
  if (system === "decay_chain") {
    const last = parameters.lambdas[parameters.lambdas.length - 1];
    return last === 0 ? [{ name: "total nuclei", unit: "count", value: (t, N) => N.reduce((sum, count) => sum + count, 0) }] : [];
  }
  return normalized.definition.conserved(parameters);
}

function bateman(lambdas, N0, t) {
  // General Bateman solution for N1(0) = N0, N_i(0) = 0 (i > 1), distinct λ.
  return lambdas.map((_, i) => {
    let product = N0;
    for (let j = 0; j < i; j += 1) product *= lambdas[j];
    let sum = 0;
    for (let j = 0; j <= i; j += 1) {
      let denominator = 1;
      for (let k = 0; k <= i; k += 1) if (k !== j) denominator *= lambdas[k] - lambdas[j];
      sum += Math.exp(-lambdas[j] * t) / denominator;
    }
    return product * sum;
  });
}

function amplitudeEstimate(times, values, fraction = 0.2) {
  const startIndex = Math.floor(times.length * (1 - fraction));
  let min = Infinity; let max = -Infinity;
  for (let i = startIndex; i < values.length; i += 1) { min = Math.min(min, values[i]); max = Math.max(max, values[i]); }
  return (max - min) / 2;
}

function analyticChecks(normalized, integration, times, states, warnings) {
  const { system, parameters: p, initialState, timeSpan } = normalized;
  const rows = [];
  const push = (quantity, unit, simulated, analytic, note) => rows.push({ quantity, unit, simulated, analytic, deviation: simulated === null || analytic === null ? null : simulated - analytic, relativeDeviation: simulated === null || analytic === null || analytic === 0 ? null : (simulated - analytic) / Math.abs(analytic), note });
  const extras = {};
  if (system === "projectile_drag") {
    const event = integration.event;
    const maxHeight = Math.max(...states.map((state) => state[1]));
    extras.impact = event ? { time: event.t, range: event.y[0], detected: true } : { time: null, range: null, detected: false };
    extras.maxHeight = maxHeight;
    if (!event) warnings.push("The projectile did not reach y < 0 within time_span; range and flight time are not available.");
    if (p.drag === "none") {
      const [, y0, vx0, vy0] = initialState;
      const disc = vy0 * vy0 + 2 * p.g * y0;
      const flight = disc >= 0 && p.g > 0 ? (vy0 + Math.sqrt(disc)) / p.g : null;
      push("flight time", "s", event ? event.t - timeSpan.start : null, flight === null ? null : flight, "drag-free closed form");
      push("range", "m", event ? event.y[0] - initialState[0] : null, flight === null ? null : vx0 * flight, "drag-free closed form");
      push("maximum height", "m", maxHeight, vy0 > 0 ? y0 + vy0 * vy0 / (2 * p.g) : y0, "drag-free closed form (sampled maximum on the output grid)");
    }
  }
  if (system === "damped_driven_oscillator") {
    const analytic = (p.F0 / p.m) / Math.sqrt((p.omega0 ** 2 - p.omega_drive ** 2) ** 2 + (2 * p.zeta * p.omega0 * p.omega_drive) ** 2);
    const phase = Math.atan2(2 * p.zeta * p.omega0 * p.omega_drive, p.omega0 ** 2 - p.omega_drive ** 2);
    const estimate = amplitudeEstimate(times, states.map((state) => state[0]));
    push("steady-state amplitude", "m", estimate, analytic, "estimate: half peak-to-peak of x over the last 20 % of the run");
    push("phase lag", "rad", null, phase, "analytic φ = atan2(2ζω0ωd, ω0²−ωd²)");
    const decay = p.zeta * p.omega0 * 0.8 * (timeSpan.end - timeSpan.start);
    if (decay < 5) warnings.push(`Transient decay exponent over the first 80 % of the run is ${decay.toPrecision(3)} (< 5); the steady-state amplitude estimate still contains transient motion.`);
    if (p.omega_drive > 0) {
      const cycles = p.omega_drive * 0.2 * (timeSpan.end - timeSpan.start) / (2 * Math.PI);
      if (cycles < 1) warnings.push("Fewer than one drive period lies inside the last 20 % of the run; the amplitude estimate is unreliable.");
    }
  }
  if (system === "nonlinear_pendulum") {
    const ups = crossings(integration.steps, 0, "up");
    const measured = ups.length >= 2 ? (ups[ups.length - 1] - ups[0]) / (ups.length - 1) : null;
    const [theta0, omega0] = initialState;
    let exact = null;
    if (p.b === 0 && omega0 === 0 && Math.abs(theta0) > 0 && Math.abs(theta0) < Math.PI) exact = 4 * Math.sqrt(p.L / p.g) * common.completeEllipticK(Math.sin(Math.abs(theta0) / 2));
    push("period", "s", measured, exact, exact === null ? "exact period needs b = 0, ω(0) = 0, 0 < |θ0| < π" : "exact period 4√(L/g)·K(sin(θ0/2))");
    push("small-angle period", "s", measured, 2 * Math.PI * Math.sqrt(p.L / p.g), "2π√(L/g) for comparison");
    if (measured === null) warnings.push("Fewer than two upward zero crossings of θ; the period could not be measured.");
    extras.zeroCrossings = ups.length;
  }
  if (system === "rlc_series") {
    const omega0 = 1 / Math.sqrt(p.L * p.C);
    const Q = p.R > 0 ? omega0 * p.L / p.R : null;
    const discriminant = p.R * p.R - 4 * p.L / p.C;
    extras.resonance = { omega0, frequency: omega0 / (2 * Math.PI), qualityFactor: Q, regime: discriminant < 0 ? "underdamped" : discriminant === 0 ? "critically damped" : "overdamped" };
    push("resonant angular frequency", "rad/s", null, omega0, "ω0 = 1/√(LC)");
    push("quality factor", null, null, Q, "Q = ω0 L / R");
    if (p.omega > 0) {
      const impedance = Math.sqrt(p.R * p.R + (p.omega * p.L - 1 / (p.omega * p.C)) ** 2);
      push("steady-state current amplitude", "A", amplitudeEstimate(times, states.map((state) => state[1])), p.V0 / impedance, "estimate over the last 20 % vs V0/|Z|");
    } else {
      push("final capacitor charge", "C", states[states.length - 1][0], p.V0 * p.C, "step response asymptote q → C V0");
    }
  }
  if (system === "lorenz") {
    extras.note = "No conserved quantity; the attractor is chaotic and pointwise trajectories diverge with tolerance.";
  }
  if (system === "two_body_orbit") {
    const [x, y, vx, vy] = initialState;
    const r = Math.hypot(x, y);
    const energy = 0.5 * (vx * vx + vy * vy) - p.mu / r;
    const h = x * vy - y * vx;
    const eccentricity = Math.sqrt(Math.max(0, 1 + 2 * energy * h * h / (p.mu * p.mu)));
    const a = energy < 0 ? -p.mu / (2 * energy) : null;
    const period = a === null ? null : 2 * Math.PI * Math.sqrt(a ** 3 / p.mu);
    extras.orbitalElements = { semiMajorAxis: a, eccentricity, period, specificEnergy: energy, specificAngularMomentum: h, bound: energy < 0 };
    push("semi-major axis", "length", null, a, "from ε = −μ/(2a)");
    push("eccentricity", null, null, eccentricity, "e = √(1 + 2εh²/μ²)");
    push("orbital period", "time", null, period, "T = 2π√(a³/μ) (bound orbits only)");
    if (energy >= 0) warnings.push("The initial state is unbound (ε ≥ 0); no period is defined.");
  }
  if (system === "decay_chain") {
    const lambdas = p.lambdas;
    const distinct = lambdas.every((a, i) => lambdas.every((b, j) => i === j || Math.abs(a - b) > 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1e-300)));
    const pureStart = initialState.slice(1).every((count) => count === 0);
    if (distinct && pureStart) {
      const maxAbs = new Array(lambdas.length).fill(0);
      const maxRel = new Array(lambdas.length).fill(0);
      times.forEach((t, index) => {
        const analytic = bateman(lambdas, initialState[0], t - times[0]);
        analytic.forEach((value, species) => {
          const deviation = Math.abs(states[index][species] - value);
          maxAbs[species] = Math.max(maxAbs[species], deviation);
          if (Math.abs(value) > 1e-12 * initialState[0]) maxRel[species] = Math.max(maxRel[species], deviation / Math.abs(value));
        });
      });
      lambdas.forEach((_, species) => push(`N${species + 1} max |solver − Bateman|`, "count", maxAbs[species], 0, `max relative deviation ${maxRel[species].toExponential(3)} where N > 1e-12·N0`));
      extras.bateman = { maxAbsoluteDeviation: maxAbs, maxRelativeDeviation: maxRel };
    } else warnings.push(distinct ? "Bateman check requires N1(0) > 0 and all other species initially empty." : "Bateman check skipped: decay constants are not distinct (the closed form is singular).");
    extras.halfLives = lambdas.map((lambda) => (lambda > 0 ? Math.LN2 / lambda : null));
  }
  if (system === "logistic") {
    const N0 = initialState[0];
    let maxAbs = 0;
    times.forEach((t, index) => {
      const analytic = p.K / (1 + (p.K / N0 - 1) * Math.exp(-p.r * (t - times[0])));
      maxAbs = Math.max(maxAbs, Math.abs(states[index][0] - analytic));
    });
    push("max |solver − analytic N(t)|", "count", maxAbs, 0, "N(t) = K / (1 + (K/N0 − 1) e^{−rt})");
    push("final population", "count", states[states.length - 1][0], p.K / (1 + (p.K / N0 - 1) * Math.exp(-p.r * (timeSpan.end - timeSpan.start))), "closed form at t_end");
  }
  if (system === "sir") {
    let peak = { time: times[0], value: states[0][1] };
    states.forEach((state, index) => { if (state[1] > peak.value) peak = { time: times[index], value: state[1] }; });
    extras.peakInfected = peak;
    extras.basicReproductionNumber = p.beta / p.gamma;
    push("basic reproduction number R0", null, null, p.beta / p.gamma, "β/γ");
    push("peak infected", "count", peak.value, null, `at t = ${peak.time} (sampled on the output grid)`);
    push("final susceptible fraction", null, states[states.length - 1][0] / p.N, null, "S(t_end)/N");
  }
  return { rows, extras };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyzeOdeSimulation(input) {
  const normalized = normalizeInput(input);
  const { system, definition, parameters, stateDefinition, initialState, timeSpan, defaultSpan, options, timeUnit } = normalized;
  const warnings = [];
  const derivative = derivativeFor(normalized);
  const integration = integrate(derivative, timeSpan.start, initialState, timeSpan.end, {
    rtol: options.rtol, atol: options.atol, maxSteps: options.maxSteps,
    ...(definition.event ? { event: definition.event } : {}),
  });
  const tEnd = integration.steps[integration.steps.length - 1].t;
  const times = common.linspace(timeSpan.start, tEnd, options.outputPoints);
  const states = interpolateGrid(integration.steps, times);
  const derivatives = times.map((t, index) => derivative(t, states[index]));
  const conserved = conservedFor(normalized);
  const conservedSeries = conserved.map((quantity) => {
    const values = times.map((t, index) => quantity.value(t, states[index]));
    const reference = values[0];
    const relative = values.map((value) => (Math.abs(reference) > 1e-300 ? (value - reference) / Math.abs(reference) : value - reference));
    const maxDrift = Math.max(...relative.map((value) => Math.abs(value)));
    return { name: quantity.name, unit: quantity.unit, initial: reference, final: values[values.length - 1], maxRelativeDrift: maxDrift, relativeMode: Math.abs(reference) > 1e-300 ? "relative" : "absolute", values, relative };
  });
  const checks = analyticChecks(normalized, integration, times, states, warnings);
  const driftThreshold = Math.max(1e3 * options.rtol, 10 * integration.accepted * options.rtol);
  conservedSeries.forEach((series) => { if (series.maxRelativeDrift > driftThreshold) warnings.push(`${series.name} drifts by ${series.maxRelativeDrift.toExponential(3)}, above the heuristic ${driftThreshold.toExponential(2)} (10 × accepted steps × rtol); tighten rtol/atol before trusting long-horizon values.`); });
  if (integration.rejected > integration.accepted) warnings.push("More steps were rejected than accepted; the problem may be stiff for an explicit solver.");
  const stateUnits = stateDefinition.map((entry) => entry.unit);
  const publicationTable = common.scienceTable(`${definition.title} · time series`, [
    { id: "t", label: "t", unit: timeUnit },
    ...stateDefinition.map((entry) => ({ id: entry.name, label: entry.name, unit: entry.unit })),
  ], times.map((t, index) => [t, ...states[index]]));
  const diagnosticsStride = Math.max(1, Math.ceil(times.length / 500));
  const diagnosticsTable = common.scienceTable("Conserved quantities and relative drift", [
    { id: "t", label: "t", unit: timeUnit },
    ...conservedSeries.flatMap((series, index) => [
      { id: `q${index}`, label: series.name, unit: series.unit },
      { id: `d${index}`, label: `${series.name} ${series.relativeMode} drift` },
    ]),
  ], times.filter((_, index) => index % diagnosticsStride === 0 || index === times.length - 1).map((t, position) => {
    const index = Math.min(position * diagnosticsStride, times.length - 1);
    return [t, ...conservedSeries.flatMap((series) => [series.values[index], series.relative[index]])];
  }));
  const checksTable = common.scienceTable("Closed-form and diagnostic checks", [
    { id: "quantity", label: "Quantity", type: "string" }, { id: "unit", label: "Unit", type: "string" }, { id: "simulated", label: "Simulated" }, { id: "analytic", label: "Analytic" },
    { id: "deviation", label: "Deviation" }, { id: "relative", label: "Relative deviation" }, { id: "note", label: "Note", type: "string" },
  ], checks.rows.map((row) => [row.quantity, row.unit, row.simulated, row.analytic, row.deviation, row.relativeDeviation, row.note]));
  // Figure data (downsampled to ≤ 500 grid points).
  const figureStride = Math.max(1, Math.ceil(times.length / 500));
  const figureIndices = times.map((_, index) => index).filter((index) => index % figureStride === 0 || index === times.length - 1);
  const seriesRows = [];
  figureIndices.forEach((index) => stateDefinition.forEach((entry, component) => seriesRows.push({ component: entry.name, t: times[index], value: states[index][component] })));
  const phase = definition.phase;
  // The phase portrait is a curve through state space, not a time series. At the 500 samples the
  // time panel is happy with, a fast trajectory -- a Lorenz wing, an orbit near periapsis -- draws
  // as straight chords between samples and reads as a sketch rather than a solution. It gets its
  // own dense grid, taken from the same Hermite dense output the solver already produces, so the
  // added points are interpolated to the integrator's own order and not invented between measured
  // ones.
  const phaseTimes = times.length >= PHASE_FIGURE_POINTS ? times : common.linspace(timeSpan.start, tEnd, PHASE_FIGURE_POINTS);
  const phaseStates = phaseTimes === times ? states : interpolateGrid(integration.steps, phaseTimes);
  const phaseStride = Math.max(1, Math.ceil(phaseTimes.length / PHASE_FIGURE_POINTS));
  const phaseIndices = phaseTimes.map((_, index) => index).filter((index) => index % phaseStride === 0 || index === phaseTimes.length - 1);
  const phaseRows = phaseIndices.map((index) => ({
    px: phaseStates[index][phase.x],
    py: phase.derivative !== undefined ? derivative(phaseTimes[index], phaseStates[index])[phase.derivative] : phaseStates[index][phase.y],
  }));
  const driftRows = [];
  figureIndices.forEach((index) => conservedSeries.forEach((series) => driftRows.push({ quantity: series.name, t: times[index], drift: series.relative[index] })));
  const width = 680;
  const panels = [
    {
      name: "seriesPanel", height: 260,
      scales: [
        common.linearScale("x", "series", "t", "width"),
        common.linearScale("y", "series", "value", "height"),
        ...common.componentScales("componentColor", "componentDash", "series", "component"),
      ],
      axes: [common.axis("bottom", "x", `t (${timeUnit})`), common.axis("left", "y", "State")],
      legends: [{ stroke: "componentColor", strokeDash: "componentDash", orient: "right", title: "Component" }],
      marks: [{
        type: "group", from: { facet: { name: "componentSeries", data: "series", groupby: "component" } },
        marks: [{ type: "line", from: { data: "componentSeries" }, encode: { enter: { x: { scale: "x", field: "t" }, y: { scale: "y", field: "value" }, stroke: { scale: "componentColor", field: "component" }, strokeDash: { scale: "componentDash", field: "component" }, strokeWidth: { value: 1.6 } } } }],
      }],
    },
    {
      name: "phasePanel", height: 260,
      scales: [common.linearScale("x", "phase", "px", "width"), common.linearScale("y", "phase", "py", "height")],
      axes: [common.axis("bottom", "x", phase.label[0]), common.axis("left", "y", phase.label[1])],
      marks: [common.lineMark("phase", "px", "py", common.PALETTE.fit, { strokeWidth: 1.4 })],
    },
  ];
  if (conservedSeries.length) {
    panels.push({
      name: "driftPanel", height: 140,
      scales: [
        common.linearScale("x", "drift", "t", "width"),
        common.linearScale("y", "drift", "drift", "height", { zero: true }),
        ...common.componentScales("driftColor", "driftDash", "drift", "quantity"),
      ],
      axes: [common.axis("bottom", "x", `t (${timeUnit})`), common.axis("left", "y", "Relative drift")],
      legends: [{ stroke: "driftColor", strokeDash: "driftDash", orient: "right", title: "Conserved quantity" }],
      marks: [{
        type: "group", from: { facet: { name: "driftSeries", data: "drift", groupby: "quantity" } },
        marks: [{ type: "line", from: { data: "driftSeries" }, encode: { enter: { x: { scale: "x", field: "t" }, y: { scale: "y", field: "drift" }, stroke: { scale: "driftColor", field: "quantity" }, strokeDash: { scale: "driftDash", field: "quantity" }, strokeWidth: { value: 1.4 } } } }],
      }],
    });
  }
  const spec = common.stackedVegaFigure({
    description: `${definition.title}: state components versus time, phase-space trajectory (${phase.label[0]} vs ${phase.label[1]})${conservedSeries.length ? ", and relative drift of conserved quantities" : ""}; Dormand–Prince RK5(4), rtol = ${options.rtol}, atol = ${options.atol}.`,
    width,
    data: [{ name: "series", values: seriesRows }, { name: "phase", values: phaseRows }, { name: "drift", values: driftRows }],
    panels,
  });
  const parameterEcho = { ...parameters };
  if (system === "decay_chain") { delete parameterEcho.decay_constants; delete parameterEcho.half_lives; }
  const result = {
    schema: "agentlas.physics.analysis-result/v1",
    analysisId: "ode-simulation",
    method: {
      id: "dormand-prince-rk54-adaptive", version: "1.0.0",
      tableau: "DP5(4) with FSAL", errorNorm: "RMS of error/(atol + rtol·max(|y_n|,|y_{n+1}|))", controller: "Hairer–Nørsett–Wanner safety 0.9, factor bounds [0.2, 10]", interpolation: "cubic Hermite on accepted steps",
      references: [
        "J. R. Dormand, P. J. Prince, A family of embedded Runge–Kutta formulae, J. Comput. Appl. Math. 6, 19 (1980)",
        "E. Hairer, S. P. Nørsett, G. Wanner, Solving Ordinary Differential Equations I, 2nd ed., Springer (1993), §II.4–II.5",
        "H. Bateman, Proc. Cambridge Philos. Soc. 15, 423 (1910) (decay chain solution)",
        "W. O. Kermack, A. G. McKendrick, Proc. R. Soc. A 115, 700 (1927) (SIR model)",
      ],
    },
    input: {
      system, title: definition.title, parameters: parameterEcho,
      parameterUnits: Object.fromEntries(Object.entries(definition.parameters).map(([name, spec]) => [name, spec.unit ?? null])),
      initialState: Object.fromEntries(stateDefinition.map((entry, index) => [entry.name, initialState[index]])),
      stateUnits: Object.fromEntries(stateDefinition.map((entry) => [entry.name, entry.unit])),
      timeUnit, timeSpan, defaultSpan, options,
    },
    summary: {
      acceptedSteps: integration.accepted, rejectedSteps: integration.rejected, storedSteps: integration.steps.length,
      integrationEnd: tEnd, stoppedByEvent: integration.event !== null,
      finalState: Object.fromEntries(stateDefinition.map((entry, index) => [entry.name, states[states.length - 1][index]])),
      conserved: conservedSeries.map((series) => ({ name: series.name, unit: series.unit, initial: series.initial, final: series.final, maxDrift: series.maxRelativeDrift, driftMode: series.relativeMode })),
      checks: checks.rows,
      ...checks.extras,
    },
    publicationTable,
    tables: { diagnostics: diagnosticsTable, checks: checksTable },
    figure: common.figureReceipt(spec),
    boundaries: [
      "Explicit non-stiff solver: stiff problems (large R with small L·C, very disparate decay constants) waste steps or fail with max-steps; no implicit method is provided.",
      "Event handling covers only the projectile ground impact (y crossing below zero); other crossings are reported from the interpolant, not by stopping the integration.",
      "Conserved-quantity drift and closed-form comparisons are diagnostics of the numerical solution, not proofs of accuracy for the requested tolerance.",
      "Lorenz trajectories are chaotic: pointwise values beyond a few Lyapunov times are not reproducible across tolerances or implementations.",
      "Output grid values come from cubic Hermite interpolation between accepted steps (step size capped at 1/200 of the span so the interpolation error stays small for smooth problems); the grid does not affect the integration itself.",
      "Units are declared by the catalogue; the runtime does not convert or check the caller's parameter units.",
    ],
    warnings,
  };
  return common.finalizeAnalysis(result);
}

module.exports = { analyzeOdeSimulation, integrate, hermite, bateman, SYSTEMS };
