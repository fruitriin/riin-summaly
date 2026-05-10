/**
 * src/utils/hedged-fetch.ts の単体テスト (phase18)。
 *
 * モックの fetchByStrategy で各経路の挙動 (即返却 / 遅延 / 失敗) を仕込み、
 * 「champion 即勝ち」「champion 遅延 + challenger 勝ち」「全 invalid」「abort 動作」を確認。
 */

import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import {
	hedgedRace,
	HedgedRaceAllFailedError,
	ALL_STRATEGIES,
	type FetchStrategyFn,
} from '@/utils/hedged-fetch.js';
import type { DomainStrategy } from '@/utils/domain-strategy-cache.js';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

/**
 * テスト用の strategy 動作仕様。
 *
 * - `delayMs`: fetch の解決までの遅延 (vi.useFakeTimers で advance する)
 * - `result`: 解決時の値 (`'data:<n>'` 等の string、`null` ならゲート不通過)
 * - `throwOn`: true なら delayMs 経過後に reject する
 * - `abortable`: true なら signal.aborted で reject (= 真に abort 観測する)
 */
type StrategySpec = {
	delayMs: number;
	result: string | null;
	throwOn?: boolean;
	abortable?: boolean;
};

function makeFetchByStrategy(specs: Partial<Record<DomainStrategy, StrategySpec>>): FetchStrategyFn<string> {
	return (strategy, signal) => new Promise<string | null>((resolve, reject) => {
		const spec = specs[strategy];
		if (spec == null) {
			// 未指定 strategy は即時 gate_failed (null)
			resolve(null);
			return;
		}
		const timer = setTimeout(() => {
			if (spec.throwOn) {
				reject(new Error(`${strategy} failed`));
			} else {
				resolve(spec.result);
			}
		}, spec.delayMs);
		if (spec.abortable === true) {
			signal.addEventListener('abort', () => {
				clearTimeout(timer);
				reject(new Error(`${strategy} aborted`));
			});
		}
	});
}

const isValid = (r: string) => r.startsWith('data:');

