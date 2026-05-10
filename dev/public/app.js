// summaly dev UI — Vanilla JS
// 役割:
// - URL を入力して /api/summaly?url=... を叩く
// - 結果を JSON / カード / iframe の 3 タブで表示する
// - サンプル URL 集をワンクリックで入力欄に流し込む
// - allowedPlugins / lang / useRange / enablePdf を設定する

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// iframe sandbox 設定 — Misskey の MkUrlPreview と揃える。
// allow-popups は YouTube の "他のサイトで見る" ボタン用。
const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-presentation allow-popups';

const form = $('#form');
const urlInput = $('#url-input');
const langInput = $('#lang-input');
const useRangeInput = $('#useRange');
const enablePdfInput = $('#enablePdf');
const proxyInput = $('#proxy');
const proxyRow = $('#proxy-row');
const proxyHint = $('#proxy-hint');
const allowedPluginsContainer = $('#allowed-plugins');
const sampleGroupsContainer = $('#sample-groups');
const errorBox = $('#error');
const fetchButton = $('#fetch-button');

const paneJson = $('#pane-json');
const paneCard = $('#pane-card');
const panePlayer = $('#pane-player');

let lastResult = null;

// --- サンプル URL & プラグイン名一覧の取得 ----------------------------------

async function loadSamples() {
	try {
		const res = await fetch('/api/sample-urls');
		const data = await res.json();
		renderPluginCheckboxes(data.plugins);
		renderSampleGroups(data.groups);
	} catch (e) {
		console.error('Failed to load samples', e);
	}
}

// dev サーバ起動時の env 状態を取得し、proxy fallback の checkbox 表示を切り替える (phase12.1)。
async function loadDevConfig() {
	try {
		const res = await fetch('/api/dev-config');
		const data = await res.json();
		if (data.proxyAvailable) {
			proxyRow.hidden = false;
			proxyHint.textContent = `proxy: ${data.proxyHost}`;
		}
	} catch (e) {
		console.error('Failed to load dev config', e);
	}
}

function renderPluginCheckboxes(plugins) {
	allowedPluginsContainer.innerHTML = '';
	for (const name of plugins) {
		const id = `allowed-${name}`;
		const wrapper = document.createElement('label');
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.id = id;
		cb.name = 'allowedPlugins';
		cb.value = name;
		const text = document.createTextNode(name);
		wrapper.append(cb, text);
		allowedPluginsContainer.appendChild(wrapper);
	}
}

function renderSampleGroups(groups) {
	sampleGroupsContainer.innerHTML = '';
	for (const group of groups) {
		const section = document.createElement('div');
		section.className = 'sample-group';

		const h = document.createElement('h3');
		h.textContent = group.name;
		section.appendChild(h);

		const p = document.createElement('p');
		p.textContent = group.description;
		section.appendChild(p);

		const ul = document.createElement('ul');
		ul.className = 'sample-list';
		for (const sample of group.urls) {
			const li = document.createElement('li');
			const a = document.createElement('a');
			a.textContent = sample.label;
			a.title = sample.url;
			a.href = '#';
			a.addEventListener('click', (ev) => {
				ev.preventDefault();
				urlInput.value = sample.url;
				applyPresets(sample.presets);
				urlInput.focus();
			});
			li.appendChild(a);
			if (sample.note) {
				const note = document.createElement('span');
				note.className = 'note';
				note.textContent = `— ${sample.note}`;
				li.appendChild(note);
			}
			ul.appendChild(li);
		}
		section.appendChild(ul);

		sampleGroupsContainer.appendChild(section);
	}
}

/** サンプル URL をクリックしたときに、フォームのチェックボックス類を自動設定する */
function applyPresets(presets) {
	if (!presets) return;
	if (presets.enablePdf != null) enablePdfInput.checked = presets.enablePdf;
	if (presets.useRange != null) useRangeInput.checked = presets.useRange;
	if (presets.proxy != null && !proxyRow.hidden) proxyInput.checked = presets.proxy;
	if (presets.allowedPlugins) {
		const allowed = new Set(presets.allowedPlugins);
		$$('#allowed-plugins input').forEach((cb) => { cb.checked = allowed.has(cb.value); });
	}
}

