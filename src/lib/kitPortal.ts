import https from 'node:https';
import type { CancellationFeed, CancellationNotice, LectureNotice } from '../types.js';

// KIT ポータル (portal.student.kit.ac.jp) から休講通知・授業関連連絡を直接スクレイプする。
// 学外からは直接アクセスできないため、KIT の SSL-VPN (vpns.cis.kit.ac.jp) のプロキシ
// 経由でアクセスし、Shibboleth (学認) ログインを突破する。元実装は Python + requests +
// BeautifulSoup。ここでは外部依存なしで Cookie jar / HTML パース / フォーム自動送信を再現する。
//
//   1. /remote/logincheck に学籍番号+パスワードを POST          → VPN ログイン (redir 取得)
//   2. redir 先 (install URL) にアクセス                        → SVPNCOOKIE
//   3. /remote/portal の JSON を取得                            → fgt_sslvpn_sid (プロキシ ID)
//   4. プロキシ URL で ?c=lecture_cancellation にアクセス       → Shibboleth フローへ
//   5. 中間フォーム (shib_idp_ls) を自動送信 ×2
//   6. IdP に j_username/j_password を POST
//   7. 残りのフォームを自動送信 ×2                              → ポータルセッション確立
//   8. lecture_cancellation / lecture_information の表をスクレイプ
//
// 認証情報は環境変数 KIT_USER_ID / KIT_PASSWORD で渡す (未設定/失敗時はエラーを伝播。フォールバックなし)。

const VPN_HOST = process.env.KIT_VPN_HOST ?? 'vpns.cis.kit.ac.jp';
const PORTAL_HOST = 'portal.student.kit.ac.jp';
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 15;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

export function hasPortalCredentials(): boolean {
  return Boolean(process.env.KIT_USER_ID && process.env.KIT_PASSWORD);
}

// ===== Cookie jar =====
// 通信はすべて同一ホスト (vpns.cis.kit.ac.jp) 上で完結する (ポータル/IdP もプロキシ経由)
// ため、ドメインを区別しない単純な name=value ストアで十分。
class CookieJar {
  private jar = new Map<string, string>();

