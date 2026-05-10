/**
 * Hedged race for fetch strategies (phase18).
 *
 * 経路選定を全自動化するための「champion / challenger pool」並列発火機構。
 *
 * 発火フロー:
 * 1. champion を即起動
 * 2. champion が `thresholdMs` 以内に valid な response を返したら採用 (hedgeFired = false、定常状態)
 * 3. champion が `thresholdMs` 経過 or 失敗 → challengers 全員を並列起動 (hedgeFired = true)
 * 4. `Promise.any` で最初に valid を返した経路を採用 + 残り inflight を AbortController で cancel
 * 5. 全経路が invalid なら最速の (thin) response を返す。全 error なら集約 throw
 * 6. 勝者が champion でなければ、呼出側が cache に新 champion として昇格させる
 *
 * 設計判断 (`docs/plans/phase18-hedged-fallback.md` 参照):
 * - 昇格は 1 回で確定 (N 連続要件なし)。並列発火そのものが「champion 不適切」シグナルを内包している
 * - 降格・除外メカ無し。並列発火がレアイベントなら無駄経路への投入は許容コスト
 */

import type { DomainStrategy } from '@/utils/domain-strategy-cache.js';

/**
 * 全 strategy 一覧。`challengers` は通常 `ALL_STRATEGIES - champion` で導出する。
 */
export const ALL_STRATEGIES: readonly DomainStrategy[] = ['default', 'fallback_ua', 'proxy', 'curl_cffi'];

export interface HedgedRaceConfig {
	/** 第一候補。即起動 */
	champion: DomainStrategy;
	/** 並列発火対象 (= ALL_STRATEGIES - champion - 起動不可な経路) */
	challengers: readonly DomainStrategy[];
	/**
	 * champion 起動から N ms 経過したら challengers を並列起動 (default 5000)。
	 * 0 にすると champion と challengers が同時起動 (= 完全並列。debug / explore 用途)。
	 */
	thresholdMs: number;
	/**
	 * オプション: champion が threshold 内に error で fail した場合、その error を見て
	 * 「並列発火しても結果が変わらない確定 error」かを判別するフィルタ。
	 *
	 * `true` を返したら hedge fire せず error をそのまま throw する (challenger 起動なし)。
	 * `false` (or 未指定) なら通常通り hedge fire (challenger を並列起動)。
	 *
	 * 用途: 404 / 403 / Private IP rejected / Invalid URL のような **サイトが意図的に返した
	 * 確定 error** は別経路で叩いても同じ結果になる可能性が高いため、無駄リクエストを
	 * 防ぐために skip する。
	 */
	isFinalError?: (error: unknown) => boolean;
}

export interface HedgedRaceResult<T> {
	response: T;
	winnerStrategy: DomainStrategy;
	/** 並列発火が起きたか (`false` = champion 単独で valid を返した) */
	hedgeFired: boolean;
	/** 各経路の completion latency (ms)。abort された経路は記録されない場合がある */
	latencyMs: Partial<Record<DomainStrategy, number>>;
	/** 各経路の最終結果 (valid / invalid / error / aborted)。pino ログ用 */
	outcomes: Partial<Record<DomainStrategy, HedgedOutcome>>;
}

export type HedgedOutcome = 'valid' | 'invalid' | 'error' | 'gate_failed';

/**
 * `fetchByStrategy` の関数シグネチャ。
 *
 * - 戻り値が `null` = ゲート不通過 (config 上使えない、中立)
 * - throw = 実行時失敗
 * - signal の abort 通知に従ってリクエストを中断する責務を負う
 */
export type FetchStrategyFn<T> = (
	strategy: DomainStrategy,
	signal: AbortSignal,
) => Promise<T | null>;

/**
 * 取得した response が valid かを判定。同期 / async 両対応。
 *
 * **設計選択 (got.ts での呼び出し)**: HTTP 層では `() => true` を渡し、thin 判定は Summary 層
 * (`isThinSummary`) で別途行う設計。理由: HTTP 層で thin 判定すると「全 invalid → 最速 thin 採用」
 * フローが起動するが、その後 summary 層でも同じ判定をするため二重計算になる。HTTP 層で「取得成功 = valid」
 * とすることで `Promise.any` の最初の resolve で早期決着 (= 多くの定常ケースで thin 判定不要)。
 * thin 判定を HTTP 層に下ろす場合は呼出側で本関数に `(r) => !isThinSummary(...)` を渡す。
 */
export type ValidityCheckFn<T> = (response: T) => boolean | Promise<boolean>;

/**
 * 全経路が失敗したときに throw される集約エラー。
 *
 * `causes` で各経路の失敗原因を保持。pino ログには `causes.map(c => c.strategy + ': ' + c.error.message)`
 * で十分な診断情報が出る。
 *
 * **phase18.1 修正**: catch 経路でも hedge 情報を伝搬するため `hedgeFired` / `outcomes` / `latencyMs` を含める。
 * (本番診断で「hedge fire したのに challenger 全 gate_failed で throw」のときも `hedge_fired: true` ログを出すため)
 */