// --- フォーム送信 → /api/summaly --------------------------------------------

form.addEventListener('submit', async (ev) => {
	ev.preventDefault();
	const url = urlInput.value.trim();
	if (!url) return;
	await runFetch(url);
});

// 進行中リクエストの AbortController。連続クリック・別 URL への切り替え時に古いリクエストを明示中断する
// （古いリクエストが裏で残ってて新規発射が "Failed to fetch" になる事故を防ぐ）。
let inFlightController = null;
// fetch にデフォルトタイムアウトが無いため明示的な timeout を入れる。amazon 等の重いサイト対応で 90 秒。
const FETCH_TIMEOUT_MS = 90 * 1000;

async function runFetch(url) {
	hideError();
	fetchButton.disabled = true;
	paneJson.textContent = '取得中...';
	paneCard.innerHTML = '';
	panePlayer.innerHTML = '';

	const params = new URLSearchParams();
	params.set('url', url);

	const lang = langInput.value.trim();
	if (lang) params.set('lang', lang);

	// dev サーバは /api/summaly でクエリを毎回 summaly() の options に変換するため、
	// useRange / enablePdf / allowedPlugins もリクエスト単位で切り替えられる。
	if (useRangeInput.checked) params.set('useRange', '1');
	if (enablePdfInput.checked) params.set('enablePdf', '1');
	// proxy fallback (phase12.1) — checkbox は env が両方セットされているときだけ表示される。
	// `!proxyRow.hidden` ガード (S-1): hidden のときは送信しない (defense-in-depth、サーバ側 `proxyAvailable` ガードに二重保険)
	if (proxyInput.checked && !proxyRow.hidden) params.set('proxy', '1');
	const allowed = $$('#allowed-plugins input:checked').map(cb => cb.value);
	if (allowed.length > 0) params.set('allowedPlugins', allowed.join(','));

	// 古いリクエストを中断 + 新規 AbortController を生成
	if (inFlightController != null) inFlightController.abort();
	const controller = new AbortController();
	inFlightController = controller;
	const timeoutId = setTimeout(() => controller.abort(new Error(`timeout (${FETCH_TIMEOUT_MS / 1000}s)`)), FETCH_TIMEOUT_MS);

	// 経過時間ティック表示（重いサイトで無反応に見える事故を防ぐ）
	const startedAt = Date.now();
	const tick = setInterval(() => {
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
		paneJson.textContent = `取得中... ${elapsed}s`;
	}, 250);

	try {
		const res = await fetch(`/api/summaly?${params.toString()}`, { signal: controller.signal });
		const text = await res.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error(`非 JSON レスポンス (status=${res.status}):\n${text.slice(0, 500)}`);
		}

		if (!res.ok) {
			showError(`status=${res.status}\n${JSON.stringify(json, null, 2)}`);
			paneJson.textContent = JSON.stringify(json, null, 2);
			lastResult = null;
			return;
		}

		lastResult = json;
		renderResult(json);
	} catch (e) {
		// AbortError は「古いリクエストを意図して中断した」ケースが多い。新規リクエストの完了表示で
		// 上書きされるため、エラー表示は出さずに paneJson もクリアしない（前の表示を残す）
		if (e?.name === 'AbortError' && controller.signal.reason?.message?.startsWith('timeout')) {
			showError(`タイムアウト: ${FETCH_TIMEOUT_MS / 1000}s 以内にレスポンスが返りませんでした (heavy なサイト or サーバ応答停止)`);
			paneJson.textContent = '';
		} else if (e?.name !== 'AbortError') {
			// "TypeError: Failed to fetch" 系: ネットワーク失敗 / CORS / TLS / proxy 切断 等
			const hint = e?.message === 'Failed to fetch'
				? '\n(原因候補: dev サーバが落ちた / 接続が切られた / ブラウザ拡張がブロックした)'
				: '';
			showError((e?.message ?? String(e)) + hint);
			paneJson.textContent = '';
		}
	} finally {
		clearTimeout(timeoutId);
		clearInterval(tick);
		// 自分が最後の controller のままなら null に戻す（古い request の finally では触らない）
		if (inFlightController === controller) inFlightController = null;
		fetchButton.disabled = false;
	}
}

