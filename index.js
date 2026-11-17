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

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  throw new Error("Set TELEGRAM_BOT_TOKEN in FadeHost environment variables.");
}

const DERIV_URL =
  "wss://api.derivws.com/trading/v1/options/ws/public";

const bot = new TelegramBot(TOKEN, { polling: true });

let socket = null;
let connecting = null;
let requestId = 0;

const pending = new Map();
const watched = new Map();
const automaticChats = new Set();
const lastSignals = new Map();

function connectDeriv() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  if (connecting) return connecting;

  connecting = new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_URL);
    socket = ws;

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Deriv connection timed out."));
    }, 15000);

    ws.on("open", () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.on("message", raw => {
      let data;

      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (data.req_id && pending.has(data.req_id)) {
        const item = pending.get(data.req_id);
        pending.delete(data.req_id);

        if (data.error) {
          item.reject(new Error(data.error.message));
        } else {
          item.resolve(data);
        }
      }
    });

    ws.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      if (socket === ws) socket = null;

      pending.forEach(item =>
        item.reject(new Error("Deriv connection closed."))
      );

      pending.clear();
    });
  }).finally(() => {
    connecting = null;
  });

  return connecting;
}

async function derivRequest(payload) {
  await connectDeriv();

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("Deriv is not connected.");
  }

  const id = ++requestId;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Deriv request timed out."));
    }, 20000);

    pending.set(id, {
      resolve: result => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: error => {
        clearTimeout(timeout);
        reject(error);
      }
    });

    socket.send(JSON.stringify({
      ...payload,
      req_id: id
    }), error => {
      if (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error);
      }
    });
  });
}

async function getMarkets() {
  const result = await derivRequest({
    active_symbols: "brief"
  });

  return result.active_symbols || [];
}

