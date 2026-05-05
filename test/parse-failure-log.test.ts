/**
 * src/utils/parse-failure-log.ts の単体テスト (phase10.1)。
 */

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	groupKeyOf,
	sanitizeUrlForLog,
	isThinSummary,
	isFilteredFailure,
	categorizeError,
	serializeJsonlLine,
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

	test('thumbnail === icon は thin 判定継続 (phase11.7 favicon フォールバック)', () => {
		// favicon フォールバックが発動しているケースは「OG 画像が無いので favicon を流用した」
		// 状態。プラグイン化候補のシグナルとして残したいので thin 判定を継続する
		const fav = 'https://example.com/favicon.ico';
		expect(isThinSummary(dummySummary({
			title: 'example.com',
			url: 'https://example.com/',
			icon: fav,
			thumbnail: fav,
		}))).toBe(true);
		// title が独自であれば（hostname と異なる）thin ではない
		expect(isThinSummary(dummySummary({
			title: 'Some Article',
			url: 'https://example.com/article',
			icon: fav,
			thumbnail: fav,
		}))).toBe(false);
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

describe('categorizeError (phase11.2)', () => {
	test('StatusError + statusCode 404 → not_found', () => {
		expect(categorizeError('404 Not Found', 'StatusError', 404)).toBe('not_found');
	});

	test('StatusError + statusCode 4xx (404 以外) → bot_blocked', () => {
		expect(categorizeError('403 Forbidden', 'StatusError', 403)).toBe('bot_blocked');
		expect(categorizeError('401 Unauthorized', 'StatusError', 401)).toBe('bot_blocked');
		expect(categorizeError('429 Too Many Requests', 'StatusError', 429)).toBe('bot_blocked');
	});

	test('StatusError + statusCode 5xx → origin_error', () => {
		expect(categorizeError('500 Internal Server Error', 'StatusError', 500)).toBe('origin_error');
		expect(categorizeError('503 Service Unavailable', 'StatusError', 503)).toBe('origin_error');
	});

	test('TimeoutError / AbortError / CancelError → timeout', () => {
		expect(categorizeError('timeout', 'TimeoutError')).toBe('timeout');
		expect(categorizeError('aborted', 'AbortError')).toBe('timeout');
		expect(categorizeError('', 'CancelError')).toBe('timeout');
	});

	test('メッセージ先頭の 3 桁ステータスでも分類できる（StatusError 名前無しのフォールバック）', () => {
		expect(categorizeError('404 Not Found')).toBe('not_found');
		expect(categorizeError('403 Forbidden')).toBe('bot_blocked');
		expect(categorizeError('502 Bad Gateway')).toBe('origin_error');
	});

	test('Private IP rejected メッセージ → ssrf_blocked', () => {
		expect(categorizeError('Private IP rejected 192.168.1.1')).toBe('ssrf_blocked');
	});

	test('Invalid IP (IP パース失敗) も ssrf_blocked に分類 (statusCode 500 由来 origin_error より優先)', () => {
		expect(categorizeError('Invalid IP some-bad-string', 'StatusError', 500)).toBe('ssrf_blocked');
	});

	test('Rejected by type filter メッセージ → unsupported_type', () => {
		expect(categorizeError('Rejected by type filter application/pdf')).toBe('unsupported_type');
	});

	test('Rejected by type filter undefined (content-type 欠落) → bot_blocked (phase12.1 followup)', () => {
		// Amazon が Vultr Tokyo IP に対して 200 + 空 content-type を返すケース。
		// 真の非 HTML と区別して proxy fallback の発火対象 (bot_blocked) に振り分ける。
		expect(categorizeError('Rejected by type filter undefined')).toBe('bot_blocked');
	});

	test('maxSize exceeded メッセージ → content_too_large', () => {
		expect(categorizeError('maxSize exceeded (15728640 > 10485760) on response')).toBe('content_too_large');
	});

	test('低レベルネットワーク到達不能 → network_error', () => {
		expect(categorizeError('getaddrinfo ENOTFOUND example.invalid')).toBe('network_error');
		expect(categorizeError('connect ECONNREFUSED 127.0.0.1:443')).toBe('network_error');
		expect(categorizeError('connect EHOSTUNREACH')).toBe('network_error');
	});

	test('TCP/TLS 後の切断系 → connection_dropped (phase11.9)', () => {
		// bot block 系 WAF が「`SummalyBot` 文字列を検知してから TCP/TLS 確立後に
		// HTTP レスポンス前で切断する」典型パターン。フォールバック UA でリトライ価値あり。
		expect(categorizeError('socket hang up')).toBe('connection_dropped');
		expect(categorizeError('write EPIPE')).toBe('connection_dropped');
		expect(categorizeError('Empty reply from server')).toBe('connection_dropped');
		// ECONNRESET は意味的に socket hang up とほぼ同じなので connection_dropped 側に寄せる
		// （phase11.2 までは network_error 配下だったが、リトライ判定の精度を上げるため再分類）
		expect(categorizeError('connect ECONNRESET')).toBe('connection_dropped');
		// got が wrap せず Node.js が直接 throw する `read ECONNRESET` 形式もマッチする
		expect(categorizeError('read ECONNRESET')).toBe('connection_dropped');
	});

	test('failed summarize メッセージ → parse_error', () => {
		expect(categorizeError('failed summarize')).toBe('parse_error');
	});

	test('未知のエラー → unknown', () => {
		expect(categorizeError('cheerio internal error')).toBe('unknown');
		expect(categorizeError(undefined, undefined)).toBe('unknown');
		expect(categorizeError()).toBe('unknown');
	});

	test('statusCode 優先: errorMessage より statusCode の方が信頼できる', () => {
		// メッセージは 200 OK だが statusCode が 503 の場合 (ありえない組み合わせだが優先順位確認)
		expect(categorizeError('something went wrong', 'StatusError', 503)).toBe('origin_error');
	});

	test('StatusError + 範囲外 statusCode (例: 200, 600) はメッセージにフォールバック', () => {
		// 4xx/5xx 外は status による分類スキップ → メッセージ先頭の 3 桁を見て分類
		expect(categorizeError('300 Multiple Choices', 'StatusError', 300)).toBe('unknown');
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

describe('serializeJsonlLine', () => {
	test('1 行で改行終端、key + sample フィールドが flat に乗る', () => {
		const line = serializeJsonlLine('example.com/a', {
			url: 'https://example.com/a/b',
			ts: 1000,
			reason: 'thin',
		});
		expect(line.endsWith('\n')).toBe(true);
		expect(line.includes('\n')).toBe(true);
		const parsed = JSON.parse(line.trim());
		expect(parsed).toEqual({
			key: 'example.com/a',
			url: 'https://example.com/a/b',
			ts: 1000,
			reason: 'thin',
		});
	});

	test('errorMessage が改行を含んでも 1 行に収まる（JSON.stringify がエスケープ）', () => {
		const line = serializeJsonlLine('example.com/x', {
			url: 'https://example.com/x',
			ts: 1,
			reason: 'throw',
			errorMessage: 'first line\nsecond line',
		});
		expect(line.split('\n').filter(Boolean)).toHaveLength(1);
	});
});

describe('ParseFailureLog (JSONL 永続化)', () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'summaly-pflog-'));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test('jsonlPath 未指定なら fs に書かない', () => {
		const log = new ParseFailureLog({ maxGroups: 10, samplesPerGroup: 5 });
		log.record('https://example.com/a', 'thin');
		// 何も起きないことの確認は副次的。一応 tmpDir に file が無いこと
		expect(existsSync(join(tmpDir, 'any.jsonl'))).toBe(false);
	});

	test('jsonlPath 指定で record のたび JSONL 1 行が append される', () => {
		const path = join(tmpDir, 'pf.jsonl');
		const log = new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			jsonlPath: path,
		});
		log.record('https://example.com/articles/foo/a', 'thin');
		log.record('https://example.com/articles/foo/b', 'thin');
		log.record('https://example.com/x/y', 'throw', 'BOOM');

		const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
		expect(lines).toHaveLength(3);
		const parsed = lines.map(l => JSON.parse(l));
		expect(parsed[0]).toMatchObject({ key: 'example.com/articles/foo', url: 'https://example.com/articles/foo/a', reason: 'thin' });
		expect(parsed[1]).toMatchObject({ key: 'example.com/articles/foo', url: 'https://example.com/articles/foo/b', reason: 'thin' });
		expect(parsed[2]).toMatchObject({ key: 'example.com/x/y', url: 'https://example.com/x/y', reason: 'throw', errorMessage: 'BOOM' });
	});

	test('既存ファイルがあると append（上書きしない）', () => {
		const path = join(tmpDir, 'pf.jsonl');
		writeFileSync(path, '{"key":"existing.com/x","url":"https://existing.com/x","ts":1,"reason":"thin"}\n');

		const log = new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			jsonlPath: path,
		});
		log.record('https://example.com/a', 'thin');

		const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toMatchObject({ key: 'existing.com/x' });
		expect(JSON.parse(lines[1])).toMatchObject({ url: 'https://example.com/a' });
	});

	test('jsonlMaxBytes を超える append はスキップ（既存ファイルが既に超えていれば一切書かない）', () => {
		const path = join(tmpDir, 'pf.jsonl');
		// 既存サイズが 200 byte で cap が 100 byte → 起動時から cap 越え
		writeFileSync(path, 'x'.repeat(200));
		const log = new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			jsonlPath: path,
			jsonlMaxBytes: 100,
		});
		log.record('https://example.com/a', 'thin');

		// 既存 200 バイトのまま（追記されない）
		expect(statSync(path).size).toBe(200);
	});

	test('jsonlMaxBytes 直近で次の line が cap を越えるなら書かない（厳格 cap）', () => {
		const path = join(tmpDir, 'pf.jsonl');
		const log = new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			jsonlPath: path,
			jsonlMaxBytes: 80,  // 1 line ≒ 90 バイト想定
		});
		log.record('https://example.com/articles/foo/very-long-url-that-exceeds-cap', 'thin');
		// 1 行追加すると cap 越えなので書かれない
		expect(existsSync(path)).toBe(false);
	});

	test('cap 越え後、in-memory 集約は引き続き機能する', () => {
		const path = join(tmpDir, 'pf.jsonl');
		writeFileSync(path, 'x'.repeat(200));
		const log = new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			jsonlPath: path,
			jsonlMaxBytes: 100,
		});
		log.record('https://example.com/a', 'thin');
		log.record('https://example.com/b', 'thin');
		// in-memory には記録されている
		expect(log.size).toBe(2);
	});

	test('jsonlMaxBytes が負数だと RangeError', () => {
		expect(() => new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			jsonlPath: '/tmp/x.jsonl',
			jsonlMaxBytes: -1,
		})).toThrow(/jsonlMaxBytes/);
	});

	test('書き込み権限が無い path はサイレントに失敗する（エラーで request を止めない）', () => {
		// /proc/null のような書き込み不可パス（環境依存）。代わりに tmpDir 内の存在しないサブディレクトリを使う
		const path = join(tmpDir, 'no-such-dir', 'pf.jsonl');
		const log = new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			jsonlPath: path,
		});
		// throw しないことだけ確認
		expect(() => log.record('https://example.com/a', 'thin')).not.toThrow();
		// in-memory は記録される
		expect(log.size).toBe(1);
	});
});

