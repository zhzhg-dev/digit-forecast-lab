import { METHODS, mostLikely, predict, syntheticSequence } from '../forecast.mjs';
import { forecastIntegers, scoreIntegerForecast } from '../integer-forecast.mjs';

const STREAMS = 256;
const HISTORY = 256;
const HORIZON = 5;
const BASE_SEED = 0x3740a310;
const CATEGORIES = ['4', '219', '533', '706', '851'];
const INTEGER_METHODS = ['frequency', 'transition', 'periodic'];
const PROFILES = [
  {
    id: 'exact', description: 'Exact repetition of 37 synthetic 20-digit unsigned values',
    expectedPositionAccuracy: Array(HORIZON).fill(1), expectedAllFiveAccuracy: 1,
  },
  {
    id: 'markov', description: 'Advance around a five-value cycle with probability 0.8, otherwise draw a fresh value uniformly',
    expectedPositionAccuracy: Array.from({ length: HORIZON }, (_, step) => 0.2 + 0.8 * (0.8 ** (step + 1))),
    expectedAllFiveAccuracy: 0.84 ** HORIZON,
  },
  {
    id: 'iid', description: 'Independent uniform draws from the same five-value alphabet',
    expectedPositionAccuracy: Array(HORIZON).fill(0.2), expectedAllFiveAccuracy: 0.2 ** HORIZON,
  },
];

function makeSequence(profileId, seed) {
  const length = HISTORY + HORIZON;
  if (profileId === 'exact') {
    const period = 37;
    const digits = syntheticSequence('uniform', period * 18, seed).join('');
    const template = Array.from({ length: period }, (_, index) => '10' + digits.slice(index * 18, (index + 1) * 18));
    return Array.from({ length }, (_, index) => template[index % period]);
  }

  const draws = syntheticSequence('uniform', length * 2, seed);
  let position = draws[0] % CATEGORIES.length;
  return Array.from({ length }, (_, index) => {
    const fresh = draws[index * 2] % CATEGORIES.length;
    const advance = profileId === 'markov' && index > 0 && draws[index * 2 + 1] < 8;
    position = advance ? (position + 1) % CATEGORIES.length : fresh;
    return CATEGORIES[position];
  });
}

function makeTally() {
  return { covered: 0, positions: Array(HORIZON).fill(0), pooled: 0, exact: 0 };
}

function addScore(tally, result) {
  if (result === null) return;
  tally.covered += 1;
  tally.pooled += result.hits;
  tally.exact += Number(result.exact);
  result.positions.forEach((correct, index) => { tally.positions[index] += Number(correct); });
}

function summarizeTally({ covered, positions, pooled, exact }) {
  return {
    coverage: { count: covered, total: STREAMS },
    positions: positions.map((hits) => ({ hits, total: covered })),
    pooled: { hits: pooled, total: HORIZON * covered },
    allFive: { hits: exact, total: covered },
  };
}

function encodeDigits(values, width) {
  return values.map((value) => value.padStart(width, '0')).join('');
}

function forecastDigits(values, width) {
  const history = Array.from(encodeDigits(values, width), Number);
  return Object.fromEntries(Object.entries(predict(history, HORIZON)).map(([id, rows]) => [id, rows.map(mostLikely).join('')]));
}

function addPairedScore(paired, digitForecast, integerForecast, target) {
  const padded = target.padStart(paired.wordWidth, '0');
  for (const [id, forecast] of Object.entries(digitForecast)) {
    paired.legacyNextWord[id].hits += Number(forecast.slice(0, paired.wordWidth) === padded);
  }
  for (const [id, forecast] of Object.entries(integerForecast)) {
    if (forecast === null) continue;
    paired.integerNextWord[id].total += 1;
    paired.integerNextWord[id].hits += Number(forecast[0] === target);
  }
  if (integerForecast.transition === null) return;
  const integerCorrect = integerForecast.transition[0] === target;
  const legacyCorrect = digitForecast.markov.slice(0, paired.wordWidth) === padded;
  const matched = paired.transitionVsLegacyMarkov;
  matched.total += 1;
  matched.bothCorrect += Number(integerCorrect && legacyCorrect);
  matched.onlyInteger += Number(integerCorrect && !legacyCorrect);
  matched.onlyLegacy += Number(legacyCorrect && !integerCorrect);
  matched.neither += Number(!integerCorrect && !legacyCorrect);
}

