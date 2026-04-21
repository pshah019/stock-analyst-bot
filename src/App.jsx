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
      h_div: scan.hDiv?.label || null,
      d_div: scan.dDiv?.label || null,
      combined_div: scan.cDiv?.label || null,
      analyzed_at: scan.timestamp || new Date().toISOString(),
    }]);
    if (error) console.warn("Supabase save error:", error.message);
    else console.log(`Saved ${scan.ticker} to Supabase`);
  } catch (e) {
    console.warn("Supabase save failed:", e.message);
  }
}

/* Delete rows older than 30 days (History tab retention window). */async function deleteOldFromSupabase(days = 30) {  try {    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();    const { error } = await supabase      .from("analysis_results")      .delete()      .lt("analyzed_at", cutoff);    if (error) console.warn("Supabase cleanup error:", error.message);  } catch (e) {    console.warn("Supabase cleanup failed:", e.message);  }}async function fetchHistoryFromSupabase(limit = 200) {
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

// ─── GAP DETECTION ───
function detectGaps(data, minGapPct = 0.005) {
  const gaps = [];
  for (let i = 1; i < data.length; i++) {
    const prevClose = data[i - 1].close;
    const currOpen = data[i].open;
    const gapSize = currOpen - prevClose;
    const gapPct = Math.abs(gapSize) / prevClose;
    // Standard gap: prev close vs current open
    if (gapPct >= minGapPct) {
      const isUp = gapSize > 0;
      const gapTop = isUp ? currOpen : prevClose;
      const gapBottom = isUp ? prevClose : currOpen;
      let filled = false, fillDate = null, partialFill = 0;
      for (let j = i; j < data.length; j++) {
        if (isUp && data[j].low <= gapBottom) { filled = true; fillDate = data[j].date; break; }
        if (!isUp && data[j].high >= gapTop) { filled = true; fillDate = data[j].date; break; }
        if (isUp) { const penetration = (gapTop - data[j].low) / (gapTop - gapBottom); partialFill = Math.max(partialFill, Math.min(1, penetration)); }
        else { const penetration = (data[j].high - gapBottom) / (gapTop - gapBottom); partialFill = Math.max(partialFill, Math.min(1, penetration)); }
      }
      gaps.push({ type: isUp ? "GAP UP" : "GAP DOWN", date: data[i].date, prevDate: data[i - 1].date, prevClose, gapOpen: currOpen, gapTop, gapBottom, gapSize: Math.abs(gapSize), gapPct: (gapPct * 100).toFixed(2), filled, fillDate, partialFill: (partialFill * 100).toFixed(0), index: i });
    }
    // Body gap: prev high vs current low (gap up) or prev low vs current high (gap down)
    // This catches large moves where the candle bodies don't overlap
    const prevHigh = data[i - 1].high, prevLow = data[i - 1].low;
    const currLow = data[i].low, currHigh = data[i].high;
    if (currLow > prevHigh) {
      const bodyGapSize = currLow - prevHigh;
      const bodyGapPct = bodyGapSize / prevHigh;
      if (bodyGapPct >= minGapPct && !gaps.find(g => g.index === i && Math.abs(g.gapSize - bodyGapSize) < 1)) {
        let filled = false, fillDate = null, partialFill = 0;
        for (let j = i + 1; j < data.length; j++) {
          if (data[j].low <= prevHigh) { filled = true; fillDate = data[j].date; break; }
          const penetration = (currLow - data[j].low) / (currLow - prevHigh); partialFill = Math.max(partialFill, Math.min(1, penetration));
        }
        gaps.push({ type: "GAP UP", date: data[i].date, prevDate: data[i - 1].date, prevClose: prevHigh, gapOpen: currLow, gapTop: currLow, gapBottom: prevHigh, gapSize: bodyGapSize, gapPct: (bodyGapPct * 100).toFixed(2), filled, fillDate, partialFill: (partialFill * 100).toFixed(0), index: i });
      }
    }
    if (currHigh < prevLow) {
      const bodyGapSize = prevLow - currHigh;
      const bodyGapPct = bodyGapSize / prevLow;
      if (bodyGapPct >= minGapPct && !gaps.find(g => g.index === i && Math.abs(g.gapSize - bodyGapSize) < 1)) {
        let filled = false, fillDate = null, partialFill = 0;
        for (let j = i + 1; j < data.length; j++) {
          if (data[j].high >= prevLow) { filled = true; fillDate = data[j].date; break; }
          const penetration = (data[j].high - currHigh) / (prevLow - currHigh); partialFill = Math.max(partialFill, Math.min(1, penetration));
        }
        gaps.push({ type: "GAP DOWN", date: data[i].date, prevDate: data[i - 1].date, prevClose: prevLow, gapOpen: currHigh, gapTop: prevLow, gapBottom: currHigh, gapSize: bodyGapSize, gapPct: (bodyGapPct * 100).toFixed(2), filled, fillDate, partialFill: (partialFill * 100).toFixed(0), index: i });
      }
    }
  }
  // Deduplicate: if two gaps at same index, keep the larger one
  const deduped = [];
  for (const g of gaps) {
    const existing = deduped.find(d => d.index === g.index && d.type === g.type);
    if (existing) { if (g.gapSize > existing.gapSize) { Object.assign(existing, g); } }
    else deduped.push(g);
  }
  return deduped.sort((a, b) => a.index - b.index);
}

function analyzeGapContext(gaps, currentPrice, data) {
  if (gaps.length === 0) return { activeGapFill: null, nearbyGaps: [], gapFillAdj: 0, explanation: "No significant gaps detected in this data." };

  const unfilled = gaps.filter(g => !g.filled);
  const recentGaps = gaps.slice(-10); // last 10 gaps

  // Check if current price is INSIDE any unfilled gap (gap fill in progress)
  let activeGapFill = null;
  for (const g of unfilled) {
    if (currentPrice >= g.gapBottom && currentPrice <= g.gapTop) {
      activeGapFill = g;
      break;
    }
  }

  // Check if current price just completed a gap fill (within last few bars)
  let justFilled = null;
  for (const g of gaps) {
    if (g.filled && g.fillDate === data[data.length - 1].date) justFilled = g;
    else if (g.filled) {
      const fillIdx = data.findIndex(d => d.date === g.fillDate);
      if (fillIdx >= data.length - 3 && fillIdx > 0) justFilled = g;
    }
  }

  // Find gaps near current price (within 3% either direction)
  const nearbyGaps = gaps.filter(g => {
    return Math.abs(g.gapTop - currentPrice) / currentPrice < 0.03 ||
           Math.abs(g.gapBottom - currentPrice) / currentPrice < 0.03 ||
           (currentPrice >= g.gapBottom && currentPrice <= g.gapTop);
  });

  // Score adjustment based on gap context
  let gapFillAdj = 0;
  let explanation = "";

  if (activeGapFill) {
    const g = activeGapFill;
    const fillProgress = g.type === "GAP UP"
      ? ((g.gapTop - currentPrice) / (g.gapTop - g.gapBottom) * 100).toFixed(0)
      : ((currentPrice - g.gapBottom) / (g.gapTop - g.gapBottom) * 100).toFixed(0);

    if (g.type === "GAP UP") {
      // Price is dropping into a gap up = gap fill in progress (bearish flow, but nearing completion = potential bounce)
      if (parseFloat(fillProgress) >= 80) {
        gapFillAdj = 2; // Near full fill = bounce likely
        explanation = `🔴 GAP FILL NEARLY COMPLETE (${fillProgress}% filled)\n\n${g.type} from ${g.prevDate} → ${g.date}\nGap range: $${g.gapBottom.toFixed(2)} (bottom) — $${g.gapTop.toFixed(2)} (top)\nGap size: $${g.gapSize.toFixed(2)} (${g.gapPct}%)\n\nPrice ($${currentPrice.toFixed(2)}) has filled ${fillProgress}% of this gap. The gap is almost fully filled. Historically, once a gap fills completely, the stock often bounces because the \"magnet\" effect is exhausted. The gap bottom ($${g.gapBottom.toFixed(2)}) is the completion target — watch for a reversal bounce there.\n\n→ This FAVORS CALLS once the gap fill completes at $${g.gapBottom.toFixed(2)}. Puts have mostly played out.`;
      } else if (parseFloat(fillProgress) >= 50) {
        gapFillAdj = -0.5; // Mid fill = could go either way, slight bearish edge
        explanation = `🟡 GAP FILL IN PROGRESS (${fillProgress}% filled)\n\n${g.type} from ${g.prevDate} → ${g.date}\nGap range: $${g.gapBottom.toFixed(2)} — $${g.gapTop.toFixed(2)}\nGap size: $${g.gapSize.toFixed(2)} (${g.gapPct}%)\n\nPrice ($${currentPrice.toFixed(2)}) is mid-gap. The gap is acting like a magnet pulling price down to fill. Gaps tend to fill completely once they start. The full fill target is $${g.gapBottom.toFixed(2)}.\n\n→ Puts can still work targeting $${g.gapBottom.toFixed(2)}, but be ready to flip to calls once the fill completes. Don't chase puts aggressively — the move is half done.`;
      } else {
        gapFillAdj = -1.5; // Early fill = bearish, gap magnet pulling
        explanation = `🔴 GAP FILL STARTING (${fillProgress}% filled)\n\n${g.type} from ${g.prevDate} → ${g.date}\nGap range: $${g.gapBottom.toFixed(2)} — $${g.gapTop.toFixed(2)}\nGap size: $${g.gapSize.toFixed(2)} (${g.gapPct}%)\n\nPrice ($${currentPrice.toFixed(2)}) has entered the gap from above and is filling it. \"Gaps tend to fill\" is one of the most reliable patterns in trading. The magnet target is $${g.gapBottom.toFixed(2)}.\n\n→ PUTS favored targeting gap bottom at $${g.gapBottom.toFixed(2)}. This gap fill likely has more room to run.`;
      }
    } else {
      // GAP DOWN being filled (price rising into it)
      if (parseFloat(fillProgress) >= 80) {
        gapFillAdj = -2;
        explanation = `🟢 GAP FILL NEARLY COMPLETE (${fillProgress}% filled)\n\n${g.type} from ${g.prevDate} → ${g.date}\nGap range: $${g.gapBottom.toFixed(2)} — $${g.gapTop.toFixed(2)}\n\nPrice ($${currentPrice.toFixed(2)}) has filled ${fillProgress}% of this gap down. Near full fill = potential rejection. Gap top ($${g.gapTop.toFixed(2)}) may act as resistance.\n\n→ Puts may set up once gap fill completes at $${g.gapTop.toFixed(2)}.`;
      } else if (parseFloat(fillProgress) >= 50) {
        gapFillAdj = 0.5;
        explanation = `🟡 GAP DOWN FILL IN PROGRESS (${fillProgress}% filled)\n\n${g.type} from ${g.prevDate} → ${g.date}\nGap range: $${g.gapBottom.toFixed(2)} — $${g.gapTop.toFixed(2)}\n\nPrice filling the gap down. Target: $${g.gapTop.toFixed(2)}.`;
      } else {
        gapFillAdj = 1.5;
        explanation = `🟢 GAP DOWN FILL STARTING (${fillProgress}% filled)\n\n${g.type} from ${g.prevDate} → ${g.date}\nGap range: $${g.gapBottom.toFixed(2)} — $${g.gapTop.toFixed(2)}\n\nCalls favored targeting gap top at $${g.gapTop.toFixed(2)}.`;
      }
    }
  } else if (justFilled) {
    const g = justFilled;
    if (g.type === "GAP UP") {
      gapFillAdj = 2;
      explanation = `✅ GAP FILL JUST COMPLETED\n\n${g.type} from ${g.prevDate} → ${g.date}\nGap range: $${g.gapBottom.toFixed(2)} — $${g.gapTop.toFixed(2)}\nFilled on: ${g.fillDate}\n\nThe gap has been fully filled. The magnet effect is exhausted. Historically this is where bounces happen — the selling pressure from the gap fill is done and buyers often step in at the gap's origin.\n\n→ CALLS favored. Gap fill exhaustion bounce is a high-probability setup. Stop below gap bottom ($${g.gapBottom.toFixed(2)}).`;
    } else {
      gapFillAdj = -2;
      explanation = `✅ GAP DOWN FILL COMPLETED\n\n${g.type} from ${g.prevDate} → ${g.date}\nFilled on: ${g.fillDate}\n\nGap down fully filled. Resistance likely at gap top ($${g.gapTop.toFixed(2)}). Puts may set up.`;
    }
  } else {
    // Check unfilled gaps as potential magnets
    const nearUnfilled = unfilled.filter(g => {
      if (g.type === "GAP UP" && g.gapTop > currentPrice && (g.gapTop - currentPrice) / currentPrice < 0.05) return true;
      if (g.type === "GAP UP" && currentPrice > g.gapTop && (currentPrice - g.gapBottom) / currentPrice < 0.05) return true;
      if (g.type === "GAP DOWN" && g.gapBottom < currentPrice && (currentPrice - g.gapBottom) / currentPrice < 0.05) return true;
      return false;
    });
    if (nearUnfilled.length > 0) {
      const g = nearUnfilled[0];
      explanation = `⚠ UNFILLED GAP NEARBY\n\n${g.type} from ${g.prevDate} → ${g.date}\nGap range: $${g.gapBottom.toFixed(2)} — $${g.gapTop.toFixed(2)}\nPartially filled: ${g.partialFill}%\n\nThis unfilled gap acts as a price magnet. ${g.type === "GAP UP" ? `If price approaches $${g.gapTop.toFixed(2)} from below, the gap may pull it down to $${g.gapBottom.toFixed(2)}.` : `If price drops toward $${g.gapBottom.toFixed(2)}, the gap may push it up to $${g.gapTop.toFixed(2)}.`}`;
    } else {
      explanation = `No active gap fills. ${unfilled.length} unfilled gap${unfilled.length !== 1 ? "s" : ""} remain in this data.`;
    }
  }

  return { activeGapFill, justFilled, nearbyGaps, gapFillAdj, explanation, unfilled, allGaps: gaps };
}

function detectPatterns(data, label) {
  if (data.length < 20) return [];
  const P = [], recent = data.slice(-30), highs = recent.map(d => d.high), lows = recent.map(d => d.low), last = data[data.length - 1], tag = `[${label}] `;
  if (last.fastSMA && last.slowSMA && last.extraSMA && last.sma200) {
    if (last.fastSMA > last.slowSMA && last.slowSMA > last.extraSMA && last.extraSMA > last.sma200) P.push({ name: tag + "Stacked Bullish SMAs", confidence: "High", bias: "Bullish" });
    else if (last.fastSMA < last.slowSMA && last.slowSMA < last.extraSMA && last.extraSMA < last.sma200) P.push({ name: tag + "Stacked Bearish SMAs", confidence: "High", bias: "Bearish" });
    const prev = data.length > 2 ? data[data.length - 2] : null;
    if (prev?.extraSMA && prev?.sma200) { if (prev.extraSMA < prev.sma200 && last.extraSMA >= last.sma200) P.push({ name: tag + "Golden Cross", confidence: "High", bias: "Bullish reversal" }); if (prev.extraSMA > prev.sma200 && last.extraSMA <= last.sma200) P.push({ name: tag + "Death Cross", confidence: "High", bias: "Bearish reversal" }); }
  }
  if (last.vwap != null) { if (last.vwapUpperBand && last.close >= last.vwapUpperBand) P.push({ name: tag + "At VWAP Upper Band", confidence: "High", bias: "Overextended" }); if (last.vwapLowerBand && last.close <= last.vwapLowerBand) P.push({ name: tag + "At VWAP Lower Band", confidence: "High", bias: "Oversold" }); }
  if (last.rsi != null && last.rsiUpperBB != null) { if (last.rsi >= last.rsiUpperBB) P.push({ name: tag + "RSI at Upper BB", confidence: "High", bias: "Overbought" }); if (last.rsi <= last.rsiLowerBB) P.push({ name: tag + "RSI at Lower BB", confidence: "High", bias: "Oversold" }); }
  // ── DOUBLE/TRIPLE TOP & BOTTOM DETECTION ──
  // Proper detection: find distinct swing highs/lows separated by a meaningful pullback
  if (data.length >= 30) {
    const lookback = data.slice(-60); // Look at last 60 bars for patterns
    const atrArr = computeATR(data);
    const atr = atrArr[atrArr.length - 1] || (last.high - last.low);
    const tolerance = atr * 0.4; // Peaks/valleys must be within 0.4 ATR of each other
    const minSep = 5; // Minimum bars between touches (need a real valley/peak between)
    const minPullback = atr * 0.5; // Pullback between touches must be at least 0.5 ATR

    // Find swing highs (local maxima with at least 3 bars each side)
    const swingHighs = [];
    const swingLows = [];
    const lb = 3;
    for (let i = lb; i < lookback.length - lb; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - lb; j <= i + lb; j++) {
        if (j === i) continue;
        if (lookback[j].high >= lookback[i].high) isHigh = false;
        if (lookback[j].low <= lookback[i].low) isLow = false;
      }
      if (isHigh) swingHighs.push({ price: lookback[i].high, idx: i, date: lookback[i].date });
      if (isLow) swingLows.push({ price: lookback[i].low, idx: i, date: lookback[i].date });
    }

    // Check for DOUBLE/TRIPLE TOPS
    if (swingHighs.length >= 2) {
      // Group swing highs at similar prices
      const topGroups = [];
      for (const sh of swingHighs) {
        const grp = topGroups.find(g => Math.abs(g.level - sh.price) <= tolerance);
        if (grp) {
          // Must be separated by enough bars AND have a pullback between them
          const lastTouch = grp.touches[grp.touches.length - 1];
          if (sh.idx - lastTouch.idx >= minSep) {
            // Check for pullback between touches
            let minBetween = Infinity;
            for (let k = lastTouch.idx; k <= sh.idx; k++) { minBetween = Math.min(minBetween, lookback[k].low); }
            if (grp.level - minBetween >= minPullback) {
              grp.touches.push(sh);
              grp.level = grp.touches.reduce((a, t) => a + t.price, 0) / grp.touches.length;
              grp.pullback = Math.max(grp.pullback || 0, grp.level - minBetween);
            }
          }
        } else {
          topGroups.push({ level: sh.price, touches: [sh], pullback: 0 });
        }
      }
      for (const g of topGroups) {
        if (g.touches.length < 2 || (g.touches.length === 2 && g.pullback < minPullback)) continue;

        // ── VALIDATION: reject false patterns ──
        // 1. Touches must be roughly flat (not trending higher = just an uptrend)
        const touchPrices = g.touches.map(t => t.price);
        const firstTouch = touchPrices[0], lastTouchPrice = touchPrices[touchPrices.length - 1];
        const touchDrift = (lastTouchPrice - firstTouch) / atr;
        if (touchDrift > 1) continue; // Highs trending up = uptrend, not a double top

        // 2. Pullback between touches must be meaningful (at least 1 ATR)
        if (g.pullback < atr * 1) continue;

        // 3. Not just noise in a strong uptrend — check if highs BEFORE the pattern were lower
        const prePatternIdx = Math.max(0, g.touches[0].idx - 10);
        const prePatternHighs = lookback.slice(prePatternIdx, g.touches[0].idx).map(d => d.high);
        const preHigh = prePatternHighs.length > 0 ? Math.max(...prePatternHighs) : 0;
        if (preHigh > g.level + tolerance) continue; // Pattern is below prior highs = not a real ceiling

        const patName = g.touches.length >= 3 ? "Triple Top" : "Double Top";
        const lastTouchIdx = g.touches[g.touches.length - 1].idx;
        const barsSinceLastTouch = lookback.length - 1 - lastTouchIdx;
        const belowLevel = last.close < g.level;
        const distFromLevel = (g.level - last.close) / atr;

        // Neckline: lowest point between touches = breakdown level
        let neckline = Infinity;
        for (let k = g.touches[0].idx; k <= lastTouchIdx; k++) { neckline = Math.min(neckline, lookback[k].low); }
        const belowNeckline = last.close < neckline;
        const targetMove = g.level - neckline; // measured move target

        // Check last 2 bars direction
        const last2 = data.slice(-2);
        const falling2d = last2.length === 2 && last2[1].close < last2[0].close;

        // ── CLASSIFY PATTERN STATUS ──
        let status = "", actionable = false;

        if (belowNeckline && barsSinceLastTouch <= 8 && falling2d) {
          // Just broke neckline AND still falling = ACTIVE BREAKDOWN
          status = "BREAKDOWN CONFIRMED";
          actionable = true;
        } else if (belowNeckline && barsSinceLastTouch <= 8 && !falling2d) {
          // Broke neckline but pausing = might be retesting
          const distBelowNeck = (neckline - last.close) / atr;
          if (distBelowNeck < 1.5) {
            status = "NECKLINE RETEST";
            actionable = true;
          } else {
            status = "MOVE PLAYED OUT";
            actionable = false;
          }
        } else if (belowLevel && !belowNeckline && barsSinceLastTouch <= 5 && falling2d) {
          // Rejected from top, heading toward neckline = FORMING
          status = "FORMING — rejection in progress";
          actionable = true;
        } else if (!belowLevel && barsSinceLastTouch <= 3) {
          // Testing the top right now
          status = "TESTING TOP — watch for rejection";
          actionable = true;
        } else if (belowNeckline) {
          // Way past neckline = already played out
          const distBelowNeck = (neckline - last.close) / atr;
          if (distBelowNeck >= 2) { status = "MOVE PLAYED OUT"; actionable = false; }
          else { status = "EXTENDED — late entry risk"; actionable = barsSinceLastTouch <= 12; }
        } else {
          // Pattern exists but price is between level and neckline, not fresh
          if (barsSinceLastTouch > 15) { status = "OLD PATTERN"; actionable = false; }
          else { status = "ACTIVE"; actionable = true; }
        }

        if (actionable) {
          P.push({
            name: tag + `${patName} at $${g.level.toFixed(2)} — ${status}`,
            confidence: (status === "BREAKDOWN CONFIRMED" || status === "FORMING — rejection in progress") ? "High" : "Medium",
            bias: "Bearish reversal",
            detail: `${g.touches.length} touches at $${g.level.toFixed(2)} (${g.touches.map(t => t.date).join(", ")}). Neckline: $${neckline.toFixed(2)}. Pullback: $${g.pullback.toFixed(2)}. Measured move target: $${(neckline - targetMove).toFixed(2)}.${falling2d ? " Price falling last 2 bars ✓" : ""} Status: ${status}.`,
            status,
            level: g.level,
            neckline,
            target: neckline - targetMove,
            touches: g.touches.length,
          });
        }
      }
    }

    // Check for DOUBLE/TRIPLE BOTTOMS
    if (swingLows.length >= 2) {
      const botGroups = [];
      for (const sl of swingLows) {
        const grp = botGroups.find(g => Math.abs(g.level - sl.price) <= tolerance);
        if (grp) {
          const lastTouch = grp.touches[grp.touches.length - 1];
          if (sl.idx - lastTouch.idx >= minSep) {
            let maxBetween = -Infinity;
            for (let k = lastTouch.idx; k <= sl.idx; k++) { maxBetween = Math.max(maxBetween, lookback[k].high); }
            if (maxBetween - grp.level >= minPullback) {
              grp.touches.push(sl);
              grp.level = grp.touches.reduce((a, t) => a + t.price, 0) / grp.touches.length;
              grp.pullback = Math.max(grp.pullback || 0, maxBetween - grp.level);
            }
          }
        } else {
          botGroups.push({ level: sl.price, touches: [sl], pullback: 0 });
        }
      }
      for (const g of botGroups) {
        if (g.touches.length < 2 || (g.touches.length === 2 && g.pullback < minPullback)) continue;

        // ── VALIDATION: reject false patterns ──
        // 1. Touches must be roughly flat (not trending lower = just a downtrend grinding along support)
        const touchPrices = g.touches.map(t => t.price);
        const firstTouch = touchPrices[0], lastTouchPrice = touchPrices[touchPrices.length - 1];
        const touchDrift = (firstTouch - lastTouchPrice) / atr;
        if (touchDrift > 1) continue; // Lows trending down = downtrend, not a double bottom

        // 2. Rally between touches must be meaningful (at least 1 ATR)
        if (g.pullback < atr * 1) continue;

        // 3. Not just noise in a downtrend — check if lows BEFORE the pattern were higher
        const prePatternIdx = Math.max(0, g.touches[0].idx - 10);
        const prePatternLows = lookback.slice(prePatternIdx, g.touches[0].idx).map(d => d.low);
        const preLow = prePatternLows.length > 0 ? Math.min(...prePatternLows) : Infinity;
        if (preLow < g.level - tolerance) continue; // Pattern is above prior lows = not a real floor

        // 4. Current price shouldn't be making new lows below the pattern
        if (last.close < g.level - atr * 0.5) continue; // Price broke below = pattern failed, not a bottom

        const patName = g.touches.length >= 3 ? "Triple Bottom" : "Double Bottom";
        const lastTouchIdx = g.touches[g.touches.length - 1].idx;
        const barsSinceLastTouch = lookback.length - 1 - lastTouchIdx;
        const aboveLevel = last.close > g.level;

        // Neckline: highest point between touches = breakout level
        let neckline = -Infinity;
        for (let k = g.touches[0].idx; k <= lastTouchIdx; k++) { neckline = Math.max(neckline, lookback[k].high); }
        const aboveNeckline = last.close > neckline;
        const targetMove = neckline - g.level;

        // Check last 2 bars direction
        const last2 = data.slice(-2);
        const rising2d = last2.length === 2 && last2[1].close > last2[0].close;

        // ── CLASSIFY PATTERN STATUS ──
        let status = "", actionable = false;

        if (aboveNeckline && barsSinceLastTouch <= 8 && rising2d) {
          status = "BREAKOUT CONFIRMED";
          actionable = true;
        } else if (aboveNeckline && barsSinceLastTouch <= 8 && !rising2d) {
          const distAboveNeck = (last.close - neckline) / atr;
          if (distAboveNeck < 1.5) {
            status = "NECKLINE RETEST";
            actionable = true;
          } else {
            status = "MOVE PLAYED OUT";
            actionable = false;
          }
        } else if (aboveLevel && !aboveNeckline && barsSinceLastTouch <= 5 && rising2d) {
          status = "FORMING — bounce in progress";
          actionable = true;
        } else if (!aboveLevel && barsSinceLastTouch <= 3) {
          status = "TESTING BOTTOM — watch for bounce";
          actionable = true;
        } else if (aboveNeckline) {
          const distAboveNeck = (last.close - neckline) / atr;
          if (distAboveNeck >= 2) { status = "MOVE PLAYED OUT"; actionable = false; }
          else { status = "EXTENDED — late entry risk"; actionable = barsSinceLastTouch <= 12; }
        } else {
          if (barsSinceLastTouch > 15) { status = "OLD PATTERN"; actionable = false; }
          else { status = "ACTIVE"; actionable = true; }
        }

        if (actionable) {
          P.push({
            name: tag + `${patName} at $${g.level.toFixed(2)} — ${status}`,
            confidence: (status === "BREAKOUT CONFIRMED" || status === "FORMING — bounce in progress") ? "High" : "Medium",
            bias: "Bullish reversal",
            detail: `${g.touches.length} touches at $${g.level.toFixed(2)} (${g.touches.map(t => t.date).join(", ")}). Neckline: $${neckline.toFixed(2)}. Rally: $${g.pullback.toFixed(2)}. Measured move target: $${(neckline + targetMove).toFixed(2)}.${rising2d ? " Price rising last 2 bars ✓" : ""} Status: ${status}.`,
            status,
            level: g.level,
            neckline,
            target: neckline + targetMove,
            touches: g.touches.length,
          });
        }
      }
    }
  }
  return P;
}
function analyzeGapPot(data) {
  if (data.length < 5) return null;
  const atr = computeATR(data); const a = atr[atr.length - 1]; const avg = data.slice(-20).reduce((s, d) => s + (d.volume || 0), 0) / 20; const v = data[data.length - 1].volume || 0; const vs = avg > 0 ? v / avg : 1;
  const lc = data[data.length - 1], cb = lc.close - lc.open; let d = "Neutral", p = "Low"; if (vs > 1.8 && Math.abs(cb) / lc.open > 0.02) { d = cb > 0 ? "Gap Up" : "Gap Down"; p = vs > 2.5 ? "High" : "Medium"; }
  return { direction: d, probability: p, volSpike: vs.toFixed(2), lastATR: a?.toFixed(2) };
}

