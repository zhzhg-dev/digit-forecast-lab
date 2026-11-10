import { createStaticLocalizer, createTranslator } from './i18n.mjs?v=0.3.0';

const localizeStatic = createStaticLocalizer(document);
const language = document.querySelector('#language');
const dataset = document.querySelector('#precision-dataset');
const history = document.querySelector('#precision-history');
const status = document.querySelector('#precision-status');
const condition = document.querySelector('#precision-condition');
const table = document.querySelector('#precision-table');
const results = document.querySelector('#precision-results');
const oracle = document.querySelector('#precision-oracle');
const datasets = {
  period8: ['Exact 8-digit cycle', '精确重复 8 位'],
  period64: ['Exact 64-digit cycle', '精确重复 64 位'],
  period257: ['Exact 257-digit cycle', '精确重复 257 位'],
  uniform: ['Independent uniform control', '独立均匀对照'],
  noisy: ['Noisy copy control', '带噪声的复制对照'],
};

let translator = createTranslator(new URLSearchParams(location.search).get('lang'));
let report;
let loadFailed = false;

function populateHistories() {
  if (!report) return;
  const lengths = [...new Set(report.rows.filter(row => row.datasetId === dataset.value).map(row => row.historyLength))]
    .sort((left, right) => left - right);
  const previous = Number(history.value);
  history.replaceChildren(...lengths.map(length => new Option(translator.integer(length), String(length))));
  if (lengths.includes(previous)) {
    history.value = String(previous);
  } else {
    const first = report.rows.find(row => row.datasetId === dataset.value);
    const preferred = first?.period === null ? 512 : first?.period * 3;
    history.value = String(lengths.includes(preferred) ? preferred : lengths.at(-1));
  }
}

function setLanguage() {
  translator = createTranslator(language.value);
  localizeStatic(translator.language);
  const translated = translator.language === 'zh' ? 1 : 0;
  for (const option of dataset.options) option.textContent = datasets[option.value][translated];
  populateHistories();
  renderReport();
}

function renderReport() {
  const chinese = translator.language === 'zh';
  const selected = report?.rows.filter(row => row.datasetId === dataset.value && row.historyLength === Number(history.value));
  status.classList.toggle('error', loadFailed);
  table.hidden = !selected?.length;
  condition.textContent = '';
  oracle.textContent = '';
  if (!selected?.length) {
    status.textContent = loadFailed
      ? (chinese ? '无法载入精度结果，请刷新重试。' : 'Could not load accuracy results. Refresh to try again.')
      : (chinese ? '正在载入精度结果。' : 'Loading accuracy results.');
    return;
  }

  const percent = new Intl.NumberFormat(translator.documentLanguage, { style: 'percent', maximumFractionDigits: 3 }).format;
  const first = selected[0];
  const sampleCount = translator.integer(first.streams);
  status.textContent = chinese ? `${sampleCount} 条独立初始化的合成序列` : `${sampleCount} independently initialized synthetic sequences`;
  const periodic = selected.find(row => row.method === 'periodic');
  const acceptance = percent(periodic.detectorAcceptanceRate);
  const interval = periodic.blockInterval.map(percent);
  const range = chinese ? `${interval[0]} 至 ${interval[1]}` : `${interval[0]} to ${interval[1]}`;
  condition.textContent = chinese
    ? `周期验证通过率 ${acceptance}。周期续写五位全中率的 95% Wilson 区间为 ${range}。`
    : `Cycle verification passed on ${acceptance} of sequences. The 95% Wilson interval for all-five accuracy is ${range}.`;
  const next = percent(first.oracleNextAccuracy);
  const fifth = percent(first.oracleFifthAccuracy);
  const block = percent(first.oracleBlockAccuracy);
  oracle.textContent = chinese
    ? `已知合成规则时的理论参考：下一位 ${next}，第 5 位 ${fifth}，五位全中 ${block}。`
    : `Theoretical reference with the synthetic rule known: ${next} next digit, ${fifth} position +5, ${block} all five.`;

  results.replaceChildren(...selected.map(row => {
    const item = document.createElement('tr');
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = translator.method(row.method).label;
    item.append(name);
    const minimum = report.thresholds.find(entry => entry.datasetId === row.datasetId && entry.method === row.method)?.blockMinHistory;
    const minimumLabel = minimum == null ? (chinese ? '网格内未达到' : 'Not reached on grid') : translator.integer(minimum);
    for (const value of [percent(row.nextAccuracy), percent(row.fifthAccuracy), percent(row.blockAccuracy),
      translator.decimal(row.meanLogLoss), minimumLabel]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      item.append(cell);
    }
    return item;
  }));
}

for (const id of Object.keys(datasets)) dataset.append(new Option('', id));
dataset.value = 'period257';
language.value = translator.language;
language.addEventListener('change', setLanguage);
dataset.addEventListener('change', () => {
  populateHistories();
  renderReport();
});
history.addEventListener('change', renderReport);
setLanguage();

try {
  const response = await fetch('./high-precision-results.json?v=0.3.0');
  if (!response.ok) throw new Error(`Accuracy report request failed (${response.status})`);
  report = await response.json();
} catch {
  loadFailed = true;
}
populateHistories();
renderReport();