// --- 結果表示 ---------------------------------------------------------------

function renderResult(result) {
	paneJson.textContent = JSON.stringify(result, null, 2);
	renderCard(result);
	renderPlayer(result);
	updatePlayerTabState(result);
	// 取得のたびにカードプレビュータブへ戻す（player なしのときに iframe タブを見せ続けないため）
	activateTab('card');
}

/** player.url が無いと iframe タブをグレーアウトする（クリック自体は可能、視覚的に「null」を伝える） */
function updatePlayerTabState(result) {
	const playerTab = document.querySelector('.tab[data-tab="player"]');
	if (!playerTab) return;
	const hasPlayer = result?.player?.url != null;
	playerTab.classList.toggle('is-null', !hasPlayer);
	playerTab.title = hasPlayer ? '' : 'player.url が null';
}

/** 指定タブをアクティブにする（タブ click handler と同じ挙動を関数化） */
function activateTab(target) {
	$$('.tab').forEach((b) => {
		const active = b.dataset.tab === target;
		b.classList.toggle('active', active);
		b.setAttribute('aria-selected', active ? 'true' : 'false');
	});
	$$('.tab-pane').forEach((p) => {
		const active = p.id === `pane-${target}`;
		p.classList.toggle('active', active);
		p.hidden = !active;
	});
}

// Misskey の Note timeline で使われる compact mode 風レイアウト:
// 左に 120sq の正方形サムネイル / 右に sitename + title + description + url。
// 旧実装は 100% 幅バナーだったため、profile 画像が thumbnail にフォールバックされる
// プラグイン（twitter 等）でアイコンが過剰に主張する問題があった。
function renderCard(result) {
	paneCard.innerHTML = '';
	const card = document.createElement('div');
	card.className = 'mk-card';

	// 左カラム: thumbnail（無ければ icon にフォールバック、どちらも無ければ thumb 自体を出さない）
	const thumbSrc = pickSafeImageUrl(result.thumbnail) ?? pickSafeImageUrl(result.icon);
	if (thumbSrc != null) {
		const thumbBox = document.createElement('div');
		thumbBox.className = 'thumb';
		const img = document.createElement('img');
		img.src = thumbSrc;
		img.alt = '';
		img.addEventListener('error', () => thumbBox.remove());
		thumbBox.appendChild(img);
		card.appendChild(thumbBox);
	}

	// 右カラム: meta
	const body = document.createElement('div');
	body.className = 'body';

	if (result.sensitive) {
		const sens = document.createElement('div');
		sens.className = 'sensitive-label';
		sens.textContent = '⚠ センシティブな内容';
		body.appendChild(sens);
	}

	// sitename 行: 小さい favicon (16px) + sitename テキストを横並び
	if (result.sitename || result.icon) {
		const snRow = document.createElement('div');
		snRow.className = 'sitename-row';
		const faviconSrc = pickSafeImageUrl(result.icon);
		if (faviconSrc != null) {
			const fav = document.createElement('img');
			fav.className = 'favicon';
			fav.src = faviconSrc;
			fav.alt = '';
			fav.addEventListener('error', () => fav.remove());
			snRow.appendChild(fav);
		}
		if (result.sitename) {
			const snText = document.createElement('span');
			snText.className = 'sitename';
			snText.textContent = result.sitename;
			snRow.appendChild(snText);
		}
		body.appendChild(snRow);
	}

	const title = document.createElement('div');
	title.className = 'title';
	title.textContent = result.title ?? '(no title)';
	body.appendChild(title);

	if (result.description) {
		const desc = document.createElement('p');
		desc.className = 'description';
		desc.textContent = result.description;
		body.appendChild(desc);
	}

	if (result.url) {
		const url = document.createElement('div');
		url.className = 'url';
		url.textContent = result.url;
		body.appendChild(url);
	}

	card.appendChild(body);
	paneCard.appendChild(card);
}