// ─── VOLUME ANALYSIS (Enhanced) ───
function analyzeVolume(data) {
  if (!data || data.length < 10) return { relVol: 1, trend: "flat", confirmation: "none", avgVol: 0 };
  const vols = data.map(d => d.volume || 0);
  // Skip if no volume data
  if (vols.every(v => v === 0)) return { relVol: 1, trend: "flat", confirmation: "none", avgVol: 0, hasVolume: false };

  const last = data[data.length - 1];
  const avg20 = data.slice(-20).reduce((s, d) => s + (d.volume || 0), 0) / Math.min(20, data.length);
  const relVol = avg20 > 0 ? (last.volume || 0) / avg20 : 1;

  // Volume trend: compare avg volume of last 5 bars vs prior 10 bars
  const recent5 = data.slice(-5).reduce((s, d) => s + (d.volume || 0), 0) / 5;
  const prior10 = data.slice(-15, -5).reduce((s, d) => s + (d.volume || 0), 0) / Math.min(10, data.slice(-15, -5).length || 1);
  const trend = prior10 > 0 ? (recent5 / prior10 > 1.3 ? "expanding" : recent5 / prior10 < 0.7 ? "contracting" : "flat") : "flat";

  // Volume confirmation: are up bars getting more volume than down bars? (last 10 bars)
  const recent = data.slice(-10);
  let upVol = 0, dnVol = 0, upBars = 0, dnBars = 0;
  for (const d of recent) {
    if (d.close >= d.open) { upVol += d.volume || 0; upBars++; }
    else { dnVol += d.volume || 0; dnBars++; }
  }
  const avgUpVol = upBars > 0 ? upVol / upBars : 0;
  const avgDnVol = dnBars > 0 ? dnVol / dnBars : 0;
  let confirmation = "none";
  if (avgUpVol > 0 && avgDnVol > 0) {
    const ratio = avgUpVol / avgDnVol;
    if (ratio > 1.4) confirmation = "bullish"; // Up bars have more volume
    else if (ratio < 0.7) confirmation = "bearish"; // Down bars have more volume
    else confirmation = "neutral";
  }

  // On-balance trend: last 3 bars volume direction
  const last3 = data.slice(-3);
  const last3Bullish = last3.filter(d => d.close >= d.open).length;
  const climax = relVol > 2.5; // Possible exhaustion/climax

  // ── NEW: Breakout bar volume (current bar vs prior 3 bars avg) ──
  const prior3Avg = data.length >= 4
    ? data.slice(-4, -1).reduce((s, d) => s + (d.volume || 0), 0) / 3
    : avg20;
  const breakoutVolRatio = prior3Avg > 0 ? (last.volume || 0) / prior3Avg : 1;
  const breakoutVol = breakoutVolRatio > 1.8; // Current bar has 1.8x volume of prior 3 bars

  // ── NEW: Volume build pattern (gradual build = continuation, spike = exhaustion) ──
  // Check if last 5 bars show gradually increasing volume (each bar > prior)
  let volBuild = "none";
  if (data.length >= 5) {
    const last5Vols = data.slice(-5).map(d => d.volume || 0);
    let increasing = 0, decreasing = 0;
    for (let i = 1; i < last5Vols.length; i++) {
      if (last5Vols[i] > last5Vols[i - 1] * 1.05) increasing++;
      else if (last5Vols[i] < last5Vols[i - 1] * 0.95) decreasing++;
    }
    if (increasing >= 3) volBuild = "building"; // Gradual build = institutional accumulation
    else if (decreasing >= 3) volBuild = "fading"; // Fading volume = move losing conviction
    // Spike pattern: one big bar after quiet bars
    if (breakoutVolRatio > 2.5 && last5Vols[3] < avg20 * 0.8) volBuild = "spike"; // Exhaustion risk
  }

  // ── NEW: Close Location Value (CLV) ──
  // Where did price close within its range? 1.0 = at high, 0.0 = at low
  const range = last.high - last.low;
  const clv = range > 0 ? (last.close - last.low) / range : 0.5;

  return {
    relVol: Math.round(relVol * 100) / 100, trend, confirmation, avgVol: Math.round(avg20),
    hasVolume: true, climax, last3Bullish,
    breakoutVol, breakoutVolRatio: Math.round(breakoutVolRatio * 100) / 100,
    volBuild, clv: Math.round(clv * 100) / 100
  };
}

// ─── MARKET REGIME ANALYSIS ───
function analyzeRegime(dailyData) {
  if (!dailyData || dailyData.length < 20) return null;
  const last = dailyData[dailyData.length - 1];
  const price = last.close;

  // Price vs SMAs
  const aboveSMA10 = last.fastSMA ? price > last.fastSMA : null;
  const aboveSMA20 = last.slowSMA ? price > last.slowSMA : null;
  const aboveSMA50 = last.extraSMA ? price > last.extraSMA : null;
  const aboveSMA200 = last.sma200 ? price > last.sma200 : null;

  // RSI
  const rsi = last.rsi;

  // % change over recent periods
  const pct5d = dailyData.length >= 6 ? ((price - dailyData[dailyData.length - 6].close) / dailyData[dailyData.length - 6].close * 100) : 0;
  const pct20d = dailyData.length >= 21 ? ((price - dailyData[dailyData.length - 21].close) / dailyData[dailyData.length - 21].close * 100) : 0;

  // MACD
  const macd = computeMACD(dailyData);
  const macdHist = macd.histogram[macd.histogram.length - 1];

  // Score the regime: positive = bullish, negative = bearish
  let score = 0;
  if (aboveSMA10 !== null) score += aboveSMA10 ? 1 : -1;
  if (aboveSMA20 !== null) score += aboveSMA20 ? 1 : -1;
  if (aboveSMA50 !== null) score += aboveSMA50 ? 1.5 : -1.5;
  if (aboveSMA200 !== null) score += aboveSMA200 ? 2 : -2;
  if (rsi != null) { if (rsi > 55) score += 0.5; else if (rsi < 45) score -= 0.5; }
  if (macdHist > 0) score += 0.5; else if (macdHist < 0) score -= 0.5;

  // Direction
  const direction = score >= 2 ? "BULLISH" : score <= -2 ? "BEARISH" : "NEUTRAL";
  const strength = Math.abs(score);

  return {
    direction, strength: Math.round(strength * 10) / 10, score: Math.round(score * 10) / 10,
    rsi: rsi?.toFixed(1), pct5d: pct5d.toFixed(1), pct20d: pct20d.toFixed(1),
    aboveSMA10, aboveSMA20, aboveSMA50, aboveSMA200, price: price.toFixed(2),
    macdHist: macdHist?.toFixed(3)
  };
}

function scoreTF(data, isH = false) {
  if (data.length < 10) return { score: 0, trend: 0, entry: 0, confirm: 0, latePenalty: 0, factors: [], rsiBBSignal: "mid-band", rsiSignal: "neutral", rsiTrend: "flat", rsiBBWidth: "normal", rsiRecovery: "", vwapSignal: "none", atr: 0, macdHist: 0, volume: {} };
  const last = data[data.length - 1], prev = data[data.length - 2];
  const macd = computeMACD(data); const mH = macd.histogram[macd.histogram.length - 1];
  const atr = computeATR(data); const a = atr[atr.length - 1] || (last.high - last.low);
  const vol = analyzeVolume(data);
  const F = [];
  let rS = "neutral", rBB = "mid-band", rsiTrend = "flat", rsiBBWidth = "normal", rsiRecovery = "", vS = "none";

  // ══════════════════════════════════════════════════════
  // CATEGORY 1: TREND (max 3) — Is there a directional trend?
  // This is the baseline. Every stock in a trending market gets this.
  // ══════════════════════════════════════════════════════
  let trend = 0;

  // SMA structure: stacked = strong trend
  if (last.fastSMA && last.slowSMA && last.extraSMA) {
    if (last.fastSMA > last.slowSMA && last.slowSMA > last.extraSMA) {
      trend += 1; F.push({ text: `SMAs stacked bullish (10>20>50)`, bull: true, cat: "trend" });
    } else if (last.fastSMA < last.slowSMA && last.slowSMA < last.extraSMA) {
      trend -= 1; F.push({ text: `SMAs stacked bearish (10<20<50)`, bull: false, cat: "trend" });
    } else {
      const aboveCt = (last.close > last.fastSMA ? 1 : 0) + (last.close > last.slowSMA ? 1 : 0) + (last.close > last.extraSMA ? 1 : 0);
      if (aboveCt >= 2) { trend += 0.5; F.push({ text: `Price above ${aboveCt}/3 SMAs — lean bullish`, bull: true, cat: "trend" }); }
      else { trend -= 0.5; F.push({ text: `Price below ${3-aboveCt}/3 SMAs — lean bearish`, bull: false, cat: "trend" }); }
    }
  }

  // SMA200 = long-term regime
  if (last.sma200) {
    if (last.close > last.sma200) { trend += 0.5; F.push({ text: `Above SMA 200 ($${last.sma200.toFixed(2)}) — long-term bullish`, bull: true, cat: "trend" }); }
    else { trend -= 0.5; F.push({ text: `Below SMA 200 ($${last.sma200.toFixed(2)}) — long-term bearish`, bull: false, cat: "trend" }); }
  }

  // MACD direction (basic trend confirmation)
  if (mH > 0) { trend += 0.5; F.push({ text: `MACD positive`, bull: true, cat: "trend" }); }
  else { trend -= 0.5; F.push({ text: `MACD negative`, bull: false, cat: "trend" }); }

  // Established trend duration (daily only)
  if (!isH && data.length >= 20 && last.slowSMA) {
    const recent20 = data.slice(-20);
    const aboveSlow = recent20.filter(d => d.slowSMA && d.close > d.slowSMA).length;
    const belowSlow = recent20.filter(d => d.slowSMA && d.close < d.slowSMA).length;
    if (aboveSlow >= 16) {
      trend += 1; F.push({ text: `Price above SMA 20 for ${aboveSlow}/20 bars — established uptrend`, bull: true, cat: "trend" });
    } else if (belowSlow >= 16) {
      trend -= 1; F.push({ text: `Price below SMA 20 for ${belowSlow}/20 bars — established downtrend`, bull: false, cat: "trend" });
    } else if (aboveSlow >= 8 && aboveSlow <= 12) {
      F.push({ text: `Choppy — ${aboveSlow}/20 bars above SMA 20, no clear trend`, bull: false, cat: "trend" });
    }
  }

  // VWAP (hourly only — trend context)
  if (isH && last.vwap != null) {
    if (last.close > last.vwap) { trend += 0.5; vS = "above"; F.push({ text: `Above VWAP ($${last.vwap.toFixed(2)})`, bull: true, cat: "trend" }); }
    else { trend -= 0.5; vS = "below"; F.push({ text: `Below VWAP ($${last.vwap.toFixed(2)})`, bull: false, cat: "trend" }); }
  }

  trend = Math.max(-3, Math.min(3, trend)); // Clamp

  // ══════════════════════════════════════════════════════
  // CATEGORY 2: ENTRY QUALITY (max 5) — Is NOW a good time?
  // This is the differentiator. Most stocks won't score here.
  // ══════════════════════════════════════════════════════
  let entry = 0;

  // ── 2a. SMA rejection/bounce (price touched SMA and reversed) ──
  if (last.fastSMA && prev) {
    // Bearish: price rallied to touch SMA 10 from below, then rejected (closed below)
    if (last.close < last.fastSMA && last.high >= last.fastSMA * 0.997 && prev.close < prev.fastSMA) {
      entry -= 1.5; F.push({ text: `🎯 Rejected at SMA 10 ($${last.fastSMA.toFixed(2)}) — sell the rally entry`, bull: false, cat: "entry" });
    }
    // Bullish: price dipped to SMA 10 from above, bounced
    if (last.close > last.fastSMA && last.low <= last.fastSMA * 1.003 && prev.close > prev.fastSMA) {
      entry += 1.5; F.push({ text: `🎯 Bounced off SMA 10 ($${last.fastSMA.toFixed(2)}) — buy the dip entry`, bull: true, cat: "entry" });
    }
  }
  if (last.slowSMA && prev) {
    if (last.close < last.slowSMA && last.high >= last.slowSMA * 0.997 && prev.close < prev.slowSMA) {
      entry -= 1.5; F.push({ text: `🎯 Rejected at SMA 20 ($${last.slowSMA.toFixed(2)}) — key resistance rejection`, bull: false, cat: "entry" });
    }
    if (last.close > last.slowSMA && last.low <= last.slowSMA * 1.003 && prev.close > prev.slowSMA) {
      entry += 1.5; F.push({ text: `🎯 Bounced off SMA 20 ($${last.slowSMA.toFixed(2)}) — key support hold`, bull: true, cat: "entry" });
    }
  }

  // ── 2b. RSI reversal from pullback ──
  if (last.rsi != null && data.length >= 5) {
    const rsi5 = data.slice(-5).map(d => d.rsi).filter(v => v != null);
    if (rsi5.length >= 4) {
      const rsiMax5 = Math.max(...rsi5), rsiMin5 = Math.min(...rsi5);
      // Bearish entry: RSI pulled back to 45-60 zone then turned back down
      if (rsiMax5 >= 45 && last.rsi < rsiMax5 - 3 && last.rsi < 50 && trend < 0) {
        entry -= 1; F.push({ text: `🎯 RSI pullback rejection (peaked ${rsiMax5.toFixed(0)}, now ${last.rsi.toFixed(0)}) — failed rally`, bull: false, cat: "entry" });
      }
      // Bullish entry: RSI dipped to 40-55 zone then bounced back up
      if (rsiMin5 <= 55 && last.rsi > rsiMin5 + 3 && last.rsi > 50 && trend > 0) {
        entry += 1; F.push({ text: `🎯 RSI dip recovery (bottomed ${rsiMin5.toFixed(0)}, now ${last.rsi.toFixed(0)}) — dip bought`, bull: true, cat: "entry" });
      }
    }
  }

  // ── 2c. RSI momentum burst (rapid shift) ──
  if (last.rsi != null) {
    const rsiLong = data.slice(-20).map(d => d.rsi).filter(v => v != null);
    if (rsiLong.length >= 5) {
      const rsi3ago = rsiLong[rsiLong.length - 3];
      const rsiNow = rsiLong[rsiLong.length - 1];
      const shift3 = rsiNow - rsi3ago;
      if (shift3 >= 10 && rsiNow <= 60) {
        entry += 1.5; F.push({ text: `⚡ RSI burst +${shift3.toFixed(0)} in 3 bars (${rsi3ago.toFixed(0)}→${rsiNow.toFixed(0)}) — momentum ignition`, bull: true, cat: "entry" });
      } else if (shift3 <= -10 && rsiNow >= 40) {
        entry -= 1.5; F.push({ text: `⚡ RSI crash ${shift3.toFixed(0)} in 3 bars (${rsi3ago.toFixed(0)}→${rsiNow.toFixed(0)}) — momentum collapse`, bull: false, cat: "entry" });
      }
    }
  }

  // ── 2d. Rejection candle (wick > 2x body at key area) ──
  if (data.length >= 2) {
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low;
    const upperWick = last.high - Math.max(last.close, last.open);
    const lowerWick = Math.min(last.close, last.open) - last.low;

    if (range > 0 && body > 0) {
      // Bearish rejection: big upper wick, price closed near low
      if (upperWick > body * 2 && last.close < last.open && upperWick > range * 0.5) {
        entry -= 1; F.push({ text: `🎯 Bearish rejection candle — upper wick ${(upperWick/body).toFixed(1)}x body`, bull: false, cat: "entry" });
      }
      // Bullish rejection: big lower wick (hammer), price closed near high
      if (lowerWick > body * 2 && last.close > last.open && lowerWick > range * 0.5) {
        entry += 1; F.push({ text: `🎯 Bullish hammer candle — lower wick ${(lowerWick/body).toFixed(1)}x body`, bull: true, cat: "entry" });
      }
    }

    // Engulfing patterns
    if (prev) {
      const prevBody = Math.abs(prev.close - prev.open);
      // Bearish engulfing
      if (last.close < last.open && prev.close > prev.open && last.open >= prev.close && last.close <= prev.open && body > prevBody * 1.2) {
        entry -= 1; F.push({ text: `🎯 Bearish engulfing candle — sellers overwhelmed buyers`, bull: false, cat: "entry" });
      }
      // Bullish engulfing
      if (last.close > last.open && prev.close < prev.open && last.open <= prev.close && last.close >= prev.open && body > prevBody * 1.2) {
        entry += 1; F.push({ text: `🎯 Bullish engulfing candle — buyers overwhelmed sellers`, bull: true, cat: "entry" });
      }
    }
  }

  // ── 2e. MACD zero-line cross (fresh momentum shift) ──
  if (macd.histogram.length >= 3) {
    const prev2 = macd.histogram[macd.histogram.length - 3];
    if (prev2 < 0 && mH > 0) { entry += 1; F.push({ text: `🎯 MACD crossed above zero — fresh bullish momentum`, bull: true, cat: "entry" }); }
    else if (prev2 > 0 && mH < 0) { entry -= 1; F.push({ text: `🎯 MACD crossed below zero — fresh bearish momentum`, bull: false, cat: "entry" }); }
  }

  // ── 2e2. MACD signal line crossover (more reliable than zero-line for short-term) ──
  if (macd.macd.length >= 2 && macd.signal.length >= 2) {
    const mNow = macd.macd[macd.macd.length - 1], mPrev = macd.macd[macd.macd.length - 2];
    const sNow = macd.signal[macd.signal.length - 1], sPrev = macd.signal[macd.signal.length - 2];
    // Bullish crossover: MACD line crosses above signal line
    if (mPrev <= sPrev && mNow > sNow) {
      entry += 1.25; F.push({ text: `🎯 MACD bullish signal crossover — MACD line crossed above signal`, bull: true, cat: "entry" });
    }
    // Bearish crossover: MACD line crosses below signal line
    else if (mPrev >= sPrev && mNow < sNow) {
      entry -= 1.25; F.push({ text: `🎯 MACD bearish signal crossover — MACD line crossed below signal`, bull: false, cat: "entry" });
    }
  }

  // ── 2f. VWAP band extreme (hourly only — mean reversion entry) ──
  if (isH && last.vwapUpperBand && last.vwapLowerBand) {
    if (last.close >= last.vwapUpperBand) { entry -= 1; vS = "upper-band"; F.push({ text: `🎯 At VWAP upper band — overextended, mean reversion entry`, bull: false, cat: "entry" }); }
    else if (last.close <= last.vwapLowerBand) { entry += 1; vS = "lower-band"; F.push({ text: `🎯 At VWAP lower band — oversold, mean reversion entry`, bull: true, cat: "entry" }); }
  }

  // ── 2g. Close Location Value (CLV) — where price closed within its range ──
  // CLV near 1.0 = closed at high (bullish conviction), near 0.0 = closed at low (bearish conviction)
  if (vol.hasVolume && vol.clv != null) {
    if (vol.clv >= 0.85 && trend > 0) {
      entry += 0.75; F.push({ text: `🎯 CLV ${vol.clv} — closed near high of bar (strong buyer conviction)`, bull: true, cat: "entry" });
    } else if (vol.clv <= 0.15 && trend < 0) {
      entry -= 0.75; F.push({ text: `🎯 CLV ${vol.clv} — closed near low of bar (strong seller conviction)`, bull: false, cat: "entry" });
    } else if (vol.clv >= 0.85 && trend < 0) {
      // Closing near high in a downtrend = potential reversal signal
      entry += 0.5; F.push({ text: `🎯 CLV ${vol.clv} — closed near high despite downtrend (buyers stepping in)`, bull: true, cat: "entry" });
    } else if (vol.clv <= 0.15 && trend > 0) {
      // Closing near low in an uptrend = potential reversal signal
      entry -= 0.5; F.push({ text: `🎯 CLV ${vol.clv} — closed near low despite uptrend (sellers taking over)`, bull: false, cat: "entry" });
    }
  }

  entry = Math.max(-5, Math.min(5, entry)); // Clamp

  // ══════════════════════════════════════════════════════
  // CATEGORY 3: CONFIRMATION (max 3) — Does momentum back it up?
  // ══════════════════════════════════════════════════════
  let confirm = 0;

  // Volume confirming direction
  if (vol.hasVolume) {
    if (vol.confirmation === "bullish") {
      confirm += 1; F.push({ text: `Vol: ${vol.relVol}x avg, ${vol.trend}, bullish (up bars heavier)`, bull: true, cat: "confirm" });
    } else if (vol.confirmation === "bearish") {
      confirm -= 1; F.push({ text: `Vol: ${vol.relVol}x avg, ${vol.trend}, bearish (down bars heavier)`, bull: false, cat: "confirm" });
    } else {
      F.push({ text: `Vol: ${vol.relVol}x avg, ${vol.trend}, neutral`, bull: trend > 0, cat: "confirm" });
    }
    if (vol.trend === "expanding" && vol.relVol > 1.3) {
      if (trend > 0 || entry > 0) { confirm += 0.5; F.push({ text: `Volume expanding on move (${vol.relVol}x)`, bull: true, cat: "confirm" }); }
      else if (trend < 0 || entry < 0) { confirm -= 0.5; F.push({ text: `Volume expanding on move (${vol.relVol}x)`, bull: false, cat: "confirm" }); }
    }
    // ── NEW: Breakout bar volume — current bar vs prior 3 bars ──
    if (vol.breakoutVol) {
      const lastBar = data[data.length - 1];
      const bullBreakout = lastBar.close > lastBar.open;
      if (bullBreakout) { confirm += 0.75; F.push({ text: `⚡ Breakout volume on bullish bar (${vol.breakoutVolRatio}x prior 3 bars)`, bull: true, cat: "confirm" }); }
      else { confirm -= 0.75; F.push({ text: `⚡ Breakout volume on bearish bar (${vol.breakoutVolRatio}x prior 3 bars)`, bull: false, cat: "confirm" }); }
    }
    // ── NEW: Volume build pattern ──
    if (vol.volBuild === "building") {
      const direction_bull = trend > 0 || entry > 0;
      if (direction_bull) { confirm += 0.5; F.push({ text: `📈 Volume building gradually (institutional accumulation)`, bull: true, cat: "confirm" }); }
      else { confirm -= 0.5; F.push({ text: `📉 Volume building gradually (institutional distribution)`, bull: false, cat: "confirm" }); }
    } else if (vol.volBuild === "fading") {
      F.push({ text: `Volume fading — move losing conviction`, bull: !(trend > 0 || entry > 0), cat: "confirm" });
    } else if (vol.volBuild === "spike") {
      // Spike after quiet = possible exhaustion, penalize the current direction
      if (trend > 0) { confirm -= 0.5; F.push({ text: `🔥 Volume spike after quiet — exhaustion risk for bulls`, bull: false, cat: "confirm" }); }
      else if (trend < 0) { confirm += 0.5; F.push({ text: `🔥 Volume spike after quiet — exhaustion risk for bears`, bull: true, cat: "confirm" }); }
    }
    if (vol.climax) { confirm += (trend > 0 ? -0.5 : 0.5); F.push({ text: `🔥 Climax volume (${vol.relVol}x) — exhaustion, penalizing current trend`, bull: trend <= 0, cat: "confirm" }); }
  }

  // MACD accelerating (not just negative/positive — getting MORE so)
  const histLast5 = macd.histogram.slice(-5);
  if (histLast5.length >= 3) {
    if (mH > 0) {
      const increasing = histLast5.every((v, i) => i === 0 || v >= histLast5[i - 1] - 0.01);
      if (increasing) { confirm += 0.5; F.push({ text: `MACD accelerating bullish`, bull: true, cat: "confirm" }); }
      else {
        const decreasing = histLast5.every((v, i) => i === 0 || v <= histLast5[i - 1] + 0.01);
        if (decreasing) F.push({ text: `MACD decelerating — momentum fading`, bull: false, cat: "confirm" });
      }
    } else {
      const moreNeg = histLast5.every((v, i) => i === 0 || v <= histLast5[i - 1] + 0.01);
      if (moreNeg) { confirm -= 0.5; F.push({ text: `MACD accelerating bearish`, bull: false, cat: "confirm" }); }
      else {
        const lessNeg = histLast5.every((v, i) => i === 0 || v >= histLast5[i - 1] - 0.01);
        if (lessNeg) F.push({ text: `MACD decelerating — selling pressure easing`, bull: true, cat: "confirm" });
      }
    }
  }

  // RSI BB expanding in trend direction
  if (last.rsi != null && last.rsiUpperBB != null) {
    const bbWidth = last.rsiUpperBB - last.rsiLowerBB;
    const prev5 = data.length > 5 ? data[data.length - 6] : null;
    if (prev5?.rsiUpperBB != null) {
      const prevWidth = prev5.rsiUpperBB - prev5.rsiLowerBB;
      if (bbWidth < prevWidth * 0.85) { rsiBBWidth = "squeezing"; F.push({ text: `RSI BB squeezing — breakout imminent`, bull: true, cat: "confirm" }); }
      else if (bbWidth > prevWidth * 1.15) { rsiBBWidth = "expanding"; F.push({ text: `RSI BB expanding — volatility increasing`, bull: last.rsi > 50, cat: "confirm" }); }
    }
    if (last.rsi >= last.rsiUpperBB) { rBB = "upper-band-touch"; }
    else if (last.rsi <= last.rsiLowerBB) { rBB = "lower-band-touch"; }
    else if (last.rsi > last.rsiMA) { rBB = "above-median"; }
    else if (last.rsi < last.rsiMA) { rBB = "below-median"; }
  }

  // Candle body conviction
  if (data.length >= 5) {
    const r5 = data.slice(-5);
    const bullBodies = r5.filter(d => d.close > d.open).length;
    if (bullBodies >= 4) { confirm += 0.5; F.push({ text: `${bullBodies}/5 bars bullish — buyer conviction`, bull: true, cat: "confirm" }); }
    else if (bullBodies <= 1) { confirm -= 0.5; F.push({ text: `${5-bullBodies}/5 bars bearish — seller conviction`, bull: false, cat: "confirm" }); }
  }

  // ── NEW: Consecutive candle body analysis with increasing body size ──
  // 3+ consecutive same-direction bars with growing bodies = institutional flow
  if (data.length >= 4) {
    const r4 = data.slice(-4);
    // Check for consecutive bullish bars with increasing body size
    let consecBull = 0, bullBodiesGrowing = true;
    for (let i = r4.length - 1; i >= 0; i--) {
      if (r4[i].close > r4[i].open) {
        consecBull++;
        if (consecBull >= 2 && i < r4.length - 1) {
          const currBody = r4[i + 1].close - r4[i + 1].open;
          const prevBodyVal = r4[i].close - r4[i].open;
          if (currBody < prevBodyVal * 0.9) bullBodiesGrowing = false;
        }
      } else break;
    }
    // Check for consecutive bearish bars with increasing body size
    let consecBear = 0, bearBodiesGrowing = true;
    for (let i = r4.length - 1; i >= 0; i--) {
      if (r4[i].close < r4[i].open) {
        consecBear++;
        if (consecBear >= 2 && i < r4.length - 1) {
          const currBody = r4[i + 1].open - r4[i + 1].close;
          const prevBodyVal = r4[i].open - r4[i].close;
          if (currBody < prevBodyVal * 0.9) bearBodiesGrowing = false;
        }
      } else break;
    }
    if (consecBull >= 3 && bullBodiesGrowing) {
      confirm += 1; F.push({ text: `🏛 ${consecBull} consecutive bullish bars with growing bodies — institutional buying flow`, bull: true, cat: "confirm" });
    } else if (consecBull >= 3) {
      confirm += 0.5; F.push({ text: `${consecBull} consecutive bullish bars — sustained buying`, bull: true, cat: "confirm" });
    }
    if (consecBear >= 3 && bearBodiesGrowing) {
      confirm -= 1; F.push({ text: `🏛 ${consecBear} consecutive bearish bars with growing bodies — institutional selling flow`, bull: false, cat: "confirm" });
    } else if (consecBear >= 3) {
      confirm -= 0.5; F.push({ text: `${consecBear} consecutive bearish bars — sustained selling`, bull: false, cat: "confirm" });
    }
  }

  confirm = Math.max(-3, Math.min(3, confirm)); // Clamp

  // ══════════════════════════════════════════════════════
  // LATE ENTRY PENALTY — Are you chasing a move that's done?
  // ══════════════════════════════════════════════════════
  let latePenalty = 0;

  // RSI slope for metadata
  if (last.rsi != null) {
    const rsiVals = data.slice(-8).map(d => d.rsi).filter(v => v != null);
    if (rsiVals.length >= 4) {
      const n = rsiVals.length; let sx=0,sy=0,sxy=0,sx2=0;
      for(let i=0;i<n;i++){sx+=i;sy+=rsiVals[i];sxy+=i*rsiVals[i];sx2+=i*i;}
      const slope = (n*sxy-sx*sy)/(n*sx2-sx*sx);
      if (slope > 0.8) rsiTrend = "rising";
      else if (slope < -0.8) rsiTrend = "falling";
    }

    // Overbought/oversold metadata — shifted thresholds for momentum continuation
    if (last.rsi > 75) rS = "overbought";
    else if (last.rsi < 25) rS = "oversold";

    // Late for PUTS: RSI already deeply oversold (shifted from 30→25)
    if (last.rsi < 25 && trend < 0) {
      latePenalty += 2;
      F.push({ text: `⚠ LATE: RSI ${last.rsi.toFixed(1)} already oversold (<25) — bounce risk, move mostly done`, bull: true, cat: "late" });
      if (last.rsi < 20) {
        latePenalty += 1;
        rsiRecovery = "capitulating";
        F.push({ text: `⚠ RSI ${last.rsi.toFixed(1)} EXTREME oversold (<20) — very high bounce risk`, bull: true, cat: "late" });
      }
    }
    // Late for CALLS: RSI already overbought (shifted from 70→75)
    if (last.rsi > 75 && trend > 0) {
      latePenalty += 2;
      F.push({ text: `⚠ LATE: RSI ${last.rsi.toFixed(1)} already overbought (>75) — pullback risk, move mostly done`, bull: false, cat: "late" });
      if (last.rsi > 80) {
        latePenalty += 1;
        F.push({ text: `⚠ RSI ${last.rsi.toFixed(1)} EXTREME overbought (>80) — very high pullback risk`, bull: false, cat: "late" });
      }
    }

    // RSI grinding oversold/overbought for extended period
    const rsiLong = data.slice(-15).map(d => d.rsi).filter(v => v != null);
    if (rsiLong.length >= 10) {
      const belowCount = rsiLong.filter(r => r < 35).length;
      const aboveCount = rsiLong.filter(r => r > 65).length;
      if (belowCount >= 8 && trend < 0) {
        latePenalty += 1;
        F.push({ text: `⚠ LATE: RSI below 35 for ${belowCount}/15 bars — selling exhausted`, bull: true, cat: "late" });
      }
      if (aboveCount >= 8 && trend > 0) {
        latePenalty += 1;
        F.push({ text: `⚠ LATE: RSI above 65 for ${aboveCount}/15 bars — buying exhausted`, bull: false, cat: "late" });
      }
    }
  }

  // Price extended from SMA 20 (more than 2 ATR away)
  if (last.slowSMA && a > 0) {
    const distFromSMA = (last.close - last.slowSMA) / a;
    if (distFromSMA > 2 && trend > 0) {
      latePenalty += 1;
      F.push({ text: `⚠ LATE: Price ${distFromSMA.toFixed(1)} ATR above SMA 20 — overextended`, bull: false, cat: "late" });
    }
    if (distFromSMA < -2 && trend < 0) {
      latePenalty += 1;
      F.push({ text: `⚠ LATE: Price ${Math.abs(distFromSMA).toFixed(1)} ATR below SMA 20 — overextended`, bull: true, cat: "late" });
    }
  }

  // Late penalty pushes score toward zero (reduces conviction)
  const sc = trend + entry + confirm + (latePenalty * (trend > 0 ? -1 : 1));

  return { score: Math.round(sc * 10) / 10, trend: Math.round(trend * 10) / 10, entry: Math.round(entry * 10) / 10, confirm: Math.round(confirm * 10) / 10, latePenalty, factors: F, rsiBBSignal: rBB, rsiSignal: rS, rsiTrend, rsiBBWidth, rsiRecovery, vwapSignal: vS, atr: a, macdHist: mH, volume: vol };
}

