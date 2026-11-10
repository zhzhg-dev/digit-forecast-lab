import { isDeepStrictEqual } from 'node:util';
import { backtest, METHODS, predict, syntheticSequence, verifiedPeriod } from '../forecast.mjs';

const HORIZON = 5;
const STREAMS = 400;
const ACCURACY_GAP = 0.03;
const LOSS_EXCESS = { frequency: 0.02, markov: 0.04, lag: 0.04, transformer: 0.06 };
const COPY_RATE = 0.6;
const COPY_ACCURACY = 0.1 + 0.9 * COPY_RATE;
const BASE_SEED = 0x2f6a2917;
const PROTOCOL = {
  version: 1,
  streamsPerCase: STREAMS,
  horizon: HORIZON,
  accuracyGapTolerance: ACCURACY_GAP,
  lossExcessTolerances: LOSS_EXCESS,
};

// The cases, seed family, and bounds are fixed before the hybrid is evaluated.
const CASES = [
  { id: 'uniform', label: '独立均匀', kind: 'uniform', historyLength: 1024, gates: { uniform: 'uniform', periodic: 'reject' } },
  { id: 'biased', label: '独立偏置，优势数字轮换', kind: 'biased', historyLength: 1024, gates: { frequency: 'stochastic' } },
  { id: 'lag1', label: '滞后 1，60% 复制', kind: 'copy', period: 1, historyLength: 8192, gates: { markov: 'stochastic' } },
  { id: 'markov-cycle', label: '十个不同数字构成的确定性转移环', kind: 'permutation', period: 10, historyLength: 8192, gates: { markov: 'exact' } },
  { id: 'lag8', label: '滞后 8，60% 复制', kind: 'copy', period: 8, historyLength: 8192, gates: { lag: 'stochastic', periodic: 'reject' } },
  { id: 'mtd-cycle', label: '精确重复 8 位，长历史', kind: 'period', period: 8, historyLength: 8192, gates: { lag: 'exact' } },
  ...[8, 64, 257].map((period) => ({
    id: `period${period}`, label: `精确重复 ${period} 位，三次完整循环`, kind: 'period', period,
    historyLength: 3 * period, gates: { periodic: 'verified' },
  })),
  { id: 'transformer-cycle', label: '精确重复 5 位', kind: 'period', period: 5, historyLength: 1024, gates: { transformer: 'exactProbability' } },
  { id: 'lag5', label: '滞后 5，60% 复制', kind: 'copy', period: 5, historyLength: 1024, gates: { transformer: 'stochastic' } },
  { id: 'transformer-lag8', label: '训练未见滞后 8，60% 复制', kind: 'copy', period: 8, historyLength: 1024, gates: { transformer: 'stochastic' } },
];

function primitiveTemplate(period, seed) {
  const draws = syntheticSequence('uniform', period * 4, seed);
  for (let offset = 0; offset < draws.length; offset += period) {
    const template = draws.slice(offset, offset + period);
    let repeats = false;
    for (let divisor = 1; divisor < period; divisor += 1) {
      if (period % divisor === 0 && template.every((digit, index) => digit === template[index % divisor])) {
        repeats = true;
        break;
      }
    }
    if (!repeats) return template;
  }
  throw new Error('Could not generate a primitive synthetic template.');
}

function digitDistribution(bestDigit, maximum) {
  const probabilities = Array(10).fill((1 - maximum) / 9);
  probabilities[bestDigit] = maximum;
  return probabilities;
}

function makeTrial(scenario, seed, streamIndex) {
  const { kind, period, historyLength } = scenario;
  const length = historyLength + HORIZON;
  let favored = 0;
  let digits;
  if (kind === 'uniform') {
    digits = syntheticSequence('uniform', length, seed);
  } else if (kind === 'biased') {
    const shift = (streamIndex * 7 + 3) % 10;
    favored = (7 + shift) % 10;
    digits = syntheticSequence('biased', length, seed).map((digit) => (digit + shift) % 10);
  } else if (kind === 'copy') {
    const draws = syntheticSequence('uniform', length * 2, seed);
    digits = [];
    for (let index = 0; index < length; index += 1) {
      const copy = index >= period && draws[index * 2] < COPY_RATE * 10;
      digits.push(copy ? digits[index - period] : draws[index * 2 + 1]);
    }
  } else {
    const template = kind === 'permutation'
      ? [...new Set([...syntheticSequence('uniform', 128, seed), 0, 1, 2, 3, 4, 5, 6, 7, 8, 9])]
      : primitiveTemplate(period, seed);
    digits = Array.from({ length }, (_, index) => template[index % period]);
  }

  const history = digits.slice(0, historyLength);
  const truth = digits.slice(historyLength);
  const oracle = [];
  const expectedAccuracy = [];
  for (let step = 0; step < HORIZON; step += 1) {
    let maximum = 0.1;
    let preferred = favored;
    if (kind === 'biased') {
      maximum = 0.46;
    } else if (kind === 'copy') {
      maximum = 0.1 + 0.9 * COPY_RATE ** Math.ceil((step + 1) / period);
      preferred = history[historyLength + (step % period) - period];
    } else if (period !== undefined) {
      maximum = 1;
      preferred = history[historyLength + (step % period) - period];
    }
    oracle.push(digitDistribution(preferred, maximum));
    expectedAccuracy.push(maximum);
  }

  // Conditioning on all previous guesses being right restores the copy source for each step.
  const expectedBlockAccuracy = (kind === 'copy' ? COPY_ACCURACY : expectedAccuracy[0]) ** HORIZON;
  return { history, truth, oracle, expectedAccuracy, expectedBlockAccuracy };
}

