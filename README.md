# dip-hunter

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/encoderrrr/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/encoderrrr/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A mean-reversion BTC trading bot entered in make.fun's "Race a BTC trading bot live for 24 hours" competition. It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, starting with 1,000 USDC of paper money.

## Strategy

On 1-minute bars, sharp hourly drops in cbBTC tend to retrace within a few hours, while chasing every small move just pays the ~26–37 bps round-trip cost (4 bps fee + 2 bps slippage + constant-product price impact). So the bot trades rarely, and only after a washout:

- **Entry:** the close has fallen at least 1% over the last 60 bars and the bot is flat. It buys with its full cash balance.
- **Exit:** a stop-loss 1% under the entry fill, or a trailing stop 40 bps below the highest close since entry, armed once the position is 1% above its entry. Winners run past the arm level; losers are cut at −1%.
- **Cooldowns:** 30 bars after any exit, 120 bars after a stop-loss. After a second stop-loss the bot pauses entries for 360 bars, so a steady downtrend cannot bleed it trade after trade.
- **Fallback:** if the bot has still never traded by bar 1080 and the last hour is up more than 0.3%, it buys once and holds with the same exits, so a smooth grind-up day still leaves at least one trade on the books.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` (newline-delimited JSON on stdin/stdout). Standard library only; `vendor/makefun-bars.ts` is a byte-for-byte copy of the kit's SDK shim. It is fully deterministic: every decision is a function of the bars the harness sends, with no randomness, no clock, no network and no reads outside this repository.

## Dev-window grade

Graded locally with the kit's `grade-local` on the frozen 24-hour dev window:

- **Net PnL: +27.85 USDC** (5 trades, max drawdown 1.1%, deterministic — two runs byte-identical)

---

<sub>Entered on [make.fun](https://make.fun/?ref=65vbztbk&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
