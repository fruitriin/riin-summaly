/**
 * src/utils/parse-failure-log.ts の単体テスト (phase10.1)。
 */

import { describe, expect, test } from 'vitest';
import {
	groupKeyOf,
	sanitizeUrlForLog,
	isThinSummary,
	isFilteredFailure,
	ParseFailureLog,
} from '@/utils/parse-failure-log.js';
import type { SummalyResult } from '@/index.js';

function dummySummary(overrides: Partial<SummalyResult> = {}): SummalyResult {
	return {
		title: null,
		icon: null,
		description: null,
		thumbnail: null,
		sitename: null,
		player: { url: null, width: null, height: null, allow: [] },
		activityPub: null,
		fediverseCreator: null,
		url: 'https://example.com/page',
		...overrides,
	};
}

describe('groupKeyOf', () => {
	test('hostname + 先頭 1〜2 セグメントを連結する', () => {
		expect(groupKeyOf('https://qiita.com/UserA/items/abc')).toBe('qiita.com/UserA/items');
		expect(groupKeyOf('https://note.com/foo/n/abc')).toBe('note.com/foo/n');
		expect(groupKeyOf('https://example.com/foo')).toBe('example.com/foo');
	});

	test('パスが無い URL は hostname/ で終わる', () => {
		expect(groupKeyOf('https://example.com/')).toBe('example.com/');
		expect(groupKeyOf('https://example.com')).toBe('example.com/');
	});

	test('query / fragment は無視される', () => {
		expect(groupKeyOf('https://qiita.com/UserA/items/abc?session=xxx#top')).toBe('qiita.com/UserA/items');
	});

	test('不正 URL は _invalid', () => {
		expect(groupKeyOf('not a url')).toBe('_invalid');
	});
});

describe('sanitizeUrlForLog', () => {
	test('query / fragment を除いた origin + pathname を返す', () => {
		expect(sanitizeUrlForLog('https://example.com/path?token=secret#hash')).toBe('https://example.com/path');
		expect(sanitizeUrlForLog('https://example.com/')).toBe('https://example.com/');
	});

	test('basic auth は URL に含めない（New URL の origin が auth を含まないため）', () => {
		expect(sanitizeUrlForLog('https://user:pass@example.com/p')).toBe('https://example.com/p');
	});

	test('不正 URL は元文字列をそのまま返す', () => {
		expect(sanitizeUrlForLog('not-a-url')).toBe('not-a-url');
	});

	test('data: / file: 等の non-http(s) スキームはガベージ文字列にせず安全な placeholder を返す', () => {
		// URL.origin が "null" を返すケース。`"nulltext/html,..."` のような怪しい文字列を
		// ログに混入させない
		expect(sanitizeUrlForLog('data:text/html,<h1>x</h1>')).toBe('data:[sanitized]');
		expect(sanitizeUrlForLog('file:///etc/passwd')).toBe('file:[sanitized]');
		expect(sanitizeUrlForLog('javascript:alert(1)')).toBe('javascript:[sanitized]');
	});
});

describe('isThinSummary', () => {
	test('description があれば false', () => {
		expect(isThinSummary(dummySummary({ description: 'hello' }))).toBe(false);
	});

	test('thumbnail があれば false', () => {
		expect(isThinSummary(dummySummary({ thumbnail: 'https://example.com/img.jpg' }))).toBe(false);
	});

	test('player.url があれば false', () => {
		expect(isThinSummary(dummySummary({ player: { url: 'https://e/embed', width: 100, height: 100, allow: [] } }))).toBe(false);
	});

	test('title が hostname と同じなら thin', () => {
		expect(isThinSummary(dummySummary({ title: 'example.com', url: 'https://example.com/page' }))).toBe(true);
	});

	test('title が null / 空文字なら thin', () => {
		expect(isThinSummary(dummySummary({ title: null }))).toBe(true);
		expect(isThinSummary(dummySummary({ title: '' }))).toBe(true);
	});

	test('独自 title があれば thin ではない（プラグイン由来想定）', () => {
		expect(isThinSummary(dummySummary({ title: 'jack on X' }))).toBe(false);
	});

	test('description が空文字なら thin（null と同等扱い）', () => {
		expect(isThinSummary(dummySummary({ title: 'example.com', description: '', url: 'https://example.com/' }))).toBe(true);
	});

	test('medias[] にコンテンツがあれば thin ではない', () => {
		expect(isThinSummary(dummySummary({
			title: 'example.com',
			url: 'https://example.com/',
			medias: ['https://example.com/img.jpg'],
		}))).toBe(false);
	});

	test('medias が空配列なら thin 判定を継続（hostname title を thin と見なす）', () => {
		expect(isThinSummary(dummySummary({
			title: 'example.com',
			url: 'https://example.com/',
			medias: [],
		}))).toBe(true);
	});
});

