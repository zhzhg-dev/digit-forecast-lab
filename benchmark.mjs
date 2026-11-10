import { createStaticLocalizer, createTranslator } from './i18n.mjs?v=0.2.0';

const localizeStatic = createStaticLocalizer(document);
const language = document.querySelector('#language');
const dataset = document.querySelector('#dataset');
const history = document.querySelector('#history');
const position = document.querySelector('#position');
const status = document.querySelector('#report-status');
const reference = document.querySelector('#report-reference');
const table = document.querySelector('#report-table');
const results = document.querySelector('#report-results');
const datasets = {
  uniform: ['Independent uniform', '独立均匀'],
  biased: ['Independent biased', '独立有偏'],
  short: ['Depends on the previous digit', '依赖上一位'],
  long: ['Depends on the digit five places back', '依赖五位之前'],
  lag8: ['Holdout: depends on the digit eight places back', '留出机制：依赖八位之前'],
};

let translator = createTranslator(new URLSearchParams(location.search).get('lang'));
let rows;
let loadFailed = false;

function setLanguage() {
  translator = createTranslator(language.value);
  localizeStatic(translator.language);
  const translated = translator.language === 'zh' ? 1 : 0;
  for (const option of dataset.options) option.textContent = datasets[option.value][translated];
  renderReport();
}

function renderReport() {
  const chinese = translator.language === 'zh';
  const selected = rows?.filter(row => row.datasetId === dataset.value &&
    row.historyLength === Number(history.value) && row.step === Number(position.value));
  status.classList.toggle('error', loadFailed);
  table.hidden = !selected?.length;
  reference.textContent = '';
  if (!selected?.length) {
    status.textContent = loadFailed
      ? (chinese ? '无法载入基准数据，请刷新重试。' : 'Could not load benchmark data. Refresh to try again.')
      : (chinese ? '正在载入基准数据。' : 'Loading benchmark data.');
    return;
  }

  const formatAccuracy = new Intl.NumberFormat(translator.documentLanguage, { style: 'percent', maximumFractionDigits: 2 });
  const formatPoints = new Intl.NumberFormat(translator.documentLanguage, { maximumFractionDigits: 2, signDisplay: 'exceptZero' });
  const points = value => formatPoints.format(value * 100);
  const first = selected[0];
  const sampleCount = translator.integer(first.streams);
  status.textContent = chinese ? `${sampleCount} 条独立合成序列` : `${sampleCount} independent synthetic sequences`;
  const accuracy = formatAccuracy.format(first.oracleAccuracy);
  const loss = translator.decimal(first.oracleLogLoss);
  reference.textContent = chinese
    ? `已知生成规则时的理论最优参考：命中率 ${accuracy}，期望对数损失 ${loss}。`
    : `Theoretical reference with the generating rule known: ${accuracy} accuracy and ${loss} expected log loss.`;

  results.replaceChildren(...selected.map(row => {
    const item = document.createElement('tr');
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = translator.method(row.method).label;
    item.append(name);
    const [lower, upper] = row.advantageInterval;
    for (const value of [formatAccuracy.format(row.accuracy), translator.decimal(row.logLoss), points(row.advantage),
      `${points(lower)} ${chinese ? '至' : 'to'} ${points(upper)}`]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      item.append(cell);
    }
    return item;
  }));
}

for (const id of Object.keys(datasets)) {
  const option = document.createElement('option');
  option.value = id;
  dataset.append(option);
}
language.value = translator.language;
language.addEventListener('change', setLanguage);
for (const filter of [dataset, history, position]) filter.addEventListener('change', renderReport);
setLanguage();

try {
  const response = await fetch('./benchmark-results.json?v=0.2.0');
  if (!response.ok) throw new Error(`Benchmark request failed (${response.status})`);
  rows = await response.json();
} catch {
  loadFailed = true;
}
renderReport();