describe('ParseFailureLog 迂回候補ログ (phase11.6)', () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'summaly-pflog-blocked-'));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test('throw + フィルタ対象 (4xx) は blocked JSONL に書かれ、in-memory には残らない', () => {
		const candidatePath = join(tmpDir, 'pf.jsonl');
		const blockedPath = join(tmpDir, 'blocked.jsonl');
		const log = new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			jsonlPath: candidatePath,
			blockedJsonlPath: blockedPath,
		});

		log.record('https://www.npmjs.com/package/mfm', 'throw', '403 Forbidden', 'StatusError', 403);

		// in-memory には残らない（流量抑制）
		expect(log.size).toBe(0);
		// candidate JSONL も空（プラグイン候補純度を保つ）
		expect(() => readFileSync(candidatePath, 'utf8')).toThrow();
		// blocked JSONL に 1 行
		const lines = readFileSync(blockedPath, 'utf8').split('\n').filter(Boolean);
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]) as { key: string; reason: string; category: string; errorName: string };
		expect(entry.key).toBe('www.npmjs.com/package/mfm');
		expect(entry.reason).toBe('throw');
		expect(entry.category).toBe('bot_blocked');
		expect(entry.errorName).toBe('StatusError');
	});

	test('throw + 非フィルタ対象 (parse_error) は candidate JSONL + in-memory', () => {
		const candidatePath = join(tmpDir, 'pf.jsonl');
		const blockedPath = join(tmpDir, 'blocked.jsonl');
		const log = new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			jsonlPath: candidatePath,
			blockedJsonlPath: blockedPath,
		});

		log.record('https://example.com/post', 'throw', 'failed summarize', 'Error');

		expect(log.size).toBe(1);
		const lines = readFileSync(candidatePath, 'utf8').split('\n').filter(Boolean);
		expect(lines).toHaveLength(1);
		// blocked JSONL は空
		expect(() => readFileSync(blockedPath, 'utf8')).toThrow();
	});

	test('thin reason は常に candidate JSONL（blocked には混ざらない）', () => {
		const candidatePath = join(tmpDir, 'pf.jsonl');
		const blockedPath = join(tmpDir, 'blocked.jsonl');
		const log = new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			jsonlPath: candidatePath,
			blockedJsonlPath: blockedPath,
		});

		log.record('https://example.com/article', 'thin');

		expect(log.size).toBe(1);
		expect(readFileSync(candidatePath, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
		expect(() => readFileSync(blockedPath, 'utf8')).toThrow();
	});

	test('カテゴリ別: connection_dropped / timeout / ssrf_blocked / network_error が blocked に振り分けられる', () => {
		const blockedPath = join(tmpDir, 'blocked.jsonl');
		const log = new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			blockedJsonlPath: blockedPath,
		});

		log.record('https://a.com/x', 'throw', 'socket hang up');
		log.record('https://b.com/x', 'throw', 'request timed out', 'TimeoutError');
		log.record('https://c.com/x', 'throw', 'Private IP rejected 10.0.0.1');
		log.record('https://d.com/x', 'throw', 'getaddrinfo ENOTFOUND foo');

		const lines = readFileSync(blockedPath, 'utf8').split('\n').filter(Boolean);
		expect(lines).toHaveLength(4);
		const cats = lines.map(l => (JSON.parse(l) as { category: string }).category);
		expect(cats).toEqual(['connection_dropped', 'timeout', 'ssrf_blocked', 'network_error']);
	});

	test('blockedJsonlPath 未指定なら blocked 経路はサイレントに no-op', () => {
		const log = new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
		});
		// throw + フィルタ対象を投げても何も起きない（in-memory も増えない、JSONL も無い）
		expect(() => log.record('https://blocked.com/x', 'throw', '403 Forbidden', 'StatusError', 403)).not.toThrow();
		expect(log.size).toBe(0);
	});

	test('blockedJsonlMaxBytes 越え時は append 停止（candidate cap とは独立）', () => {
		const candidatePath = join(tmpDir, 'pf.jsonl');
		const blockedPath = join(tmpDir, 'blocked.jsonl');
		const log = new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			jsonlPath: candidatePath,
			jsonlMaxBytes: 10485760, // 大きい cap
			blockedJsonlPath: blockedPath,
			blockedJsonlMaxBytes: 500, // 1〜3 行分は通せる小さい cap
		});

		// 5 件投げる → cap で途中から append 停止
		for (let i = 0; i < 5; i++) {
			log.record(`https://blocked${i}.com/x`, 'throw', '403 Forbidden', 'StatusError', 403);
		}
		const blockedContent = readFileSync(blockedPath, 'utf8');
		expect(blockedContent.length).toBeLessThanOrEqual(500);
		// 少なくとも 1 行は書けた（cap が 0 ではない）
		expect(blockedContent.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(1);

		// candidate 側は cap 越えしていないので thin は引き続き書ける
		log.record('https://example.com/article', 'thin');
		expect(log.size).toBe(1);
		expect(readFileSync(candidatePath, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
	});

	test('parseFailureLogBlockedJsonlMaxBytes が負数だと RangeError', () => {
		expect(() => new ParseFailureLog({
			maxGroups: 10,
			samplesPerGroup: 5,
			blockedJsonlPath: '/tmp/x.jsonl',
			blockedJsonlMaxBytes: -1,
		})).toThrow(/parseFailureLogBlockedJsonlMaxBytes/);
	});
});