describe('isFilteredFailure (絶対失敗類型の除外)', () => {
	test('reason=thin は常に false（thin はプラグイン候補なので残す）', () => {
		expect(isFilteredFailure('thin')).toBe(false);
		expect(isFilteredFailure('thin', 'whatever')).toBe(false);
	});

	test('StatusError は filter（4xx/5xx すべて、Akamai 403 等を含む）', () => {
		expect(isFilteredFailure('throw', '403 Forbidden', 'StatusError')).toBe(true);
		expect(isFilteredFailure('throw', '404 Not Found', 'StatusError')).toBe(true);
		expect(isFilteredFailure('throw', '500 Internal Server Error', 'StatusError')).toBe(true);
	});

	test('TimeoutError / AbortError / CancelError は filter', () => {
		expect(isFilteredFailure('throw', 'timeout', 'TimeoutError')).toBe(true);
		expect(isFilteredFailure('throw', 'aborted', 'AbortError')).toBe(true);
		expect(isFilteredFailure('throw', '', 'CancelError')).toBe(true);
	});

	test('Private IP rejected メッセージは filter', () => {
		expect(isFilteredFailure('throw', 'Private IP rejected 192.168.1.1')).toBe(true);
	});

	test('Rejected by type filter メッセージは filter', () => {
		expect(isFilteredFailure('throw', 'Rejected by type filter application/pdf')).toBe(true);
	});

	test('"403 Forbidden" 形式のメッセージはエラー名に依らず filter', () => {
		expect(isFilteredFailure('throw', '403 Forbidden')).toBe(true);
		expect(isFilteredFailure('throw', '503 Service Unavailable')).toBe(true);
	});

	test('未知の throw は false（記録される）', () => {
		expect(isFilteredFailure('throw', 'failed summarize')).toBe(false);
		expect(isFilteredFailure('throw', 'cheerio parse error')).toBe(false);
	});

	test('低レベルネットワーク到達不能エラー (ENOTFOUND/ECONNREFUSED 等) は filter', () => {
		expect(isFilteredFailure('throw', 'getaddrinfo ENOTFOUND example.invalid')).toBe(true);
		expect(isFilteredFailure('throw', 'connect ECONNREFUSED 127.0.0.1:443')).toBe(true);
		expect(isFilteredFailure('throw', 'connect ECONNRESET')).toBe(true);
		expect(isFilteredFailure('throw', 'connect EHOSTUNREACH 1.2.3.4')).toBe(true);
		expect(isFilteredFailure('throw', 'getaddrinfo EAI_AGAIN host')).toBe(true);
	});

	test('errorMessage / errorName が undefined でも安全', () => {
		expect(isFilteredFailure('throw')).toBe(false);
	});
});

