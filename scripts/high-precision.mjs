import { METHODS, predict, syntheticSequence, verifiedPeriod } from '../forecast.mjs';

const STREAMS = 400;
const HORIZON = 5;
const MAX_HISTORY = 16_384;
const THRESHOLD = 0.99;
const BASE_HISTORIES = [32, 128, 512, 2048, 8192, MAX_HISTORY];
const CONTROL_HISTORIES = [32, 512, 2048, MAX_HISTORY];
const BASE_SEED = 83_042_989;
const DATASETS = [
  ...[8, 64, 257].map((period) => ({
    id: `period${period}`,
    label: `精确重复模板，长度 ${period}`,
    period,
    histories: Array.from(new Set([
      ...BASE_HISTORIES, period, 2 * period, 3 * period - 1, 3 * period, 3 * period + 1,
    ])).sort((left, right) => left - right),
  })),
  { id: 'uniform', label: '独立均匀对照', period: null, source: 'uniform', oracle: 0.1, histories: CONTROL_HISTORIES },
  { id: 'noisy', label: '五位滞后，60% 复制对照', period: null, source: 'long', oracle: 0.64, histories: CONTROL_HISTORIES },
];

function generateSequence(dataset, seed) {
  const length = MAX_HISTORY + HORIZON;
  if (dataset.period === null) return syntheticSequence(dataset.source, length, seed);

  const template = syntheticSequence('uniform', dataset.period, seed);
  return Array.from({ length }, (_, index) => template[index % dataset.period]);
}

function entropy(maximumProbability) {
  const otherProbability = (1 - maximumProbability) / 9;
  return maximumProbability === 1 ? 0 : -maximumProbability * Math.log(maximumProbability)
    - 9 * otherProbability * Math.log(otherProbability);
}

function oracleFor(dataset, historyLength) {
  const probabilities = Array.from({ length: HORIZON }, (_, step) => {
    if (dataset.period === null) return dataset.oracle;
    const offset = (historyLength + step) % dataset.period;
    return offset < historyLength ? 1 : 0.1;
  });
  return {
    oracleNextAccuracy: probabilities[0],
    oracleFifthAccuracy: probabilities[HORIZON - 1],
    oracleBlockAccuracy: probabilities.reduce((product, value) => product * value, 1),
    oracleMeanLogLoss: probabilities.reduce((sum, value) => sum + entropy(value), 0) / HORIZON,
  };
}

function wilsonInterval(hits) {
  const rate = hits / STREAMS;
  const z = 1.96;
  const denominator = 1 + z ** 2 / STREAMS;
  const center = (rate + z ** 2 / (2 * STREAMS)) / denominator;
  const margin = z * Math.sqrt((rate * (1 - rate) + z ** 2 / (4 * STREAMS)) / STREAMS) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function blankCondition(historyLength) {
  return {
    historyLength,
    detectorAccepts: 0,
    detectorCorrectPeriod: 0,
    detectorAcceptedBlockHits: 0,
    methods: Object.fromEntries(METHODS.map(({ id }) => [id, {
      hits: Array(HORIZON).fill(0),
      losses: Array(HORIZON).fill(0),
      blockHits: 0,
    }])),
  };
}

function scoreCondition(condition, dataset, sequence) {
  const { historyLength } = condition;
  const history = sequence.slice(0, historyLength);
  const truth = sequence.slice(historyLength, historyLength + HORIZON);
  const forecasts = predict(history, HORIZON);
  const candidate = verifiedPeriod(history);
  if (candidate !== null) {
    condition.detectorAccepts += 1;
    condition.detectorCorrectPeriod += Number(candidate === dataset.period);
  }

  for (const { id } of METHODS) {
    const score = condition.methods[id];
    let hits = 0;
    for (const [step, actual] of truth.entries()) {
      const probabilities = forecasts[id][step];
      const guess = probabilities.indexOf(Math.max(...probabilities));
      const hit = Number(guess === actual);
      hits += hit;
      score.hits[step] += hit;
      score.losses[step] -= Math.log(probabilities[actual]);
    }
    const blockHit = Number(hits === HORIZON);
    score.blockHits += blockHit;
    if (id === 'periodic' && candidate !== null) condition.detectorAcceptedBlockHits += blockHit;
  }
}

function formatCondition(condition, dataset) {
  return METHODS.map(({ id, label }) => {
    const { historyLength, detectorAccepts, detectorCorrectPeriod, detectorAcceptedBlockHits } = condition;
    const { hits, losses, blockHits } = condition.methods[id];
    return {
      datasetId: dataset.id,
      dataset: dataset.label,
      period: dataset.period,
      historyLength,
      method: id,
      label,
      streams: STREAMS,
      nextAccuracy: hits[0] / STREAMS,
      fifthAccuracy: hits[HORIZON - 1] / STREAMS,
      blockAccuracy: blockHits / STREAMS,
      nextLogLoss: losses[0] / STREAMS,
      fifthLogLoss: losses[HORIZON - 1] / STREAMS,
      meanLogLoss: losses.reduce((sum, value) => sum + value, 0) / (STREAMS * HORIZON),
      nextInterval: wilsonInterval(hits[0]),
      fifthInterval: wilsonInterval(hits[HORIZON - 1]),
      blockInterval: wilsonInterval(blockHits),
      ...oracleFor(dataset, historyLength),
      detectorAcceptanceRate: detectorAccepts / STREAMS,
      detectorCorrectPeriodRate: dataset.period === null ? null : detectorCorrectPeriod / STREAMS,
      detectorAcceptedBlockAccuracy: detectorAccepts === 0 ? null : detectorAcceptedBlockHits / detectorAccepts,
    };
  });
}

function runExperiment() {
  const rows = [];
  for (const [datasetIndex, dataset] of DATASETS.entries()) {
    const conditions = dataset.histories.map(blankCondition);
    for (let stream = 0; stream < STREAMS; stream += 1) {
      const sequence = generateSequence(dataset, BASE_SEED + datasetIndex * 10_000_000 + stream * 7919);
      for (const condition of conditions) scoreCondition(condition, dataset, sequence);
    }
    rows.push(...conditions.flatMap((condition) => formatCondition(condition, dataset)));
  }

  const thresholds = DATASETS.flatMap((dataset) => METHODS.map(({ id }) => {
    const tested = rows.filter((row) => row.datasetId === dataset.id && row.method === id);
    const firstPassing = (field) => tested.find((row) => row[field] >= THRESHOLD)?.historyLength ?? null;
    return {
      datasetId: dataset.id,
      method: id,
      nextMinHistory: firstPassing('nextAccuracy'),
      fifthMinHistory: firstPassing('fifthAccuracy'),
      blockMinHistory: firstPassing('blockAccuracy'),
    };
  }));

  return { protocol: { streamsPerCondition: STREAMS, horizon: HORIZON, accuracyThreshold: THRESHOLD, maxHistory: MAX_HISTORY }, rows, thresholds };
}

const report = runExperiment();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`每类 ${STREAMS} 条独立初始化的合成序列。每条序列在给定历史长度下锁定一次未来 ${HORIZON} 位的预测。`);
  console.log('各指标达到 99% 的最小已测历史长度。相同类别的不同历史长度共享同一批合成序列。');
  console.log('空值表示在本次测试网格上未达到阈值。各准确率的 95% Wilson 区间及对数损失可用 --json 查看。');
  console.table(report.thresholds);
}
