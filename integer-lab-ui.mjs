import { createStaticLocalizer, createTranslator } from "./i18n.mjs?v=0.4.0";
import { forecastIntegers, IntegerSequenceError, parseIntegerSequence, scoreIntegerForecast } from "./integer-forecast.mjs?v=0.5.0";

const methodIds = ["frequency", "transition", "periodic"];
const sampleCycle = ["308", "9007199254740993", "18446744073709551615", "42"];
const copy = {
  en: {
    empty: "Enter at least one integer.",
    invalid: "Use nonnegative decimal integers separated by commas or whitespace.",
    tooMany: "Enter no more than 20,000 values.",
    tooLong: "Shorten the input to at most 500,000 characters.",
    outOfRange: "Each value must be from 0 to 18,446,744,073,709,551,615.",
    unexpected: "The calculation could not finish. Check the input and try again.",
    sample: "Synthetic history loaded. Choose a horizon and lock the forecasts.",
    lockFirst: "Lock a forecast to enable scoring.",
    historyChanged: "The history or forecast horizon changed. Lock a new forecast.",
    locked: ({ count, horizon }, integer) =>
      `Locked ${integer(horizon)} forecast ${horizon === 1 ? "position" : "positions"} from ${integer(count)} historical ${count === 1 ? "value" : "values"}.`,
    scoreReady: ({ horizon }) =>
      horizon === 1 ? "Enter the one actual value to score this forecast." : "Enter exactly five actual values to score this forecast.",
    truthCount: ({ actual, horizon }, integer) =>
      `Enter exactly ${integer(horizon)} actual ${horizon === 1 ? "value" : "values"}. Received ${integer(actual)}.`,
    scored: "Scored the stored forecasts against the actual values.",
    method: "Method",
    score: "Score",
    frequency: "Frequency baseline",
    transition: "Validated first-order transition",
    periodic: "Verified cycle",
    transitionSupported: "The held-out history check passed.",
    transitionUnsupported: "The held-out history check did not pass.",
    transitionPath: "The history check passed. The forecast path lacked support.",
    period: ({ period }, integer) => `Verified a cycle of ${integer(period)} ${period === 1 ? "value" : "values"}.`,
    noCycle: "The held-out history did not verify a cycle.",
    abstain: "Abstained",
    actual: "Actual values",
    match: "Match",
    miss: "Miss",
    hits: ({ hits, horizon }, integer) => `${integer(hits)} / ${integer(horizon)} positions`,
    exact: "Exact match",
    partial: "Exact match missed",
  },
  zh: {
    empty: "请至少输入一个整数。",
    invalid: "请输入非负十进制整数，并用逗号或空白分隔。",
    tooMany: "最多可输入 20,000 个值。",
    tooLong: "请把输入缩短至 500,000 个字符以内。",
    outOfRange: "每个值须在 0 至 18,446,744,073,709,551,615 之间。",
    unexpected: "计算未完成。请检查输入后重试。",
    sample: "已载入合成历史。请选择预测范围并锁定预测。",
    lockFirst: "先锁定预测，再进行评分。",
    historyChanged: "历史或预测范围已改变。请重新锁定预测。",
    locked: ({ count, horizon }, integer) => `已根据 ${integer(count)} 个历史值锁定 ${integer(horizon)} 个位置的预测。`,
    scoreReady: ({ horizon }, integer) => `请输入 ${integer(horizon)} 个后续真值来评分。`,
    truthCount: ({ actual, horizon }, integer) => `需要 ${integer(horizon)} 个真值，目前输入了 ${integer(actual)} 个。`,
    scored: "已用真值为锁定的预测评分。",
    method: "方法",
    score: "评分",
    frequency: "频率基线",
    transition: "经验证的一阶转移",
    periodic: "经验证的周期",
    transitionSupported: "通过了留出历史的验证。",
    transitionUnsupported: "留出历史的验证未通过。",
    transitionPath: "历史验证通过，但预测路径的支持不足。",
    period: ({ period }, integer) => `已验证长度为 ${integer(period)} 个值的周期。`,
    noCycle: "留出的历史未能验证周期。",
    abstain: "弃权",
    actual: "实际值",
    match: "命中",
    miss: "未中",
    hits: ({ hits, horizon }, integer) => `命中 ${integer(hits)} / ${integer(horizon)} 个位置`,
    exact: "全部一致",
    partial: "未全部一致",
  },
};

const elements = {
  language: document.querySelector("#language"),
  historyForm: document.querySelector("#integer-history-form"),
  history: document.querySelector("#integer-history"),
  historyStatus: document.querySelector("#integer-history-status"),
  truthForm: document.querySelector("#integer-truth-form"),
  truthFields: document.querySelector("#integer-truth-fields"),
  truth: document.querySelector("#integer-truth"),
  scoreStatus: document.querySelector("#integer-score-status"),
  example: document.querySelector("#integer-example"),
  results: document.querySelector("#integer-results"),
  resultHead: document.querySelector("#integer-result-head"),
  resultBody: document.querySelector("#integer-result-body"),
};
const localizeStatic = createStaticLocalizer(document);
let translator = createTranslator(new URLSearchParams(location.search).get("lang"));
let locked;
let scored;
let historyMessage;
let scoreMessage = { key: "lockFirst" };

function text(key, args) {
  const value = copy[translator.language][key];
  return typeof value === "function" ? value(args, translator.integer) : value;
}

