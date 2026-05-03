summaly
================================================================

[![][npm-badge]][npm-link]
[![][mit-badge]][mit]
[![][himawari-badge]][himasaku]
[![][sakurako-badge]][himasaku]

Installation
----------------------------------------------------------------
```
npm install @misskey-dev/summaly
```

Usage
----------------------------------------------------------------
As a function:

```javascript
import { summaly } from 'summaly';

summaly(url[, opts])
```

As Fastify plugin:
(will listen `GET` of `/`)

```javascript
import Summaly from 'summaly';

fastify.register(Summaly[, opts])
```

Run the server:

```
git clone https://github.com/misskey-dev/summaly.git
cd summaly
NODE_ENV=development npm install
npm run build
npm run serve
```

#### opts (SummalyOptions)

| Property                  | Type                   | Description                                                                                                                                                                         | Default                |
|:--------------------------|:-----------------------|:------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:-----------------------|
| **lang**                  | *string*               | Accept-Language for the request                                                                                                                                                     | `null`                 |
| **followRedirects**       | *boolean*              | Whether follow redirects                                                                                                                                                            | `true`                 |
| **plugins**               | *plugin[]* (see below) | Custom plugins                                                                                                                                                                      | `null`                 |
| **agent**                 | *Got.Agents*           | Custom HTTP agent (see below)                                                                                                                                                       | `null`                 |
| **userAgent**             | *string*               | User-Agent for the request                                                                                                                                                          | `SummalyBot/[version]` |
| **responseTimeout**       | *number*               | Set timeouts for each phase, such as host name resolution and socket communication.                                                                                                 | `20000`                |
| **operationTimeout**      | *number*               | Set the timeout from the start to the end of the request.                                                                                                                           | `60000`                |
| **contentLengthLimit**    | *number*               | If set to true, an error will occur if the content-length value returned from the other server is larger than this parameter (or if the received body size exceeds this parameter). | `10485760`             |
| **contentLengthRequired** | *boolean*              | If set to true, it will be an error if the other server does not return content-length.                                                                                             | `false`                |
| **cacheMaxAge**           | *number*               | Fastify mode only. `Cache-Control: public, max-age=<n>` (seconds) for successful responses. Set to `0` to emit `Cache-Control: no-store`.                                           | `604800` (1 week)      |
| **cacheErrorMaxAge**      | *number*               | Fastify mode only. `Cache-Control: public, max-age=<n>` (seconds) for error responses. Set to `0` to emit `Cache-Control: no-store`.                                                | `3600` (1 hour)        |
| **useRange**              | *boolean*              | Send `Range: bytes=0-N-1` to fetch only the head of the document. Servers that ignore Range fall back to full body (still capped by `contentLengthLimit`).                            | `false`                |
| **allowedPlugins**        | *string[]*             | Opt-in allowlist of builtin plugin names. `undefined` = all enabled. Empty array `[]` = all builtins disabled (general path only). Custom `plugins` are not filtered.                 | `undefined`            |
| **inMemoryCache**         | *boolean*              | Fastify mode only. Enable in-process LRU cache so repeated requests for the same URL are served from memory. Useful when an HTTP client (e.g. Got, node-fetch) ignores `Cache-Control`. | `false`                |
| **inMemoryCacheMaxEntries** | *number*             | Fastify mode only. Maximum number of entries in the in-memory cache. Each entry is typically a few KB, but a long `description` or `data:` thumbnail can push it higher; size accordingly. | `1000`                 |

#### Server caching

