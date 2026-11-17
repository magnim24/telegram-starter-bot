// A Telegram bot you can deploy in one click and then make your own.
//
// Two ways to receive updates:
//   polling (default): the bot asks Telegram for updates. Works everywhere,
//     needs no web address, fine for almost every bot.
//   webhook: Telegram pushes updates to https://<your app>/telegram. Set
//     TELEGRAM_MODE=webhook and WEBHOOK_URL to the app's public address.
//
// Handlers live in src/commands.js. This file only wires things up.

import http from "node:http"
import { Bot, webhookCallback } from "grammy"
import { registerCommands } from "./src/commands.js"

const TelegramBot = require("node-telegram-bot-api");
const WebSocket = require("ws");

const TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.TELEGRAM_TOKEN;

const APP_ID = process.env.DERIV_APP_ID;

if (!TOKEN) {
  throw new Error("Missing Telegram bot token");
}

const bot = new TelegramBot(TOKEN, { polling: true });

let watchedSymbols = [];
let autoMode = false;
let deriv;
let requestId = 0;
const pending = new Map();
const lastSignals = new Map();

function connectDeriv() {
  return new Promise((resolve, reject) => {
    deriv = new WebSocket(
      `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`
    );

    deriv.on("open", resolve);

    deriv.on("message", raw => {
      const data = JSON.parse(raw);

      if (data.req_id && pending.has(data.req_id)) {
        const callback = pending.get(data.req_id);
        pending.delete(data.req_id);

        if (data.error) callback.reject(new Error(data.error.message));
        else callback.resolve(data);
      }
    });

    deriv.on("error", reject);
    deriv.on("close", () => {
      pending.forEach(p => p.reject(new Error("Deriv disconnected")));
      pending.clear();
    });
  });
}

