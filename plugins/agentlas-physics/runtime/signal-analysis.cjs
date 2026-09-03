"use strict";

// Uniformly sampled signal analysis: windowed FFT (radix-2 for powers of two,
// Bluestein's chirp-z transform otherwise), single-sided amplitude spectrum
// with coherent-gain correction, ENBW-corrected power spectral density,
// dominant peaks with parabolic interpolation, FFT-based autocorrelation,
// an SNR estimate, and an optional STFT spectrogram table.
//
// References: Harris, Proc. IEEE 66, 51 (1978) (windows, coherent gain,
// ENBW); Bluestein, IEEE Trans. Audio Electroacoust. 18, 451 (1970);
// Smith & Serra, ICMC 1987 (quadratic peak interpolation).

const common = require("./analysis-common.cjs");

const { PhysicsError } = common;
const MIN_POINTS = 8;

// ---------------------------------------------------------------------------
// FFT
// ---------------------------------------------------------------------------

function isPowerOfTwo(n) { return n > 0 && (n & (n - 1)) === 0; }
function nextPowerOfTwo(n) { let m = 1; while (m < n) m *= 2; return m; }

// In-place iterative radix-2 FFT (Cooley–Tukey); sign = -1 forward, +1 inverse (unscaled).
function fftRadix2(re, im, sign) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = sign * 2 * Math.PI / length;
    const wRe = Math.cos(angle); const wIm = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let cRe = 1; let cIm = 0;
      for (let k = 0; k < length / 2; k += 1) {
        const a = start + k; const b = a + length / 2;
        const tRe = re[b] * cRe - im[b] * cIm;
        const tIm = re[b] * cIm + im[b] * cRe;
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe; im[a] += tIm;
        const nextRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe; cRe = nextRe;
      }
    }
  }
}

// Bluestein chirp-z for arbitrary n via a radix-2 convolution of size m >= 2n-1.
function fftBluestein(re, im, sign) {
  const n = re.length;
  const m = nextPowerOfTwo(2 * n - 1);
  const chirpRe = new Float64Array(n); const chirpIm = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    const angle = sign * Math.PI * ((k * k) % (2 * n)) / n; // exp(sign·iπk²/n), k² reduced mod 2n
    chirpRe[k] = Math.cos(angle); chirpIm[k] = Math.sin(angle);
  }
  const aRe = new Float64Array(m); const aIm = new Float64Array(m);
  for (let k = 0; k < n; k += 1) {
    // a_k = x_k · conj(chirp_k) for forward (sign -1 in chirp already), general: x_k · exp(sign iπk²/n)
    aRe[k] = re[k] * chirpRe[k] - im[k] * chirpIm[k];
    aIm[k] = re[k] * chirpIm[k] + im[k] * chirpRe[k];
  }
  const bRe = new Float64Array(m); const bIm = new Float64Array(m);
  bRe[0] = chirpRe[0]; bIm[0] = -chirpIm[0];
  for (let k = 1; k < n; k += 1) {
    bRe[k] = chirpRe[k]; bIm[k] = -chirpIm[k];
    bRe[m - k] = chirpRe[k]; bIm[m - k] = -chirpIm[k];
  }
  fftRadix2(aRe, aIm, -1); fftRadix2(bRe, bIm, -1);
  for (let k = 0; k < m; k += 1) {
    const pRe = aRe[k] * bRe[k] - aIm[k] * bIm[k];
    const pIm = aRe[k] * bIm[k] + aIm[k] * bRe[k];
    aRe[k] = pRe; aIm[k] = pIm;
  }
  fftRadix2(aRe, aIm, 1);
  for (let k = 0; k < n; k += 1) {
    const cRe = aRe[k] / m; const cIm = aIm[k] / m;
    re[k] = cRe * chirpRe[k] - cIm * chirpIm[k];
    im[k] = cRe * chirpIm[k] + cIm * chirpRe[k];
  }
}