function emptyScores() {
  return { observations: 0, hits: Array(HORIZON).fill(0), blockHits: 0, loss: 0 };
}

function addScores(scores, forecast, truth) {
  let blockHits = 0;
  for (const [step, actual] of truth.entries()) {
    const probabilities = forecast[step];
    const guess = probabilities.indexOf(Math.max(...probabilities));
    const hit = Number(guess === actual);
    blockHits += hit;
    scores.hits[step] += hit;
    scores.loss -= Math.log(probabilities[actual]);
  }
  scores.observations += 1;
  scores.blockHits += Number(blockHits === HORIZON);
}

function validForecast(forecast) {
  return Array.isArray(forecast) && forecast.length === HORIZON && forecast.every((row) =>
    Array.isArray(row) && row.length === 10 && row.every((value) => Number.isFinite(value) && value > 0 && value < 1) &&
    Math.abs(row.reduce((sum, value) => sum + value, 0) - 1) < 1e-6);
}

function addCheck(method, caseId, metric, label, samples, actual, operator, bound) {
  const valid = Number.isFinite(actual);
  const pass = valid && (operator === '===' ? actual === bound : actual <= bound);
  method.checks.push({ id: `${caseId}:${metric}`, caseId, label, samples, metric, actual: valid ? actual : null, operator, bound, pass });
}

function addScenarioChecks(method, scenario, report, uniformForecastRate, correctPeriodRate) {
  const gate = scenario.gates[method.id];
  const check = (metric, label, actual, operator, bound) =>
    addCheck(method, scenario.id, metric, label, STREAMS, actual, operator, bound);

  if (gate === 'uniform') check('uniformForecastRate', '全部概率恰为 0.1 的比例', uniformForecastRate, '===', 1);
  if (gate === 'stochastic' || gate === 'uniform') {
    const bound = gate === 'uniform' ? 1e-12 : ACCURACY_GAP;
    check('nextAccuracyGap', '下一位准确率距同样本理论预测的差值',
      report.nextAccuracy === null ? null : report.oracleNextAccuracy - report.nextAccuracy, '<=', bound);
    check('fifthAccuracyGap', '第 5 位准确率距同样本理论预测的差值',
      report.fifthAccuracy === null ? null : report.oracleFifthAccuracy - report.fifthAccuracy, '<=', bound);
  }
  if (gate === 'stochastic' || gate === 'uniform' || gate === 'exactProbability') {
    const bound = gate === 'uniform' ? 1e-12 : LOSS_EXCESS[method.id];
    check('meanLogLossExcess', '平均对数损失超过同样本理论预测的数值',
      report.meanLogLoss === null ? null : report.meanLogLoss - report.oracleMeanLogLoss, '<=', bound);
  }
  if (gate === 'exact' || gate === 'verified' || gate === 'exactProbability') {
    check('blockAccuracy', '未来五位全部正确率', report.blockAccuracy, '===', 1);
  }
  if (gate === 'verified' || gate === 'reject') {
    check('detectorAcceptanceRate', '周期验证通过率', report.detectorAcceptanceRate, '===', Number(gate === 'verified'));
  }
  if (gate === 'verified') check('correctPeriodRate', '识别出真实周期的比例', correctPeriodRate, '===', 1);
}

function verifyFixedPredictions(methods) {
  const histories = [
    makeTrial(CASES.find(({ id }) => id === 'period8'), BASE_SEED + 190_000_000, 0).history,
    makeTrial(CASES.find(({ id }) => id === 'lag5'), BASE_SEED + 190_000_001, 0).history,
  ];
  const counts = new Map(METHODS.map(({ id }) => [id, 0]));
  for (const history of histories) {
    const forecasts = predict(history, HORIZON);
    const suffixes = [[0, 1, 2, 3, 4], [9, 8, 7, 6, 5]];
    const details = suffixes.map((suffix) => backtest([...history, ...suffix], history.length, HORIZON, { includeDetails: true }).details[0]);
    for (const method of methods.values()) {
      const locked = details.every((detail, index) => detail && isDeepStrictEqual(detail.truth, suffixes[index]) &&
        isDeepStrictEqual(detail.forecasts[method.id], forecasts[method.id]));
      if (locked) counts.set(method.id, counts.get(method.id) + 1);
    }
  }
  for (const method of methods.values()) {
    addCheck(method, 'locked', 'fixedForecastCount', '替换整段真值后预测仍固定的测试数',
      histories.length, counts.get(method.id), '===', histories.length);
  }
}

