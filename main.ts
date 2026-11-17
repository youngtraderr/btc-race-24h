import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const MAX_SLIPPAGE_BPS = 100;
const TAKE_PROFIT_BPS = 120;  // 1.2%
const TRAILING_STOP_BPS = 800; // 8%
const REBUY_DROP_BPS = 50;    // 0.5%

const series = new Map<string, Series>();

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  ema: Ema;
  peak: bigint;
  entryPrice: bigint;
  lastSellPrice: bigint;
  cooldownBars: number;
  invested: boolean;
}

function stepEma(e: Ema, close: number): void {
  const c = Number(close);
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (c - e.value);
    return;
  }
  e.warm.push(c);
  if (e.warm.length === e.span) {
    const sum = e.warm.reduce((a, x) => a + x, 0);
    e.value = sum / e.span;
  }
}

function initSeries(): Series {
  return { 
    ema: { span: 8, warm: [], value: null }, 
    peak: 0n, 
    entryPrice: 0n, 
    lastSellPrice: 0n, 
    cooldownBars: 0,
    invested: false 
  };
}

function processBar(s: Series, close: bigint, isHolding: boolean): { buy: boolean; sell: boolean } {
  stepEma(s.ema, Number(close));
  let buy = false;
  let sell = false;

  if (!isHolding) {
    if (s.ema.value !== null) {
      if (s.lastSellPrice === 0n) {
        // Initial buy
        buy = true;
        s.entryPrice = close;
        s.peak = close;
        s.invested = true;
      } else {
        // Rebuy check: price dropped REBUY_DROP_BPS below lastSellPrice
        const rebuyThreshold = s.lastSellPrice - BigInt(Math.floor(Number(s.lastSellPrice) * REBUY_DROP_BPS / 10000));
        if (close <= rebuyThreshold && s.cooldownBars === 0) {
          buy = true;
          s.entryPrice = close;
          s.peak = close;
          s.invested = true;
        }
      }
    }
  } else {
    // Holding: check take profit and trailing stop
    if (close > s.peak) {
      s.peak = close;
    }
    
    // Take profit check
    const tpThreshold = s.entryPrice + BigInt(Math.floor(Number(s.entryPrice) * TAKE_PROFIT_BPS / 10000));
    if (close >= tpThreshold) {
      sell = true;
      s.lastSellPrice = close;
      s.cooldownBars = 5;
      s.invested = false;
    } else if (s.peak > 0n) {
      // Trailing stop check
      const stopLevel = s.peak - BigInt(Math.floor(Number(s.peak) * TRAILING_STOP_BPS / 10000));
      if (close <= stopLevel) {
        sell = true;
        s.lastSellPrice = close;
        s.cooldownBars = 5;
        s.invested = false;
      }
    }
  }
  return { buy, sell };
}

await runBars({
  onHello() {},
  onBatch(state, batch) {
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const buySymbols: string[] = [];

    for (const { symbol } of state.hello.symbols) {
      const held = state.positions.get(symbol);
      if (!series.has(symbol)) series.set(symbol, initSeries());
      const s = series.get(symbol)!;
      const closeVal = state.close(symbol);
      if (closeVal === null) continue;
      const { buy: buyResult, sell: sellResult } = processBar(s, closeVal, held !== undefined);

      if (held !== undefined && sellResult) {
        sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      } else if (held === undefined && buyResult) {
        buySymbols.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = [...sells];
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    let room = slots - state.positions.size;

    for (const symbol of buySymbols) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      const byWeight = state.equity * BigInt(caps.max_weight_bps) / BPS;
      const maxNotional = state.cash < byWeight ? state.cash : byWeight;
      if (maxNotional >= BigInt(fees.min_notional_quote_units)) {
        orders.push({ side: 'buy', symbol, notional_quote_units: maxNotional, max_slippage_bps: MAX_SLIPPAGE_BPS });
        room--;
      }
    }
    return orders;
  },
});