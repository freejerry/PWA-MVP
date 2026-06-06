/*
 * Cloudflare Worker — 極簡同步後端（搭配 KV）。
 *
 * 路由（皆以「同步碼」當作資料分組鍵）：
 *   GET    /notes?code=XXXX            → 讀回該同步碼的記事 { notes, rev }
 *   POST   /notes?code=XXXX  body:{notes:[...]}
 *                                      → 伺服器端 union-merge 後寫回，回傳合併結果 { notes, rev }
 *   OPTIONS *                          → CORS preflight
 *
 * 設計重點：
 *  - 伺服器端也做 union-merge，所以多裝置「同時 push」不會互相覆蓋掉資料。
 *  - 記事為 append-only + tombstone(deleted)；合併規則：依 id 取聯集，deleted 勝出，
 *    其餘欄位取 updated 較新者。
 *  - KV key = `notes:<code>`。注意：任何人拿到同步碼即可讀寫，這是 PoC 等級的設計，
 *    正式環境應改用真正的帳號/權杖。
 *
 * 綁定：wrangler.toml 裡的 KV namespace binding 名稱為 NOTES。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

function sanitizeCode(code) {
  // 只留安全字元，限制長度，避免奇怪的 KV key。
  return (code || '').toString().trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

// union-merge：依 id 取聯集，deleted 勝出，其餘欄位取 updated 較新者。
function mergeNotes(a, b) {
  const map = new Map();
  for (const n of [...(a || []), ...(b || [])]) {
    if (!n || !n.id) continue;
    const ex = map.get(n.id);
    if (!ex) { map.set(n.id, { ...n }); continue; }
    const newer = (n.updated || n.ts || 0) >= (ex.updated || ex.ts || 0) ? n : ex;
    map.set(n.id, {
      ...ex, ...newer,
      // 不可變欄位：建立時間與內容以最早出現者為準（避免被覆寫）
      ts: ex.ts || n.ts,
      text: ex.text != null ? ex.text : n.text,
      deleted: Boolean(ex.deleted || n.deleted),
      updated: Math.max(ex.updated || ex.ts || 0, n.updated || n.ts || 0),
    });
  }
  return [...map.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0));
}

async function readKV(env, code) {
  const raw = await env.NOTES.get(`notes:${code}`);
  if (!raw) return { notes: [], rev: 0 };
  try {
    const obj = JSON.parse(raw);
    return { notes: Array.isArray(obj.notes) ? obj.notes : [], rev: obj.rev || 0 };
  } catch {
    return { notes: [], rev: 0 };
  }
}

async function writeKV(env, code, notes, rev) {
  await env.NOTES.put(`notes:${code}`, JSON.stringify({ notes, rev, updatedAt: Date.now() }));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname !== '/notes') return json({ error: 'not found' }, 404);

    if (!env.NOTES) return json({ error: 'KV binding NOTES 未設定' }, 500);

    const code = sanitizeCode(url.searchParams.get('code'));
    if (!code) return json({ error: '缺少有效的 code' }, 400);

    if (request.method === 'GET') {
      const cur = await readKV(env, code);
      return json(cur);
    }

    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'JSON 解析失敗' }, 400); }
      const incoming = Array.isArray(body && body.notes) ? body.notes : [];
      const cur = await readKV(env, code);
      const merged = mergeNotes(cur.notes, incoming);
      const rev = (cur.rev || 0) + 1;
      await writeKV(env, code, merged, rev);
      return json({ notes: merged, rev });
    }

    return json({ error: 'method not allowed' }, 405);
  },
};
