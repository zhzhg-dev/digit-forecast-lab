import assert from 'node:assert/strict';
import test from 'node:test';
import { backtest, METHODS, parseSequence, predict, syntheticSequence } from '../forecast.mjs';

function bestDigit(probabilities) {
  return probabilities.indexOf(Math.max(...probabilities));
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

test('parses digit strings, separators and full-width digits while preserving leading zeros', () => {
  assert.deepEqual(parseSequence('00190'), [0, 0, 1, 9, 0]);
  assert.deepEqual(parseSequence(' ０、０，１,9\n0\t'), [0, 0, 1, 9, 0]);
  assert.deepEqual(parseSequence(' \t, '), []);
  for (const invalid of ['0.5', '-1', '[1,2]', '1;2', '4x5']) {
    assert.throws(() => parseSequence(invalid));
  }
});

test('each forecast is a normalized distribution for each requested position', () => {
  const history = syntheticSequence('long', 160, 29);
  for (const horizon of [1, 5]) {
    const result = predict(history, horizon);
    assert.deepEqual(Object.keys(result).sort(), METHODS.map(({ id }) => id).sort());
    for (const probabilities of Object.values(result)) {
      assert.equal(probabilities.length, horizon);
      for (const row of probabilities) {
        assert.equal(row.length, 10);
        assert.ok(row.every((value) => Number.isFinite(value) && value > 0 && value < 1));
        close(row.reduce((total, value) => total + value, 0), 1);
      }
    }
    assert.ok(result.uniform.every((row) => row.every((probability) => probability === 0.1)));
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
    const report = backtest([...history, ...suffix], history.length, 5);
    assert.equal(report.origins, 1);
    assert.equal(report.historyLength, history.length);
    assert.equal(report.horizon, 5);
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
  assert.equal(report.origins, 3);
  assert.ok(report.results.every(({ steps }) => steps.every(({ accuracy, logLoss }) =>
    accuracy >= 0 && accuracy <= 1 && Number.isFinite(logLoss))));
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
