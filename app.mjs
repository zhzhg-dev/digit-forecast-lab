import { METHODS, backtest, parseSequence, predict, syntheticSequence } from "./forecast.mjs";

const MAX_TEXT_LENGTH = 100_000;
const SAMPLE_LENGTH = 420;
const DEMO_SEED = 1729;
const integerFormat = new Intl.NumberFormat("zh-CN");
const percentFormat = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });

const elements = {
  input: document.querySelector("#sequence"),
  inputStatus: document.querySelector("#input-status"),
  count: document.querySelector("#sequence-count"),
  file: document.querySelector("#import-file"),
  sample: document.querySelector("#sample"),
  forecastForm: document.querySelector("#forecast-form"),
  resultStatus: document.querySelector("#result-status"),
  method: document.querySelector("#method"),
  steps: document.querySelector("#steps"),
  chartTitle: document.querySelector("#chart-title"),
  probabilities: document.querySelector("#probabilities"),
  testForm: document.querySelector("#backtest-form"),
  historyLength: document.querySelector("#history-length"),
  testHorizon: document.querySelector("#test-horizon"),
  testStatus: document.querySelector("#backtest-status"),
  exportButton: document.querySelector("#export-csv"),
  benchmarkResults: document.querySelector("#benchmark-results"),
  tableHead: document.querySelector("#benchmark-head"),
  tableBody: document.querySelector("#benchmark-body"),
  methodNotes: document.querySelector("#method-notes"),
};

const methodsById = new Map(METHODS.map((method) => [method.id, method]));
let currentForecast;
let currentBenchmark;
let selectedStep = 0;
let inputRevision = 0;

function element(tagName, text, className) {
  const node = document.createElement(tagName);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function setMessage(node, message, isError = false) {
  node.textContent = message;
  node.classList.toggle("error", isError);
}

function percentage(value) {
  return value === null ? "—" : percentFormat.format(value);
}

function readHistory(text) {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error("文本太长。请减少分隔符，或分成更短的序列。");
  }
  const history = parseSequence(text);
  if (history.length === 0) throw new Error("请至少输入一个 0–9 的数字。");
  return history;
}

function showCount(length) {
  elements.count.textContent = length === undefined ? "最多 20,000 位" : integerFormat.format(length) + " 位";
}