async function getCandles(symbol, timeframe) {
  const result = await derivRequest({
    ticks_history: symbol,
    count: 220,
    end: "latest",
    style: "candles",
    granularity: timeframe
  });

  if (!result.candles || result.candles.length < 202) {
    throw new Error("Insufficient candle history.");
  }

  // Exclude the unfinished candle.
  return result.candles.slice(0, -1).map(c => ({
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));
}

function calculateEMA(values, period) {
  const multiplier = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result =
      values[i] * multiplier +
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

  return recent.reduce((a, b) => a + b, 0) /
    recent.length;
}

function analyse(candles) {
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const atr = calculateATR(candles);

  return {
    price: last.close,
    ema50,
    ema200,
    atr,

    bullish: ema50 > ema200 && last.close > ema50,
    bearish: ema50 < ema200 && last.close < ema50,

    breakoutUp: last.close > previous.high,
    breakoutDown: last.close < previous.low
  };
}

function formatPrice(value) {
  return Number(value.toPrecision(8)).toString();
}

async function analyseMarket(symbol) {
  const [h1, m15, m5] = await Promise.all([
    getCandles(symbol, 3600),
    getCandles(symbol, 900),
    getCandles(symbol, 300)
  ]);

  const H1 = analyse(h1);
  const M15 = analyse(m15);
  const M5 = analyse(m5);

  let direction = "NO TRADE";

  if (
    H1.bullish &&
    M15.bullish &&
    M5.bullish &&
    M5.breakoutUp
  ) {
    direction = "BUY";
  }

  if (
    H1.bearish &&
    M15.bearish &&
    M5.bearish &&
    M5.breakoutDown
  ) {
    direction = "SELL";
  }

  if (direction === "NO TRADE") {
    return {
      direction,
      message:
        `MAGNIM MARKET ANALYSIS\n\n` +
        `Market: ${symbol}\n` +
        `H1: ${H1.bullish ? "Bullish" : H1.bearish ? "Bearish" : "Mixed"}\n` +
        `M15: ${M15.bullish ? "Bullish" : M15.bearish ? "Bearish" : "Mixed"}\n` +
        `M5: Waiting for breakout confirmation\n` +
        `Current reference: ${formatPrice(M5.price)}\n\n` +
        `Decision: NO TRADE\n` +
        `Waiting for confirmation.`
    };
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

  return {
    direction,
    message: [
      "MAGNIM TRADING SIGNAL",
      "",
      `Market: ${symbol}`,
      `Direction: ${direction}`,
      "Timeframes: H1 / M15 / M5",
      "",
      `Entry reference: ${formatPrice(entry)}`,
      `Stop Loss: ${formatPrice(sl)}`,
      `TP1: ${formatPrice(targets[0])}`,
      `TP2: ${formatPrice(targets[1])}`,
      `TP3: ${formatPrice(targets[2])}`,
      "",
      "Risk-to-reward: 1:1 / 1:2 / 1:3",
      "Confirmation: EMA alignment and breakout",
      "Status: Preliminary signal",
      "",
      "Source: Deriv public market data",
      "Risk warning: No guaranteed profits."
    ].join("\n")
  };
}

async function scanChat(chatId) {
  const symbols = watched.get(chatId) || [];

  if (!symbols.length) {
    return bot.sendMessage(
      chatId,
      "No markets selected.\nUse /markets and /watch SYMBOL first."
    );
  }

  for (const symbol of symbols) {
    try {
      const result = await analyseMarket(symbol);

      const key = `${chatId}:${symbol}`;
      const previous = lastSignals.get(key);

      // Avoid repeatedly sending identical decisions.
      if (
        result.direction !== "NO TRADE" &&
        result.direction === previous
      ) {
        continue;
      }

      lastSignals.set(key, result.direction);

      await bot.sendMessage(chatId, result.message);

    } catch (error) {
      await bot.sendMessage(
        chatId,
        `${symbol}: Data unavailable. ${error.message}`
      );
    }
  }
}

bot.onText(/^\/start$/, async msg => {
  bot.sendMessage(
    msg.chat.id,
    "Welcome to MAGNIM TRADING BOT!\n\n" +
    "Deriv market analysis assistant.\n\n" +
    "/help - Commands\n" +
    "/markets - Available markets\n" +
    "/watch SYMBOL - Select market\n" +
    "/scan - Scan selected markets\n" +
    "/auto - Enable automatic scanning\n" +
    "/stop - Stop automatic scanning"
  );
});

bot.onText(/^\/help$/, msg => {
  bot.sendMessage(
    msg.chat.id,
    "MAGNIM COMMANDS\n\n" +
    "/markets\n" +
    "/watch SYMBOL\n" +
    "/scan\n" +
    "/auto\n" +
    "/stop\n\n" +
    "This version generates analysis only. " +
    "It does not execute trades."
  );
});

bot.onText(/^\/markets$/, async msg => {
  try {
    const symbols = await getMarkets();

    const matching = symbols.filter(item =>
      /gold|bitcoin|boom|crash|volatility|EUR|GBP|USD/i
        .test(item.display_name || "")
    );

    const output = matching.slice(0, 50).map(item =>
      `${item.display_name}: ${item.symbol}`
    );

    await bot.sendMessage(
      msg.chat.id,
      output.length
        ? output.join("\n")
        : "No matching markets found."
    );

  } catch (error) {
    bot.sendMessage(msg.chat.id, error.message);
  }
});

bot.onText(/^\/watch\s+([A-Za-z0-9_]+)$/, async (msg, match) => {
  const symbol = match[1].toUpperCase();

  try {
    const markets = await getMarkets();

    const found = markets.find(item =>
      item.symbol.toUpperCase() === symbol
    );

    if (!found) {
      return bot.sendMessage(
        msg.chat.id,
        "Symbol not found. Use /markets to check available symbols."
      );
    }

    const list = watched.get(msg.chat.id) || [];

    if (!list.includes(symbol)) list.push(symbol);

    watched.set(msg.chat.id, list);

    bot.sendMessage(
      msg.chat.id,
      `Market added: ${found.display_name}\nSymbol: ${symbol}`
    );

  } catch (error) {
    bot.sendMessage(msg.chat.id, error.message);
  }
});

bot.onText(/^\/scan$/, msg => {
  scanChat(msg.chat.id);
});

bot.onText(/^\/auto$/, msg => {
  automaticChats.add(msg.chat.id);

  bot.sendMessage(
    msg.chat.id,
    "Automatic scanning enabled. " +
    "The bot will check your selected markets every five minutes."
  );
});

bot.onText(/^\/stop$/, msg => {
  automaticChats.delete(msg.chat.id);

  bot.sendMessage(
    msg.chat.id,
    "Automatic scanning stopped."
  );
});

// Automatic scanning for each Telegram chat.
let scanning = false;

setInterval(async () => {
  if (scanning || automaticChats.size === 0) return;

  scanning = true;

  try {
    for (const chatId of automaticChats) {
      await scanChat(chatId);
    }
  } finally {
    scanning = false;
  }
}, 300000);

bot.on("polling_error", error => {
  console.error("Telegram error:", error.message);
});

console.log("Magnim Trading Bot is starting.");
