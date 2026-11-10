import { METHODS, predict, syntheticSequence } from '../forecast.mjs';

const STREAM_COUNT = 400;
const HISTORY_LENGTHS = [32, 128, 512];
const STEPS = [1, 5];
const DATASETS = [
  { id: 'uniform', name: '独立均匀', oracle: () => 0.1 },
  { id: 'biased', name: '独立有偏', oracle: () => 0.46 },
  { id: 'short', name: '依赖上一位', oracle: (step) => 0.1 + 0.9 * (0.6 ** step) },
  { id: 'long', name: '依赖五位之前', oracle: () => 0.64 },
];

function blankScores() {
  return { hits: 0, logLoss: 0, delta: 0, deltaSquared: 0 };
}

function bestDigit(probabilities) {
  return probabilities.indexOf(Math.max(...probabilities));
}

function runBenchmark() {
  const rows = [];
  const horizon = Math.max(...STEPS);
  const streamLength = Math.max(...HISTORY_LENGTHS) + horizon;

  for (const [datasetIndex, dataset] of DATASETS.entries()) {
    const streams = Array.from({ length: STREAM_COUNT }, (_, index) =>
      syntheticSequence(dataset.id, streamLength, 20261112 + datasetIndex * 1000000 + index * 7919));

    for (const historyLength of HISTORY_LENGTHS) {
      const scores = Object.fromEntries(METHODS.map(({ id }) => [id, STEPS.map(blankScores)]));

      for (const stream of streams) {
        const forecast = predict(stream.slice(0, historyLength), horizon);
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
        for (const { id, label } of METHODS) {
          const score = scores[id][stepIndex];
          const advantage = score.delta / STREAM_COUNT;
          const variance = Math.max(0, (score.deltaSquared - score.delta * advantage) / (STREAM_COUNT - 1));
          const margin = 1.96 * Math.sqrt(variance / STREAM_COUNT);
          rows.push({
            dataset: dataset.name,
            historyLength,
            step,
            method: id,
            label,
            streams: STREAM_COUNT,
            accuracy: score.hits / STREAM_COUNT,
            logLoss: score.logLoss / STREAM_COUNT,
            oracleAccuracy: dataset.oracle(step),
            advantage,
            advantageInterval: [advantage - margin, advantage + margin],
          });
        }
      }
    }
  }

  return rows;
}

const rows = runBenchmark();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const points = (value) => (value * 100).toFixed(1);
  console.log(`每类 ${STREAM_COUNT} 条独立合成序列。每条序列在给定历史长度下只锁定一次预测。`);
  console.log('步数指该未来位置。区间是相对历史频率的成对差值近似 95% 区间，单位为百分点。');
  console.log('理论命中率按已知合成规则计算。');
  console.table(rows.map((row) => ({
    数据: row.dataset,
    历史: row.historyLength,
    步数: row.step,
    方法: row.label,
    命中率: percent(row.accuracy),
    理论: percent(row.oracleAccuracy),
    对数损失: row.logLoss.toFixed(3),
    频率差及区间: `${points(row.advantage)} [${row.advantageInterval.map(points).join(', ')}]`,
  })));
}
