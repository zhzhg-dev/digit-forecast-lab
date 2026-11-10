import { verifiedSymbolPeriod } from "./periodic.mjs?v=0.5.0";

const MAX_VALUES = 20_000;
const MAX_TEXT_LENGTH = 500_000;
const MAX_VALUE = "18446744073709551615";
const MIN_TRANSITION_SAMPLES = 4;
const MIN_VALIDATION_LENGTH = 24;
const MIN_VALIDATION_COVERAGE = 0.8;
const MIN_VALIDATION_GAIN = 0.1;

export class IntegerSequenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "IntegerSequenceError";
    this.code = code;
  }
}

function lessThan(left, right) {
  return left.length === right.length ? left < right : left.length < right.length;
}

export function parseIntegerSequence(text) {
  if (typeof text !== "string") throw new IntegerSequenceError("invalid");
  if (text.length > MAX_TEXT_LENGTH) throw new IntegerSequenceError("tooLong");

  const tokens = text.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) throw new IntegerSequenceError("empty");
  if (tokens.length > MAX_VALUES) throw new IntegerSequenceError("tooMany");

  return tokens.map(token => {
    if (!/^[0-9]+$/.test(token)) throw new IntegerSequenceError("invalid");
    const value = token.replace(/^0+(?=\d)/, "");
    if (lessThan(MAX_VALUE, value)) throw new IntegerSequenceError("outOfRange");
    return value;
  });
}

function requireValues(values) {
  if (!Array.isArray(values) || values.length === 0) throw new IntegerSequenceError("empty");
  if (values.length > MAX_VALUES) throw new IntegerSequenceError("tooMany");
  for (const value of values) {
    if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
      throw new IntegerSequenceError("invalid");
    }
    if (lessThan(MAX_VALUE, value)) throw new IntegerSequenceError("outOfRange");
  }
}

function increment(counts, value) {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function mostFrequent(counts) {
  let best;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && lessThan(value, best))) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function frequencyPick(history) {
  const counts = new Map();
  for (const value of history) increment(counts, value);
  return mostFrequent(counts);
}

function validatedTransitions(history) {
  const fitLength = Math.floor(history.length * 2 / 3);
  const validationLength = history.length - fitLength;
  if (validationLength < MIN_VALIDATION_LENGTH) return null;

  const countsByPrevious = new Map();
  for (let index = 1; index < fitLength; index += 1) {
    const previous = history[index - 1];
    if (!countsByPrevious.has(previous)) countsByPrevious.set(previous, { total: 0, counts: new Map() });
    const row = countsByPrevious.get(previous);
    row.total += 1;
    increment(row.counts, history[index]);
  }

  const predictions = new Map();
  for (const [previous, row] of countsByPrevious) {
    if (row.total >= MIN_TRANSITION_SAMPLES) predictions.set(previous, mostFrequent(row.counts));
  }

  const baseline = frequencyPick(history.slice(0, fitLength));
  let supported = 0;
  let hits = 0;
  let baselineHits = 0;
  for (let index = fitLength; index < history.length; index += 1) {
    const prediction = predictions.get(history[index - 1]);
    supported += Number(prediction !== undefined);
    hits += Number(prediction === history[index]);
    baselineHits += Number(baseline === history[index]);
  }

  if (supported < MIN_VALIDATION_COVERAGE * validationLength ||
      hits - baselineHits < MIN_VALIDATION_GAIN * validationLength) return null;
  return predictions;
}

function followTransitions(predictions, previous, horizon) {
  if (predictions === null) return null;
  const sequence = [];
  for (let step = 0; step < horizon; step += 1) {
    const prediction = predictions.get(previous);
    if (prediction === undefined) return null;
    sequence.push(prediction);
    previous = prediction;
  }
  return sequence;
}

export function forecastIntegers(history, horizon) {
  requireValues(history);
  if (horizon !== 1 && horizon !== 5) throw new RangeError("Forecast horizon must be 1 or 5.");

  const period = verifiedSymbolPeriod(history);
  const transitions = validatedTransitions(history);
  return {
    period,
    transitionValidated: transitions !== null,
    methods: {
      frequency: Array(horizon).fill(frequencyPick(history)),
      transition: followTransitions(transitions, history.at(-1), horizon),
      periodic: period === null ? null : Array.from({ length: horizon }, (_, step) =>
        history[(history.length + step) % period]),
    },
  };
}

export function scoreIntegerForecast(forecasts, actual) {
  requireValues(actual);
  if (actual.length !== 1 && actual.length !== 5) throw new RangeError("Enter 1 or 5 actual values.");

  return Object.fromEntries(Object.entries(forecasts).map(([method, prediction]) => {
    if (prediction === null) return [method, null];
    if (prediction.length !== actual.length) throw new RangeError("Truth must match the forecast horizon.");

    const positions = actual.map((value, index) => value === prediction[index]);
    const hits = positions.filter(Boolean).length;
    return [method, { positions, hits, exact: hits === actual.length }];
  }));
}
