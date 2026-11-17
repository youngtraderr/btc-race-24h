
import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 8;
const SLOW_BARS = 21;
const MAX_SLIPPAGE_BPS = 100;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  gap: number | null;
  now: number | null;
}

const series = new Map<string, Series>();

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = { fast: { span: FAST_BARS, warm: [], value: null }, slow: { span: SLOW_BARS, warm: [], value: null }, gap: null, now: null };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  step(s.fast, c);
  step(s.slow, c);
  s.gap = s.now;
  s.now = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  return s;
}

await runBars({
  onBatch(state, batch) {
    const crossUp = new Set<string>();
    const crossDown = new Set<string>();
    for (const bar of batch.bars) {
      const s = push(bar);
      if (s.gap === null || s.now === null) continue;
      if (s.now > 0 && s.gap <= 0) crossUp.add(bar.symbol);
      if (s.now < 0 && s.gap >= 0) crossDown.add(bar.symbol);
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (crossDown.has(symbol)) sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      } else if (crossUp.has(symbol)) entries.push(symbol);
    }
    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake;
      if (cash < slice) slice = cash;
      if (slice < BigInt(fees.min_notional_quote_units)) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
