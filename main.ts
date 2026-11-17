// Dip Hunter: a mean-reversion BTC trading bot for make.fun's
// "Race a BTC trading bot live for 24 hours" (btc-race-24h-20261117-0603).
//
// Idea
// ----
// On 1-minute bars, sharp hourly drops in cbBTC tend to retrace within a few
// hours, while chasing every small move just pays the ~26-37 bps round-trip
// cost (4 bps fee + 2 bps slippage + constant-product impact). So this bot
// trades rarely and only after a washout:
//
//   Entry: the close has fallen at least 1% over the last 60 bars and the bot
//     is flat. It buys with its full cash balance.
//   Exit:  a stop-loss 1% under the entry fill, or a trailing stop 40 bps
//     below the highest close since entry, armed once the position is 1%
//     above its entry. Winners are therefore allowed to run past the arm
//     level; losers are cut at -1%.
//   Cooldowns: 30 bars after any exit, 120 bars after a stop-loss. After a
//     second stop-loss the bot pauses entries for 360 bars, so a steady
//     downtrend cannot bleed it trade after trade.
//   Fallback: if the bot has still never traded by bar 1080 and the last
//     hour is up more than 0.3%, it buys once and holds with the same exits,
//     so a smooth grind-up day still leaves at least one trade on the books.
//
// Everything is deterministic: every decision is a function of the bars the
// harness has sent, in float64, with no randomness, no clock, no network and
// no reads outside this repository. All prices are compared in the raw
// integer units the protocol carries (bar.c / fill.price), so no scale
// conversions are needed for the signals.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** Entry: the close must be this far under its close DIP_LOOK bars back. */
const DIP_LOOK = 60;
const DIP_PCT = 0.01;
/** Trailing stop arms once the close is this far above the entry fill. */
const ARM_PCT = 0.01;
/** Trailing stop: this far (in bps) under the highest close since entry. */
const TRAIL_BPS = 40;
/** Stop-loss: this far under the entry fill. */
const STOP_PCT = 0.01;
/** Bars to wait after any exit before a new entry. */
const EXIT_COOLDOWN = 30;
/** Bars to wait after a stop-loss before a new entry. */
const STOP_COOLDOWN = 120;
/** After a second stop-loss, pause entries for this many bars. */
const PAUSE_AFTER_TWO_STOPS = 360;
/** Fallback entry: if still never traded by this batch, buy a rising hour. */
const FALLBACK_BAR = 1080;
const FALLBACK_RISE_PCT = 0.003;
/** 1% past the close the order was decided on, as in the kit baselines. */
const MAX_SLIPPAGE_BPS = 100;

// --- state (all derived from the bars and fills the harness sends) --------

/** Closes of every CBBTC bar received, in raw price units, oldest first. */
const closes: number[] = [];
/** Fill price of the open position, in raw price units; null while flat. */
let entryPrice: number | null = null;
/** Highest close since the entry fill, in raw price units. */
let peak = 0;
/** Batch seq of the last exit, the last stop-loss, and the pause end. */
let lastExit = -1e9;
let lastStop = -1e9;
let pausedUntil = -1e9;
/** Stop-losses so far, and whether any buy has ever filled. */
let stopCount = 0;
let everTraded = false;

/** The 60-bar return ending at the latest close, or null without history. */
function ret60(): number | null {
  const n = closes.length;
  if (n <= DIP_LOOK) return null;
  return closes[n - 1] / closes[n - 1 - DIP_LOOK] - 1;
}

/**
 * The entry price implied by a held position's cost, in raw price units:
 * value = qty * price * 10^quote_scale / 10^(qty_scale + price_scale), so
 * price = cost * 10^(qty_scale + price_scale) / (qty * 10^quote_scale).
 * Used only if a fill price was somehow not seen; the fill price is the
 * primary source.
 */
function entryFromCost(state: BarsState, held: { qty: bigint; cost: bigint }): number {
  const sym = state.symbols.get(SYMBOL)!;
  const quoteScale = state.hello.capital.quote_scale;
  const num = Number(held.cost) * 10 ** (sym.qty_scale + sym.price_scale);
  const den = Number(held.qty) * 10 ** quoteScale;
  return num / den;
}

await runBars({
  onBatch(state, batch) {
    // Learn from the fills of the orders decided on the previous batch.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.status === 'filled' && fill.side === 'buy') {
        everTraded = true;
        entryPrice = Number(fill.price);
        peak = entryPrice;
      }
    }

    // Fold in this batch's bar (at most one symbol in this competition).
    // A bar whose close is not a positive finite number is corrupt data:
    // it would poison ret60 and the stops, so leave it out of the history
    // entirely instead of trading on it.
    let fresh = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const c = Number(bar.c);
      if (!Number.isFinite(c) || c <= 0) continue;
      closes.push(c);
      fresh = true;
    }
    if (state.warmingUp || !fresh) return [];

    const held = state.positions.get(SYMBOL);
    const close = closes[closes.length - 1];
    const r60 = ret60();
    const seq = state.seq;

    // --- exits, while holding -------------------------------------------
    if (held !== undefined) {
      if (entryPrice === null) {
        entryPrice = entryFromCost(state, held);
        peak = entryPrice;
      }
      if (close > peak) peak = close;
      const stop = entryPrice * (1 - STOP_PCT);
      const armed = close >= entryPrice * (1 + ARM_PCT);
      const trailed = peak * (1 - TRAIL_BPS / 10_000);
      if (close <= stop) {
        lastExit = seq;
        lastStop = seq;
        stopCount += 1;
        if (stopCount >= 2) pausedUntil = seq + PAUSE_AFTER_TWO_STOPS;
        entryPrice = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      if (armed && close <= trailed) {
        lastExit = seq;
        entryPrice = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat from here on.
    entryPrice = null;
    if (r60 === null) return [];
    if (seq - lastExit < EXIT_COOLDOWN) return [];
    if (seq - lastStop < STOP_COOLDOWN) return [];
    if (seq < pausedUntil) return [];

    const dip = r60 < -DIP_PCT;
    const fallback = !everTraded && seq >= FALLBACK_BAR && r60 > FALLBACK_RISE_PCT;
    if (!dip && !fallback) return [];

    const cash = state.cash;
    if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
