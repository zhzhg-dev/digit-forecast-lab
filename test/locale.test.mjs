import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { METHODS, parseSequence } from '../forecast.mjs';
import { createStaticLocalizer, createTranslator, DEFAULT_LANGUAGE, describeError } from '../i18n.mjs';

const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the static page defaults to English and offers Simplified Chinese', () => {
  assert.match(page, /<html\b[^>]*\blang="en"[^>]*>/);
  const selector = page.match(/<select\b[^>]*\bid="language"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(selector, 'the page has a language selector');
  assert.match(selector[1], /<option\s+value="en"[^>]*>English<\/option>/);
  assert.match(selector[1], /<option\s+value="zh"[^>]*>简体中文<\/option>/);
  assert.doesNotMatch(selector[1], /<option\s+value="zh"[^>]*\bselected\b/);
  assert.match(page, /<label\b[^>]*\bfor="language"/);
});

test('static locale hooks cover visible copy and assistive attributes', () => {
  assert.match(page, /<h2\b(?=[^>]*\bid="forecast-title")(?=[^>]*\bdata-zh="[^"]+")[^>]*>/);
  assert.match(page, /<h2\b(?=[^>]*\bid="backtest-title")(?=[^>]*\bdata-zh="[^"]+")[^>]*>/);
  assert.match(page, /<textarea\b[^>]*\bdata-zh-placeholder="[^"]+"/);
  assert.match(page, /<nav\b[^>]*\bdata-zh-aria-label="[^"]+"/);
  assert.match(page, /<meta\b(?=[^>]*\bname="description")(?=[^>]*\bdata-zh-content="[^"]+")[^>]*>/);
});

test('switching static text to Chinese and back restores the original English attributes', () => {
  const attributes = new Map([
    ['data-zh', '预测'],
    ['placeholder', 'Enter digits'],
    ['data-zh-placeholder', '输入数字'],
    ['data-zh-aria-label', '数字序列'],
  ]);
  const node = {
    textContent: 'Forecast',
    hasAttribute: (name) => attributes.has(name),
    getAttributeNames: () => Array.from(attributes.keys()),
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  };
  const document = { documentElement: { lang: 'en' }, querySelectorAll: () => [node] };
  const localize = createStaticLocalizer(document);

  localize('zh');
  assert.equal(document.documentElement.lang, 'zh-Hans');
  assert.equal(node.textContent, '预测');
  assert.equal(attributes.get('placeholder'), '输入数字');
  assert.equal(attributes.get('aria-label'), '数字序列');

  localize('en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(node.textContent, 'Forecast');
  assert.equal(attributes.get('placeholder'), 'Enter digits');
  assert.equal(attributes.has('aria-label'), false);
});

test('unsupported locales fall back to English and counts use the selected locale', () => {
  assert.equal(DEFAULT_LANGUAGE, 'en');
  const english = createTranslator('unsupported');
  const chinese = createTranslator('zh');

  assert.equal(english.language, 'en');
  assert.equal(english.documentLanguage, 'en');
  assert.equal(chinese.language, 'zh');
  assert.match(chinese.documentLanguage, /^zh(?:-|$)/);
  assert.equal(english.text('digitCount', { count: 1 }), '1 digit');
  assert.equal(english.text('digitCount', { count: 1234 }), '1,234 digits');
  assert.equal(chinese.text('digitCount', { count: 1234 }), '1,234 位');
});

test('each forecasting method is available in both languages with the same ID', () => {
  const english = createTranslator('en');
  const chinese = createTranslator('zh');

  for (const { id } of METHODS) {
    const enMethod = english.method(id);
    const zhMethod = chinese.method(id);
    assert.equal(enMethod.id, id);
    assert.equal(zhMethod.id, id);
    for (const field of ['label', 'description']) {
      assert.match(enMethod[field], /[A-Za-z]/);
      assert.doesNotMatch(enMethod[field], /\p{Script=Han}/u);
      assert.match(zhMethod[field], /\p{Script=Han}/u);
    }
  }
});

test('input errors translate and unknown errors use the public fallback message', () => {
  const english = createTranslator('en');
  const chinese = createTranslator('zh');

  assert.throws(() => parseSequence('1x2'), (error) => {
    const { key, args } = describeError(error);
    assert.equal(key, 'invalidDigits');
    assert.match(english.text(key, args), /digit/i);
    assert.doesNotMatch(english.text(key, args), /\p{Script=Han}/u);
    assert.match(chinese.text(key, args), /\p{Script=Han}/u);
    return true;
  });
  assert.throws(() => parseSequence('0'.repeat(20_001)), (error) => {
    const { key, args } = describeError(error);
    assert.equal(key, 'tooManyDigits');
    assert.match(english.text(key, args).replaceAll(',', ''), /20000/);
    return true;
  });

  const internalError = new Error('an unexpected browser exception');
  assert.deepEqual(describeError(internalError, 'invalidDigits'), { key: 'invalidDigits' });
  const { key, args } = describeError(internalError);
  assert.equal(key, 'unexpectedError');
  assert.doesNotMatch(english.text(key, args), /an unexpected browser exception/);
  assert.match(chinese.text(key, args), /\p{Script=Han}/u);
});