describe('ParseFailureLog', () => {
	test('record で同 URL の重複は 1 件に抑えられる', () => {
		const log = new ParseFailureLog({ maxGroups: 100, samplesPerGroup: 5 });
		log.record('https://example.com/a', 'thin');
		log.record('https://example.com/a', 'thin');
		log.record('https://example.com/a', 'thin');
		const entries = log.snapshot();
		expect(entries).toHaveLength(1);
		expect(entries[0].samples).toHaveLength(1);
	});

	test('samplesPerGroup を超えると古いものから捨てる', () => {
		const log = new ParseFailureLog({ maxGroups: 10, samplesPerGroup: 2 });
		// group key = `example.com/group/sub` を共有するよう先頭 2 セグメントを揃える
		log.record('https://example.com/group/sub/a', 'thin');
		log.record('https://example.com/group/sub/b', 'thin');
		log.record('https://example.com/group/sub/c', 'thin');
		const entries = log.snapshot();
		expect(entries).toHaveLength(1);
		expect(entries[0].key).toBe('example.com/group/sub');
		// 直近 2 件 (c, b) のみ残り、a は捨てられる。unshift なので [c, b]
		const urls = entries[0].samples.map(s => s.url);
		expect(urls).toEqual([
			'https://example.com/group/sub/c',
			'https://example.com/group/sub/b',
		]);
	});

	test('maxGroups を超えると最も古いグループから捨てる', () => {
		const log = new ParseFailureLog({ maxGroups: 2, samplesPerGroup: 1 });
		log.record('https://a.example.com/p', 'thin');
		log.record('https://b.example.com/p', 'thin');
		log.record('https://c.example.com/p', 'thin');
		const entries = log.snapshot();
		expect(entries).toHaveLength(2);
		const keys = entries.map(e => e.key).sort();
		// a が捨てられ b と c のみ
		expect(keys).toEqual(['b.example.com/p', 'c.example.com/p']);
	});

	test('既存グループに record すると Map 内位置が末尾に移る（LRU 風）', () => {
		const log = new ParseFailureLog({ maxGroups: 2, samplesPerGroup: 5 });
		// 同 group key を共有するよう先頭 2 セグメント揃え。
		// a-group: `a.example.com/articles/foo` の先頭 2 セグメント → `articles/foo`
		log.record('https://a.example.com/articles/foo/x', 'thin');
		log.record('https://b.example.com/articles/foo/x', 'thin');
		// a-group に再投入（同じ group key だが URL は別）→ Map 末尾に移動
		log.record('https://a.example.com/articles/foo/y', 'thin');
		// 3 つ目のグループを入れると、最古は b になっているはず（a が末尾に移ったため）
		log.record('https://c.example.com/articles/foo/x', 'thin');
		const keys = log.snapshot().map(e => e.key).sort();
		expect(keys).toEqual(['a.example.com/articles/foo', 'c.example.com/articles/foo']);
	});

	test('errorMessage は 200 文字で切り詰める', () => {
		const log = new ParseFailureLog({ maxGroups: 10, samplesPerGroup: 5 });
		const longMsg = 'x'.repeat(500);
		log.record('https://example.com/p', 'throw', longMsg);
		const sample = log.snapshot()[0].samples[0];
		expect(sample.errorMessage).toHaveLength(200);
	});

	test('reason: throw のみ errorMessage が乗る', () => {
		const log = new ParseFailureLog({ maxGroups: 10, samplesPerGroup: 5 });
		log.record('https://example.com/a', 'thin');
		log.record('https://example.com/b', 'throw', 'BOOM');
		const samples = log.snapshot().flatMap(e => e.samples);
		const thin = samples.find(s => s.url === 'https://example.com/a')!;
		const thrown = samples.find(s => s.url === 'https://example.com/b')!;
		expect(thin.errorMessage).toBeUndefined();
		expect(thrown.errorMessage).toBe('BOOM');
	});

	test('snapshot は ts 降順で並ぶ', async () => {
		const log = new ParseFailureLog({ maxGroups: 10, samplesPerGroup: 5 });
		log.record('https://a.example.com/p', 'thin');
		await new Promise(r => setTimeout(r, 5));
		log.record('https://b.example.com/p', 'thin');
		const entries = log.snapshot();
		expect(entries[0].key).toBe('b.example.com/p');
		expect(entries[1].key).toBe('a.example.com/p');
	});

	test('不正な maxGroups / samplesPerGroup でコンストラクタが throw', () => {
		expect(() => new ParseFailureLog({ maxGroups: 0, samplesPerGroup: 5 })).toThrow(/maxGroups/);
		expect(() => new ParseFailureLog({ maxGroups: 1.5, samplesPerGroup: 5 })).toThrow(/maxGroups/);
		expect(() => new ParseFailureLog({ maxGroups: 10, samplesPerGroup: 0 })).toThrow(/samplesPerGroup/);
	});

	test('clear() で空に', () => {
		const log = new ParseFailureLog({ maxGroups: 10, samplesPerGroup: 5 });
		log.record('https://example.com/a', 'thin');
		expect(log.size).toBe(1);
		log.clear();
		expect(log.size).toBe(0);
	});
});
