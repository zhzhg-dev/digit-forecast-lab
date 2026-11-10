export const METHODS = [
  { id: 'uniform', label: '均匀基线', description: '每个数字的概率都是 10%。' },
  { id: 'frequency', label: '平滑频率', description: '按历史频率估计数字概率，并给未出现的数字保留概率。' },
  { id: 'markov', label: '一阶转移', description: '根据上一位估计下一位的分布，多步预测逐步传播概率。' },
  { id: 'lag', label: '滞后混合（MTD）', description: '混合频率与相隔 1–12 位的转移。验证优势不足时使用平滑频率。' }
];

const DIGIT_COUNT = 10;
const MAX_DIGITS = 20_000;
const MAX_HORIZON = 20;
const MAX_ORIGINS = 150;
const MAX_LAG = 12;
const MIXTURE_SIZE = MAX_LAG + 1;
const MIXTURE_ITERATIONS = 16;
const MIN_LAG_HISTORY = 60;
const LAG_VALIDATION_MARGIN = 0.02;
const TRANSITION_PRIOR = 10;
const UINT32_RANGE = 2 ** 32;
const DEFAULT_SEED = 1729;

function requireInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label}须为 ${min}–${max} 之间的整数。`);
  }
}

function requireDigits(digits) {
  if (!Array.isArray(digits) || digits.length > MAX_DIGITS) {
    throw new RangeError(`序列须为至多 ${MAX_DIGITS} 位数字的数组。`);
  }
  for (const digit of digits) requireInteger(digit, 0, 9, '数字');
}

export function parseSequence(text) {
  if (typeof text !== 'string') throw new TypeError('请输入数字序列。');

  const compact = text.replace(/[\s,，、]/g, '');
  if (compact.length > MAX_DIGITS) throw new RangeError(`序列最多 ${MAX_DIGITS} 位。`);
  if (/[^0-9０-９]/.test(compact)) {
    throw new TypeError('序列仅接受 0–9 数字，允许用空白或逗号分隔。');
  }
  return Array.from(compact, digit => {
    const code = digit.charCodeAt(0);
    return code >= 0xff10 ? code - 0xff10 : code - 0x30;
  });
}

function uniformDistribution() {
  return Array(DIGIT_COUNT).fill(1 / DIGIT_COUNT);
}

function frequencyDistribution(digits, end = digits.length) {
  const counts = Array(DIGIT_COUNT).fill(1);
  for (let index = 0; index < end; index += 1) counts[digits[index]] += 1;
  return counts.map(count => count / (end + DIGIT_COUNT));
}

function fitTransitions(digits, lag, end, frequency) {
  const counts = Array.from({ length: DIGIT_COUNT }, () => Array(DIGIT_COUNT).fill(0));
  const totals = Array(DIGIT_COUNT).fill(0);
  for (let index = lag; index < end; index += 1) {
    const previous = digits[index - lag];
    counts[previous][digits[index]] += 1;
    totals[previous] += 1;
  }
  return counts.map((row, previous) => row.map((count, digit) => (
    (count + TRANSITION_PRIOR * frequency[digit]) / (totals[previous] + TRANSITION_PRIOR)
  )));
}

function fitLagTables(digits, end, frequency) {
  return Array.from({ length: MAX_LAG }, (_, index) => fitTransitions(digits, index + 1, end, frequency));
}

function observedProbabilities(digits, start, end, frequency, tables) {
  const likelihoods = new Float64Array((end - start) * MIXTURE_SIZE);
  for (let index = start; index < end; index += 1) {
    const offset = (index - start) * MIXTURE_SIZE;
    const actual = digits[index];
    likelihoods[offset] = frequency[actual];
    for (let lag = 1; lag <= MAX_LAG; lag += 1) {
      likelihoods[offset + lag] = tables[lag - 1][digits[index - lag]][actual];
    }
  }
  return likelihoods;
}

function weightedLikelihood(likelihoods, offset, weights) {
  let total = 0;
  for (let component = 0; component < MIXTURE_SIZE; component += 1) {
    total += weights[component] * likelihoods[offset + component];
  }
  return total;
}

function fitMixtureWeights(likelihoods) {
  const weights = new Float64Array(MIXTURE_SIZE).fill(0.5 / MAX_LAG);
  weights[0] = 0.5;
  const responsibilitySums = new Float64Array(MIXTURE_SIZE);
  const observations = likelihoods.length / MIXTURE_SIZE;

  for (let iteration = 0; iteration < MIXTURE_ITERATIONS; iteration += 1) {
    responsibilitySums.fill(0);
    for (let offset = 0; offset < likelihoods.length; offset += MIXTURE_SIZE) {
      const total = weightedLikelihood(likelihoods, offset, weights);
      for (let component = 0; component < MIXTURE_SIZE; component += 1) {
        responsibilitySums[component] += weights[component] * likelihoods[offset + component] / total;
      }
    }
    for (let component = 0; component < MIXTURE_SIZE; component += 1) {
      weights[component] = responsibilitySums[component] / observations;
    }
  }
  return weights;
}

function validatedMixture(digits) {
  if (digits.length < MIN_LAG_HISTORY) return null;

  // Keep separate chronological portions for tables, weights and validation.
  const tableEnd = Math.floor(digits.length * 0.6);
  const weightEnd = Math.floor(digits.length * 0.8);
  const frequency = frequencyDistribution(digits, tableEnd);
  const tables = fitLagTables(digits, tableEnd, frequency);
  const weights = fitMixtureWeights(observedProbabilities(digits, tableEnd, weightEnd, frequency, tables));
  const validation = observedProbabilities(digits, weightEnd, digits.length, frequency, tables);
  let gain = 0;
  for (let offset = 0; offset < validation.length; offset += MIXTURE_SIZE) {
    gain += Math.log(weightedLikelihood(validation, offset, weights)) - Math.log(validation[offset]);
  }
  return gain > LAG_VALIDATION_MARGIN * (digits.length - weightEnd) ? weights : null;
}

function advance(distribution, transitions) {
  const next = Array(DIGIT_COUNT).fill(0);
  for (let previous = 0; previous < DIGIT_COUNT; previous += 1) {
    for (let digit = 0; digit < DIGIT_COUNT; digit += 1) {
      next[digit] += distribution[previous] * transitions[previous][digit];
    }
  }
  return next;
}

function repeatDistribution(distribution, horizon) {
  return Array.from({ length: horizon }, () => distribution.slice());
}

function forecastMarkov(digits, horizon, frequency) {
  const transitions = fitTransitions(digits, 1, digits.length, frequency);
  const lastDigit = digits[digits.length - 1];
  const firstForecast = lastDigit === undefined ? frequency : transitions[lastDigit];
  const forecasts = [firstForecast.slice()];
  for (let step = 1; step < horizon; step += 1) {
    forecasts.push(advance(forecasts[step - 1], transitions));
  }
  return forecasts;
}

function forecastMixture(digits, horizon, frequency) {
  const weights = validatedMixture(digits);
  if (weights === null) return repeatDistribution(frequency, horizon);

  const tables = fitLagTables(digits, digits.length, frequency);
  const forecasts = [];
  for (let step = 0; step < horizon; step += 1) {
    const distribution = frequency.map(probability => weights[0] * probability);
    for (let lag = 1; lag <= MAX_LAG; lag += 1) {
      const previous = step - lag;
      const table = tables[lag - 1];
      // Additivity makes each component's marginal sufficient, even when lags are dependent.
      const component = previous < 0 ? table[digits[digits.length + previous]] : advance(forecasts[previous], table);
      for (let digit = 0; digit < DIGIT_COUNT; digit += 1) {
        distribution[digit] += weights[lag] * component[digit];
      }
    }
    forecasts.push(distribution);
  }
  return forecasts;
}

function forecast(history, horizon) {
  const frequency = frequencyDistribution(history);
  return {
    uniform: repeatDistribution(uniformDistribution(), horizon),
    frequency: repeatDistribution(frequency, horizon),
    markov: forecastMarkov(history, horizon, frequency),
    lag: forecastMixture(history, horizon, frequency)
  };
}

export function predict(history, horizon = 1) {
  requireDigits(history);
  requireInteger(horizon, 1, MAX_HORIZON, '预测步数');
  return forecast(history, horizon);
}

// Resolve probability ties consistently with the displayed point forecast.
function mostLikely(distribution) {
  let guess = 0;
  for (let digit = 1; digit < DIGIT_COUNT; digit += 1) {
    if (distribution[digit] > distribution[guess]) guess = digit;
  }
  return guess;
}

export function backtest(sequence, historyLength, horizon, options = {}) {
  requireDigits(sequence);
  requireInteger(historyLength, 1, MAX_DIGITS, '历史窗口');
  requireInteger(horizon, 1, MAX_HORIZON, '预测步数');
  const maxOrigins = options.maxOrigins ?? MAX_ORIGINS;
  requireInteger(maxOrigins, 1, MAX_ORIGINS, '回测窗口上限');

  const lastOrigin = sequence.length - horizon;
  const origins = Math.max(0, Math.min(maxOrigins, 1 + Math.floor((lastOrigin - historyLength) / horizon)));
  const totals = METHODS.map(({ id }) => ({
    id,
    steps: Array.from({ length: horizon }, () => ({ hits: 0, loss: 0 })),
    fullMatches: 0
  }));

  // Align to the end of the sequence, with disjoint target blocks.
  const firstOrigin = lastOrigin - (origins - 1) * horizon;
  for (let origin = firstOrigin; origin <= lastOrigin; origin += horizon) {
    const locked = forecast(sequence.slice(origin - historyLength, origin), horizon);
    for (const method of totals) {
      let matches = 0;
      for (let step = 0; step < horizon; step += 1) {
        const distribution = locked[method.id][step];
        const actual = sequence[origin + step];
        const hit = Number(mostLikely(distribution) === actual);
        method.steps[step].hits += hit;
        method.steps[step].loss -= Math.log(distribution[actual]);
        matches += hit;
      }
      method.fullMatches += Number(matches === horizon);
    }
  }

  const results = totals.map(({ id, steps, fullMatches }) => ({
    id,
    steps: steps.map(({ hits, loss }) => ({
      accuracy: origins === 0 ? null : hits / origins,
      logLoss: origins === 0 ? null : loss / origins
    })),
    fullMatchRate: origins === 0 ? null : fullMatches / origins
  }));
  return { origins, historyLength, horizon, results };
}

function makeToyDigitSampler(seed) {
  let state = seed;
  return () => {
    let word;
    do {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = Math.imul(state ^ (state >>> 15), state | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      word = (mixed ^ (mixed >>> 14)) >>> 0;
    } while (word >= UINT32_RANGE - (UINT32_RANGE % DIGIT_COUNT));
    return word % DIGIT_COUNT;
  };
}

export function syntheticSequence(kind, length, seed = DEFAULT_SEED) {
  if (!['uniform', 'biased', 'short', 'long'].includes(kind)) {
    throw new TypeError('未知的合成样本。');
  }
  requireInteger(length, 0, MAX_DIGITS, '样本长度');
  const seedValue = typeof seed === 'string' && /^[0-9]+$/.test(seed.trim()) ? Number(seed) : seed;
  requireInteger(seedValue, 0, UINT32_RANGE - 1, '模拟种子');
  const drawDigit = makeToyDigitSampler(seedValue);
  const lag = kind === 'short' ? 1 : 5;
  const digits = [];
  for (let index = 0; index < length; index += 1) {
    if (kind === 'biased' && drawDigit() < 4) {
      digits.push(7);
    } else if ((kind === 'short' || kind === 'long') && index >= lag && drawDigit() < 6) {
      digits.push(digits[index - lag]);
    } else {
      digits.push(drawDigit());
    }
  }
  return digits;
}