async function derivRequest(payload) {
  if (!deriv || deriv.readyState !== WebSocket.OPEN) {
    await connectDeriv();
  }

  const id = ++requestId;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Deriv request timed out"));
    }, 15000);

    pending.set(id, {
      resolve: data => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: error => {
        clearTimeout(timeout);
        reject(error);
      }
    });

    deriv.send(JSON.stringify({ ...payload, req_id: id }));
  });
}

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function calculateATR(candles, period = 14) {
  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  const recent = ranges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

async function getCandles(symbol, granularity) {
  const result = await derivRequest({
    ticks_history: symbol,
    adjust_start_time: 1,
    count: 220,
    end: "latest",
    style: "candles",
    granularity
  });

  if (!result.candles || result.candles.length < 202) {
    throw new Error("Insufficient candle data");
  }

  // Exclude the potentially unfinished candle.
  return result.candles.slice(0, -1).map(c => ({
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));
}

function analyse(candles) {
  const closes = candles.map(c => c.close);
  const fast = ema(closes, 50);
  const slow = ema(closes, 200);
  const atr = calculateATR(candles);
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  if (!atr || !Number.isFinite(atr)) {
    throw new Error("ATR calculation unavailable");
  }

  return {
    price: last.close,
    fast,
    slow,
    atr,
    bullish: fast > slow && last.close > fast,
    bearish: fast < slow && last.close < fast,
    breakoutUp: last.close > previous.high,
    breakoutDown: last.close < previous.low
  };
}

async function scan(symbol) {
  const [h1, m15, m5] = await Promise.all([
    getCandles(symbol, 3600),
    getCandles(symbol, 900),
    getCandles(symbol, 300)
  ]);

  const H1 = analyse(h1);
  const M15 = analyse(m15);
  const M5 = analyse(m5);

  let direction = "NO TRADE";

  if (H1.bullish && M15.bullish &&
      M5.bullish && M5.breakoutUp) {
    direction = "BUY";
  }

  if (H1.bearish && M15.bearish &&
      M5.bearish && M5.breakoutDown) {
    direction = "SELL";
  }

  if (direction === "NO TRADE") {
    return `NO TRADE: ${symbol}\n` +
      `H1: ${H1.bullish ? "Bullish" : H1.bearish ? "Bearish" : "Mixed"}\n` +
      `M15: ${M15.bullish ? "Bullish" : M15.bearish ? "Bearish" : "Mixed"}\n` +
      `M5: Waiting for confirmation.`;
  }

  const entry = M5.price;
  const risk = M5.atr * 1.5;

  const sl = direction === "BUY"
    ? entry - risk
    : entry + risk;

  const targets = [1, 2, 3].map(multiplier =>
    direction === "BUY"
      ? entry + risk * multiplier
      : entry - risk * multiplier
  );

  return [
    `MAGNIM TRADING SIGNAL`,
    ``,
    `Market: ${symbol}`,
    `Direction: ${direction}`,
    `Timeframes: H1 / M15 / M5`,
    `Entry reference: ${entry}`,
    `Stop Loss: ${sl}`,
    `TP1: ${targets[0]}`,
    `TP2: ${targets[1]}`,
    `TP3: ${targets[2]}`,
    `Risk-to-reward: 1:1 / 1:2 / 1:3`,
    ``,
    `Confirmation: EMA alignment + M5 breakout`,
    `Status: Preliminary signal`,
    `Source: Deriv market data`,
    ``,
    `Risk warning: Signals are not guaranteed.`
  ].join("\n");
}

async function markets() {
  const result = await derivRequest({
    active_symbols: "brief",
    product_type: "basic"
  });

  return result.active_symbols || [];
}

bot.onText(/^\/start$/, msg => {
  bot.sendMessage(msg.chat.id,
    "Welcome to Magnim Trading Bot!\n\n" +
    "Commands:\n" +
    "/help - Instructions\n" +
    "/markets - Available markets\n" +
    "/watch SYMBOL - Select a market\n" +
    "/scan - Analyse selected markets\n" +
    "/auto - Enable 5-minute scanning\n" +
    "/stop - Stop automatic scanning"
  );
});

bot.onText(/^\/help$/, msg => {
  bot.sendMessage(msg.chat.id,
    "Magnim Trading Bot\n\n" +
    "/markets\n" +
    "/watch SYMBOL\n" +
    "/scan\n" +
    "/auto\n" +
    "/stop\n\n" +
    "Signals are for analysis only. No trades are placed."
  );
});

bot.onText(/^\/markets$/, async msg => {
  try {
    const list = await markets();

    const relevant = list.filter(item =>
      /gold|bitcoin|boom|crash|volatility|forex|EUR\/USD|GBP\/USD/i
        .test(item.display_name || "")
    ).slice(0, 40);

    const output = relevant.map(item =>
      `${item.display_name} — ${item.symbol}`
    ).join("\n");

    bot.sendMessage(msg.chat.id,
      output || "No matching markets returned."
    );
  } catch (error) {
    bot.sendMessage(msg.chat.id,
      "Market lookup failed: " + error.message
    );
  }
});

bot.onText(/^\/watch\s+(.+)$/, async (msg, match) => {
  const symbol = match[1].trim().toUpperCase();

  try {
    const list = await markets();
    const found = list.find(item =>
      item.symbol.toUpperCase() === symbol
    );

    if (!found) {
      return bot.sendMessage(msg.chat.id,
        "Symbol not found. Use /markets to see available symbols."
      );
    }

    if (!watchedSymbols.includes(symbol)) {
      watchedSymbols.push(symbol);
    }

    bot.sendMessage(msg.chat.id,
      `Watching ${found.display_name} (${symbol}).`
    );
  } catch (error) {
    bot.sendMessage(msg.chat.id, error.message);
  }
});

async function runScan(chatId) {
  if (!watchedSymbols.length) {
    return bot.sendMessage(chatId,
      "First select a market using /markets and /watch SYMBOL."
    );
  }

  for (const symbol of watchedSymbols) {
    try {
      const signal = await scan(symbol);
      await bot.sendMessage(chatId, signal);
    } catch (error) {
      await bot.sendMessage(chatId,
        `${symbol}: Analysis unavailable. ${error.message}`
      );
    }
  }
}

bot.onText(/^\/scan$/, msg => runScan(msg.chat.id));

bot.onText(/^\/auto$/, msg => {
  autoMode = true;
  bot.sendMessage(msg.chat.id,
    "Automatic scanning enabled. Scans run every five minutes."
  );
});

bot.onText(/^\/stop$/, msg => {
  autoMode = false;
  bot.sendMessage(msg.chat.id,
    "Automatic scanning stopped."
  );
});

setInterval(() => {
  if (!autoMode) return;

  // Only scan the most recently started chat.
  // Telegram commands activate the bot.
  const chatId = bot.options.chatId;
  if (chatId) runScan(chatId);
}, 300000);

bot.on("polling_error", error => {
  console.error("Telegram polling error:", error.message);
});

console.log("Magnim Trading Bot started.");


