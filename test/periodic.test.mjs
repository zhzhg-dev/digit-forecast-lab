import assert from 'node:assert/strict';
import test from 'node:test';
import { backtest, predict, verifiedPeriod } from '../forecast.mjs';

function repeat(template, length) {
  return Array.from({ length }, (_, index) => template[index % template.length]);
}

function topDigit(probabilities) {
  return probabilities.indexOf(Math.max(...probabilities));
}

test('the period detector requires two fit cycles and a validation cycle', () => {
  for (const period of [1, 8, 64, 257]) {
    const template = [1, ...Array(period - 1).fill(0)];
    assert.equal(verifiedPeriod(repeat(template, 3 * period - 1)), null);
    assert.equal(verifiedPeriod(repeat(template, 3 * period)), period);
    assert.equal(verifiedPeriod(repeat(template, 3 * period + 1)), period);
  }
});

test('a fit-period mismatch on chronological validation returns the frequency fallback', () => {
  const sequence = [1, 2, 3, 1, 2, 3, 1, 2, 4];
  assert.equal(verifiedPeriod(sequence), null);
  const predictions = predict(sequence, 5);
  assert.deepEqual(predictions.periodic, predictions.frequency);
});

test('the smallest verified period predicts the correct phase across future cycles', () => {
  const history = repeat([0, 1, 2, 3], 13);
  assert.equal(verifiedPeriod(history), 4);
  const predictions = predict(history, 5).periodic;
  assert.deepEqual(predictions.map(topDigit), [1, 2, 3, 0, 1]);
  for (const distribution of predictions) {
    assert.equal(Math.max(...distribution), 0.99);
    assert.ok(distribution.every((probability) => probability > 0));
    assert.ok(Math.abs(distribution.reduce((total, value) => total + value, 0) - 1) < 1e-12);
  }
});

test('periodic predictions remain locked even when the held-out future breaks the cycle', () => {
  const history = repeat([0, 1, 2, 3], 13);
  const continuation = [1, 2, 3, 0, 1];
  const correct = backtest([...history, ...continuation], history.length, 5, { includeDetails: true });
  const broken = backtest([...history, 9, 9, 9, 9, 9], history.length, 5, { includeDetails: true });
  assert.deepEqual(correct.details[0].forecasts.periodic, broken.details[0].forecasts.periodic);
  assert.equal(correct.results.find(({ id }) => id === 'periodic').fullMatchRate, 1);
  const brokenResult = broken.results.find(({ id }) => id === 'periodic');
  assert.equal(brokenResult.fullMatchRate, 0);
  assert.ok(brokenResult.steps.every(({ accuracy, logLoss }) => accuracy === 0 && Number.isFinite(logLoss)));
});
