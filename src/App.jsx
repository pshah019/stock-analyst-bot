import { useState, useRef, useCallback, useEffect } from "react";
import Papa from "papaparse";
import { supabase } from "./supabase";

// ─── Supabase helpers ───
async function saveResultToSupabase(scan) {
  try {
    const { error } = await supabase.from("analysis_results").insert([{
      ticker: scan.ticker,
      grade: scan.grade,
      direction: scan.direction,
      bias: scan.bias,
      is_reversal: scan.isReversal || false,
      price: parseFloat(scan.price) || 0,
      target_1: scan.t1,
      target_2: scan.t2,
      target_3: scan.t3,
      target_4: scan.t4,
      target_5: scan.t5,
      analyzed_at: scan.timestamp || new Date().toISOString(),
    }]);
    if (error) console.warn("Supabase save error:", error.message);
    else console.log(`✅ Saved ${scan.ticker} to Supabase`);
  } catch (e) {
    console.warn("Supabase save failed:", e.message);
  }
}

async function fetchHistoryFromSupabase(limit = 200) {
  try {
    const { data, error } = await supabase
      .from("analysis_results")
      .select("*")
      .order("analyzed_at", { ascending: false })
      .limit(limit);
    if (error) { console.warn("Supabase fetch error:", error.message); return []; }
    return data || [];
  } catch (e) {
    console.warn("Supabase fetch failed:", e.message);
    return [];
  }
}

// ─── Constants ───
const BENCHMARKS = ["SPY", "QQQ", "IWM"];

// ─── Helpers ───
function computeATR(data, period = 14) {
  const trs = []; for (let i = 0; i < data.length; i++) { if (i === 0) { trs.push(data[i].high - data[i].low); continue; } trs.push(Math.max(data[i].high - data[i].low, Math.abs(data[i].high - data[i - 1].close), Math.abs(data[i].low - data[i - 1].close))); }
  const r = []; for (let i = 0; i < trs.length; i++) { if (i < period - 1) { r.push(null); continue; } if (i === period - 1) { let s = 0; for (let j = 0; j < period; j++) s += trs[j]; r.push(s / period); } else r.push((r[r.length - 1] * (period - 1) + trs[i]) / period); } return r;
}
function computeMACD(data) {
  const ema = (arr, p) => { const k = 2 / (p + 1); const r = [arr[0]]; for (let i = 1; i < arr.length; i++) r.push(arr[i] * k + r[i - 1] * (1 - k)); return r; };
  const c = data.map(d => d.close), e12 = ema(c, 12), e26 = ema(c, 26), macd = e12.map((v, i) => v - e26[i]), sig = ema(macd, 9);
  return { macd, signal: sig, histogram: macd.map((v, i) => v - sig[i]) };
}
function findSR(data, atrOverride) {
  if (data.length < 10) return { support: [], resistance: [] };
  const pivots = [], lb = Math.min(5, Math.floor(data.length / 4));
  for (let i = lb; i < data.length - lb; i++) { let isH = true, isL = true; for (let j = i - lb; j <= i + lb; j++) { if (j === i) continue; if (data[j].high >= data[i].high) isH = false; if (data[j].low <= data[i].low) isL = false; } if (isH) pivots.push({ type: "r", price: data[i].high }); if (isL) pivots.push({ type: "s", price: data[i].low }); }
  // ── NEW: ATR-based clustering threshold instead of fixed 1.5% ──
  // Use 0.6x ATR as clustering distance. Falls back to 1.5% if no ATR provided.
  const atrArr = computeATR(data);
  const atr = atrOverride || atrArr[atrArr.length - 1];
  const avgPrice = data[data.length - 1].close || 1;
  const thr = atr ? (atr * 0.6) / avgPrice : 0.015; // ATR-relative threshold, or fallback 1.5%
  const cluster = (pts, thrVal) => { const sorted = [...pts].sort((a, b) => a.price - b.price); const g = []; let c = null; for (const pt of sorted) { if (!c || Math.abs(pt.price - c.avg) / c.avg > thrVal) { c = { prices: [pt.price], avg: pt.price, touches: 1 }; g.push(c); } else { c.prices.push(pt.price); c.avg = c.prices.reduce((a, b) => a + b) / c.prices.length; c.touches++; } } return g.filter(x => x.touches >= 2).sort((a, b) => b.touches - a.touches); };
  return { support: cluster(pivots.filter(p => p.type === "s"), thr).slice(0, 6), resistance: cluster(pivots.filter(p => p.type === "r"), thr).slice(0, 6) };
}

