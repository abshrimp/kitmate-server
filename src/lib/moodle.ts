// Moodle トークン検証 (core_webservice_get_site_info)。結果は 10 分メモリキャッシュ。

const MOODLE_BASE = 'https://moodle.cis.kit.ac.jp';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;

export type MoodleVerifyResult =
  | { ok: true; username: string }
  | { ok: false; status: 401 | 502 | 503; error: string };

const verifyCache = new Map<string, { result: MoodleVerifyResult; at: number }>();

function pruneCache(): void {
  if (verifyCache.size <= CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of verifyCache) {
    if (now - entry.at >= CACHE_TTL_MS) verifyCache.delete(key);
  }
  // それでも溢れていれば古いものから削除 (Map は挿入順)
  while (verifyCache.size > CACHE_MAX_ENTRIES) {
    const oldest = verifyCache.keys().next().value;
    if (oldest === undefined) break;
    verifyCache.delete(oldest);
  }
}

export async function verifyMoodleToken(wstoken: string): Promise<MoodleVerifyResult> {
  const cached = verifyCache.get(wstoken);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  let result: MoodleVerifyResult;
  try {
    const body = new URLSearchParams({
      wsfunction: 'core_webservice_get_site_info',
      wstoken,
      moodlewssettingfilter: 'true',
      moodlewssettingfileurl: 'true',
      moodlewssettinglang: 'ja',
    });
    const res = await fetch(
      `${MOODLE_BASE}/webservice/rest/server.php?moodlewsrestformat=json&wsfunction=core_webservice_get_site_info`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const json = (await res.json()) as { username?: unknown; exception?: unknown; errorcode?: unknown };
    if (typeof json.username === 'string' && json.username.length > 0) {
      result = { ok: true, username: json.username };
    } else if (json.errorcode === 'invalidtoken') {
      result = { ok: false, status: 401, error: 'invalidtoken' };
    } else {
      result = { ok: false, status: 502, error: typeof json.errorcode === 'string' ? json.errorcode : 'moodle_error' };
    }
  } catch (e) {
    console.error('[moodle] verify failed:', e);
    // 一時的なネットワーク障害はキャッシュしない
    return { ok: false, status: 503, error: 'moodle_unreachable' };
  }

  verifyCache.set(wstoken, { result, at: Date.now() });
  pruneCache();
  return result;
}