When summaly is used as a Fastify plugin (`fastify.register(Summaly, opts)`), every response includes a `Cache-Control` header so that upstream caches (nginx `proxy_cache`, Cloudflare, etc.) can serve repeated lookups without round-tripping to the origin site. Successful responses default to `public, max-age=604800` (1 week) and error responses to `public, max-age=3600` (1 hour). Caching errors briefly avoids amplifying repeated requests for broken URLs (related to the [Mastodon link-preview DDoS issue](https://github.com/mastodon/mastodon/issues/23662)).

Override the durations with `cacheMaxAge` / `cacheErrorMaxAge`, or set them to `0` to opt out (`Cache-Control: no-store`). Note that some HTTP clients (e.g. Got, node-fetch) do not honor `Cache-Control`; if you need application-level caching, run summaly behind nginx / a CDN, or use the in-process LRU cache below.

#### In-process LRU cache

Set `inMemoryCache: true` (Fastify mode) to enable an in-process LRU cache backed by `lru-cache`. Repeat requests for the same URL within `cacheMaxAge` are served from memory and never reach the origin site. Errors are cached separately for `cacheErrorMaxAge` to amplify-protect against repeated bad URLs.

Cache key: URL with the fragment (`#...`) stripped, plus the `lang` query value (`ja` and `en` are separate entries to avoid serving Japanese results to English users). Cap entries via `inMemoryCacheMaxEntries`. Each response includes `X-Cache: HIT` or `X-Cache: MISS`.

**Caveats**:
- 5xx errors are also cached for `cacheErrorMaxAge` (default 1 hour). If an upstream site recovers from an outage, summaly will continue returning the cached error until the TTL expires. Restart the process or lower `cacheErrorMaxAge` to mitigate.
- Concurrent requests for the same URL each hit the origin until the first response populates the cache (no in-flight dedup).
- Cache lives for the process lifetime only; restart the server to flush. For persistent or shared caches across replicas, run summaly behind nginx / Varnish / a CDN that honours the emitted `Cache-Control` header.

#### Plugin

``` typescript
interface SummalyPlugin {
	test: (url: URL) => boolean;
	summarize: (url: URL) => Promise<Summary>;
}
```

urls are WHATWG URL since v4.

#### Custom HTTP agent for proxy
You can specify agents to be passed to Got for proxy use, etc.  
https://github.com/sindresorhus/got/blob/v12.6.0/documentation/tips.md#proxying

**⚠️If you set some agent, local IP rejecting will not work.⚠️**  
(Summaly usually rejects local IPs.)

(Summaly currently does not support http2.)

When `setAgent` is **not** called, summaly uses a built-in keep-alive agent (HTTP / HTTPS) to amortize TCP/TLS handshakes for high-frequency preview workloads. Set `SUMMALY_FAMILY=4` or `SUMMALY_FAMILY=6` to force IPv4 / IPv6 only.

#### Production deployment

For running summaly as a standalone Fastify server behind nginx + systemd, see [docs/deploy-examples/](docs/deploy-examples/) — nginx reverse proxy, systemd unit, and JSON config samples (treat as starting points; verify against your environment).

### Returns

A Promise of an Object that contains properties below:

※ Almost all values are nullable. player should not be null.

#### SummalyResult

| Property        | Type               | Description                                                |
|:----------------|:-------------------|:-----------------------------------------------------------|
| **title**            | *string* \| *null* | The title of the web page                                  |
| **icon**             | *string* \| *null* | The url of the icon of the web page                        |
| **description**      | *string* \| *null* | The description of the web page                            |
| **thumbnail**        | *string* \| *null* | The url of the thumbnail of the web page                   |
| **sitename**         | *string* \| *null* | The name of the web site                                   |
| **player**           | *Player*           | The player of the web page                                 |
| **sensitive**        | *boolean*          | Whether the url is sensitive                               |
| **activityPub**      | *string* \| *null* | The url of the ActivityPub representation of that web page |
| **fediverseCreator** | *string* \| *null* | The pages fediverse handle                                 |
| **medias**           | *string[]* \| *undefined* | Additional media URLs (e.g. multi-photo posts). Consumers should prefer `medias` when set, fall back to `thumbnail` otherwise. |
| **url**              | *string*           | The url of the web page                                    |

#### Summary

`Omit<SummalyResult, "url">`

#### Player

| Property   | Type               | Description                                     |
|:-----------|:-------------------|:------------------------------------------------|
| **url**    | *string* \| *null* | The url of the player                           |
| **width**  | *number* \| *null* | The width of the player                         |
| **height** | *number* \| *null* | The height of the player                        |
| **allow**  | *string[]*         | The names of the allowed permissions for iframe |

Currently the possible items in `allow` are:

* `autoplay`
* `clipboard-write`
* `fullscreen`
* `encrypted-media`
* `picture-in-picture`
* `web-share`

See [Permissions Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Permissions_Policy) in MDN for details of them.

### Example

```javascript
import { summaly } from 'summaly';

const summary = await summaly('https://www.youtube.com/watch?v=NMIEAhH_fTU');

console.log(summary);
```

will be ... ↓

```json
{
	"title": "【アイドルマスター】「Stage Bye Stage」(歌：島村卯月、渋谷凛、本田未央)",
	"icon": "https://www.youtube.com/favicon.ico",
	"description": null,
	"thumbnail": "https://i.ytimg.com/vi/NMIEAhH_fTU/maxresdefault.jpg",
	"player": {
		"url": "https://www.youtube.com/embed/NMIEAhH_fTU?feature=oembed",
		"width": 200,
		"height": 113,
		"allow": [
			"autoplay",
			"clipboard-write",
			"encrypted-media",
			"picture-in-picture",
			"web-share",
			"fullscreen"
		]
	},
	"sitename": "YouTube",
	"activityPub": null,
	"fediverseCreator": null,
	"url": "https://www.youtube.com/watch?v=NMIEAhH_fTU"
}
```

Note: Since v5.4 (phase3.1), YouTube / Spotify URLs are processed via the dedicated oEmbed plugins which do not include a `description` field (oEmbed responses do not provide one). For the previous behavior of pulling description from OG meta, set `allowedPlugins: ['amazon', 'bluesky', 'wikipedia', 'branchio-deeplinks']` to disable the youtube/spotify plugins and fall back to the general path.

Testing
----------------------------------------------------------------
`npm run test`

License
----------------------------------------------------------------
[MIT](LICENSE)

[mit]:            http://opensource.org/licenses/MIT
[mit-badge]:      https://img.shields.io/badge/license-MIT-444444.svg?style=flat-square
[himasaku]:       https://himasaku.net
[himawari-badge]: https://img.shields.io/badge/%E5%8F%A4%E8%B0%B7-%E5%90%91%E6%97%A5%E8%91%B5-1684c5.svg?style=flat-square
[sakurako-badge]: https://img.shields.io/badge/%E5%A4%A7%E5%AE%A4-%E6%AB%BB%E5%AD%90-efb02a.svg?style=flat-square
[npm-link]:       https://www.npmjs.com/package/@misskey-dev/summaly
[npm-badge]:      https://img.shields.io/npm/v/@misskey-dev/summaly.svg?style=flat-square