function runBenchmark() {
  const profiles = [];
  const wide = {
    profileId: 'exact', historyIntegers: HISTORY, historyDigits: HISTORY * 20, wordWidth: 20,
    legacyForecastDigits: HORIZON, integerForecastValues: HORIZON,
    completeIntegersCoveredByDigitForecast: 0,
    legacyMethod: 'periodic', integerMethod: 'periodic',
    legacyDigitPrefix: { hits: 0, total: STREAMS }, integerAllFive: { hits: 0, total: 0 },
  };
  const paired = {
    profileId: 'markov', historyIntegers: HISTORY, historyDigits: HISTORY * 3, wordWidth: 3,
    legacyForecastDigits: HORIZON, target: 'first complete next value', streams: STREAMS,
    legacyNextWord: Object.fromEntries(METHODS.map(({ id }) => [id, { hits: 0, total: STREAMS }])),
    integerNextWord: Object.fromEntries(INTEGER_METHODS.map((id) => [id, { hits: 0, total: 0 }])),
    transitionVsLegacyMarkov: { total: 0, bothCorrect: 0, onlyInteger: 0, onlyLegacy: 0, neither: 0 },
  };

  for (const [profileIndex, profile] of PROFILES.entries()) {
    const scores = Object.fromEntries(INTEGER_METHODS.map((id) => [id, makeTally()]));
    let validatedTransitions = 0;
    for (let stream = 0; stream < STREAMS; stream += 1) {
      const sequence = makeSequence(profile.id, BASE_SEED + profileIndex * 10_000_000 + stream * 7919);
      const history = sequence.slice(0, HISTORY);
      const forecast = forecastIntegers(history, HORIZON);
      const digitForecast = profile.id === 'iid' ? null
        : forecastDigits(history, profile.id === 'exact' ? wide.wordWidth : paired.wordWidth);

      const actual = sequence.slice(HISTORY);
      const result = scoreIntegerForecast(forecast.methods, actual);
      validatedTransitions += Number(forecast.transitionValidated);
      for (const id of INTEGER_METHODS) addScore(scores[id], result[id]);

      if (profile.id === 'exact') {
        const digitPrefix = encodeDigits(actual, wide.wordWidth).slice(0, HORIZON);
        wide.legacyDigitPrefix.hits += Number(digitForecast.periodic === digitPrefix);
        if (result.periodic !== null) {
          wide.integerAllFive.total += 1;
          wide.integerAllFive.hits += Number(result.periodic.exact);
        }
      }
      if (profile.id === 'markov') addPairedScore(paired, digitForecast, forecast.methods, actual[0]);
    }

    profiles.push({
      ...profile, streams: STREAMS, historyIntegers: HISTORY,
      transitionValidation: { count: validatedTransitions, total: STREAMS },
      methods: Object.fromEntries(Object.entries(scores).map(([id, tally]) => [id, summarizeTally(tally)])),
    });
  }
  return {
    protocol: { version: 1, streamsPerProfile: STREAMS, historyIntegers: HISTORY, horizon: HORIZON },
    profiles, comparisons: { wide, paired },
  };
}

const report = runBenchmark();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const scoreText = ({ hits, total }) => `${hits}/${total}`;
  console.log(`${STREAMS} separately seeded synthetic histories per profile. Each locks ${HORIZON} complete values after ${HISTORY} observed values.`);
  console.log('Position, pooled and all-five denominators count only forecasts that the method issued. Coverage also counts abstentions.');
  console.table(report.profiles.flatMap((profile) => Object.entries(profile.methods).map(([method, scores]) => ({
    profile: profile.id, method, coverage: `${scores.coverage.count}/${scores.coverage.total}`,
    positions: scores.positions.map(scoreText).join('  '), pooled: scoreText(scores.pooled), allFive: scoreText(scores.allFive),
  }))));
  const { wide, paired } = report.comparisons;
  console.log(`A ${wide.legacyForecastDigits}-digit forecast covers zero full ${wide.wordWidth}-digit values. Digit prefix ${scoreText(wide.legacyDigitPrefix)}. Five whole values ${scoreText(wide.integerAllFive)}.`);
  console.log(`Paired exact next value on the same ${paired.wordWidth}-digit synthetic Markov histories. The comparison varies input representation and model.`);
  console.table([
    ...Object.entries(paired.legacyNextWord).map(([method, score]) => ({ input: 'digits', method, score: scoreText(score) })),
    ...Object.entries(paired.integerNextWord).map(([method, score]) => ({ input: 'whole values', method, score: scoreText(score) })),
  ]);
}
