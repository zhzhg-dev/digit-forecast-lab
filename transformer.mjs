import { TRAINING_METADATA, TRANSFORMER_WEIGHTS as weights } from './transformer-weights.mjs?v=0.4.0';

export const TRANSFORMER_CONTEXT_LENGTH = TRAINING_METADATA.contextLength;
export const TRANSFORMER_MAX_HORIZON = TRAINING_METADATA.maxHorizon;
export const TRANSFORMER_METADATA = Object.freeze(TRAINING_METADATA);

const DIGITS = 10;
const {
  minimumHistory, maxLag, minFitPairs, fitFraction, repeatPrior, repeatCap,
  evidenceScale, correctionLimit, width, attentionHeads,
} = TRAINING_METADATA;
const HEAD_WIDTH = width / attentionHeads;
const HEAD_SCALE = 1 / Math.sqrt(HEAD_WIDTH);
const LAG_LOG_PRIOR = -Math.log(maxLag);
const LOG_CONTEXT = Math.log1p(TRANSFORMER_CONTEXT_LENGTH);

function marginalDistribution(history, end = history.length) {
  const counts = Array(DIGITS).fill(1);
  for (let index = 0; index < end; index += 1) counts[history[index]] += 1;
  return counts.map(count => count / (end + DIGITS));
}

function copyStrength(matches, expected, pairs) {
  return Math.min(repeatCap, Math.max(0, (matches - expected) / (pairs - expected + repeatPrior)));
}

function lagEvidence(history, marginal, fitMarginal, split, lag) {
  let fitMatches = 0;
  let fitExpected = 0;
  let fullExpected = 0;
  for (let index = lag; index < split; index += 1) {
    const previous = history[index - lag];
    fitMatches += Number(history[index] === previous);
    fitExpected += fitMarginal[previous];
    fullExpected += marginal[previous];
  }

  const fitted = copyStrength(fitMatches, fitExpected, split - lag);
  const missGain = Math.log1p(-fitted);
  let validationMatches = 0;
  let validationExpected = 0;
  let gain = 0;
  for (let index = split; index < history.length; index += 1) {
    const previous = history[index - lag];
    const digit = history[index];
    const matches = digit === previous;
    validationMatches += Number(matches);
    validationExpected += fitMarginal[previous];
    fullExpected += marginal[previous];
    gain += matches ? Math.log1p(fitted * (1 / fitMarginal[digit] - 1)) : missGain;
  }

  const validationPairs = history.length - split;
  return {
    fitted,
    full: copyStrength(fitMatches + validationMatches, fullExpected, history.length - lag),
    validation: copyStrength(validationMatches, validationExpected, validationPairs),
    meanGain: gain / validationPairs,
    prior: evidenceScale * gain + LAG_LOG_PRIOR,
  };
}

function evidenceFromHistory(history, marginal) {
  // Fit on the earlier portion and score these frozen estimates on the later
  // portion of the same known history. Future targets are never used here.
  const split = Math.floor(history.length * fitFraction);
  const fitMarginal = marginalDistribution(history, split);
  const length = Math.log1p(history.length) / LOG_CONTEXT;
  const largest = Math.max(...marginal);
  const tokens = [[1, length, largest, 0, 0, 0, 0]];
  const priors = [0];
  const strengths = [0];
  for (let lag = 1; lag <= maxLag; lag += 1) {
    if (split - lag < minFitPairs) {
      tokens.push([0, length, largest, 0, 0, 0, 0]);
      priors.push(-30);
      strengths.push(0);
      continue;
    }
    const { fitted, full, validation, meanGain, prior } = lagEvidence(history, marginal, fitMarginal, split, lag);
    tokens.push([0, length, largest, fitted, full, validation, meanGain]);
    priors.push(prior);
    strengths.push(full);
  }
  return { tokens, priors, strengths };
}

function project(input, layer) {
  return layer.weight.map((row, output) => {
    let value = layer.bias?.[output] ?? 0;
    for (let index = 0; index < input.length; index += 1) value += row[index] * input[index];
    return value;
  });
}