/**
 * `result.thumbnail` / `result.icon` などをそのまま `<img src>` に流すと
 * `javascript:` 等の危険な URL を踏みうるため、http(s) / data: 以外を弾く。
 * summaly 出口の sanitizeUrl も同等のことをしているが UI 側でも二重ガード。
 */
function pickSafeImageUrl(value) {
	if (typeof value !== 'string' || value === '') return null;
	if (!/^https?:|^data:/i.test(value)) return null;
	return value;
}

function renderPlayer(result) {
	panePlayer.innerHTML = '';
	const player = result.player;
	if (!player || !player.url) {
		const empty = document.createElement('div');
		empty.className = 'empty';
		empty.textContent = 'この URL には iframe プレーヤーがありません (player.url が null)';
		panePlayer.appendChild(empty);
		return;
	}

	// summaly 出口で sanitize 済みだが、UI 側でも防御的に https のみ通す。
	// dev サーバ自身が組み立てる localhost / 127.0.0.1 (= 自前 /embed エンドポイント) も許可
	// (本番と同じ embed iframe の動作確認のため)。
	const isHttps = /^https:\/\//i.test(player.url);
	const isLocalDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(player.url);
	if (!isHttps && !isLocalDev) {
		const warn = document.createElement('div');
		warn.className = 'empty';
		warn.textContent = `player.url が非 https かつ非 localhost のためレンダリングをスキップしました: ${player.url}`;
		panePlayer.appendChild(warn);
		return;
	}

	// player.height が null の場合は iframe を出さない（Misskey の MkUrlPreview に揃える）
	if (player.height == null) {
		const warn = document.createElement('div');
		warn.className = 'empty';
		warn.textContent = 'player.height が null のため iframe をレンダリングしません';
		panePlayer.appendChild(warn);
		return;
	}

	// 実寸ラベル: summaly が返した width × height を表示（dev での見やすさのため iframe は CSS で拡大表示）
	const meta = document.createElement('div');
	meta.className = 'player-meta';
	const w = player.width ?? '?';
	const h = player.height ?? '?';
	meta.textContent = `summaly が返した player サイズ: ${w} × ${h} (dev では aspect ratio を保ったまま拡大表示)`;
	panePlayer.appendChild(meta);

	const iframe = document.createElement('iframe');
	iframe.src = player.url;
	// dev では `iframe.width` / `iframe.height` 属性を設定せず、CSS で 100% 幅 + aspect-ratio で拡大表示する。
	// summaly の YouTube oEmbed は 200x113 等の小さい寸法を返すため、属性をそのまま使うと
	// 視覚的に「動作していない」ように見えてしまう。実寸はラベルで別途確認できる。
	if (player.width && player.height) {
		iframe.style.aspectRatio = `${player.width} / ${player.height}`;
	}
	if (Array.isArray(player.allow) && player.allow.length > 0) {
		iframe.setAttribute('allow', player.allow.join('; '));
	}
	// dev では referrerpolicy を browser default (strict-origin-when-cross-origin) のままにする。
	// Misskey 本番は privacy 目的で `no-referrer` を使うが、その状態だと YouTube の oEmbed 埋め込み
	// (`?feature=oembed`) が空 Referer を理由にエラー 153「動画プレーヤーの設定エラー」を返す。
	// dev は「summaly の出力どおりに iframe が機能するか」を確認するのが目的のため、
	// embed 側の referrer 検証を通せる挙動を優先する。
	iframe.setAttribute('sandbox', IFRAME_SANDBOX);
	panePlayer.appendChild(iframe);
}

// --- タブ切替 ---------------------------------------------------------------

$$('.tab').forEach((btn) => {
	btn.addEventListener('click', () => {
		activateTab(btn.dataset.tab);
	});
});

// --- エラー表示 -------------------------------------------------------------

function showError(message) {
	errorBox.textContent = message;
	errorBox.hidden = false;
}

function hideError() {
	errorBox.textContent = '';
	errorBox.hidden = true;
}

// --- 起動 -------------------------------------------------------------------

loadSamples();
loadDevConfig();
