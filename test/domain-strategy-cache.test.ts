/**
 * src/utils/domain-strategy-cache.ts の単体テスト (phase14 Step 1)。
 */

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	pathKeysOf,
	DomainStrategyCache,
	getDefaultBootstrapPath,
	type DomainStrategyEntry,
} from '@/utils/domain-strategy-cache.js';

describe('pathKeysOf', () => {
	test('host + 先頭 1〜2 セグメントを specific → general 順で返す', () => {
		expect(pathKeysOf('https://amazon.co.jp/dp/B0XXXXXX/?ref=foo'))
			.toEqual(['amazon.co.jp/dp/B0XXXXXX', 'amazon.co.jp/dp', 'amazon.co.jp']);
		expect(pathKeysOf('https://qiita.com/UserA/items/abc'))
			.toEqual(['qiita.com/UserA/items', 'qiita.com/UserA', 'qiita.com']);
	});

	test('1 セグメントだけの URL', () => {
		expect(pathKeysOf('https://example.com/foo'))
			.toEqual(['example.com/foo', 'example.com']);
	});

	test('パスが無い URL は host のみ', () => {
		expect(pathKeysOf('https://example.com/')).toEqual(['example.com']);
		expect(pathKeysOf('https://example.com')).toEqual(['example.com']);
	});

	test('query / fragment は無視される', () => {
		expect(pathKeysOf('https://example.com/foo/bar?x=1#h'))
			.toEqual(['example.com/foo/bar', 'example.com/foo', 'example.com']);
	});

	test('不正 URL は空配列', () => {
		expect(pathKeysOf('not a url')).toEqual([]);
	});

	test('data: / file: / javascript: スキームは空配列 (phase14 Step 1 W-3)', () => {
		expect(pathKeysOf('data:text/html,<h1>x</h1>')).toEqual([]);
		expect(pathKeysOf('file:///etc/passwd')).toEqual([]);
		expect(pathKeysOf('javascript:alert(1)')).toEqual([]);
	});

	test('hostname が空の URL は空配列', () => {
		// ftp://example.com は scheme guard で弾かれる
		expect(pathKeysOf('ftp://example.com/foo')).toEqual([]);
	});

	test('URL インスタンスを直接受け付ける', () => {
		expect(pathKeysOf(new URL('https://example.com/a/b')))
			.toEqual(['example.com/a/b', 'example.com/a', 'example.com']);
	});
});

