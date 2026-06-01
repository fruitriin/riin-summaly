(unreleased)
------------------
* **fix (plugin: google-drive / embed)**: **デスクトップで縦動画が巨大表示される問題**を修正。背景: summaly は PC/SP を判別できない固定レスポンスのため、デスクトップの広いカード幅で縦動画 (実比率 h/w≈1.78) をそのまま比率で渡すと、Misskey の `padding-top=(height/width)*100%` で高さが過大になり画面を埋める。対策: **縦動画 (h/w>1) は `player.width=null` + `player.height=480px` (固定 px 高さ) を返す**。Misskey の `MkUrlPreview.vue` は `player.width` が falsy のとき高さ計算を `padding-top:<height>px` (= **画面幅に依存しない絶対 px**) に切り替えるため、**デスクトップ/スマホ問わず高さが 480px 一定**になり巨大化しない。その固定 px の箱に内側 Drive iframe を **`object-fit:contain` 相当 (レターボックス)** で収めるため、`renderScaledIframeEmbed` を contain 方式 (二重 iframe) に変更: 内側 Drive iframe は **実比率のまま描画**し、`container-type: size` (cqi 幅 / cqb 高さ) + 中央寄せ + `transform: scale(min(100cqi/RW, 100cqb/innerHeight))` で外箱に収める。これで縦動画はクロップされず実比率のまま左右余白付きで表示される。横動画・正方形 (h/w<=1) は従来通り実比率 (幅に応じた自然な高さ)。`applyMeta` / `renderEmbed` の `playerBox` + `renderScaledIframeEmbed` の contain テストを更新 (計 717 件 pass)
* **refactor (plugin: google-drive / embed) [PR #2 code-review 対応]**: code-review で挙がった 9 件を対処。**(#1 アスペクト比対策)** `MAX_DIM` の絶対値上限は `1×32767` のような極端比を素通しし Misskey の `padding-top=(height/width)*100%` を破綻/巨大化させるため、`applyMeta` / `renderEmbed` で **dims→player の写像層で比率を別途 bound** する (絶対値上限とは別レイヤ)。最終的に縦動画は固定 px 高さ方式に発展 (上記 fix 参照)。**(#2 JPEG off-by-one)** `readJpegDimensions` の `while (offset+9 < len)` を `<= len` に修正 (width が buffer 末尾ぴったりの valid JPEG を取りこぼしていた)。**(#3 二重フェッチ統合)** `summarize` と `renderEmbed` が同じ thumbnail/title フェッチを二重実行していたのを `resolveDriveMeta(id, opts)` に共通化。**(#4 Range + 軽量抽出)** thumbnail/title フェッチに `Range: bytes=0-65535` を付けて全体 DL を回避、og:title は cheerio 全 DOM 構築をやめ `extractOgTitle` 正規表現で抽出 (cheerio 依存を google-drive から除去)。**(#5 CSP テスト)** `filterCspOrigins` / `buildCspDirectiveParts` のヘッダインジェクション防御に専用テスト 9 件追加。**(#6 cspDirectives 一般化)** `EmbedRenderResult.frameSrc?: string[]` を **`cspDirectives?: Record<string, string[]>`** に一般化 (ディレクティブ許可リスト `frame-src`/`media-src` 等 + origin-only 再検証)。将来 media-src 等が必要でも embed 側コード変更不要 (revert された `<video>` 版の media-src churn を構造的に解消)。**(#7 player URL helper)** embed player URL 組み立てを `src/utils/embed-player-url.ts` の `composeEmbedPlayerUrl` に切り出し (末尾スラッシュ複数除去)。**(#8 scale ラッパー汎用化)** `drive-embed-html.ts` を **`src/utils/scaled-iframe-embed.ts` の `renderScaledIframeEmbed`** に汎用化 (`renderWidth` を引数化、Drive 固有の 900px はプラグイン側 `DRIVE_RENDER_WIDTH` に保持)。**(#9 thumbnail 独立採用)** dims 判定失敗 (大きすぎ/破損で null) でも thumbnail URL は valid なので **`applyMeta` で dims と独立に thumbnail を採用** (絵は出す)。併せて dev `/embed` に本番と同じ body size cap (512KB) を追加 (guard parity)。テスト 717 件 pass
* **fix (util: image-dimensions)**: `getImageDimensions` の敵対的入力に対する防御を強化 (PR #2 review fruitriin)。(1) **寸法上限 `MAX_DIM=32767`**: 攻撃者が手書きヘッダで `width=4294967295` 等を仕込んでも `applyMeta` に異常値が伝搬するのを防ぐ第一防衛 (絶対値上限。ただし極端 *比率* は上記 #1 の applyMeta 側 clamp で別途 bound する)。上限超過は null を返す。(2) **GIF magic を 6 byte 厳密検証** (`GIF87a`/`GIF89a` のみ、`GIFXYZ` 等の偽 magic を弾く)。(3) **JPEG の 0xFF padding スキップ** (ISO/IEC 10918-1 B.1.1.2、スキャナ・古いエンコーダが生成する正規 JPEG を寸法判定できるように)。既存の width/height=0 ガード・JPEG segment 走査の無限ループ/OOB 安全性 (`segLen<2` reject + offset 単調増加 + `offset+9<=len` 境界) も退行防止テストで担保。敵対的カバレッジテスト 14 件追加 (寸法上限 / GIF magic / width=0 / truncated・異常 segLen DoS / 0xFF padding / VP8 lossy 縦長)
* **enhance (plugin: google-drive / embed)**: Drive `/preview` iframe を **CSS scale で縮小ラップ**してスマホ幅でのコントロール崩れを回避 (phase19.1 followup #4)。背景: Drive の `/preview` プレイヤーはコントロールバーに最小幅があり (特に **タッチデバイスではスマホ用 UI でボタンが大きくなる**)、Misskey カード内の狭い実描画幅 (~200px) ではコントロールが崩れて操作不能になる (Drive 側 UI の問題で `/preview` を直接スマホで開いても崩れる、アスペクト比調整では直せないと実機切り分け)。対策: embed 有効時 (`embedBaseUrl` 設定) は `player.url` を `/embed?url=...` に向け、`renderEmbed` で新規 `src/utils/drive-embed-html.ts` の `composeDriveScaledEmbedHtml` が内部 Drive iframe を **固定 `RENDER_WIDTH=900px` (スマホ UI でコントロールが崩れない最小幅、実機検証で確定) で描画**し、CSS の **container query length unit (`cqi`)** で `transform: scale(calc(100cqi / 900px))` を掛けてカード幅に追従縮小する。Drive プレイヤーは「自分は 900px 幅」と認識してコントロールを崩さず描画し、CSS でカード幅に縮小表示する。**JS 不要** (embed CSP `default-src 'none'` を緩めない、`<script>` なし)。stage は `height:100%` で embed iframe 自体の aspect-ratio (`player.width/height`) に追従させ二重 aspect-ratio を回避。内部に外部 iframe を埋め込むため `EmbedRenderResult.frameSrc?: string[]` を新設し、embed エンドポイント (本番 `src/index.ts` + dev `dev/server.ts`) で **origin-only 再検証**して CSP `frame-src https://drive.google.com` を追加 (CSP ヘッダインジェクション防御)。embed 無効 (library mode 等) では従来通り Drive `/preview` iframe 直 (`composePlayerUrl` で分岐)。実機検証で横/縦動画 + スマホエミュレートでコントロールが崩れず動作することを確認 (2026-06-01)。`composeDriveScaledEmbedHtml` (HTML 構造 / XSS / https / 比率フォールバック) + `composePlayerUrl` + `pickHttpsUrl` の単体テスト 7 件追加 (計 693 件 pass)。**注記**: 当初 Drive 直ストリーミング URL を自前 `<video>` で再生する案を試みたが、Drive download URL は `Cross-Origin-Resource-Policy: same-site` + `Sec-Fetch-Site: cross-site` 403 + HEVC/AV1 コーデックで第三者サイトの `<video>` からは原理的に再生不可と判明 (curl/ffprobe は CORP/Sec-Fetch を無視するため取得できてしまうのが罠)。`docs/knowhow/embed-endpoint-design.md` 参照
* **feat (plugin: google-drive)**: Google Drive プレビュープラグインを追加 (phase19.1)。`drive.google.com/file/d/<id>/...` 形式の共有 URL について、Google 公式の embed URL `https://drive.google.com/file/d/<id>/preview` を `Summary.player.url` に組み立てて返し、Misskey 上で動画 / PDF / 画像 / Docs を iframe でインライン表示する。oEmbed が存在しないため URL から file ID を抽出して player URL を構築する (`extractFileId` / `buildSummaryFromUrl` を pure 関数として export しテスト容易化)。`/preview` は Google が動画・PDF・画像・Docs すべてをレンダリングするため file 種別判定は不要。`PLAYER_ALLOW_OEMBED` 流用。`skipRedirectResolution = true` で `/view` の HEAD probe ログインゲート 302 で別ホストへ飛ぶのを回避。**縦動画の縦長プレビュー対応**: 公開 thumbnail エンドポイント `https://drive.google.com/thumbnail?id=<id>&sz=w1000` は file の実アスペクト比を保った画像を返すので、これを取得して新規 `src/utils/image-dimensions.ts` の `getImageDimensions` (JPEG/PNG/GIF/WebP ヘッダパーサ、外部依存なし) で pixel 寸法を読み、`player.width`/`player.height` に実比率を入れる (Misskey は height/width 比率で iframe 縦横比を計算するため縦動画は縦長・横動画は横長に表示。実測: 横 `1000×562` / 縦 `1000×1778`)。**title 補完**: `/view` ページを `facebookexternalhit/1.1` UA で叩くと `og:title` に file 名が入るのでこれを title に採用。thumbnail も採用。thumbnail/title の各フェッチは独立 try/catch + `Promise.all` で、失敗時は base (`/preview` player + 16:9 + title/thumbnail null) にグレースフルデグレード (8 秒 timeout + 2 MiB cap)。**Google フォトは非対応**: `photos.google.com` が `X-Frame-Options: SAMEORIGIN` を返すため第三者サイト (Misskey) の iframe には構造的に表示できない (実機確認 2026-06-01)。将来 Playwright モード導入後に「card 表示のみ」で再検討する余地を残す。両 config example の `[plugins].allowed` に `"google-drive"` を追加 (NSFW ではないのでアクティブ形式)。test() マッチ + player URL 組み立て + skipRedirectResolution + extractFileId + applyMeta (寸法/title 上書き + デグレード) + image-dimensions パーサ (JPEG/PNG/GIF/WebP VP8/VP8L/VP8X の横/縦/Uint8Array/不正の各ケース) の単体テスト計 14 件追加
* **change (plugin: iwara) [phase15.6 followup 2026-05-11]**: iwara.tv は `www.` / `ecchi.` 問わず MMD/3D モデルアニメで R-15〜R-18 が混在するサイトのため、**全件 sensitive=true 強制**に変更 (旧仕様: `ecchi.iwara.tv` のみ sensitive)。`applyNsfwCardSuppression` が常に発火して card 抑制 + embed フル表示の経路に切り替わる。オーナー判断「iwara は全部 NSFW でいい」(2026-05-11) を反映。サイト全体の NSFW 比率が高い場合は host 分岐より「常時抑制」のほうが運用上安全という設計知見を `docs/knowhow/age-gate-bypass-pattern.md` に追記
* **enhance (plugin: dlsite/iwara/komiflo/nijie)**: phase15.5 で DMM プラグインに導入した「card 抑制 + embed フル表示の二層構造」を NSFW 系プラグイン全般に横展開 (phase15.6)。`src/utils/nsfw-card-suppress.ts` の `applyNsfwCardSuppression(summary, url, embedBaseUrl)` と `src/utils/nsfw-embed-html.ts` の `composeNsfwEmbedHtml(...)` を共通 helper として切り出し、`dmm` / `dlsite` / `iwara` / `komiflo` / `nijie` の 5 プラグインで共有。**`summary.sensitive === true` のときのみ抑制を適用** する設計のため、`dlsite` の `/comic/` セーフパス (商業向け一般作品) や `iwara` `www.` (一般版) は素通しで既存挙動を維持、`dlsite` `/maniax/` / `iwara` `ecchi.` / `komiflo` API 取得成功時 / `nijie` `/view.php` 着地時のみ抑制が発火。各プラグインに `renderEmbed` export を追加し、`[plugins].allowed` で有効化すると `[embed].allowedPlugins` auto-fill で embed 経由フル表示が自動的に有効になる (phase16.3 連動)。`docs/knowhow/age-gate-bypass-pattern.md` の二層構造セクションを「DMM 限定」から「NSFW 系汎用パターン」に格上げ。共通 helper の pure 関数テスト (XSS 防御 / sensitive 分岐 / oEmbed fallthrough 防止) + dlsite renderEmbed の統合テスト計 4 件追加、既存 dlsite テスト 2 件を新仕様に更新
* **enhance (plugin: dmm)**: phase15.3 で追加した DMM (FANZA) プラグインを **card 抑制 + embed フル表示の二層構造** に再設計 (phase15.5)。問題: phase15.3 の素朴実装では og:image (作品サムネ) と og:description (作品あらすじ) が直球すぎて Misskey タイムラインの URL preview に流すと露骨だった。**card preview** = title を `【<sitename>】<og:title>` (例: 「【FANZA】家出娘、拾いました。」) に整形、description を固定文言 `【R-18】 内容を伏せています` に置換、thumbnail を `null` に強制 (作品サムネ非表示、icon = サイト favicon は parseGeneral 由来で維持)。**embed (`renderEmbed`)** = 制限なしで og:title / og:description / og:image をフル表示する HTML5 ドキュメント (CSP `default-src 'none'; img-src https:; style-src 'unsafe-inline'`、`<img>` には `https:` のみ通す二重防御、escapeHtml で全ユーザー入力を escape)。embed は Misskey 等の UI で明示的に展開操作しないと描画されない原則を利用してフル情報を出す経路として設計。`composeEmbedHtml` を pure 関数として export してテスト容易化、XSS 防御テスト含む 9 件追加
* **feat (plugin: dmm)**: DMM (FANZA) プラグインを追加 (phase15.3)。`dmm.co.jp` 全サブドメイン (`/age_check` パス除く) で年齢認証ゲート (`Vary: User-Agent` で `SummalyBot` UA を 302 → `www.dmm.co.jp/age_check/=/?rurl=...`) を `facebookexternalhit/1.1` UA allowlist 経由で素通しし、`scpaping()` → `parseGeneral()` で OGP 抽出 (`nintendo-store` プラグインと同型)。`skipRedirectResolution = true` で HEAD probe による gate URL 書き換えを回避、`sensitive: true` 固定 (DMM/FANZA 全サブドメインが age_check 経由のため保守的に NSFW 扱い)。両 config example の `[plugins].allowed` には NSFW 慣例でコメントアウト形式 (`# "dmm",`) で追記。test() マッチパターン + UA 固定 + sensitive セットの fastify mock テスト 3 件追加
* **fix (plugin: syosetu)**: 連載状態 (`end` フィールド) の **意味を完全に反転させていたバグ** を修正。なろう公式 API ドキュメント (https://dev.syosetu.com/man/api/) の仕様は **「end: 短編作品と完結済作品は 0、連載中は 1」** だが、コードは `end === 1 ? '完結済' : '連載中'` と逆判定していたため、すべての連載/完結作品で連載中⇄完結済が入れ替わって表示されていた (実例: 完結済 R-18 作品が「連載中」、連載中作品が「完結済」と表示)。`composeDescription` / `composeEmbedHtml` 両方修正、テスト 6 件 (`SAMPLE_NOVEL.end` の前提含む) を新仕様に合わせて更新
* **enhance (plugin: syosetu)**: `composeDescription` / `composeEmbedHtml` を `noveltype === undefined` (HTML フォールバック経路、API allcount=0 時) でも `end != null` なら「連載中」/「完結済」を表示する分岐に拡張。`extractNovelDataFromHtml` 自体は HTML から end を取らない (= undefined のまま) — 当初「最終更新日」/「最終エピソード掲載日」ラベル差から推定する案を実装したが、連載中作品でも「最終エピソード掲載日」が表示されるためラベル差で区別不能と実機確認、誤推定を避けて省略する方針に変更
* **enhance (dev)**: `pnpm dev` で起動する開発用 UI から **embed iframe を実際にレンダリング** できるよう dev サーバを拡張。原因: (1) dev サーバが `embedBaseUrl` を `summaly()` に渡していなかった (`Summary.player.url: null`)、(2) dev サーバに `/embed` ルート未実装、(3) `dev/public/app.js` の player.url スキームチェックが `^https:` のみで `http://localhost:...` を弾いていた。修正: dev/server.ts に `embedBaseUrl = process.env.EMBED_PUBLIC_URL ?? 'http://localhost:${port}'` 追加 + 本番 `/embed` ルートの最小再実装 (CSP `frame-ancestors 'self' http://localhost:PORT http://127.0.0.1:PORT`)、UI 側で `https:` または `http://localhost / 127.0.0.1` を許可
* **fix (plugin: syosetu)**: R-18 ドメイン (`novel18.syosetu.com`) の **年齢確認ゲートで preview 取得が失敗していた問題** を修正。`SummalyBot/x.y.z` UA で叩くと 302 で `https://nl.syosetu.com/redirect/ageauth/?url=<encoded>&hash=...` に redirect され、`summaly()` の HEAD probe (`followRedirects`) で解決された URL ではプラグイン test() が外れ、`general()` が年齢確認ページの OGP (title="年齢確認" / sitename="nl.syosetu.com" / description=null) を返してしまっていた。**対策 1**: `export const skipRedirectResolution = true` を宣言して HEAD probe を skip し、最初から原 URL で API 直叩き経路に乗せる。**対策 2** (defense-in-depth): ageauth URL を test() でマッチさせて `?url=` パラメータから元 URL を unwrap する `unwrapAgeAuthUrl()` を追加。何らかの経路で ageauth URL が直接 summaly に渡された場合 (Mi 側仕様変更等) でも救援可能。回帰防止テスト 4 件追加 (test() で ageauth URL マッチ / inner が ncode 形式でない場合 false / `?url=` 欠如時 false / extractNcodeAndR18 で R-18 元 URL に unwrap)
* **fix (plugin: syosetu)**: `composeDescription` / `composeEmbedHtml` が API レスポンスのフィールド名 `noveltype` を `novel_type` (アンダースコアあり) で参照しており **常に undefined** で取り回されていたバグを修正。なろう公式 API は `of=nt` で要求すると `noveltype` (アンダースコアなし) で返す仕様。結果、これまで `novelType === 2 ? '短編' : (end === 1 ? '完結' : '連載中')` の三分岐が機能せず、`else (end === 1 ? ...)` 経路に常に入っていた (連載中作品では偶然正しい表示、完結作品で「完結」が出ず、短編判定も非動作)。`SyosetuNovelData.noveltype` に統一、テスト 5 件追加で回帰防止
* **enhance (plugin: syosetu chapter)**: chapter (各話) URL のプレビューに **本文先頭を表示** (kakuyomu と同パターン)。**card description**: 旧 `<各話タイトル>` (各話タイトルだけで上書き) → 新 `「<各話タイトル>」 / <本文先頭 80 文字 clip>` (各話の冒頭がプレビューに乗る)。**embed UI**: 作品タイトル直下に `<div class="episode-title">「<各話タイトル>」</div>` を太字 0.95rem で表示、`<div class="story">` には `novel.story` (作品全体のあらすじ) ではなく **その話の本文先頭 300 文字 clip** を流す。本文取得は `<div class="js-novel-text p-novel__text">` 配下の `<p>` を改行結合 (前書き `--foreword` / 後書き `--afterword` は除外)。`extractChapterTitle` / `extractEpisodeBody` を pure 関数として export 化、`fetchChapterTitle` を `fetchChapterData` に置換 (title + body を 1 リクエストで並列抽出)。`composeEmbedHtml` シグネチャに `episodeTitle?` `episodeBody?` の 2 引数追加。本文取得失敗時 (HTML 構造変更) は `novel.story` に fallback。XSS テスト + extractEpisodeBody / extractChapterTitle 純関数の単体テスト含む 15 件追加
* **enhance (plugin: kakuyomu episode)**: episode (各話) URL のプレビューに **本文先頭を表示**。**card description**: 旧 `あらすじ: ... / 序章` (作品全体のあらすじ + 各話タイトル末尾) → 新 `「序章」 / <本文先頭 80 文字 clip>` (各話タイトル + 各話本文)。**embed UI**: 作品タイトル直下に `<div class="episode-title">「<各話タイトル>」</div>` を太字 0.95rem で表示、`<div class="story">` には introduction (作品全体のあらすじ) ではなく **その話の本文先頭 300 文字 clip** を流す。本文取得は `<div class="widget-episodeBody js-episode-body">` 配下の `<p>` を改行結合 (`extractEpisodeBody` 純関数で抽出、テスト容易性確保)。本文取得失敗時 (HTML 構造変更等) は `work.introduction` に fallback。`composeDescription` / `composeEmbedHtml` シグネチャ拡張 (`episodeTitle` + `episodeBody` の 2 引数追加、両方 default null)。`fetchEpisodeData` で title + body を 1 リクエストで並列抽出 (旧 `fetchEpisodeTitle` を置換)。XSS テスト + extractEpisodeBody / extractEpisodeTitleFromOg 純関数の単体テスト含む 16 件追加
* **enhance (plugin: kakuyomu embed)**: syosetu と同じレイアウトルール (`docs/knowhow/embed-endpoint-design.md`「カード description vs embed iframe の責任分担」) に統一。(1) **`<div class="author">作者: ...</div>` 独立 div を撤廃して meta 行先頭に統合**、(2) meta 行を **「作者 / 連載ステータス / ジャンル / 警告」順 1 行統合** ( `display: flex` + `<span>` pill デザインを撤廃し、`/` 区切り flat スタイルに)、(3) **連載ステータスに話数 + 文字数を内包** (`連載中 (169話 / 282,850文字)` 形式) で読み応え情報を 1 単位に集約、(4) `composeStatusLabel` の戻り値変更 (`連載中 (169話)` → `連載中 (169話 / 282,850文字)`)、(5) `.story` の `border-left: 3px solid #4a90e2` 装飾を撤廃 (縦幅節約)、(6) `composeDescription` を **あらすじだけに簡素化** (旧: `作者: ... / ジャンル / 連載中 (169話) / [マーカー] / あらすじ: ...` → 新: `あらすじ: <80 文字 clip>`、Misskey カード幅対策)、(7) `composeDescription` のシグネチャから `authorName` 引数を削除 (利用しなくなったため)
* **enhance (plugin: syosetu embed)**: `/embed` UI を Mi 側プレイヤーの「縦幅 = 横幅依存 + スクロール不可」制約に合わせて重要要素を上に寄せる構成に再編。(1) **「作者 / 連載ステータス / ジャンル / 警告」の順序で 1 行統合** (旧: 3 行構成、マーカーは独立 div)、(2) `[残酷描写]` `[R-15]` `[BL]` `[GL]` 等のマーカーを meta 行末尾に `<span class="markers">` で統合 (赤文字 `#b22` 強調は維持、独立ブロックは廃止)、(3) ジャンル取得不可 (R-18 = `novel18api`、`biggenre` / `genre` 非返却仕様) のとき空表示を避けて省略、(4) 「あらすじ」見出しラベル削除、(5) タグ (キーワード) をあらすじの後ろに配置、(6) 完結フラグ表記を「完結」→「完結済」に変更
* **change (plugin: syosetu)**: card style 用 description (`composeDescription`) を **あらすじだけに簡素化** (旧: `作者: ... / ジャンル / 連載中 / [残酷描写] / あらすじ: ...`)。Misskey カード幅で description が複数要素入るとあらすじ部分が見切れてしまうため、メタ情報 (作者 / ジャンル / 連載状態 / マーカー) は embed iframe に集約する方針に変更。Misskey の URL preview カードでは description は `あらすじ: <80 文字 clip>` のみ表示
* **refactor (phase18.1) [BREAKING]**: 旧 cascade 関数 (`getResponseWithFallback` / `getResponseWithProxyFallback` / `getResponseWithCurlCffiFallback`) と `StrategyTracker` 型を **削除** (phase18 で hedge race に置換後 dead code 化していた)。`viaProxyWorker` / `viaCurlCffi` を直接呼ぶ形に統一。`ProxyFallbackConfig.domains` / `CurlCffiFallbackConfig.domains` 内部フィールド + `bin/config-loader.ts` の bootstrap 自動導出 + 経路依存 fail-fast (phase16.3) も **撤廃**。hedge race の並列発火モデルと矛盾していた host allowlist を完全削除し、SSRF 防御は (1) Worker 側 `ALLOWED_DOMAINS` (オープンプロキシ化防止)、(2) curl_cffi 側 Python `assert_public_ip` (private IP rejection) で確保。`config.toml` の旧キー (`[scraping.proxy].domains` / `categories` / `[scraping.curl_cffi].domains` / `categories`) は **silent ignore** で forward-compat 維持。**結果**: monotaro 等「bootstrap entry に書いていなかったため curl_cffi が呼ばれなかった」サイトが phase18.1 で自動救援対象になる。**pino ログ拡張**: hedge fire 時に `hedge_fired: true, winner, outcomes, latency_ms` を構造化ログ出力 (`logHedgeIfFired`)。`SummalyOptions._cacheRecording` を internal API として公開し、Fastify ハンドラで recState を共有して outcomes を pino に伝搬。本番診断 (「どの経路が gate_failed か」「curl_cffi が起動しているか」) が journalctl で可視化される。詳細: DEPRECATED.md
* **feat (hedged fallback) [BREAKING]**: 経路選定を全自動化する hedged race 機構を導入 (phase18)。経路学習キャッシュ (phase14) の champion + 残り全 strategy (= challenger pool) の階層構造を採用し、champion が `hedgedThresholdMs` (default 5000ms) 以内に valid response を返さない、または失敗した場合に challenger を `Promise.any` で並列発火、最初に取得成功した経路を採用 + 即座に新 champion へ昇格 (1 回で promotion、N 連続要件なし)。phase14 の段階的 cascade (default UA → fallback UA → proxy → curl_cffi) を撤廃し、各経路が独立した hedge race 候補として動作。AbortSignal 伝搬で勝者確定後の残り inflight を best-effort cancel (proxy: got abort、curl_cffi: subprocess SIGKILL)。確定エラー (`not_found` / `ssrf_blocked` / `unsupported_type` / `content_too_large` / `parse_error`) は `isFinalError` フィルタで hedge fire を skip し無駄リクエストを防ぐ。**[scraping.fallback] に `hedgedThresholdMs` (default 5000) を新設**。`fallbackRetryCategories` は機能上意味を持たなくなった (deprecation 通知、TOML キーは forward-compat 維持)。**経路問題だけのサイト (monotaro.com 級) は plugin / config 編集なしで自動救援される**設計。Plan: docs/plans/phase18-hedged-fallback.md
* **feat (curl_cffi)**: Python 側に **SSRF ガード** を追加 (`assert_public_ip`)。phase18 で `domains` allowlist の効力が薄れる (hedge race ですべての URL に対して全 strategy 並列発火) ため、Node 側 `got.ts` の private IP rejection と同等の防御を curl_cffi 経路にも実装。`urllib.parse` + `socket.getaddrinfo` + `ipaddress` で名前解決した全 IP を private / loopback / link-local / multicast / reserved / IPv4-mapped loopback 判定。redirect 後の最終 URL も再検証 (DNS rebinding / open redirect → SSRF 防御)。`SUMMALY_ALLOW_PRIVATE_IP=true` でテスト用バイパス可能 (Node 側既存仕様と一致)。SSRF 拒否時は `{"category": "ssrf_blocked"}` で JSON 出力 → Node 側 `viaCurlCffi` が `Private IP rejected: ...` Error に変換 → `categorizeError` で `ssrf_blocked` 分類で復元
* **change (plugin)**: ニトリプラグイン (phase15.4) を **デフォルト disable** に変更 (Followup #2、fail mode J 確定、2026-05-10)。Followup #1 のローカル検証で動いていたのに本番 Vultr Tokyo IP からは引き続き HTTP/2 INTERNAL_ERROR、CF Workers proxy (AS13335) 経由でも 520 Web Server Returns Unknown Error が返ることを `scripts/check-nitori-via-worker.mjs` で実機確認し、**ニトリは datacenter IP 全般を Akamai 系で block** している (fail mode J、新カテゴリ) と確定。residential proxy 商用サービスが必要だが summaly のスコープ外。プラグイン本体 `src/plugins/nitori.ts` と `src/plugins/index.ts` 登録は維持 (家庭用 IP / library 直接利用者は引き続き使える、Followup #1 の curl_cffi CLI `--header` 機構は他の JSON API ケース用に資産)。両 config example の `[plugins].allowed` からは `"nitori"` をコメントアウト形式で外し「fail mode J で本番運用は救援不可」を明記。`tools/cf-proxy-worker/wrangler.toml` の `ALLOWED_DOMAINS` と `data/domain-strategy-bootstrap.jsonl` から `nitori-net.jp` を削除 (Followup #1 で一時追加 → revert)。knowhow `spa-dynamic-ogp-unfixable.md` を再更新し fail mode J 新セクション (H との比較 + 切り分けチェックリスト) を追加
* **fix (curl_cffi)**: `tools/curl-cffi-fetcher` CLI に `--header NAME:VALUE` 反復引数を追加し、`viaCurlCffi` から呼出側ヘッダの一部 (allowlist: `accept` / `accept-language` / `referer` / `user-agent`) を CLI に伝える経路を実装 (phase15.4 Followup #1)。これまで CLI は `requests.get(url, impersonate=...)` で叩いており呼出側ヘッダが**完全に無視**される設計だった。impersonate モードが生成する Chrome 風 Accept (`text/html,application/xhtml+xml,...`) が固定送信され、`Accept: application/json` を要求しても XHTML が返ってくる挙動になっていた (ニトリプラグインの本番動作不能の root cause の 1 つ、ローカル検証で発見)。allowlist 方式により Range / Content-Type / Accept-Encoding 等は impersonate のブラウザヘッダ群と衝突しない設計。`pickOverrideHeaders` を export し単体テスト + viaCurlCffi での Accept 反映テスト + 既存 argv テストの末尾追加更新で 611 件全 pass
* **feat (plugin)**: ニトリ (nitori-net.jp) プラグイン追加 (phase15.4)。商品詳細ページ (`/ec/product/<sku>/`) は **TLS layer + UA layer の二重 bot block** + **JS 動的 OGP 注入** の三重壁で過去に「fail mode I (救援不可)」と整理されていたが、公式 SAP Commerce OCC API (`/occ/v2/nitorinet/nitori/products/<sku>?handleError=true&lang=ja&curr=JPY`) を **`viaCurlCffi` (libcurl-impersonate / Chrome JA3 偽装) 経由で直叩き** することで title / description / thumbnail / brand / price 等の構造化データを救援。経路は経路学習キャッシュではなく `viaCurlCffi` 直接呼びの個別 hardcode 方式 (JSON API のため `getJson` は経路学習キャッシュ非統合、かつ TLS + UA の二重 block で経路が一意確定するため cascade 不要)。`skipRedirectResolution = true` で HEAD probe 空回り回避 (TLS 切断対策、yodobashi と同じ理由)。エラー response (`INVALID_PRODUCT`) は `StatusError(404)` を投げて `category: 'not_found'` 扱い、`skuData.name` 欠如 (API 仕様変更) は `failed summarize` で可視化。**運用要件**: `[scraping.curl_cffi].enabled = true` + `tools/curl-cffi-fetcher/` の `uv sync` 完了 + `bootstrap.jsonl` の `nitori-net.jp → curl_cffi` (新エントリで `curlCffiFallback.domains` allowlist に自動的に含まれる)。両 config example の `[plugins].allowed` に `"nitori"` を追加。`getJson` 自体を経路学習キャッシュ統合する案は phase15.5 (仮) として TODO 登録 (本 phase は影響範囲を nitori プラグインに閉じる判断)。**派生**: knowhow `spa-dynamic-ogp-unfixable.md` の nitori セクションを「救援不可」から「公式 JSON API + curl_cffi で救援可能」に更新、教訓「fail mode I 判定の前に隠れ JSON API 探索を 1 段挟む」を追記
* **feat (server)**: 起動時 healthcheck で placeholder + 疎通検証を fail-fast (phase16.4)。`config.example.toml` で「enabled = true 時に必須な項目」(`url` / `secret` / `projectDir` / `uvPath`) を placeholder 値のままコメント無しで書いておくスタイルを採用 (運用者が `enabled = true` にしたとき「何を埋めるべきか」が一目で分かる)。これと組み合わせて、`bin/summaly-server.ts` 起動時に `runConfigHealthchecks` を呼び、proxy / curl_cffi / embed の `enabled = true` 時に以下を検出して fail-fast: (1) URL / secret に placeholder 文字列 (`<your>` / `<...>` / `...`) が残っていないか、(2) projectDir に `/path/to/` が残っていないか + 実体ディレクトリが存在するか、(3) uvPath が PATH 上で実行可能か (`spawnSync('uv', ['--version'])` で検証)、(4) embed.enabled = true で publicUrl が placeholder か。エラーメッセージで「対処: …」と具体的に案内 (例: 「Worker を deploy → URL を埋める」「`cd <projectDir> && uv sync`」「uv をインストール (https://docs.astral.sh/uv/)」)。**library mode (= summaly() 直接呼び出し) では走らない** — Fastify モード専用。フォロー候補: proxy 実 HTTP 疎通テスト (Worker 側 `/health` endpoint 追加 + summaly 起動時に GET 200 確認) は phase16.5 検討
* **breaking (config)**: TOML config 全面整理 + 経路依存 fail-fast (phase16.3)。riin-summaly はオレオレ運用前提で互換性は破壊する判断 (silent migration / forward-compat の運用負担より「設定が間違っていれば即起動失敗」の方が運用上正しい)。**TOML キー削除** (`[server].publicUrl` → `[embed].publicUrl` 移動、`[embed].allowedPlugins` 削除 + `[plugins].allowed` × `renderEmbed` 実装プラグインから auto-fill、`[scraping.proxy].categories` / `domains` / `[scraping.curl_cffi].categories` / `domains` / `[scraping.fallback].categories` 削除でコード側 default 固定 + bootstrap.jsonl から domains 自動導出)。**`expectKnownKeys` 実装**: 全セクションで未知キー silent ignore を起動失敗化 (phase11.5 で削除された `parseFailureLogEndpoint = true` 等も含む)。**経路依存 fail-fast**: `[scraping.strategy_cache]` の bootstrap が proxy / curl_cffi 経路を要求する状態で対応セクションが `enabled = false` だと起動失敗、エラーメッセージで「(a) 該当経路を有効化、(b) `strategy_cache` を無効化、(c) bootstrap entry 削除」の 3 択案内。**`useRange` の internal default を true に変更**: 帯域節約をデフォルトに (Range 非対応サーバはフルボディ fallback で互換)。**`parseFailureLog` ペア + デフォルト**: `parseFailureLog = true` で Path 未指定なら `./data/parse-failures.jsonl` / `./data/parse-failures-blocked.jsonl` 自動適用、片方だけ Path 指定はペア違反で起動失敗。**proxy secret 未設定で warning + 無効化を fail-fast に変更**。**`config.example.toml` 全面書き直し**: デフォルト値で十分なキーをコメントアウト化、半端な有効値を整理 (運用判断が必要なキーだけが目立つ)。**`.gitignore`** に `data/parse-failures*.jsonl` / `data/domain-strategy-runtime.jsonl` 追加。**ドキュメント**: `DEPRECATED.md` に phase16.3 セクション追加 (旧 → 新の対応 + 移行手順 5 機能分)。**テスト書き直し**: `test/config-loader.test.ts` を全面書き直し (旧キー起動失敗 / 経路依存 fail-fast / parseFailureLog ペア違反 / useRange default true 等を網羅、559 件 pass)
* **docs**: 廃止された機能の経緯記述を `DEPRECATED.md` に集約し、各 docs から切り出し (phase16.2)。phase16.1 で経路優先システムを目玉特徴に位置づけた際、廃止された機能 (旧 fastify-cli `--options summaly-config.json` / `/__diagnostics/parse-failures` HTTP エンドポイント / `parseFailureLogEndpoint` TOML キー / `forceCurlCffiFallback` / `forceProxyFallback` プラグインフラグ) の経緯記述が README / docs/SETUP.md / docs/Library.md / docs/Plugins.md / docs/deploy-examples/README.md に散在し、新規利用者の「今動く機能だけ知りたい」目線でノイズになっていた状態を解消。**新規 DEPRECATED.md (ルート直下)** に 4 機能それぞれについて「旧 / 新 (移行先) / 廃止理由 / 移行手順」を一貫した構成で記載し、関連 Plan / knowhow へのリンクで深堀り可能に。各 docs からは廃止経緯詳細を削除して 1 行サマリ + DEPRECATED.md リンクに簡素化。**README.md** L45 の HTTP エンドポイント廃止言及削除、L114 の phase14 言及を「プラグインは extraction 専用、経路選択は経路学習キャッシュ」という現在の責務分離説明に簡素化、設計ドキュメントセクションに DEPRECATED.md リンク追加。**docs/Library.md** L94 末尾の「Step 4 で...フラグ廃止済」を DEPRECATED.md リンクに、L115 の「HTTP エンドポイント版は phase11.5 で廃止」を削除。**docs/SETUP.md** L90 / L208 / L443 / L547 の廃止経緯を 1 行サマリ + DEPRECATED.md リンクに簡素化。**docs/Plugins.md** L258 / L272 の forceX フラグ廃止経緯削除 (現在の経路説明には不要)。**docs/deploy-examples/README.md** の phase11.5 廃止言及も同様。**副次的修正**: phase15.2 で `kakuyomu` を `config.example.toml` の `[plugins.allowed]` に追加し忘れていた反映漏れを `test/config-example-plugins.test.ts` (既存自動ガード) が catch して修正
* **docs**: 経路優先システムを README の目玉特徴として位置づけ (phase16.1)。phase11.9 / 12.1 / 12.5 / 14 で整備した 4 経路 (Summaly UA / SNS Preview Bot UA / Proxy / curl_cffi) と経路学習キャッシュ + bootstrap が SETUP.md / Library.md の奥でしか語られていなかった状態を解消。**README.md** に「経路優先システム」セクション新設 (4 経路の責務分担表 + 経路学習キャッシュの 1 段落)、「riin-summaly で拡張された運用機能」表に 3 行追加 (経路学習キャッシュ + bootstrap / CF Workers proxy / curl_cffi TLS 偽装)、vs 本家 / mei23 比較表に同 3 行追加、対応サイト表に **`kakuyomu` 行追加 + 「経路」列追加** (各プラグインの fetch 戦略を明示)、dev サーバセクションを「経路優先システムの手元再現」に拡張 (proxy / curl_cffi 両方の手元動作確認手順を案内)。**docs/SETUP.md** 目次に curl_cffi / 経路学習キャッシュ追加 + 本文「キャッシュ戦略」直後に「経路優先システム俯瞰」セクション新設 (cascade fallback chain と経路学習キャッシュが「初回 cascade」と「2 回目以降 fast path」をどう繋げているかを 1 ページで説明)。**docs/Library.md** L94 `domainStrategyCache` の「Step 3 で同梱予定」「Step 4 で `forceX` フラグ廃止予定」を「同梱済」「廃止済」に更新、L95 `embedBaseUrl` 対応プラグインを `syosetu` のみ → `syosetu` / `kakuyomu` に修正。**docs/knowhow/domain-strategy-cache.md** の同種の「予定」表現も「済」に整理。**新規 test/readme-plugins.test.ts** で `src/plugins/*.ts` の `export const name` を抽出して README 内のバッククォート付きトークン (\`<name>\`) として言及されているか自動チェック (`config-example-plugins.test.ts` パターンの README 拡張、phase15.2 で kakuyomu が README に未反映だったような同期漏れを構造的に防止)
* **feat**: カクヨムプラグインを追加 (phase15.2)。`kakuyomu.jp/works/<id>` および `/works/<id>/episodes/<eid>` の URL を識別し、HTML 内の `<script id="__NEXT_DATA__" type="application/json">` の Apollo (Relay 風) 正規化キャッシュ JSON を parse して `Work:<id>` エンティティを取得する。**card style description**: 作者 (`UserAccount` ref lookup) / ジャンル (enum 文字列 → 日本語ラベル) / 連載中・完結 + 話数 / 残酷描写・性的描写・暴力描写マーカー / catchphrase or introduction 抜粋 (80 文字 clip) を 1 行整形。**embed (`renderEmbed`)**: `/embed?url=...` で iframe 用 HTML5 ドキュメントを返す (タイトル / 作者 / ジャンル + 状態 + 文字数 + マーカー / introduction 300 文字 clip / タグ上位 5 件 / 最終話日付)。**XSS 全エスケープ + CSP `default-src 'none'`** で二重防御 (phase13.1 syosetu と同設計)。`Work.ogImageUrl` (`cdn-static.kakuyomu.jp/works/<id>/ogimage.png`) を Summary thumbnail に採用 → 作品ごとのカスタムサムネで見栄え良し (なろうのサイトロゴ固定より改善)。`isSexual === true` で `sensitive: true`。`Twitterbot/1.0` UA で叩いて PV カウント除外を狙う (phase12.3 nintendo-store と同類)。chapter URL は作品トップに丸めつつ episode 個別の `og:title` から各話タイトルだけ抽出して description 末尾に付与 (phase13.1 syosetu chapter 対応と同パターン)。ジャンル enum マッピング (`src/utils/kakuyomu-genres.ts`) で `LOVE_STORY` / `FANTASY` / `SF` / `HORROR` / `MYSTERY` / `HISTORY` / `DRAMA` / `ESSAY_NONFICTION` 等 → 日本語表示名、未知 enum は `'その他'` フォールバック。テスト 31 件追加 (URL マッチ / `__NEXT_DATA__` parse + Apollo state walk + UserAccount lookup / pure 関数群 / XSS 攻撃 2 ケース)
* **feat (dev)**: 経路学習キャッシュ観測 API を dev サーバに追加 (phase14 Step 5 部分)。`dev/server.ts` で `DomainStrategyCache` を `getDefaultBootstrapPath()` 自動ロード付きでインスタンス化 + `setActiveCache` で singleton 登録 (起動時に bootstrap 9 entries が読まれる)。`GET /api/strategy-cache` で cache 中身 (size + bootstrapPath + runtimePath + consecutiveFailureThreshold + entries `lastAttemptAt` 降順) を JSON で返す。**dev 限定** (機密データ漏洩経路化を防ぐため本番には載せない)。サンプル URL → 経路マッピング学習 → 本 API で確認、というフローで cache 動作を視覚化できる。**注**: UI パネル化と目視動作確認は Step 5 残作業 (UI work + 手動範囲)
* **docs**: phase13.1 Step 4 (テスト) + Step 6 (docs) + Step 7 (knowhow) を完了。`docs/Library.md` に `embedBaseUrl` / `embedConfig` 行追加、`docs/Plugins.md` に `syosetu` セクション + `renderEmbed` interface 説明追加、`docs/SETUP.md` に `/embed` エンドポイント節 (8 層 defense-in-depth + Misskey 側挙動 + library/Fastify 分離) 新設、`README.md` プラグイン一覧に `syosetu` + `sqex` 行追加、`CLAUDE.repo.md` 対応形式表に syosetu 行追加、`docs/knowhow/embed-endpoint-design.md` を新設 (XSS / CSP 設計の汎用化、他プラグイン拡張時の踏み台)。Step 4 テストは pure 関数 (`composeEmbedHtml` / `buildSummaryFromApi` / etc) を 32 ケース網羅 + escape-html / embed エンドポイント基盤 / config-loader 計 31 ケースで実質的に網羅、`summarize` / `renderEmbed` のフルフロー (実 API 経由) は外部 mock infra が現リポに無いため Step 5 dev 手動検証で代替判断。phase13.1 は Step 5 dev 手動 (UI 検証必要のため自動化対象外) のみ残
* **feat**: 小説家になろうプラグインを追加 (phase13.1 Step 3)。`ncode.syosetu.com` (一般) / `novel18.syosetu.com` (R-18 ノクターン・ムーンライト) の作品 URL を識別し、なろう公式 API (`api.syosetu.com/{novelapi|novel18api}/api/`) を直叩きして作品メタを取得。**card style description**: 作者 / ジャンル / 連載中・完結 / R-15・残酷描写・BL・GL マーカー / あらすじ抜粋 (80 文字 clip) を 1 行に整形。**embed (`renderEmbed`)**: `/embed?url=...` で iframe 用の完全な HTML5 ドキュメントを返す (タイトル / 作者 / ジャンル + 状態 / マーカー / タグ上位 5 件 / あらすじ 300 文字 clip)。**XSS 全エスケープ**: composeEmbedHtml で全フィールドを `escapeHtml` 経由で entity 化、CSP `default-src 'none'` + `<script>` sanity check (Step 1 で実装) と二重防御。chapter URL (`/<ncode>/<chapter>/`) は作品レベルの ncode に集約。R-18 ドメインで `sensitive: true` + sitename 切替 (`ノクターンノベルズ / ムーンライトノベルズ`)。ジャンル ID マッピング (`src/utils/syosetu-genres.ts`) で大ジャンル + ジャンル ID → 表示名を変換、未知 ID は 'その他' フォールバック。テスト 32 件追加 (test() URL マッチ + 別パス除外 + ncode 正規表現精度 / pure 関数群 / XSS 攻撃 3 ケース)。**注**: phase13.1 Step 3 では library mode で `summarize()` の player.url=null 固定 (`embedBaseUrl` を `GeneralScrapingOptions` 経由で受け取れない型制約のため、Fastify モード player.url 組み立ては次フェーズの内部 opts 拡張で対応予定)
* **feat**: `/embed` エンドポイント基盤を Fastify モードに新設 (phase13.1 Step 1+2)。プレイヤー iframe として読まれる JS なし HTML+CSS を返す機構の土台を実装。`renderEmbed?: (url, opts) => Promise<EmbedRenderResult>` を `SummalyPlugin` interface に追加 — プラグインが本フィールドを実装すると `/embed?url=<URL>` で当該 HTML が返るようになる。`src/utils/escape-html.ts` に `escapeHtml(s)` / `escapeAttr(s)` の純関数を新 export (5 文字 `& < > " '` を entity 化)。`/embed` ルートは URL https-only 検証 + builtinPlugins から `test() && renderEmbed != null && allowedPlugins.includes(name)` の最初を採用 + 未知クエリ無視 (Misskey transformPlayerUrl 対応) + CSP `default-src 'none'` + `style-src 'unsafe-inline'` + `img-src https:` + `frame-ancestors <config>` ヘッダ + 512KB body cap + `<script>` sanity check (defense-in-depth)。エラー経路は plain text 400 / 404 / 500 (HTML 返さない)。`SummalyOptions` に `embedBaseUrl?: string` (Fastify モードで自身が公開されている URL ベース) と `embedConfig?: { enabled, allowedPlugins, frameAncestors }` を追加。TOML `[server].publicUrl` (https only 検証) + `[embed]` セクション (allowedPlugins 空配列禁止 fail-close、frameAncestors の各要素は `*` / `'self'` / `'none'` / origin-only URL のみ許容、CSP インジェクション防御)。テスト 22 件追加。**注**: 本コミットは embed 基盤のみ。renderEmbed を実装したプラグインはまだ無いため `/embed` を叩いても 404 になる。Step 3 (syosetu プラグイン本体) 以降で実機動作。`config.example.toml` + `docs/deploy-examples/summaly-config.example.toml` の **両方** に `[embed]` セクションのコメント例を追加
* **breaking (internal)**: `GeneralScrapingOptions` から `forceCurlCffiFallback` / `forceProxyFallback` フラグを廃止 (phase14 Step 4)。phase12.5 followup #3 で導入した「1〜3段目スキップして curl_cffi 直行」と phase12.6 で導入した「1〜2段目スキップして proxy 直行」の特殊経路強制フラグを削除。代替経路は phase14 Step 3 で同梱した `data/domain-strategy-bootstrap.jsonl` の bootstrap エントリ (yodobashi.com → curl_cffi、store.jp.square-enix.com → proxy) で `scpaping()` 冒頭の cache hit fast path から各 strategy が直接呼ばれる経路に統合。`src/utils/got.ts` の `fetchResponse` から forceX 分岐を削除、`src/general.ts` の `GeneralScrapingOptions` フィールド削除、`src/plugins/yodobashi.ts` / `src/plugins/sqex.ts` から各 forceX フラグ宣言削除。テスト 8 件 (forceCurlCffiFallback / forceProxyFallback describe 群) 削除。**library 利用者への影響**: `GeneralScrapingOptions` は内部型 (`SummalyOptions` には含まれていない) なので公開 API への影響無し。カスタムプラグインで `forceX` フラグを使っていた場合は bootstrap entry に置き換える必要あり (詳細は `data/README.md` 参照)
* **feat**: 経路学習キャッシュの bootstrap データを npm パッケージに同梱 (phase14 Step 3)。`data/domain-strategy-bootstrap.jsonl` を新設し、yodobashi (TLS 切断) → `curl_cffi`、Square Enix e-STORE (IP block) → `proxy`、Amazon `co.jp/dp` `co.jp/gp` `com/dp` (Vultr Tokyo IP block) → `proxy` の 9 エントリを bundle。`package.json` `files` に `data/` を追加して publish 対象化、`src/utils/domain-strategy-cache.ts` に新 export `getDefaultBootstrapPath()` を追加し、`import.meta.url` を起点に bundled (`built/index.js → ../data/...`) と source dev (`src/utils/X.ts → ../../data/...`) の 2 候補を `statSync` で probe してパス自動解決。Fastify auto-init は `bootstrapPath ?? getDefaultBootstrapPath()` で `[scraping.strategy_cache]` の `bootstrapPath` 未指定時に同梱を自動ロード。**運用上の効果**: 新規環境で summaly を `npm install` した時点で yodobashi / sqex / amazon が「初日から正しい経路で動く」(初回 20 秒空回りを回避)、bootstrap 同梱が phase14 Step 4 (`forceX` フラグ廃止) のブロッカーを解消。詳細は `data/README.md` 参照
* **feat**: Fastify モードで経路学習キャッシュを自動インスタンス化 (phase14 Step 2b-4)。`src/index.ts` の Fastify plugin setup で `options.domainStrategyCache?.enabled === true` のとき `DomainStrategyCache` インスタンスを作成して `setActiveCache(cache)` で登録する。`scpaping()` は singleton 経由で取得して lookup する。`bootstrapPath` / `runtimePath` も全て透過渡し。これで Fastify モードでは `[scraping.strategy_cache]` TOML を書くだけで cache が有効化される (`config.example.toml` の例参照)。テスト 4 件追加 (auto-init / 未指定 / enabled=false / 全オプション伝搬)。**設計**: モジュールレベル singleton (既存 `setAgent` パターン踏襲) で 1 プロセス 1 Fastify 想定、Fastify close 時の cleanup なし
* **feat**: 経路学習キャッシュの記録判定を Summary レイヤに集約 (phase14 Step 2b 後半)。`src/utils/got.ts` の `fetchResponse` から `cache.recordSuccess` / `recordFailure` の直接呼出を全削除し、`opts._cacheRecording` (mutable side-channel、`CacheRecordingState` 型) に context (recordKey / strategy / gateFailedNeutral) を埋める形に refactor。`src/index.ts` の `summaly()` トップレベルで try/catch wrapping + `isThinSummary` 判定に基づき一括して `recordCacheSuccess` / `recordCacheFailure` を呼ぶ。**修正された構造的バグ**: HTTP 200 + Summary thin の振動 (yodobashi/sqex 等の bot-block 200 + 正規 404 ページボディ パターン) で、HTTP 層 recordSuccess → Summary 層 recordFailure → HTTP 層 recordSuccess... の繰り返しで連続失敗カウンタが閾値に達せず invalidate が機能しない問題があった。Summary 層に集約することで bot-block 200+thin パターンも N 回連続で確実に entry 破棄される。テスト 3 件追加 (Summary thin → recordFailure / 連続 thin で閾値到達 invalidate / HTTP throw → recordFailure)。**注**: Fastify モードでの cache 自動インスタンス化は Step 2b-4 (次サイクル) で実装
* **feat**: 経路学習キャッシュの cache miss 経路で cascade tracking + recordSuccess を実装 (phase14 Step 2b 前半)。`src/utils/got.ts` に新 export `StrategyTracker = { value?: DomainStrategy }` を追加。`getResponseWithFallback` / `getResponseWithProxyFallback` / `getResponseWithCurlCffiFallback` に optional `tracker` 引数を追加し、各段成功時に `tracker.value` を該当 strategy にセット。`scpaping()` の `fetchResponse` で cache miss 時に tracker 経由で cascade success の strategy を捕捉、状況別に pathKey を選定して `recordSuccess` 呼出: cache hit が throw で失敗 → `hit.hitKey` 上書き、cache miss → 1-seg pathKey (host のみ URL は host)、cache hit gate-fail → record せず (entry を「config 復帰時の再利用候補」として温存、neutrality 維持)。**設計選択**: tracker は mutable side-channel パターンで既存シグネチャを変えず後方互換性を維持。`fetchResponse` の関数スコープ内で都度作成するので並行リクエスト混線無し。**注**: 本コミットは Step 2b 前半。Summary レイヤでの thin 判定 → recordFailure (cache miss + cascade 失敗で何も記録されない問題の解決) と、Fastify モードでの cache 自動インスタンス化は Step 2b 後半 (次サイクル) で実装。テスト 4 件追加 + Step 2a の 1 件を Step 2b 仕様に更新
* **feat**: 経路学習キャッシュを `scpaping()` に統合 (phase14 Step 2a、cache hit fast path のみ)。`src/utils/domain-strategy-cache.ts` にモジュールレベル singleton (`setActiveCache` / `getActiveCache`、`got.ts` の `agent` と同じパターン) を追加し、`scpaping()` の冒頭で cache lookup → ヒット時は該当 strategy で direct invoke (cascade を完全スキップ)。`'default'` / `'fallback_ua'` は `getResponse` (UA 切替のみ、リトライなし)、`'proxy'` は `viaProxyWorker` 直接、`'curl_cffi'` は `viaCurlCffi` 直接。**ゲート不通過** (config 無効 / allowlist 不一致 / `https:` プロトコル不一致) は `null` を返して通常カスケードに fallthrough し中立扱い (recordFailure 呼ばない)。**fast path 失敗** は `recordFailure` (連続失敗カウント増、N 回到達でエントリ破棄) + cascade fallthrough。**注**: cache miss 時の cascade tracking + recordSuccess、Summary レイヤでの thin 判定 → recordFailure、Fastify モードでの cache 自動インスタンス化は phase14 Step 2b (次サイクル) で実装。テスト 7 ケース追加。`forceCurlCffiFallback` / `forceProxyFallback` 経路は cache 経路より優先で挙動変化なし
* **feat**: 経路学習キャッシュのストレージ層を追加 (phase14 Step 1)。`src/utils/domain-strategy-cache.ts` を新設し、ドメイン (host + path prefix 1〜2 段) ごとに「成功した取得経路」(`default` / `fallback_ua` / `proxy` / `curl_cffi`) を学習・JSONL 永続化するクラス `DomainStrategyCache` を実装。`lookup(url)` は specific → general 順で探索し最初にヒットしたエントリを返す。`recordSuccess(pathKey, strategy)` / `recordFailure(pathKey)` で学習更新。bootstrap JSONL (リポ同梱) を起動時に 1 回ロード後、runtime JSONL (環境ローカル) で上書き。`fs.appendFileSync` で 1 行ずつ追記し、累積行数が `compactionThreshold` を超えたら `setImmediate` 経由で全件書き換え (compaction)。N 連続失敗 (デフォルト 3) で破棄。TOML `[scraping.strategy_cache]` で設定可能 (`enabled` / `bootstrapPath` / `runtimePath` / `maxEntries` / `consecutiveFailureThreshold` / `compactionThreshold`)、`SummalyOptions.domainStrategyCache` にマップ。**注**: 本コミットは Step 1 (ストレージ層 + TOML 設定) のみで、`scpaping()` への統合と `forceX` フラグ廃止は Step 2〜4 で実施するため現時点では設定しても挙動は変わらない (将来互換)
* **feat**: sqex プラグインを追加 + `GeneralScrapingOptions.forceProxyFallback` を新設 (phase12.6)。Square Enix e-STORE (`store.jp.square-enix.com`) はデータセンター IP レンジ全般を CDN 段で広く弾くため、Vultr Tokyo IP から直叩きすると **HTTP/200 + `text/html;charset=utf-8` + 正規 404 ページボディ** が返る (= got レイヤではエラーが何も発生せず、phase12.1 の `getResponseWithProxyFallback` のエラー発火型では救援できない新パターン、skill `/url-preview-check` Phase 3 の fail mode 拡張)。`forceProxyFallback: true` で **1〜2段目 (default UA / fallback UA) をスキップして CF Workers proxy 直行**。`forceCurlCffiFallback` と並列構造で defense-in-depth (domains allowlist + `https:` プロトコル) は維持。短縮 URL `sqex.to/<id>` は HEAD で `store.jp.square-enix.com/...` に正常解決可能なので resolveRedirect 段に任せ、プラグインは `skipRedirectResolution` を宣言しない。`[scraping.proxy].domains` と Worker `wrangler.toml` の `ALLOWED_DOMAINS` の両方に `store.jp.square-enix.com` を追加 + Worker 再 deploy が運用要件
* **perf**: `GeneralScrapingOptions.forceCurlCffiFallback` を追加し yodobashi で有効化 (phase12.5 followup #3)。phase12.5 followup #2 で resolveRedirect HEAD probe をスキップしても本番が依然 ~20 秒のままだった原因が「**1段目 scpaping (default UA) が Vultr Tokyo IP からの yodobashi リクエストで `Timeout awaiting 'socket'` (20秒) で空回り**」だったことを特定。`forceCurlCffiFallback: true` を渡すと、1〜3段目 (default UA / fallback UA / CF Worker proxy) を **すべてスキップして curl_cffi を最初から呼ぶ**。defense-in-depth で domains / `https:` の二重防御は維持。yodobashi では「resolveRedirect スキップ + 1〜3段目スキップ + proxy 強制 undefined」の **3 重スキップで無駄リクエストをゼロ化**。本番実測 21 秒 → ~3 秒に短縮見込み
* **perf**: プラグインに `skipRedirectResolution` フラグを追加し yodobashi で有効化 (phase12.5 followup #2)。本番 21 秒の根本原因が「`summaly()` 冒頭の `resolveRedirect` HEAD probe が yodobashi の TLS 切断で 20 秒 timeout 待ち」だったことを特定。プラグインが `skipRedirectResolution = true` を宣言すると、初期 URL がそのプラグインの `test()` にマッチした場合に限り `resolveRedirect` (HEAD/GET probe) を完全スキップする。yodobashi のように **TLS layer で bot 切断 + URL が終端確定** (短縮 URL でない) なサイトに適用。所要時間 21 秒 → 数秒に短縮見込み。短縮 URL を扱うプラグイン (`amazon` の `amzn.asia` / `branchio-deeplinks` 等) は宣言しないこと (resolveRedirect が必須)
* **perf**: yodobashi プラグインで proxy fallback 段を強制スキップ (phase12.5 followup)。本番実証で yodobashi のプレビュー取得が ~21 秒かかっていた原因が「CF Workers proxy 段が ~15-20 秒空回りしてから失敗」だったため、yodobashi では `proxyFallback: undefined` で proxy 段をスキップして curl_cffi に直行する設計に変更。CF Workers fetch も TLS フィンガープリント固定なので yodobashi に対しては構造的に救えない (本来 curl_cffi の libcurl-impersonate が唯一の正解経路)。所要時間 ~3-4 秒に短縮見込み
* **feat**: curl_cffi (TLS layer bot block) フォールバックを Node.js 側に統合 (phase12.5 Step 2)。`src/utils/curl-cffi-fetch.ts` で `child_process.spawn` 経由の透過プロキシブリッジを実装。`SummalyOptions.curlCffiFallback` (or Fastify モードでは `[scraping.curl_cffi]` TOML セクション) で有効化すると、4 段目フォールバック (default UA → fallback UA → CF Worker proxy → curl_cffi) として発火する。`enabled = false` がデフォルトでオプトイン制御。発火条件は `categories` (デフォルト `['timeout', 'connection_dropped', 'bot_blocked']`) + `domains` (suffix-match allowlist 必須) + `https:` プロトコル必須の 3 重 gating。production server 上で `uv sync` 必須。詳細は [docs/SETUP.md](docs/SETUP.md) の curl_cffi セクション参照
* **experimental**: TLS layer bot block 救援用に `tools/curl-cffi-fetcher/` (Python CLI) を追加 (phase12.5 Step 1)。`curl_cffi` (libcurl-impersonate バインディング) で Chrome 120 の TLS フィンガープリント (JA3) と HTTP/2 settings を完全再現し、`got` / Node TLS / CF Workers fetch では弾かれる yodobashi 級の bot block (HTTP/2 INTERNAL_ERROR / 即時切断) を突破できる。**2026-05-06 GO 判定確定** — `https://www.yodobashi.com/product/100000001003176109/` で status 200 + OGP (og:title / og:description / og:image / og:url / og:site_name) 完全取得を確認。本ツールは `package.json` `files` 対象外で **npm publish に含まれない** (production 環境では別途 `cd tools/curl-cffi-fetcher && uv sync` が必要)。Step 2 (Node.js IPC ブリッジ + yodobashi プラグイン統合) は次サイクル
* **feat**: yodobashi プラグインを追加 (phase12.4)。`yodobashi.com` は TLS / HTTP/2 レイヤで bot を能動切断する厳しい WAF を持っており SummalyBot / ブラウザ / SNS bot UA すべてで弾かれる (skill `/url-preview-check` Phase 3 fail mode H)。OGP は整備されているので **proxy fallback の categories を `timeout` / `connection_dropped` も含めるよう拡張**して CF Workers の egress IP / TLS フィンガープリント経由で救援を試みる新パターン。Worker `wrangler.toml` の `ALLOWED_DOMAINS` と summaly `[scraping.proxy].domains` 両側に `yodobashi.com` 追加 + Worker 再 deploy が運用要件
* **feat**: nintendo-store プラグインを追加 (phase12.3)。`store-jp.nintendo.com` 等の My Nintendo Store は Akamai Bot Manager の JS challenge 配下で SummalyBot / ブラウザ UA / Twitterbot / Discordbot だと challenge ページにリダイレクトされるが、`facebookexternalhit/1.1` UA は allowlist されている事実を利用。プラグイン内で UA を固定して `scpaping()` → `parseGeneral()` に流すことで OGP (`og:title` / `og:image` / `og:description` / `og:site_name="My Nintendo Store..."`) が取得できる。skill `/url-preview-check` の Phase 3 fail mode G 「Akamai Bot Manager」のうち SNS bot UA allowlist がある場合の対処パターン
* **fix**: youtube プラグインがライブ配信 URL (`/live/<id>`) にマッチしない問題を修正 (phase12.2)。`PATH_PATTERNS` に `/live/` を追加して oEmbed エンドポイント経由で取得できるようにした。実例: `youtube.com/live/YVjfasn756M` でタイトル / サムネ / iframe player が取れる
* **feat**: Outbound proxy フォールバック (Cloudflare Workers) を追加 (phase12.1):
  * Vultr Tokyo IP からの amazon.co.jp が IP レピュテーション層で 500 を返す問題を救援
  * 3 段リトライ: ① デフォルト UA → ② UA fallback (phase11.9) → ③ **Worker proxy 経由** (新規)
  * `[scraping.proxy]` TOML セクションでオプトイン制御。`secret` は環境変数 `SUMMALY_PROXY_SECRET` 経由を推奨
  * 発火条件: `categories` に含まれるエラーカテゴリ + `domains` allowlist (suffix-match) 一致のみ
  * Worker は `tools/cf-proxy-worker/` にデプロイ。HMAC-SHA256 + タイムスタンプ ±5 分窓 + URL allowlist + HTTPS 限定 + 受信 Body cap (5 MiB) + 透過プロキシ
  * **実証データ**: `https://www.amazon.co.jp/dp/B0C4LRBFX6` を CF Workers 経由で取得 → HTTP 200 / 2.6 MB / 1.81 秒（Vultr 直叩きの 500 と比較してクリアな勝利）
  * Worker は CF Free プラン (100,000 req/day, 10ms CPU/req) で動作。超過しても 429 が返るだけで金額課金は発生しない
  * セキュリティ防衛 8 層 (HTTPS only / HMAC / タイムスタンプ窓 / Worker 側 allowlist / summaly 側 allowlist / 受信 cap / 定数時間比較 / 403 で詳細を返さない)
  * **dev サーバ統合**: `pnpm dev` で `SUMMALY_PROXY_URL` + `SUMMALY_PROXY_SECRET` 環境変数を渡すと UI の checkbox から per-request 切替できる。サンプル URL 「Amazon JP (proxy 経由)」をクリックで `presets.proxy: true` を自動適用。`/api/dev-config` で env 状態を返すが secret は決して露出しない (proxyHost のみ)
  * **E2E 検証成功 (2026-05-05)**: 本番 Worker (`summaly.riinsworkspace.workers.dev`) に対して `node tools/cf-proxy-worker/sign.mjs https://www.amazon.co.jp/dp/B0C4LRBFX6 $WORKER_URL` で透過プロキシ動作確認
  * **followup #1 (2026-05-06)**: Amazon が Vultr Tokyo IP に対して `200 + content-type 欠落` で malformed response を返す bot block 新パターンを発見。`Rejected by type filter undefined` エラーを `unsupported_type` から `bot_blocked` に再分類して proxy fallback で救援できるようにした。proxy categories のデフォルトも `['origin_error']` から `['origin_error', 'bot_blocked']` に変更
  * **followup #2 (2026-05-06)**: 長い query 付き Amazon URL (`/<slug>/dp/<asin>?_encoding=UTF8&pd_rd_w=...&ref_=...`) は CF Workers proxy 経由でも Amazon が 500 を返すケースを発見。`amazon` プラグインに `normalizeAmazonUrl` を追加し、`/dp/<asin>` の canonical 形に正規化（query / fragment / SEO slug を全部削る）してから取得するように変更。referral tracking の query は商品ページの内容に影響しないため副作用なし。**`SummalyResult.url` は変更前と同じ解決済み URL のまま**（正規化は scpaping への送信 URL のみに適用、resolveRedirect の出力には影響しない）
  * **followup #3 (2026-05-06)**: `amazon.co.jp/dp/...` (bare hostname) の URL が amazon プラグインの `test()` でマッチせず general パスに流れて URL 正規化を経由していなかった問題を修正。`test()` を `^(?:www\.)?amazon\.<TLD>$` の anchored 正規表現にして bare / www 両形式をマッチさせる。`normalizeAmazonUrl` も hostname を `www.` 付きの canonical 形に揃えるようにし、Amazon が 301 でリダイレクトする挙動を summaly 側で先回りして潰す。`aws.amazon.com` 等のサブドメインは引き続きマッチしない（テストで担保）
  * **followup #5 (2026-05-06)**: Prime Video URL (`/gp/video/detail/<asin>`) で `title: null` になる問題を修正。Prime Video 専用 HTML は `#title` 要素は存在するが text() が空 (JS で動的に埋まる) かつ og:title も空のため、title 抽出 fallback に `<title>` HTML タグ + `twitter:title` を追加。優先順位は `#title` → `og:title` → `twitter:title` → `<title>` → `''`
  * **followup #4 (2026-05-06)**: `amzn.asia/d/<id>` 等の Amazon 短縮 URL が summaly 本番で薄い preview HTML (og:title="Amazon" / og:image=previewdoh.png) しか取れない問題を修正。原因は Vultr Tokyo IP からの `amzn.asia` GET に Amazon が 301 リダイレクトを返さず 200 + preview HTML を返すため、`resolveRedirect` が `www.amazon.co.jp` に解決できず amazon プラグインへも到達しなかった。修正:
    - `amazon.test()` に `amzn.asia` / `amzn.to` / `a.co` を追加してマッチ可能に
    - `summarize()` に 2 段取得: 短縮 URL は一度 scpaping → final URL から ASIN 抽出 → canonical 形で再 scpaping。final URL も短縮ドメインのままなら preview HTML をそのままパース
    - `parseAmazonHtml` を別関数に切り出し、`#title` / `#productDescription` / `#landingImage` が無い preview HTML でも og:title / og:description / og:image を fallback で見るように補強
    - proxy allowlist に `amzn.asia` / `amzn.to` / `a.co` を追加（Worker と summaly 両側、両方のデプロイ反映が必要）
* **feat**: 迂回候補ログ（ブロック失敗の別系統 JSONL）を追加 (phase11.6):
  * `parseFailureLogBlockedJsonlPath` / `parseFailureLogBlockedJsonlMaxBytes` を追加。`isFilteredFailure` 対象（4xx/5xx, timeout, SSRF block, type filter, network, connection_dropped）の失敗を別ファイルに集約
  * 既存 `parseFailureLogJsonlPath`（プラグイン候補）には引き続き thin + 非フィルタ throw のみ書かれ、シグナル純度を維持
  * 各行に `category` (`SummalyErrorCategory`) と `errorName` を付与。`cat blocked.jsonl | jq -c 'select(.category == "bot_blocked") | .url' | sort -u` で「公開 HTML はブロックだが別 API で同等情報が取れる」迂回候補（npm の registry.npmjs.org が好例）を発見
  * 迂回候補は **in-memory 集約しない**（流量過大によるメモリ消費を避けるため、JSONL 専用）
  * サイズ cap は両系統で独立に効く（流量差を吸収）
  * `ParseFailureLog.record()` に `errorName` / `statusCode` 引数を追加（optional、互換性維持）。内部で `categorizeError` を呼んで振り分け
  * TOML: `[diagnostics]` セクションに `parseFailureLogBlockedJsonlPath` / `parseFailureLogBlockedJsonlMaxBytes` を追加
  * **プライバシー**: blocked ログには失敗 URL の origin+pathname が記録されるため、ファイルパーミッション 600 推奨（plugin-candidate ログと同じ扱い）
* **enhance**: 汎用パスで OG 画像が無い場合 favicon を thumbnail に採用 (phase11.7, [riin-summaly#3](https://github.com/fruitriin/riin-summaly/issues/3)):
  * `parseGeneral` の thumbnail 解決を `og:image` → `twitter:image` → `image_src` → `apple-touch-icon` → **`favicon` (新規)** の順に拡張
  * 「タイトルだけのスカスカプレビュー」が「サイトアイコン入りの最低限の見た目」に格上げされる
  * favicon は `getIcon()` で HEAD 検証済みの URL のみ採用するため、リンク切れや `data:` URI のケースは安全にフォールバックしない（既存挙動維持）
  * `isThinSummary` を補正: `thumbnail === icon` のとき thin 候補として継続判定する。プラグイン化候補のシグナル品質は phase10.1 と同等を維持
* **feat**: Bot block 対策のフォールバック UA リトライを追加 (phase11.9):
  * `SummalyBot` 文字列を WAF が検知して TCP/TLS 確立後に HTTP 応答前で切断する（`socket hang up`）サイトに対する救援機構。`config.toml` の `[scraping.fallback]` でデフォルト ON
  * 1 回目失敗 + `categorizeError` 結果がリトライ対象カテゴリ（デフォルト `bot_blocked` / `connection_dropped`）なら、UA を `facebookexternalhit/1.1` 等に差し替えて 1 回だけ再試行
  * 実証データ: `playing-games.com` / `wacoca.com` のように WAF が `SummalyBot` 文字列で弾くサイト 2/3 を救援できる（残り 1/3 は IP block で射程外）
  * 倫理的配慮: フォールバック UA は `[scraping.fallback].userAgent` で差し替え可能。`facebookexternalhit/1.1` をデフォルトにしたのは、share link を公開するサイトの多くが OGP 取得用途として明示的に許可しているため
  * 副作用: bot block されるサイトは worst case リクエスト数が 1 → 2 に増える。LRU キャッシュ HIT で 2 度目以降は 0 リクエスト、in-flight dedup により並列でも先頭の 1 ユーザーだけが 2 リクエスト払う
  * ライブラリ利用者向け: `summaly()` の `opts.fallbackUserAgent` / `opts.fallbackRetryCategories` で同等のリトライを指定可能
* **enhance**: デフォルト UA を Mozilla プレフィックス付きの複合 UA に変更 (phase11.9):
  * 旧: `SummalyBot/<version>`
  * 新: `Mozilla/5.0 (compatible; SummalyBot/<version>; +https://github.com/fruitriin/riin-summaly)`
  * 自己同定（`SummalyBot/<version>` + URL）は維持。「Mozilla プレフィックス必須」タイプの WAF を底上げで通すための変更
  * 自己説明 URL は riin-summaly fork のリポジトリを指す
* **enhance**: `categorizeError` に `connection_dropped` カテゴリを追加 (phase11.9):
  * 「TCP/TLS は通ったが HTTP 応答を返さず切断」シグニチャ（`socket hang up` / `EPIPE` / `ECONNRESET` / `Empty reply`）を `network_error` から分離
  * **`ECONNRESET` の再分類**: 既存 `network_error` 配下から `connection_dropped` 側に移動（意味的に `socket hang up` とほぼ同じため）。`network_error` で監視している運用者は `connection_dropped` も見るように追加してください
  * pino ログレベルは `warn`（既存 `network_error` と同等）
* **feat**: npmjs.com プラグインを追加 (phase11.4):
  * `https://www.npmjs.com/package/<pkg>` および scoped `/package/@scope/name` で Cloudflare 配下の HTML スクレイプを諦め、Registry API (`https://registry.npmjs.org/<pkg>`) を直叩きして Summary を組み立てる
  * `dist-tags.latest` の `name` / `description` を最優先、無ければ `versions[latest].description` にフォールバック
  * バージョン指定パス (`/v/<ver>`) や `/tutorial` 等のサブパスでも latest の Summary を返す
  * `sitename: 'npm'` 固定、icon/thumbnail は npm の固定 PNG (`static-production.npmjs.com/...`)
  * `allowedPlugins` で `'npmjs'` を指定/除外可能
  * 背景: npm は Cloudflare Bot Management で正規 bot UA も含めて 403 を返すが、Registry API は素通しで `application/json` を返してくれる。X / Discord が npm の OG カードを表示できているのは verified bot の IP allowlist 経由であり、HTTP レイヤでの突破は不可能
* **BREAKING**: `parseFailureLogEndpoint` オプションと `GET /__diagnostics/parse-failures` HTTP エンドポイントを削除しました (phase11.5):
  * プライバシーリスク（過去 preview 試行 URL が前段 nginx の設定ミスで外部漏洩）を恒久排除するため、診断は **`parseFailureLogJsonlPath` で書き出される JSONL ファイル経由で実施** してください
  * 月次レビュー / プラグイン化候補発見の用途は `cat /var/log/summaly/parse-failures.jsonl | jq -r '.key' | sort | uniq -c | sort -rn | head -20` で代替可能
  * 既存の `config.toml` に `parseFailureLogEndpoint = true` が残っていても **smol-toml が unknown key を silent ignore する** ため起動失敗にはならない（移行猶予）。エンドポイントが mount されないだけ
  * `ParseFailureLog` クラス本体（`record()` / `snapshot()` / JSONL 永続化）は維持。`parseFailureLog: true` + `parseFailureLogJsonlPath` の組み合わせは引き続き動作する
* **enhance**: Fastify モードで `summaly()` が throw したとき pino ログを 1 行出力するように (phase11.8):
  * これまでは 500 をクライアントに返すだけでサーバ側ログは無音だったため、本番のエラー原因切り分けが不可能だった
  * `req.log[level]({ err, url, lang, statusCode }, 'summaly error')` を `fetchEntry` catch ブロックで呼ぶ
  * ログレベルは `error.category` 由来で 3 段: `info` (4xx), `warn` (5xx/timeout/SSRF/型 reject 等), `error` (想定外)
  * URL は `sanitizeUrlForLog` で query/fragment/auth 除去（PII 保護）
  * LRU キャッシュ HIT / dedup HIT 時は再ログしない (spam 抑制)
  * `bin/summaly-server.ts` に `setErrorHandler` セーフティネット追加（404 ハンドラ未マッチ等）
  * `journalctl -u summaly --priority=warning -f` で気にすべき分だけ追える運用に

* **Fastify モードのエラーレスポンスをカテゴリ化** (phase11.2, [riin-summaly#2](https://github.com/fruitriin/riin-summaly/issues/2)):
  * 失敗時のレスポンスに `error.category` フィールドを追加 (`SummalyErrorCategory` 型)
  * カテゴリ: `timeout` / `bot_blocked` / `not_found` / `origin_error` / `unsupported_type` / `content_too_large` / `ssrf_blocked` / `network_error` / `parse_error` / `unknown`
  * `StatusError` のときは `error.statusCode` も同梱（HTTP 由来エラーの上流コードが分かる）
  * 既存フィールド (`message` / `name`) は維持して後方互換
  * 利用側 (Misskey 等) で「プレビューできませんでした」を「タイムアウト」「bot block」「リンク切れ」等に細分化表示できる。Misskey 側の対応は本 fork 連携 Plan に記録
  * `categorizeError(message, name, statusCode)` を `src/utils/parse-failure-log.ts` から export し、`isFilteredFailure` (phase10.1) もこの関数ベースに refactor

* **バージョン確認エンドポイント** `GET /v` を追加:
  * 返却 JSON: `{ version, commit, message }`（package.json のバージョン + git の HEAD コミット short hash + コミットメッセージの 1 行目）
  * `Cache-Control: no-store` でキャッシュ無効化（再起動毎に値が変わるため）
  * ビルド時 (`tsdown` / `vitest`) の `define` で baked、tsx 経由 (`bin/summaly-server.ts` / `pnpm dev`) では `setup-version.ts` で globalThis に注入
  * `.git` が無い環境では git 情報は `'unknown'` フォールバックで build を止めない
  * 用途: 「いま動いているデプロイは何のコミットか」を運用者が即確認できる（特に bug fix 後のロールアウト確認）
* **バグ修正**: Fastify モードで `amazon.co.jp/dp/<ASIN>` 等のリダイレクトする URL がプレビュー失敗していた問題を修正 (phase11.3, [riin-summaly#1](https://github.com/fruitriin/riin-summaly/issues/1)):
  * `summaly()` の `followRedirects: false` フラグが scrape 本体 (`scpaping()` 内の got リクエスト) の `followRedirect` に伝播しており、HTTP リダイレクト中間レスポンス (content-type 無し) が typeFilter で reject されて `Rejected by type filter undefined` で死んでいた
  * `followRedirects` の責務を **summaly() の初期 HEAD 解決限定** に再定義し、scpaping レイヤには伝播させないように修正
  * scrape 本体は got のデフォルト挙動 (リダイレクト follow) に任せる。SSRF チェイン抑制は `maxRedirects: 5` + プライベート IP ガードで継続担保
  * 影響: `summaly(url, { followRedirects: false })` を直呼びしていて「scrape 中もリダイレクト追跡を完全停止したい」依存があった場合、挙動が変わる。Fastify モード利用者には改善方向のみ

* Fastify モードに **パース失敗ドメインのログ蓄積** を追加 (phase10.1):
  * `parseFailureLog: true` で「汎用パスでスカスカ（OG/Twitter Card/`<title>` のいずれも取れない）になった URL」をホスト + パス先頭 1〜2 セグメント単位で集約する。プラグイン化候補のドメイン発見器
  * 「絶対失敗する類型」（HTTP 4xx/5xx の `StatusError`、timeout、非 HTML の type filter reject、SSRF block）は自動で除外され、ノイズが乗らない
  * `parseFailureLogEndpoint: true` で `GET /__diagnostics/parse-failures` を mount。**公開時は nginx 等のネットワーク層でアクセス制限が必須**（過去の preview 試行 URL がプライバシー漏洩する）
  * サンプルに保存する URL は `${origin}${pathname}` のみ（query / fragment / basic auth を捨てる）
  * 上限: グループ数 1000、サンプル数 5/group。同 URL の重複追加は抑制
  * デフォルト無効、`SummalyOptions.parseFailureLog` / TOML の `[diagnostics]` セクションでオプトイン
  * **JSONL ファイル永続化** (`parseFailureLogJsonlPath`): record 毎に 1 行 append。`parseFailureLogJsonlMaxBytes`（デフォルト 10 MiB）を超えたら以降 append を停止する（ローテーションはしない、`logrotate` 等で運用者が rm/mv 想定）。書き込み失敗はサイレントスキップ + stderr に 1 回警告
* 短縮 URL の HEAD 失敗時に GET fallback でリダイレクトを解決するように変更 (phase9.1):
  * `amzn.asia` のように HEAD に 404 を返すが GET には 301 でリダイレクトを返す短縮ホストが解決できるようになる
  * GET fallback には `Range: bytes=0-0` を付けて body 受信量を最小化（リダイレクトされる場合は body 自体無く、最終ターゲットが Range を尊重すれば 1 バイトで済む）
  * HEAD が成功する短縮 URL（`spotify.link` 等）の挙動は変わらない
  * HEAD も GET も失敗した場合は元の URL のまま続行（既存挙動互換）
* twitter (X) プラグインを追加 (phase6.1):
  * `(twitter|x).com/<user>/status/<id>` をハンドル
  * `cdn.syndication.twimg.com/tweet-result` から JSON を取得して description / thumbnail / sensitive / `medias[]`（複数画像対応）を組み立てる
  * `player` は **常に null**（Misskey 側に「ポストを展開する」機能があり、summaly が iframe player を返すと表示が二重化するため／mei23 オリジナル準拠）
  * **メンテナンス上の警告**: X 内部 CDN と独自 token 算出ロジックを利用しているため、X 側仕様変更で予告なく壊れる。デフォルト有効だがリスクを承知で運用すること。動作不要なら `allowedPlugins` から `twitter` を除外する
  * 元実装: mei23 fork
* **Breaking**: スタンドアロン Fastify サーバの起動方式を **TOML 設定ファイル** に移行 (phase8.1):
  * 旧: `fastify start ./built/index.js --options summaly-config.json`
  * 新: `pnpm serve config.toml`（または `tsx bin/summaly-server.ts /path/to/config.toml`）
  * `config.example.toml` をリポジトリルートに同梱。`[server]` / `[summaly]` / `[summaly.cache]` / `[summaly.pdf]` / `[plugins]` セクションでコメント付き設定が書ける
  * 不正値（型違い・負数・ポート範囲外等）は起動時に early fail し、メッセージで該当キーが分かる
  * ライブラリ用途（`summaly()` 関数 / `fastify.register(Summaly, opts)`）は変更なし
  * 旧 `summaly-config.example.json` は DEPRECATED として 1 リリース残置、マイグレーション手順は `docs/deploy-examples/README.md` を参照
  * 環境変数 `SUMMALY_CONFIG_PATH` で設定ファイルパスを上書き可能（CLI 引数 > env > `./config.toml`）
* `summaly()` の連続呼び出しで前回の opts が次回呼び出しに漏れるバグを修正 (`Object.assign(summalyDefaultOptions, options)` が `summalyDefaultOptions` を mutate していた)
  * 利用者が異なる opts で連続呼び出ししても、前回の値が混入しなくなります
  * 「前回の `summaly()` 呼び出し後に `summalyDefaultOptions` が変化していること」に依存するコードがあれば動作が変わりますが、想定されない使用方法のため Breaking Change と見做していません
* プラグイン基盤を整備:
  * `getJson(url, referer?, opts?)` ヘルパを追加（プラグインが oEmbed / 外部 JSON API を叩く際の共通入口、SSRF ガード継承）
  * `SummalyPlugin.name` を導入（`allowedPlugins` 等のキー用）、組み込み 4 プラグインに付与
  * `BROWSER_UA` 定数を追加（プラグインからブラウザ UA を上書きする用途）
  * `KNOWN_SHORT_HOSTS` を導入し Fastify モード（`followRedirects: false`）でも公式短縮 URL は HEAD で解決される
* mei23 fork から非プラグイン機能を取り込み:
  * `Summary.medias?: string[]` を追加（マルチ写真対応・利用側は medias 優先 / 無ければ thumbnail）
  * `SummalyOptions.useRange` を追加（`Range: bytes=0-N-1` で帯域節約、サーバ未対応時はフルボディフォールバック）
  * `SummalyOptions.allowedPlugins` を追加（オプトイン許可リスト、空配列で組み込み全 disable）
  * `sanitizeUrl()` で結果 URL のプロトコルフィルタ（`https:` / `http:` / `data:` 10KB 以下のみ通す）
  * keep-alive デフォルト agent を導入（高頻度プレビューでの遅延削減、`setAgent` で外部 agent 注入時はそちらを優先）
  * `SUMMALY_FAMILY=4` / `=6` で IP family を強制可能
  * 文字コード判定を `chardet` → `jschardet` + `encoding-japanese` に置き換え（[issue #39](https://github.com/misskey-dev/summaly/issues/39): ISO-2022-JP の文字化けを修正）
* `docs/deploy-examples/` に nginx / systemd / 設定 JSON の参考例を追加
* PDF レスポンス対応をオプトインで追加:
  * `enablePdf: true` または環境変数 `SUMMALY_ENABLE_PDF=true` で PDF からタイトル取得が有効化される（デフォルトは無効、既存挙動と互換）
  * `pdf-parse@2` の `getInfo()` で document-level metadata だけを読み、本文ページ解析は走らない
  * 5 秒で hard timeout、`contentLengthLimit` で受信前にサイズ制限、`useRange` 併用で先頭領域だけ取得など多段防衛
  * Title が無い / パース失敗 / timeout 時は hostname を title に、固定の SVG PDF アイコン (`data:image/svg+xml;base64,...`) を icon に返す
  * `enablePdf: false` を明示すると環境変数より優先される（呼出側の意思を尊重）
* Fastify モードに **インメモリ LRU キャッシュ** をオプトインで追加 (issue #27):
  * `inMemoryCache: true` で同一 URL リクエストをサーバ内 LRU キャッシュから返す。`Cache-Control` を解釈しない HTTP クライアント（Misskey の Got / node-fetch 等）でも summaly サーバ単独で重複アクセスを抑制可能
  * 成功 / エラーともキャッシュ。それぞれ `cacheMaxAge` / `cacheErrorMaxAge` を TTL として流用
  * `inMemoryCacheMaxEntries` (デフォルト 1000) でエントリ数上限
  * レスポンスに `X-Cache: HIT` / `MISS` を付与（無効時は付かない）
  * キャッシュキーは URL（フラグメント除去）+ `lang`。プロセス再起動でキャッシュは消える
* Fastify モードに **in-flight リクエスト dedup** を追加（thundering herd 緩和）:
  * `inFlightDedup: true`（**デフォルト有効**）で、同一 URL の並列リクエストを先頭リクエストの結果に集約し、origin への同時アクセスを 1 本化する
  * Misskey のユーザーストリーミング機能で同一リンクが多数のクライアントから同時に引かれるケースで origin が DDoS のように見える問題を抑制
  * `inMemoryCache` とは独立に効くため、キャッシュ無効でも並列の集中だけは抑えられる（両方有効が推奨）
  * `X-Cache: HIT-COALESCED` ヘッダで dedup 効果を可視化（並列待ちで取得したリクエストに付く）
  * 完全に従来挙動に戻すには `inFlightDedup: false` を明示（`X-Cache` ヘッダの追加だけが純粋な互換性影響だが、改善方向のため Breaking Change と見做していない）
* DOM 後処理系プラグインを追加（dlsite / iwara / komiflo / nijie）:
  * `dlsite`: `www.dlsite.com`。`/announce/` ↔ `/work/` で 404 のときに自動再取得、結果パスのカテゴリで `sensitive` を判定
  * `iwara`: `(www|ecchi).iwara.tv`。description を `.field-type-text-with-summary` から、thumbnail を `#video-player[poster]` 等から補完。`ecchi.` ホストで `sensitive`
  * `komiflo`: `komiflo.com/comics/<id>`。thumbnail がデフォルト画像 (`favicon`/`ogp_logo`) にフォールバックしている場合のみ `api.komiflo.com` から `346_mobile` variant を取得して `sensitive`
  * `nijie`: `nijie.info/view.php`。`<script type="application/ld+json">` の `ImageObject` から description / thumbnail を補完。`view.php` 着地で `sensitive`
  * これらは性的コンテンツを含むサイトを扱います。デフォルト無効で運用したい場合は `allowedPlugins` から除外してください
* oEmbed 系プラグインを追加（youtube / spotify）:
  * `youtube`: `*.youtube.com/{watch,v,playlist,shorts}` および `youtu.be/<id>` をハンドル。`https://www.youtube.com/oembed` を 1 リクエストで叩く高速化パス
  * `spotify`: `open.spotify.com` をハンドル。`https://open.spotify.com/oembed` 経由
  * 既存の汎用 `general()` 経由（HTML 取得 → oEmbed フォールバック）に比べてリクエスト数が削減される
  * **挙動変更**: oEmbed には description フィールドが無いため、上記サイトでは `description: null` になります（従来は OG メタの description を返していました）

5.3.0 / 2026/05/02
------------------
* summalyをバンドルしてビルドするように
  * パスを参照してsummalyの特定のファイルをインポートしている場合はそれらが使用できなくなりますが、想定されている使用方法ではないためBreaking Changeと見做していません。
* 依存関係の見直し
* `SummalyResult`型をexportするように
* summalyを別のプロジェクトにバンドルして使用できない問題を修正
* 依存関係の更新

5.2.5 / 2025/10/22
------------------
* 依存関係の更新

5.2.4 / 2025/10/01
------------------
* 依存関係の更新

5.2.3 / 2025/07/19
------------------
* パッケージが使用できない問題を修正

5.2.2 / 2025/07/06
------------------
* 最初のHEADリクエストにUAが反映されない問題を修正
* 依存関係の更新
* テストスイートをVitestに変更

5.2.1 / 2025/04/28
------------------
* セキュリティに関する修正

5.2.0 / 2025/02/05
------------------
* センシティブフラグの判定を `<meta property="rating">` および `rating` ヘッダでも行うように
* Bluesky（bsky.app）のプレビューに対応
* `fediverse:creator` のパースに対応
* 依存関係の更新
* eslintの設定を更新

5.1.0 / 2024-03-18
------------------
* GETリクエストよりも前にHEADリクエストを送信し、その結果を使用して検証するように (#22)
* 下記のパラメータを`summaly`メソッドのオプションに追加
  - userAgent
  - responseTimeout
  - operationTimeout
  - contentLengthLimit
  - contentLengthRequired

5.0.3 / 2023-12-30
------------------
* Fix .github/workflows/npm-publish.yml

5.0.2 / 2023-12-30
------------------
* Fix .github/workflows/npm-publish.yml

5.0.1 / 2023-12-30
------------------
* Fix .github/workflows/npm-publish.yml

5.0.0 / 2023-12-30
------------------
* support `<link rel="alternate" type="application/activitypub+json" href="{href}">` https://github.com/misskey-dev/summaly/pull/10, https://github.com/misskey-dev/summaly/pull/11
  * 結果の`activityPub`プロパティでherfの内容を取得できます
* branch.ioを用いたディープリンク（spotify.link）などでパースに失敗する問題を修正 https://github.com/misskey-dev/summaly/pull/13
* Twitter Cardが読めていない問題を修正 https://github.com/misskey-dev/summaly/pull/15
* 'mixi:content-rating'をsensitive判定で見ることで、dlsiteなどでセンシティブ情報を得れるように https://github.com/misskey-dev/summaly/pull/16
* sitenameをURLから生成する場合、ポートを含むように (URL.hostname → URL.host)
* `Summary`型に`url`プロパティを追加した`SummalyResult`型をexportするように
* `IPlugin`インターフェースを`SummalyPlugin`に改称

4.0.2 / 2023-04-20
------------------
* YouTubeをフルスクリーンにできない問題を修正

4.0.1 / 2023-03-16
------------------
* oEmbedの読み込みでエラーが発生した際は、エラーにせずplayerの中身をnullにするように

4.0.0 / 2023-03-14
------------------
* oEmbed type=richの制限的なサポート
* プラグインの引数がWHATWG URLになりました

3.0.4 / 2023-02-12
------------------
* 不要な依存関係を除去

3.0.3 / 2023-02-12
------------------
* agentが指定されている（もしくはagentが空のオブジェクトの）場合はプライベートIPのリクエストを許可

3.0.2 / 2023-02-12
------------------
* Fastifyのルーティングを'/url'から'/'に

3.0.1 / 2023-02-12
------------------
* ES Moduleになりました
  - `import { summaly } from 'summaly';`で関数をインポートします
  - デフォルトエクスポートはFastifyプラグインになります
* https/http agents options
* サーバーのコマンドはnpm run serveになりました

2.7.0 / 2022-07-09
------------------
* accept XHTML
* update got to 11.8.5

2.6.0 / 2022-06-18
------------------
* Improve player detection

2.5.0 / 2021-12-17
------------------
* プライベートIPアドレス等は拒否するように
* Update dependencies

2.3.1 / 2019-09-02
------------------
* Fix amazon support
* Update dependencies

2.3.0 / 2019-06-18
------------------
* Lang support

2.2.0 / 2018-08-29
------------------
* Add standalone server

2.1.4 / 2018-08-22
------------------
* Fix bug

2.1.3 / 2018-08-16
------------------
* Fix bug

2.1.2 / 2018-08-11
------------------
* Fix bug

2.1.1 / 2018-08-10
------------------
* Fix bug

2.1.0 / 2018-08-09
------------------
* Add twitter:player support
* Dependency updates

2.0.6 / 2018-05-18
------------------
* Fix bug

2.0.5 / 2018-05-18
------------------
* Fix bug

2.0.4 / 2018-04-18
------------------
* Dependencies update

2.0.3 / 2017-05-06
------------------
* Improve title cleanuping

2.0.2 / 2017-05-04
------------------
* Support more favicon cases #64
* Update some dependencies
* Bug fix

2.0.1 / 2017-03-11
------------------
* Update some dependencies
* Some refactors

2.0.0 / 2017-02-08
------------------
* **[BREAKING CHANGE] Renamed: Plugins: Method `summary` is now `summarize`**
* Some refactors

1.6.1 / 2017-02-06
------------------
* Fix the incorrect type definition

1.6.0 / 2017-02-05
------------------
* Add user-defined plugin support #22
* Add `followRedirects` option #16
* Add `url` property to result #15

1.5.0 / 2017-01-31
------------------
* Improve: Check favicon exist #7
* [Plugin:Wikipedia] Improve: Clip description #11
* Fix: Import the missing function

1.4.1 / 2017-01-30
------------------
* [Plugin:Wikipedia] Fix bug

1.4.0 / 2017-01-30
------------------
* Follow redirects #5

1.3.0 / 2017-01-15
------------------
* Improve: Better Wikipedia support #2
* Remove babel completely

1.2.7 / 2016-12-11
------------------
* iroiro
* Remove babel

1.2.6 / 2016-10-23
------------------
* Bug fix

1.2.5 / 2016-10-23
------------------
* Fix type definitions problem

1.2.4 / 2016-09-22
------------------
* Fix: Add missing dependency

1.2.3 / 2016-09-15
------------------
* Improvement

1.2.2 / 2016-09-15
------------------
* Bug fix

1.2.1 / 2016-09-15
------------------
* Some improvements
* Some bug fixes

1.2.0 / 2016-09-15
------------------
* Amazon support

1.1.3 / 2016-09-15
------------------
* [Plugin:Wikipedia] Bug fix

1.1.2 / 2016-09-15
------------------
* Bug fix

1.1.1 / 2016-09-15
------------------
* Bug fix

1.1.0 / 2016-09-15
------------------
* Some improvements

1.0.0 / 2016-09-15
------------------
**[BREAKING CHANGE] なんかもうめっちゃ変えた**

0.0.1 / 2016-09-13
------------------
* :bug: Some bug fixes
  * https://github.com/syuilo/summaly/commit/65de5ae1fbf6a0f4dacccc12f2a2e027142ae4b0
  * https://github.com/syuilo/summaly/commit/33132b2ba2744835c52b72da4c4c8b854b0d2045

0.0.0 / 2016-09-13
------------------
Initial release