export class HedgedRaceAllFailedError extends Error {
	readonly causes: ReadonlyArray<{ strategy: DomainStrategy; error: unknown }>;
	readonly hedgeFired: boolean;
	readonly outcomes: Partial<Record<DomainStrategy, HedgedOutcome>>;
	readonly latencyMs: Partial<Record<DomainStrategy, number>>;
	constructor(
		causes: ReadonlyArray<{ strategy: DomainStrategy; error: unknown }>,
		extras: {
			hedgeFired?: boolean;
			outcomes?: Partial<Record<DomainStrategy, HedgedOutcome>>;
			latencyMs?: Partial<Record<DomainStrategy, number>>;
		} = {},
	) {
		const summary = causes
			.map((c) => `${c.strategy}: ${c.error instanceof Error ? c.error.message : String(c.error)}`)
			.join('; ');
		super(`hedged race: all strategies failed (${summary})`);
		this.name = 'HedgedRaceAllFailedError';
		this.causes = causes;
		this.hedgeFired = extras.hedgeFired ?? false;
		this.outcomes = extras.outcomes ?? {};
		this.latencyMs = extras.latencyMs ?? {};
	}
}

type Settled<T> = {
	strategy: DomainStrategy;
	result: T | null;
	error: unknown;
};

/**
 * Hedged race の本体。
 *
 * @param config champion / challengers / thresholdMs
 * @param fetchByStrategy strategy ごとに fetch を起動する関数 (AbortSignal を尊重する責務あり)
 * @param isValidResponse response が valid (= preview として使える) かを判定する関数
 * @returns 勝者経路 + response + 各経路の outcome / latency
 * @throws HedgedRaceAllFailedError 全経路が error / gate_failed のとき (= 完全失敗)
 */
