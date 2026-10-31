// mdgw-seg v1.0.0 — 麻豆瓜网分片全球镜像 (与 rou-seg 同站, Netlify Edge + Blobs)
// /m/<tok>.ts?c=<cid>&p=<源序号>&i=<段序号>
//   命中 Blobs 全局镜像直出; 未命中现拉 tok 源址, 失败时从 CF 中转的新鲜清单换同序号地址再拉;
//   成功回填镜像; 每次服务后滚动预取后 3 段 (目标清单从 CF 中转的改写清单解析, 缓存进 Blobs)
// 背景: CF 中转的 Cache API 按机房分区, 用户请求散射导致预取/缓存频频落空, 5 秒一段的片
//      只要有一段冷拉慢过缓冲就冻屏数秒 — 镜像改全局后, 预取到哪一段哪一段就稳。
import { getStore } from "@netlify/blobs";

const RELAY = "https://mdgw.fengxue556.ccwu.cc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const LIST_TTL = 10 * 60 * 1000;

function store() { try { return getStore("mdgw-segs"); } catch (e) { return null; } }
function decTok(tok) {
  const b64 = tok.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function fetchBuf(url, ms) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), ms || 8000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl.signal });
    if (r.status !== 200) return null;
    const b = await r.arrayBuffer();
    return b.byteLength ? b : null;
  } catch (e) { return null; } finally { clearTimeout(tm); }
}
// 从 CF 中转取改写清单, 解析出有序的段目标 [{tok,url}]
async function resolveTargets(st, cid, srcIdx, force) {
  const key = "mpl/" + cid + "/" + srcIdx;
  if (st && !force) {
    try {
      const j = await st.get(key, { type: "json", consistency: "strong" });
      if (j && j.list && j.list.length && Date.now() - j.ts < LIST_TTL) return j.list;
    } catch (e) {}
  }
  try {
    const r = await fetch(RELAY + "/play/" + cid + ".m3u8?i=" + srcIdx, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const text = await r.text();
    const list = [];
    for (const rawLine of text.split("\n")) {
      const mm = rawLine.trim().match(/\/s\/([A-Za-z0-9\-_]+)\.ts\?/);
      if (mm) { try { list.push({ tok: mm[1], url: decTok(mm[1]) }); } catch (e) {} }
    }
    if (!list.length) return null;
    if (st) { try { await st.setJSON(key, { ts: Date.now(), list }); } catch (e) {} }
    return list;
  } catch (e) { return null; }
}
async function fillSeg(st, cid, srcIdx, idx, targets) {
  if (!st || !targets || !targets[idx]) return;
  const key = "m/" + cid + "/" + srcIdx + "/" + idx;
  try { const md = await st.getMetadata(key); if (md) return; } catch (e) {}
  const buf = await fetchBuf(targets[idx].url, 10000);
  if (buf) { try { await st.set(key, buf); } catch (e) {} }
}
async function prefetchNext(st, cid, srcIdx, idx) {
  if (!st || !cid || idx < 0) return;
  const list = await resolveTargets(st, cid, srcIdx, false);
  if (!list) return;
  await Promise.allSettled([idx + 1, idx + 2, idx + 3].map((j) => fillSeg(st, cid, srcIdx, j, list)));
}
function segResp(buf, tag) {
  return new Response(buf, { status: 200, headers: { "Content-Type": "video/mp2t", "Cache-Control": "public, max-age=21600", "Access-Control-Allow-Origin": "*", "X-MdgwSeg": tag } });
}

export default async (request, context) => {
  const u = new URL(request.url);
  if (u.pathname === "/mhealth") return Response.json({ ok: true, name: "mdgw-seg", version: "1.0.0", blobs: !!store() });
  const m = u.pathname.match(/^\/m\/([A-Za-z0-9\-_]+)\.ts$/);
  if (!m) return new Response("not found", { status: 404 });
  const cid = (u.searchParams.get("c") || "").replace(/[^0-9]/g, "");
  const srcIdx = Math.max(0, parseInt(u.searchParams.get("p") || "0", 10) || 0);
  const idx = parseInt(u.searchParams.get("i") || "-1", 10);
  let target = "";
  try { target = decTok(m[1]); } catch (e) {}
  if (!/^https:\/\//.test(target)) return new Response("bad token", { status: 400 });
  const st = store();
  const key = cid && idx >= 0 ? "m/" + cid + "/" + srcIdx + "/" + idx : "mt/" + m[1];
  if (st) {
    try {
      const blob = await st.get(key, { type: "arrayBuffer", consistency: "strong" });
      if (blob) {
        context.waitUntil(prefetchNext(st, cid, srcIdx, idx));
        return segResp(blob, "HIT");
      }
    } catch (e) {}
  }
  let buf = await fetchBuf(target, 8000);
  if (!buf && st && cid && idx >= 0) {
    const list = await resolveTargets(st, cid, srcIdx, true);
    if (list && list[idx] && list[idx].url !== target) buf = await fetchBuf(list[idx].url, 8000);
  }
  if (!buf) return new Response("segment unavailable", { status: 502 });
  if (st) {
    context.waitUntil((async () => {
      try { await st.set(key, buf); } catch (e) {}
      await prefetchNext(st, cid, srcIdx, idx);
    })());
  }
  return segResp(buf, "MISS");
};
