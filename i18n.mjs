import { METHODS } from "./forecast.mjs";

export const DEFAULT_LANGUAGE = "en";

const englishMethods = {
  uniform: ["Uniform baseline", "Assigns a 10% probability to every digit."],
  frequency: ["Smoothed frequency", "Estimates probabilities from the observed digit counts and gives unseen digits some probability."],
  markov: ["First-order Markov", "Estimates the next digit from the previous one. For later positions it carries the probabilities forward."],
  lag: ["Lag mixture (MTD)", "Combines digit frequencies with transitions from 1 to 12 positions back. Uses smoothed frequencies if the mixture does not improve enough on validation data."],
};

const dictionaries = {
  en: {
    empty: "",
    digitLimit: "Up to 20,000 digits",
    digitCount: ({ count }, integer) => `${integer(count)} ${count === 1 ? "digit" : "digits"}`,
    forecastUsing: ({ methodId, count }, integer, method) => `${method(methodId).label} used ${integer(count)} ${count === 1 ? "digit" : "digits"} of history.`,
    positionProbabilities: ({ step }) => `Digit probabilities at position +${step}`,
    digitProbability: ({ digit, probability }) => `Digit ${digit}, ${probability}`,
    stepTied: ({ step }) => `Position +${step}, tied for highest probability`,
    stepGuess: ({ step, digit }) => `Position +${step}, predicted digit ${digit}`,
    inputChanged: "The sequence changed. Run the forecast again to see updated results.",
    benchmarkReady: "Run a backtest with the current sequence.",
    fixInput: "Correct the input and run the forecast again.",
    sampleLoaded: ({ count }, integer) => `Loaded ${integer(count)} synthetic digits.`,
    imported: "Imported the text file.",
    horizonChanged: "The forecast horizon changed. Run the forecast again.",
    settingsChanged: "The backtest settings changed. Run the backtest again.",
    missingDigits: ({ count }, integer) => `Enter at least ${integer(count)} digits or use a shorter history window.`,
    benchmarkComplete: ({ origins, count }, integer) => `Scored ${integer(origins)} non-overlapping forecast ${origins === 1 ? "window" : "windows"}, each with ${integer(count)} ${count === 1 ? "digit" : "digits"} of history. Ties go to the smaller digit.`,
    methodHeader: "Method",
    stepHeader: ({ step }) => `Position +${step}`,
    fullMatch: "All digits correct",
    lossValue: ({ loss }) => `Log loss ${loss}`,
    csvHistoryLength: "History length",
    csvHorizon: "Forecast horizon",
    csvWindows: "Test windows",
    csvPosition: "Forecast position",
    csvAccuracy: "Accuracy",
    csvLogLoss: "Log loss",
    csvFullMatch: "Exact match rate",
    textTooLong: "The text is too long. Remove extra separators or use a shorter sequence.",
    fileTooLarge: "The file is too large. Split the digits into smaller text files.",
    enterDigits: "Enter at least one digit from 0 to 9.",
    tooManyDigits: ({ max = 20_000 }, integer) => `Enter no more than ${integer(max)} digits.`,
    invalidDigits: "Use digits 0–9. You can separate them with spaces, commas, or line breaks.",
    invalidSequence: ({ max = 20_000 }, integer) => `The sequence must contain at most ${integer(max)} digits from 0 to 9.`,
    unknownSample: "Choose one of the synthetic samples.",
    unexpectedError: "Something went wrong. Check the input and try again.",
    importFailed: "Could not read the file. Try importing it again or paste the digits directly.",
    sampleFailed: "Could not load the sample. Choose a sample and try again.",
    integerRange: ({ field, min, max }, integer) => `${fieldNames.en[field]} must be an integer from ${integer(min)} to ${integer(max)}.`,
  },
  zh: {
    empty: "",
    digitLimit: "最多 20,000 位",
    digitCount: ({ count }, integer) => `${integer(count)} 位`,
    forecastUsing: ({ methodId, count }, integer, method) => `${method(methodId).label}使用 ${integer(count)} 位历史数字。`,
    positionProbabilities: ({ step }) => `第 ${step} 位各数字的概率`,
    digitProbability: ({ digit, probability }) => `数字 ${digit}，概率 ${probability}`,
    stepTied: ({ step }) => `第 ${step} 位，最高概率并列`,
    stepGuess: ({ step, digit }) => `第 ${step} 位，预测数字 ${digit}`,
    inputChanged: "序列有变动。重新计算后可查看预测。",
    benchmarkReady: "当前序列可以用于盲测。",
    fixInput: "修正输入后可以重新计算。",
    sampleLoaded: ({ count }, integer) => `已载入 ${integer(count)} 位合成数字。`,
    imported: "已导入文本文件。",
    horizonChanged: "预测范围已改变。请重新计算。",
    settingsChanged: "盲测设置已改变。请重新运行盲测。",
    missingDigits: ({ count }, integer) => `请至少提供 ${integer(count)} 位数字，或缩短历史窗口。`,
    benchmarkComplete: ({ origins, count }, integer) => `已测试 ${integer(origins)} 个不重叠的预测区间，每次使用 ${integer(count)} 位历史。概率并列时用较小数字计命中。`,
    methodHeader: "方法",
    stepHeader: ({ step }) => `第 ${step} 位`,
    fullMatch: "整段全中",
    lossValue: ({ loss }) => `对数损失 ${loss}`,
    csvHistoryLength: "历史长度",
    csvHorizon: "预测范围",
    csvWindows: "测试区间数",
    csvPosition: "预测位置",
    csvAccuracy: "命中率",
    csvLogLoss: "对数损失",
    csvFullMatch: "整段全中率",
    textTooLong: "文本太长。请减少分隔符，或分成更短的序列。",
    fileTooLarge: "文件过大。请把数字拆成较短的文本。",
    enterDigits: "请至少输入一个 0–9 的数字。",
    tooManyDigits: ({ max = 20_000 }, integer) => `请输入不超过 ${integer(max)} 位数字。`,
    invalidDigits: "序列仅接受 0–9 数字，可以用空格、逗号或换行分隔。",
    invalidSequence: ({ max = 20_000 }, integer) => `序列须由 0–9 组成，最多 ${integer(max)} 位。`,
    unknownSample: "请选择一个合成示例。",
    unexpectedError: "操作失败。请检查输入后重试。",
    importFailed: "无法读取文件。请重新导入，或直接粘贴数字。",
    sampleFailed: "无法载入示例。请选择一个示例后重试。",
    integerRange: ({ field, min, max }, integer) => `${fieldNames.zh[field]}须为 ${integer(min)} 至 ${integer(max)} 之间的整数。`,
  },
};