  setFromResponse(setCookie: string[] | undefined): void {
    for (const raw of setCookie ?? []) {
      const pair = raw.split(';', 1)[0]?.trim();
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || value === 'deleted') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

// 低レベル HTTP リクエスト。グローバル fetch (undici) は厳格な HTTP パーサを持ち、
// Fortinet SSL-VPN が返す非準拠なチャンク転送 (チャンクサイズに余分な空白等) を
// HPE_INVALID_CHUNK_SIZE で拒否する。Node の https モジュールは per-request の
// insecureHTTPParser: true で寛容に解釈できる (Python requests と同等の挙動)。
function rawRequest(
  method: string,
  urlStr: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const reqHeaders: Record<string, string> = {
      'accept-encoding': 'identity', // gzip を要求しない (自前で解凍しないため)
      ...headers,
    };
    if (body !== undefined) reqHeaders['content-length'] = String(Buffer.byteLength(body));

    const req = https.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: reqHeaders,
        insecureHTTPParser: true,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('[kitPortal] request timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function headerString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

interface HopResult {
  status: number;
  text: string;
  url: string; // 最終 URL (リダイレクト追跡後)。相対 action の解決に使う
}

// リダイレクトを手動で追跡しつつ Cookie jar を更新する HTTP ラッパ。
// Cookie は各ホップで明示的に付与する。
async function fetchFollow(
  jar: CookieJar,
  startUrl: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<HopResult> {
  let url = startUrl;
  let method = init.method ?? 'GET';
  let body = init.body;
  let headers: Record<string, string> = { 'user-agent': USER_AGENT, ...(init.headers ?? {}) };

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const cookie = jar.header();
    const res = await rawRequest(method, url, cookie ? { ...headers, cookie } : headers, body);
    jar.setFromResponse(res.headers['set-cookie'] as string[] | undefined);

    if (res.status >= 300 && res.status < 400) {
      const loc = headerString(res.headers['location']);
      if (loc) {
        url = new URL(loc, url).toString();
        // 3xx 後は GET に切り替え (302/303 相当)。body と content-type は破棄。
        method = 'GET';
        body = undefined;
        const { 'content-type': _ct, ...rest } = headers;
        headers = rest;
        continue;
      }
    }
    return { status: res.status, text: res.body, url };
  }
  throw new Error('[kitPortal] too many redirects');
}

function encodeForm(payload: Record<string, string>): string {
  return Object.entries(payload)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ===== 最小限の HTML パース =====
function getAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  if (!m) return null;
  return m[2] ?? m[3] ?? '';
}

interface ParsedForm {
  action: string;
  inputs: Record<string, string>;
}

// 最初の <form> を取り出し、action と <input name=...> の値を集める。
function parseFirstForm(html: string): ParsedForm | null {
  const formMatch = html.match(/<form\b[\s\S]*?<\/form>/i);
  if (!formMatch) return null;
  const form = formMatch[0];
  const openTag = form.match(/<form\b[^>]*>/i)?.[0] ?? '';
  const action = getAttr(openTag, 'action') ?? '';

  const inputs: Record<string, string> = {};
  for (const tag of form.match(/<input\b[^>]*>/gi) ?? []) {
    const name = getAttr(tag, 'name');
    if (!name) continue;
    inputs[name] = getAttr(tag, 'value') ?? '';
  }
  return { action, inputs };
}

// Shibboleth の自動送信フォーム (shib_idp_ls 等) を再現して POST する。
async function submitForm(
  jar: CookieJar,
  html: string,
  baseUrl: string,
  success: boolean,
): Promise<HopResult> {
  const form = parseFirstForm(html);
  if (!form) throw new Error('[kitPortal] expected an auto-submit form but found none');
  const payload = { ...form.inputs };
  if (success) payload['shib_idp_ls_success.shib_idp_session_ss'] = 'true';
  const action = new URL(form.action || baseUrl, baseUrl).toString();
  return fetchFollow(jar, action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: encodeForm(payload),
  });
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

// セル内 HTML をプレーンテキストに。全角スペース (U+3000) は氏名で意味を持つため
// 折り畳み対象に含めず、ASCII の空白/改行のみ単一スペースに正規化する。
function cellTextPlain(innerHtml: string): string {
  return decodeEntities(innerHtml.replace(/<[^>]+>/g, ''))
    .replace(/[ \t\r\n\f]+/g, ' ')
    .trim();
}

// 連絡事項など複数行セル用。<br> を改行に変換してから他タグを除去。
function cellTextMultiline(innerHtml: string): string {
  return decodeEntities(innerHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 指定 id の <table> を取り出し、各 <tr> の <td> 内 HTML を二次元配列で返す。
// (ネストした table は想定しない。<th> のみの行は除外される)
function extractTableRows(html: string, tableId: string): string[][] {
  const idIdx = html.search(new RegExp(`<table\\b[^>]*\\bid\\s*=\\s*["']${tableId}["']`, 'i'));
  if (idIdx < 0) return [];
  const startIdx = html.lastIndexOf('<table', idIdx + 6);
  const endIdx = html.indexOf('</table>', idIdx);
  if (startIdx < 0 || endIdx < 0) return [];
  const table = html.slice(startIdx, endIdx);

  const rows: string[][] = [];
  for (const trMatch of table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (trMatch.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) ?? []).map((td) =>
      td.replace(/^<td\b[^>]*>/i, '').replace(/<\/td>$/i, ''),
    );
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function toInt(s: string): number {
  const n = parseInt(s.replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function splitInstructors(s: string): string[] {
  return s
    .split(/[,、，]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

// ===== ログイン =====
async function login(jar: CookieJar): Promise<string> {
  const userId = process.env.KIT_USER_ID;
  const password = process.env.KIT_PASSWORD;
  if (!userId || !password) throw new Error('[kitPortal] KIT_USER_ID / KIT_PASSWORD not set');

  // 1. VPN ログイン
  const loginUrl = `https://${VPN_HOST}/remote/logincheck`;
  const loginRes = await fetchFollow(jar, loginUrl, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      origin: `https://${VPN_HOST}`,
      referer: `https://${VPN_HOST}/remote/login?lang=x-sjis`,
    },
    body: `ajax=1&username=${encodeURIComponent(userId)}&realm=&credential=${encodeURIComponent(password)}`,
  });
  const redirPart = loginRes.text.split('redir=')[1];
  if (!redirPart) throw new Error('[kitPortal] VPN login failed (no redir; check credentials)');

  // 2. install URL → SVPNCOOKIE
  await fetchFollow(jar, `https://${VPN_HOST}${redirPart}`, {
    headers: { referer: `https://${VPN_HOST}/remote/login?lang=x-sjis` },
  });

  // 3. fgt_sslvpn_sid
  const portalRes = await fetchFollow(jar, `https://${VPN_HOST}/remote/portal`, {
    headers: { accept: '*/*', referer: `https://${VPN_HOST}/sslvpn/portal/index.html` },
  });
  let sid: string;
  try {
    sid = (JSON.parse(portalRes.text) as { fgt_sslvpn_sid?: string }).fgt_sslvpn_sid ?? '';
  } catch {
    throw new Error('[kitPortal] /remote/portal did not return JSON (session not established)');
  }
  if (!sid) throw new Error('[kitPortal] fgt_sslvpn_sid missing');

  // 4. プロキシ経由でポータルにアクセス → Shibboleth フローへ
  const targetUrl = proxyUrl(sid, 'lecture_cancellation');
  const nav = await fetchFollow(jar, targetUrl, { headers: browserHeaders() });

  // 5. 中間フォームを自動送信 ×2 (shib_idp_ls の session 復元)
  const r2 = await submitForm(jar, nav.text, nav.url, true);
  const r3 = await submitForm(jar, r2.text, r2.url, true);

  // 6. IdP に資格情報を POST
  const credForm = parseFirstForm(r3.text);
  if (!credForm) throw new Error('[kitPortal] IdP login form not found');
  const credPayload = { ...credForm.inputs };
  credPayload['j_username'] = userId;
  credPayload['j_password'] = password;
  delete credPayload['donotcache'];
  delete credPayload['_shib_idp_revokeConsent'];
  credPayload['_eventId_proceed'] = '';
  const credAction = new URL(credForm.action || r3.url, r3.url).toString();
  const r4 = await fetchFollow(jar, credAction, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: encodeForm(credPayload),
  });

  // 7. 残りの自動送信フォーム ×2 → SP (ポータル) にセッション確立
  const r5 = await submitForm(jar, r4.text, r4.url, false);
  await submitForm(jar, r5.text, r5.url, false);

  return sid;
}

function proxyUrl(sid: string, controller: 'lecture_cancellation' | 'lecture_information'): string {
  return `https://${VPN_HOST}/proxy/${sid}/https/${PORTAL_HOST}/ead/?c=${controller}`;
}

function browserHeaders(): Record<string, string> {
  return {
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  };
}

// ===== スクレイプ =====
function parseCancellations(html: string): CancellationNotice[] {
  // cancel_info_data_tbl: [No, 学部名など, 授業科目名, 担当教員, 休講年月日, 曜日, 時限, 備考, 掲示年月日]
  const rows = extractTableRows(html, 'cancel_info_data_tbl');
  const out: CancellationNotice[] = [];
  for (const c of rows) {
    if (c.length < 9) continue;
    out.push({
      no: toInt(cellTextPlain(c[0])),
      facultyLabel: cellTextPlain(c[1]),
      courseName: cellTextPlain(c[2]),
      instructors: splitInstructors(cellTextPlain(c[3])),
      cancelledOn: cellTextPlain(c[4]),
      dayLabel: cellTextPlain(c[5]),
      periodLabel: cellTextPlain(c[6]),
      remarks: cellTextMultiline(c[7]),
      postedAt: cellTextPlain(c[8]),
    });
  }
  return out;
}

function parseNotices(html: string): LectureNotice[] {
  // class_msg_data_tbl: [No, 学部名など, 学期, 授業科目名, 担当教員, 曜日, 時限, 分類, 連絡事項, 初回掲示日, 最終更新日]
  const rows = extractTableRows(html, 'class_msg_data_tbl');
  const out: LectureNotice[] = [];
  for (const c of rows) {
    if (c.length < 11) continue;
    const period = cellTextPlain(c[6]);
    out.push({
      no: toInt(cellTextPlain(c[0])),
      facultyLabel: cellTextPlain(c[1]),
      termLabel: cellTextPlain(c[2]),
      courseName: cellTextPlain(c[3]),
      instructors: splitInstructors(cellTextPlain(c[4])),
      dayLabel: cellTextPlain(c[5]),
      periodLabel: period === '' ? null : period,
      category: cellTextPlain(c[7]),
      message: cellTextMultiline(c[8]),
      firstPostedAt: cellTextPlain(c[9]),
      updatedAt: cellTextPlain(c[10]),
    });
  }
  return out;
}

// ===== セッション使い回し =====
// 1 分間隔などの高頻度ポーリングで毎回フルログインすると重く、レート制限の懸念もある。
// VPN セッション (jar + fgt_sslvpn_sid) をキャッシュして再利用し、切れたら再ログインする。
interface PortalSession {
  jar: CookieJar;
  sid: string;
}
let cachedSession: PortalSession | null = null;

// ログイン済みなら表ページに対象テーブル or 「データ無し」表示が含まれる。
// 含まれない場合は VPN/Shibboleth のログイン画面に飛ばされている = セッション切れ。
const NO_DATA_MARKER = '指定の条件で現在表示する情報はありません';

function looksLoggedIn(html: string, tableId: string): boolean {
  return html.includes(tableId) || html.includes(NO_DATA_MARKER);
}

async function createSession(): Promise<PortalSession> {
  const jar = new CookieJar();
  const sid = await login(jar);
  return { jar, sid };
}

/**
 * KIT ポータルにログインし、休講通知と授業関連連絡を取得して CancellationFeed を返す。
 * セッションをキャッシュして再利用し、切れている/失敗した場合は 1 度だけ再ログインする。
 */
export async function fetchFeedFromPortal(): Promise<CancellationFeed> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!cachedSession) cachedSession = await createSession();
      const { jar, sid } = cachedSession;

      const cancelRes = await fetchFollow(jar, proxyUrl(sid, 'lecture_cancellation'), {
        headers: browserHeaders(),
      });
      if (!looksLoggedIn(cancelRes.text, 'cancel_info_data_tbl')) {
        cachedSession = null; // セッション切れ → 再ログインして再試行
        continue;
      }
      const noticeRes = await fetchFollow(jar, proxyUrl(sid, 'lecture_information'), {
        headers: browserHeaders(),
      });

      return {
        cancellations: parseCancellations(cancelRes.text),
        notices: parseNotices(noticeRes.text),
        fetchedAt: new Date().toISOString(),
      };
    } catch (e) {
      lastErr = e;
      cachedSession = null; // 壊れたセッションは破棄して再試行
    }
  }
  throw lastErr ?? new Error('[kitPortal] failed to fetch portal feed');
}
