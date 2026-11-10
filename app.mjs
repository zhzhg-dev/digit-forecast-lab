import { METHODS, backtest, mostLikely, parseSequence, predict, syntheticSequence, verifiedPeriod } from "./forecast.mjs?v=0.3.0";
import { DEFAULT_LANGUAGE, LocalizedError, createStaticLocalizer, createTranslator, describeError } from "./i18n.mjs?v=0.3.0";
import { TRANSFORMER_CONTEXT_LENGTH } from "./transformer.mjs?v=0.2.0";

const MAX_TEXT_LENGTH = 100_000;
const SAMPLE_LENGTH = 420;
const DEMO_SEED = 1729;
const PERIODIC_SAMPLE_LENGTH = 64;
const APP_VERSION = "0.3.0";

const elements = {
  language: document.querySelector("#language"),
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
  exportDetailsButton: document.querySelector("#export-details-csv"),
  benchmarkResults: document.querySelector("#benchmark-results"),
  tableHead: document.querySelector("#benchmark-head"),
  tableBody: document.querySelector("#benchmark-body"),
  methodNotes: document.querySelector("#method-notes"),
};

const localizeStatic = createStaticLocalizer(document, [
  elements.count, elements.resultStatus, elements.testStatus,
]);
const messages = new Map();
let translator = createTranslator(DEFAULT_LANGUAGE);
let currentForecast;
let currentBenchmark;
let displayedLength;
let selectedStep = 0;
let inputRevision = 0;

function element(tagName, text, className) {
  const node = document.createElement(tagName);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderMessage(node, { key, args, isError }) {
  const text = translator.text(key, args);
  if (node.textContent !== text) node.textContent = text;
  node.classList.toggle("error", isError);
}

function setMessage(node, key, args, isError = false) {
  const message = { key, args, isError };
  messages.set(node, message);
  renderMessage(node, message);
}

function showError(node, error, fallback) {
  const { key, args } = describeError(error, fallback);
  setMessage(node, key, args, true);
}

function percentage(value) {
  return value === null ? "—" : translator.percent(value);
}

function readHistory(text) {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new LocalizedError("textTooLong");
  }
  const history = parseSequence(text);
  if (history.length === 0) throw new LocalizedError("enterDigits");
  return history;
}

function renderCount() {
  elements.count.textContent = displayedLength === undefined
    ? translator.text("digitLimit")
    : translator.text("digitCount", { count: displayedLength });
}

function showCount(length) {
  displayedLength = length;
  renderCount();
}

