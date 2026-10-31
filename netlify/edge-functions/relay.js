// sj-relay v2 — SupJav 中转 (Netlify Edge 版, 与 sj-relay-server.mjs 同一逻辑)
// 与 v1 (Cloudflare Worker) 的区别: CF 出口被 upload18/helvid 整站拒绝,
// 本版跑在中性主机上自己铸造会话 (普通运行时出口实测可过播放页)。
// 能力: 自铸会话 / 清单改写 (真实 .ts 后缀) / 分片缓存 / 预加载后续分片 (抗开头卡与续播断粮)
// 路由: /health /segprobe?u=<url> /stats /play/<slug>.m3u8 /v/<tok>.m3u8 /s/<tok>.ts

const UA_LIST = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];
const SITE = "https://supjav.blog";
const PLAY = "https://upload18.org";
const MAX_CACHE_BYTES = 200 * 1024 * 1024;
const SESSION_TTL = 20 * 60 * 1000;
const PREFETCH_AHEAD = 8;   // 每次服务分片时向前预取的段数
const PREFETCH_PAR = 4;     // 预取并发

function pickUA() { return UA_LIST[Math.floor(Math.random() * UA_LIST.length)]; }
function b64e(o) {
  // 纯 Web API 实现 (不用 Buffer): Vercel/Netlify/Deno 的 Edge 运行时没有 Buffer 全局
  const s = typeof o === "string" ? o : JSON.stringify(o);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64d(t) {
  let s = String(t).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}
function fetchT(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms || 30000);
  return fetch(url, Object.assign({}, opts, { signal: c.signal })).finally(() => clearTimeout(t));
}

// ---------- 会话与清单 ----------
const sessions = new Map(); // slug -> {cookie, ua, listUrl, segs:[], at}
async function mintSession(slug) {
  const ua = pickUA();
  const r = await fetchT(PLAY + "/play/index/" + slug, {
    headers: { "User-Agent": ua, Referer: SITE + "/video/" + slug, "Accept-Language": "en-US,en;q=0.9" },
  }, 20000);
  if (r.status !== 200) throw new Error("play page " + r.status);
  const html = await r.text();
  let cookie = "";
  try {
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    cookie = sc.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  } catch (e) { /* 无 cookie 也继续: 分片自带签名 */ }
  const i = html.indexOf("window.PLAYER_CONFIG");
  if (i < 0) throw new Error("no PLAYER_CONFIG");
  const cfg = JSON.parse(html.slice(html.indexOf("{", i), html.indexOf("};", i) + 1).replace(/\\u0026/g, "&").replace(/\\u003d/g, "="));
  if (!cfg.m3u8 && !cfg.alternate720) throw new Error("no stream in config");
  return { cookie, ua, cfg };
}

async function getSession(slug) {
  const hit = sessions.get(slug);
  if (hit && Date.now() - hit.at < SESSION_TTL) return hit;
  const { cookie, ua, cfg } = await mintSession(slug);
  const listUrl = cfg.m3u8 || cfg.alternate720;
  const pr = await fetchT(listUrl, {
    headers: { "User-Agent": ua, Referer: PLAY + "/", ...(cookie ? { Cookie: cookie } : {}) },
  }, 20000);
  if (pr.status !== 200) throw new Error("playlist " + pr.status);
  const text = await pr.text();
  const lines = text.split("\n");
  const isMaster = text.includes("EXT-X-STREAM-INF");
  let segs = [];
  if (!isMaster) segs = lines.filter((l) => l.trim() && !l.startsWith("#")).map((l) => new URL(l, listUrl).toString());
  const sess = { cookie, ua, cfg, listUrl, text, isMaster, segs, at: Date.now() };
  sessions.set(slug, sess);
  return sess;
}

// ---------- 分片缓存与预取 ----------
const segCache = new Map();   // slug#n -> {buf:ArrayBuffer, at}
const inflight = new Map();   // slug#n -> Promise<ArrayBuffer>
let cacheBytes = 0;
let parCount = 0;
const parWaiters = [];
function parAcquire() {
  if (parCount < PREFETCH_PAR) { parCount++; return Promise.resolve(); }
  return new Promise((res) => parWaiters.push(res));
}
function parRelease() {
  const w = parWaiters.shift();
  if (w) w(); else parCount--;
}
function cachePut(key, buf) {
  const old = segCache.get(key);
  if (old) cacheBytes -= old.buf.byteLength;
  segCache.set(key, { buf, at: Date.now() });
  cacheBytes += buf.byteLength;
  while (cacheBytes > MAX_CACHE_BYTES && segCache.size) {
    const k0 = segCache.keys().next().value;
    cacheBytes -= segCache.get(k0).buf.byteLength;
    segCache.delete(k0);
  }
}
async function fetchSegment(slug, n) {
  const key = slug + "#" + n;
  const hit = segCache.get(key);
  if (hit) return hit.buf;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const sess = await getSession(slug);
    const url = sess.segs[n];
    if (!url) throw new Error("segment out of range");
    const r = await fetchT(url, {
      headers: { "User-Agent": sess.ua, Referer: PLAY + "/", ...(sess.cookie ? { Cookie: sess.cookie } : {}) },
    }, 45000);
    if (r.status !== 200 && r.status !== 206) throw new Error("segment " + r.status);
    const buf = await r.arrayBuffer();
    cachePut(key, buf);
    return buf;
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}
async function fetchSegmentBg(slug, n) {
  await parAcquire();
  try { await fetchSegment(slug, n); } catch (e) { /* 预取失败忽略 */ } finally { parRelease(); }
}
function prefetch(slug, fromN) {
  getSession(slug).then((sess) => {
    for (let n = fromN; n < Math.min(sess.segs.length, fromN + PREFETCH_AHEAD); n++) {
      const key = slug + "#" + n;
      if (!segCache.has(key) && !inflight.has(key)) fetchSegmentBg(slug, n);
    }
  }).catch(() => {});
}