export async function hedgedRace<T>(
	config: HedgedRaceConfig,
	fetchByStrategy: FetchStrategyFn<T>,
	isValidResponse: ValidityCheckFn<T>,
): Promise<HedgedRaceResult<T>> {
	const startTime = Date.now();
	const latencyMs: Partial<Record<DomainStrategy, number>> = {};
	const outcomes: Partial<Record<DomainStrategy, HedgedOutcome>> = {};
	const aborters = new Map<DomainStrategy, AbortController>();
	// 勝者を outer scope に持つことで finally の「二重防御 abort」で勝者を skip できる
	// (勝者は既に resolve 済みだが、signal の abort listener が後追いで発火して
	// 副作用を起こすケースを防ぐ)
	let winnerStrategy: DomainStrategy | undefined;
	// champion が threshold 前に失敗したときの error を outer scope に保持。
	// inFlight には challengers のみが入るため、全 reject 時の cause 集計で
	// champion error が漏れないように後で補填する。
	let championError: unknown;

	const launchStrategy = (strategy: DomainStrategy): Promise<Settled<T>> => {
		const ac = new AbortController();
		aborters.set(strategy, ac);
		return fetchByStrategy(strategy, ac.signal)
			.then((result) => {
				latencyMs[strategy] = Date.now() - startTime;
				return { strategy, result, error: undefined };
			})
			.catch((error) => {
				latencyMs[strategy] = Date.now() - startTime;
				return { strategy, result: null, error };
			});
	};

	let thresholdHandle: ReturnType<typeof setTimeout> | undefined;

	try {
		const championPromise = launchStrategy(config.champion);

		// threshold タイマ — champion 単独勝負のための時間窓
		const thresholdPromise = new Promise<'__threshold__'>((resolve) => {
			thresholdHandle = setTimeout(() => resolve('__threshold__'), Math.max(0, config.thresholdMs));
		});

		// race champion vs threshold
		const first = await Promise.race([championPromise, thresholdPromise]);

		if (first !== '__threshold__') {
			// champion が threshold 前に決着 (成功 or 失敗)
			if (first.error == null && first.result != null) {
				const valid = await classifyValidity(first.result, isValidResponse);
				if (valid) {
					outcomes[config.champion] = 'valid';
					winnerStrategy = config.champion;
					return {
						response: first.result,
						winnerStrategy: config.champion,
						hedgeFired: false,
						latencyMs,
						outcomes,
					};
				}
				outcomes[config.champion] = 'invalid';
			} else {
				outcomes[config.champion] = first.error != null ? 'error' : 'gate_failed';
				if (first.error != null) {
					championError = first.error;
					// champion が確定 error (404 / SSRF block / unsupported_type 等) で失敗した場合、
					// 別経路で叩いても結果が変わる見込みが薄いため hedge fire を skip
					if (config.isFinalError?.(first.error) === true) {
						throw first.error;
					}
				}
			}
			// champion 不調 (retryable) → hedge 発火 (champion promise は既に settled、再利用しない)
		}
		// それ以外は threshold 経過 → champion 継続 + challengers 並列発火

		// hedge fire
		const challengerPromises = config.challengers.map(launchStrategy);
		const inFlight: Array<Promise<Settled<T>>> = first === '__threshold__'
			? [championPromise, ...challengerPromises]
			: challengerPromises;

		// Promise.any: 最初に valid を返した経路を採用。
		// 各 wrapper promise に `.catch(() => {})` を chained 追加して unhandled rejection を抑制
		// (Promise.any が AggregateError で reject すると wrapper の reject が unhandled として拾われるため)
		const wrappers = inFlight.map((p) =>
			p.then(async (settled) => {
				// 元 error をそのまま throw する (wrapper で `new Error('error')` に置き換えると
				// fetchResponse catch 側で StatusError 等の category 情報が失われて `unknown` 化する)
				if (settled.error != null) throw settled.error;
				if (settled.result == null) throw new Error('gate_failed');
				const valid = await classifyValidity(settled.result, isValidResponse);
				if (!valid) throw new Error('invalid');
				return settled;
			}),
		);
		// unhandled rejection 抑制 (Promise.any 自体の reject は外側 try/catch で受ける)
		wrappers.forEach((w) => { w.catch(() => { /* noop */ }); });

		try {
			const validResult = await Promise.any(wrappers);
			outcomes[validResult.strategy] = 'valid';
			winnerStrategy = validResult.strategy;
			// 残り inflight を abort
			for (const [s, ac] of aborters) {
				if (s !== validResult.strategy) ac.abort();
			}
			// 他経路の outcome を非同期に拾って outcomes に反映 (caller の log 用、await はしない)
			void Promise.allSettled(inFlight).then((settledList) => {
				for (const r of settledList) {
					if (r.status !== 'fulfilled') continue;
					const s = r.value.strategy;
					if (outcomes[s] != null) continue;
					outcomes[s] = r.value.error != null
						? 'error'
						: (r.value.result == null ? 'gate_failed' : 'invalid');
				}
			});
			return {
				response: validResult.result as T,
				winnerStrategy: validResult.strategy,
				hedgeFired: true,
				latencyMs,
				outcomes,
			};
		} catch {
			// Promise.any が AggregateError で reject = 全経路が error / gate_failed / invalid
			// 全 settled を集めて、最速の thin (= invalid だが result あり) を返す
			const settledList = await Promise.all(inFlight);

			// outcomes に反映
			for (const s of settledList) {
				if (outcomes[s.strategy] != null) continue;
				outcomes[s.strategy] = s.error != null
					? 'error'
					: (s.result == null ? 'gate_failed' : 'invalid');
			}

			// 最速の invalid (= thin だが result あり) を選ぶ
			const invalidsWithResult = settledList
				.filter((s) => s.error == null && s.result != null)
				.sort((a, b) => (latencyMs[a.strategy] ?? Infinity) - (latencyMs[b.strategy] ?? Infinity));
			if (invalidsWithResult.length > 0) {
				const winner = invalidsWithResult[0];
				winnerStrategy = winner.strategy;
				return {
					response: winner.result as T,
					winnerStrategy: winner.strategy,
					hedgeFired: true,
					latencyMs,
					outcomes,
				};
			}

			// 全 error / gate_failed → 集約 throw
			const causes: Array<{ strategy: DomainStrategy; error: unknown }> = settledList
				.filter((s) => s.error != null)
				.map((s) => ({ strategy: s.strategy, error: s.error }));
			// champion error が threshold 前に確定していて inFlight に含まれていない場合、補填する
			if (championError != null && !causes.some((c) => c.strategy === config.champion)) {
				causes.unshift({ strategy: config.champion, error: championError });
			}
			// hedge 情報 (hedgeFired / outcomes / latencyMs) を error に載せて catch 側に伝える。
			// hedge fire しているケース (= 全 challenger fail で error 集約) でも本番診断が可能。
			const hedgeInfo = { hedgeFired: true, outcomes: { ...outcomes }, latencyMs: { ...latencyMs } };
			if (causes.length === 0) {
				// 全 gate_failed (= config 上使える経路がなかった、champion も即時 gate_failed だった)
				throw new HedgedRaceAllFailedError(
					settledList.map((s) => ({ strategy: s.strategy, error: new Error('gate failed (no strategy enabled)') })),
					hedgeInfo,
				);
			}
			throw new HedgedRaceAllFailedError(causes, hedgeInfo);
		}
	} finally {
		if (thresholdHandle != null) clearTimeout(thresholdHandle);
		// 二重防御: 残っている inflight を全 abort (勝者は除外。signal の abort listener が
		// 後追いで発火して副作用を起こすのを避ける)
		for (const [s, ac] of aborters) {
			if (s === winnerStrategy) continue;
			try { ac.abort(); } catch { /* AbortController.abort は throw しないが defense-in-depth */ }
		}
	}
}

/**
 * `isValidResponse` の評価で throw が起きても false 扱いに丸める。
 * (validator が throw すると hedge 全体が abort される事故を防ぐ)
 */
async function classifyValidity<T>(response: T, isValidResponse: ValidityCheckFn<T>): Promise<boolean> {
	try {
		return await isValidResponse(response);
	} catch {
		return false;
	}
}