describe('DomainStrategyCache (in-memory のみ)', () => {
	test('lookup が specific → general 順でマッチする', () => {
		const cache = new DomainStrategyCache();
		cache.recordSuccess('amazon.co.jp/dp', 'proxy');

		const hit = cache.lookup('https://amazon.co.jp/dp/B0XXX/?ref=x');
		expect(hit).toBeDefined();
		expect(hit?.entry.strategy).toBe('proxy');
		expect(hit?.hitKey).toBe('amazon.co.jp/dp');
	});

	test('specific 一致が general 一致より優先される', () => {
		const cache = new DomainStrategyCache();
		cache.recordSuccess('example.com', 'default');
		cache.recordSuccess('example.com/api', 'curl_cffi');

		const hit = cache.lookup('https://example.com/api/v1');
		expect(hit?.hitKey).toBe('example.com/api');
		expect(hit?.entry.strategy).toBe('curl_cffi');
	});

	test('完全一致 (path 2 段) があればそれを返す', () => {
		const cache = new DomainStrategyCache();
		cache.recordSuccess('example.com', 'default');
		cache.recordSuccess('example.com/foo', 'proxy');
		cache.recordSuccess('example.com/foo/bar', 'curl_cffi');

		const hit = cache.lookup('https://example.com/foo/bar');
		expect(hit?.hitKey).toBe('example.com/foo/bar');
		expect(hit?.entry.strategy).toBe('curl_cffi');
	});

	test('lookup ミス時は undefined', () => {
		const cache = new DomainStrategyCache();
		expect(cache.lookup('https://example.com/foo')).toBeUndefined();
	});

	test('recordSuccess: 同 strategy を複数回呼ぶと successCount が増える', () => {
		const cache = new DomainStrategyCache();
		cache.recordSuccess('a.com', 'proxy');
		cache.recordSuccess('a.com', 'proxy');
		cache.recordSuccess('a.com', 'proxy');

		const hit = cache.lookup('https://a.com/');
		expect(hit?.entry.successCount).toBe(3);
		expect(hit?.entry.consecutiveFailures).toBe(0);
	});

	test('recordSuccess: strategy が変わると successCount は 1 にリセット', () => {
		const cache = new DomainStrategyCache();
		cache.recordSuccess('a.com', 'proxy');
		cache.recordSuccess('a.com', 'proxy');
		cache.recordSuccess('a.com', 'curl_cffi');

		const hit = cache.lookup('https://a.com/');
		expect(hit?.entry.strategy).toBe('curl_cffi');
		expect(hit?.entry.successCount).toBe(1);
	});

	test('recordFailure: エントリ無しなら no-op', () => {
		const cache = new DomainStrategyCache();
		cache.recordFailure('unknown.com');
		expect(cache.size).toBe(0);
	});

	test('recordFailure: 連続失敗が閾値未満なら increment', () => {
		const cache = new DomainStrategyCache({ consecutiveFailureThreshold: 3 });
		cache.recordSuccess('a.com', 'proxy');
		cache.recordFailure('a.com');
		cache.recordFailure('a.com');

		const hit = cache.lookup('https://a.com/');
		expect(hit?.entry.consecutiveFailures).toBe(2);
		expect(hit?.entry.strategy).toBe('proxy');
	});

	test('recordFailure: 閾値到達でエントリ破棄', () => {
		const cache = new DomainStrategyCache({ consecutiveFailureThreshold: 2 });
		cache.recordSuccess('a.com', 'proxy');
		cache.recordFailure('a.com');
		expect(cache.size).toBe(1);
		cache.recordFailure('a.com');
		expect(cache.size).toBe(0);
	});

	test('recordSuccess は consecutiveFailures を 0 にリセット', () => {
		const cache = new DomainStrategyCache({ consecutiveFailureThreshold: 5 });
		cache.recordSuccess('a.com', 'proxy');
		cache.recordFailure('a.com');
		cache.recordFailure('a.com');
		cache.recordSuccess('a.com', 'proxy');

		const hit = cache.lookup('https://a.com/');
		expect(hit?.entry.consecutiveFailures).toBe(0);
		expect(hit?.entry.successCount).toBe(2);
	});

	test('LRU: 上限超過で最古キーから捨てる', () => {
		const cache = new DomainStrategyCache({ maxEntries: 3 });
		cache.recordSuccess('a.com', 'proxy');
		cache.recordSuccess('b.com', 'proxy');
		cache.recordSuccess('c.com', 'proxy');
		cache.recordSuccess('d.com', 'proxy');

		expect(cache.size).toBe(3);
		expect(cache.lookup('https://a.com/')).toBeUndefined();
		expect(cache.lookup('https://d.com/')).toBeDefined();
	});

	test('LRU: recordSuccess がアクセスとして扱われ最新化される', () => {
		const cache = new DomainStrategyCache({ maxEntries: 3 });
		cache.recordSuccess('a.com', 'proxy');
		cache.recordSuccess('b.com', 'proxy');
		cache.recordSuccess('c.com', 'proxy');
		cache.recordSuccess('a.com', 'proxy'); // a を最新に
		cache.recordSuccess('d.com', 'proxy'); // 最古は b

		expect(cache.lookup('https://a.com/')).toBeDefined();
		expect(cache.lookup('https://b.com/')).toBeUndefined();
	});

	test('clear: 全エントリ削除', () => {
		const cache = new DomainStrategyCache();
		cache.recordSuccess('a.com', 'proxy');
		cache.recordSuccess('b.com', 'proxy');
		cache.clear();
		expect(cache.size).toBe(0);
	});

	test('snapshot: lastAttemptAt 降順', async () => {
		const cache = new DomainStrategyCache();
		cache.recordSuccess('a.com', 'proxy');
		await new Promise(r => setTimeout(r, 5));
		cache.recordSuccess('b.com', 'proxy');
		await new Promise(r => setTimeout(r, 5));
		cache.recordSuccess('c.com', 'proxy');

		const snap = cache.snapshot();
		expect(snap.map(e => e.pathKey)).toEqual(['c.com', 'b.com', 'a.com']);
	});

	test('constructor: maxEntries < 1 で RangeError', () => {
		expect(() => new DomainStrategyCache({ maxEntries: 0 })).toThrow(RangeError);
		expect(() => new DomainStrategyCache({ maxEntries: -1 })).toThrow(RangeError);
		expect(() => new DomainStrategyCache({ maxEntries: 1.5 })).toThrow(RangeError);
	});

	test('constructor: consecutiveFailureThreshold < 1 で RangeError', () => {
		expect(() => new DomainStrategyCache({ consecutiveFailureThreshold: 0 })).toThrow(RangeError);
	});

	test('constructor: compactionThreshold < 1 で RangeError', () => {
		expect(() => new DomainStrategyCache({ compactionThreshold: 0 })).toThrow(RangeError);
	});
});