// ---------- 响应辅助 ----------
function textResp(body, status, type) {
  return new Response(body, { status: status || 200, headers: { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
function rewritePlaylist(sess, slug, origin) {
  const out = [];
  let segIdx = 0;
  for (const line of sess.text.split("\n")) {
    const t = line.trim();
    if (!t) { out.push(line); continue; }
    if (t.startsWith("#")) { out.push(line); continue; }
    const abs = new URL(t, sess.listUrl).toString();
    if (sess.isMaster) {
      out.push(origin + "/v/" + b64e({ u: abs, s: slug }) + ".m3u8");
    } else {
      out.push(origin + "/s/" + b64e({ u: abs, s: slug, n: segIdx }) + ".ts");
      segIdx++;
    }
  }
  return out.join("\n");
}

// ---------- 主处理 ----------
async function handle(req) {
  const url = new URL(req.url);
  const origin = url.origin;
  const path = url.pathname;
  try {
    if (path === "/" || path === "/health") return textResp(JSON.stringify({ ok: true, name: "sj-relay v2" }), 200, "application/json");
    if (path === "/stats") {
      return textResp(JSON.stringify({ sessions: sessions.size, cachedSegments: segCache.size, cacheMB: +(cacheBytes / 1048576).toFixed(1) }), 200, "application/json");
    }
    if (path === "/segprobe") {
      const u = url.searchParams.get("u");
      if (!u) return textResp("missing u", 400);
      const t0 = Date.now();
      const r = await fetchT(u, { headers: { "User-Agent": pickUA(), Referer: PLAY + "/" } }, 45000);
      const buf = await r.arrayBuffer();
      return textResp(JSON.stringify({ status: r.status, ms: Date.now() - t0, bytes: buf.byteLength }), 200, "application/json");
    }
    let m = path.match(/^\/play\/([A-Za-z0-9._-]+)\.m3u8$/);
    if (m) {
      const slug = m[1];
      const sess = await getSession(slug);
      const body = rewritePlaylist(sess, slug, origin);
      if (!sess.isMaster) prefetch(slug, 0);
      return textResp(body, 200, "application/vnd.apple.mpegurl");
    }
    m = path.match(/^\/v\/([A-Za-z0-9_-]+)\.m3u8$/);
    if (m) {
      const tok = JSON.parse(b64d(m[1]));
      const sess = await getSession(tok.s);
      const pr = await fetchT(tok.u, { headers: { "User-Agent": sess.ua, Referer: PLAY + "/", ...(sess.cookie ? { Cookie: sess.cookie } : {}) } }, 20000);
      if (pr.status !== 200) return textResp("variant " + pr.status, 502);
      const text = await pr.text();
      sess.text = text; sess.listUrl = tok.u; sess.isMaster = false;
      sess.segs = text.split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => new URL(l, tok.u).toString());
      sess.at = Date.now();
      const body = rewritePlaylist(sess, tok.s, origin);
      prefetch(tok.s, 0);
      return textResp(body, 200, "application/vnd.apple.mpegurl");
    }
    m = path.match(/^\/s\/([A-Za-z0-9_-]+)\.ts$/);
    if (m) {
      const tok = JSON.parse(b64d(m[1]));
      const buf = await fetchSegment(tok.s, tok.n | 0);
      prefetch(tok.s, (tok.n | 0) + 1);
      const range = req.headers.get("range");
      const total = buf.byteLength;
      const headers = { "Content-Type": "video/mp2t", "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
      if (range) {
        const rm = range.match(/bytes=(\d*)-(\d*)/);
        if (rm) {
          let st = rm[1] ? parseInt(rm[1], 10) : 0;
          let en = rm[2] ? parseInt(rm[2], 10) : total - 1;
          if (st > total - 1) st = total - 1;
          if (en > total - 1) en = total - 1;
          headers["Content-Range"] = "bytes " + st + "-" + en + "/" + total;
          headers["Content-Length"] = String(en - st + 1);
          return new Response(buf.slice(st, en + 1), { status: 206, headers });
        }
      }
      headers["Content-Length"] = String(total);
      return new Response(buf, { status: 200, headers });
    }
    return textResp("not found", 404);
  } catch (e) {
    return textResp("relay error: " + (e && e.message ? e.message : String(e)), 502);
  }
}

// ---------- Netlify Edge 挂载 ----------
export const config = { path: "/*" };
export default handle;