function fft(re, im, sign = -1) {
  const outRe = Float64Array.from(re); const outIm = Float64Array.from(im);
  if (outRe.length === 1) return { re: outRe, im: outIm };
  if (isPowerOfTwo(outRe.length)) fftRadix2(outRe, outIm, sign); else fftBluestein(outRe, outIm, sign);
  return { re: outRe, im: outIm };
}

function directDft(re, im, sign = -1) {
  const n = re.length;
  const outRe = new Float64Array(n); const outIm = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    let sumRe = 0; let sumIm = 0;
    for (let t = 0; t < n; t += 1) {
      const angle = sign * 2 * Math.PI * ((k * t) % n) / n;
      const c = Math.cos(angle); const s = Math.sin(angle);
      sumRe += re[t] * c - im[t] * s;
      sumIm += re[t] * s + im[t] * c;
    }
    outRe[k] = sumRe; outIm[k] = sumIm;
  }
  return { re: outRe, im: outIm };
}

// ---------------------------------------------------------------------------
// Windows (symmetric definitions, Harris 1978)
// ---------------------------------------------------------------------------

const WINDOWS = {
  rectangular: () => 1,
  hann: (i, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)),
  hamming: (i, n) => 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1)),
  blackman: (i, n) => 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1)),
  blackman_harris: (i, n) => 0.35875 - 0.48829 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.14128 * Math.cos(4 * Math.PI * i / (n - 1)) - 0.01168 * Math.cos(6 * Math.PI * i / (n - 1)),
  flat_top: (i, n) => 0.21557895 - 0.41663158 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.277263158 * Math.cos(4 * Math.PI * i / (n - 1)) - 0.083578947 * Math.cos(6 * Math.PI * i / (n - 1)) + 0.006947368 * Math.cos(8 * Math.PI * i / (n - 1)),
};

