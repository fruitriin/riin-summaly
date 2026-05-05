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

// --- フォーム送信 → /api/summaly --------------------------------------------

form.addEventListener('submit', async (ev) => {
	ev.preventDefault();
	const url = urlInput.value.trim();
	if (!url) return;
	await runFetch(url);
});

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
	const allowed = $$('#allowed-plugins input:checked').map(cb => cb.value);
	if (allowed.length > 0) params.set('allowedPlugins', allowed.join(','));

	try {
		const res = await fetch(`/api/summaly?${params.toString()}`);
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
		showError(e.message ?? String(e));
		paneJson.textContent = '';
	} finally {
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

function renderCard(result) {
	paneCard.innerHTML = '';
	const card = document.createElement('div');
	card.className = 'mk-card';

	const thumb = result.thumbnail;
	if (thumb && /^https?:|^data:/i.test(thumb)) {
		const img = document.createElement('img');
		img.className = 'thumbnail';
		img.src = thumb;
		img.alt = '';
		img.addEventListener('error', () => img.remove());
		card.appendChild(img);
	}

	const body = document.createElement('div');
	body.className = 'body';

	if (result.icon && /^https?:|^data:/i.test(result.icon)) {
		const icon = document.createElement('img');
		icon.className = 'icon';
		icon.src = result.icon;
		icon.alt = '';
		icon.addEventListener('error', () => icon.remove());
		body.appendChild(icon);
	}

	const meta = document.createElement('div');
	meta.className = 'meta';

	if (result.sensitive) {
		const sens = document.createElement('div');
		sens.className = 'sensitive-label';
		sens.textContent = '⚠ センシティブな内容';
		meta.appendChild(sens);
	}

	if (result.sitename) {
		const sn = document.createElement('div');
		sn.className = 'sitename';
		sn.textContent = result.sitename;
		meta.appendChild(sn);
	}

	const title = document.createElement('div');
	title.className = 'title';
	title.textContent = result.title ?? '(no title)';
	meta.appendChild(title);

	if (result.description) {
		const desc = document.createElement('p');
		desc.className = 'description';
		desc.textContent = result.description;
		meta.appendChild(desc);
	}

	if (result.url) {
		const url = document.createElement('div');
		url.className = 'url';
		url.textContent = result.url;
		meta.appendChild(url);
	}

	body.appendChild(meta);
	card.appendChild(body);
	paneCard.appendChild(card);
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

	// summaly 出口で sanitize 済みだが、UI 側でも防御的に https のみ通す
	if (!/^https:\/\//i.test(player.url)) {
		const warn = document.createElement('div');
		warn.className = 'empty';
		warn.textContent = `player.url が非 https のためレンダリングをスキップしました: ${player.url}`;
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

	const iframe = document.createElement('iframe');
	iframe.src = player.url;
	if (player.width != null) {
		iframe.width = String(player.width);
	} else {
		iframe.style.width = '100%';
	}
	iframe.height = String(player.height);
	if (Array.isArray(player.allow) && player.allow.length > 0) {
		iframe.setAttribute('allow', player.allow.join('; '));
	}
	iframe.setAttribute('referrerpolicy', 'no-referrer');
	iframe.setAttribute('sandbox', IFRAME_SANDBOX);
	iframe.setAttribute('loading', 'lazy');
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