describe('hedgedRace', () => {
	test('champion が threshold 内に valid を返したら hedgeFired = false', async () => {
		const fetchFn = makeFetchByStrategy({
			default: { delayMs: 100, result: 'data:champion-ok' },
			fallback_ua: { delayMs: 100, result: 'data:fallback-ok' },
			proxy: { delayMs: 100, result: 'data:proxy-ok' },
			curl_cffi: { delayMs: 100, result: 'data:curl-ok' },
		});

		const racePromise = hedgedRace(
			{ champion: 'default', challengers: ['fallback_ua', 'proxy', 'curl_cffi'], thresholdMs: 5000 },
			fetchFn,
			isValid,
		);
		await vi.advanceTimersByTimeAsync(150);
		const result = await racePromise;

		expect(result.winnerStrategy).toBe('default');
		expect(result.hedgeFired).toBe(false);
		expect(result.response).toBe('data:champion-ok');
		expect(result.outcomes.default).toBe('valid');
		// challengers は起動されていない
		expect(result.outcomes.fallback_ua).toBeUndefined();
		expect(result.outcomes.proxy).toBeUndefined();
		expect(result.outcomes.curl_cffi).toBeUndefined();
	});

	test('champion が threshold 経過 → challenger 勝ち で昇格対象', async () => {
		const fetchFn = makeFetchByStrategy({
			default: { delayMs: 30000, result: 'data:slow-champion', abortable: true },
			fallback_ua: { delayMs: 100, result: 'data:fast-fallback', abortable: true },
			proxy: { delayMs: 200, result: 'data:proxy-ok', abortable: true },
			curl_cffi: { delayMs: 200, result: 'data:curl-ok', abortable: true },
		});

		const racePromise = hedgedRace(
			{ champion: 'default', challengers: ['fallback_ua', 'proxy', 'curl_cffi'], thresholdMs: 5000 },
			fetchFn,
			isValid,
		);
		// threshold 経過 → challengers 起動 → fallback_ua 100ms で勝ち
		await vi.advanceTimersByTimeAsync(5200);
		const result = await racePromise;

		expect(result.hedgeFired).toBe(true);
		expect(result.winnerStrategy).toBe('fallback_ua');
		expect(result.response).toBe('data:fast-fallback');
		expect(result.outcomes.fallback_ua).toBe('valid');
	});

	test('champion 即失敗 → challenger 並列発火 → 勝ち', async () => {
		const fetchFn = makeFetchByStrategy({
			default: { delayMs: 50, result: null, throwOn: true, abortable: true },
			fallback_ua: { delayMs: 100, result: 'data:fallback-ok', abortable: true },
			proxy: { delayMs: 200, result: 'data:proxy-ok', abortable: true },
			curl_cffi: { delayMs: 300, result: 'data:curl-ok', abortable: true },
		});

		const racePromise = hedgedRace(
			{ champion: 'default', challengers: ['fallback_ua', 'proxy', 'curl_cffi'], thresholdMs: 5000 },
			fetchFn,
			isValid,
		);
		// champion 50ms で即失敗 → hedge fire → fallback_ua が 100ms (合計 150ms) で勝ち
		await vi.advanceTimersByTimeAsync(200);
		const result = await racePromise;

		expect(result.hedgeFired).toBe(true);
		expect(result.winnerStrategy).toBe('fallback_ua');
		expect(result.outcomes.default).toBe('error');
		expect(result.outcomes.fallback_ua).toBe('valid');
	});

	test('全経路が invalid (thin) → 最速の invalid response を返す', async () => {
		const fetchFn = makeFetchByStrategy({
			default: { delayMs: 100, result: 'thin:champion', abortable: true },
			fallback_ua: { delayMs: 200, result: 'thin:fallback', abortable: true },
			proxy: { delayMs: 300, result: 'thin:proxy', abortable: true },
			curl_cffi: { delayMs: 400, result: 'thin:curl', abortable: true },
		});

		const racePromise = hedgedRace(
			{ champion: 'default', challengers: ['fallback_ua', 'proxy', 'curl_cffi'], thresholdMs: 5000 },
			fetchFn,
			isValid,
		);
		// champion 100ms で invalid (thin) → hedge fire → 全 challenger も invalid → 最速採用
		await vi.advanceTimersByTimeAsync(500);
		const result = await racePromise;

		// champion (default) が threshold 前に invalid で決着 → hedge fire → challengers のみ並列起動
		// (champion promise は inFlight に含まれない、Settled 済みで再利用しない設計)。
		// 全 challenger invalid → 最速の invalid result を採用。fallback_ua (200ms) が最速。
		expect(result.hedgeFired).toBe(true);
		expect(result.winnerStrategy).toBe('fallback_ua');
	});

	test('全経路が error → HedgedRaceAllFailedError', async () => {
		const fetchFn = makeFetchByStrategy({
			default: { delayMs: 50, result: null, throwOn: true, abortable: true },
			fallback_ua: { delayMs: 100, result: null, throwOn: true, abortable: true },
			proxy: { delayMs: 150, result: null, throwOn: true, abortable: true },
			curl_cffi: { delayMs: 200, result: null, throwOn: true, abortable: true },
		});

		// `.catch` を先に貼って unhandled rejection 抑制 (vi.useFakeTimers + rejects.toThrow の
		// micro-task ordering で reject が unhandled として観測されるのを防ぐ)
		const racePromise = hedgedRace(
			{ champion: 'default', challengers: ['fallback_ua', 'proxy', 'curl_cffi'], thresholdMs: 5000 },
			fetchFn,
			isValid,
		);
		const captured = racePromise.catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(300);
		const err = await captured;
		expect(err).toBeInstanceOf(HedgedRaceAllFailedError);
	});

	test('challenger プールが空 (champion only) で champion 失敗 → throw', async () => {
		const fetchFn = makeFetchByStrategy({
			default: { delayMs: 50, result: null, throwOn: true, abortable: true },
		});

		const racePromise = hedgedRace(
			{ champion: 'default', challengers: [], thresholdMs: 5000 },
			fetchFn,
			isValid,
		);
		const captured = racePromise.catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(100);
		const err = await captured;
		expect(err).toBeInstanceOf(HedgedRaceAllFailedError);
	});

	test('勝者確定後、残り inflight が abort される (signal 観測)', async () => {
		const aborts: DomainStrategy[] = [];
		const fetchFn: FetchStrategyFn<string> = (strategy, signal) =>
			new Promise<string | null>((resolve) => {
				const delay = strategy === 'default' ? 100 : 30000;
				const timer = setTimeout(() => resolve(`data:${strategy}-ok`), delay);
				signal.addEventListener('abort', () => {
					aborts.push(strategy);
					clearTimeout(timer);
					resolve(null);
				});
			});

		const racePromise = hedgedRace(
			{ champion: 'default', challengers: ['fallback_ua', 'proxy', 'curl_cffi'], thresholdMs: 5000 },
			fetchFn,
			isValid,
		);
		await vi.advanceTimersByTimeAsync(150);
		const result = await racePromise;

		expect(result.winnerStrategy).toBe('default');
		expect(result.hedgeFired).toBe(false);
		// hedge 発火しなかったので challengers は起動していない = abort もない
		expect(aborts).toEqual([]);
	});

	test('hedge 発火後の勝者確定で他 challenger が abort される', async () => {
		const aborts: DomainStrategy[] = [];
		const fetchFn: FetchStrategyFn<string> = (strategy, signal) =>
			new Promise<string | null>((resolve) => {
				let delay: number;
				if (strategy === 'default') delay = 30000; // 永遠に返らない (hedge 発火させる)
				else if (strategy === 'fallback_ua') delay = 100; // 勝者
				else delay = 30000; // 残りも永遠

				const timer = setTimeout(() => resolve(`data:${strategy}-ok`), delay);
				signal.addEventListener('abort', () => {
					aborts.push(strategy);
					clearTimeout(timer);
					resolve(null);
				});
			});

		const racePromise = hedgedRace(
			{ champion: 'default', challengers: ['fallback_ua', 'proxy', 'curl_cffi'], thresholdMs: 5000 },
			fetchFn,
			isValid,
		);
		// threshold 経過 + fallback_ua 100ms 勝ち → 残りすべて abort
		await vi.advanceTimersByTimeAsync(5200);
		const result = await racePromise;

		expect(result.hedgeFired).toBe(true);
		expect(result.winnerStrategy).toBe('fallback_ua');
		// default + proxy + curl_cffi が abort される
		expect(aborts).toContain('default');
		expect(aborts).toContain('proxy');
		expect(aborts).toContain('curl_cffi');
		// 勝者 (fallback_ua) は abort されない
		expect(aborts).not.toContain('fallback_ua');
	});

	test('isValidResponse が throw しても hedged race は止まらない (false 扱い)', async () => {
		const fetchFn = makeFetchByStrategy({
			default: { delayMs: 100, result: 'data:throws-on-validate' },
			fallback_ua: { delayMs: 200, result: 'data:fallback-valid', abortable: true },
		});
		const validateFn = (r: string) => {
			if (r === 'data:throws-on-validate') throw new Error('validator boom');
			return r.startsWith('data:');
		};

		const racePromise = hedgedRace(
			{ champion: 'default', challengers: ['fallback_ua'], thresholdMs: 5000 },
			fetchFn,
			validateFn,
		);
		await vi.advanceTimersByTimeAsync(300);
		const result = await racePromise;

		// validator が throw した default は invalid 扱い → hedge fire → fallback_ua が valid で勝ち
		expect(result.winnerStrategy).toBe('fallback_ua');
	});

	test('ALL_STRATEGIES export が DomainStrategy 全部を網羅', () => {
		expect(ALL_STRATEGIES).toEqual(['default', 'fallback_ua', 'proxy', 'curl_cffi']);
	});
});