function softmax(scores) {
  const maximum = Math.max(...scores);
  const exponents = scores.map(score => Math.exp(score - maximum));
  const total = exponents.reduce((sum, value) => sum + value, 0);
  return exponents.map(value => value / total);
}

function rmsNormalize(input) {
  const meanSquare = input.reduce((sum, value) => sum + value * value, 0) / input.length;
  const scale = 1 / Math.sqrt(meanSquare + 1e-5);
  return input.map(value => value * scale);
}

function attendedTokens(tokens) {
  const keys = tokens.map(token => project(token, weights.key));
  const values = tokens.map(token => project(token, weights.value));
  return tokens.map(token => {
    const query = project(token, weights.query);
    const attended = Array(width).fill(0);
    for (let head = 0; head < attentionHeads; head += 1) {
      const offset = head * HEAD_WIDTH;
      const end = offset + HEAD_WIDTH;
      const scores = keys.map(key => {
        let dot = 0;
        for (let index = offset; index < end; index += 1) dot += query[index] * key[index];
        return dot * HEAD_SCALE;
      });
      const attention = softmax(scores);
      for (let position = 0; position < values.length; position += 1) {
        for (let index = offset; index < end; index += 1) {
          attended[index] += attention[position] * values[position][index];
        }
      }
    }
    return project(attended, weights.attentionOutput);
  });
}

function mixtureWeights(evidence, priors) {
  // Sharing all parameters across evidence tokens allows the same scoring
  // rule to apply to lags omitted during training.
  const tokens = evidence.map(token => project(token, weights.embedding).map(Math.tanh));
  const attended = attendedTokens(tokens);
  const logits = tokens.map((token, position) => {
    const hidden = rmsNormalize(token.map((value, index) => value + attended[position][index]));
    const expanded = project(hidden, weights.feedIn).map(value => Math.max(0, value));
    const feed = project(expanded, weights.feedOut);
    const features = rmsNormalize(hidden.map((value, index) => value + feed[index]));
    const correction = correctionLimit * Math.tanh(project(features, weights.score)[0]);
    return priors[position] + correction;
  });
  return softmax(logits);
}

function predictMixture(history, horizon, marginal, strengths, mixture) {
  return Array.from({ length: horizon }, (_, step) => {
    const probabilities = Array(DIGITS).fill(0);
    let totalCopyMass = 0;
    for (let lag = 1; lag <= maxLag; lag += 1) {
      // With every copy on this strand, the digit stays at its anchor. Any
      // redraw returns it to the marginal, so no generated digit is fed back.
      const copies = Math.floor(step / lag) + 1;
      const mass = mixture[lag] * strengths[lag] ** copies;
      const anchor = history[history.length - lag + step % lag];
      probabilities[anchor] += mass;
      totalCopyMass += mass;
    }
    return probabilities.map((mass, digit) => mass + (1 - totalCopyMass) * marginal[digit]);
  });
}

export function predictTransformer(history, horizon = 1) {
  if (!Array.isArray(history)) throw new TypeError('History must be an array of digits.');
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > TRANSFORMER_MAX_HORIZON) {
    throw new RangeError('Forecast horizon must be an integer from 1 to ' + TRANSFORMER_MAX_HORIZON + '.');
  }

  const context = history.slice(-TRANSFORMER_CONTEXT_LENGTH);
  for (const digit of context) {
    if (!Number.isInteger(digit) || digit < 0 || digit >= DIGITS) {
      throw new RangeError('History digits must be integers from 0 to 9.');
    }
  }
  const marginal = marginalDistribution(context);
  if (context.length < minimumHistory) {
    return Array.from({ length: horizon }, () => marginal.slice());
  }

  const { tokens, priors, strengths } = evidenceFromHistory(context, marginal);
  return predictMixture(context, horizon, marginal, strengths, mixtureWeights(tokens, priors));
}