// ─── UNIX TIMESTAMP → PST ───
function unixToPST(val) {
  if (!val) return "";
  const num = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(num) || num < 1e8) return String(val);
  const ms = num < 1e12 ? num * 1000 : num;
  try { return new Date(ms).toLocaleString("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }); }
  catch { return new Date(ms).toLocaleString(); }
}

// ─── TREND / RANGE ANALYSIS ───
function analyzeTrendRange(dData, hData) {
  if (dData.length < 10) return { mode: "Unknown", detail: "", breakout: "", longCtx: "" };
  const price = dData[dData.length - 1].close;
  const d2w = dData.slice(-10);
  const h2w = Math.max(...d2w.map(d => d.high)), l2w = Math.min(...d2w.map(d => d.low));
  const rng2w = (h2w - l2w) / ((h2w + l2w) / 2);
  const d1m = dData.slice(-20);
  const h1m = Math.max(...d1m.map(d => d.high)), l1m = Math.min(...d1m.map(d => d.low));
  const d3m = dData.slice(-60);
  const h3m = Math.max(...d3m.map(d => d.high)), l3m = Math.min(...d3m.map(d => d.low));
  const hAll = Math.max(...dData.map(d => d.high)), lAll = Math.min(...dData.map(d => d.low));
  const closes20 = d1m.map(d => d.close), n = closes20.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += closes20[i]; sumXY += i * closes20[i]; sumX2 += i * i; }
  const slope20 = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const slopePct20 = (slope20 * n / closes20[0] * 100).toFixed(2);
  const closesAll = dData.map(d => d.close), nA = closesAll.length;
  let sXA = 0, sYA = 0, sXYA = 0, sX2A = 0;
  for (let i = 0; i < nA; i++) { sXA += i; sYA += closesAll[i]; sXYA += i * closesAll[i]; sX2A += i * i; }
  const slopeAll = (nA * sXYA - sXA * sYA) / (nA * sX2A - sXA * sXA);
  const isRangy2w = rng2w < 0.06, trendDir = slope20 > 0 ? "UP" : "DOWN", trendStrength = Math.abs(parseFloat(slopePct20));
  let mode, detail, breakout = "";
  if (isRangy2w && trendStrength < 3) {
    mode = "RANGE";
    detail = `2-week range: $${l2w.toFixed(2)} — $${h2w.toFixed(2)} (${(rng2w * 100).toFixed(1)}% wide). Consolidating.`;
    if (price > h2w * 0.998) breakout = `⚡ RANGE BREAKOUT UP — Price ($${price.toFixed(2)}) breaking above 2-week top ($${h2w.toFixed(2)}).`;
    else if (price < l2w * 1.002) breakout = `⚡ RANGE BREAKDOWN — Price ($${price.toFixed(2)}) breaking below 2-week bottom ($${l2w.toFixed(2)}).`;
  } else {
    mode = `TREND ${trendDir}`;
    detail = `20-day slope: ${slopePct20}% ${trendDir === "UP" ? "↑" : "↓"}. Trending ${trendDir.toLowerCase()}.`;
    const expectedPrice = closesAll[0] + slopeAll * (nA - 1);
    const deviation = (price - expectedPrice) / expectedPrice;
    if (slopeAll > 0 && price < expectedPrice && Math.abs(deviation) > 0.02) breakout = `⚡ TRENDLINE BREAK DOWN — Price ($${price.toFixed(2)}) broke below uptrend (expected ~$${expectedPrice.toFixed(2)}).`;
    else if (slopeAll < 0 && price > expectedPrice && Math.abs(deviation) > 0.02) breakout = `⚡ TRENDLINE BREAK UP — Price ($${price.toFixed(2)}) broke above downtrend (expected ~$${expectedPrice.toFixed(2)}).`;
  }
  const longCtx = `1-mo: $${l1m.toFixed(2)}-$${h1m.toFixed(2)} | 3-mo: $${l3m.toFixed(2)}-$${h3m.toFixed(2)} | Full: $${lAll.toFixed(2)}-$${hAll.toFixed(2)}`;
  return { mode, detail, breakout, longCtx, range2w: { high: h2w, low: l2w }, slopePct20, trendDir };
}