// ─── 5 TARGETS with gap levels ───
function compute5Targets(direction, price, dData, hData, dSR, hSR, dATR, hATR, gapCtx, patterns) {
  const dL = dData[dData.length - 1], hL = hData[hData.length - 1];
  const cands = [];

  if (direction === "CALLS") {
    hSR.resistance.forEach(r => { if (r.avg > price * 1.002) cands.push({ price: r.avg, label: `Hourly resistance (${r.touches}x)`, source: "sr", strength: r.touches }); });
    dSR.resistance.forEach(r => { if (r.avg > price * 1.002) cands.push({ price: r.avg, label: `Daily resistance (${r.touches}x)`, source: "sr", strength: r.touches + 1 }); });
    if (dL.fastSMA && dL.fastSMA > price * 1.002) cands.push({ price: dL.fastSMA, label: "Daily SMA 10", source: "sma", strength: 2.5 });
    if (dL.slowSMA && dL.slowSMA > price * 1.002) cands.push({ price: dL.slowSMA, label: "Daily SMA 20", source: "sma", strength: 3 });
    if (dL.extraSMA && dL.extraSMA > price * 1.002) cands.push({ price: dL.extraSMA, label: "Daily SMA 50", source: "sma", strength: 3.5 });
    if (dL.sma200 && dL.sma200 > price * 1.002) cands.push({ price: dL.sma200, label: "Daily SMA 200", source: "sma", strength: 4 });
    if (hL.vwap && hL.vwap > price * 1.002) cands.push({ price: hL.vwap, label: "VWAP", source: "vwap", strength: 2 });
    if (hL.vwapUpperBand && hL.vwapUpperBand > price * 1.002) cands.push({ price: hL.vwapUpperBand, label: "VWAP Upper Band — bands can expand", source: "vwap_band", strength: 1 });
    // Gap levels as targets
    if (gapCtx?.activeGapFill?.type === "GAP UP") {
      cands.push({ price: gapCtx.activeGapFill.gapTop, label: `Gap top (${gapCtx.activeGapFill.date}) — bounce target back to gap origin`, source: "gap", strength: 3 });
    }
    gapCtx?.unfilled?.forEach(g => { if (g.type === "GAP DOWN" && g.gapTop > price * 1.002) cands.push({ price: g.gapTop, label: `Unfilled gap down top (${g.date}) — magnet`, source: "gap", strength: 2.5 }); });
    // Pattern targets (neckline breakout, measured moves)
    if (patterns) for (const p of patterns) {
      if (p.neckline && p.target && p.bias === "Bullish reversal") {
        if (p.neckline > price * 1.002) cands.push({ price: p.neckline, label: `${p.touches}x bottom neckline — breakout level`, source: "pattern", strength: 3.5 });
        if (p.target > price * 1.002) cands.push({ price: p.target, label: `${p.touches}x bottom measured move target`, source: "pattern", strength: 2 });
      }
    }
    cands.push({ price: price + dATR, label: "+1x daily ATR", source: "atr", strength: 0.3 });
    const swH = Math.max(...dData.slice(-20).map(d => d.high));
    const swL = Math.min(...dData.slice(-20).map(d => d.low));
    if (swH > price * 1.002) cands.push({ price: swH, label: "20-day swing high", source: "swing", strength: 3 });
    // Fib extensions from recent swing low→high as filler targets
    const fibRange = swH - swL;
    if (fibRange > 0) {
      const fibLevels = [
        { r: 1.272, l: "Fib 127.2% ext" }, { r: 1.618, l: "Fib 161.8% ext" }, { r: 2.0, l: "Fib 200% ext" }
      ];
      fibLevels.forEach(f => {
        const fp = swL + fibRange * f.r;
        if (fp > price * 1.002) cands.push({ price: fp, label: f.l, source: "fib", strength: 0.8 });
      });
    }
    cands.sort((a, b) => a.price - b.price);
  } else if (direction === "PUTS") {
    hSR.support.forEach(s => { if (s.avg < price * 0.998) cands.push({ price: s.avg, label: `Hourly support (${s.touches}x)`, source: "sr", strength: s.touches }); });
    dSR.support.forEach(s => { if (s.avg < price * 0.998) cands.push({ price: s.avg, label: `Daily support (${s.touches}x)`, source: "sr", strength: s.touches + 1 }); });
    if (dL.fastSMA && dL.fastSMA < price * 0.998) cands.push({ price: dL.fastSMA, label: "Daily SMA 10", source: "sma", strength: 2.5 });
    if (dL.slowSMA && dL.slowSMA < price * 0.998) cands.push({ price: dL.slowSMA, label: "Daily SMA 20", source: "sma", strength: 3 });
    if (dL.extraSMA && dL.extraSMA < price * 0.998) cands.push({ price: dL.extraSMA, label: "Daily SMA 50", source: "sma", strength: 3.5 });
    if (dL.sma200 && dL.sma200 < price * 0.998) cands.push({ price: dL.sma200, label: "Daily SMA 200", source: "sma", strength: 4 });
    if (hL.vwap && hL.vwap < price * 0.998) cands.push({ price: hL.vwap, label: "VWAP", source: "vwap", strength: 2 });
    if (hL.vwapLowerBand && hL.vwapLowerBand < price * 0.998) cands.push({ price: hL.vwapLowerBand, label: "VWAP Lower Band — bands can expand", source: "vwap_band", strength: 1 });
    // Gap fill targets
    if (gapCtx?.activeGapFill?.type === "GAP UP") {
      cands.push({ price: gapCtx.activeGapFill.gapBottom, label: `Gap bottom (${gapCtx.activeGapFill.prevDate}) — full gap fill target`, source: "gap", strength: 4 });
    }
    gapCtx?.unfilled?.forEach(g => { if (g.type === "GAP UP" && g.gapBottom < price * 0.998) cands.push({ price: g.gapBottom, label: `Unfilled gap up bottom (${g.prevDate}) — fill magnet`, source: "gap", strength: 3.5 }); });
    // Pattern targets (neckline breakdown, measured moves)
    if (patterns) for (const p of patterns) {
      if (p.neckline && p.target && p.bias === "Bearish reversal") {
        if (p.neckline < price * 0.998) cands.push({ price: p.neckline, label: `${p.touches}x top neckline — breakdown level`, source: "pattern", strength: 3.5 });
        if (p.target < price * 0.998) cands.push({ price: p.target, label: `${p.touches}x top measured move target`, source: "pattern", strength: 2 });
      }
    }
    cands.push({ price: price - dATR, label: "-1x daily ATR", source: "atr", strength: 0.3 });
    const swH = Math.max(...dData.slice(-20).map(d => d.high));
    const swL = Math.min(...dData.slice(-20).map(d => d.low));
    if (swL < price * 0.998) cands.push({ price: swL, label: "20-day swing low", source: "swing", strength: 3 });
    // Fib retracements from recent swing low→high as filler targets
    const fibRange = swH - swL;
    if (fibRange > 0) {
      const fibLevels = [
        { r: 0.382, l: "Fib 38.2% retrace" }, { r: 0.5, l: "Fib 50% retrace" }, { r: 0.618, l: "Fib 61.8% retrace" }, { r: 0.786, l: "Fib 78.6% retrace" }
      ];
      fibLevels.forEach(f => {
        const fp = swH - fibRange * f.r;
        if (fp < price * 0.998) cands.push({ price: fp, label: f.l, source: "fib", strength: 0.8 });
      });
    }
    cands.sort((a, b) => b.price - a.price);
  }
  if (!cands.length) return [];
  const deduped = [];
  for (const c of cands) { const dup = deduped.find(d => Math.abs(d.price - c.price) / c.price < 0.005); if (dup) { if (c.strength > dup.strength) { dup.label = c.label; dup.source = c.source; dup.strength = c.strength; } dup.label += " ★confluent"; } else deduped.push({ ...c }); }
  const noVB = deduped.filter(d => d.source !== "vwap_band"), vB = deduped.filter(d => d.source === "vwap_band");
  let final = [];
  if (noVB.length > 0) { final.push(noVB[0]); const rest = [...noVB.slice(1), ...vB]; if (direction === "CALLS") rest.sort((a, b) => a.price - b.price); else rest.sort((a, b) => b.price - a.price); for (const r of rest) { if (final.length >= 5) break; if (!final.find(f => Math.abs(f.price - r.price) / r.price < 0.005)) final.push(r); } } else final = deduped.slice(0, 5);
  // Guarantee 5 targets — pad with ATR increments if needed
  let padIdx = 1;
  while (final.length < 5) {
    const lastP = final.length > 0 ? final[final.length - 1].price : price;
    const step = dATR * (0.5 + padIdx * 0.4);
    const padPrice = direction === "CALLS" ? lastP + step : lastP - step;
    if (padPrice > 0 && !final.find(f => Math.abs(f.price - padPrice) / padPrice < 0.005)) {
      final.push({ price: padPrice, label: `+${(padIdx * 0.5 + 0.5).toFixed(1)}x ATR projection`, source: "atr", strength: 0.2 });
    }
    padIdx++;
    if (padIdx > 10) break; // safety
  }
  // Final sort: CALLS must be ascending (T1 < T2 < T3...), PUTS must be descending (T1 > T2 > T3...)
  if (direction === "CALLS") final.sort((a, b) => a.price - b.price);
  else if (direction === "PUTS") final.sort((a, b) => b.price - a.price);
  // ── NEW: ATR-based reachability for weekly options ──
  // T1: within 1.5x ATR = high, T2: within 2x = medium, T3+: within 3x = low, beyond = aspirational
  return final.slice(0, 5).map((t, i) => {
    const dist = Math.abs(t.price - price);
    const atrMultiple = dATR > 0 ? dist / dATR : 0;
    let reachability = "aspirational";
    if (atrMultiple <= 1.5) reachability = "high";
    else if (atrMultiple <= 2.5) reachability = "medium";
    else if (atrMultiple <= 3.5) reachability = "low";
    return { ...t, num: i + 1, pct: ((t.price - price) / price * 100).toFixed(1), atrDist: Math.round(atrMultiple * 10) / 10, reachability };
  });
}

// ─── REVERSAL DETECTION ───
// When daily and hourly conflict, determine if hourly is leading a genuine reversal
function detectReversal(dData, hData, daily, hourly, dSR) {
  if (dData.length < 20 || hData.length < 10) return null;
  const dL = dData[dData.length - 1], hL = hData[hData.length - 1];
  const price = hL.close;
  const hDir = hourly.score >= 1.5 ? "CALLS" : hourly.score <= -1.5 ? "PUTS" : "NEUTRAL";
  if (hDir === "NEUTRAL") return null;

  let signals = [], score = 0;
  const reversalDir = hDir; // hourly is proposing this direction

  // ── 1. DAILY RSI DIVERGENCE ──
  // Bullish: price making lower lows but RSI making higher lows (last 15 bars)
  // Bearish: price making higher highs but RSI making lower highs
  if (dData.length >= 15) {
    const recent = dData.slice(-15);
    const rsiVals = recent.filter(d => d.rsi != null);
    if (rsiVals.length >= 10) {
      const firstHalf = rsiVals.slice(0, Math.floor(rsiVals.length / 2));
      const secondHalf = rsiVals.slice(Math.floor(rsiVals.length / 2));
      const fhLowPrice = Math.min(...firstHalf.map(d => d.low));
      const shLowPrice = Math.min(...secondHalf.map(d => d.low));
      const fhLowRSI = Math.min(...firstHalf.map(d => d.rsi));
      const shLowRSI = Math.min(...secondHalf.map(d => d.rsi));
      const fhHighPrice = Math.max(...firstHalf.map(d => d.high));
      const shHighPrice = Math.max(...secondHalf.map(d => d.high));
      const fhHighRSI = Math.max(...firstHalf.map(d => d.rsi));
      const shHighRSI = Math.max(...secondHalf.map(d => d.rsi));

      if (reversalDir === "CALLS" && shLowPrice < fhLowPrice && shLowRSI > fhLowRSI + 2) {
        score += 3; signals.push({ text: "Daily RSI bullish divergence — price lower lows, RSI higher lows", weight: 3, bull: true });
      }
      if (reversalDir === "PUTS" && shHighPrice > fhHighPrice && shHighRSI < fhHighRSI - 2) {
        score += 3; signals.push({ text: "Daily RSI bearish divergence — price higher highs, RSI lower highs", weight: 3, bull: false });
      }
    }
  }

  // ── 2. DAILY MACD MOMENTUM FADING ──
  // Histogram shrinking = trend losing steam
  const macd = computeMACD(dData);
  const hist = macd.histogram;
  if (hist.length >= 5) {
    const recent5 = hist.slice(-5);
    const prior5 = hist.slice(-10, -5);
    if (prior5.length >= 3) {
      const recentAvg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
      const priorAvg = prior5.reduce((a, b) => a + b, 0) / prior5.length;
      if (reversalDir === "CALLS" && priorAvg < 0 && recentAvg < 0 && recentAvg > priorAvg) {
        score += 2; signals.push({ text: `Daily MACD momentum fading (histogram: ${priorAvg.toFixed(3)} → ${recentAvg.toFixed(3)})`, weight: 2, bull: true });
      }
      if (reversalDir === "PUTS" && priorAvg > 0 && recentAvg > 0 && recentAvg < priorAvg) {
        score += 2; signals.push({ text: `Daily MACD momentum fading (histogram: ${priorAvg.toFixed(3)} → ${recentAvg.toFixed(3)})`, weight: 2, bull: false });
      }
    }
  }

  // ── 3. HOURLY VOLUME CONFIRMATION ──
  if (hourly.volume?.hasVolume) {
    const vol = hourly.volume;
    if (reversalDir === "CALLS" && vol.confirmation === "bullish") {
      score += 2; signals.push({ text: `Hourly volume confirms reversal (up bars heavier, RelVol ${vol.relVol}x)`, weight: 2, bull: true });
    } else if (reversalDir === "PUTS" && vol.confirmation === "bearish") {
      score += 2; signals.push({ text: `Hourly volume confirms reversal (down bars heavier, RelVol ${vol.relVol}x)`, weight: 2, bull: false });
    }
    if (vol.trend === "expanding" && vol.relVol > 1.3) {
      score += 1; signals.push({ text: `Hourly volume expanding on reversal (${vol.relVol}x avg)`, weight: 1, bull: reversalDir === "CALLS" });
    }
  }

  // ── 4. HOURLY RECLAIMING SMAs ──
  if (reversalDir === "CALLS") {
    let reclaimed = 0;
    if (hL.fastSMA && hL.close > hL.fastSMA) reclaimed++;
    if (hL.slowSMA && hL.close > hL.slowSMA) reclaimed++;
    if (hL.extraSMA && hL.close > hL.extraSMA) reclaimed++;
    if (reclaimed >= 2) {
      score += 2; signals.push({ text: `Hourly reclaimed ${reclaimed} SMAs — structure turning bullish`, weight: 2, bull: true });
    }
  } else {
    let lost = 0;
    if (hL.fastSMA && hL.close < hL.fastSMA) lost++;
    if (hL.slowSMA && hL.close < hL.slowSMA) lost++;
    if (hL.extraSMA && hL.close < hL.extraSMA) lost++;
    if (lost >= 2) {
      score += 2; signals.push({ text: `Hourly lost ${lost} SMAs — structure turning bearish`, weight: 2, bull: false });
    }
  }

  // ── 5. PRICE AT KEY DAILY S/R ──
  if (reversalDir === "CALLS" && dSR.support.length > 0) {
    const nearSupport = dSR.support.find(s => Math.abs(s.avg - price) / price < 0.015);
    if (nearSupport) {
      score += 2; signals.push({ text: `Price at daily support $${nearSupport.avg.toFixed(2)} (${nearSupport.touches}x tested)`, weight: 2, bull: true });
    }
  }
  if (reversalDir === "PUTS" && dSR.resistance.length > 0) {
    const nearResistance = dSR.resistance.find(r => Math.abs(r.avg - price) / price < 0.015);
    if (nearResistance) {
      score += 2; signals.push({ text: `Price at daily resistance $${nearResistance.avg.toFixed(2)} (${nearResistance.touches}x tested)`, weight: 2, bull: false });
    }
  }

  // ── 6. HOURLY RSI RECOVERY FROM EXTREME ──
  if (reversalDir === "CALLS" && hL.rsi != null && hL.rsi > 40 && hL.rsi < 55) {
    // Check if RSI was recently oversold (last 5 bars)
    const recentHRSI = hData.slice(-5).filter(d => d.rsi != null);
    if (recentHRSI.some(d => d.rsi < 30)) {
      score += 1.5; signals.push({ text: `Hourly RSI recovering from oversold (was <30, now ${hL.rsi.toFixed(1)})`, weight: 1.5, bull: true });
    }
  }
  if (reversalDir === "PUTS" && hL.rsi != null && hL.rsi < 60 && hL.rsi > 45) {
    const recentHRSI = hData.slice(-5).filter(d => d.rsi != null);
    if (recentHRSI.some(d => d.rsi > 70)) {
      score += 1.5; signals.push({ text: `Hourly RSI dropping from overbought (was >70, now ${hL.rsi.toFixed(1)})`, weight: 1.5, bull: false });
    }
  }

  // ── VERDICT ──
  // Lowered threshold: score >= 4 with 2+ signals, OR score >= 3 with a single high-weight signal (weight >= 3)
  // This catches early reversals before the daily confirms — critical for 1-2 week option entries
  const hasHighWeightSignal = signals.some(s => s.weight >= 3);
  if ((signals.length >= 2 && score >= 4) || (hasHighWeightSignal && score >= 3)) {
    return {
      isReversal: true,
      direction: reversalDir,
      score: Math.round(score * 10) / 10,
      signals,
      confidence: score >= 9 ? "High" : score >= 7 ? "Medium-High" : score >= 5 ? "Medium" : "Medium-Low",
      explanation: `🔄 REVERSAL DETECTED — Hourly leading daily\n\n${signals.length} reversal signals (score ${score.toFixed(1)}/13):\n${signals.map(s => `• ${s.text}`).join("\n")}\n\nThe hourly timeframe is showing early signs of a ${reversalDir === "CALLS" ? "bullish" : "bearish"} reversal while the daily is still ${reversalDir === "CALLS" ? "bearish" : "bullish"}. This is how trend changes begin — the shorter timeframe leads.`
    };
  }

  return { isReversal: false, direction: reversalDir, score: Math.round(score * 10) / 10, signals, explanation: `Conflict appears to be noise, not reversal (score ${score.toFixed(1)}/13, need ≥5 with 2+ signals).` };
}

