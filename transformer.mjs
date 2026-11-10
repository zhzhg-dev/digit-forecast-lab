import { TRAINING_METADATA, TRANSFORMER_WEIGHTS as weights } from './transformer-weights.mjs?v=0.2.0';

export const TRANSFORMER_CONTEXT_LENGTH = TRAINING_METADATA.contextLength;
export const TRANSFORMER_MAX_HORIZON = TRAINING_METADATA.maxHorizon;
export const TRANSFORMER_METADATA = Object.freeze(TRAINING_METADATA);

const DIGITS = 10;
const WIDTH = TRAINING_METADATA.width;
const HEADS = TRAINING_METADATA.attentionHeads;
const HEAD_WIDTH = WIDTH / HEADS;
const HEAD_SCALE = 1 / Math.sqrt(HEAD_WIDTH);

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

function attend(tokens, firstPosition) {
  const query = project(tokens.at(-1), weights.query);
  const keys = tokens.map(token => project(token, weights.key));
  const values = tokens.map(token => project(token, weights.value));
  const attended = Array(WIDTH).fill(0);

  // The final token is the sole readout query. Its attention is causal because
  // every key and value comes from the known history, including that token.
  for (let head = 0; head < HEADS; head += 1) {
    const offset = head * HEAD_WIDTH;
    const scores = keys.map((key, position) => {
      let dot = 0;
      for (let index = offset; index < offset + HEAD_WIDTH; index += 1) {
        dot += query[index] * key[index];
      }
      return dot * HEAD_SCALE + weights.attentionBias[head][firstPosition + position];
    });
    const attention = softmax(scores);
    for (let position = 0; position < values.length; position += 1) {
      for (let index = offset; index < offset + HEAD_WIDTH; index += 1) {
        attended[index] += attention[position] * values[position][index];
      }
    }
  }
  return project(attended, weights.attentionOutput);
}

export function predictTransformer(history, horizon = 1) {
  if (!Array.isArray(history)) throw new TypeError('History must be an array of digits.');
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > TRANSFORMER_MAX_HORIZON) {
    throw new RangeError(`Forecast horizon must be an integer from 1 to ${TRANSFORMER_MAX_HORIZON}.`);
  }
  if (history.length === 0) {
    return Array.from({ length: horizon }, () => Array(DIGITS).fill(1 / DIGITS));
  }

  const context = history.slice(-TRANSFORMER_CONTEXT_LENGTH);
  const firstPosition = TRANSFORMER_CONTEXT_LENGTH - context.length;
  const tokens = Array.from({ length: context.length }, (_, index) => {
    const digit = context[index];
    if (!Number.isInteger(digit) || digit < 0 || digit >= DIGITS) {
      throw new RangeError('History digits must be integers from 0 to 9.');
    }
    const position = weights.position[firstPosition + index];
    return weights.digit[digit].map((value, column) => value + position[column]);
  });

  const lastToken = tokens.at(-1);
  const hidden = attend(tokens, firstPosition).map((value, index) => value + lastToken[index]);
  const intermediate = project(rmsNormalize(hidden), weights.feedIn).map(value => Math.max(0, value));
  const residual = project(intermediate, weights.feedOut).map((value, index) => value + hidden[index]);
  const features = rmsNormalize(residual);
  const outputs = horizon * DIGITS;
  const logits = project(features, {
    weight: weights.readout.weight.slice(0, outputs),
    bias: weights.readout.bias.slice(0, outputs),
  });

  // Separate heads produce each horizon directly from the same encoded history.
  return Array.from({ length: horizon }, (_, step) => softmax(logits.slice(step * DIGITS, (step + 1) * DIGITS)));
}
