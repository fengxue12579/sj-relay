// rou-seg v1.0.0 — 肉视频分片全局镜像 (Netlify Edge Function + Blobs)
// /s/<tok>.ts?v=<vid>&i=<idx>  分片: 先查 Blobs 全局镜像 (强一致读), 命中直出;
//                              未命中从 tok 里的源站地址现拉, 失败换一次新鲜解析的同序号地址,
//                              成功后回填镜像; 每次服务后滚动预取后 3 段进镜像
// /health                      存活检查 (含 blobs 可用性)
// 设计目的: 绕开 CF Cache API 按机房分区的毛病 — 快进落点只要被任何人/任何机房预取过一次,
//          全球任意节点都命中镜像, 不再陪慢边缘现拉。
import { getStore } from "@netlify/blobs";

const SITE = "https://rou07.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const LIST_TTL = 25 * 60 * 1000;

function store() { try { return getStore("rou-segs"); } catch (e) { return null; } }
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
async function resolveList(st, vid, force) {
  if (st && !force) {
    try {
      const j = await st.get("pl/" + vid, { type: "json", consistency: "strong" });
      if (j && j.list && j.list.length && Date.now() - j.ts < LIST_TTL) return j.list;
    } catch (e) {}
  }
  try {
    const r = await fetch(SITE + "/api/hls/" + vid, { headers: { "User-Agent": UA, Referer: SITE + "/v/" + vid } });
    if (!r.ok) return null;
    const text = await r.text();
    if (!text.includes("#EXTM3U")) return null;
    const base = new URL(r.url);
    const list = [];
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      try { list.push(new URL(line, base).toString()); } catch (e) {}
    }
    if (!list.length) return null;
    if (st) { try { await st.setJSON("pl/" + vid, { ts: Date.now(), list }); } catch (e) {} }
    return list;
  } catch (e) { return null; }
}
async function fillSeg(st, vid, idx, targets) {
  if (!st || !targets || !targets[idx]) return;
  const key = "s/" + vid + "/" + idx;
  try { const md = await st.getMetadata(key); if (md) return; } catch (e) {}
  const buf = await fetchBuf(targets[idx], 10000);
  if (buf) { try { await st.set(key, buf); } catch (e) {} }
}
async function prefetchNext(st, vid, idx) {
  if (!st || !vid || idx < 0) return;
  const list = await resolveList(st, vid, false);
  if (!list) return;
  await Promise.allSettled([idx + 1, idx + 2, idx + 3].map((j) => fillSeg(st, vid, j, list)));
}
function segResp(buf, tag) {
  return new Response(buf, { status: 200, headers: { "Content-Type": "video/mp2t", "Cache-Control": "public, max-age=21600", "Access-Control-Allow-Origin": "*", "X-RouSeg": tag } });
}

export default async (request, context) => {
  const u = new URL(request.url);
  if (u.pathname === "/health") {
    return Response.json({ ok: true, name: "rou-seg", version: "1.0.0", blobs: !!store() });
  }
  const m = u.pathname.match(/^\/s\/([A-Za-z0-9\-_]+)\.ts$/);
  if (!m) return new Response("not found", { status: 404 });
  const vid = (u.searchParams.get("v") || "").replace(/[^A-Za-z0-9]/g, "");
  const idx = parseInt(u.searchParams.get("i") || "-1", 10);
  let target = "";
  try { target = decTok(m[1]); } catch (e) {}
  if (!/^https:\/\//.test(target)) return new Response("bad token", { status: 400 });
  const st = store();
  const key = vid && idx >= 0 ? "s/" + vid + "/" + idx : "t/" + m[1];
  if (st) {
    try {
      const blob = await st.get(key, { type: "arrayBuffer", consistency: "strong" });
      if (blob) {
        context.waitUntil(prefetchNext(st, vid, idx));
        return segResp(blob, "HIT");
      }
    } catch (e) {}
  }
  let buf = await fetchBuf(target, 8000);
  if (!buf && st && vid && idx >= 0) {
    const list = await resolveList(st, vid, true);
    if (list && list[idx] && list[idx] !== target) buf = await fetchBuf(list[idx], 8000);
  }
  if (!buf) return new Response("segment unavailable", { status: 502 });
  if (st) {
    context.waitUntil((async () => {
      try { await st.set(key, buf); } catch (e) {}
      await prefetchNext(st, vid, idx);
    })());
  }
  return segResp(buf, "MISS");
};
