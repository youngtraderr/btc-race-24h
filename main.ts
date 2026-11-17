import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const LOOKBACK = 24;
const BUY_THRESHOLD_BPS = 200;  // Buy if price up 200 bps from entry reference
const TRAILING_STOP_BPS = 800;  // Sell if price down 800 bps from peak
const MAX_SLIPPAGE_BPS = 100;

const series = new Map<string, Series>();

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  ema: Ema;
  peak: bigint;  // peak close price since entry
  invested: boolean;
}

/** One EMA: moving average of closes. */
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

/** Initialize series state for a symbol. */
function initSeries(): Series {
  return { ema: { span: 8, warm: [], value: null }, peak: 0n, invested: false };
}

/** Process a bar: update EMA and check exit signals. */
function processBar(s: Series, close: bigint): { buy: boolean; sell: boolean } {
  const c = Number(close);
  stepEma(s.ema, c);
  
  let buy = false;
  let sell = false;
  
  if (!s.invested) {
    // Not invested: check if price shows upward EMA momentum
    if (s.ema.value !== null && s.ema.value > 0) {
      buy = true;
      s.invested = true;
      // Set peak to current close price (scaled to integer)
      s.peak = close;
    }
  } else {
    // Invested: check trailing stop
    const currentPrice = close;
    if (s.peak > 0n) {
      // trailing stop: peak * (1 - TRAILING_STOP_BPS / 10000)
      const stopLevel = s.peak - (s.peak * BigInt(TRAILING_STOP_BPS)) / BigInt(10000);
      if (currentPrice <= stopLevel) {
        sell = true;
        s.invested = false;
      }
    }
  }
  
  return { buy, sell };
}

await runBars({
  onHello() {
    // Series initialized per symbol on first bar
  },
  onBatch(state, batch) {
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const buySymbols: string[] = [];
    
    // Process each symbol
    for (const { symbol } of state.hello.symbols) {
      const held = state.positions.get(symbol);
      
      if (held !== undefined) {
        // We hold this symbol - check trailing stop
        if (!series.has(symbol)) series.set(symbol, initSeries());
        const s = series.get(symbol)!;
        const { buy: buyResult, sell: sellResult } = processBar(s, state.close(symbol));
        if (sellResult) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else {
        // Not holding this symbol - consider buying
        if (!series.has(symbol)) series.set(symbol, initSeries());
        const s = series.get(symbol)!;
        const { buy: buyResult } = processBar(s, state.close(symbol));
        if (buyResult) {
          buySymbols.push(symbol);
        }
      }
    }
    
    // Build orders: sells first, then buys
    const orders: (SellInput | BuyInput)[] = [...sells];
    
    // Add buys (max 1 open position)
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    let room = slots - state.positions.size;
    let cash = state.cash;
    
    for (const symbol of buySymbols) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      // Buy: spend up to max weight but at least 1 USDC
      const byWeight = state.equity * BigInt(caps.max_weight_bps) / BPS;
      const maxNotional = state.cash < byWeight ? state.cash : byWeight;
      if (maxNotional >= BigInt(fees.min_notional_quote_units)) {
        orders.push({ side: 'buy', symbol, notional_quote_units: maxNotional, max_slippage_bps: MAX_SLIPPAGE_BPS });
        cash -= maxNotional;
        room--;
      }
    }
    
    return orders;
  },
});