describe('DomainStrategyCache (永続化)', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'summaly-strategy-cache-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test('runtimePath への append が JSONL 1 行ずつ書かれる', () => {
		const runtimePath = join(tmpDir, 'runtime.jsonl');
		const cache = new DomainStrategyCache({ runtimePath });

		cache.recordSuccess('a.com', 'proxy');
		cache.recordSuccess('b.com', 'curl_cffi');

		const text = readFileSync(runtimePath, 'utf8');
		const lines = text.split('\n').filter(l => l !== '');
		expect(lines.length).toBe(2);

		const e1 = JSON.parse(lines[0]) as DomainStrategyEntry;
		expect(e1.pathKey).toBe('a.com');
		expect(e1.strategy).toBe('proxy');
		const e2 = JSON.parse(lines[1]) as DomainStrategyEntry;
		expect(e2.pathKey).toBe('b.com');
		expect(e2.strategy).toBe('curl_cffi');
	});

	test('bootstrap JSONL を起動時にロード', () => {
		const bootstrapPath = join(tmpDir, 'bootstrap.jsonl');
		const ts = Date.now();
		const lines = [
			JSON.stringify({ pathKey: 'yodobashi.com', strategy: 'curl_cffi', successCount: 1, consecutiveFailures: 0, lastSuccessAt: ts, lastAttemptAt: ts }),
			JSON.stringify({ pathKey: 'store.jp.square-enix.com', strategy: 'proxy', successCount: 1, consecutiveFailures: 0, lastSuccessAt: ts, lastAttemptAt: ts }),
		].join('\n') + '\n';
		writeFileSync(bootstrapPath, lines, 'utf8');

		const cache = new DomainStrategyCache({ bootstrapPath });
		expect(cache.size).toBe(2);
		expect(cache.lookup('https://yodobashi.com/product/x')?.entry.strategy).toBe('curl_cffi');
		expect(cache.lookup('https://store.jp.square-enix.com/item/y')?.entry.strategy).toBe('proxy');
	});

	test('runtime JSONL は bootstrap の値を上書きする (後勝ち)', () => {
		const bootstrapPath = join(tmpDir, 'bootstrap.jsonl');
		const runtimePath = join(tmpDir, 'runtime.jsonl');
		const ts = Date.now();
		writeFileSync(bootstrapPath, JSON.stringify({
			pathKey: 'a.com', strategy: 'proxy', successCount: 1, consecutiveFailures: 0, lastSuccessAt: ts, lastAttemptAt: ts,
		}) + '\n', 'utf8');
		writeFileSync(runtimePath, JSON.stringify({
			pathKey: 'a.com', strategy: 'curl_cffi', successCount: 5, consecutiveFailures: 0, lastSuccessAt: ts, lastAttemptAt: ts,
		}) + '\n', 'utf8');

		const cache = new DomainStrategyCache({ bootstrapPath, runtimePath });
		expect(cache.lookup('https://a.com/')?.entry.strategy).toBe('curl_cffi');
		expect(cache.lookup('https://a.com/')?.entry.successCount).toBe(5);
	});

	test('bootstrap の consecutiveFailures は 0 にリセットされて取り込まれる (C-1)', () => {
		// bootstrap.jsonl に「閾値以上の失敗カウント」を持つエントリが書かれていても
		// 起動時の threshold 設定で誤って削除されないことを確認
		const bootstrapPath = join(tmpDir, 'bootstrap.jsonl');
		const ts = Date.now();
		writeFileSync(bootstrapPath, JSON.stringify({
			pathKey: 'a.com', strategy: 'proxy', successCount: 1, consecutiveFailures: 5, lastSuccessAt: ts, lastAttemptAt: ts,
		}) + '\n', 'utf8');

		const cache = new DomainStrategyCache({ bootstrapPath, consecutiveFailureThreshold: 3 });
		const hit = cache.lookup('https://a.com/');
		expect(hit).toBeDefined();
		expect(hit?.entry.strategy).toBe('proxy');
		// consecutiveFailures は 0 にリセットされている
		expect(hit?.entry.consecutiveFailures).toBe(0);
	});

	test('runtime JSONL の閾値到達エントリは bootstrap を打ち消す', () => {
		const bootstrapPath = join(tmpDir, 'bootstrap.jsonl');
		const runtimePath = join(tmpDir, 'runtime.jsonl');
		const ts = Date.now();
		writeFileSync(bootstrapPath, JSON.stringify({
			pathKey: 'a.com', strategy: 'proxy', successCount: 1, consecutiveFailures: 0, lastSuccessAt: ts, lastAttemptAt: ts,
		}) + '\n', 'utf8');
		// runtime に「閾値以上の連続失敗」を記録 → ロード時に削除扱い
		writeFileSync(runtimePath, JSON.stringify({
			pathKey: 'a.com', strategy: 'proxy', successCount: 1, consecutiveFailures: 3, lastSuccessAt: ts, lastAttemptAt: ts,
		}) + '\n', 'utf8');

		const cache = new DomainStrategyCache({ bootstrapPath, runtimePath, consecutiveFailureThreshold: 3 });
		expect(cache.lookup('https://a.com/')).toBeUndefined();
	});

	test('壊れた JSON 行 / schema 不一致は無視される', () => {
		const runtimePath = join(tmpDir, 'runtime.jsonl');
		const ts = Date.now();
		const lines = [
			'this is not json',
			JSON.stringify({ no: 'schema' }),
			JSON.stringify({ pathKey: 'good.com', strategy: 'proxy', successCount: 1, consecutiveFailures: 0, lastSuccessAt: ts, lastAttemptAt: ts }),
			JSON.stringify({ pathKey: 'bad.com', strategy: 'invalid_strategy', successCount: 1, consecutiveFailures: 0, lastSuccessAt: ts, lastAttemptAt: ts }),
			'',
		].join('\n');
		writeFileSync(runtimePath, lines, 'utf8');

		const cache = new DomainStrategyCache({ runtimePath });
		expect(cache.size).toBe(1);
		expect(cache.lookup('https://good.com/')?.entry.strategy).toBe('proxy');
	});

	test('ファイル未存在は OK (空でスタート)', () => {
		const runtimePath = join(tmpDir, 'never-existed.jsonl');
		const cache = new DomainStrategyCache({ runtimePath });
		expect(cache.size).toBe(0);
		// append で初めて作成される
		cache.recordSuccess('a.com', 'proxy');
		expect(existsSync(runtimePath)).toBe(true);
	});

	test('forceCompaction: 現在の map 内容で書き換え', () => {
		const runtimePath = join(tmpDir, 'runtime.jsonl');
		const cache = new DomainStrategyCache({ runtimePath });

		cache.recordSuccess('a.com', 'proxy');
		cache.recordSuccess('a.com', 'proxy'); // 同 pathKey 2 行目
		cache.recordSuccess('a.com', 'curl_cffi'); // strategy 切替で 3 行目
		// この時点で JSONL は 3 行 (重複 pathKey 含む)

		cache.forceCompaction();

		const text = readFileSync(runtimePath, 'utf8');
		const lines = text.split('\n').filter(l => l !== '');
		expect(lines.length).toBe(1); // map は 1 entry のみ
		const e = JSON.parse(lines[0]) as DomainStrategyEntry;
		expect(e.pathKey).toBe('a.com');
		expect(e.strategy).toBe('curl_cffi');
		expect(e.successCount).toBe(1);
	});

	test('compactionThreshold 到達で setImmediate 経由で自動圧縮', async () => {
		const runtimePath = join(tmpDir, 'runtime.jsonl');
		const cache = new DomainStrategyCache({ runtimePath, compactionThreshold: 5 });

		// 同 pathKey に 6 回 recordSuccess → 6 行 append → 5 で閾値到達 → setImmediate で compact
		for (let i = 0; i < 6; i++) cache.recordSuccess('a.com', 'proxy');

		// setImmediate を待つ
		await new Promise(r => setImmediate(r));

		const text = readFileSync(runtimePath, 'utf8');
		const lines = text.split('\n').filter(l => l !== '');
		expect(lines.length).toBe(1);
	});

	test('runtime path の親ディレクトリが無くても作成される', () => {
		const runtimePath = join(tmpDir, 'nested', 'sub', 'runtime.jsonl');
		const cache = new DomainStrategyCache({ runtimePath });
		cache.recordSuccess('a.com', 'proxy');
		expect(existsSync(runtimePath)).toBe(true);
	});

	test('runtimePath 未指定なら永続化されない', () => {
		const cache = new DomainStrategyCache();
		cache.recordSuccess('a.com', 'proxy');
		expect(cache.size).toBe(1);
		// 永続化先が無いだけで in-memory には残る
	});
});

