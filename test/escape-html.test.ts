/**
 * src/utils/escape-html.ts の単体テスト (phase13.1)。
 */

import { describe, expect, test } from 'vitest';
import { escapeHtml, escapeAttr } from '@/utils/escape-html.js';

describe('escapeHtml', () => {
	test('プレーンテキストは変わらない', () => {
		expect(escapeHtml('hello world')).toBe('hello world');
		expect(escapeHtml('日本語テキスト')).toBe('日本語テキスト');
	});

	test('5 文字 (& < > " \') を entity 化する', () => {
		expect(escapeHtml('&')).toBe('&amp;');
		expect(escapeHtml('<')).toBe('&lt;');
		expect(escapeHtml('>')).toBe('&gt;');
		expect(escapeHtml('"')).toBe('&quot;');
		expect(escapeHtml("'")).toBe('&#39;');
	});

	test('script タグを完全に無害化する (XSS 対策)', () => {
		const malicious = '<script>alert("XSS")</script>';
		expect(escapeHtml(malicious)).toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
	});

	test('属性ブレイク攻撃を無害化する', () => {
		// 属性値の "" を破壊して onerror を仕込む典型攻撃
		const malicious = '" onerror="alert(1)';
		expect(escapeHtml(malicious)).toBe('&quot; onerror=&quot;alert(1)');
	});

	test('img onerror インジェクションを無害化する', () => {
		const malicious = '<img src=x onerror=alert(1)>';
		expect(escapeHtml(malicious)).toBe('&lt;img src=x onerror=alert(1)&gt;');
	});

	test('& は最初に処理する (二重 escape を防ぐ)', () => {
		// & を先に escape しないと `<` → `&lt;` の `&` がさらに `&amp;lt;` になる
		expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
	});

	test('既に entity 化されている文字列も再 escape する (idempotent ではない)', () => {
		// `&amp;` は ` & a m p ;` の 5 文字とみなされ、`&` だけが再 escape される
		expect(escapeHtml('&amp;')).toBe('&amp;amp;');
	});

	test('空文字列はそのまま', () => {
		expect(escapeHtml('')).toBe('');
	});

	test('混在文字列', () => {
		const input = `<a href="javascript:alert('X')">click</a>`;
		const expected = `&lt;a href=&quot;javascript:alert(&#39;X&#39;)&quot;&gt;click&lt;/a&gt;`;
		expect(escapeHtml(input)).toBe(expected);
	});
});

describe('escapeAttr', () => {
	test('escapeHtml と同じ結果を返す (現在の実装)', () => {
		const inputs = ['plain', '<>"\'&', 'javascript:alert(1)', ''];
		for (const i of inputs) {
			expect(escapeAttr(i)).toBe(escapeHtml(i));
		}
	});

	test('属性値ダブルクォート破壊を無害化する', () => {
		const malicious = '" autofocus onfocus="alert(1)';
		expect(escapeAttr(malicious)).toBe('&quot; autofocus onfocus=&quot;alert(1)');
	});
});