function runAcceptance() {
  const methods = new Map(METHODS.map(({ id, label }) => [id, { id, label, checks: [], scores: [] }]));
  const shapeCounts = new Map(METHODS.map(({ id }) => [id, 0]));
  for (const [caseIndex, scenario] of CASES.entries()) {
    const scoresByMethod = Object.fromEntries(Object.keys(scenario.gates).map((id) => [id, emptyScores()]));
    const oracleScores = emptyScores();
    let expectedAccuracy;
    let expectedBlockAccuracy;
    let uniformCount = 0;
    let accepts = 0;
    let correctPeriod = 0;

    for (let stream = 0; stream < STREAMS; stream += 1) {
      const trial = makeTrial(scenario, BASE_SEED + caseIndex * 10_000_000 + stream * 7919, stream);
      const { history, truth, oracle } = trial;
      expectedAccuracy = trial.expectedAccuracy;
      expectedBlockAccuracy = trial.expectedBlockAccuracy;
      const forecasts = predict(history, HORIZON);
      addScores(oracleScores, oracle, truth);
      for (const { id } of METHODS) {
        if (!validForecast(forecasts[id])) continue;
        shapeCounts.set(id, shapeCounts.get(id) + 1);
        if (scoresByMethod[id]) addScores(scoresByMethod[id], forecasts[id], truth);
      }
      if (scenario.gates.uniform && validForecast(forecasts.uniform) &&
        forecasts.uniform.every((row) => row.every((probability) => probability === 0.1))) uniformCount += 1;
      if (scenario.gates.periodic) {
        const period = verifiedPeriod(history);
        if (period !== null) accepts += 1;
        if (period === scenario.period) correctPeriod += 1;
      }
    }

    for (const [id, scores] of Object.entries(scoresByMethod)) {
      const method = methods.get(id);
      const complete = scores.observations === STREAMS;
      const report = {
        caseId: scenario.id,
        caseLabel: scenario.label,
        historyLength: scenario.historyLength,
        streams: STREAMS,
        nextAccuracy: complete ? scores.hits[0] / STREAMS : null,
        fifthAccuracy: complete ? scores.hits[HORIZON - 1] / STREAMS : null,
        blockAccuracy: complete ? scores.blockHits / STREAMS : null,
        meanLogLoss: complete ? scores.loss / (STREAMS * HORIZON) : null,
        oracleNextAccuracy: oracleScores.hits[0] / STREAMS,
        oracleFifthAccuracy: oracleScores.hits[HORIZON - 1] / STREAMS,
        oracleBlockAccuracy: oracleScores.blockHits / STREAMS,
        oracleMeanLogLoss: oracleScores.loss / (STREAMS * HORIZON),
        expectedOracleNextAccuracy: expectedAccuracy[0],
        expectedOracleFifthAccuracy: expectedAccuracy[HORIZON - 1],
        expectedOracleBlockAccuracy: expectedBlockAccuracy,
        detectorAcceptanceRate: id === 'periodic' ? accepts / STREAMS : null,
      };
      method.scores.push(report);
      addScenarioChecks(method, scenario, report, uniformCount / STREAMS, correctPeriod / STREAMS);
    }
  }

  const totalForecasts = CASES.length * STREAMS;
  for (const method of methods.values()) {
    addCheck(method, 'all', 'validForecastCount', '十类概率有效且归一化的预测数',
      totalForecasts, shapeCounts.get(method.id), '===', totalForecasts);
  }
  verifyFixedPredictions(methods);
  const results = Array.from(methods.values(), (method) => ({ ...method, pass: method.checks.every(({ pass }) => pass) }));
  return { protocol: PROTOCOL, pass: results.every(({ pass }) => pass), methods: results };
}

let report;
try {
  report = runAcceptance();
} catch (error) {
  report = { protocol: PROTOCOL, pass: false, methods: [], error: error.message };
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else if (report.error) {
  console.error(report.error);
} else {
  console.log(`每个测试条件使用 ${STREAMS} 条固定种子的合成序列，所有预测均在揭晓五位真值之前完成。`);
  console.table(report.methods.map(({ id, label, pass, checks }) => ({
    id, 方法: label, 通过: pass, 通过项: `${checks.filter((check) => check.pass).length}/${checks.length}`,
  })));
  const failed = report.methods.flatMap(({ id, checks }) => checks.filter(({ pass }) => !pass).map((check) => ({ method: id, ...check })));
  if (failed.length) console.table(failed);
}
if (!report.pass) process.exitCode = 1;