const fieldNames = {
  en: { digit: "A digit", horizon: "The forecast horizon", history: "The history length", origins: "The window limit", sampleLength: "The sample length", seed: "The sample seed" },
  zh: { digit: "数字", horizon: "预测步数", history: "历史长度", origins: "回测窗口上限", sampleLength: "样本长度", seed: "模拟种子" },
};

const fieldByCoreName = new Map([
  ["数字", "digit"], ["预测步数", "horizon"], ["历史窗口", "history"], ["回测窗口上限", "origins"],
  ["样本长度", "sampleLength"], ["模拟种子", "seed"],
]);
const keysByCoreError = new Map([
  ["请输入数字序列。", "enterDigits"],
  ["序列仅接受 0–9 数字，允许用空白或逗号分隔。", "invalidDigits"],
  ["未知的合成样本。", "unknownSample"],
]);

export class LocalizedError extends Error {
  constructor(key, args) {
    super(key);
    this.key = key;
    this.args = args;
  }
}

export function describeError(error, fallback = "unexpectedError") {
  if (error instanceof LocalizedError) return { key: error.key, args: error.args };
  const message = error?.message;
  if (typeof message !== "string") return { key: fallback };
  if (keysByCoreError.has(message)) return { key: keysByCoreError.get(message) };

  const maxDigits = /^序列最多 (\d+) 位。$/.exec(message);
  if (maxDigits) return { key: "tooManyDigits", args: { max: Number(maxDigits[1]) } };
  const arrayLimit = /^序列须为至多 (\d+) 位数字的数组。$/.exec(message);
  if (arrayLimit) return { key: "invalidSequence", args: { max: Number(arrayLimit[1]) } };
  const range = /^(.+)须为 (\d+)–(\d+) 之间的整数。$/.exec(message);
  if (range && fieldByCoreName.has(range[1])) {
    return { key: "integerRange", args: { field: fieldByCoreName.get(range[1]), min: Number(range[2]), max: Number(range[3]) } };
  }
  return { key: fallback };
}

const chineseMethods = new Map(METHODS.map(method => [method.id, method]));

export function createTranslator(requestedLanguage) {
  const language = requestedLanguage === "zh" ? "zh" : DEFAULT_LANGUAGE;
  const locale = language === "zh" ? "zh-CN" : "en";
  const { format: integer } = new Intl.NumberFormat(locale);
  const { format: percent } = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const { format: decimal } = new Intl.NumberFormat(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  function method(id) {
    if (language === "zh") return chineseMethods.get(id);
    const [label, description] = englishMethods[id];
    return { id, label, description };
  }
  return {
    language,
    documentLanguage: language === "zh" ? "zh-Hans" : "en",
    integer,
    percent,
    decimal,
    text(key, args = {}) {
      const message = dictionaries[language][key];
      return typeof message === "function" ? message(args, integer, method) : message;
    },
    method,
  };
}

export function createStaticLocalizer(document, dynamicTextNodes = []) {
  const entries = [];
  const dynamicText = new Set(dynamicTextNodes);
  for (const node of document.querySelectorAll("*")) {
    if (!dynamicText.has(node) && node.hasAttribute("data-zh")) {
      entries.push({ node, attribute: null, en: node.textContent, zh: node.getAttribute("data-zh") });
    }
    for (const marker of node.getAttributeNames()) {
      if (!marker.startsWith("data-zh-")) continue;
      const attribute = marker.slice("data-zh-".length);
      entries.push({ node, attribute, en: node.getAttribute(attribute), zh: node.getAttribute(marker) });
    }
  }

  return (language) => {
    const chinese = language === "zh";
    document.documentElement.lang = chinese ? "zh-Hans" : "en";
    for (const entry of entries) {
      const value = chinese ? entry.zh : entry.en;
      if (entry.attribute === null) {
        if (entry.node.textContent !== value) entry.node.textContent = value;
      } else if (value === null) {
        entry.node.removeAttribute(entry.attribute);
      } else {
        entry.node.setAttribute(entry.attribute, value);
      }
    }
  };
}
