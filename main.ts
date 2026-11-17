// cbBTC dip buyer: waits for the close to fall DIP_BPS under its own 60-bar mean, buys the dip
// with the whole account, and takes the position off at a 100 bps bounce or a wide stop. One
// asset, long only, no leverage, at most one order per reply.
//
// Why this shape: a bar-by-bar cross bot on this market pays more in fees (4 bps a fill, 2 bps of
// modelled slippage and the pool impact on every round trip) than a 1-minute up move is worth, so
// trading often loses by construction. Buying a stretch under the mean and selling the bounce
// trades rarely, sizes the whole account against a real edge, and keeps the drawdown small
// because a position that does not bounce is cut.
//
// Rules, read from the bars and the account the harness sends:
//   - entry (fills at the next open): the close is at least DIP_BPS under the mean of the last
//     MEAN_BARS closes, and there is a full MEAN_BARS of history. Spend 99% of the cash.
//   - exit, the whole position: the close is TAKE_BPS above the fill price, or STOP_BPS under it.
//   - slippage is capped at MAX_SLIPPAGE_BPS so a liquidity gap refuses the fill rather than
//     taking it at any price; the order is simply decided again on the next bar.
//
// Deterministic: float64 arithmetic on + - * / only, no clock, no random, no environment.

import { runBars, type BarsState, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10_000;
/** Bars in the mean the dip is measured against. */
const MEAN_BARS = 60;
/** How far under the mean, in bps, the close must sit to buy. */
const DIP_BPS = 80;
/** Take the bounce, in bps above the fill. */
const TAKE_BPS = 100;
/** Cut a position that keeps falling, in bps under the fill. */
const STOP_BPS = 400;
/** Leave this share of the cash for the fee and the price impact. */
const CASH_FRACTION = 0.99;
/** Refuse a fill this far from the close the order was decided on. */
const MAX_SLIPPAGE_BPS = 200;

const closes: number[] = [];
let meanSum = 0;
let entryPrice = 0;

function onBatch(state: BarsState, batch: { bars: Bar[] }): BuyInput[] | SellInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (!bar) return [];
  if (state.warmingUp) return [];

  // The price scale is 5: the close is USDC per unit in fixed point. Only the ratios matter.
  const close = Number(BigInt(bar.c));
  closes.push(close);
  meanSum += close;
  if (closes.length > MEAN_BARS) meanSum -= closes.shift() as number;

  const holding = state.positions.get(SYMBOL);
  const held = holding !== undefined && holding.qty > 0n;

  if (held) {
    if (entryPrice <= 0) return [];
    const gainBps = ((close - entryPrice) / entryPrice) * BPS;
    if (gainBps >= TAKE_BPS || gainBps <= -STOP_BPS) {
      return [{ side: 'sell', symbol: SYMBOL, qty: holding!.qty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  if (closes.length < MEAN_BARS) return [];
  const mean = meanSum / closes.length;
  const dipBps = ((mean - close) / mean) * BPS;
  if (dipBps < DIP_BPS) return [];

  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  const spend = BigInt(Math.floor(Number(state.cash) * CASH_FRACTION));
  if (spend < minNotional) return [];

  entryPrice = close;
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

runBars({ onBatch });
