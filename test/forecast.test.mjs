import assert from 'node:assert/strict';
import test from 'node:test';
import { backtest, METHODS, parseSequence, predict, syntheticSequence } from '../forecast.mjs';

function bestDigit(probabilities) {
  return probabilities.indexOf(Math.max(...probabilities));
}

function close(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

function verifyDistributions(forecasts, horizon) {
  assert.deepEqual(Object.keys(forecasts).sort(), METHODS.map(({ id }) => id).sort());
  for (const probabilities of Object.values(forecasts)) {
    assert.equal(probabilities.length, horizon);
    for (const row of probabilities) {
      assert.equal(row.length, 10);
      assert.ok(row.every((value) => Number.isFinite(value) && value > 0 && value < 1));
      close(row.reduce((total, value) => total + value, 0), 1, 1e-6);
    }
  }
  assert.ok(forecasts.uniform.every((row) => row.every((probability) => probability === 0.1)));
}

test('parses digit strings, separators and full-width digits while preserving leading zeros', () => {
  assert.deepEqual(parseSequence('00190'), [0, 0, 1, 9, 0]);
  assert.deepEqual(parseSequence(' ０、０，１,9\n0\t'), [0, 0, 1, 9, 0]);
  assert.deepEqual(parseSequence(' \t, '), []);
  for (const invalid of ['0.5', '-1', '[1,2]', '1;2', '4x5']) {
    assert.throws(() => parseSequence(invalid));
  }
});

test('all six methods return normalized distributions at horizons from 1 through 20', () => {
  const history = syntheticSequence('long', 160, 29);
  assert.deepEqual(METHODS.map(({ id }) => id).sort(), ['frequency', 'lag', 'markov', 'periodic', 'transformer', 'uniform']);
  for (let horizon = 1; horizon <= 20; horizon += 1) {
    verifyDistributions(predict(history, horizon), horizon);
  }
});

test('short histories and the 32-digit context boundary remain valid', () => {
  const sequence = syntheticSequence('short', 33, 829);
  for (const length of [0, 1, 7, 31, 32, 33]) {
    const history = sequence.slice(0, length);
    verifyDistributions(predict(history), 1);
    verifyDistributions(predict(history, 20), 20);
  }
});

test('the frequency model learns a skewed history', () => {
  const history = [1, 7, 7, 2, 7, 7, 9];
  assert.equal(bestDigit(predict(history, 1).frequency[0]), 7);
});

test('the longer-history model learns a toy cycle that a one-step transition misses', () => {
  const cycle = [0, 1, 0, 2, 0];
  const history = Array.from({ length: 80 }, () => cycle).flat();
  const scores = backtest([...history, ...cycle], history.length, cycle.length);
  const lag = scores.results.find(({ id }) => id === 'lag');
  const markov = scores.results.find(({ id }) => id === 'markov');

  assert.equal(lag.fullMatchRate, 1);
  assert.ok(lag.steps.every(({ logLoss }, index) => logLoss < markov.steps[index].logLoss));
});

test('all five positions are scored against the same prefix for different future suffixes', () => {
  const history = syntheticSequence('short', 128, 47);
  const forecasts = predict(history, 5);
  const suffixes = [[0, 1, 2, 3, 4], [9, 8, 7, 6, 5]];

  for (const suffix of suffixes) {
    const report = backtest([...history, ...suffix], history.length, 5, { includeDetails: true });
    assert.equal(report.origins, 1);
    assert.equal(report.historyLength, history.length);
    assert.equal(report.horizon, 5);
    assert.deepEqual(report.details, [{ start: 0, origin: history.length, truth: suffix, forecasts }]);
    for (const { id, steps, fullMatchRate } of report.results) {
      assert.equal(steps.length, 5);
      const matches = [];
      steps.forEach(({ accuracy, logLoss }, index) => {
        const probabilities = forecasts[id][index];
        const actual = suffix[index];
        const match = Number(bestDigit(probabilities) === actual);
        matches.push(match);
        assert.equal(accuracy, match);
        close(logLoss, -Math.log(probabilities[actual]));
      });
      assert.equal(fullMatchRate, Number(matches.every(Boolean)));
    }
  }
});

test('backtest reports the configured cap on the number of forecast origins', () => {
  const sequence = syntheticSequence('uniform', 100, 11);
  const report = backtest(sequence, 32, 5, { maxOrigins: 3 });
  assert.deepEqual(Object.keys(report).sort(), ['historyLength', 'horizon', 'origins', 'results']);
  assert.equal(report.origins, 3);
  assert.ok(report.results.every(({ steps }) => steps.every(({ accuracy, logLoss }) =>
    accuracy >= 0 && accuracy <= 1 && Number.isFinite(logLoss))));
});

test('detailed windows preserve origins and reconstruct all aggregate scores', () => {
  const sequence = syntheticSequence('long', 100, 41);
  const report = backtest(sequence, 32, 5, { maxOrigins: 3, includeDetails: true });
  assert.deepEqual(report.details.map(({ start, origin }) => [start, origin]), [[53, 85], [58, 90], [63, 95]]);
  for (const { start, origin, truth, forecasts } of report.details) {
    assert.deepEqual(truth, sequence.slice(origin, origin + 5));
    assert.deepEqual(forecasts, predict(sequence.slice(start, origin), 5));
  }

  for (const { id, steps, fullMatchRate } of report.results) {
    const predictions = report.details.map(({ truth, forecasts }) => truth.map((actual, step) => ({
      hit: Number(bestDigit(forecasts[id][step]) === actual),
      logLoss: -Math.log(forecasts[id][step][actual]),
    })));
    for (const [step, score] of steps.entries()) {
      close(score.accuracy, predictions.reduce((sum, window) => sum + window[step].hit, 0) / report.origins);
      close(score.logLoss, predictions.reduce((sum, window) => sum + window[step].logLoss, 0) / report.origins);
    }
    const fullMatches = predictions.filter((window) => window.every(({ hit }) => hit === 1)).length;
    close(fullMatchRate, fullMatches / report.origins);
  }
});

test('backtest exposes no scores or detail windows when the input is too short', () => {
  const report = backtest([1, 2, 3], 3, 5, { includeDetails: true });
  assert.equal(report.origins, 0);
  assert.deepEqual(report.details, []);
  for (const { fullMatchRate, steps } of report.results) {
    assert.equal(fullMatchRate, null);
    assert.deepEqual(steps, Array.from({ length: 5 }, () => ({ accuracy: null, logLoss: null })));
  }
});

test('toy examples have a reproducible length and use decimal symbols', () => {
  for (const kind of ['uniform', 'biased', 'short', 'long']) {
    const sequence = syntheticSequence(kind, 100, 12345);
    assert.equal(sequence.length, 100);
    assert.ok(sequence.every((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9));
    assert.deepEqual(sequence, syntheticSequence(kind, 100, 12345));
    assert.notDeepEqual(sequence, syntheticSequence(kind, 100, 12346));
  }
});

test('separately seeded example streams preserve distinct histories', () => {
  const histories = Array.from({ length: 20 }, (_, index) =>
    syntheticSequence('uniform', 64, 20261112 + index * 7919).join(''));
  assert.equal(new Set(histories).size, histories.length);
});