function preferredDigit(probabilities) {
  const maximum = Math.max(...probabilities);
  const candidates = probabilities.flatMap((probability, digit) =>
    Math.abs(probability - maximum) < 1e-12 ? [digit] : [],
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function contextLength(methodId, length) {
  if (methodId === "uniform") return 0;
  return methodId === "transformer" ? Math.min(length, TRANSFORMER_CONTEXT_LENGTH) : length;
}

function renderDistribution() {
  const distribution = currentForecast?.predictions[elements.method.value][selectedStep];
  elements.chartTitle.hidden = !distribution;
  if (!distribution) {
    elements.probabilities.replaceChildren();
    return;
  }

  const topDigit = preferredDigit(distribution);
  elements.chartTitle.textContent = translator.text("positionProbabilities", { step: selectedStep + 1 });
  elements.probabilities.replaceChildren(...distribution.map((probability, digit) => {
    const row = element("div", undefined, "probability-row");
    row.setAttribute("role", "listitem");
    const displayedProbability = percentage(probability);
    row.setAttribute("aria-label", translator.text("digitProbability", { digit, probability: displayedProbability }));
    row.classList.toggle("is-top", digit === topDigit);
    const bar = element("progress", undefined, "probability-bar");
    bar.max = 1;
    bar.value = probability;
    bar.setAttribute("aria-hidden", "true");
    row.append(element("span", String(digit)), bar, element("span", displayedProbability, "probability-value"));
    return row;
  }));
}

function renderForecast() {
  if (!currentForecast) {
    elements.steps.replaceChildren();
    renderDistribution();
    return;
  }
  const { length, predictions, period } = currentForecast;
  const methodId = elements.method.value;
  if (methodId === "uniform") {
    setMessage(elements.resultStatus, "uniformUsing");
  } else if (methodId === "transformer") {
    setMessage(elements.resultStatus, "transformerUsing", { count: length, context: contextLength(methodId, length) });
  } else if (methodId === "periodic") {
    const key = period === null ? "periodicFallback" : "periodicUsing";
    setMessage(elements.resultStatus, key, { count: length, period });
  } else {
    setMessage(elements.resultStatus, "forecastUsing", { methodId, count: length });
  }
  elements.steps.replaceChildren(...predictions[methodId].map((distribution, step) => {
    const digit = preferredDigit(distribution);
    const button = element("button", undefined, "step");
    button.type = "button";
    button.setAttribute("aria-pressed", String(step === selectedStep));
    button.setAttribute("aria-label", translator.text(digit === null ? "stepTied" : "stepGuess", { step: step + 1, digit }));
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

function clearForecast(key) {
  currentForecast = undefined;
  renderForecast();
  setMessage(elements.resultStatus, key);
}

function clearBenchmark(key) {
  currentBenchmark = undefined;
  elements.benchmarkResults.hidden = true;
  elements.exportButton.disabled = true;
  elements.exportDetailsButton.disabled = true;
  setMessage(elements.testStatus, key);
}

function refreshInput() {
  inputRevision += 1;
  elements.input.removeAttribute("aria-invalid");
  showCount();
  setMessage(elements.inputStatus, "empty");
  clearForecast("inputChanged");
  clearBenchmark("benchmarkReady");
}

function runForecast() {
  try {
    const history = readHistory(elements.input.value);
    const horizon = Number(new FormData(elements.forecastForm).get("horizon"));
    currentForecast = { length: history.length, predictions: predict(history, horizon), period: verifiedPeriod(history) };
    selectedStep = 0;
    elements.input.removeAttribute("aria-invalid");
    setMessage(elements.inputStatus, "empty");
    showCount(history.length);
    renderForecast();
  } catch (error) {
    clearForecast("fixInput");
    elements.input.setAttribute("aria-invalid", "true");
    showError(elements.inputStatus, error);
  }
}

function loadSample() {
  try {
    const kind = elements.sample.value;
    if (kind === "periodic") {
      const cycle = syntheticSequence("uniform", PERIODIC_SAMPLE_LENGTH, DEMO_SEED);
      elements.input.value = Array.from({ length: SAMPLE_LENGTH }, (_, index) => cycle[index % cycle.length]).join("");
    } else {
      elements.input.value = syntheticSequence(kind, SAMPLE_LENGTH, DEMO_SEED).join("");
    }
  } catch (error) {
    showError(elements.inputStatus, error, "sampleFailed");
    return;
  }
  refreshInput();
  runForecast();
  setMessage(elements.inputStatus, "sampleLoaded", { count: SAMPLE_LENGTH });
}

function renderBenchmark(result) {
  const heading = element("tr");
  const headers = [translator.text("methodHeader"), ...Array.from({ length: result.horizon }, (_, step) => (
    translator.text("stepHeader", { step: step + 1 })
  ))];
  if (result.horizon > 1) headers.push(translator.text("fullMatch"));
  for (const label of headers) {
    const cell = element("th", label);
    cell.scope = "col";
    heading.append(cell);
  }
  elements.tableHead.replaceChildren(heading);
  const frequencySteps = result.results.find(({ id }) => id === "frequency").steps;
  elements.tableBody.replaceChildren(...result.results.map((method) => {
    const row = element("tr");
    const name = element("th", translator.method(method.id).label);
    name.scope = "row";
    row.append(name);
    for (const [index, step] of method.steps.entries()) {
      const cell = element("td");
      const loss = step.logLoss === null ? "—" : translator.decimal(step.logLoss);
      cell.append(element("span", percentage(step.accuracy)), element("span", translator.text("lossValue", { loss }), "loss-value"));
      if (step.accuracy !== null && frequencySteps[index].accuracy !== null) {
        const difference = translator.percentagePoints(step.accuracy - frequencySteps[index].accuracy);
        cell.append(element("span", translator.text("accuracyDifference", { difference }), "delta-value"));
      }
      row.append(cell);
    }
    if (result.horizon > 1) row.append(element("td", percentage(method.fullMatchRate)));
    return row;
  }));
  elements.benchmarkResults.hidden = false;
  elements.exportButton.disabled = false;
  elements.exportDetailsButton.disabled = !result.details?.length;
}

function runBacktest() {
  clearBenchmark("empty");
  try {
    const sequence = readHistory(elements.input.value);
    const historyLength = elements.historyLength.valueAsNumber;
    const horizon = Number(elements.testHorizon.value);
    const result = backtest(sequence, historyLength, horizon, { includeDetails: true });
    showCount(sequence.length);
    if (result.origins === 0) {
      setMessage(elements.testStatus, "missingDigits", { count: historyLength + horizon }, true);
      return;
    }
    currentBenchmark = result;
    renderBenchmark(result);
    setMessage(elements.testStatus, "benchmarkComplete", { origins: result.origins, count: result.historyLength });
  } catch (error) {
    showError(elements.testStatus, error);
  }
}

function csvCell(value) {
  return '"' + String(value ?? "").replaceAll('"', '""') + '"';
}

function downloadCsv(rows, filename) {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = element("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportBenchmark() {
  if (!currentBenchmark) return;
  const { historyLength, horizon, origins, results } = currentBenchmark;
  const headerKeys = ["methodHeader", "csvHistoryLength", "csvHorizon", "csvWindows", "csvPosition", "csvAccuracy", "csvLogLoss", "csvFullMatch"];
  const rows = [headerKeys.map(key => translator.text(key))];
  for (const method of results) {
    for (const [index, step] of method.steps.entries()) {
      rows.push([translator.method(method.id).label, historyLength, horizon, origins, index + 1, step.accuracy, step.logLoss, method.fullMatchRate]);
    }
  }
  downloadCsv(rows, "digit-forecast-backtest.csv");
}

function exportBenchmarkDetails() {
  if (!currentBenchmark?.details?.length) return;
  const { historyLength, horizon, details } = currentBenchmark;
  const headerKeys = [
    "csvMethodId", "methodHeader", "csvAppVersion", "csvHistoryLength", "csvContextLength", "csvHorizon",
    "csvHistoryStart", "csvOrigin", "csvTargetIndex", "csvHorizonStep", "csvPrediction", "csvActual",
  ];
  const probabilities = Array.from({ length: 10 }, (_, digit) => translator.text("csvProbability", { digit }));
  const rows = [[...headerKeys.map(key => translator.text(key)), ...probabilities]];
  for (const { start, origin, truth, forecasts } of details) {
    for (const { id } of METHODS) {
      const { label } = translator.method(id);
      const usedContext = contextLength(id, historyLength);
      for (const [step, actual] of truth.entries()) {
        const distribution = forecasts[id][step];
        rows.push([
          id, label, APP_VERSION, historyLength, usedContext, horizon, start, origin, origin + step, step + 1,
          mostLikely(distribution), actual, ...distribution,
        ]);
      }
    }
  }
  downloadCsv(rows, "digit-forecast-backtest-details.csv");
}

function renderMethods() {
  const selected = elements.method.value || "markov";
  const options = [];
  const notes = [];
  for (const { id } of METHODS) {
    const { label, description } = translator.method(id);
    const option = element("option", label);
    option.value = id;
    options.push(option);
    const note = element("div");
    note.append(element("dt", label), element("dd", description));
    notes.push(note);
  }
  elements.method.replaceChildren(...options);
  elements.method.value = selected;
  elements.methodNotes.replaceChildren(...notes);
}

function updateLanguage(language) {
  translator = createTranslator(language);
  elements.language.value = translator.language;
  localizeStatic(translator.language);
  renderMethods();
  renderCount();
  renderForecast();
  if (currentBenchmark) renderBenchmark(currentBenchmark);
  for (const [node, message] of messages) renderMessage(node, message);
}

elements.language.addEventListener("change", () => updateLanguage(elements.language.value));
elements.input.addEventListener("input", refreshInput);
elements.file.addEventListener("change", async () => {
  const [file] = elements.file.files;
  elements.file.value = "";
  if (!file) return;
  const revision = inputRevision;
  try {
    if (file.size > 400_000) throw new LocalizedError("fileTooLarge");
    const text = await file.text();
    if (revision !== inputRevision) return;
    readHistory(text);
    elements.input.value = text;
    refreshInput();
    runForecast();
    setMessage(elements.inputStatus, "imported");
  } catch (error) {
    if (revision === inputRevision) showError(elements.inputStatus, error, "importFailed");
  }
});
document.querySelector("#load-sample").addEventListener("click", loadSample);
elements.forecastForm.addEventListener("change", (event) => {
  if (event.target.name === "horizon") clearForecast("horizonChanged");
});
elements.forecastForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runForecast();
});
elements.method.addEventListener("change", renderForecast);
elements.testForm.noValidate = true;
elements.testForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runBacktest();
});
for (const control of [elements.historyLength, elements.testHorizon]) {
  control.addEventListener("input", () => clearBenchmark("settingsChanged"));
}
elements.exportButton.addEventListener("click", exportBenchmark);
elements.exportDetailsButton.addEventListener("click", exportBenchmarkDetails);
updateLanguage(DEFAULT_LANGUAGE);
loadSample();
