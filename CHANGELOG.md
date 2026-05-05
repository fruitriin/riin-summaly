(unreleased)
------------------
* 短縮 URL の HEAD 失敗時に GET fallback でリダイレクトを解決するように変更 (phase9.1):
  * `amzn.asia` のように HEAD に 404 を返すが GET には 301 でリダイレクトを返す短縮ホストが解決できるようになる
  * GET fallback には `Range: bytes=0-0` を付けて body 受信量を最小化（リダイレクトされる場合は body 自体無く、最終ターゲットが Range を尊重すれば 1 バイトで済む）
  * HEAD が成功する短縮 URL（`spotify.link` 等）の挙動は変わらない
  * HEAD も GET も失敗した場合は元の URL のまま続行（既存挙動互換）
* twitter (X) プラグインを追加 (phase6.1):
  * `(twitter|x).com/<user>/status/<id>` をハンドル
  * `cdn.syndication.twimg.com/tweet-result` から JSON を取得して description / thumbnail / sensitive / `medias[]`（複数画像対応）を組み立てる
  * `platform.twitter.com/embed/Tweet.html?id=<id>` を `player.url` として返し、利用側で iframe 展開できる
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