function element(tagName, value, className) {
  const node = document.createElement(tagName);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function renderMessage(node, message) {
  const value = message ? text(message.key, message.args) : "";
  if (node.textContent !== value) node.textContent = value;
  node.classList.toggle("error", message?.error === true);
}

function errorMessage(error) {
  return { key: error instanceof IntegerSequenceError ? error.code : "unexpected", error: true };
}

function tableHeading(value, scope) {
  const heading = element("th", value);
  heading.scope = scope;
  return heading;
}

function valueCell(value, match) {
  const cell = element("td");
  cell.append(element("code", value));
  if (match !== undefined) {
    const key = match ? "match" : "miss";
    const className = match ? "integer-matched" : "integer-missed";
    cell.append(element("span", text(key), className));
  }
  return cell;
}

function methodNote(id, result) {
  if (id === "transition") {
    if (!result.transitionValidated) return text("transitionUnsupported");
    return text(result.methods.transition ? "transitionSupported" : "transitionPath");
  }
  if (id === "periodic") {
    return result.period === null ? text("noCycle") : text("period", { period: result.period });
  }
  return "";
}

function renderMethod(id, { result, horizon }) {
  const row = element("tr");
  const name = tableHeading(text(id), "row");
  const note = methodNote(id, result);
  if (note) name.append(element("span", note, "integer-result-note"));
  row.append(name);

  const forecast = result.methods[id];
  const methodScore = scored?.methods[id];
  if (forecast) {
    forecast.forEach((value, index) => row.append(valueCell(value, methodScore?.positions[index])));
  } else {
    const cell = element("td", text("abstain"));
    cell.colSpan = horizon;
    row.append(cell);
  }

  if (scored) {
    const cell = element("td");
    if (methodScore) {
      cell.append(element("span", text("hits", { hits: methodScore.hits, horizon })));
      cell.append(element("span", text(methodScore.exact ? "exact" : "partial"), "integer-result-note"));
    } else {
      cell.textContent = "—";
    }
    row.append(cell);
  }
  return row;
}

function renderResults() {
  elements.results.hidden = !locked;
  if (!locked) {
    elements.resultHead.replaceChildren();
    elements.resultBody.replaceChildren();
    return;
  }

  const heading = element("tr");
  heading.append(tableHeading(text("method"), "col"));
  for (let position = 1; position <= locked.horizon; position += 1) {
    heading.append(tableHeading("+" + translator.integer(position), "col"));
  }
  if (scored) heading.append(tableHeading(text("score"), "col"));
  elements.resultHead.replaceChildren(heading);

  const rows = methodIds.map(id => renderMethod(id, locked));
  if (scored) {
    const actual = element("tr");
    actual.append(tableHeading(text("actual"), "row"), ...scored.actual.map(value => valueCell(value)), element("td", "—"));
    rows.unshift(actual);
  }
  elements.resultBody.replaceChildren(...rows);
}

function render() {
  elements.truthFields.disabled = !locked;
  renderMessage(elements.historyStatus, historyMessage);
  renderMessage(elements.scoreStatus, scoreMessage);
  renderResults();
}

function invalidateForecast(key) {
  locked = undefined;
  scored = undefined;
  historyMessage = key ? { key } : undefined;
  scoreMessage = { key: "lockFirst" };
  elements.history.removeAttribute("aria-invalid");
  elements.truth.removeAttribute("aria-invalid");
  render();
}

function onHistoryChanged() {
  const changed = locked || historyMessage?.key === "historyChanged";
  invalidateForecast(changed ? "historyChanged" : undefined);
}

function runForecast(event) {
  event.preventDefault();
  locked = undefined;
  scored = undefined;
  elements.history.removeAttribute("aria-invalid");
  elements.truth.removeAttribute("aria-invalid");
  scoreMessage = { key: "lockFirst" };
  try {
    const history = parseIntegerSequence(elements.history.value);
    const horizon = Number(new FormData(elements.historyForm).get("integer-horizon"));
    locked = { result: forecastIntegers(history, horizon), horizon };
    historyMessage = { key: "locked", args: { count: history.length, horizon } };
    scoreMessage = { key: "scoreReady", args: { horizon } };
  } catch (error) {
    historyMessage = errorMessage(error);
    elements.history.setAttribute("aria-invalid", "true");
  }
  render();
}

function runScore(event) {
  event.preventDefault();
  if (!locked) return;
  scored = undefined;
  elements.truth.removeAttribute("aria-invalid");
  try {
    const actual = parseIntegerSequence(elements.truth.value);
    const { horizon, result } = locked;
    if (actual.length !== horizon) {
      scoreMessage = { key: "truthCount", args: { actual: actual.length, horizon }, error: true };
      elements.truth.setAttribute("aria-invalid", "true");
    } else {
      scored = { actual, methods: scoreIntegerForecast(result.methods, actual) };
      scoreMessage = { key: "scored" };
    }
  } catch (error) {
    scoreMessage = errorMessage(error);
    elements.truth.setAttribute("aria-invalid", "true");
  }
  render();
}

function setLanguage() {
  translator = createTranslator(elements.language.value);
  localizeStatic(translator.language);
  render();
}

elements.language.value = translator.language;
elements.language.addEventListener("change", setLanguage);
elements.history.addEventListener("input", onHistoryChanged);
elements.historyForm.addEventListener("change", event => {
  if (event.target.name === "integer-horizon") onHistoryChanged();
});
elements.historyForm.addEventListener("submit", runForecast);
elements.truthForm.addEventListener("submit", runScore);
elements.truth.addEventListener("input", () => {
  if (!locked) return;
  scored = undefined;
  elements.truth.removeAttribute("aria-invalid");
  scoreMessage = { key: "scoreReady", args: { horizon: locked.horizon } };
  render();
});
elements.example.addEventListener("click", () => {
  elements.history.value = Array(18).fill(sampleCycle.join(", ")).join("\n");
  elements.truth.value = "";
  invalidateForecast("sample");
});
setLanguage();