function windowValues(name, n) {
  const fn = WINDOWS[name];
  return Array.from({ length: n }, (_, i) => (n === 1 ? 1 : fn(i, n)));
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

function normalizeInput(input) {
  const value = common.exactObject(input, ["table", "value_column", "time_column", "sample_rate", "options"], "physics-signal-input");
  const table = common.verifiedScienceTable(value.table);
  const signal = common.numericColumn(table, value.value_column, "physics-signal-value-column");
  if (value.time_column !== undefined && value.sample_rate !== undefined) throw new PhysicsError("physics-signal-sampling-conflict", "give time_column or sample_rate, not both");
  if (value.time_column === undefined && value.sample_rate === undefined) throw new PhysicsError("physics-signal-sampling-required", "time_column or sample_rate is required");
  const n = signal.values.length;
  if (n < MIN_POINTS) throw new PhysicsError("physics-signal-too-few-points", `at least ${MIN_POINTS} samples are required`);
  let sampleRate; let timeUnit; let timeColumn = null; let sampleInterval; let startTime = 0;
  if (value.time_column !== undefined) {
    const time = common.numericColumn(table, value.time_column, "physics-signal-time-column");
    timeColumn = time.column;
    const diffs = time.values.slice(1).map((t, i) => t - time.values[i]);
    const meanDiff = common.mean(diffs);
    if (!(meanDiff > 0)) throw new PhysicsError("physics-signal-sampling-nonuniform", "time column must increase");
    const maxDeviation = Math.max(...diffs.map((d) => Math.abs(d - meanDiff) / meanDiff));
    if (maxDeviation > 1e-6) throw new PhysicsError("physics-signal-sampling-nonuniform", `sample spacing varies by ${maxDeviation.toExponential(2)} relative (> 1e-6)`);
    sampleInterval = meanDiff;
    sampleRate = 1 / meanDiff;
    startTime = time.values[0];
    timeUnit = time.column.unit;
  } else {
    sampleRate = common.finite(value.sample_rate, Number.MIN_VALUE, 1e15, "physics-signal-sample-rate");
    sampleInterval = 1 / sampleRate;
    timeUnit = "s";
  }
  const frequencyUnit = timeUnit === null ? "cycles per time unit" : timeUnit === "s" ? "Hz" : `1/${timeUnit}`;
  const optionsInput = value.options === undefined ? {} : common.exactObject(value.options, ["window", "detrend", "peak_count", "min_peak_separation_bins", "stft", "autocorrelation_max_lag", "zero_pad_to_power_of_two"], "physics-signal-options");
  let stft = null;
  if (optionsInput.stft !== undefined) {
    const item = common.exactObject(optionsInput.stft, ["frame_size", "hop"], "physics-signal-stft");
    const frameSize = common.optionalInteger(item.frame_size, 16, 4096, "physics-signal-stft-frame-size", 256);
    if (!isPowerOfTwo(frameSize)) throw new PhysicsError("physics-signal-stft-frame-size-invalid", "frame_size must be a power of two");
    const hop = common.optionalInteger(item.hop, 1, 4096, "physics-signal-stft-hop", frameSize / 2);
    if (frameSize > n) throw new PhysicsError("physics-signal-stft-frame-too-long", "frame_size exceeds the number of samples");
    stft = { frameSize, hop };
  }
  const options = {
    window: optionsInput.window === undefined ? "hann" : common.enumText(optionsInput.window, Object.keys(WINDOWS), "physics-signal-window"),
    detrend: optionsInput.detrend === undefined ? "mean" : common.enumText(optionsInput.detrend, ["none", "mean", "linear"], "physics-signal-detrend"),
    peakCount: common.optionalInteger(optionsInput.peak_count, 1, 20, "physics-signal-peak-count", 5),
    minPeakSeparationBins: common.optionalInteger(optionsInput.min_peak_separation_bins, 1, 10_000, "physics-signal-min-peak-separation", 2),
    stft,
    autocorrelationMaxLag: common.optionalInteger(optionsInput.autocorrelation_max_lag, 1, 10_000, "physics-signal-autocorrelation-max-lag", Math.min(n - 1, 2000)),
    zeroPadToPowerOfTwo: common.boolean(optionsInput.zero_pad_to_power_of_two, "physics-signal-zero-pad", false),
  };
  if (options.autocorrelationMaxLag > n - 1) throw new PhysicsError("physics-signal-autocorrelation-max-lag-invalid", "autocorrelation_max_lag must be below the sample count");
  return { table, signal, timeColumn, n, sampleRate, sampleInterval, startTime, timeUnit, frequencyUnit, options };
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function detrend(values, mode) {
  if (mode === "none") return { values: values.slice(), removed: { mean: 0, slope: 0 } };
  if (mode === "mean") { const m = common.mean(values); return { values: values.map((v) => v - m), removed: { mean: m, slope: 0 } }; }
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = common.mean(values);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i += 1) { sxy += (i - xMean) * (values[i] - yMean); sxx += (i - xMean) ** 2; }
  const slope = sxy / sxx;
  return { values: values.map((v, i) => v - (yMean + slope * (i - xMean))), removed: { mean: yMean, slope } };
}

function spectrum(values, window, sampleRate, padTo) {
  const n = values.length;
  const length = padTo ?? n;
  const re = new Float64Array(length); const im = new Float64Array(length);
  let sumW = 0; let sumW2 = 0;
  for (let i = 0; i < n; i += 1) { re[i] = values[i] * window[i]; sumW += window[i]; sumW2 += window[i] * window[i]; }
  const transformed = fft(re, im, -1);
  const bins = Math.floor(length / 2) + 1;
  const resolution = sampleRate / length;
  const amplitude = new Array(bins); const psd = new Array(bins); const magnitude = new Array(bins);
  for (let k = 0; k < bins; k += 1) {
    const mag = Math.hypot(transformed.re[k], transformed.im[k]);
    const single = k === 0 || (length % 2 === 0 && k === length / 2) ? 1 : 2;
    magnitude[k] = mag;
    amplitude[k] = single * mag / sumW;
    psd[k] = single * mag * mag / (sampleRate * sumW2);
  }
  return { amplitude, psd, magnitude, bins, resolution, coherentGain: sumW / n, enbwBins: n * sumW2 / (sumW * sumW), enbw: sampleRate * sumW2 / (sumW * sumW), length };
}

function findPeaks(amplitude, resolution, count, minSeparation) {
  const candidates = [];
  for (let k = 1; k < amplitude.length - 1; k += 1) {
    if (amplitude[k] > amplitude[k - 1] && amplitude[k] >= amplitude[k + 1] && amplitude[k] > 0) candidates.push(k);
  }
  candidates.sort((a, b) => amplitude[b] - amplitude[a] || a - b);
  const selected = [];
  for (const k of candidates) {
    if (selected.length >= count) break;
    if (selected.some((s) => Math.abs(s - k) < minSeparation)) continue;
    selected.push(k);
  }
  return selected.map((k, rank) => {
    const a = Math.log(Math.max(amplitude[k - 1], 1e-300));
    const b = Math.log(amplitude[k]);
    const c = Math.log(Math.max(amplitude[k + 1], 1e-300));
    const denominator = a - 2 * b + c;
    const neighboursResolved = Math.min(amplitude[k - 1], amplitude[k + 1]) > 1e-8 * amplitude[k];
    const delta = neighboursResolved && denominator < 0 ? 0.5 * (a - c) / denominator : 0;
    const clamped = Math.max(-0.5, Math.min(0.5, delta));
    return { rank: rank + 1, bin: k, frequency: k * resolution, refinedFrequency: (k + clamped) * resolution, amplitude: amplitude[k], refinedAmplitude: Math.exp(b - 0.25 * (a - c) * clamped), interpolationOffsetBins: clamped };
  });
}

function autocorrelation(values, maxLag) {
  const n = values.length;
  const length = nextPowerOfTwo(2 * n);
  const re = new Float64Array(length); const im = new Float64Array(length);
  for (let i = 0; i < n; i += 1) re[i] = values[i];
  const forward = fft(re, im, -1);
  const powerRe = new Float64Array(length); const powerIm = new Float64Array(length);
  for (let k = 0; k < length; k += 1) powerRe[k] = forward.re[k] * forward.re[k] + forward.im[k] * forward.im[k];
  const inverse = fft(powerRe, powerIm, 1);
  const zero = inverse.re[0];
  if (!(zero > 0)) return { values: new Array(maxLag + 1).fill(1), firstPeakLag: null };
  const out = Array.from({ length: maxLag + 1 }, (_, lag) => inverse.re[lag] / zero);
  let firstPeakLag = null; let refined = null;
  for (let lag = 1; lag < out.length - 1; lag += 1) {
    if (out[lag] > out[lag - 1] && out[lag] >= out[lag + 1] && out[lag] > 0) {
      firstPeakLag = lag;
      const denominator = out[lag - 1] - 2 * out[lag] + out[lag + 1];
      refined = denominator < 0 ? lag + 0.5 * (out[lag - 1] - out[lag + 1]) / denominator : lag;
      break;
    }
  }
  return { values: out, firstPeakLag, refinedPeakLag: refined };
}

function stftSpectrogram(values, sampleRate, window, frameSize, hop) {
  const frames = [];
  for (let start = 0; start + frameSize <= values.length; start += hop) frames.push(start);
  if (!frames.length) throw new PhysicsError("physics-signal-stft-no-frames");
  const bins = frameSize / 2 + 1;
  const resolution = sampleRate / frameSize;
  const rows = frames.map((start) => {
    const frame = values.slice(start, start + frameSize);
    const s = spectrum(frame, window, sampleRate, null);
    return { time: (start + frameSize / 2) / sampleRate, psd: s.psd };
  });
  return { frames: rows, bins, resolution, frameCount: frames.length, frameDuration: frameSize / sampleRate, hopDuration: hop / sampleRate };
}

function decibel(power) { return 10 * Math.log10(Math.max(power, 1e-300)); }

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyzeSignal(input) {
  const normalized = normalizeInput(input);
  const { signal, n, sampleRate, sampleInterval, startTime, timeUnit, frequencyUnit, options } = normalized;
  const warnings = [];
  const detrended = detrend(signal.values, options.detrend);
  const window = windowValues(options.window, n);
  const padTo = options.zeroPadToPowerOfTwo ? nextPowerOfTwo(n) : null;
  const spec = spectrum(detrended.values, window, sampleRate, padTo);
  const peaks = findPeaks(spec.amplitude, spec.resolution, options.peakCount, options.minPeakSeparationBins);
  if (!peaks.length) warnings.push("No interior spectral maximum was found; the signal may be constant or dominated by DC.");
  // SNR estimate: power in the top-K peak bins ±1 versus everything else (DC bin excluded).
  const peakBins = new Set();
  peaks.forEach((peak) => [peak.bin - 1, peak.bin, peak.bin + 1].forEach((k) => { if (k >= 1 && k < spec.bins) peakBins.add(k); }));
  let peakPower = 0; let restPower = 0; let totalPower = 0;
  for (let k = 1; k < spec.bins; k += 1) { totalPower += spec.psd[k]; if (peakBins.has(k)) peakPower += spec.psd[k]; else restPower += spec.psd[k]; }
  const snrDb = restPower > 0 ? 10 * Math.log10(peakPower / restPower) : null;
  if (snrDb === null) warnings.push("The residual spectrum has zero power, so the SNR estimate is undefined.");
  const acf = autocorrelation(detrended.values, options.autocorrelationMaxLag);
  const periodEstimate = acf.refinedPeakLag === null ? null : acf.refinedPeakLag * sampleInterval;
  const nyquist = sampleRate / 2;
  const highBandPower = (() => { let sum = 0; const start = Math.floor(0.9 * (spec.bins - 1)); for (let k = start; k < spec.bins; k += 1) sum += spec.psd[k]; return sum; })();
  if (totalPower > 0 && highBandPower / totalPower > 0.1) warnings.push("More than 10 % of the power lies within 10 % of the Nyquist frequency; aliasing or under-sampling is possible.");
  if (options.window === "rectangular") warnings.push("Rectangular window: spectral leakage from strong tones can mask weaker components.");
  const spectrogram = options.stft ? stftSpectrogram(detrended.values, sampleRate, windowValues(options.window, options.stft.frameSize), options.stft.frameSize, options.stft.hop) : null;
  // Tables
  const peaksTable = common.scienceTable(`Dominant spectral peaks · ${normalized.table.title}`, [
    { id: "rank", label: "Rank" }, { id: "bin", label: "Bin" }, { id: "frequency", label: "Bin frequency", unit: frequencyUnit }, { id: "refinedFrequency", label: "Refined frequency", unit: frequencyUnit },
    { id: "amplitude", label: "Bin amplitude", unit: signal.column.unit }, { id: "refinedAmplitude", label: "Refined amplitude", unit: signal.column.unit }, { id: "powerFraction", label: "Power fraction" }, { id: "period", label: "Period", unit: timeUnit },
  ], peaks.map((peak) => [peak.rank, peak.bin, peak.frequency, peak.refinedFrequency, peak.amplitude, peak.refinedAmplitude, totalPower > 0 ? [peak.bin - 1, peak.bin, peak.bin + 1].filter((k) => k >= 1 && k < spec.bins).reduce((sum, k) => sum + spec.psd[k], 0) / totalPower : null, peak.refinedFrequency > 0 ? 1 / peak.refinedFrequency : null]));
  const spectrumStride = Math.max(1, Math.ceil(spec.bins / 2000));
  const spectrumTable = common.scienceTable("Single-sided spectrum", [
    { id: "frequency", label: "Frequency", unit: frequencyUnit }, { id: "amplitude", label: "Amplitude", unit: signal.column.unit }, { id: "psd", label: "Power spectral density", unit: signal.column.unit ? `${signal.column.unit}²/${frequencyUnit}` : `1/${frequencyUnit}` },
  ], spec.amplitude.map((a, k) => [k * spec.resolution, a, spec.psd[k]]).filter((_, k) => k % spectrumStride === 0 || k === spec.bins - 1));
  const acfStride = Math.max(1, Math.ceil(acf.values.length / 2000));
  const acfTable = common.scienceTable("Autocorrelation (biased, normalized)", [
    { id: "lag", label: "Lag", unit: timeUnit }, { id: "lagSamples", label: "Lag (samples)" }, { id: "r", label: "Autocorrelation" },
  ], acf.values.map((r, lag) => [lag * sampleInterval, lag, r]).filter((_, lag) => lag % acfStride === 0 || lag === acf.values.length - 1));
  const tables = { spectrum: spectrumTable, autocorrelation: acfTable };
  let spectrogramRows = [];
  let spectrogramRects = [];
  if (spectrogram) {
    const cells = spectrogram.frameCount * spectrogram.bins;
    const frameStride = Math.max(1, Math.ceil(spectrogram.frameCount / Math.sqrt(4000 * spectrogram.frameCount / spectrogram.bins)));
    const binStride = Math.max(1, Math.ceil(spectrogram.bins / Math.sqrt(4000 * spectrogram.bins / spectrogram.frameCount)));
    spectrogram.frames.forEach((frame, frameIndex) => {
      if (frameIndex % frameStride !== 0) return;
      for (let k = 0; k < spectrogram.bins; k += binStride) spectrogramRows.push([startTime + frame.time, k * spectrogram.resolution, decibel(frame.psd[k])]);
    });
    if (spectrogramRows.length > 4000) spectrogramRows = spectrogramRows.filter((_, index) => index % Math.ceil(spectrogramRows.length / 4000) === 0);
    tables.spectrogram = common.scienceTable(`STFT spectrogram (${spectrogram.frameCount} frames × ${spectrogram.bins} bins, downsampled)`, [
      { id: "time", label: "Frame center time", unit: timeUnit }, { id: "frequency", label: "Frequency", unit: frequencyUnit }, { id: "powerDb", label: "Power spectral density", unit: "dB" },
    ], spectrogramRows);
    const rectFrameStride = Math.max(1, Math.ceil(spectrogram.frameCount / Math.sqrt(6000 * spectrogram.frameCount / spectrogram.bins)));
    const rectBinStride = Math.max(1, Math.ceil(spectrogram.bins / Math.sqrt(6000 * spectrogram.bins / spectrogram.frameCount)));
    const rectFrames = spectrogram.frames.filter((_, index) => index % rectFrameStride === 0);
    rectFrames.forEach((frame, position) => {
      const nextTime = position + 1 < rectFrames.length ? rectFrames[position + 1].time : frame.time + spectrogram.hopDuration * rectFrameStride;
      for (let k = 0; k < spectrogram.bins; k += rectBinStride) {
        let power = 0; let count = 0;
        for (let j = k; j < Math.min(spectrogram.bins, k + rectBinStride); j += 1) { power += frame.psd[j]; count += 1; }
        spectrogramRects.push({ t0: startTime + frame.time, t1: startTime + nextTime, f0: k * spectrogram.resolution, f1: Math.min(spectrogram.bins - 1, k + rectBinStride) * spectrogram.resolution, powerDb: decibel(power / count) });
      }
    });
    if (spectrogramRects.length > 6000) spectrogramRects = spectrogramRects.filter((_, index) => index % Math.ceil(spectrogramRects.length / 6000) === 0);
    void cells;
  }
  // Figure
  const width = 680;
  const seriesStride = Math.max(1, Math.ceil(n / 2000));
  const seriesRows = signal.values.map((v, i) => ({ t: startTime + i * sampleInterval, value: v })).filter((_, i) => i % seriesStride === 0 || i === n - 1);
  const spectrumFigureStride = Math.max(1, Math.ceil(spec.bins / 2000));
  const spectrumRows = spec.amplitude.map((a, k) => ({ frequency: k * spec.resolution, amplitude: a })).filter((_, k) => k % spectrumFigureStride === 0 || k === spec.bins - 1);
  const peakRows = peaks.map((peak) => ({ frequency: peak.refinedFrequency, amplitude: peak.amplitude, rank: peak.rank }));
  const acfRows = acf.values.map((r, lag) => ({ lag: lag * sampleInterval, r })).filter((_, lag) => lag % acfStride === 0 || lag === acf.values.length - 1);
  const timeLabel = `t${timeUnit ? ` (${timeUnit})` : ""}`;
  const valueLabel = `${signal.column.name}${signal.column.unit ? ` (${signal.column.unit})` : ""}`;
  const panels = [
    {
      name: "seriesPanel", height: 180,
      scales: [common.linearScale("x", "series", "t", "width"), common.linearScale("y", "series", "value", "height")],
      axes: [common.axis("bottom", "x", timeLabel), common.axis("left", "y", valueLabel)],
      marks: [common.lineMark("series", "t", "value", common.PALETTE.data, { strokeWidth: 1.2 })],
    },
    {
      name: "spectrumPanel", height: 220,
      scales: [common.linearScale("x", "spectrum", "frequency", "width", { zero: true }), common.linearScale("y", "spectrum", "amplitude", "height", { zero: true })],
      axes: [common.axis("bottom", "x", `Frequency (${frequencyUnit})`), common.axis("left", "y", `Amplitude${signal.column.unit ? ` (${signal.column.unit})` : ""}`)],
      marks: [
        common.lineMark("spectrum", "frequency", "amplitude", common.PALETTE.fit, { strokeWidth: 1.4 }),
        common.symbolMark("peaks", "frequency", "amplitude", common.PALETTE.data, { size: 70, tooltip: "rank" }),
      ],
    },
  ];
  if (spectrogram) {
    panels.push({
      name: "spectrogramPanel", height: 220,
      scales: [
        { name: "x", type: "linear", domain: { data: "spectrogram", fields: ["t0", "t1"] }, range: "width", nice: false, zero: false },
        { name: "y", type: "linear", domain: { data: "spectrogram", fields: ["f0", "f1"] }, range: "height", nice: false, zero: true },
        { name: "color", type: "linear", domain: { data: "spectrogram", field: "powerDb" }, range: { scheme: "viridis" } },
      ],
      axes: [common.axis("bottom", "x", timeLabel), common.axis("left", "y", `Frequency (${frequencyUnit})`, { grid: false })],
      legends: [{ fill: "color", orient: "right", title: "PSD (dB)" }],
      marks: [{ type: "rect", from: { data: "spectrogram" }, encode: { enter: { x: { scale: "x", field: "t0" }, x2: { scale: "x", field: "t1" }, y: { scale: "y", field: "f0" }, y2: { scale: "y", field: "f1" }, fill: { scale: "color", field: "powerDb" } } } }],
    });
  } else {
    panels.push({
      name: "autocorrelationPanel", height: 160,
      scales: [common.linearScale("x", "autocorrelation", "lag", "width", { zero: true }), common.linearScale("y", "autocorrelation", "r", "height", { zero: true })],
      axes: [common.axis("bottom", "x", `Lag${timeUnit ? ` (${timeUnit})` : ""}`), common.axis("left", "y", "Autocorrelation")],
      marks: [common.horizontalRule("autocorrelation", 0, common.PALETTE.neutral, { width }), common.lineMark("autocorrelation", "lag", "r", common.PALETTE.component[0], { strokeWidth: 1.4 })],
    });
  }
  const figure = common.stackedVegaFigure({
    description: `Signal ${signal.column.name}: time series, single-sided ${options.window} amplitude spectrum with the ${peaks.length} dominant peaks marked, and ${spectrogram ? "an STFT spectrogram" : "the normalized autocorrelation"}; fs = ${sampleRate} ${frequencyUnit}, Δf = ${spec.resolution} ${frequencyUnit}.`,
    width,
    data: [
      { name: "series", values: seriesRows }, { name: "spectrum", values: spectrumRows }, { name: "peaks", values: peakRows },
      { name: "autocorrelation", values: acfRows }, { name: "spectrogram", values: spectrogramRects },
    ],
    panels,
  });
  const result = {
    schema: "agentlas.physics.analysis-result/v1",
    analysisId: "signal-analysis",
    method: {
      id: "windowed-fft-spectrum-peaks-autocorrelation", version: "1.0.0",
      fft: isPowerOfTwo(spec.length) ? "radix-2 iterative Cooley–Tukey" : "Bluestein chirp-z over a radix-2 convolution",
      amplitudeNormalization: "single-sided |X_k|·(2 or 1)/Σw (coherent gain corrected)",
      psdNormalization: "single-sided |X_k|²·(2 or 1)/(fs·Σw²)",
      peakInterpolation: "quadratic on log amplitude (Smith & Serra 1987)",
      autocorrelation: "biased estimator via zero-padded FFT, normalized to r(0) = 1",
      references: [
        "F. J. Harris, On the use of windows for harmonic analysis with the discrete Fourier transform, Proc. IEEE 66, 51 (1978)",
        "L. I. Bluestein, A linear filtering approach to the computation of discrete Fourier transform, IEEE Trans. Audio Electroacoust. 18, 451 (1970)",
        "J. O. Smith, X. Serra, PARSHL: an analysis/synthesis program for non-harmonic sounds, Proc. ICMC (1987) (quadratic peak interpolation)",
      ],
    },
    input: {
      title: normalized.table.title, valueColumn: signal.column.name, valueUnit: signal.column.unit,
      timeColumn: normalized.timeColumn ? normalized.timeColumn.name : null, timeUnit, sampleRate, sampleRateSource: normalized.timeColumn ? "inferred-from-time-column" : "declared-sample-rate-assumed-Hz",
      sampleCount: n, startTime, options: { ...options, stft: options.stft },
    },
    summary: {
      sampleRate, sampleInterval, duration: (n - 1) * sampleInterval, nyquistFrequency: nyquist, frequencyUnit, frequencyResolution: spec.resolution, transformLength: spec.length,
      window: { name: options.window, coherentGain: spec.coherentGain, enbwBins: spec.enbwBins, enbw: spec.enbw },
      detrend: { mode: options.detrend, ...detrended.removed },
      peaks,
      dominantFrequency: peaks.length ? peaks[0].refinedFrequency : null,
      dominantPeriod: peaks.length && peaks[0].refinedFrequency > 0 ? 1 / peaks[0].refinedFrequency : null,
      autocorrelation: { firstPeakLagSamples: acf.firstPeakLag, refinedPeakLagSamples: acf.refinedPeakLag, periodEstimate, maxLag: options.autocorrelationMaxLag },
      snrEstimateDb: snrDb, snrPeakBinCount: peakBins.size, totalPower, peakPower, residualPower: restPower,
      spectrogram: spectrogram ? { frameCount: spectrogram.frameCount, bins: spectrogram.bins, frameDuration: spectrogram.frameDuration, hopDuration: spectrogram.hopDuration, resolution: spectrogram.resolution, tableRows: spectrogramRows.length } : null,
    },
    publicationTable: peaksTable,
    tables,
    figure: common.figureReceipt(figure),
    boundaries: [
      "Uniform sampling is required (spacing checked to 1e-6 relative); no resampling or gap handling is performed.",
      "Frequencies above the Nyquist frequency fs/2 fold back into the spectrum; the aliasing warning is a heuristic on high-band power, not a proof of adequate sampling.",
      "Amplitudes are coherent-gain corrected for the chosen window, so a pure tone of amplitude A that falls exactly on a bin reads A; off-bin tones read lower (scalloping loss) unless the refined amplitude is used.",
      "The SNR estimate assumes the top-K peaks (±1 bin) are signal and everything else (DC excluded) is noise; broadband signals or harmonics beyond K make it misleading.",
      "Peak frequencies are refined by quadratic interpolation and are only meaningful for isolated, well-resolved tones (separation > 2 bins).",
      "The autocorrelation period estimate is the first local maximum; it is unreliable for multi-tone or strongly damped signals.",
      "No statistical uncertainty is assigned to spectral estimates; use repeated segments or STFT variance for that.",
    ],
    warnings,
  };
  return common.finalizeAnalysis(result);
}

module.exports = { analyzeSignal, fft, directDft, windowValues, WINDOWS, findPeaks, autocorrelation, isPowerOfTwo, nextPowerOfTwo };