// ─── CORE PLAN ───
function computePlan(dData, hData, dSR, hSR, earningsDate, regime) {
  const dL = dData[dData.length - 1], hL = hData[hData.length - 1], price = hL.close;
  const daily = scoreTF(dData, false), hourly = scoreTF(hData, true);
  const dATR = daily.atr || 1, hATR = hourly.atr || 0.5;

  // Pattern detection for grade adjustment
  const dPat = detectPatterns(dData, "Daily");
  let patternAdj = 0, patternNote = "";
  for (const p of dPat) {
    if (!p.status) continue; // Only timing-aware patterns have status

    const isTriple = p.name.includes("Triple");
    const isTop = p.name.includes("Top");
    const isBot = p.name.includes("Bottom");
    const confirmed = p.status === "BREAKDOWN CONFIRMED" || p.status === "BREAKOUT CONFIRMED";
    const forming = p.status.includes("FORMING") || p.status.includes("TESTING");
    const retest = p.status === "NECKLINE RETEST";

    if (isTop) {
      if (confirmed) { patternAdj -= (isTriple ? 3 : 2.5); }
      else if (forming) { patternAdj -= (isTriple ? 2 : 1.5); }
      else if (retest) { patternAdj -= (isTriple ? 2.5 : 2); }
      else { patternAdj -= (isTriple ? 1.5 : 1); }
      patternNote = `${p.name.split("—")[0].trim()}: ${p.status}. ${p.detail}`;
    }
    if (isBot) {
      if (confirmed) { patternAdj += (isTriple ? 3 : 2.5); }
      else if (forming) { patternAdj += (isTriple ? 2 : 1.5); }
      else if (retest) { patternAdj += (isTriple ? 2.5 : 2); }
      else { patternAdj += (isTriple ? 1.5 : 1); }
      patternNote = `${p.name.split("—")[0].trim()}: ${p.status}. ${p.detail}`;
    }
  }

  // Gap detection on daily
  const gaps = detectGaps(dData, 0.004);
  const gapCtx = analyzeGapContext(gaps, price, dData);

  // Apply gap + pattern adjustment to daily score
  const adjDailyScore = daily.score + gapCtx.gapFillAdj + patternAdj;

  let dDir = adjDailyScore >= 1.5 ? "CALLS" : adjDailyScore <= -1.5 ? "PUTS" : "NEUTRAL";
  let hDir = hourly.score >= 1.5 ? "CALLS" : hourly.score <= -1.5 ? "PUTS" : "NEUTRAL";

  let direction, bias, alignment, reversalInfo = null;
  if (dDir === "CALLS" && hDir === "CALLS") { direction = "CALLS"; bias = "Strong Bullish"; alignment = "ALIGNED — Both bullish."; }
  else if (dDir === "PUTS" && hDir === "PUTS") { direction = "PUTS"; bias = "Strong Bearish"; alignment = "ALIGNED — Both bearish."; }
  else if (dDir === "CALLS" && hDir === "NEUTRAL") { direction = "CALLS"; bias = "Lean Bullish"; alignment = "DAILY BULLISH, HOURLY NEUTRAL."; }
  else if (dDir === "PUTS" && hDir === "NEUTRAL") { direction = "PUTS"; bias = "Lean Bearish"; alignment = "DAILY BEARISH, HOURLY NEUTRAL."; }
  else if ((dDir === "CALLS" && hDir === "PUTS") || (dDir === "PUTS" && hDir === "CALLS")) {
    // ═══ CONFLICT — CHECK FOR REVERSAL ═══
    reversalInfo = detectReversal(dData, hData, daily, hourly, dSR);
    if (reversalInfo?.isReversal) {
      direction = reversalInfo.direction;
      bias = `Reversal ${reversalInfo.direction === "CALLS" ? "Bullish" : "Bearish"}`;
      alignment = `🔄 REVERSAL — Daily ${dDir}, hourly ${hDir}. Hourly leading with ${reversalInfo.signals.length} reversal signals (score ${reversalInfo.score}).`;
    } else {
      direction = "WAIT"; bias = "Conflicting";
      alignment = `⚠ Daily ${dDir}, hourly ${hDir}. ${reversalInfo?.explanation || "No reversal signals."}`;
    }
  }
  else if (dDir === "NEUTRAL" && hDir !== "NEUTRAL") { direction = hDir; bias = `Weak ${hDir === "CALLS" ? "Bullish" : "Bearish"}`; alignment = `DAILY NEUTRAL, HOURLY ${hDir}.`; }
  else { direction = "WAIT"; bias = "Neutral"; alignment = "Both neutral."; }

  // Gap context annotation
  if (gapCtx.activeGapFill) {
    const g = gapCtx.activeGapFill;
    alignment += ` | GAP FILL ACTIVE: ${g.type} from ${g.prevDate}→${g.date} ($${g.gapBottom.toFixed(2)}-$${g.gapTop.toFixed(2)})`;
  }

  // ══════════════════════════════════════════════════════
  // GRADE: 3-Category System — Trend + Entry + Confirmation
  // Grade 9-10 requires strong entry quality, not just trend alignment
  // ══════════════════════════════════════════════════════
  const dTrend = Math.abs(daily.trend), dEntry = Math.abs(daily.entry), dConfirm = Math.abs(daily.confirm);
  const hTrend = Math.abs(hourly.trend), hEntry = Math.abs(hourly.entry), hConfirm = Math.abs(hourly.confirm);
  const dLate = daily.latePenalty, hLate = hourly.latePenalty;

  // Weighted composite per category
  // Trend: daily leads (60/40) — daily sets the directional context
  // Entry & Confirm: hourly leads (40/60) — for 1-2 week options, hourly timing is critical
  const trendScore = dTrend * 0.6 + hTrend * 0.4; // max ~3
  const entryScore = dEntry * 0.4 + hEntry * 0.6;  // max ~5 — hourly leads for entry timing
  const confirmScore = dConfirm * 0.4 + hConfirm * 0.6; // max ~3 — hourly momentum matters more
  const latePenalty = Math.max(dLate, hLate); // Use worst late penalty

  // Alignment bonus (both timeframes agree on direction)
  const isReversal = reversalInfo?.isReversal;
  const alignBonus = (dDir === hDir && dDir !== "NEUTRAL") ? 1
    : isReversal ? 0.5
    : (dDir !== "NEUTRAL" && hDir === "NEUTRAL") ? 0.25
    : 0;

  // Raw grade = Trend (max 3) + Entry (max 5) + Confirm (max 3) + Align (max 1) - Late penalty
  const rawGrade = trendScore + entryScore + confirmScore + alignBonus - latePenalty;

  let grade;
  if (direction === "WAIT") {
    grade = Math.min(3, Math.round(rawGrade * 0.5 + 1));
  } else {
    // ── REVISED grade mapping — wider spread at the top ──
    // Grade 10 is now genuinely rare (rawGrade 11+), grade 9 requires rawGrade 9+
    // This prevents "pretty good" setups from scoring the same as exceptional ones
    // rawGrade 0-2→grade 1-3, 2-4→4-5, 4-6→6-7, 6-9→7-8, 9-11→9, 11+→10
    if (rawGrade <= 2) grade = Math.max(1, Math.round(rawGrade + 1));
    else if (rawGrade <= 4) grade = Math.round(2 + rawGrade);
    else if (rawGrade <= 6) grade = Math.round(4 + rawGrade * 0.5);
    else if (rawGrade <= 9) grade = Math.round(5 + rawGrade * 0.3);
    else if (rawGrade <= 11) grade = 9;
    else grade = 10;
    grade = Math.min(10, Math.max(1, grade));

    // Hard gate: Entry score < 1 caps grade at 6 (trend alone isn't enough)
    if (entryScore < 1 && grade > 6) grade = 6;
    // Entry score < 0.5 caps at 5
    if (entryScore < 0.5 && grade > 5) grade = 5;
  }

  // ═══ SAFEGUARD 1: OVERSOLD/OVERBOUGHT SNAP-BACK WARNING ═══
  const dRSI = dL.rsi, hRSI = hL.rsi;
  let extremeWarning = null;
  if (dRSI != null && hRSI != null) {
    // Check 52-week low (approximate: lowest low in daily data)
    const allTimeLow = Math.min(...dData.map(d => d.low));
    const allTimeHigh = Math.max(...dData.map(d => d.high));
    const nearLow = price <= allTimeLow * 1.03;
    const nearHigh = price >= allTimeHigh * 0.97;

    if (dRSI < 28 && hRSI < 28 && direction === "PUTS") {
      const penalty = nearLow ? -3 : -2;
      grade = Math.max(1, grade + penalty);
      extremeWarning = {
        type: "oversold_bounce",
        severity: nearLow ? "critical" : "high",
        text: nearLow
          ? `⚠️ EXTREME OVERSOLD AT DATA LOWS — SNAP-BACK RISK\n\nDaily RSI ${dRSI.toFixed(1)} + Hourly RSI ${hRSI.toFixed(1)} — both deeply oversold.\nPrice ($${price.toFixed(2)}) is within 3% of the data low ($${allTimeLow.toFixed(2)}).\n\nThis is the WORST time to enter puts. Any positive catalyst (earnings beat, upgrade, partnership) can trigger a violent short squeeze. Grade penalized by ${Math.abs(penalty)}.`
          : `⚠️ BOTH TIMEFRAMES OVERSOLD — BOUNCE RISK\n\nDaily RSI ${dRSI.toFixed(1)} + Hourly RSI ${hRSI.toFixed(1)} — both deeply oversold.\nEven in strong downtrends, mean-reversion bounces are common at these RSI levels. Chasing puts here has poor risk/reward. Grade penalized by ${Math.abs(penalty)}.`,
        gradeAdj: penalty
      };
    } else if (dRSI > 72 && hRSI > 72 && direction === "CALLS") {
      const penalty = nearHigh ? -3 : -2;
      grade = Math.max(1, grade + penalty);
      extremeWarning = {
        type: "overbought_reversal",
        severity: nearHigh ? "critical" : "high",
        text: nearHigh
          ? `⚠️ EXTREME OVERBOUGHT AT DATA HIGHS — REVERSAL RISK\n\nDaily RSI ${dRSI.toFixed(1)} + Hourly RSI ${hRSI.toFixed(1)} — both overbought.\nPrice ($${price.toFixed(2)}) is within 3% of the data high ($${allTimeHigh.toFixed(2)}).\n\nThis is the WORST time to enter calls. Any negative catalyst can trigger sharp selling. Grade penalized by ${Math.abs(penalty)}.`
          : `⚠️ BOTH TIMEFRAMES OVERBOUGHT — PULLBACK RISK\n\nDaily RSI ${dRSI.toFixed(1)} + Hourly RSI ${hRSI.toFixed(1)} — both overbought.\nChasing calls at these levels has poor risk/reward. Grade penalized by ${Math.abs(penalty)}.`,
        gradeAdj: penalty
      };
    }
  }

  // ═══ SAFEGUARD 2: EARNINGS PROXIMITY (info only — no grade change) ═══
  let earningsAdj = null;
  if (earningsDate && direction !== "WAIT") {
    const earningsParsed = new Date(earningsDate.replace(/just reported/i, "").trim());
    if (!isNaN(earningsParsed.getTime())) {
      const now = new Date();
      const daysUntil = Math.round((earningsParsed - now) / (1000 * 60 * 60 * 24));
      if (daysUntil >= 0 && daysUntil <= 5) {
        earningsAdj = { daysUntil, effect: "warning", text: `📅 EARNINGS IN ${daysUntil} DAY${daysUntil !== 1 ? "S" : ""} — BINARY EVENT\n\nEarnings on ${earningsDate}. IV crush + unknown outcome. Be aware of the event risk.`, gradeAdj: 0 };
      } else if (daysUntil > 5 && daysUntil <= 21) {
        if (direction === "CALLS") {
          earningsAdj = { daysUntil, effect: "tailwind", text: `📅 EARNINGS IN ${daysUntil} DAYS — POTENTIAL TAILWIND\n\nEarnings on ${earningsDate}. Stocks tend to get bought 1-3 weeks before earnings. This is a potential tailwind for calls.`, gradeAdj: 0 };
        } else if (direction === "PUTS") {
          earningsAdj = { daysUntil, effect: "headwind", text: `📅 EARNINGS IN ${daysUntil} DAYS — POTENTIAL HEADWIND\n\nEarnings on ${earningsDate}. Stocks tend to get bought 1-3 weeks before earnings. This buying pressure may work against puts.`, gradeAdj: 0 };
        }
      } else if (daysUntil > 21) {
        earningsAdj = { daysUntil, effect: "neutral", text: `📅 Earnings on ${earningsDate} (${daysUntil} days away). No immediate impact.`, gradeAdj: 0 };
      }
    }
  }

  // ═══ SAFEGUARD 3: RSI EXTREME GRADE CAP ═══
  let rsiCap = null;
  if (direction !== "WAIT" && dRSI != null) {
    if ((dRSI < 25 && direction === "PUTS") || (dRSI > 80 && direction === "CALLS")) {
      const cappedFrom = grade;
      if (grade > 7) {
        grade = 7;
        rsiCap = {
          text: `⛔ GRADE CAPPED AT 7 (was ${cappedFrom}) — Daily RSI ${dRSI.toFixed(1)} is ${dRSI < 25 ? "below 25" : "above 80"}.\nChasing ${direction.toLowerCase()} at RSI extremes has historically poor risk/reward. The easy money in this direction has already been made.`,
          cappedFrom
        };
      }
    }
  }

  // ═══ SAFEGUARD 4: MARKET REGIME ═══
  // Market regime scoring DISABLED — grades based on pure chart technicals only
  let regimeAdj = null;

  // ═══ SAFEGUARD 5: RSI DIVERGENCE vs DIRECTION ═══
  // If RSI divergence opposes the trade direction, penalize the grade
  // Both TF opposing = -2, Daily only = -1.5, Hourly only = -1
  // Hidden divergence = half penalty of regular/developing
  const dDiv = detectDivergence(dData, 30);
  const hDiv = detectDivergence(hData, 60);
  const cDiv = combinedDivergence(dDiv, hDiv);
  let divAdj = null;
  if (direction !== "WAIT") {
    const dOpp = (direction === "PUTS" && dDiv.type === "bullish") || (direction === "CALLS" && dDiv.type === "bearish");
    const hOpp = (direction === "PUTS" && hDiv.type === "bullish") || (direction === "CALLS" && hDiv.type === "bearish");
    const dBld = dDiv.label.startsWith("BLD");
    const hBld = hDiv.label.startsWith("BLD");
    // RSI MA contradicts = weaker divergence, halve penalty
    const dWeak = dDiv.weakened;
    const hWeak = hDiv.weakened;

    if (dOpp && hOpp) {
      let pen = (dBld && hBld) ? -1 : (dBld || hBld) ? -1.5 : -2;
      if (dWeak && hWeak) pen = pen * 0.25; // both contradicted by RSI MA = barely matters
      else if (dWeak || hWeak) pen = pen * 0.5; // one contradicted = half penalty
      pen = Math.round(pen * 2) / 2; // round to nearest 0.5
      grade = Math.max(1, grade + pen);
      divAdj = { gradeAdj: pen, text: `⚠️ BOTH TF DIVERGENCE vs ${direction}\n\nHourly: ${hDiv.label} — ${hDiv.detail}\nDaily: ${dDiv.label} — ${dDiv.detail}\n\nBoth timeframes show RSI divergence opposing ${direction.toLowerCase()}.${(dWeak || hWeak) ? " (weakened — RSI MA not fully confirming)" : ""} Grade ${pen}.` };
    } else if (dOpp) {
      let pen = dBld ? -1 : -1.5;
      if (dWeak) pen = pen * 0.5;
      pen = Math.round(pen * 2) / 2;
      grade = Math.max(1, grade + pen);
      divAdj = { gradeAdj: pen, text: `⚠️ DAILY DIVERGENCE vs ${direction}\n\n${dDiv.label} — ${dDiv.detail}\n\nDaily RSI divergence opposes ${direction.toLowerCase()}.${dWeak ? " (RSI MA not confirming — weaker signal)" : ""} Grade ${pen}.` };
    } else if (hOpp) {
      let pen = hBld ? -0.5 : -1;
      if (hWeak) pen = pen * 0.5;
      pen = Math.round(pen * 2) / 2;
      grade = Math.max(1, grade + pen);
      divAdj = { gradeAdj: pen, text: `⚠️ HOURLY DIVERGENCE vs ${direction}\n\n${hDiv.label} — ${hDiv.detail}\n\nHourly RSI divergence opposes ${direction.toLowerCase()}.${hWeak ? " (RSI MA not confirming — weaker signal)" : ""} Grade ${pen}.` };
    }
  }

  // Re-clamp grade
  grade = Math.min(10, Math.max(1, Math.round(grade)));

  let confidence = grade >= 8 ? "High" : grade >= 6 ? "Medium-High" : grade >= 4 ? "Medium" : "Low";
  if (gapCtx.activeGapFill) confidence += ` | Gap fill ${gapCtx.activeGapFill.type === "GAP UP" && direction === "PUTS" ? "supports puts — fill not complete" : gapCtx.activeGapFill.type === "GAP UP" && direction === "CALLS" ? "may resist calls — gap still pulling down" : "in play"}`;
  if (extremeWarning) confidence += ` | ${extremeWarning.severity === "critical" ? "🚨" : "⚠️"} ${extremeWarning.type === "oversold_bounce" ? "Oversold snap-back risk" : "Overbought reversal risk"}`;
  if (earningsAdj) confidence += ` | 📅 Earnings ${earningsAdj.daysUntil}d`;
  if (rsiCap) confidence += ` | ⛔ Grade capped from ${rsiCap.cappedFrom}`;
  if (divAdj) confidence += ` | ⚠️ Divergence vs ${direction} (${divAdj.gradeAdj})`;

  const targets = compute5Targets(direction, price, dData, hData, dSR, hSR, dATR, hATR, gapCtx, dPat);

  // Entry/Stop
  const hasVWAP = hL.vwap != null; const vwap = hL.vwap, vwapUB = hL.vwapUpperBand, vwapLB = hL.vwapLowerBand;
  const hNS = hSR.support.sort((a, b) => b.avg - a.avg).find(s => s.avg < price);
  const hNR = hSR.resistance.sort((a, b) => a.avg - b.avg).find(r => r.avg > price);
  let entry = {}, stop = {}, actionNow = "", entryDetail = "";

  if (direction === "CALLS") {
    const atLB = hasVWAP && vwapLB && Math.abs(price - vwapLB) / price < 0.008;
    const gapBounce = gapCtx.activeGapFill?.type === "GAP UP" && price <= gapCtx.activeGapFill.gapBottom * 1.005;
    if (gapBounce) { entry.price = price.toFixed(2); actionNow = "YES — GAP FILL COMPLETE"; entryDetail = `ENTER CALLS at $${price.toFixed(2)}.\n\nGap fill from ${gapCtx.activeGapFill.prevDate}→${gapCtx.activeGapFill.date} is COMPLETE. Price has reached gap bottom ($${gapCtx.activeGapFill.gapBottom.toFixed(2)}). Bounce expected — the magnet is exhausted.`; }
    else if (hourly.vwapSignal === "lower-band" || atLB) { entry.price = price.toFixed(2); actionNow = "YES — ENTER NOW"; entryDetail = `At VWAP Lower Band ($${vwapLB?.toFixed(2)}).`; }
    else if (hourly.rsiBBSignal === "lower-band-touch") { entry.price = price.toFixed(2); actionNow = "YES — ENTER NOW"; entryDetail = `Hourly RSI at Lower BB — oversold.`; }
    else {
      const strongBullish = hourly.score >= 3 || (hourly.score >= 1.5 && adjDailyScore >= 1.5);
      if (strongBullish) {
        entry.price = price.toFixed(2); actionNow = "YES — ENTER NOW";
        entryDetail = `Strong bullish alignment. Enter CALLS at current price $${price.toFixed(2)}.`;
      } else {
        const smallDip = price - hATR * 0.3;
        const nearSup = hNS && hNS.avg > price - hATR * 1.5 ? hNS.avg : null;
        const nearVwap = hasVWAP && vwap < price && vwap > price - hATR * 1.5 ? vwap : null;
        const ie = nearVwap || nearSup || smallDip;
        entry.price = ie.toFixed(2); actionNow = "WAIT";
        entryDetail = `Wait for dip to $${ie.toFixed(2)} for better entry${nearVwap ? " (VWAP)" : nearSup ? " (near support)" : ""}, or enter at $${price.toFixed(2)} if buying continues.`;
      }
    }
    const sp = hasVWAP && vwapLB ? Math.min(vwapLB - hATR * 0.3, price - dATR * 1.5) : price - dATR * 1.5;
    stop = { price: sp.toFixed(2), explanation: `Stop $${sp.toFixed(2)}` };
  } else if (direction === "PUTS") {
    const atUB = hasVWAP && vwapUB && Math.abs(price - vwapUB) / price < 0.008;
    const midGapFill = gapCtx.activeGapFill?.type === "GAP UP" && parseFloat(gapCtx.activeGapFill.partialFill || "0") < 80;
    if (midGapFill) { entry.price = price.toFixed(2); actionNow = "YES — GAP FILL IN PROGRESS"; entryDetail = `ENTER PUTS at $${price.toFixed(2)}.\n\nGap fill in progress: ${gapCtx.activeGapFill.type} from ${gapCtx.activeGapFill.prevDate}→${gapCtx.activeGapFill.date}. Gap bottom target: $${gapCtx.activeGapFill.gapBottom.toFixed(2)}. Gaps tend to fill completely.`; }
    else if (hourly.vwapSignal === "upper-band" || atUB) { entry.price = price.toFixed(2); actionNow = "YES — ENTER NOW"; entryDetail = `At VWAP Upper Band ($${vwapUB?.toFixed(2)}).`; }
    else if (hourly.rsiBBSignal === "upper-band-touch") { entry.price = price.toFixed(2); actionNow = "YES — ENTER NOW"; entryDetail = `Hourly RSI at Upper BB — overbought.`; }
    else {
      // For puts: enter near current price or on a small bounce, not at distant resistance
      // If score is strongly bearish, enter now. If moderate, allow a small bounce entry.
      const strongBearish = hourly.score <= -3 || (hourly.score <= -1.5 && adjDailyScore <= -1.5);
      if (strongBearish) {
        entry.price = price.toFixed(2); actionNow = "YES — ENTER NOW";
        entryDetail = `Strong bearish alignment. Enter PUTS at current price $${price.toFixed(2)}.`;
      } else {
        // Allow a small bounce (0.3-0.5x hourly ATR) for better entry, not distant resistance
        const smallBounce = price + hATR * 0.3;
        const nearRes = hNR && hNR.avg < price + hATR * 1.5 ? hNR.avg : null;
        const nearVwap = hasVWAP && vwap > price && vwap < price + hATR * 1.5 ? vwap : null;
        const ie = nearVwap || nearRes || smallBounce;
        entry.price = ie.toFixed(2); actionNow = "WAIT";
        entryDetail = `Wait for small bounce to $${ie.toFixed(2)} for better entry${nearVwap ? " (VWAP)" : nearRes ? " (near resistance)" : ""}, or enter at $${price.toFixed(2)} if selling continues.`;
      }
    }
    const sp = hasVWAP && vwapUB ? Math.max(vwapUB + hATR * 0.3, price + dATR * 1.5) : price + dATR * 1.5;
    stop = { price: Math.min(sp, price + dATR * 2).toFixed(2), explanation: `Stop $${Math.min(sp, price + dATR * 2).toFixed(2)}` };
  } else {
    entry = { price: "—" }; stop = { price: "—", explanation: "No trade." }; actionNow = "NO TRADE"; entryDetail = `${alignment}`;
  }

  let rsiExp = "", vwapExp = "";
  if (hL.rsi != null && hL.rsiUpperBB != null) { rsiExp = `HOURLY RSI ${hL.rsi.toFixed(1)} | Median ${hL.rsiMA?.toFixed(1)} | BB: ${hL.rsiLowerBB.toFixed(1)}-${hL.rsiUpperBB.toFixed(1)}`; if (dL.rsi != null) rsiExp += `\nDAILY RSI ${dL.rsi.toFixed(1)}`; }
  if (hasVWAP) vwapExp = `VWAP $${vwap.toFixed(2)}${vwapUB ? ` | +2σ $${vwapUB.toFixed(2)}` : ""}${vwapLB ? ` | -2σ $${vwapLB.toFixed(2)}` : ""}\nPrice ${price > vwap ? "ABOVE" : "BELOW"} VWAP`;

  // ── TREND / RANGE ──
  const trendRange = analyzeTrendRange(dData, hData);

  // ── SUMMARY ──
  // 1. Gaps: only unfilled OR >$25
  const relevantGaps = gaps.filter(g => !g.filled || g.gapSize >= 25);
  const gapBullets = [];
  // Active gap fill gets top priority
  if (gapCtx.activeGapFill) {
    const g = gapCtx.activeGapFill;
    gapBullets.push(`• Active gap fill: ${g.type} from ${g.date} ($${g.gapBottom.toFixed(2)}-$${g.gapTop.toFixed(2)}, $${g.gapSize.toFixed(2)}). Current price is inside this gap.`);
  }
  // Unfilled gaps nearby
  const unfilledNearby = relevantGaps.filter(g => !g.filled && g !== gapCtx.activeGapFill).sort((a, b) => Math.abs(price - (a.gapTop + a.gapBottom) / 2) - Math.abs(price - (b.gapTop + b.gapBottom) / 2));
  for (const g of unfilledNearby) { if (gapBullets.length >= 3) break; gapBullets.push(`• Unfilled ${g.type} from ${g.date}: $${g.gapBottom.toFixed(2)}-$${g.gapTop.toFixed(2)} ($${g.gapSize.toFixed(2)}) — ${g.partialFill}% partially filled`); }
  // Fill with large filled gaps (>$25) if room
  const bigFilled = relevantGaps.filter(g => g.filled && g.gapSize >= 25);
  for (const g of bigFilled) { if (gapBullets.length >= 3) break; gapBullets.push(`• Large ${g.type} from ${g.date}: $${g.gapBottom.toFixed(2)}-$${g.gapTop.toFixed(2)} ($${g.gapSize.toFixed(2)}) — filled on ${g.fillDate}`); }
  const gapSummary = gapBullets.length ? gapBullets.join("\n") : "No unfilled or significant (>$25) gaps detected.";

  // 2. Direction + top 3 targets
  const top3 = targets.slice(0, 3);
  const dirSummary = direction === "WAIT" ? "No trade recommended — conflicting signals." : `${direction} recommended. Take profit targets: ${top3.map((t, i) => `T${i + 1}: $${t.price.toFixed(2)} (${t.pct}%)`).join(", ")}.`;

  // 3. Key S/R based on direction
  let keySR = "";
  if (direction === "CALLS") {
    const sups = [...dSR.support, ...hSR.support].filter(s => s.avg < price).sort((a, b) => b.avg - a.avg).slice(0, 2);
    keySR = sups.length ? `Key support to watch: ${sups.map(s => `$${s.avg.toFixed(2)} (${s.touches}x)`).join(", ")}. If these break, exit calls.` : "No major support levels identified below price.";
  } else if (direction === "PUTS") {
    const ress = [...dSR.resistance, ...hSR.resistance].filter(r => r.avg > price).sort((a, b) => a.avg - b.avg).slice(0, 2);
    keySR = ress.length ? `Key resistance to watch: ${ress.map(r => `$${r.avg.toFixed(2)} (${r.touches}x)`).join(", ")}. If price reclaims these, exit puts.` : "No major resistance levels identified above price.";
  } else { keySR = "No trade = no key levels to focus on."; }

  // 4. Trend/Range
  const trendSummary = `${trendRange.mode}: ${trendRange.detail}${trendRange.breakout ? `\n${trendRange.breakout}` : ""}\n${trendRange.longCtx}`;

  const summary = { gapSummary, dirSummary, keySR, trendSummary, trendRange };

  return { direction, bias, alignment, grade, confidence, actionNow, entry, stop, entryDetail, targets, gapCtx, summary,
    extremeWarning, earningsAdj, rsiCap, regimeAdj, divAdj, dDiv, hDiv, cDiv, reversalInfo, patternAdj: patternAdj !== 0 ? { adj: patternAdj, note: patternNote } : null,
    categories: { trend: Math.round(trendScore * 10) / 10, entry: Math.round(entryScore * 10) / 10, confirm: Math.round(confirmScore * 10) / 10, late: latePenalty, align: alignBonus, raw: Math.round(rawGrade * 10) / 10 },
    daily: { ...daily, score: adjDailyScore, origScore: daily.score, rsi: dL.rsi?.toFixed(1), fastSMA: dL.fastSMA?.toFixed(2), slowSMA: dL.slowSMA?.toFixed(2), extraSMA: dL.extraSMA?.toFixed(2), sma200: dL.sma200?.toFixed(2), atr: dATR.toFixed(2), dir: dDir },
    hourly: { ...hourly, rsi: hL.rsi?.toFixed(1), fastSMA: hL.fastSMA?.toFixed(2), atr: hATR.toFixed(2), dir: hDir, vwap: vwap?.toFixed(2), vwapUB: vwapUB?.toFixed(2), vwapLB: vwapLB?.toFixed(2) },
    rsiExp, vwapExp, price: price.toFixed(2) };
}

// ─── CSV ───
function parseCSV(text) {
  const parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true }); if (!parsed.data?.length) return null;
  const f = (...n) => { for (const x of n) { const r = Object.keys(parsed.data[0]).find(c => c.toLowerCase().trim().includes(x.toLowerCase())); if (r) return r; } return null; };
  // Exact match helper — matches full column name exactly (case-insensitive, trimmed)
  const fe = (...n) => { for (const x of n) { const r = Object.keys(parsed.data[0]).find(c => c.trim().toLowerCase() === x.toLowerCase()); if (r) return r; } return null; };
  const dc = f("time", "date"), oc = f("open"), hc = f("high"), lc = f("low"), cc = f("close"), vc = f("volume");
  // SMA: support both old named format ("Fast SMA") and new generic format ("MA 1"=10, "MA 2"=20, "MA 3"=50, "MA 4"=200)
  const fs = f("fast sma", "fastsma", "sma10") || fe("ma 1");
  const ss = f("slow sma", "slowsma", "sma20") || fe("ma 2");
  const es = f("extra sma", "extrasma", "sma50") || fe("ma 3");
  const s2 = f("200 sma", "200sma", "sma200") || fe("ma 4");
  // RSI: exact match first to avoid collisions, then fuzzy
  const rc = fe("rsi") || f("rsi");
  const rm = f("rsi-based ma", "rsima", "rsi ma", "rsi-based");
  // RSI Bollinger Bands: must match "bollinger" to avoid colliding with VWAP "Upper Band #2"
  const ru = f("upper bollinger", "upperbb", "upper bb");
  const rl = f("lower bollinger", "lowerbb", "lower bb");
  // VWAP bands: match "band #2" or "vwap" variants — only if not already matched as RSI BB
  const vw = fe("vwap") || f("vwap");
  const vu = f("upper band #2", "upper vwap", "vwap upper") || (!ru ? f("upper band") : null);
  const vl = f("lower band #2", "lower vwap", "vwap lower") || (!rl ? f("lower band") : null);
  if (!cc) return null;
  const cols = { fastSMACol: fs, slowSMACol: ss, sma200Col: s2, extraSMACol: es, rsiCol: rc, rsiMACol: rm, rsiUpperBBCol: ru, rsiLowerBBCol: rl, vwapCol: vw, vwapUpperCol: vu, vwapLowerCol: vl };
  const records = parsed.data.map(row => ({ date: dc ? unixToPST(row[dc]) : "", open: parseFloat(row[oc]) || 0, high: parseFloat(row[hc]) || 0, low: parseFloat(row[lc]) || 0, close: parseFloat(row[cc]) || 0, volume: vc ? parseFloat(row[vc]) || 0 : 0, fastSMA: fs ? parseFloat(row[fs]) || null : null, slowSMA: ss ? parseFloat(row[ss]) || null : null, sma200: s2 ? parseFloat(row[s2]) || null : null, extraSMA: es ? parseFloat(row[es]) || null : null, rsi: rc ? parseFloat(row[rc]) || null : null, rsiMA: rm ? parseFloat(row[rm]) || null : null, rsiUpperBB: ru ? parseFloat(row[ru]) || null : null, rsiLowerBB: rl ? parseFloat(row[rl]) || null : null, vwap: vw ? parseFloat(row[vw]) || null : null, vwapUpperBand: vu ? parseFloat(row[vu]) || null : null, vwapLowerBand: vl ? parseFloat(row[vl]) || null : null })).filter(d => !isNaN(d.close) && d.close > 0);
  return { records, cols };
}

