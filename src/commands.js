
import { getSignal, ASSETS } from "./market.js";

const subscribers = new Set();
const lastSent = new Map();

let monitoring = false;
let checking = false;

function formatSignal(data) {
  const time = new Date(data.candleTime * 1000)
    .toLocaleString("en-NG", {
      timeZone: "Africa/Lagos"
    });

  return `
📊 GOLD SIGNAL BOT

Asset: ${data.asset}
Direction: ${data.signal}

Entry reference: ${data.price}
EMA 9: ${data.ema9.toFixed(5)}
EMA 21: ${data.ema21.toFixed(5)}
RSI: ${data.rsi.toFixed(2)}
ATR: ${data.atr.toFixed(5)}

Expiry: ${data.expiry}
Candle time: ${time}

${data.signal === "CALL"
  ? "🟢 Bullish confirmation detected."
  : data.signal === "PUT"
  ? "🔴 Bearish confirmation detected."
  : "⚪ No confirmed trading setup."}

Risk warning: This is an automated technical signal,
not a guaranteed trade. Confirm on your broker chart.
  `;
}

async function sendSignal(ctx, asset) {
  const data = await getSignal(asset);
  await ctx.reply(formatSignal(data));
}

async function monitorMarkets(bot) {
  if (checking || subscribers.size === 0) return;

  checking = true;

  try {
    for (const asset of Object.keys(ASSETS)) {
      if (subscribers.size === 0) break;

      try {
        const data = await getSignal(asset);

        if (data.signal === "NO TRADE") continue;

        const previous = lastSent.get(asset);

        if (previous === data.candleTime) continue;

        lastSent.set(asset, data.candleTime);

        for (const chatId of subscribers) {
          try {
            await bot.api.sendMessage(
              chatId,
              formatSignal(data)
            );
          } catch (error) {
            console.error("Message delivery failed:", error);
          }
        }
      } catch (error) {
        console.error(`Monitoring ${asset} failed:`, error.message);
      }
    }
  } finally {
    checking = false;
  }
}

export function registerCommands(bot) {

  bot.command("start", async (ctx) => {
    await ctx.reply(`
👋 Welcome to GOLD SIGNAL BOT.

Your market analysis assistant is ready.

Commands:

/on - Start signal monitoring
/off - Stop signal monitoring
/signals - Get XAUUSD signal
/signals BTCUSD - Get Bitcoin signal
/signals EURUSD - Get EURUSD signal
/signals VOL100 - Get Volatility 100 signal
/signals ALL - Analyse all assets
/status - Check bot status
/assets - View supported markets
/help - Show commands

Signals use five-minute candles.
No automatic trades are placed.
    `);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(`
COMMAND GUIDE

/on
Start automatic signal monitoring.

/off
Stop automatic signal monitoring.

/signals
Analyse XAUUSD.

/signals BTCUSD
Analyse Bitcoin.

/signals ALL
Analyse all supported markets.

/status
Check monitoring status.

/assets
Show supported assets.
    `);
  });

  bot.command("ping", async (ctx) => {
    await ctx.reply("🟢 Bot is online and responding.");
  });

  bot.command("id", async (ctx) => {
    await ctx.reply(`Your Telegram Chat ID: ${ctx.chat.id}`);
  });

  bot.command("assets", async (ctx) => {
    await ctx.reply(
      "SUPPORTED MARKETS\n\n" +
      Object.keys(ASSETS).join("\n")
    );
  });

  bot.command("status", async (ctx) => {
    const active = subscribers.has(ctx.chat.id);

    await ctx.reply(`
BOT STATUS

Connection: Online
Monitoring: ${active ? "ON" : "OFF"}
Signal expiry: 5 minutes
Markets: ${Object.keys(ASSETS).length}
Trading execution: Disabled
    `);
  });

  bot.command("on", async (ctx) => {
    subscribers.add(ctx.chat.id);

    if (!monitoring) {
      monitoring = true;

      setInterval(() => {
        monitorMarkets(bot).catch(console.error);
      }, 60000);
    }

    await ctx.reply(
      "🟢 Signal monitoring enabled.\n" +
      "You will receive confirmed signals when available.\n" +
      "Use /off to stop."
    );

    await monitorMarkets(bot);
  });

  bot.command("off", async (ctx) => {
    subscribers.delete(ctx.chat.id);

    await ctx.reply(
      "🔴 Signal monitoring stopped for this chat."
    );
  });

  bot.command("signals", async (ctx) => {
    const requested = ctx.match?.trim().toUpperCase() || "XAUUSD";

    if (requested === "ALL") {
      await ctx.reply("Analysing all markets. Please wait...");

      for (const asset of Object.keys(ASSETS)) {
        try {
          await sendSignal(ctx, asset);
        } catch (error) {
          await ctx.reply(
            `${asset}: Data unavailable. ${error.message}`
          );
        }
      }

      return;
    }

    if (!ASSETS[requested]) {
      await ctx.reply(
        "Unsupported market.\nUse /assets to see available markets."
      );
      return;
    }

    await ctx.reply(`Analysing ${requested}...`);

    try {
      await sendSignal(ctx, requested);
    } catch (error) {
      await ctx.reply(
        `Analysis failed: ${error.message}`
      );
    }
  });
}

