import { METHODS, predict, syntheticSequence } from '../forecast.mjs';

const DEFAULT_STREAM_COUNT = 400;
const HISTORY_LENGTHS = [32, 128, 512];
const STEPS = [1, 5];
const DATASETS = [
  { id: 'uniform', name: '独立均匀', oracle: () => 0.1 },
  { id: 'biased', name: '独立有偏', oracle: () => 0.46 },
  { id: 'short', name: '依赖上一位', oracle: (step) => 0.1 + 0.9 * (0.6 ** step) },
  { id: 'long', name: '依赖五位之前', oracle: () => 0.64 },
];
const HOLDOUT = { id: 'lag8', name: '依赖八位之前（留出）', oracle: () => 0.64 };

function generateHoldout(length, seed) {
  const source = syntheticSequence('uniform', length * 2, seed);
  const digits = [];
  for (let index = 0; index < length; index += 1) {
    const copy = index >= 8 && source[index * 2] < 6;
    digits.push(copy ? digits[index - 8] : source[index * 2 + 1]);
  }
  return digits;
}

function theoreticalLogLoss(maximumProbability) {
  const otherProbability = (1 - maximumProbability) / 9;
  return -maximumProbability * Math.log(maximumProbability)
    - 9 * otherProbability * Math.log(otherProbability);
}

function blankScores() {
  return { hits: 0, logLoss: 0, delta: 0, deltaSquared: 0 };
}

function bestDigit(probabilities) {
  return probabilities.indexOf(Math.max(...probabilities));
}

function runBenchmark(streamCount, includeHoldout, measureTiming) {
  const rows = [];
  const horizon = Math.max(...STEPS);
  const streamLength = Math.max(...HISTORY_LENGTHS) + horizon;
  const datasets = includeHoldout ? [...DATASETS, HOLDOUT] : DATASETS;

  for (const [datasetIndex, dataset] of datasets.entries()) {
    const isHoldout = dataset.id === HOLDOUT.id;
    const streams = Array.from({ length: streamCount }, (_, index) => {
      const seed = 20261112 + datasetIndex * 1000000 + index * 7919;
      return isHoldout
        ? generateHoldout(streamLength, seed)
        : syntheticSequence(dataset.id, streamLength, seed);
    });

    for (const historyLength of HISTORY_LENGTHS) {
      const scores = Object.fromEntries(METHODS.map(({ id }) => [id, STEPS.map(blankScores)]));
      let forecastTime = 0;

      for (const stream of streams) {
        const start = measureTiming ? performance.now() : 0;
        const forecast = predict(stream.slice(0, historyLength), horizon);
        if (measureTiming) forecastTime += performance.now() - start;
        for (const [stepIndex, step] of STEPS.entries()) {
          const actual = stream[historyLength + step - 1];
          const frequencyHit = Number(bestDigit(forecast.frequency[step - 1]) === actual);
          for (const { id } of METHODS) {
            const probabilities = forecast[id][step - 1];
            const hit = Number(bestDigit(probabilities) === actual);
            const delta = hit - frequencyHit;
            const score = scores[id][stepIndex];
            score.hits += hit;
            score.logLoss -= Math.log(probabilities[actual]);
            score.delta += delta;
            score.deltaSquared += delta ** 2;
          }
        }
      }

      for (const [stepIndex, step] of STEPS.entries()) {
        const oracleAccuracy = dataset.oracle(step);
        for (const { id, label } of METHODS) {
          const score = scores[id][stepIndex];
          const advantage = score.delta / streamCount;
          const variance = Math.max(0, (score.deltaSquared - score.delta * advantage) / (streamCount - 1));
          const margin = 1.96 * Math.sqrt(variance / streamCount);
          rows.push({
            datasetId: dataset.id,
            dataset: dataset.name,
            distribution: isHoldout ? 'holdout' : 'baseline',
            historyLength,
            step,
            method: id,
            label,
            streams: streamCount,
            accuracy: score.hits / streamCount,
            logLoss: score.logLoss / streamCount,
            oracleAccuracy,
            oracleLogLoss: theoreticalLogLoss(oracleAccuracy),
            advantage,
            advantageInterval: [advantage - margin, advantage + margin],
            ...(measureTiming ? { latencyMsPerForecast: forecastTime / streamCount } : {}),
          });
        }
      }
    }
  }

  return rows;
}

const args = process.argv.slice(2);
const streamOption = args.find((argument) => argument.startsWith('--streams='));
const streamCount = streamOption ? Number(streamOption.slice('--streams='.length)) : DEFAULT_STREAM_COUNT;
if (!Number.isInteger(streamCount) || streamCount < 2 || streamCount > DEFAULT_STREAM_COUNT) {
  throw new RangeError(`--streams 必须是 2–${DEFAULT_STREAM_COUNT} 之间的整数。`);
}

const rows = runBenchmark(streamCount, args.includes('--holdout'), args.includes('--timing'));
if (args.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const points = (value) => (value * 100).toFixed(1);
  console.log(`每类 ${streamCount} 条独立初始化的合成序列。每条序列在给定历史长度下只锁定一次预测。`);
  console.log('步数指该未来位置。对每条序列和频率基线成对，按差值均值 ± 1.96 倍标准误计算逐条件近似 95% 区间，单位为百分点。');
  console.log('理论命中率和理论对数损失按已知合成规则计算。');
  console.table(rows.map((row) => ({
    数据: row.dataset,
    历史: row.historyLength,
    步数: row.step,
    方法: row.label,
    命中率: percent(row.accuracy),
    理论: percent(row.oracleAccuracy),
    对数损失: row.logLoss.toFixed(3),
    理论对数损失: row.oracleLogLoss.toFixed(3),
    频率差及区间: `${points(row.advantage)} [${row.advantageInterval.map(points).join(', ')}]`,
    ...(row.latencyMsPerForecast === undefined ? {} : { 全部方法毫秒: row.latencyMsPerForecast.toFixed(2) }),
  })));
}
