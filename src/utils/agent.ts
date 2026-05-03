import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

/**
 * IP family を SUMMALY_FAMILY 環境変数から決定する。
 * - '4' → IPv4 のみ
 * - '6' → IPv6 のみ
 * - それ以外（未設定含む）→ システム任せ（undefined）
 */
function ipFamily(): 4 | 6 | undefined {
	const v = process.env.SUMMALY_FAMILY;
	if (v === '4') return 4;
	if (v === '6') return 6;
	return undefined;
}

/**
 * keep-alive を有効にしたデフォルト agent。高頻度プレビュー用途で TCP/TLS ハンドシェイクを節約する。
 * 外部から `setAgent` で agent が注入された場合はそちらを優先するため、これは fallback として利用される。
 */
export const defaultHttpAgent = new HttpAgent({
	keepAlive: true,
	keepAliveMsecs: 30 * 1000,
	family: ipFamily(),
});

export const defaultHttpsAgent = new HttpsAgent({
	keepAlive: true,
	keepAliveMsecs: 30 * 1000,
	family: ipFamily(),
});

/**
 * テスト後の cleanup などでソケットを明示的に閉じたい場合に呼ぶ。
 */
export function destroyDefaultAgents(): void {
	defaultHttpAgent.destroy();
	defaultHttpsAgent.destroy();
}
