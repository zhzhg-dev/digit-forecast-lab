const DIGIT_COUNT = 10;
const CONTINUATION_PROBABILITY = 0.99;

function isDigit(value) {
  return Number.isInteger(value) && value >= 0 && value < DIGIT_COUNT;
}

export function verifiedPeriod(history) {
  if (!Array.isArray(history) || history.length < 3 || !isDigit(history[0])) return null;

  const fitLength = Math.floor(history.length * 2 / 3);
  const borders = new Uint32Array(fitLength);
  for (let index = 1; index < fitLength; index += 1) {
    const digit = history[index];
    if (!isDigit(digit)) return null;
    let border = borders[index - 1];
    while (border > 0 && digit !== history[border]) border = borders[border - 1];
    borders[index] = digit === history[border] ? border + 1 : border;
  }

  // The longest prefix that is also a suffix gives the shortest period,
  // including when the fitting segment ends partway through a cycle.
  const period = fitLength - borders[fitLength - 1];
  if (2 * period > fitLength || period > history.length - fitLength) return null;

  for (let index = fitLength; index < history.length; index += 1) {
    if (history[index] !== history[index % period]) return null;
  }
  return period;
}

export function forecastPeriodic(history, horizon) {
  const period = verifiedPeriod(history);
  if (period === null) return null;

  const otherProbability = (1 - CONTINUATION_PROBABILITY) / (DIGIT_COUNT - 1);
  return Array.from({ length: horizon }, (_, step) => {
    const digit = history[(history.length + step) % period];
    const probabilities = Array(DIGIT_COUNT).fill(otherProbability);
    probabilities[digit] = CONTINUATION_PROBABILITY;
    return probabilities;
  });
}