// ─── Charts ───
function PriceChart({ data, label, showVWAP, gaps }) {
  if (!data || data.length < 2) return null;
  const W = 600, H = 150, P = 22, all = [...data.map(d => d.high), ...data.map(d => d.low)], mn = Math.min(...all), mx = Math.max(...all), rng = mx - mn || 1;
  const xc = i => P + (i / (data.length - 1)) * (W - 2 * P), yc = v => H - P - ((v - mn) / rng) * (H - 2 * P);
  const cl = data.map((d, i) => `${xc(i)},${yc(d.close)}`).join(" "), up = data[data.length - 1].close >= data[0].close, mc = up ? "#00e676" : "#ff1744";
  const sl = (k, c) => { const pts = data.map((d, i) => d[k] != null ? `${xc(i)},${yc(d[k])}` : null).filter(Boolean); return pts.length > 2 ? <polyline key={k} fill="none" stroke={c} strokeWidth="1" strokeDasharray="3,3" opacity="0.5" points={pts.join(" ")} /> : null; };
  const vf = () => { if (!showVWAP) return null; const u = [], l = []; data.forEach((d, i) => { if (d.vwapUpperBand != null && d.vwapLowerBand != null) { u.push(`${xc(i)},${yc(d.vwapUpperBand)}`); l.push(`${xc(i)},${yc(d.vwapLowerBand)}`); } }); return u.length > 1 ? <polygon fill="#f59e0b" opacity="0.05" points={[...u, ...l.reverse()].join(" ")} /> : null; };
  const vl2 = (k, c, d, w) => { const pts = data.map((dd, i) => dd[k] != null ? `${xc(i)},${yc(dd[k])}` : null).filter(Boolean); return pts.length > 2 ? <polyline key={k + "v"} fill="none" stroke={c} strokeWidth={w || "1"} strokeDasharray={d || "none"} opacity="0.6" points={pts.join(" ")} /> : null; };
  // Gap zones
  const gapRects = (gaps || []).filter(g => !g.filled && g.gapBottom >= mn && g.gapTop <= mx).map((g, i) => {
    const x1 = xc(Math.max(0, g.index - 1)), x2 = W - P;
    return <rect key={"gap" + i} x={x1} y={yc(g.gapTop)} width={x2 - x1} height={Math.abs(yc(g.gapBottom) - yc(g.gapTop))} fill={g.type === "GAP UP" ? "#00e676" : "#ff1744"} opacity="0.08" />;
  });
  return (<div><div style={{ fontSize: 9, fontWeight: 700, color: "#64748b", letterSpacing: 1, textTransform: "uppercase" }}>{label}</div>
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 150 }}>
      <defs><linearGradient id={`g${label}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={mc} stopOpacity="0.15" /><stop offset="100%" stopColor={mc} stopOpacity="0" /></linearGradient></defs>
      {gapRects}{vf()}{sl("sma200", "#ff6d00")}{sl("extraSMA", "#7c3aed")}{sl("slowSMA", "#00b0ff")}{sl("fastSMA", "#ffd600")}
      {showVWAP && vl2("vwapUpperBand", "#f59e0b", "4,3")}{showVWAP && vl2("vwapLowerBand", "#f59e0b", "4,3")}{showVWAP && vl2("vwap", "#f59e0b", "none", "1.5")}
      <polyline fill="none" stroke={mc} strokeWidth="1.5" points={cl} /><polygon fill={`url(#g${label})`} points={`${P},${H - P} ${cl} ${W - P},${H - P}`} />
      <text x={P} y={12} fill="#6b7280" fontSize="9" fontFamily="monospace">{mx.toFixed(2)}</text><text x={P} y={H - 2} fill="#6b7280" fontSize="9" fontFamily="monospace">{mn.toFixed(2)}</text>
    </svg></div>);
}
function RSIChart({ data }) {
  if (!data || data.length < 2 || data[0].rsi == null) return null;
  const W = 600, H = 70, P = 22, xc = i => P + (i / (data.length - 1)) * (W - 2 * P), yc = v => H - P - (v / 100) * (H - 2 * P);
  const mk = (k, c, d) => { const pts = data.map((dd, i) => dd[k] != null ? `${xc(i)},${yc(dd[k])}` : null).filter(Boolean); return pts.length > 2 ? <polyline fill="none" stroke={c} strokeWidth={k === "rsi" ? "1.5" : "1"} strokeDasharray={d || "none"} opacity={k === "rsi" ? 1 : 0.4} points={pts.join(" ")} /> : null; };
  const bf = () => { const u = [], l = []; data.forEach((d, i) => { if (d.rsiUpperBB != null && d.rsiLowerBB != null) { u.push(`${xc(i)},${yc(d.rsiUpperBB)}`); l.push(`${xc(i)},${yc(d.rsiLowerBB)}`); } }); return u.length > 1 ? <polygon fill="#7c3aed" opacity="0.06" points={[...u, ...l.reverse()].join(" ")} /> : null; };
  const last = data[data.length - 1];
  return <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 70 }}>{bf()}{mk("rsiUpperBB", "#7c3aed", "3,3")}{mk("rsiLowerBB", "#7c3aed", "3,3")}{mk("rsiMA", "#ffd600", "2,2")}{mk("rsi", "#00b0ff")}{last.rsi != null && <circle cx={xc(data.length - 1)} cy={yc(last.rsi)} r="2.5" fill="#00b0ff" />}</svg>;
}

// ─── BATCH FILENAME PARSER ───
// Parses "NYSE_MA, 1D.csv" → { ticker: "MA", timeframe: "daily" }
// Parses "NASDAQ_AAPL, 60.csv" → { ticker: "AAPL", timeframe: "hourly" }
function parseBatchFilename(name) {
  const clean = name.replace(/\.csv$/i, "").trim();
  const underIdx = clean.indexOf("_");
  if (underIdx < 0) return null;
  const afterExchange = clean.slice(underIdx + 1); // "MA, 1D" or "AAPL, 60"
  const commaIdx = afterExchange.indexOf(",");
  if (commaIdx < 0) return null;
  const ticker = afterExchange.slice(0, commaIdx).trim().toUpperCase();
  const tf = afterExchange.slice(commaIdx + 1).trim().toUpperCase();
  let timeframe = null;
  if (tf === "1D" || tf === "D" || tf === "1W" || tf === "W") timeframe = "daily";
  else if (tf === "60" || tf === "1H" || tf === "240" || tf === "4H") timeframe = "hourly";
  if (!ticker || !timeframe) return null;
  return { ticker, timeframe };
}

// ─── RSI DIVERGENCE DETECTION (simplified: BULL DIV, BEAR DIV, BLD BULL, BLD BEAR, or —) ───
function detectDivergence(data, lookback) {
  if (!data || data.length < 10) return { type: "none", label: "—", detail: "" };
  const recent = data.slice(-Math.min(lookback, data.length));
  const w = recent.filter(d => d.rsi != null && d.close > 0);
  if (w.length < 6) return { type: "none", label: "—", detail: "" };

  // Find swing pivots with 2-bar left, 1-bar right
  const lows = [], highs = [];
  for (let i = 2; i < w.length - 1; i++) {
    if (w[i].low <= w[i-1].low && w[i].low <= w[i-2].low && w[i].low <= w[i+1].low)
      lows.push({ idx: i, price: w[i].low, rsi: w[i].rsi });
    if (w[i].high >= w[i-1].high && w[i].high >= w[i-2].high && w[i].high >= w[i+1].high)
      highs.push({ idx: i, price: w[i].high, rsi: w[i].rsi });
  }
  const last = w[w.length - 1];
  let bull = null, bear = null;

  // ── STALENESS & FAILURE CHECK ──
  const isStale = (pivotIdx, pivotPrice, type) => {
    const recencyThreshold = Math.floor(w.length * 0.4);
    if (pivotIdx < recencyThreshold) return true;
    if (type === "bear" && last.close < pivotPrice * 0.97) return true;
    if (type === "bull" && last.close > pivotPrice * 1.03) return true;
    if (type === "bull" && last.close < pivotPrice * 0.97) return true;
    if (type === "bear" && last.close > pivotPrice * 1.03) return true;
    return false;
  };

  // ── BULL DIV: price lower low, RSI higher low ──
  for (let i = lows.length - 1; i >= 1 && !bull; i--) {
    const c = lows[i], p = lows[i-1];
    if (c.idx - p.idx < 3) continue;
    if (c.price < p.price * 0.998 && c.rsi > p.rsi + 1.5 && !isStale(c.idx, c.price, "bull")) {
      // INVALIDATION: check if any later swing low (or last bar) has BOTH lower price AND lower RSI
      // That means price and RSI dropped together past the divergence — pattern broken
      let invalidated = false;
      for (let j = i + 1; j < lows.length; j++) {
        if (lows[j].price < c.price && lows[j].rsi < c.rsi - 1) { invalidated = true; break; }
      }
      if (!invalidated && last.low < c.price * 0.995 && last.rsi < c.rsi - 1) invalidated = true;
      if (!invalidated)
        bull = { sub: "regular", d: `Price $${p.price.toFixed(2)}→$${c.price.toFixed(2)} (lower low), RSI ${p.rsi.toFixed(0)}→${c.rsi.toFixed(0)} (higher low)` };
    }
  }

  // ── BEAR DIV: price higher high, RSI lower high ──
  for (let i = highs.length - 1; i >= 1 && !bear; i--) {
    const c = highs[i], p = highs[i-1];
    if (c.idx - p.idx < 3) continue;
    if (c.price > p.price * 1.002 && c.rsi < p.rsi - 1.5 && !isStale(c.idx, c.price, "bear")) {
      // INVALIDATION: check if any later swing high has BOTH higher price AND higher RSI
      let invalidated = false;
      for (let j = i + 1; j < highs.length; j++) {
        if (highs[j].price > c.price && highs[j].rsi > c.rsi + 1) { invalidated = true; break; }
      }
      if (!invalidated && last.high > c.price * 1.005 && last.rsi > c.rsi + 1) invalidated = true;
      if (!invalidated)
        bear = { sub: "regular", d: `Price $${p.price.toFixed(2)}→$${c.price.toFixed(2)} (higher high), RSI ${p.rsi.toFixed(0)}→${c.rsi.toFixed(0)} (lower high)` };
    }
  }

  // ── BLD BULL / BLD BEAR: 2+ confirmation points of RSI diverging from price ──
  if (w.length >= 10) {
    if (!bull) {
      const recentLows = lows.filter(l => l.idx > w.length * 0.3);
      let confirmations = 0, lastConfirm = null, firstConfirm = null;
      for (let i = 1; i < recentLows.length; i++) {
        const p = recentLows[i-1], c = recentLows[i];
        if (c.idx - p.idx < 2) continue;
        if (c.rsi > p.rsi + 1 && c.price <= p.price * 1.005) {
          if (!firstConfirm) firstConfirm = p;
          lastConfirm = c;
          confirmations++;
        }
      }
      if (recentLows.length >= 1) {
        const lastLow = recentLows[recentLows.length - 1];
        if (last.rsi > lastLow.rsi + 1 && last.low <= lastLow.price * 1.01 && w.length - 1 - lastLow.idx >= 2) {
          if (!firstConfirm) firstConfirm = lastLow;
          lastConfirm = { idx: w.length - 1, price: last.low, rsi: last.rsi };
          confirmations++;
        }
      }
      if (confirmations >= 2 && firstConfirm && lastConfirm) {
        if (last.close >= lastConfirm.price * 0.97) {
          const priceFromLow = (last.close - Math.min(...w.slice(-Math.floor(w.length * 0.6)).map(d => d.low))) / Math.min(...w.slice(-Math.floor(w.length * 0.6)).map(d => d.low));
          if (priceFromLow < 0.05)
            bull = { sub: "building", d: `${confirmations} confirms: RSI lows rising ${firstConfirm.rsi.toFixed(0)}→${lastConfirm.rsi.toFixed(0)} while price lows flat/lower $${firstConfirm.price.toFixed(2)}→$${lastConfirm.price.toFixed(2)}` };
        }
      }
    }
    if (!bear) {
      const recentHighs = highs.filter(h => h.idx > w.length * 0.3);
      let confirmations = 0, lastConfirm = null, firstConfirm = null;
      for (let i = 1; i < recentHighs.length; i++) {
        const p = recentHighs[i-1], c = recentHighs[i];
        if (c.idx - p.idx < 2) continue;
        if (c.rsi < p.rsi - 1 && c.price >= p.price * 0.995) {
          if (!firstConfirm) firstConfirm = p;
          lastConfirm = c;
          confirmations++;
        }
      }
      if (recentHighs.length >= 1) {
        const lastHigh = recentHighs[recentHighs.length - 1];
        if (last.rsi < lastHigh.rsi - 1 && last.high >= lastHigh.price * 0.99 && w.length - 1 - lastHigh.idx >= 2) {
          if (!firstConfirm) firstConfirm = lastHigh;
          lastConfirm = { idx: w.length - 1, price: last.high, rsi: last.rsi };
          confirmations++;
        }
      }
      if (confirmations >= 2 && firstConfirm && lastConfirm) {
        if (last.close <= lastConfirm.price * 1.03) {
          const priceFromHigh = (Math.max(...w.slice(-Math.floor(w.length * 0.6)).map(d => d.high)) - last.close) / last.close;
          if (priceFromHigh < 0.05)
            bear = { sub: "building", d: `${confirmations} confirms: RSI highs falling ${firstConfirm.rsi.toFixed(0)}→${lastConfirm.rsi.toFixed(0)} while price highs flat/higher $${firstConfirm.price.toFixed(2)}→$${lastConfirm.price.toFixed(2)}` };
        }
      }
    }
  }

  // ── RSI vs RSI MA CONFLUENCE ──
  // 1. Position: RSI above or below RSI MA
  // 2. Crossover: RSI just crossed above/below RSI MA (last 3 bars)
  // 3. Bounce: RSI approached RSI MA from above, held, went back up (bullish support)
  // 4. Rejection: RSI approached RSI MA from below, failed, went back down (bearish resistance)
  const tail = w.slice(-6);
  const hasMa = tail.every(d => d.rsiMA != null);
  let rsiMaSignal = "neutral"; // "bull_cross", "bear_cross", "bull_bounce", "bear_reject", "above", "below", "neutral"
  let rsiMaNote = "";

  if (hasMa && tail.length >= 4) {
    const curr = tail[tail.length - 1], prev1 = tail[tail.length - 2], prev2 = tail[tail.length - 3], prev3 = tail[tail.length - 4];
    const aboveNow = curr.rsi > curr.rsiMA;
    const abovePrev1 = prev1.rsi > prev1.rsiMA;
    const abovePrev2 = prev2.rsi > prev2.rsiMA;
    const abovePrev3 = prev3.rsi > prev3.rsiMA;
    const gap = curr.rsi - curr.rsiMA;

    // Crossover: RSI broke above RSI MA within last 2 bars
    if (aboveNow && (!abovePrev1 || !abovePrev2) && !abovePrev3) { rsiMaSignal = "bull_cross"; rsiMaNote = `✓ RSI crossed ABOVE RSI MA (${curr.rsi.toFixed(0)} > ${curr.rsiMA.toFixed(0)}) — bullish crossover`; }
    // Crossover: RSI broke below RSI MA within last 2 bars
    else if (!aboveNow && (abovePrev1 || abovePrev2) && abovePrev3) { rsiMaSignal = "bear_cross"; rsiMaNote = `⚠ RSI crossed BELOW RSI MA (${curr.rsi.toFixed(0)} < ${curr.rsiMA.toFixed(0)}) — bearish crossover`; }
    // Bounce: RSI was above MA, dipped toward it (within 2pts), then pushed back up
    else if (aboveNow && abovePrev2 && Math.abs(prev1.rsi - prev1.rsiMA) < 2.5 && curr.rsi > prev1.rsi + 1) { rsiMaSignal = "bull_bounce"; rsiMaNote = `✓ RSI bounced off RSI MA support (touched ${prev1.rsi.toFixed(0)} near MA ${prev1.rsiMA.toFixed(0)}, now ${curr.rsi.toFixed(0)}) — MA holding as support`; }
    // Rejection: RSI was below MA, pushed up toward it (within 2pts), then fell back
    else if (!aboveNow && !abovePrev2 && Math.abs(prev1.rsi - prev1.rsiMA) < 2.5 && curr.rsi < prev1.rsi - 1) { rsiMaSignal = "bear_reject"; rsiMaNote = `⚠ RSI rejected at RSI MA resistance (touched ${prev1.rsi.toFixed(0)} near MA ${prev1.rsiMA.toFixed(0)}, now ${curr.rsi.toFixed(0)}) — MA acting as ceiling`; }
    // Sustained position
    else if (aboveNow && abovePrev1 && abovePrev2) { rsiMaSignal = "above"; rsiMaNote = `RSI above MA (${curr.rsi.toFixed(0)} > ${curr.rsiMA.toFixed(0)}) — bullish momentum`; }
    else if (!aboveNow && !abovePrev1 && !abovePrev2) { rsiMaSignal = "below"; rsiMaNote = `RSI below MA (${curr.rsi.toFixed(0)} < ${curr.rsiMA.toFixed(0)}) — bearish momentum`; }
    else { rsiMaNote = `RSI ${curr.rsi.toFixed(0)} vs MA ${curr.rsiMA.toFixed(0)} — choppy`; }
  }

  // Determine if RSI MA confirms or contradicts each divergence
  const bullishMa = ["bull_cross", "bull_bounce", "above"].includes(rsiMaSignal);
  const bearishMa = ["bear_cross", "bear_reject", "below"].includes(rsiMaSignal);

  const addConfluence = (result, isBull) => {
    if (!result) return result;
    const confirms = isBull ? bullishMa : bearishMa;
    const contradicts = isBull ? bearishMa : bullishMa;
    return { ...result, d: result.d + ` | ${rsiMaNote}`, confluence: confirms ? "confirmed" : contradicts ? "contradicted" : "neutral" };
  };

  if (bull) bull = addConfluence(bull, true);
  if (bear) bear = addConfluence(bear, false);

  // Contradicted = weakened, less grade impact
  if (bull && bull.confluence === "contradicted") bull.weakened = true;
  if (bear && bear.confluence === "contradicted") bear.weakened = true;

  if (bull && bear) return { type: "mixed", label: "MIXED", detail: `Bull: ${bull.d} | Bear: ${bear.d}` };
  if (bull) return { type: "bullish", label: bull.sub === "building" ? "BLD BULL" : "BULL DIV", detail: bull.d, weakened: bull.weakened };
  if (bear) return { type: "bearish", label: bear.sub === "building" ? "BLD BEAR" : "BEAR DIV", detail: bear.d, weakened: bear.weakened };
  return { type: "none", label: "—", detail: "" };
}

function combinedDivergence(daily, hourly) {
  const d = daily.type, h = hourly.type;
  // Both none
  if (d === "none" && h === "none") return { label: "—", color: "#64748b", detail: "No divergence on either timeframe" };
  // Both aligned
  if (d === "bullish" && h === "bullish") return { label: "BOTH BULL", color: "#00e676", detail: "Both daily & hourly show bullish divergence — strong reversal signal UP" };
  if (d === "bearish" && h === "bearish") return { label: "BOTH BEAR", color: "#ff1744", detail: "Both daily & hourly show bearish divergence — strong reversal signal DOWN" };
  // Conflicting
  if (d === "bullish" && h === "bearish") return { label: "CONFLICT", color: "#f59e0b", detail: "Daily bullish but hourly bearish — trend transition, daily bottoming while hourly still selling" };
  if (d === "bearish" && h === "bullish") return { label: "CONFLICT", color: "#f59e0b", detail: "Daily bearish but hourly bullish — hourly bounce within daily topping pattern" };
  // One only — clearly label which timeframe
  if (d === "bullish" && h === "none") return { label: "DAILY ONLY", color: "#66bb6a", detail: "Daily bullish divergence — hourly not confirming yet" };
  if (d === "bearish" && h === "none") return { label: "DAILY ONLY", color: "#ff9800", detail: "Daily bearish divergence — hourly not confirming yet" };
  if (d === "none" && h === "bullish") return { label: "HRLY ONLY", color: "#66bb6a", detail: "Hourly bullish divergence — may lead daily if it holds" };
  if (d === "none" && h === "bearish") return { label: "HRLY ONLY", color: "#ff9800", detail: "Hourly bearish divergence — early warning, watch if daily follows" };
  // Mixed within a timeframe
  if (d === "mixed" || h === "mixed") return { label: "MIXED", color: "#ffd600", detail: "Mixed signals — conflicting divergences within a timeframe" };
  return { label: "—", color: "#64748b", detail: "" };
}

