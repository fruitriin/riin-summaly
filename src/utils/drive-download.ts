/**
 * Google Drive の **直ストリーミング URL 解決** (phase19.1 followup #3)。
 *
 * Drive の `/preview` iframe player はスマホ幅でコントロール UI が崩れる (Drive 側の問題で
 * summaly からは直せない)。これを回避するため、自前の HTML5 `<video>` プレイヤーに
 * **Drive の download URL を直接** 流す。download URL は `Access-Control-Allow-Origin: *` +
 * `Accept-Ranges: bytes` を返すため、第三者サイトの `<video src>` から CORS + seek 付きで
 * 再生できる (実機確認 2026-06-01)。
 *
 * **confirm token の解決**: `drive.usercontent.google.com/download?id=<id>&export=download` は、
 * 大きいファイルだと「ウイルススキャンできません」確認 HTML を返す (gdown と同じ挙動)。その HTML の
 * `<form>` に含まれる `confirm` / `uuid` を付け直して再リクエストすると実バイナリに到達する。
 * 小さいファイルは確認を挟まず直接バイナリが返るため、その場合は素の download URL をそのまま使う。
 *
 * 本モジュールは **URL を 1 つ解決して返すだけ** (バイナリは中継しない)。実再生はブラウザ ↔ Drive 直
 * (summaly の帯域は消費しない)。
 */

import * as cheerio from 'cheerio';
import type { GeneralScrapingOptions } from '@/general.js';
import { getResponse, DEFAULT_FALLBACK_UA } from '@/utils/got.js';

const DOWNLOAD_HOST = 'drive.usercontent.google.com';

/** Drive 直ストリーミング URL を配信する origin (CSP `media-src` 用)。 */
export const DRIVE_DOWNLOAD_ORIGIN = `https://${DOWNLOAD_HOST}`;

// confirm 解決のためだけに download ページ HTML を読むので、cap は小さめ (確認 HTML は数 KB)。
const RESOLVE_MAX_BYTES = 256 * 1024;
const RESOLVE_TIMEOUT_MS = 8 * 1000;

/** file ID から素の download URL を組み立てる。 */
export function baseDownloadUrl(id: string): string {
	return `${DRIVE_DOWNLOAD_ORIGIN}/download?id=${encodeURIComponent(id)}&export=download`;
}

/**
 * download ページの確認 HTML から `confirm` / `uuid` を抽出して、解決済み download URL を組み立てる。
 * HTML が確認フォームでない (= 既に直接バイナリ) 場合や抽出失敗時は null を返す。テスト容易化のため export (pure)。
 */
export function resolveConfirmUrlFromHtml(id: string, html: string): string | null {
	// 確認ページは hidden input 群を持つ <form id="download-form" action="...download">。
	// `#download-form` を優先し、無ければ最初の form にフォールバック (Drive が id を変えた場合の保険)。
	const $ = cheerio.load(html);
	const form = $('#download-form').length > 0 ? $('#download-form') : $('form').first();
	if (form.length === 0) return null;
	const confirm = form.find('input[name="confirm"]').attr('value');
	const uuid = form.find('input[name="uuid"]').attr('value');
	if (typeof confirm !== 'string' || confirm === '') return null;
	// uuid は無い場合もある (confirm だけで通るケース) ため optional 扱い。
	const params = new URLSearchParams({ id, export: 'download', confirm });
	if (typeof uuid === 'string' && uuid !== '') params.set('uuid', uuid);
	return `${DRIVE_DOWNLOAD_ORIGIN}/download?${params.toString()}`;
}

/**
 * file ID から `<video src>` に使える直ストリーミング URL を解決する。
 *
 * 1. 素の download URL を取得する。
 * 2. content-type が image/video/octet-stream 等のバイナリ系なら、その URL がそのまま使える。
 * 3. text/html (= 確認ページ) なら HTML をパースして `confirm` / `uuid` 付き URL を組み立てる。
 *
 * 解決できなければ null (呼び元は iframe `/preview` 等にフォールバック)。
 */
export async function resolveDownloadUrl(id: string, opts?: GeneralScrapingOptions): Promise<string | null> {
	const url = baseDownloadUrl(id);
	try {
		const res = await getResponse({
			url,
			method: 'GET',
			headers: {
				'accept': 'text/html,application/octet-stream,*/*',
				'user-agent': opts?.userAgent ?? DEFAULT_FALLBACK_UA,
			},
			// HTML 確認ページ or バイナリ。両方許容 (typeFilter で絞ると確認ページが弾かれる)。
			// content-type を見たいだけなので、バイナリが返るケースで全量受信しないよう useRange で先頭のみ要求。
			// 直接バイナリのファイル (確認不要な小サイズ) でも contentLengthLimit (256 KB) で打ち切られる二重防御。
			useRange: true,
			responseTimeout: RESOLVE_TIMEOUT_MS,
			contentLengthLimit: RESOLVE_MAX_BYTES,
			followRedirects: true,
		});
		const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
		if (!contentType.startsWith('text/html')) {
			// 確認を挟まず直接バイナリが返るファイル → 素の download URL がそのまま使える。
			return url;
		}
		// 確認ページ → confirm/uuid を抽出して解決済み URL を組み立てる。
		return resolveConfirmUrlFromHtml(id, String(res.body));
	} catch {
		return null;
	}
}
