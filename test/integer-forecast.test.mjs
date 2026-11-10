import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticSequence } from '../forecast.mjs';
import { forecastIntegers, parseIntegerSequence, scoreIntegerForecast } from '../integer-forecast.mjs';

function repeat(template, length) {
  return Array.from({ length }, (_, index) => template[index % template.length]);
}

test('the integer parser preserves token boundaries and values above Number precision', () => {
  assert.deepEqual(parseIntegerSequence('  000, 01\t9007199254740992,\n9007199254740993 18446744073709551615 '), [
    '0', '1', '9007199254740992', '9007199254740993', '18446744073709551615',
  ]);
});

test('the integer parser enforces unsigned decimal and public limits', () => {
  for (const invalid of ['-1', '+1', '1.2', '1e3', '0x10']) {
    assert.throws(() => parseIntegerSequence(invalid), { code: 'invalid' });
  }
  assert.throws(() => parseIntegerSequence(' ,\n '), { code: 'empty' });
  assert.throws(() => parseIntegerSequence('18446744073709551616'), { code: 'outOfRange' });
  assert.equal(parseIntegerSequence('0 '.repeat(20_000)).length, 20_000);
  assert.throws(() => parseIntegerSequence('0 '.repeat(20_001)), { code: 'tooMany' });
  assert.throws(() => parseIntegerSequence('0'.repeat(500_001)), { code: 'tooLong' });
});

test('whole-value periodic forecasting verifies a cycle then continues the exact phase', () => {
  const template = ['9007199254740992', '9007199254740993', '18446744073709551615', '7'];
  const early = forecastIntegers(repeat(template, 11), 5);
  assert.equal(early.period, null);
  assert.equal(early.methods.periodic, null);

  const verified = forecastIntegers(repeat(template, 13), 5);
  assert.equal(verified.period, template.length);
  assert.deepEqual(verified.methods.periodic, [template[1], template[2], template[3], template[0], template[1]]);
});

test('first-order transition forecasts recur from the last observed whole value', () => {
  const labels = ['4', '219', '533', '706', '851'];
  const draws = syntheticSequence('uniform', 512, 42737);
  let index = 0;
  const history = Array.from({ length: 256 }, (_, offset) => {
    index = draws[offset * 2] < 8 ? (index + 1) % labels.length : draws[offset * 2 + 1] % labels.length;
    return labels[index];
  });
  const result = forecastIntegers(history, 5);
  assert.equal(result.period, null);
  assert.equal(result.transitionValidated, true);
  const lastIndex = labels.indexOf(history.at(-1));
  assert.deepEqual(result.methods.transition, labels.map((_, step) => labels[(lastIndex + step + 1) % labels.length]));
});

test('a good fit cannot activate transitions that fail on later observations', () => {
  const fitted = repeat(['10', '20'], 80);
  const history = [...fitted, ...Array(40).fill('10')];
  const result = forecastIntegers(history, 5);
  assert.equal(result.transitionValidated, false);
  assert.equal(result.methods.transition, null);
  assert.equal(result.methods.periodic, null);
  assert.deepEqual(result.methods.frequency, Array(5).fill('10'));
});

test('scoring checks a locked prediction by exact value and preserves abstentions', () => {
  const history = repeat(['9007199254740992', '9007199254740993'], 13);
  const locked = forecastIntegers(history, 5).methods;
  const snapshot = structuredClone(locked);
  const truth = ['9007199254740993', '9007199254740992', '9007199254740993', '9007199254740992', '9007199254740993'];
  const matched = scoreIntegerForecast(locked, truth);
  const changed = scoreIntegerForecast(locked, Array(5).fill('9007199254740992'));

  assert.equal(matched.transition, null);
  assert.deepEqual(matched.periodic, { positions: [true, true, true, true, true], hits: 5, exact: true });
  assert.deepEqual(changed.periodic, { positions: [false, true, false, true, false], hits: 2, exact: false });
  assert.deepEqual(locked, snapshot);
  assert.throws(() => scoreIntegerForecast(locked, [truth[0]]), RangeError);
});