function preferredDigit(probabilities) {
  const maximum = Math.max(...probabilities);
  const candidates = probabilities.flatMap((probability, digit) =>
    Math.abs(probability - maximum) < 1e-12 ? [digit] : [],
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function renderDistribution() {
  const distribution = currentForecast?.predictions[elements.method.value][selectedStep];
  elements.chartTitle.hidden = !distribution;
  if (!distribution) {
    elements.probabilities.replaceChildren();
    return;
  }

  const topDigit = preferredDigit(distribution);
  elements.chartTitle.textContent = "第 " + (selectedStep + 1) + " 位各数字的概率";
  elements.probabilities.replaceChildren(...distribution.map((probability, digit) => {
    const row = element("div", undefined, "probability-row");
    row.setAttribute("role", "listitem");
    row.classList.toggle("is-top", digit === topDigit);
    const bar = element("progress", undefined, "probability-bar");
    bar.max = 1;
    bar.value = probability;
    bar.setAttribute("aria-hidden", "true");
    row.append(element("span", String(digit)), bar, element("span", percentage(probability), "probability-value"));
    return row;
  }));
}

function renderForecast() {
  if (!currentForecast) {
    elements.steps.replaceChildren();
    renderDistribution();
    return;
  }
  const { length, predictions } = currentForecast;
  const method = methodsById.get(elements.method.value);
  elements.resultStatus.textContent = method.label + "使用 " + integerFormat.format(length) + " 位历史。";
  elements.steps.replaceChildren(...predictions[method.id].map((distribution, step) => {
    const digit = preferredDigit(distribution);
    const button = element("button", undefined, "step");
    button.type = "button";
    button.setAttribute("aria-pressed", String(step === selectedStep));
    button.setAttribute("aria-label", "第 " + (step + 1) + " 位，" + (digit === null ? "最高概率并列" : "预测 " + digit));
    button.append(element("span", "+" + (step + 1)), element("strong", digit === null ? "—" : String(digit)));
    button.addEventListener("click", () => {
      selectedStep = step;
      Array.from(elements.steps.children).forEach((child, index) => {
        child.setAttribute("aria-pressed", String(index === step));
      });
      renderDistribution();
    });
    return button;
  }));
  renderDistribution();
}

function clearForecast(message) {
  currentForecast = undefined;
  renderForecast();
  elements.resultStatus.textContent = message;
}

function clearBenchmark(message) {
  currentBenchmark = undefined;
  elements.benchmarkResults.hidden = true;
  elements.exportButton.disabled = true;
  setMessage(elements.testStatus, message);
}

function refreshInput() {
  inputRevision += 1;
  elements.input.removeAttribute("aria-invalid");
  showCount();
  setMessage(elements.inputStatus, "");
  clearForecast("序列有变动。重新计算后可查看预测。");
  clearBenchmark("当前序列可以用于下一次盲测。");
}

function runForecast() {
  try {
    const history = readHistory(elements.input.value);
    const horizon = Number(new FormData(elements.forecastForm).get("horizon"));
    currentForecast = { length: history.length, predictions: predict(history, horizon) };
    selectedStep = 0;
    elements.input.removeAttribute("aria-invalid");
    setMessage(elements.inputStatus, "");
    showCount(history.length);
    renderForecast();
  } catch (error) {
    clearForecast("修正输入后可以重新计算。");
    elements.input.setAttribute("aria-invalid", "true");
    setMessage(elements.inputStatus, error.message, true);
  }
}

function loadSample() {
  elements.input.value = syntheticSequence(elements.sample.value, SAMPLE_LENGTH, DEMO_SEED).join("");
  refreshInput();
  runForecast();
  setMessage(elements.inputStatus, "已载入 " + SAMPLE_LENGTH + " 位合成数字。");
}

function renderBenchmark(result) {
  const heading = element("tr");
  const headers = ["方法", ...Array.from({ length: result.horizon }, (_, step) => "第 " + (step + 1) + " 位")];
  if (result.horizon > 1) headers.push("整段全中");
  for (const label of headers) {
    const cell = element("th", label);
    cell.scope = "col";
    heading.append(cell);
  }
  elements.tableHead.replaceChildren(heading);
  elements.tableBody.replaceChildren(...result.results.map((method) => {
    const row = element("tr");
    const name = element("th", methodsById.get(method.id).label);
    name.scope = "row";
    row.append(name);
    for (const step of method.steps) {
      const cell = element("td");
      const logLoss = step.logLoss === null ? "—" : step.logLoss.toFixed(3);
      cell.append(element("span", percentage(step.accuracy)), element("span", "损失 " + logLoss, "loss-value"));
      row.append(cell);
    }
    if (result.horizon > 1) row.append(element("td", percentage(method.fullMatchRate)));
    return row;
  }));
  elements.benchmarkResults.hidden = false;
  elements.exportButton.disabled = false;
}

function runBacktest() {
  clearBenchmark("");
  try {
    const sequence = readHistory(elements.input.value);
    const historyLength = elements.historyLength.valueAsNumber;
    const horizon = Number(elements.testHorizon.value);
    const result = backtest(sequence, historyLength, horizon);
    showCount(sequence.length);
    if (result.origins === 0) {
      setMessage(elements.testStatus, "数字不够。请至少提供 " + (historyLength + horizon) + " 位，或缩短历史长度。", true);
      return;
    }
    currentBenchmark = result;
    renderBenchmark(result);
    setMessage(elements.testStatus, "已测试 " + integerFormat.format(result.origins) + " 个不重叠的预测区间，每次使用 " +
      integerFormat.format(result.historyLength) + " 位历史。概率并列时用较小数字计命中。");
  } catch (error) {
    setMessage(elements.testStatus, error.message, true);
  }
}

function csvCell(value) {
  return '"' + String(value ?? "").replaceAll('"', '""') + '"';
}

function exportBenchmark() {
  if (!currentBenchmark) return;
  const { historyLength, horizon, origins, results } = currentBenchmark;
  const rows = [["方法", "历史长度", "预测范围", "测试区间数", "预测位置", "命中率", "对数损失", "整段全中率"]];
  for (const method of results) {
    for (const [index, step] of method.steps.entries()) {
      rows.push([methodsById.get(method.id).label, historyLength, horizon, origins, index + 1, step.accuracy, step.logLoss, method.fullMatchRate]);
    }
  }
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = element("a");
  link.href = url;
  link.download = "digit-forecast-backtest.csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const method of METHODS) {
  const option = element("option", method.label);
  option.value = method.id;
  elements.method.append(option);
  const note = element("div");
  note.append(element("dt", method.label), element("dd", method.description));
  elements.methodNotes.append(note);
}
elements.method.value = "markov";

elements.input.addEventListener("input", refreshInput);
elements.file.addEventListener("change", async () => {
  const [file] = elements.file.files;
  elements.file.value = "";
  if (!file) return;
  const revision = inputRevision;
  try {
    if (file.size > 400_000) throw new Error("文件过大。请把数字拆成较短的文本。");
    const text = await file.text();
    if (revision !== inputRevision) return;
    readHistory(text);
    elements.input.value = text;
    refreshInput();
    runForecast();
    setMessage(elements.inputStatus, "已导入文本。");
  } catch (error) {
    if (revision === inputRevision) setMessage(elements.inputStatus, error.message, true);
  }
});
document.querySelector("#load-sample").addEventListener("click", loadSample);
elements.forecastForm.addEventListener("change", (event) => {
  if (event.target.name === "horizon") clearForecast("预测范围已改变。请重新计算。");
});
elements.forecastForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runForecast();
});
elements.method.addEventListener("change", renderForecast);
elements.testForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runBacktest();
});
for (const control of [elements.historyLength, elements.testHorizon]) {
  control.addEventListener("input", () => clearBenchmark("测试设置已改变。请重新运行盲测。"));
}
elements.exportButton.addEventListener("click", exportBenchmark);
loadSample();