// ─── App ───
export default function App() {
  const [ticker, setTicker] = useState(""), [dD, setDD] = useState(null), [hD, setHD] = useState(null), [dC, setDC] = useState(null), [hC, setHC] = useState(null);
  const [an, setAn] = useState(null), [ai, setAI] = useState(""), [aiL, setAIL] = useState(false), [err, setErr] = useState(""), [tab, setTab] = useState("trade");
  const [scans, setScans] = useState({}); // { AAPL: { ticker, grade, direction, price, targets }, ... }
  const [batchMode, setBatchMode] = useState(false);
  const [batchLog, setBatchLog] = useState([]); // status messages
  const [batchPending, setBatchPending] = useState({}); // { MA: { daily: records, hourly: null }, ... }
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchAIResults, setBatchAIResults] = useState({}); // { AAPL: "ai text", ... }
  const [batchAILoading, setBatchAILoading] = useState(false);
  const [batchAIProgress, setBatchAIProgress] = useState("");
  const [earningsDates, setEarningsDates] = useState({}); // { AAPL: "Mar 5", ... }
  const [earningsLoading, setEarningsLoading] = useState(false);
  const [regimeData, setRegimeData] = useState({}); // { SPY: {...}, QQQ: {...}, IWM: {...} }
  // ── History view (Supabase) ──
  const [viewMode, setViewMode] = useState("analysis"); // "analysis" | "history"
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
  // ── Sort & Filter for scans table ──
  const [sortCol, setSortCol] = useState("grade"); // "grade" | "dir" | "combined"
  const [sortAsc, setSortAsc] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [compareCsvText, setCompareCsvText] = useState("");
  const [filterDir, setFilterDir] = useState("ALL"); // ALL | PUTS | CALLS | WAIT
  const [filterGrade, setFilterGrade] = useState("ALL"); // ALL | 7+ | 6+ | 5+ | <=4
  const [filterCombined, setFilterCombined] = useState("ALL"); // ALL | BOTH BULL | BOTH BEAR | CONFLICT | HRLY ONLY | DAILY ONLY | MIXED | —
  // ── Previous Day Comparison ──
  const [compareMode, setCompareMode] = useState(false);
  const [compareCsv, setCompareCsv] = useState(null); // parsed rows from downloaded CSV
  const [compareTodayData, setCompareTodayData] = useState({}); // { AAPL: { open, close, high, low }, ... }
  const [compareResults, setCompareResults] = useState(null); // final comparison results
  const [compareLog, setCompareLog] = useState([]);
  const compareCSVRef = useRef();
  const compareBatchRef = useRef();
  const dR = useRef(), hR = useRef(), batchR = useRef();
  const rawDataRef = useRef({}); // { AAPL: { daily: records, hourly: records }, ... }

  // One-time cleanup: delete any leftover persistent storage from old versions
  useEffect(() => {
    (async () => {
      try {
        const keys = await window.storage.list("scans:");
        if (keys?.keys?.length) {
          for (const k of keys.keys) { try { await window.storage.delete(k); } catch {} }
        }
      } catch {}
    })();
  }, []);

  // No persistent storage — scans rebuild on each batch run

  // Auto-save scan when analysis completes with a ticker
  const saveScan = useCallback(async (tkr, tradeResult, dailyData, hourlyData) => {
    if (!tkr || !tradeResult) return;
    const scan = {
      ticker: tkr,
      grade: tradeResult.grade,
      direction: tradeResult.direction,
      bias: tradeResult.bias,
      isReversal: tradeResult.reversalInfo?.isReversal || false,
      price: tradeResult.price,
      t1: tradeResult.targets[0]?.price?.toFixed(2) || "—",
      t2: tradeResult.targets[1]?.price?.toFixed(2) || "—",
      t3: tradeResult.targets[2]?.price?.toFixed(2) || "—",
      t4: tradeResult.targets[3]?.price?.toFixed(2) || "—",
      t5: tradeResult.targets[4]?.price?.toFixed(2) || "—",
      timestamp: new Date().toISOString(),
      hDiv: tradeResult.hDiv, dDiv: tradeResult.dDiv, cDiv: tradeResult.cDiv, divAdj: tradeResult.divAdj,
    };
    setScans(prev => ({ ...prev, [tkr]: scan }));
    saveResultToSupabase(scan);
    return scan;
  }, []);

  const run = useCallback((d, h, overrideTicker) => {
    if (!d || !h) return;
    const tkr = overrideTicker || ticker;
    const result = { trade: computePlan(d, h, findSR(d), findSR(h), earningsDates[tkr]?.date || earningsDates[tkr], regimeData), dSR: findSR(d), hSR: findSR(h), dPat: detectPatterns(d, "Daily"), hPat: detectPatterns(h, "Hourly"), gap: analyzeGapPot(d) };
    setAn(result); setTab("trade");
    if (tkr) {
      saveScan(tkr, result.trade, d, h);
      rawDataRef.current[tkr] = { daily: d, hourly: h };
    }
    return result;
  }, [ticker, saveScan, earningsDates, regimeData]);

  const load = useCallback((file, type) => { setErr(""); const r = new FileReader(); r.onload = e => { const res = parseCSV(e.target.result); if (!res || res.records.length < 10) { setErr(`Bad ${type} CSV`); return; } if (type === "daily") { setDD(res.records); setDC(res.cols); if (hD) run(res.records, hD); } else { setHD(res.records); setHC(res.cols); if (dD) run(dD, res.records); } }; r.readAsText(file); }, [dD, hD, run]);

  // ── PREVIOUS DAY COMPARISON ──
  const handleCompareCSV = useCallback((file) => {
    const r = new FileReader();
    r.onload = e => {
      const parsed = Papa.parse(e.target.result.trim(), { header: true, skipEmptyLines: true });
      if (!parsed.data?.length) { setCompareLog(["❌ Could not parse CSV"]); return; }
      setCompareCsv(parsed.data);
      setCompareLog([`✅ Loaded ${parsed.data.length} tickers from previous day CSV`]);
    };
    r.readAsText(file);
  }, []);

  const handleCompareBatch = useCallback(async (files) => {
    if (!compareCsv || !compareCsv.length) { setCompareLog(prev => [...prev, "❌ Upload previous day CSV first"]); return; }
    const log = [`📂 ${files.length} files dropped for today's data`];
    setCompareLog(prev => [...prev, ...log]);
    const todayData = {};
    const fileArr = Array.from(files);
    let matched = 0, skipped = 0;
    for (const file of fileArr) {
      const info = parseBatchFilename(file.name);
      if (!info) { skipped++; continue; }
      const text = await file.text();
      const parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
      if (!parsed.data?.length) { skipped++; continue; }
      const headers = parsed.meta.fields.map(f => f.toLowerCase().trim());
      const oIdx = headers.findIndex(h => h === "open");
      const cIdx = headers.findIndex(h => h === "close");
      const hIdx = headers.findIndex(h => h === "high");
      const lIdx = headers.findIndex(h => h === "low");
      const lastRow = parsed.data[parsed.data.length - 1];
      const vals = Object.values(lastRow);
      const open = parseFloat(oIdx >= 0 ? vals[oIdx] : lastRow.open || lastRow.Open);
      const close = parseFloat(cIdx >= 0 ? vals[cIdx] : lastRow.close || lastRow.Close);
      const high = parseFloat(hIdx >= 0 ? vals[hIdx] : lastRow.high || lastRow.High);
      const low = parseFloat(lIdx >= 0 ? vals[lIdx] : lastRow.low || lastRow.Low);
      if (isNaN(open)) { skipped++; continue; }
      const tkr = info.ticker;
      // For daily: use as primary source. For hourly: aggregate high/low across all bars, use latest close
      if (!todayData[tkr]) {
        todayData[tkr] = { open, close: isNaN(close) ? open : close, high: isNaN(high) ? open : high, low: isNaN(low) ? open : low };
      } else {
        // Merge: expand high/low range, prefer daily close if available
        const existing = todayData[tkr];
        if (!isNaN(high) && high > existing.high) existing.high = high;
        if (!isNaN(low) && low < existing.low) existing.low = low;
        // For hourly files, scan ALL bars to get true intraday high/low
        if (info.timeframe === "hourly") {
          for (const row of parsed.data) {
            const rv = Object.values(row);
            const rh = parseFloat(hIdx >= 0 ? rv[hIdx] : row.high || row.High);
            const rl = parseFloat(lIdx >= 0 ? rv[lIdx] : row.low || row.Low);
            if (!isNaN(rh) && rh > existing.high) existing.high = rh;
            if (!isNaN(rl) && rl < existing.low) existing.low = rl;
          }
          // Use hourly latest close as the most recent price
          const hClose = parseFloat(cIdx >= 0 ? vals[cIdx] : lastRow.close || lastRow.Close);
          if (!isNaN(hClose)) existing.close = hClose;
        }
        if (info.timeframe === "daily" && !isNaN(close)) existing.close = close;
      }
      matched++;
      log.push(`✅ ${tkr} (${info.timeframe}): ${info.timeframe === "daily" ? "open $" + open.toFixed(2) + " close $" + (isNaN(close) ? "—" : close.toFixed(2)) : "hourly H/L merged"}`);
    }
    if (skipped > 0) log.push(`⚠ ${skipped} files skipped (unrecognized naming)`);
    log.push(`── ${matched} files matched across ${Object.keys(todayData).length} tickers ──`);
    setCompareLog(prev => [...prev, ...log]);
    setCompareTodayData(todayData);

    // Now compare
    const results = [];
    for (const row of compareCsv) {
      const tkr = (row.Ticker || row.ticker || "").trim().toUpperCase();
      if (!tkr) continue;
      const prevDir = (row.Dir || row.dir || row.Direction || "").trim().toUpperCase();
      const prevGrade = parseInt(row.Grade || row.grade || row.GRD || "0");
      const prevPrice = parseFloat((row.Price || row.price || "0").replace("$", ""));
      const t1 = row.T1 || row.t1 || "—";
      const t2 = row.T2 || row.t2 || "—";
      const t3 = row.T3 || row.t3 || "—";
      const today = todayData[tkr];
      if (!today) { results.push({ tkr, prevDir, prevGrade, prevPrice, todayOpen: null, move: null, correct: null, note: "No today data" }); continue; }
      const todayOpen = today.open;
      const todayClose = today.close;
      const todayHigh = today.high;
      const todayLow = today.low;
      const movePct = ((todayClose - prevPrice) / prevPrice * 100).toFixed(2);
      const openMovePct = ((todayOpen - prevPrice) / prevPrice * 100).toFixed(2);
      let correct = null;
      let note = "";
      if (prevDir === "PUTS") {
        // Check if price moved down from prev price
        const hitT1 = t1 !== "—" && todayLow <= parseFloat(t1);
        if (todayClose < prevPrice) { correct = true; note = `Dropped ${Math.abs(movePct)}%${hitT1 ? " ✓ Hit T1" : ""}`; }
        else if (todayLow < prevPrice && todayClose >= prevPrice) { correct = "partial"; note = `Intraday low hit but closed up ${movePct}%`; }
        else { correct = false; note = `Rose ${movePct}%`; }
      } else if (prevDir === "CALLS") {
        const hitT1 = t1 !== "—" && todayHigh >= parseFloat(t1);
        if (todayClose > prevPrice) { correct = true; note = `Gained ${movePct}%${hitT1 ? " ✓ Hit T1" : ""}`; }
        else if (todayHigh > prevPrice && todayClose <= prevPrice) { correct = "partial"; note = `Intraday high hit but closed down ${movePct}%`; }
        else { correct = false; note = `Dropped ${Math.abs(movePct)}%`; }
      } else {
        correct = null; note = `WAIT — no direction. Moved ${movePct}%`;
      }
      results.push({ tkr, prevDir, prevGrade, prevPrice, todayOpen, todayClose, todayHigh, todayLow, movePct, openMovePct, correct, note, t1, t2, t3 });
    }
    // Sort: correct first, then partial, then wrong, then no data
    results.sort((a, b) => {
      const order = v => v === true ? 0 : v === "partial" ? 1 : v === false ? 2 : 3;
      return order(a.correct) - order(b.correct);
    });
    setCompareResults(results);
    const wins = results.filter(r => r.correct === true).length;
    const partials = results.filter(r => r.correct === "partial").length;
    const losses = results.filter(r => r.correct === false).length;
    const noData = results.filter(r => r.correct === null).length;
    log.push(`\n── RESULTS: ✅ ${wins} correct, 🟡 ${partials} partial, ❌ ${losses} wrong, ⏸ ${noData} no data ──`);
    log.push(`Win rate: ${results.length > 0 ? ((wins / (wins + losses + partials)) * 100).toFixed(1) : 0}% (${wins}/${wins + losses + partials})`);
    setCompareLog(prev => [...prev, ...log]);
  }, [compareCsv]);


  // ── BATCH MODE ──
  const processBatchFiles = useCallback(async (files) => {    /* Clean up rows older than 30 days before saving new batch results. */    deleteOldFromSupabase(30);
    setBatchProcessing(true);
    const log = [];
    const pending = {};

    // Step 1: Parse filenames and read all files
    const fileArr = Array.from(files);
    log.push(`📂 ${fileArr.length} files dropped`);
    setBatchLog([...log]);

    const readFile = (f) => new Promise((res) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.onerror = () => res(null);
      r.readAsText(f);
    });

    for (const file of fileArr) {
      const info = parseBatchFilename(file.name);
      if (!info) {
        log.push(`⚠ Skipped "${file.name}" — couldn't parse ticker/timeframe`);
        setBatchLog([...log]);
        continue;
      }
      const text = await readFile(file);
      if (!text) { log.push(`❌ Failed to read "${file.name}"`); setBatchLog([...log]); continue; }
      const csv = parseCSV(text);
      if (!csv || csv.records.length < 10) { log.push(`❌ Bad CSV: "${file.name}" (${csv?.records?.length || 0} bars)`); setBatchLog([...log]); continue; }

      if (!pending[info.ticker]) pending[info.ticker] = { daily: null, hourly: null };
      pending[info.ticker][info.timeframe] = csv.records;
      log.push(`✅ ${info.ticker} ${info.timeframe} — ${csv.records.length} bars`);
      setBatchLog([...log]);
    }

    // Step 2: Match pairs and run analysis
    const tickers = Object.keys(pending);
    let processed = 0, skipped = 0;
    log.push(`\n── Processing ${tickers.length} tickers ──`);
    setBatchLog([...log]);

    // Process benchmarks FIRST so regime is available for individual stocks
    const benchmarkTickers = tickers.filter(t => BENCHMARKS.includes(t));
    const stockTickers = tickers.filter(t => !BENCHMARKS.includes(t));
    const newRegime = {};

    for (const tkr of benchmarkTickers) {
      const p = pending[tkr];
      if (!p.daily) { log.push(`⚠ ${tkr}: missing daily CSV — skipped`); setBatchLog([...log]); continue; }
      try {
        const regime = analyzeRegime(p.daily);
        if (regime) {
          newRegime[tkr] = regime;
          const icon = regime.direction === "BULLISH" ? "🟢" : regime.direction === "BEARISH" ? "🔴" : "🟡";
          log.push(`${icon} ${tkr}: ${regime.direction} (score ${regime.score}, 5d: ${regime.pct5d}%, RSI ${regime.rsi})`);
        }
      } catch (e) { log.push(`⚠ ${tkr}: regime analysis failed`); }
      setBatchLog([...log]);
    }
    setRegimeData(newRegime);
    if (benchmarkTickers.length > 0) {
      log.push(`── Market regime loaded: ${Object.entries(newRegime).map(([k, v]) => `${k}=${v.direction}`).join(", ")} ──`);
      setBatchLog([...log]);
    }

    for (const tkr of stockTickers) {
      const p = pending[tkr];
      if (!p.daily) { log.push(`⚠ ${tkr}: missing daily CSV — skipped`); skipped++; setBatchLog([...log]); continue; }
      if (!p.hourly) { log.push(`⚠ ${tkr}: missing hourly CSV — skipped`); skipped++; setBatchLog([...log]); continue; }

      try {
        const trade = computePlan(p.daily, p.hourly, findSR(p.daily), findSR(p.hourly), earningsDates[tkr]?.date || earningsDates[tkr], newRegime);
        const scan = {
          ticker: tkr, grade: trade.grade, direction: trade.direction, bias: trade.bias,
          isReversal: trade.reversalInfo?.isReversal || false, price: trade.price,
          t1: trade.targets[0]?.price?.toFixed(2) || "—", t2: trade.targets[1]?.price?.toFixed(2) || "—",
          t3: trade.targets[2]?.price?.toFixed(2) || "—", t4: trade.targets[3]?.price?.toFixed(2) || "—",
          t5: trade.targets[4]?.price?.toFixed(2) || "—", timestamp: new Date().toISOString(),
          hDiv: trade.hDiv, dDiv: trade.dDiv, cDiv: trade.cDiv, divAdj: trade.divAdj,
        };
        setScans(prev => ({ ...prev, [tkr]: scan }));
        saveResultToSupabase(scan);
        rawDataRef.current[tkr] = { daily: p.daily, hourly: p.hourly };
        const dc = trade.reversalInfo?.isReversal ? "🔄" : trade.direction === "CALLS" ? "📈" : trade.direction === "PUTS" ? "📉" : "⏸";
        log.push(`✅ ${tkr}: ${dc} ${trade.direction}${trade.reversalInfo?.isReversal ? " (REVERSAL)" : ""} Grade ${trade.grade}/10 — $${trade.price}`);
        processed++;
      } catch (e) {
        log.push(`❌ ${tkr}: analysis failed — ${e.message}`);
        skipped++;
      }
      setBatchLog([...log]);
    }

    log.push(`\n── Done: ${processed} analyzed, ${skipped} skipped ──`);
    if (skipped > 0) {
      const skippedTickers = log.filter(l => l.includes("⚠") || l.includes("❌")).map(l => l.match(/[⚠❌]\s*(\S+):/)?.[1]).filter(Boolean);
      if (skippedTickers.length) log.push(`⚠ SKIPPED: ${skippedTickers.join(", ")}`);
    }
    setBatchLog([...log]);
    setBatchProcessing(false);
  }, []);

  // Clear all scans
  const clearScans = () => {
    setScans({});
    setBatchAIResults({});
    setBatchAIProgress("");
    setEarningsDates({});
    setRegimeData({});
    rawDataRef.current = {};
    earningsFetchingRef.current = new Set();
    earningsQueueRef.current = [];
    if (earningsTimerRef.current) clearTimeout(earningsTimerRef.current);
  };

  // Load a scan's full analysis on double-click
  const loadScan = (tkr) => {
    const raw = rawDataRef.current[tkr];
    if (!raw || !raw.daily || !raw.hourly) {
      setErr(`No raw data for ${tkr} — re-upload CSVs or re-run batch to enable full view.`);
      return;
    }
    setTicker(tkr);
    setDD(raw.daily);
    setHD(raw.hourly);
    setBatchMode(false);
    setAI("");
    setErr("");
    // Run full analysis
    const result = { trade: computePlan(raw.daily, raw.hourly, findSR(raw.daily), findSR(raw.hourly), earningsDates[tkr]?.date || earningsDates[tkr], regimeData), dSR: findSR(raw.daily), hSR: findSR(raw.hourly), dPat: detectPatterns(raw.daily, "Daily"), hPat: detectPatterns(raw.hourly, "Hourly"), gap: analyzeGapPot(raw.daily) };
    setAn(result);
    setTab("trade");
  };

  const fetchAI = async () => {
    if (!an) return; setAIL(true); setAI("");
    const t = an.trade;
    const tgts = t.targets.slice(0, 3).map((x, i) => `T${i + 1}: $${x.price.toFixed(2)} (${x.pct}%) — ${x.label}`).join("\n");
    const gapInfo = t.gapCtx?.activeGapFill ? `ACTIVE GAP FILL: ${t.gapCtx.activeGapFill.type} $${t.gapCtx.activeGapFill.gapBottom.toFixed(2)}-$${t.gapCtx.activeGapFill.gapTop.toFixed(2)}` : "No active gap fill";
    const divInfo = t.divAdj ? `DIV CONFLICT: ${t.divAdj.gradeAdj} — divergence opposes direction` : t.cDiv?.label !== "—" ? `DIVERGENCE: H:${t.hDiv?.label || "—"} D:${t.dDiv?.label || "—"} Combined:${t.cDiv?.label}` : "";
    const safeguards = [
      t.extremeWarning ? `${t.extremeWarning.type} (${t.extremeWarning.severity})` : "",
      t.earningsAdj ? `Earnings ${t.earningsAdj.daysUntil}d (${t.earningsAdj.effect})` : "",
      t.rsiCap ? `Grade capped from ${t.rsiCap.cappedFrom}` : "",
      t.reversalInfo?.isReversal ? `Reversal: ${t.reversalInfo.signals.length} signals` : "",
    ].filter(Boolean).join(", ");
    const prompt = `${ticker} swing trade analysis (1-2 week hold).
Price: $${t.price} | ${t.direction} Grade ${t.grade}/10 | Daily RSI ${t.daily.rsi} | Hourly RSI ${t.hourly.rsi}
Daily: ${t.daily.dir} (score ${t.daily.score}) | Hourly: ${t.hourly.dir} (score ${t.hourly.score})
Gap: ${gapInfo} | Vol: ${t.daily.volume?.hasVolume ? `${t.daily.volume.relVol}x ${t.daily.volume.confirmation}` : "N/A"}
${divInfo ? `${divInfo}\n` : ""}${safeguards ? `Safeguards: ${safeguards}\n` : ""}Targets:\n${tgts}

Respond in this EXACT format — be concise, 1-2 sentences per section:

1. **TAKE TRADE NOW?** Yes/No + reason considering momentum & gaps
2. **GAP ANALYSIS** Gap fill vs trend reversal assessment
3. **NEWS & CATALYSTS** Key recent drivers (tariffs, earnings, upgrades, sector)
4. **TARGET PROBABILITIES (1 WEEK)**
T1 $${t.targets[0]?.price.toFixed(2) || "—"}: XX% — reason
T2 $${t.targets[1]?.price.toFixed(2) || "—"}: XX% — reason
T3 $${t.targets[2]?.price.toFixed(2) || "—"}: XX% — reason
5. **RISKS** Top 2-3 risks
6. **FINAL VERDICT** One line: direction, best target, confidence`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const r = await fetch("/api/claude", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: prompt }] })
      });
      clearTimeout(timeout);
      const d = await r.json();
      setAI(d.content?.map(i => i.text || "").filter(Boolean).join("\n") || "No response.");
    } catch (e) { clearTimeout(timeout); setAI(e.name === "AbortError" ? "⏱ Timed out (30s). Try again." : "Error: " + e.message); }
    setAIL(false);
  };

  const fetchBatchAI = async () => {
    const topScans = Object.values(scans).filter(s => s.grade >= 9);
    if (topScans.length === 0) { setBatchAIProgress("No tickers with grade 9+"); return; }
    setBatchAILoading(true);
    setBatchAIProgress(`🤖 Running AI on ${topScans.length} ticker${topScans.length > 1 ? "s" : ""}...`);

    const results = { ...batchAIResults };

    for (let idx = 0; idx < topScans.length; idx++) {
      const s = topScans[idx];
      const tkr = s.ticker;
      setBatchAIProgress(`[${idx + 1}/${topScans.length}] Running AI for ${tkr} (Grade ${s.grade})...`);

      // Get raw data and run full analysis
      const raw = rawDataRef.current[tkr];
      if (!raw || !raw.daily || !raw.hourly) {
        results[tkr] = "⚠ No raw CSV data — re-upload or re-run batch to enable AI.";
        setBatchAIResults({ ...results });
        continue;
      }

      const t = computePlan(raw.daily, raw.hourly, findSR(raw.daily), findSR(raw.hourly), earningsDates[tkr]?.date || earningsDates[tkr], regimeData);
      const tgts = t.targets.map((x, i) => `T${i + 1}: $${x.price.toFixed(2)} (${x.label})`).join("\n");
      const gapInfo = t.gapCtx?.activeGapFill ? `ACTIVE GAP FILL: ${t.gapCtx.activeGapFill.type} from ${t.gapCtx.activeGapFill.prevDate}→${t.gapCtx.activeGapFill.date}, range $${t.gapCtx.activeGapFill.gapBottom.toFixed(2)}-$${t.gapCtx.activeGapFill.gapTop.toFixed(2)}` : "No active gap fill";
      const t1 = t.targets[0], t2 = t.targets[1], t3 = t.targets[2];

      const safeguardInfo = [
        t.extremeWarning ? `SAFEGUARD WARNING: ${t.extremeWarning.type} — ${t.extremeWarning.severity} severity. Grade penalized by ${t.extremeWarning.gradeAdj}.` : "",
        t.earningsAdj ? `EARNINGS: ${t.earningsAdj.daysUntil} days until earnings. Effect: ${t.earningsAdj.effect}.` : "",
        t.rsiCap ? `RSI CAP: Grade capped at 7 from ${t.rsiCap.cappedFrom} due to RSI extreme.` : "",
        t.reversalInfo?.isReversal ? `REVERSAL: Hourly leading daily, ${t.reversalInfo.signals.length} signals (score ${t.reversalInfo.score}). Early reversal — daily not confirmed.` : "",
      ].filter(Boolean).join("\n");

      const batchVolInfo = t.daily.volume?.hasVolume ? `${t.daily.volume.relVol}x ${t.daily.volume.confirmation}` : "No vol";
      const divInfo = t.divAdj ? `DIV CONFLICT: ${t.divAdj.gradeAdj}` : t.cDiv?.label !== "—" ? `DIV: ${t.cDiv?.label}` : "";
      const prompt = `${tkr} swing trade (1-2wk). $${t.price} | ${t.direction} G${t.grade} | D:${t.daily.dir} RSI${t.daily.rsi} H:${t.hourly.dir} RSI${t.hourly.rsi}
Gap:${gapInfo} Vol:${batchVolInfo}${divInfo ? ` ${divInfo}` : ""}
${safeguardInfo ? safeguardInfo + "\n" : ""}Targets: ${tgts}

Concise (1-2 sentences each):
1.**TRADE NOW?** 2.**GAP** 3.**NEWS** 4.**T1$${t1?.price.toFixed(2)||"—"}:XX% T2$${t2?.price.toFixed(2)||"—"}:XX% T3$${t3?.price.toFixed(2)||"—"}:XX%** 5.**RISKS** 6.**VERDICT**`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const r = await fetch("/api/claude", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 800,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages: [{ role: "user", content: prompt }] })
        });
        clearTimeout(timeout);
        const d = await r.json();
        results[tkr] = d.content?.map(i => i.text || "").filter(Boolean).join("\n") || "No response.";
      } catch (e) {
        clearTimeout(timeout);
        results[tkr] = e.name === "AbortError" ? "⏱ Timed out (30s)" : "Error: " + e.message;
      }
      setBatchAIResults({ ...results });
    }

    setBatchAIProgress(`✅ Done — ${topScans.length} ticker${topScans.length > 1 ? "s" : ""} analyzed`);
    setBatchAILoading(false);
  };

  const earningsFetchingRef = useRef(new Set()); // Track in-flight fetches

  const fetchEarningsBatch = async (tickers) => {
    if (!tickers.length) return;
    // Mark as in-flight
    tickers.forEach(t => earningsFetchingRef.current.add(t));
    setEarningsLoading(true);
    try {
      const tickerCtx = tickers.map(tkr => {
        const s = scans[tkr];
        return s ? `${tkr}: price $${s.price}, direction ${s.direction}, grade ${s.grade}` : tkr;
      }).join("; ");

      const prompt = `You are a senior equity analyst. Today is ${new Date().toLocaleDateString()}.

For each stock below, search for and provide:
1. Next earnings date (or "Just reported [date]" if within last 7 days)
2. Your prediction: will they BEAT or MISS earnings expectations? (beat/miss/uncertain)
3. Will the report be received WELL or POORLY by the market? (positive/negative/mixed)
4. After earnings, will the stock go UP or DOWN? Give a 1-sentence reason.
5. Current market sentiment around this stock heading into earnings (bullish/bearish/neutral) and why in 1 sentence.

Consider: recent revenue trends, analyst estimate revisions, guidance patterns, sector headwinds/tailwinds, management commentary, options positioning, whisper numbers, and current sentiment.

Stocks with context: ${tickerCtx}

Respond ONLY with a JSON object. No other text. No markdown backticks. Use this exact format:
{"AAPL": {"date": "Apr 30, 2026", "beat": "likely", "reason": "strong iPhone cycle + services growth", "reception": "positive", "receptionReason": "guidance likely raised", "postEarningsDir": "up", "postEarningsWhy": "Services revenue beat + raised guidance should push stock higher", "sentiment": "bullish", "sentimentWhy": "Analyst upgrades and strong iPhone 17 pre-orders driving optimism"}}

Valid values for "beat": "likely", "unlikely", "uncertain", "beat" (if already reported), "miss" (if already reported)
Valid values for "reception": "positive", "negative", "mixed"
Valid values for "postEarningsDir": "up", "down", "flat"
Valid values for "sentiment": "bullish", "bearish", "neutral"`;

      const r = await fetch("/api/claude", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 3000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: prompt }]
        })
      });
      const d = await r.json();
      const text = d.content?.map(i => i.text || "").filter(Boolean).join("\n") || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          setEarningsDates(prev => ({ ...prev, ...parsed }));
        } catch {}
      }
    } catch {}
    tickers.forEach(t => earningsFetchingRef.current.delete(t));
    setEarningsLoading(earningsFetchingRef.current.size > 0);
  };

  // Auto-fetch earnings for grade 9+ tickers as they appear (batches of 5)
  const earningsQueueRef = useRef([]);
  const earningsTimerRef = useRef(null);

  useEffect(() => {
    const needed = Object.values(scans)
      .filter(s => s.grade >= 9)
      .map(s => s.ticker)
      .filter(t => !earningsDates[t] && !earningsFetchingRef.current.has(t));

    if (needed.length === 0) return;

    // Add to queue (dedup)
    for (const t of needed) {
      if (!earningsQueueRef.current.includes(t)) earningsQueueRef.current.push(t);
    }

    // Debounce: wait 500ms after last scan update, then fire batches
    if (earningsTimerRef.current) clearTimeout(earningsTimerRef.current);
    earningsTimerRef.current = setTimeout(async () => {
      while (earningsQueueRef.current.length > 0) {
        // Grab up to 2 batches of 10 and run in parallel
        const batches = [];
        for (let i = 0; i < 2 && earningsQueueRef.current.length > 0; i++) {
          const batch = earningsQueueRef.current.splice(0, 10);
          const stillNeeded = batch.filter(t => !earningsDates[t] && !earningsFetchingRef.current.has(t));
          if (stillNeeded.length > 0) batches.push(fetchEarningsBatch(stillNeeded));
        }
        if (batches.length > 0) await Promise.all(batches);
      }
    }, 500);
  }, [scans]);

  const tabs = [{ id: "trade", l: "⚡ Trade" }, { id: "targets", l: "🎯 Targets" }, { id: "gaps", l: "📊 Gaps" }, { id: "levels", l: "S/R" }, { id: "patterns", l: "Patterns" }, { id: "ai", l: "AI" }];
  const Card = ({ title, children, accent: a }) => <div style={{ background: "rgba(17,24,39,0.8)", border: `1px solid ${a || "#1e293b"}`, borderRadius: 8, padding: "12px 16px", marginBottom: 8 }}>{title && <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color: a || "#64748b", marginBottom: 6 }}>{title}</div>}{children}</div>;
  const Badge = ({ children, color: c }) => <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: c + "22", color: c, border: `1px solid ${c}44`, marginRight: 4, marginBottom: 3 }}>{children}</span>;
  const gc = g => g >= 8 ? "#00e676" : g >= 6 ? "#66bb6a" : g >= 4 ? "#ffd600" : g >= 2 ? "#ff9800" : "#ff1744";
  const UB = ({ label, fr, data, cols, type, color }) => (
    <div onClick={() => fr.current?.click()} style={{ border: `2px dashed ${data ? color : "#1e293b"}`, borderRadius: 10, padding: "14px 10px", textAlign: "center", cursor: "pointer", background: data ? color + "08" : "rgba(17,24,39,0.5)", flex: 1, minWidth: 170 }}>
      <div style={{ fontSize: 16 }}>{data ? "✅" : "📁"}</div>
      <div style={{ fontSize: 11, fontWeight: 700, color: data ? color : "#e2e8f0" }}>{label}</div>
      {data && <div style={{ fontSize: 9, color: "#64748b" }}>{data.length} bars</div>}
      <input ref={fr} type="file" accept=".csv" style={{ display: "none" }} onChange={e => e.target.files[0] && load(e.target.files[0], type)} />
    </div>);

  const t = an?.trade, hL = hD?.[hD.length - 1];

  return (
    <div style={{ minHeight: "100vh", background: "#0a0e17", color: "#e2e8f0", fontFamily: "'JetBrains Mono','Fira Code',monospace" }}>
      <div style={{ background: "linear-gradient(180deg,#111827,#0a0e17)", borderBottom: "1px solid #1e293b", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 26, height: 26, borderRadius: 5, background: "linear-gradient(135deg,#00e676,#00b0ff)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 11, color: "#0a0e17" }}>SA</div>
        <div><div style={{ fontWeight: 800, fontSize: 12 }}>STOCK ANALYST</div><div style={{ fontSize: 7, color: "#64748b", letterSpacing: 1 }}>DUAL TF · VWAP · GAPS · 5 TARGETS · BATCH SCAN</div></div>
        <div style={{ flex: 1 }} />
        <input type="text" placeholder="TICKER" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 5, padding: "4px 8px", color: "#00e676", fontFamily: "inherit", fontSize: 12, fontWeight: 700, width: 80, textAlign: "center", outline: "none" }} />
        {Object.keys(scans).length > 0 && <div style={{ background: "#7c3aed22", border: "1px solid #7c3aed44", borderRadius: 5, padding: "3px 8px", fontSize: 9, color: "#a78bfa", fontWeight: 700 }}>{Object.keys(scans).length} scans</div>}
        <button onClick={() => { setBatchMode(!batchMode); setViewMode("analysis"); }} style={{ background: batchMode && viewMode === "analysis" ? "#f59e0b22" : "transparent", border: `1px solid ${batchMode && viewMode === "analysis" ? "#f59e0b" : "#1e293b"}`, borderRadius: 5, padding: "4px 8px", color: batchMode && viewMode === "analysis" ? "#f59e0b" : "#64748b", fontFamily: "inherit", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>{batchMode ? "⚡ SINGLE" : "📦 BATCH"}</button>
        <button onClick={async () => { if (viewMode === "history") { setViewMode("analysis"); } else { setViewMode("history"); setHistoryLoading(true); const data = await fetchHistoryFromSupabase(); setHistory(data); setHistoryLoading(false); }}} style={{ background: viewMode === "history" ? "#7c3aed22" : "transparent", border: `1px solid ${viewMode === "history" ? "#7c3aed" : "#1e293b"}`, borderRadius: 5, padding: "4px 8px", color: viewMode === "history" ? "#a78bfa" : "#64748b", fontFamily: "inherit", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>📜 HISTORY</button>
      </div>

      {/* ── HISTORY VIEW ── */}
      {viewMode === "history" && (
        <div style={{ padding: "10px 14px", maxWidth: 920, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <input type="text" placeholder="Filter by ticker..." value={historyFilter} onChange={e => setHistoryFilter(e.target.value.toUpperCase())} style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 5, padding: "4px 8px", color: "#a78bfa", fontFamily: "inherit", fontSize: 11, fontWeight: 700, width: 140, outline: "none" }} />
            <span style={{ fontSize: 9, color: "#64748b" }}>{history.length} records</span>
            <div style={{ flex: 1 }} />
            <button onClick={async () => { setHistoryLoading(true); const data = await fetchHistoryFromSupabase(); setHistory(data); setHistoryLoading(false); }} style={{ background: "transparent", border: "1px solid #1e293b", borderRadius: 5, padding: "3px 8px", color: "#64748b", fontFamily: "inherit", fontSize: 9, cursor: "pointer" }}>↻ Refresh</button>
          </div>
          {historyLoading && <div style={{ textAlign: "center", padding: 20, color: "#a78bfa", fontSize: 11, fontWeight: 700 }}>Loading history...</div>}
          {!historyLoading && history.length === 0 && <div style={{ textAlign: "center", padding: 20, color: "#64748b", fontSize: 11 }}>No history yet. Run analyses to populate.</div>}
          {!historyLoading && history.filter(h => !historyFilter || h.ticker?.includes(historyFilter)).length > 0 && (
            <div style={{ border: "1px solid #1e293b", borderRadius: 5, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "60px 40px 50px 60px 60px 60px 60px 60px 60px 60px 60px 70px 1fr", padding: "4px 6px", background: "#111827", borderBottom: "1px solid #1e293b" }}>
                {["Ticker", "Grade", "Dir", "Price", "T1", "T2", "T3", "T4", "T5", "H Div", "D Div", "Combined", "Date"].map(h => <div key={h} style={{ fontSize: 7, fontWeight: 700, color: h.includes("Div") || h === "Combined" ? "#a78bfa" : "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</div>)}
              </div>
              {history.filter(h => !historyFilter || h.ticker?.includes(historyFilter)).map((h, i) => {
                const dc = h.direction === "CALLS" ? "#00e676" : h.direction === "PUTS" ? "#ff1744" : "#ffd600";
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "60px 40px 50px 60px 60px 60px 60px 60px 60px 60px 60px 70px 1fr", padding: "3px 6px", borderBottom: "1px solid #1e293b11", fontSize: 9 }}>
                    <div style={{ fontWeight: 700, color: "#e2e8f0" }}>{h.ticker}</div>
                    <div style={{ fontWeight: 700, color: h.grade >= 7 ? "#00e676" : h.grade >= 5 ? "#ffd600" : "#ff1744" }}>{h.grade}</div>
                    <div style={{ fontWeight: 700, color: dc }}>{h.is_reversal ? "🔄" : ""}{h.direction === "CALLS" ? "📈" : h.direction === "PUTS" ? "📉" : "⏸"}</div>
                    <div style={{ color: "#94a3b8" }}>${h.price}</div>
                    <div style={{ color: "#94a3b8" }}>{h.target_1 || "—"}</div>
                    <div style={{ color: "#94a3b8" }}>{h.target_2 || "—"}</div>
                    <div style={{ color: "#94a3b8" }}>{h.target_3 || "—"}</div>
                    <div style={{ color: "#94a3b8" }}>{h.target_4 || "—"}</div>
                    <div style={{ color: "#94a3b8" }}>{h.target_5 || "—"}</div>
                    <div style={{ fontWeight: 700, color: h.h_div && h.h_div !== "—" ? "#a78bfa" : "#64748b", fontSize: 7 }}>{h.h_div || "—"}</div>
                    <div style={{ fontWeight: 700, color: h.d_div && h.d_div !== "—" ? "#a78bfa" : "#64748b", fontSize: 7 }}>{h.d_div || "—"}</div>
                    <div style={{ fontWeight: 700, color: h.combined_div && h.combined_div !== "—" ? "#a78bfa" : "#64748b", fontSize: 7 }}>{h.combined_div || "—"}</div>
                    <div style={{ color: "#475569", fontSize: 7 }}>{new Date(h.analyzed_at).toLocaleDateString()}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {viewMode === "analysis" && <div style={{ padding: "10px 14px", maxWidth: 920, margin: "0 auto" }}>

        {/* ── BATCH MODE ── */}
        {batchMode && (<div style={{ marginBottom: 10 }}>
          <div
            onClick={() => batchR.current?.click()}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
            onDrop={e => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files.length) processBatchFiles(e.dataTransfer.files); }}
            style={{ border: "2px dashed #f59e0b44", borderRadius: 10, padding: "24px 16px", textAlign: "center", cursor: "pointer", background: "rgba(245,158,11,0.04)", marginBottom: 8 }}>
            <div style={{ fontSize: 28 }}>📦</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#f59e0b", marginBottom: 4 }}>BATCH MODE — Drop or Click to Upload</div>
            <div style={{ fontSize: 9, color: "#94a3b8", lineHeight: 1.6 }}>
              Select ALL daily + hourly CSVs at once<br/>
              Naming: <span style={{ color: "#e2e8f0" }}>NYSE_TICKER, 1D.csv</span> (daily) + <span style={{ color: "#e2e8f0" }}>NYSE_TICKER, 60.csv</span> (hourly)<br/>
              Bot auto-matches pairs by ticker and runs analysis on each
            </div>
            <input ref={batchR} type="file" accept=".csv" multiple style={{ display: "none" }} onChange={e => { if (e.target.files.length) processBatchFiles(e.target.files); }} />
          </div>
          {batchProcessing && <div style={{ textAlign: "center", padding: 8, color: "#f59e0b", fontSize: 11, fontWeight: 700 }}>⏳ Processing batch...</div>}
          {batchLog.length > 0 && (
            <div style={{ background: "rgba(17,24,39,0.8)", border: "1px solid #1e293b", borderRadius: 6, padding: 10, maxHeight: 200, overflowY: "auto", marginBottom: 8 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Batch Log</div>
              {batchLog.map((l, i) => <div key={i} style={{ fontSize: 10, color: l.startsWith("✅") ? "#00e676" : l.startsWith("❌") ? "#ff1744" : l.startsWith("⚠") ? "#ffd600" : "#94a3b8", padding: "1px 0", fontFamily: "monospace" }}>{l}</div>)}
            </div>
          )}
        </div>)}

        {/* ── PREVIOUS DAY COMPARISON ── */}
        {batchMode && (
          <div style={{ marginBottom: 10 }}>
            <div onClick={() => setCompareMode(!compareMode)} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "8px 12px", background: compareMode ? "rgba(124,58,237,0.08)" : "rgba(17,24,39,0.5)", border: `1px solid ${compareMode ? "#7c3aed44" : "#1e293b"}`, borderRadius: 8, marginBottom: compareMode ? 8 : 0 }}>
              <span style={{ fontSize: 14 }}>📊</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: compareMode ? "#a78bfa" : "#64748b" }}>PREVIOUS DAY COMPARISON</span>
              <span style={{ fontSize: 9, color: "#64748b", marginLeft: 4 }}>— Was the bot right or wrong?</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: "#64748b" }}>{compareMode ? "▲" : "▼"}</span>
            </div>
            {compareMode && (
              <div style={{ background: "rgba(17,24,39,0.8)", border: "1px solid #7c3aed33", borderRadius: 8, padding: "14px 16px" }}>
                <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                  {/* Step 1: Upload previous day CSV */}
                  <div onClick={() => compareCSVRef.current?.click()} style={{ flex: 1, border: `2px dashed ${compareCsv ? "#a78bfa" : "#1e293b"}`, borderRadius: 10, padding: "14px 10px", textAlign: "center", cursor: "pointer", background: compareCsv ? "#7c3aed08" : "rgba(17,24,39,0.5)" }}>
                    <div style={{ fontSize: 14 }}>{compareCsv ? "✅" : "1️⃣"}</div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: compareCsv ? "#a78bfa" : "#e2e8f0" }}>Previous Day CSV</div>
                    <div style={{ fontSize: 8, color: "#64748b" }}>{compareCsv ? `${compareCsv.length} tickers loaded` : "Downloaded scans CSV"}</div>
                    <input ref={compareCSVRef} type="file" accept=".csv" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) handleCompareCSV(e.target.files[0]); }} />
                  </div>
                  {/* Step 2: Upload today's daily CSVs */}
                  <div
                    onClick={() => compareBatchRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={e => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files.length) handleCompareBatch(e.dataTransfer.files); }}
                    style={{ flex: 1, border: `2px dashed ${compareResults ? "#00e676" : "#1e293b"}`, borderRadius: 10, padding: "14px 10px", textAlign: "center", cursor: "pointer", background: compareResults ? "#00e67608" : "rgba(17,24,39,0.5)" }}>
                    <div style={{ fontSize: 14 }}>{compareResults ? "✅" : "2️⃣"}</div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: compareResults ? "#00e676" : "#e2e8f0" }}>Today's CSVs</div>
                    <div style={{ fontSize: 8, color: "#64748b" }}>{compareResults ? `${Object.keys(compareTodayData).length} tickers` : "Drop ALL daily + hourly CSVs"}</div>
                    <input ref={compareBatchRef} type="file" accept=".csv" multiple style={{ display: "none" }} onChange={e => { if (e.target.files.length) handleCompareBatch(e.target.files); }} />
                  </div>
                </div>
                {/* Compare Log */}
                {compareLog.length > 0 && (
                  <div style={{ background: "rgba(0,0,0,0.25)", borderRadius: 6, padding: 8, maxHeight: 120, overflowY: "auto", marginBottom: 8 }}>
                    {compareLog.map((l, i) => <div key={i} style={{ fontSize: 9, color: l.startsWith("✅") ? "#00e676" : l.startsWith("❌") ? "#ff1744" : l.includes("RESULTS") ? "#a78bfa" : l.includes("Win rate") ? "#ffd600" : "#94a3b8", padding: "1px 0", fontFamily: "monospace" }}>{l}</div>)}
                  </div>
                )}
                {/* Results Table */}
                {compareResults && compareResults.length > 0 && (
                  <div>
                    {/* Summary bar */}
                    <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                      {[
                        { label: "CORRECT", count: compareResults.filter(r => r.correct === true).length, color: "#00e676" },
                        { label: "PARTIAL", count: compareResults.filter(r => r.correct === "partial").length, color: "#ffd600" },
                        { label: "WRONG", count: compareResults.filter(r => r.correct === false).length, color: "#ff1744" },
                        { label: "NO DATA", count: compareResults.filter(r => r.correct === null).length, color: "#64748b" },
                      ].map(s => (
                        <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", background: s.color + "12", border: `1px solid ${s.color}33`, borderRadius: 5 }}>
                          <span style={{ fontSize: 16, fontWeight: 900, color: s.color }}>{s.count}</span>
                          <span style={{ fontSize: 8, fontWeight: 700, color: s.color }}>{s.label}</span>
                        </div>
                      ))}
                      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", background: "#a78bfa12", border: "1px solid #a78bfa33", borderRadius: 5, marginLeft: "auto" }}>
                        <span style={{ fontSize: 12, fontWeight: 900, color: "#a78bfa" }}>{(() => { const w = compareResults.filter(r => r.correct === true).length; const t = compareResults.filter(r => r.correct !== null).length; return t > 0 ? (w / t * 100).toFixed(0) : 0; })()}%</span>
                        <span style={{ fontSize: 8, fontWeight: 700, color: "#a78bfa" }}>WIN RATE</span>
                      </div>
                    </div>
                    {/* Table header */}
                    <div style={{ display: "grid", gridTemplateColumns: "55px 35px 50px 55px 55px 50px 40px 1fr", gap: 2, padding: "4px 6px", background: "rgba(0,0,0,0.3)", borderRadius: 4, marginBottom: 2 }}>
                      {["TICKER", "GRD", "DIR", "PREV $", "NOW $", "MOVE", "RESULT", "NOTE"].map(h => (
                        <div key={h} style={{ fontSize: 7, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</div>
                      ))}
                    </div>
                    <div style={{ maxHeight: 300, overflowY: "auto" }}>
                      {compareResults.map((r, i) => {
                        const rc = r.correct === true ? "#00e676" : r.correct === "partial" ? "#ffd600" : r.correct === false ? "#ff1744" : "#64748b";
                        const dc = r.prevDir === "CALLS" ? "#00e676" : r.prevDir === "PUTS" ? "#ff1744" : "#ffd600";
                        return (
                          <div key={i} style={{ display: "grid", gridTemplateColumns: "55px 35px 50px 55px 55px 50px 40px 1fr", gap: 2, padding: "5px 6px", borderBottom: "1px solid #1e293b15", alignItems: "center" }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "#e2e8f0" }}>{r.tkr}</div>
                            <div style={{ fontSize: 10, fontWeight: 700, color: rc }}>{r.prevGrade}</div>
                            <div style={{ fontSize: 9, fontWeight: 700, color: dc }}>{r.prevDir === "CALLS" ? "📈" : r.prevDir === "PUTS" ? "📉" : "⏸"} {r.prevDir}</div>
                            <div style={{ fontSize: 9, color: "#94a3b8" }}>${r.prevPrice?.toFixed(2)}</div>
                            <div style={{ fontSize: 9, color: "#e2e8f0" }}>{r.todayClose ? `$${r.todayClose.toFixed(2)}` : "—"}</div>
                            <div style={{ fontSize: 9, fontWeight: 700, color: parseFloat(r.movePct) > 0 ? "#00e676" : parseFloat(r.movePct) < 0 ? "#ff1744" : "#64748b" }}>{r.movePct ? `${parseFloat(r.movePct) > 0 ? "+" : ""}${r.movePct}%` : "—"}</div>
                            <div style={{ fontSize: 10, fontWeight: 900, color: rc }}>{r.correct === true ? "✅" : r.correct === "partial" ? "🟡" : r.correct === false ? "❌" : "—"}</div>
                            <div style={{ fontSize: 8, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.note}</div>
                          </div>
                        );
                      })}
                    </div>
                    {/* Download comparison results */}
                    <div style={{ textAlign: "center", marginTop: 8 }}>
                      <button onClick={() => {
                        const csv = "Ticker,Grade,Dir,Prev Price,Today Close,Move %,Result,Note\n" + compareResults.map(r => `${r.tkr},${r.prevGrade},${r.prevDir},$${r.prevPrice?.toFixed(2) || ""},${r.todayClose ? "$" + r.todayClose.toFixed(2) : ""},${r.movePct || ""},${r.correct === true ? "CORRECT" : r.correct === "partial" ? "PARTIAL" : r.correct === false ? "WRONG" : "NO DATA"},"${r.note}"`).join("\n");
                        setCompareCsvText(csv);
                      }} style={{ background: "transparent", border: "1px solid #a78bfa44", borderRadius: 4, padding: "4px 12px", color: "#a78bfa", fontFamily: "inherit", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>📥 Download Comparison CSV</button>
                      {compareCsvText && <button onClick={() => setCompareCsvText("")} style={{ background: "transparent", border: "1px solid #64748b44", borderRadius: 4, padding: "3px 6px", color: "#64748b", fontFamily: "inherit", fontSize: 8, cursor: "pointer", marginLeft: 4 }}>✕</button>}
                      <button onClick={() => { setCompareCsv(null); setCompareTodayData({}); setCompareResults(null); setCompareLog([]); setCompareCsvText(""); }} style={{ background: "transparent", border: "1px solid #dc262644", borderRadius: 4, padding: "4px 12px", color: "#dc2626", fontFamily: "inherit", fontSize: 9, fontWeight: 700, cursor: "pointer", marginLeft: 6 }}>🗑 RESET</button>
                    </div>
                    {compareCsvText && (
                      <div style={{ marginTop: 6, background: "rgba(0,0,0,0.3)", borderRadius: 6, padding: 8 }}>
                        <div style={{ fontSize: 8, color: "#a78bfa", fontWeight: 700, marginBottom: 4 }}>CLICK THE TEXT BOX → Ctrl+A (select all) → Ctrl+C (copy) → PASTE TO ME IN CHAT</div>
                        <textarea readOnly value={compareCsvText} onClick={e => e.target.select()} style={{ width: "100%", height: 80, background: "#0a0e17", border: "1px solid #a78bfa33", borderRadius: 4, color: "#e2e8f0", fontFamily: "monospace", fontSize: 8, padding: 6, resize: "vertical", outline: "none" }} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── SCANS TABLE ── */}
        {Object.keys(scans).length > 0 && (
          <div style={{ background: "rgba(17,24,39,0.8)", border: "1px solid #1e293b", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#a78bfa", textTransform: "uppercase", letterSpacing: 1.5 }}>📋 Saved Scans ({Object.keys(scans).length})</div>
              <div style={{ display: "flex", gap: 6 }}>
                {Object.values(scans).some(s => s.grade >= 9) && <button onClick={fetchBatchAI} disabled={batchAILoading} style={{ background: batchAILoading ? "#1e293b" : "linear-gradient(135deg,#f59e0b,#ff6d00)", border: "none", borderRadius: 4, padding: "3px 10px", color: "#fff", fontFamily: "inherit", fontSize: 9, fontWeight: 700, cursor: batchAILoading ? "wait" : "pointer" }}>{batchAILoading ? "⏳ Running..." : `🤖 AI on 9+ (${Object.values(scans).filter(s => s.grade >= 9).length})`}</button>}
                {earningsLoading && <span style={{ fontSize: 8, color: "#00b0ff", fontWeight: 700, padding: "3px 6px" }}>📅 Earnings loading...</span>}

                <button onClick={() => {
                  const rows = Object.values(scans).sort((a, b) => b.grade - a.grade);
                  const csv = "Ticker,Grade,Dir,Price,T1,T2,T3,T4,T5,H Divergence,D Divergence,Combined,Bot Right or Wrong\n" + rows.map(s => `${s.ticker},${s.grade},${s.direction},$${s.price},${s.t1},${s.t2},${s.t3},${s.t4},${s.t5},${s.hDiv?.label || "—"},${s.dDiv?.label || "—"},${s.cDiv?.label || "—"},`).join("\n");
                  setCsvText(csv);
                }} style={{ background: "transparent", border: "1px solid #00b0ff44", borderRadius: 4, padding: "3px 8px", color: "#00b0ff", fontFamily: "inherit", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>📋 CSV</button>
                {csvText && <button onClick={() => setCsvText("")} style={{ background: "transparent", border: "1px solid #64748b44", borderRadius: 4, padding: "3px 6px", color: "#64748b", fontFamily: "inherit", fontSize: 8, cursor: "pointer" }}>✕</button>}
                <button onClick={clearScans} style={{ background: "transparent", border: "1px solid #dc262644", borderRadius: 4, padding: "3px 8px", color: "#dc2626", fontFamily: "inherit", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>🗑 CLEAR</button>
              </div>
            </div>
            {/* Regime banner — DISABLED: pure technicals mode */}
            {/* CSV textarea fallback */}
            {csvText && (
              <div style={{ marginBottom: 6, background: "rgba(0,0,0,0.3)", borderRadius: 6, padding: 8 }}>
                <div style={{ fontSize: 8, color: "#00b0ff", fontWeight: 700, marginBottom: 4 }}>CLICK THE TEXT BOX → Ctrl+A (select all) → Ctrl+C (copy) → PASTE TO ME IN CHAT</div>
                <textarea readOnly value={csvText} onClick={e => e.target.select()} style={{ width: "100%", height: 100, background: "#0a0e17", border: "1px solid #00b0ff33", borderRadius: 4, color: "#e2e8f0", fontFamily: "monospace", fontSize: 8, padding: 6, resize: "vertical", outline: "none" }} />
              </div>
            )}
            {/* Filter controls */}
            <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 7, fontWeight: 700, color: "#64748b", letterSpacing: 1 }}>FILTER:</span>
              <select value={filterGrade} onChange={e => setFilterGrade(e.target.value)} style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 3, padding: "2px 4px", color: "#e2e8f0", fontFamily: "inherit", fontSize: 8, outline: "none" }}>
                {["ALL", "7+", "6+", "5+", "≤4"].map(o => <option key={o} value={o}>{o === "ALL" ? "Grade: All" : `Grade ${o}`}</option>)}
              </select>
              <select value={filterDir} onChange={e => setFilterDir(e.target.value)} style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 3, padding: "2px 4px", color: "#e2e8f0", fontFamily: "inherit", fontSize: 8, outline: "none" }}>
                {["ALL", "PUTS", "CALLS", "WAIT"].map(o => <option key={o} value={o}>{o === "ALL" ? "Dir: All" : o}</option>)}
              </select>
              <select value={filterCombined} onChange={e => setFilterCombined(e.target.value)} style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 3, padding: "2px 4px", color: "#e2e8f0", fontFamily: "inherit", fontSize: 8, outline: "none" }}>
                {["ALL", "BOTH BULL", "BOTH BEAR", "CONFLICT", "HRLY ONLY", "DAILY ONLY", "MIXED", "—"].map(o => <option key={o} value={o}>{o === "ALL" ? "Combined: All" : o}</option>)}
              </select>
              {(filterGrade !== "ALL" || filterDir !== "ALL" || filterCombined !== "ALL") && <button onClick={() => { setFilterGrade("ALL"); setFilterDir("ALL"); setFilterCombined("ALL"); }} style={{ background: "transparent", border: "1px solid #64748b33", borderRadius: 3, padding: "2px 6px", color: "#64748b", fontFamily: "inherit", fontSize: 7, cursor: "pointer" }}>✕ Reset</button>}
            </div>
            {/* Table header — click GRD/DIR/COMBINED to sort */}
            <div style={{ display: "grid", gridTemplateColumns: "55px 30px 55px 52px 52px 52px 52px 52px 52px 70px 60px 60px 70px", gap: 2, padding: "4px 6px", background: "rgba(0,0,0,0.3)", borderRadius: 4, marginBottom: 2, minWidth: 700, overflowX: "auto" }}>
              {["TICKER", "GRD", "DIR", "PRICE", "T1", "T2", "T3", "T4", "T5", "EARNINGS", "H DIV", "D DIV", "COMBINED"].map(h => {
                const sortable = h === "GRD" || h === "DIR" || h === "COMBINED";
                const sortKey = h === "GRD" ? "grade" : h === "DIR" ? "dir" : h === "COMBINED" ? "combined" : null;
                const isActive = sortKey && sortCol === sortKey;
                return (
                  <div key={h} onClick={sortable ? () => { if (sortCol === sortKey) setSortAsc(!sortAsc); else { setSortCol(sortKey); setSortAsc(false); } } : undefined}
                    style={{ fontSize: 7, fontWeight: 700, color: isActive ? "#e2e8f0" : h === "EARNINGS" ? "#00b0ff" : h.includes("DIV") || h === "COMBINED" ? "#a78bfa" : "#64748b", textTransform: "uppercase", letterSpacing: 0.5, cursor: sortable ? "pointer" : "default", userSelect: "none" }}>
                    {h}{isActive ? (sortAsc ? " ▲" : " ▼") : ""}
                  </div>
                );
              })}
            </div>
            {/* Table rows — filtered & sorted */}
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              {(() => {
                let rows = Object.values(scans);
                // Filter
                if (filterDir !== "ALL") rows = rows.filter(s => s.direction === filterDir);
                if (filterGrade === "7+") rows = rows.filter(s => s.grade >= 7);
                else if (filterGrade === "6+") rows = rows.filter(s => s.grade >= 6);
                else if (filterGrade === "5+") rows = rows.filter(s => s.grade >= 5);
                else if (filterGrade === "≤4") rows = rows.filter(s => s.grade <= 4);
                if (filterCombined !== "ALL") rows = rows.filter(s => (s.cDiv?.label || "—") === filterCombined);
                // Sort
                const dir = sortAsc ? 1 : -1;
                if (sortCol === "grade") rows.sort((a, b) => dir * (a.grade - b.grade));
                else if (sortCol === "dir") rows.sort((a, b) => dir * (a.direction || "").localeCompare(b.direction || ""));
                else if (sortCol === "combined") rows.sort((a, b) => dir * ((a.cDiv?.label || "—").localeCompare(b.cDiv?.label || "—")));
                return rows.map(s => {
                const dc = s.direction === "CALLS" ? "#00e676" : s.direction === "PUTS" ? "#ff1744" : "#ffd600";
                return (
                  <div key={s.ticker} onDoubleClick={() => loadScan(s.ticker)} title={rawDataRef.current[s.ticker] ? `Double-click to open ${s.ticker} full analysis` : `${s.ticker}: re-upload to enable full view`} style={{ display: "grid", gridTemplateColumns: "55px 30px 55px 52px 52px 52px 52px 52px 52px 70px 60px 60px 70px", gap: 2, padding: "4px 6px", borderBottom: "1px solid #1e293b11", fontSize: 10, cursor: "pointer", transition: "background 0.15s", minWidth: 700 }} onMouseEnter={e => e.currentTarget.style.background = "rgba(124,58,237,0.08)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <div style={{ fontWeight: 800, color: "#e2e8f0" }}>{s.ticker}</div>
                    <div style={{ fontWeight: 800, color: s.grade >= 7 ? "#00e676" : s.grade >= 5 ? "#ffd600" : "#ff1744" }}>{s.grade}</div>
                    <div style={{ fontWeight: 700, color: dc, fontSize: 9 }}>{s.isReversal ? "🔄" : ""}{s.direction === "CALLS" ? "📈CALL" : s.direction === "PUTS" ? "📉PUT" : "⏸WAIT"}</div>
                    <div style={{ color: "#94a3b8" }}>${s.price}</div>
                    <div style={{ color: "#cbd5e1" }}>${s.t1}</div>
                    <div style={{ color: "#cbd5e1" }}>${s.t2}</div>
                    <div style={{ color: "#cbd5e1" }}>${s.t3}</div>
                    <div style={{ color: "#cbd5e1" }}>${s.t4}</div>
                    <div style={{ color: "#cbd5e1" }}>${s.t5}</div>
                    <div style={{ fontSize: 7, lineHeight: 1.4 }}>{s.grade >= 9 && earningsDates[s.ticker] ? (() => {
                      const ed = earningsDates[s.ticker];
                      const isObj = typeof ed === "object" && ed.date;
                      const dateStr = isObj ? ed.date : ed;
                      const parsed = new Date(dateStr.replace(/just reported/i, "").trim());
                      const daysUntil = !isNaN(parsed.getTime()) ? Math.round((parsed - new Date()) / (1000 * 60 * 60 * 24)) : null;
                      const isJust = dateStr.toLowerCase().includes("just");
                      const beatIcon = isObj ? (ed.beat === "likely" || ed.beat === "beat" ? "✅" : ed.beat === "unlikely" || ed.beat === "miss" ? "❌" : "❓") : "";
                      const recIcon = isObj ? (ed.reception === "positive" ? "📈" : ed.reception === "negative" ? "📉" : "➡️") : "";
                      const dirIcon = isObj && ed.postEarningsDir ? (ed.postEarningsDir === "up" ? "🟢" : ed.postEarningsDir === "down" ? "🔴" : "🟡") : "";
                      const sentIcon = isObj && ed.sentiment ? (ed.sentiment === "bullish" ? "🐂" : ed.sentiment === "bearish" ? "🐻" : "➖") : "";
                      const showPrediction = isObj && daysUntil !== null && daysUntil >= 1 && daysUntil <= 21 && ed.postEarningsDir;
                      const fullTooltip = isObj ? [
                        `Beat: ${ed.beat} — ${ed.reason || ""}`,
                        `Reception: ${ed.reception} — ${ed.receptionReason || ""}`,
                        ed.postEarningsDir ? `Post-earnings: ${ed.postEarningsDir.toUpperCase()} — ${ed.postEarningsWhy || ""}` : "",
                        ed.sentiment ? `Sentiment: ${ed.sentiment} — ${ed.sentimentWhy || ""}` : "",
                      ].filter(Boolean).join("\n") : "";
                      return (<div title={fullTooltip}>
                        <div style={{ color: isJust ? "#f59e0b" : "#00b0ff", fontWeight: 700 }}>{dateStr.replace(/,?\s*\d{4}$/, "")}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
                          <span style={{ color: daysUntil <= 5 ? "#ff1744" : daysUntil <= 14 ? "#f59e0b" : "#64748b", fontWeight: 700 }}>{isJust ? "done" : `${daysUntil}d`}</span>
                          {beatIcon && <span>{beatIcon}</span>}
                          {recIcon && <span>{recIcon}</span>}
                        </div>
                        {showPrediction && <div style={{ marginTop: 1, display: "flex", alignItems: "center", gap: 2 }}>
                          <span>{dirIcon}</span>
                          <span style={{ color: ed.postEarningsDir === "up" ? "#00e676" : ed.postEarningsDir === "down" ? "#ff1744" : "#ffd600", fontWeight: 700 }}>{ed.postEarningsDir.toUpperCase()}</span>
                          <span>{sentIcon}</span>
                        </div>}
                      </div>);
                    })() : s.grade >= 9 ? "—" : ""}</div>
                    <div title={s.hDiv?.detail || ""} style={{ fontSize: 7, fontWeight: 700, color: s.hDiv?.type === "bullish" ? "#00e676" : s.hDiv?.type === "bearish" ? "#ff1744" : s.hDiv?.type === "mixed" ? "#ffd600" : "#64748b" }}>{s.hDiv?.label || "—"}</div>
                    <div title={s.dDiv?.detail || ""} style={{ fontSize: 7, fontWeight: 700, color: s.dDiv?.type === "bullish" ? "#00e676" : s.dDiv?.type === "bearish" ? "#ff1744" : s.dDiv?.type === "mixed" ? "#ffd600" : "#64748b" }}>{s.dDiv?.label || "—"}</div>
                    <div title={s.cDiv?.detail || ""} style={{ fontSize: 7, fontWeight: 700, color: s.cDiv?.color || "#64748b" }}>{s.cDiv?.label || "—"}</div>
                  </div>
                );
              });
              })()}
            </div>
            <div style={{ fontSize: 8, color: "#64748b", textAlign: "center", marginTop: 6, fontStyle: "italic" }}>Double-click any row to open full analysis</div>
            {/* Batch AI progress */}
            {batchAIProgress && <div style={{ fontSize: 10, color: batchAIProgress.startsWith("✅") ? "#00e676" : "#f59e0b", textAlign: "center", marginTop: 6, fontWeight: 700 }}>{batchAIProgress}</div>}
            {/* Batch AI results */}
            {Object.keys(batchAIResults).length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: "#f59e0b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>🤖 AI Analysis — Grade 9+ Tickers</div>
                {Object.entries(batchAIResults).sort((a, b) => (scans[b[0]]?.grade || 0) - (scans[a[0]]?.grade || 0)).map(([tkr, text]) => (
                  <div key={tkr} style={{ background: "rgba(0,0,0,0.3)", border: "1px solid #f59e0b22", borderRadius: 6, padding: "8px 10px", marginBottom: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, fontWeight: 900, color: "#e2e8f0" }}>{tkr}</span>
                      <span style={{ fontSize: 9, color: "#00e676", fontWeight: 700 }}>Grade {scans[tkr]?.grade || "?"} · {scans[tkr]?.direction || ""}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "#cbd5e1", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflowY: "auto" }}>
                      {text.split("**").map((p, i) => i % 2 === 1 ? <strong key={i} style={{ color: "#e2e8f0", display: "block", marginTop: 4, fontSize: 11 }}>{p}</strong> : <span key={i}>{p}</span>)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── SINGLE MODE UPLOADS ── */}
        {!batchMode && <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <UB label="📅 Daily" fr={dR} data={dD} cols={dC} type="daily" color="#00b0ff" />
          <UB label="⏰ Hourly+VWAP" fr={hR} data={hD} cols={hC} type="hourly" color="#ffd600" />
        </div>}
        {!batchMode && (!dD || !hD) && <div style={{ padding: 8, background: "rgba(17,24,39,0.5)", border: "1px solid #1e293b", borderRadius: 6, fontSize: 10, color: "#94a3b8", textAlign: "center" }}>Upload both CSVs.</div>}
        {err && <div style={{ background: "#7f1d1d33", border: "1px solid #dc2626", borderRadius: 6, padding: 6, fontSize: 10, color: "#fca5a5" }}>{err}</div>}

        {an && t && (<>
          {/* HERO */}
          <Card accent={t.direction === "CALLS" ? "#00e676" : t.direction === "PUTS" ? "#ff1744" : "#ffd600"}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 900, color: t.actionNow.includes("YES") || t.actionNow.includes("GAP FILL") ? "#00e676" : t.actionNow.includes("WAIT") ? "#ffd600" : "#ff1744" }}>{t.actionNow}</div>
                <div style={{ fontSize: 10, color: "#94a3b8" }}>{t.reversalInfo?.isReversal ? "🔄 " : ""}{t.bias} · {t.direction === "CALLS" ? "📈 CALLS" : t.direction === "PUTS" ? "📉 PUTS" : "⏸"}</div>
                {t.categories && <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 8, padding: "2px 5px", borderRadius: 3, background: "#7c3aed22", color: "#a78bfa", fontWeight: 700 }}>T:{t.categories.trend}/3</span>
                  <span style={{ fontSize: 8, padding: "2px 5px", borderRadius: 3, background: t.categories.entry >= 1.5 ? "#00e67622" : t.categories.entry >= 0.5 ? "#ffd60022" : "#ff174422", color: t.categories.entry >= 1.5 ? "#00e676" : t.categories.entry >= 0.5 ? "#ffd600" : "#ff1744", fontWeight: 700 }}>E:{t.categories.entry}/5</span>
                  <span style={{ fontSize: 8, padding: "2px 5px", borderRadius: 3, background: "#00b0ff22", color: "#00b0ff", fontWeight: 700 }}>C:{t.categories.confirm}/3</span>
                  {t.categories.late > 0 && <span style={{ fontSize: 8, padding: "2px 5px", borderRadius: 3, background: "#ff174422", color: "#ff1744", fontWeight: 700 }}>LATE:-{t.categories.late}</span>}
                </div>}
              </div>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 38, fontWeight: 900, color: gc(t.grade), lineHeight: 1 }}>{t.grade}</div><div style={{ fontSize: 8, color: "#64748b" }}>/10</div></div>
            </div>
            <div style={{ marginTop: 4, fontSize: 10, color: "#cbd5e1", padding: "4px 8px", background: "rgba(0,0,0,0.2)", borderRadius: 4 }}>{t.alignment}</div>
            <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 2 }}>{t.confidence}</div>
          </Card>

          {/* ═══ SAFEGUARD WARNINGS ═══ */}
          {t.extremeWarning && (
            <Card accent={t.extremeWarning.severity === "critical" ? "#ff1744" : "#ff9800"} title={t.extremeWarning.type === "oversold_bounce" ? "🚨 Oversold Snap-Back Risk" : "🚨 Overbought Reversal Risk"}>
              <div style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.6, whiteSpace: "pre-wrap", background: "rgba(255,23,68,0.08)", padding: 10, borderRadius: 5 }}>{t.extremeWarning.text}</div>
            </Card>
          )}
          {t.earningsAdj && (
            <Card accent={t.earningsAdj.effect === "tailwind" ? "#00e676" : t.earningsAdj.effect === "headwind" ? "#ff9800" : "#00b0ff"} title={`📅 Earnings — ${t.earningsAdj.effect === "tailwind" ? "Potential Tailwind" : t.earningsAdj.effect === "headwind" ? "Potential Headwind" : t.earningsAdj.effect === "warning" ? "Binary Event Risk" : "Noted"}`}>
              <div style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.6, whiteSpace: "pre-wrap", background: t.earningsAdj.effect === "tailwind" ? "rgba(0,230,118,0.08)" : t.earningsAdj.effect === "headwind" ? "rgba(255,152,0,0.08)" : "rgba(0,176,255,0.08)", padding: 10, borderRadius: 5 }}>{t.earningsAdj.text}</div>
            </Card>
          )}
          {t.rsiCap && (
            <Card accent="#ff6d00" title="⛔ Grade Capped — RSI Extreme">
              <div style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.6, whiteSpace: "pre-wrap", background: "rgba(255,109,0,0.08)", padding: 10, borderRadius: 5 }}>{t.rsiCap.text}</div>
            </Card>
          )}

          {/* Regime card — DISABLED: pure technicals mode */}

          {t.reversalInfo?.isReversal && (
            <Card accent="#f59e0b" title={`🔄 Reversal Detected — ${t.reversalInfo.confidence} Confidence`}>
              <div style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.6, whiteSpace: "pre-wrap", background: "rgba(245,158,11,0.06)", padding: 10, borderRadius: 5, marginBottom: 8 }}>{t.reversalInfo.explanation}</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {t.reversalInfo.signals.map((s, i) => (
                  <span key={i} style={{ display: "inline-block", padding: "3px 8px", borderRadius: 4, fontSize: 9, fontWeight: 700, background: s.bull ? "#00e67615" : "#ff174415", color: s.bull ? "#00e676" : "#ff1744", border: `1px solid ${s.bull ? "#00e67633" : "#ff174433"}` }}>{s.bull ? "▲" : "▼"} {s.text.split("—")[0].trim()} (+{s.weight})</span>
                ))}
              </div>
            </Card>
          )}

          {/* SUMMARY */}
          <Card accent="#7c3aed" title="📋 Summary">
            <div style={{ display: "grid", gap: 8 }}>
              {/* Gaps */}
              <div style={{ padding: "6px 10px", background: "rgba(245,158,11,0.06)", border: "1px solid #f59e0b33", borderRadius: 5 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: "#f59e0b", letterSpacing: 1, marginBottom: 3 }}>GAPS ({">"}$6)</div>
                <div style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{t.summary.gapSummary}</div>
              </div>
              {/* Direction + 3 targets */}
              <div style={{ padding: "6px 10px", background: t.direction === "CALLS" ? "#00e67608" : t.direction === "PUTS" ? "#ff174408" : "#ffd60008", border: `1px solid ${t.direction === "CALLS" ? "#00e67633" : t.direction === "PUTS" ? "#ff174433" : "#ffd60033"}`, borderRadius: 5 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: t.direction === "CALLS" ? "#00e676" : t.direction === "PUTS" ? "#ff1744" : "#ffd600", letterSpacing: 1, marginBottom: 3 }}>RECOMMENDATION</div>
                <div style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.5 }}>{t.summary.dirSummary}</div>
              </div>
              {/* Key S/R */}
              <div style={{ padding: "6px 10px", background: "rgba(0,176,255,0.06)", border: "1px solid #00b0ff33", borderRadius: 5 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: "#00b0ff", letterSpacing: 1, marginBottom: 3 }}>KEY LEVELS TO WATCH</div>
                <div style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.5 }}>{t.summary.keySR}</div>
              </div>
              {/* Trend / Range */}
              <div style={{ padding: "6px 10px", background: t.summary.trendRange.breakout ? "rgba(255,23,68,0.06)" : "rgba(124,58,237,0.06)", border: `1px solid ${t.summary.trendRange.breakout ? "#ff174433" : "#7c3aed33"}`, borderRadius: 5 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: t.summary.trendRange.breakout ? "#ff1744" : "#7c3aed", letterSpacing: 1, marginBottom: 3 }}>TREND / RANGE</div>
                <div style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{t.summary.trendSummary}</div>
              </div>
            </div>
          </Card>

          {/* Prices */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5, marginBottom: 8 }}>
            {[["ENTRY", t.entry.price, "#00b0ff"], ["T1", t.targets[0]?.price?.toFixed(2) || "—", "#00e676"], ["STOP", t.stop.price, "#ff1744"]].map(([l, v, c]) => (
              <div key={l} style={{ background: "rgba(17,24,39,0.8)", border: `1px solid ${c}`, borderRadius: 6, padding: 8, textAlign: "center" }}><div style={{ fontSize: 8, color: c, fontWeight: 700 }}>{l}</div><div style={{ fontSize: 18, fontWeight: 900 }}>${v}</div></div>
            ))}
          </div>

          {/* Mini targets */}
          {t.targets.length > 0 && <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            {t.targets.map((tgt, i) => (
              <div key={i} style={{ flex: 1, background: i === 0 ? (t.direction === "CALLS" ? "#00e67612" : "#ff174412") : "rgba(17,24,39,0.6)", border: `1px solid ${i === 0 ? (t.direction === "CALLS" ? "#00e67633" : "#ff174433") : "#1e293b"}`, borderRadius: 5, padding: "5px 4px", textAlign: "center" }}>
                <div style={{ fontSize: 7, color: "#64748b" }}>T{tgt.num}</div>
                <div style={{ fontSize: 13, fontWeight: 800 }}>${tgt.price.toFixed(2)}</div>
                <div style={{ fontSize: 8, color: parseFloat(tgt.pct) > 0 ? "#00e676" : "#ff1744" }}>{parseFloat(tgt.pct) > 0 ? "+" : ""}{tgt.pct}%</div>
                {tgt.source === "gap" && <div style={{ fontSize: 6, color: "#f59e0b" }}>GAP</div>}
                {tgt.source === "fib" && <div style={{ fontSize: 6, color: "#a78bfa" }}>FIB</div>}
                {tgt.source === "pattern" && <div style={{ fontSize: 6, color: "#ff6d00" }}>PATTERN</div>}
              </div>
            ))}
          </div>}

          {/* Charts */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
            <div style={{ background: "rgba(17,24,39,0.5)", border: "1px solid #1e293b", borderRadius: 6, padding: 6 }}><PriceChart data={dD} label="Daily" gaps={t.gapCtx?.allGaps} /><RSIChart data={dD} /></div>
            <div style={{ background: "rgba(17,24,39,0.5)", border: "1px solid #1e293b", borderRadius: 6, padding: 6 }}><PriceChart data={hD} label="Hourly" showVWAP /><RSIChart data={hD} /></div>
          </div>

          <div style={{ display: "flex", gap: 3, marginBottom: 8, borderBottom: "1px solid #1e293b", paddingBottom: 4, flexWrap: "wrap" }}>
            {tabs.map(tb => <button key={tb.id} onClick={() => setTab(tb.id)} style={{ background: tab === tb.id ? "#00e67622" : "transparent", border: `1px solid ${tab === tb.id ? "#00e676" : "transparent"}`, borderRadius: 5, padding: "4px 10px", color: tab === tb.id ? "#00e676" : "#64748b", fontSize: 10, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" }}>{tb.l}</button>)}
          </div>

          {tab === "trade" && (<div>
            <Card title="Entry" accent="#00b0ff"><div style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{t.entryDetail}</div></Card>
            <Card title="Stop" accent="#ff1744"><div style={{ fontSize: 11, color: "#e2e8f0" }}>{t.stop.explanation}</div></Card>
            <Card title="Factors" accent={gc(t.grade)}>
              {t.gapCtx.gapFillAdj !== 0 && <div style={{ padding: "4px 8px", marginBottom: 6, background: "#f59e0b12", border: "1px solid #f59e0b33", borderRadius: 4, fontSize: 10 }}><span style={{ color: "#f59e0b", fontWeight: 700 }}>Gap Adj:</span> <span style={{ color: "#e2e8f0" }}>{t.gapCtx.gapFillAdj > 0 ? "+" : ""}{t.gapCtx.gapFillAdj} to daily score (orig {t.daily.origScore} → adj {t.daily.score})</span></div>}
              {t.extremeWarning && <div style={{ padding: "4px 8px", marginBottom: 6, background: "#ff174412", border: "1px solid #ff174433", borderRadius: 4, fontSize: 10 }}><span style={{ color: "#ff1744", fontWeight: 700 }}>🚨 RSI Extreme:</span> <span style={{ color: "#e2e8f0" }}>Grade {t.extremeWarning.gradeAdj} ({t.extremeWarning.type === "oversold_bounce" ? "oversold snap-back risk" : "overbought reversal risk"})</span></div>}
              {t.earningsAdj && <div style={{ padding: "4px 8px", marginBottom: 6, background: t.earningsAdj.effect === "tailwind" ? "#00e67612" : t.earningsAdj.effect === "headwind" ? "#ff980012" : "#00b0ff12", border: `1px solid ${t.earningsAdj.effect === "tailwind" ? "#00e67633" : t.earningsAdj.effect === "headwind" ? "#ff980033" : "#00b0ff33"}`, borderRadius: 4, fontSize: 10 }}><span style={{ color: t.earningsAdj.effect === "tailwind" ? "#00e676" : t.earningsAdj.effect === "headwind" ? "#ff9800" : "#00b0ff", fontWeight: 700 }}>📅 Earnings ({t.earningsAdj.daysUntil}d):</span> <span style={{ color: "#e2e8f0" }}>{t.earningsAdj.effect}</span></div>}
              {t.rsiCap && <div style={{ padding: "4px 8px", marginBottom: 6, background: "#ff6d0012", border: "1px solid #ff6d0033", borderRadius: 4, fontSize: 10 }}><span style={{ color: "#ff6d00", fontWeight: 700 }}>⛔ Grade Cap:</span> <span style={{ color: "#e2e8f0" }}>Capped at 7 (was {t.rsiCap.cappedFrom}) — RSI extreme</span></div>}
              {t.divAdj && <div style={{ padding: "4px 8px", marginBottom: 6, background: "#f59e0b12", border: "1px solid #f59e0b33", borderRadius: 4, fontSize: 10 }}><span style={{ color: "#f59e0b", fontWeight: 700 }}>⚠️ Div Conflict:</span> <span style={{ color: "#e2e8f0" }}>{t.divAdj.gradeAdj > 0 ? "+" : ""}{t.divAdj.gradeAdj} — RSI divergence opposes {t.direction}</span></div>}
              {t.reversalInfo?.isReversal && <div style={{ padding: "4px 8px", marginBottom: 6, background: "#f59e0b12", border: "1px solid #f59e0b33", borderRadius: 4, fontSize: 10 }}><span style={{ color: "#f59e0b", fontWeight: 700 }}>🔄 Reversal:</span> <span style={{ color: "#e2e8f0" }}>{t.reversalInfo.signals.length} signals, score {t.reversalInfo.score} ({t.reversalInfo.confidence})</span></div>}
              {t.patternAdj && <div style={{ padding: "4px 8px", marginBottom: 6, background: t.patternAdj.adj > 0 ? "#00e67612" : "#ff174412", border: `1px solid ${t.patternAdj.adj > 0 ? "#00e67633" : "#ff174433"}`, borderRadius: 4, fontSize: 10 }}><span style={{ color: t.patternAdj.adj > 0 ? "#00e676" : "#ff1744", fontWeight: 700 }}>{t.patternAdj.adj > 0 ? "📈" : "📉"} Pattern:</span> <span style={{ color: "#e2e8f0" }}>{t.patternAdj.adj > 0 ? "+" : ""}{t.patternAdj.adj} — {t.patternAdj.note}</span></div>}
              <div style={{ fontSize: 9, fontWeight: 700, color: "#00b0ff", marginBottom: 3 }}>DAILY</div>
              {["trend","entry","confirm","late"].map(cat => {
                const catFactors = t.daily.factors.filter(f => f.cat === cat);
                if (!catFactors.length) return null;
                const catLabel = cat === "trend" ? "📊 TREND" : cat === "entry" ? "🎯 ENTRY" : cat === "confirm" ? "✅ CONFIRM" : "⚠ LATE";
                const catColor = cat === "trend" ? "#7c3aed" : cat === "entry" ? "#f59e0b" : cat === "confirm" ? "#00b0ff" : "#ff1744";
                return <div key={"dc"+cat} style={{ marginBottom: 4 }}><div style={{ fontSize: 8, fontWeight: 700, color: catColor, marginBottom: 1 }}>{catLabel}</div>{catFactors.map((f, i) => <div key={"d"+cat+i} style={{ display: "flex", gap: 4, padding: "1px 0", fontSize: 10 }}><span style={{ color: f.bull ? "#00e676" : "#ff1744" }}>{f.bull ? "▲" : "▼"}</span><span style={{ color: "#cbd5e1" }}>{f.text}</span></div>)}</div>;
              })}
              <div style={{ fontSize: 9, fontWeight: 700, color: "#ffd600", marginTop: 6, marginBottom: 3 }}>HOURLY</div>
              {["trend","entry","confirm","late"].map(cat => {
                const catFactors = t.hourly.factors.filter(f => f.cat === cat);
                if (!catFactors.length) return null;
                const catLabel = cat === "trend" ? "📊 TREND" : cat === "entry" ? "🎯 ENTRY" : cat === "confirm" ? "✅ CONFIRM" : "⚠ LATE";
                const catColor = cat === "trend" ? "#7c3aed" : cat === "entry" ? "#f59e0b" : cat === "confirm" ? "#00b0ff" : "#ff1744";
                return <div key={"hc"+cat} style={{ marginBottom: 4 }}><div style={{ fontSize: 8, fontWeight: 700, color: catColor, marginBottom: 1 }}>{catLabel}</div>{catFactors.map((f, i) => <div key={"h"+cat+i} style={{ display: "flex", gap: 4, padding: "1px 0", fontSize: 10 }}><span style={{ color: f.bull ? "#00e676" : "#ff1744" }}>{f.bull ? "▲" : "▼"}</span><span style={{ color: "#cbd5e1" }}>{f.text}</span></div>)}</div>;
              })}
            </Card>
          </div>)}

          {tab === "targets" && (<div>
            <Card title={`5 ${t.direction || ""} Targets`} accent={t.direction === "CALLS" ? "#00e676" : t.direction === "PUTS" ? "#ff1744" : "#ffd600"}>
              <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 8 }}>T1 is always a concrete S/R, SMA, or gap level. VWAP bands marked as expandable.</div>
              {t.targets.map((tgt, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", marginBottom: 5, background: i === 0 ? (t.direction === "CALLS" ? "#00e67610" : "#ff174410") : "rgba(0,0,0,0.2)", border: `1px solid ${i === 0 ? (t.direction === "CALLS" ? "#00e67633" : "#ff174433") : "#1e293b"}`, borderRadius: 6 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 5, background: i === 0 ? "#00e67622" : "#1e293b", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 13, color: i === 0 ? "#00e676" : "#64748b", flexShrink: 0 }}>T{tgt.num}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span style={{ fontSize: 18, fontWeight: 900 }}>${tgt.price.toFixed(2)}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: parseFloat(tgt.pct) > 0 ? "#00e676" : "#ff1744" }}>{parseFloat(tgt.pct) > 0 ? "+" : ""}{tgt.pct}%</span>
                      {tgt.source === "gap" && <Badge color="#f59e0b">GAP LEVEL</Badge>}
                      {tgt.source === "fib" && <Badge color="#a78bfa">FIB LEVEL</Badge>}
                      {tgt.source === "pattern" && <Badge color="#ff6d00">PATTERN TARGET</Badge>}
                      {tgt.source === "vwap_band" && <Badge color="#f59e0b">VWAP BAND</Badge>}
                      {tgt.label.includes("confluent") && <Badge color="#7c3aed">CONFLUENT</Badge>}
                      {tgt.reachability && <Badge color={tgt.reachability === "high" ? "#00e676" : tgt.reachability === "medium" ? "#ffd600" : tgt.reachability === "low" ? "#ff9800" : "#ff1744"}>{tgt.atrDist}x ATR · {tgt.reachability.toUpperCase()}</Badge>}
                    </div>
                    <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 1 }}>{tgt.label}</div>
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 9, color: "#64748b", marginTop: 6, padding: "6px 8px", background: "rgba(0,0,0,0.2)", borderRadius: 4, lineHeight: 1.5 }}>
                T1: Take 30-50% · T2-T3: Scale out 25% each · T4-T5: Runners only on volume confirmation · GAP targets are high-probability magnets
              </div>
            </Card>
          </div>)}

          {tab === "gaps" && (<div>
            <Card title="Gap Map — All Detected Gaps" accent="#f59e0b">
              <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 8 }}>Gaps detected from daily chart data. Unfilled gaps act as price magnets.</div>
              {t.gapCtx?.allGaps?.length === 0 && <div style={{ fontSize: 11, color: "#64748b" }}>No gaps detected (min 0.4% gap required).</div>}
              {t.gapCtx?.allGaps?.map((g, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", marginBottom: 4, background: g.filled ? "rgba(0,0,0,0.15)" : "rgba(245,158,11,0.08)", border: `1px solid ${g.filled ? "#1e293b" : "#f59e0b33"}`, borderRadius: 5 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: g.type === "GAP UP" ? "#00e676" : "#ff1744", flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: g.type === "GAP UP" ? "#00e676" : "#ff1744" }}>{g.type}</span>
                      <span style={{ fontSize: 10, color: "#94a3b8" }}>{g.prevDate} → {g.date}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#e2e8f0" }}>${g.gapBottom.toFixed(2)} — ${g.gapTop.toFixed(2)}</span>
                      <span style={{ fontSize: 9, color: "#64748b" }}>({g.gapPct}%)</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                      {g.filled ? <Badge color="#64748b">FILLED on {g.fillDate}</Badge> : <Badge color="#f59e0b">UNFILLED ({g.partialFill}% partial)</Badge>}
                      {!g.filled && Math.abs(g.gapTop - parseFloat(t.price)) / parseFloat(t.price) < 0.03 && <Badge color="#ff1744">NEARBY</Badge>}
                      {!g.filled && parseFloat(t.price) >= g.gapBottom && parseFloat(t.price) <= g.gapTop && <Badge color="#f59e0b">PRICE INSIDE GAP</Badge>}
                    </div>
                  </div>
                </div>
              ))}
            </Card>
            {t.gapCtx?.explanation && <Card title="Gap Context — What It Means" accent="#f59e0b"><div style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{t.gapCtx.explanation}</div></Card>}
          </div>)}

          {tab === "levels" && (<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <Card title="Daily Support" accent="#00e676">{an.dSR.support.map((s, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", fontSize: 11 }}><span style={{ color: "#00e676", fontWeight: 700 }}>${s.avg.toFixed(2)}</span><span style={{ color: "#64748b" }}>{s.touches}x</span></div>)}</Card>
            <Card title="Daily Resistance" accent="#ff1744">{an.dSR.resistance.map((r, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", fontSize: 11 }}><span style={{ color: "#ff1744", fontWeight: 700 }}>${r.avg.toFixed(2)}</span><span style={{ color: "#64748b" }}>{r.touches}x</span></div>)}</Card>
          </div>)}

          {tab === "patterns" && (<div>
            {[...an.dPat, ...an.hPat].map((p, i) => <Card key={i} title={p.name} accent={p.bias.includes("Bullish") || p.bias.includes("Oversold") || p.bias.includes("bounce") ? "#00e676" : p.bias.includes("Bearish") || p.bias.includes("Overbought") ? "#ff1744" : "#ffd600"}><Badge color={p.bias.includes("Bullish") ? "#00e676" : p.bias.includes("Bearish") ? "#ff1744" : "#ffd600"}>{p.bias}</Badge><Badge color="#00b0ff">{p.confidence}</Badge>{p.detail && <div style={{ fontSize: 10, color: "#cbd5e1", marginTop: 4, lineHeight: 1.5 }}>{p.detail}</div>}</Card>)}
          </div>)}

          {tab === "ai" && (<div>
            <Card title="AI" accent="#7c3aed">
              {!ticker && <div style={{ fontSize: 10, color: "#fbbf24", marginBottom: 4 }}>Enter ticker.</div>}
              <button onClick={fetchAI} disabled={aiL} style={{ background: aiL ? "#1e293b" : "linear-gradient(135deg,#7c3aed,#00b0ff)", border: "none", borderRadius: 6, padding: "8px 16px", color: "#fff", fontFamily: "inherit", fontSize: 11, fontWeight: 700, cursor: aiL ? "wait" : "pointer", width: "100%" }}>{aiL ? "⏳..." : "🔍 Run AI"}</button>
            </Card>
            {ai && <Card title="Results" accent="#7c3aed"><div style={{ fontSize: 11, color: "#cbd5e1", lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{ai.split("**").map((p, i) => i % 2 === 1 ? <strong key={i} style={{ color: "#e2e8f0", display: "block", marginTop: 6, fontSize: 12 }}>{p}</strong> : <span key={i}>{p}</span>)}</div></Card>}
          </div>)}

          <div style={{ textAlign: "center", marginTop: 10 }}>
            <button onClick={() => { setDD(null); setHD(null); setDC(null); setHC(null); setAn(null); setAI(""); setErr(""); setBatchLog([]); }} style={{ background: "transparent", border: "1px solid #1e293b", borderRadius: 5, padding: "4px 12px", color: "#64748b", fontFamily: "inherit", fontSize: 9, cursor: "pointer" }}>RESET</button>
          </div>
        </>)}
      </div>}
    </div>);
}
