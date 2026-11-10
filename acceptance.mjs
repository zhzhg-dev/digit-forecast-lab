import { createStaticLocalizer, createTranslator } from './i18n.mjs?v=0.4.0';

const language = document.querySelector('#language');
const status = document.querySelector('#acceptance-status');
const results = document.querySelector('#acceptance-results');
const localizeStatic = createStaticLocalizer(document);
const cases = {
  all: ['All cases', '全部测试条件'],
  locked: ['Locked forecast with changed truth', '改变真值，检查预测是否锁定'],
  uniform: ['Independent uniform', '独立均匀'],
  biased: ['Independent biased', '独立有偏'],
  lag1: ['Noisy one-position copy', '带噪声的一位复制'],
  'markov-cycle': ['Exact next-digit mapping', '确定性数字转移'],
  lag8: ['Noisy eight-position copy', '带噪声的八位复制'],
  'mtd-cycle': ['Exact eight-digit cycle', '精确八位周期'],
  period8: ['Exact eight-digit cycle', '精确八位周期'],
  period64: ['Exact 64-digit cycle', '精确 64 位周期'],
  period257: ['Exact 257-digit cycle', '精确 257 位周期'],
  'transformer-cycle': ['Exact five-digit cycle', '精确五位周期'],
  lag5: ['Noisy five-position copy', '带噪声的五位复制'],
  'transformer-lag8': ['Noisy eight-position copy (held-out lag)', '带噪声的八位复制（留出滞后）'],
};
const metrics = {
  validForecastCount: ['Valid probability forecasts', '有效概率预测数'],
  fixedForecastCount: ['Forecasts fixed before truth', '揭晓前锁定的预测数'],
  uniformForecastRate: ['Share of uniform probability forecasts', '均匀概率预测比例'],
  nextAccuracyGap: ['Next-digit accuracy gap vs. reference', '下一位命中率落后于参照'],
  fifthAccuracyGap: ['Position +5 accuracy gap vs. reference', '第 5 位命中率落后于参照'],
  meanLogLossExcess: ['Mean log loss above reference', '平均对数损失超出参照'],
  blockAccuracy: ['All five correct', '五位全中率'],
  detectorAcceptanceRate: ['Cycle verification pass rate', '周期验证通过率'],
  correctPeriodRate: ['Correct period rate', '周期识别正确率'],
};

let translator = createTranslator(new URLSearchParams(location.search).get('lang'));
let report;
let loadFailed = false;

function localized(labels) {
  return labels[translator.language === 'zh' ? 1 : 0];
}

function resultLabel(pass) {
  return pass ? localized(['Pass', '通过']) : localized(['Fail', '未通过']);
}

function caseLabel(caseId, fallback) {
  return cases[caseId] ? localized(cases[caseId]) : fallback;
}

function metricValue(metric, value) {
  if (value == null) return '—';
  if (metric.endsWith('Count')) return translator.integer(value);
  if (metric === 'meanLogLossExcess') return translator.decimal(value);
  if (metric.endsWith('Gap')) {
    const points = new Intl.NumberFormat(translator.documentLanguage, { maximumFractionDigits: 2 }).format(value * 100);
    return `${points}${localized([' pp', ' 个百分点'])}`;
  }
  return translator.percent(value);
}

function scoreTable(captionText, headings, rows) {
  const region = document.createElement('div');
  region.className = 'table-scroll';
  region.tabIndex = 0;
  region.setAttribute('role', 'region');
  region.setAttribute('aria-label', captionText);
  const table = document.createElement('table');
  table.createCaption().textContent = captionText;
  const header = table.createTHead().insertRow();
  for (const text of headings) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = text;
    header.append(cell);
  }
  const body = table.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) row.insertCell().textContent = value;
  }
  region.append(table);
  return region;
}

function renderMethod(method, openMethods) {
  const item = document.createElement('details');
  item.className = 'panel';
  item.dataset.method = method.id;
  item.open = openMethods.has(method.id) || !method.pass;
  const summary = document.createElement('summary');
  summary.append(translator.method(method.id).label);
  const badge = document.createElement('span');
  badge.className = 'method-status';
  badge.classList.toggle('error', !method.pass);
  badge.textContent = resultLabel(method.pass);
  summary.append(' ', badge);
  item.append(summary);

  if (method.scores.length) {
    const accuracy = new Intl.NumberFormat(translator.documentLanguage, { style: 'percent', maximumFractionDigits: 2 }).format;
    const percentage = value => value == null ? '—' : accuracy(value);
    const pair = (actual, reference) => `${percentage(actual)} / ${percentage(reference)}`;
    const scoreRows = method.scores.map(row => [
      caseLabel(row.caseId, row.caseLabel), translator.integer(row.historyLength), translator.integer(row.streams),
      pair(row.nextAccuracy, row.oracleNextAccuracy), pair(row.fifthAccuracy, row.oracleFifthAccuracy),
      pair(row.blockAccuracy, row.oracleBlockAccuracy),
    ]);
    item.append(scoreTable(localized(['Accuracy / rule-aware reference', '命中率 / 已知规则参照']), [
      localized(['Case', '测试条件']), localized(['History (digits)', '历史（位）']), localized(['Sequences', '序列数']),
      localized(['Next digit', '下一位']), localized(['Position +5', '第 5 位']), localized(['All five', '五位全中']),
    ], scoreRows));
  }

  const checkRows = method.checks.map(check => [
    caseLabel(check.caseId, check.caseId), localized(metrics[check.metric]), metricValue(check.metric, check.actual),
    `${check.operator === '===' ? '=' : '≤'} ${metricValue(check.metric, check.bound)}`, resultLabel(check.pass),
  ]);
  item.append(scoreTable(localized(['Acceptance gates', '逐项验收门槛']), [
    localized(['Case', '测试条件']), localized(['Metric', '指标']), localized(['Observed', '实测']),
    localized(['Gate', '门槛']), localized(['Result', '结果']),
  ], checkRows));
  return item;
}

function renderReport() {
  status.classList.toggle('error', loadFailed || report?.pass === false);
  if (!report) {
    status.textContent = loadFailed
      ? localized(['Could not load the acceptance results. Refresh to try again.', '无法载入验收结果，请刷新重试。'])
      : localized(['Loading acceptance results.', '正在载入验收结果。']);
    return;
  }
  if (report.error) {
    status.textContent = localized(['The acceptance run did not finish. Download the results for diagnostic details.', '验收运行未完成，诊断信息可在结果文件中查看。']);
    results.replaceChildren();
    return;
  }

  const passing = report.methods.filter(method => method.pass).length;
  const total = report.methods.length;
  const checks = report.methods.flatMap(method => method.checks).length;
  status.textContent = localized([`${passing}/${total} methods passed across ${checks} checks.`, `${passing}/${total} 种方法通过，共 ${checks} 项检查。`]);
  const openMethods = new Set([...results.querySelectorAll('details[open]')].map(item => item.dataset.method));
  results.replaceChildren(...report.methods.map(method => renderMethod(method, openMethods)));
}

function setLanguage() {
  translator = createTranslator(language.value);
  localizeStatic(translator.language);
  renderReport();
}

language.value = translator.language;
language.addEventListener('change', setLanguage);
setLanguage();

try {
  const response = await fetch('./acceptance-results.json?v=0.4.0');
  if (!response.ok) throw new Error(`Acceptance request failed (${response.status})`);
  report = await response.json();
} catch {
  loadFailed = true;
}
renderReport();