describe('getDefaultBootstrapPath (phase14 Step 3)', () => {
	test('リポ同梱 data/domain-strategy-bootstrap.jsonl の絶対パスを返す', async () => {
		const path = getDefaultBootstrapPath();
		expect(path).toBeDefined();
		// W-3 review feedback: パス区切り依存をなくすため `path.basename` で検証
		const { basename } = await import('node:path');
		expect(path != null ? basename(path) : '').toBe('domain-strategy-bootstrap.jsonl');
	});

	test('返されたパスのファイルを読むと bootstrap エントリが含まれる (全グループ網羅)', () => {
		const path = getDefaultBootstrapPath();
		expect(path).toBeDefined();
		const cache = new DomainStrategyCache({ bootstrapPath: path });
		// yodobashi グループ: curl_cffi
		expect(cache.lookup('https://yodobashi.com/test')?.entry.strategy).toBe('curl_cffi');
		expect(cache.lookup('https://www.yodobashi.com/test')?.entry.strategy).toBe('curl_cffi');
		// sqex グループ: proxy
		expect(cache.lookup('https://store.jp.square-enix.com/item/123')?.entry.strategy).toBe('proxy');
		// amazon co.jp グループ: proxy (S-3 review feedback: 全グループ網羅)
		expect(cache.lookup('https://www.amazon.co.jp/dp/B0XXXXX')?.entry.strategy).toBe('proxy');
		expect(cache.lookup('https://amazon.co.jp/gp/product/X')?.entry.strategy).toBe('proxy');
		// amazon com グループ: proxy
		expect(cache.lookup('https://www.amazon.com/dp/B0YYYYY')?.entry.strategy).toBe('proxy');
	});
});
