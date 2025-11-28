// server.js — persist outgoing messages + instant socket echo + auto-greeting
const express = require("express");
const http = require("http");
const cors = require("cors");
let compression = null;
try {
  compression = require("compression");
} catch {}
const { Server } = require("socket.io");
const qrcode = require("qrcode");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const multer = require("multer");
const { Client, LocalAuth, MessageMedia, Location } = require("whatsapp-web.js");

const PORT = process.env.PORT || 3001;
const FRONT_ORIGIN = process.env.FRONT_ORIGIN || "*";
const SESS_PATH = path.resolve(__dirname, ".sessions");
const DATA_PATH = path.resolve(__dirname, ".data");
const UPLOADS = path.resolve(__dirname, "uploads");

fs.mkdirSync(DATA_PATH, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

/* ===== глобальные ловушки ошибок Puppeteer / whatsapp-web.js ===== */
const isPuppeteerSoftError = (err) => {
  const msg = String((err && err.message) || err || "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("execution context was destroyed") ||
    msg.includes("context was destroyed") ||
    msg.includes("target closed") ||
    (msg.includes("protocolerror") && msg.includes("runtime.callfunctionon"))
  );
};

process.on("unhandledRejection", (reason) => {
  if (isPuppeteerSoftError(reason)) {
    console.warn(
      "Игнорируем мягкую puppeteer-ошибку (navigation/target closed/protocol)..."
    );
    return;
  }
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (err) => {
  if (isPuppeteerSoftError(err)) {
    console.warn(
      "Игнорируем мягкую puppeteer-ошибку (navigation/target closed/protocol)..."
    );
    return;
  }
  console.error("UNCAUGHT EXCEPTION:", err);
});

/* ===== express / cors ===== */
const app = express();
if (compression) app.use(compression());
app.use(express.json({ limit: "20mb" }));

// максимально свободный CORS, чтобы не было ошибок с фронта
const corsOptions = {
  origin: (origin, cb) => cb(null, true),
  credentials: true,
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use("/uploads", express.static(UPLOADS));

app.get("/", (req, res) => {
  res.send(
    `<h1>WhatsApp backend is running ✅</h1>
     <p>Попробуй <code>/status</code>, <code>/qr</code>, <code>/chats</code>, <code>/messages?chatId=...</code></p>`
  );
});

const server = http.createServer(app);

// ===== socket.io (websocket) =====
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
  },
  allowEIO3: true,
});

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ===== utils =====
const chatsFile = () => path.join(DATA_PATH, "chats.json");
const msgFile = (chatId) =>
  path.join(
    DATA_PATH,
    `messages_${String(chatId || "").replace(/[^a-zA-Z0-9_.@-]/g, "_")}.json`
  );

const safeRead = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const atomicWrite = (file, obj) => {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
};

const nowSec = () => Math.floor(Date.now() / 1000);

const sortChats = (list) =>
  (list || [])
    .slice()
    .sort((a, b) => {
      if (!!b.pinned - !!a.pinned) return !!b.pinned - !!a.pinned;
      if (!!b.unreadCount - !!a.unreadCount)
        return !!b.unreadCount - !!a.unreadCount;
      const at = Number(a.lastTs || 0),
        bt = Number(b.lastTs || 0);
      if (bt !== at) return bt - at;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });

const sanitizeId = (s) => {
  const v = String(s || "");
  if (/@(c|g)\.us$/i.test(v)) return v;
  const d = v.replace(/\D/g, "");
  return d ? d + "@c.us" : v;
};

const normalizeTarget = ({ chatId, to }) =>
  chatId ? sanitizeId(chatId) : to ? sanitizeId(to) : null;

const previewFromMessage = (m) => {
  const t = String(m?.type || "").toLowerCase();
  const body = String(m?.body || "").trim();
  if (t === "call_log" || t === "call") return body || "Звонок";
  if (t === "image") return body ? `Фото · ${body}` : "Фото";
  if (t === "video") return body ? `Видео · ${body}` : "Видео";
  if (t === "audio" || t === "ptt") return "Голосовое";
  if (t === "sticker") return "Стикер";
  if (t === "document") return "Документ";
  if (t === "location") return "Локация";
  if (t === "vcard" || t === "contact" || t === "contact_card") return "Контакт";
  if (t === "buttons_response") return body || "Ответ кнопкой";
  if (t === "list_response") return body || "Выбор из списка";
  if (t === "reaction") return "Реакция";
  if (t === "revoked") return "Сообщение удалено";
  if (!body) return t || "Сообщение";
  return body.slice(0, 140);
};

const mapMessage = (m, chatId) => {
  const base = {
    id: m?.id?._serialized || null,
    chatId: chatId || m?.from || null,
    from: m.from,
    to: m.to,
    body: m.body,
    timestamp: Number(m.timestamp || nowSec()),
    fromMe: m.fromMe,
    type: m.type || "chat",
    hasMedia: !!m.hasMedia,
  };

  if (m.hasQuotedMsg && m._data?.quotedStanzaID) {
    base.quotedMessageId = m._data.quotedStanzaID;
    base.quotedBody = m._data?.quotedMsg?.body || "";
  }

  if (m.type === "location" && m.location)
    base.location = {
      latitude: m.location.latitude,
      longitude: m.location.longitude,
      description: m.location.description || "",
    };

  if (
    (m.type === "vcard" ||
      m.type === "contact" ||
      m.type === "contact_card") &&
    Array.isArray(m.vCards) &&
    m.vCards.length
  ) {
    base.vcard = m.vCards[0];
    base.type = "vcard";
  }

  if (m.type === "buttons_response") base.type = "buttons_response";
  if (m.type === "list_response") base.type = "list_response";
  if (m.type === "reaction") base.type = "reaction";

  base.preview = previewFromMessage(base);
  return base;
};

const persistAndEmit = (chatId, mapped) => {
  try {
    const file = msgFile(chatId);
    const prev = safeRead(file, { results: [] });
    prev.results.push(mapped);
    prev.savedAt = Date.now();
    atomicWrite(file, prev);
  } catch {}
  io.emit("message", mapped);
};

/* ===== analytics ===== */
const ANALYTICS_FILE = path.join(DATA_PATH, "analytics.json");
if (!fs.existsSync(ANALYTICS_FILE)) {
  try {
    fs.writeFileSync(
      ANALYTICS_FILE,
      JSON.stringify({ events: [], savedAt: Date.now() }, null, 2)
    );
  } catch {}
}
const readAnalytics = () =>
  safeRead(ANALYTICS_FILE, { events: [], savedAt: 0 });

const sameMonth = (a, b) => {
  const A = new Date(a * 1000),
    B = new Date(b * 1000);
  return A.getFullYear() === B.getFullYear() && A.getMonth() === B.getMonth();
};

const pushEventUniqueMonthly = (type, chatId, ts) => {
  try {
    const a = readAnalytics();
    const t = Number(ts || nowSec());
    const dup = (a.events || []).some(
      (ev) => ev.type === type && ev.chatId === chatId && sameMonth(ev.ts, t)
    );
    if (dup) return;
    a.events.push({ type, chatId, ts: t });
    a.savedAt = Date.now();
    atomicWrite(ANALYTICS_FILE, a);
  } catch {}
};

/* ===== greetings (auto-reply) ===== */
const GREET_FILE = path.join(DATA_PATH, "greetings.json");
if (!fs.existsSync(GREET_FILE)) {
  try {
    fs.writeFileSync(
      GREET_FILE,
      JSON.stringify({ byChat: {}, savedAt: Date.now() }, null, 2)
    );
  } catch {}
}
const readGreet = () => safeRead(GREET_FILE, { byChat: {}, savedAt: 0 });

const saveGreetTs = (chatId, ts) => {
  try {
    const g = readGreet();
    g.byChat[String(chatId)] = Number(ts || nowSec());
    g.savedAt = Date.now();
    atomicWrite(GREET_FILE, g);
  } catch {}
};
const lastGreetTs = (chatId) =>
  Number(readGreet().byChat?.[String(chatId)] || 0);

const GREET_COOLDOWN_SEC = Number(
  process.env.GREET_COOLDOWN_SEC || 3 * 60 * 60
);
const GREET_DELAY_MS = Number(process.env.GREET_DELAY_MS || 5000);
const pendingGreeting = new Set();

/* ===== WA state ===== */
let client = null;
let isReady = false;
let lastQR = null;

/* ===== chats helpers ===== */
const upsertChatLast = (target, lastVal, ts) => {
  const stored = safeRead(chatsFile(), { results: [] });
  const arr = stored.results || [];
  const ix = arr.findIndex((x) => x.id === target);
  if (ix >= 0) {
    arr[ix].last = lastVal;
    arr[ix].lastTs = ts;
    if (!arr[ix].status)
      arr[ix].status = arr[ix].isLead === true ? "lead" : "client";
    atomicWrite(chatsFile(), {
      results: sortChats(arr),
      savedAt: Date.now(),
    });
    io.emit("chat-patch", {
      id: target,
      last: arr[ix].last,
      lastTs: arr[ix].lastTs,
      status: arr[ix].status,
      isLead: arr[ix].isLead,
    });
  } else {
    const rec = {
      id: target,
      name: `+${String(target).replace(/\D/g, "")}`,
      isGroup: false,
      unreadCount: 0,
      pinned: false,
      archived: false,
      last: lastVal,
      lastTs: ts,
      isLead: true,
      status: "lead",
    };
    atomicWrite(chatsFile(), {
      results: sortChats([rec, ...arr]),
      savedAt: Date.now(),
    });
    io.emit("chat-patch", rec);
  }
};

const attachClientEvents = (c) => {
  c.on("qr", async (qr) => {
    try {
      lastQR = await qrcode.toDataURL(qr);
    } catch {
      lastQR = null;
    }
    isReady = false;
    io.emit("qr", { dataUrl: lastQR });
    io.emit("status", { ready: false, step: "qr" });
  });

  c.on("authenticated", () =>
    io.emit("status", { ready: false, step: "authenticated" })
  );

  c.on("ready", async () => {
    isReady = true;
    lastQR = null;
    io.emit("status", { ready: true, step: "ready" });
    try {
      await initialSync();
    } catch {}
  });

  // ВАЖНО: НИКАКИХ перезапусков тут, только статус
  c.on("disconnected", (reason) => {
    console.warn("WA disconnected:", reason);
    isReady = false;
    io.emit("status", { ready: false, step: "disconnected", reason });
  });

  const handleIncoming = async (msg) => {
    let chatId = msg.from,
      isGroup = false;
    try {
      const chat = await msg.getChat();
      chatId = chat?.id?._serialized || chatId;
      isGroup = !!chat?.isGroup;
    } catch {}

    const mapped = mapMessage(msg, chatId);
    persistAndEmit(chatId, mapped);

    // авто-приветствие
    try {
      if (!mapped.fromMe && !isGroup && isReady) {
        const last = lastGreetTs(chatId);
        if (
          nowSec() - last >= GREET_COOLDOWN_SEC &&
          !pendingGreeting.has(chatId)
        ) {
          pendingGreeting.add(chatId);
          setTimeout(async () => {
            try {
              await client.sendMessage(
                chatId,
                "Здравствуйте! Мы получили ваше сообщение и скоро ответим."
              );
              saveGreetTs(chatId, nowSec());
            } catch {
            } finally {
              pendingGreeting.delete(chatId);
            }
          }, GREET_DELAY_MS);
        }
      }
    } catch {}

    // обновляем chats.json
    try {
      const store = safeRead(chatsFile(), { results: [] });
      const arr = store.results || [];
      const ts = Number(mapped.timestamp || nowSec());
      const lastVal =
        mapped.preview || mapped.body || `(${mapped.type})`;
      const ix = arr.findIndex((x) => x.id === chatId);
      if (ix >= 0) {
        const rec = arr[ix];
        rec.last = lastVal;
        rec.lastTs = ts;
        if (!mapped.fromMe)
          rec.unreadCount = (rec.unreadCount || 0) + 1;
        if (!rec.status)
          rec.status = rec.isLead === true ? "lead" : "client";
        atomicWrite(chatsFile(), {
          results: sortChats(arr),
          savedAt: Date.now(),
        });
        io.emit("chat-patch", {
          id: rec.id,
          last: rec.last,
          lastTs: rec.lastTs,
          unreadCount: rec.unreadCount,
          status: rec.status,
          isLead: rec.isLead,
        });
      } else {
        const status = !isGroup && !mapped.fromMe ? "lead" : "client";
        const rec = {
          id: chatId,
          name: `+${String(chatId).replace(/\D/g, "")}`,
          isGroup,
          unreadCount: mapped.fromMe ? 0 : 1,
          pinned: false,
          archived: false,
          last: lastVal,
          lastTs: ts,
          isLead: status === "lead",
          status,
        };
        atomicWrite(chatsFile(), {
          results: sortChats([rec, ...arr]),
          savedAt: Date.now(),
        });
        io.emit("chat-patch", rec);
        if (!isGroup && !mapped.fromMe)
          pushEventUniqueMonthly("lead_new", chatId, ts);
      }
    } catch {}
  };

  c.on("message", handleIncoming);
  c.on("message_create", handleIncoming);
};

const initialSync = async () => {
  const chats = await client.getChats();
  const mapped = chats
    .filter((c) => !/status@broadcast/i.test(c?.id?._serialized || ""))
    .map((c) => {
      const id = c?.id?._serialized;
      const name =
        c.name || c.formattedTitle || c.id?.user || id;
      return {
        id,
        name,
        isGroup: !!c.isGroup,
        unreadCount: c.unreadCount || 0,
        pinned: !!c.pinned,
        archived: !!c.archived,
        last: "",
        lastTs: 0,
        isLead: false,
        status: "client",
      };
    });

  try {
    const prev =
      safeRead(chatsFile(), { results: [] }).results || [];
    const byId = new Map(prev.map((x) => [x.id, x]));
    for (const x of mapped) {
      const old = byId.get(x.id);
      if (old) {
        x.last = old.last || x.last;
        x.lastTs = old.lastTs || x.lastTs;
        x.unreadCount =
          typeof old.unreadCount === "number"
            ? old.unreadCount
            : x.unreadCount;
        x.isLead =
          typeof old.isLead === "boolean" ? old.isLead : x.isLead;
        x.pinned = !!old.pinned;
        x.archived = !!old.archived;
        x.name = old.name || x.name;
        x.status =
          old.status ||
          (old.isLead === true ? "lead" : "client");
      }
    }
  } catch {}

  atomicWrite(chatsFile(), {
    results: sortChats(mapped),
    savedAt: Date.now(),
  });
  io.emit("chats-refresh");
};

// === boot клиента — как в твоём оригинале, только с логом + soft-error фильтром ===
const bootClient = async () => {
  console.log("Booting WhatsApp client...");
  try {
    if (client) await client.destroy();
  } catch {}

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: "default",
      dataPath: SESS_PATH,
    }),
    puppeteer: {
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  attachClientEvents(client);

  try {
    await client.initialize();
    console.log("WhatsApp client initialized");
  } catch (e) {
    if (isPuppeteerSoftError(e)) {
      console.warn(
        "Мягкая ошибка при init клиента, пробуем ещё раз через 15с..."
      );
    } else {
      console.error("WA init failed:", e?.message || e);
    }
    isReady = false;
    setTimeout(bootClient, 15000);
  }
};

bootClient();

/* ===== sockets ===== */
io.on("connection", (socket) => {
  socket.emit("status", {
    ready: isReady,
    step: isReady ? "ready" : lastQR ? "qr" : "init",
  });
  if (lastQR) socket.emit("qr", { dataUrl: lastQR });
});

/* ===== REST ===== */
app.get("/status", (req, res) =>
  res.json({
    ready: isReady,
    step: isReady ? "ready" : lastQR ? "qr" : "init",
    version: "stable-fallback-1",
  })
);

app.get("/qr", (req, res) =>
  lastQR
    ? res.json({ dataUrl: lastQR })
    : res.status(404).json({ error: "NO_QR" })
);

app.get("/chats", (req, res) => {
  try {
    const scope = String(req.query.scope || "").toLowerCase();
    const statusQ = String(req.query.status || "").toLowerCase();
    const onlyLeads =
      scope === "leads" ||
      req.query.lead === "1" ||
      statusQ === "lead";
    const onlyClients =
      scope === "clients" || statusQ === "client";
    const onlyDeclined =
      scope === "declined" || statusQ === "declined";

    const stored = safeRead(chatsFile(), { results: [] });
    const arr = (stored.results || []).map((x) => ({
      ...x,
      status:
        x.status || (x.isLead === true ? "lead" : "client"),
    }));

    let base = arr;
    if (onlyLeads)
      base = arr.filter(
        (x) => (x.status || "lead") === "lead"
      );
    else if (onlyClients)
      base = arr.filter(
        (x) => (x.status || "client") === "client"
      );
    else if (onlyDeclined)
      base = arr.filter(
        (x) => (x.status || "") === "declined"
      );

    const withPreviews = base.map((c) => {
      if (!c.last || !Number(c.lastTs)) {
        const ms =
          safeRead(msgFile(c.id), {
            results: [],
          }).results || [];
        const last = ms[ms.length - 1];
        if (last) {
          c.last =
            last.preview ||
            last.body ||
            `(${last.type})`;
          c.lastTs = Number(last.timestamp || 0);
        }
      }
      return c;
    });

    res.json(sortChats(withPreviews));
  } catch {
    res.status(500).json({ error: "CHATS_FAILED" });
  }
});

app.post("/refresh-chats", async (req, res) => {
  try {
    await initialSync();
    const stored = safeRead(chatsFile(), { results: [] });
    res.json({
      ok: true,
      count: (stored.results || []).length,
    });
  } catch {
    res.status(500).json({ error: "REFRESH_FAILED" });
  }
});

// ---- MESSAGES ----
app.get("/messages", async (req, res) => {
  const raw = req.query.chatId;
  let limit = Math.max(
    1,
    Math.min(Number(req.query.limit || 200), 400)
  );
  if (!raw) return res.status(400).json({ error: "BAD_REQUEST" });
  const id = sanitizeId(raw);

  const fallback = () => {
    const stored = safeRead(msgFile(id), { results: [] });
    return res.json({
      results: stored.results || [],
      live: false,
    });
  };

  try {
    if (!isReady) return fallback();
    let mapped = null;
    try {
      const chat = await client.getChatById(String(id));
      const messages = await chat.fetchMessages({ limit });
      mapped = [];
      const MEDIA_LAST = 12;
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const mm = mapMessage(m, id);
        if (
          messages.length - i <= MEDIA_LAST &&
          m.hasMedia &&
          ["image", "sticker", "audio", "ptt", "video", "document"].includes(
            mm.type
          )
        ) {
          try {
            const media = await m.downloadMedia();
            if (media)
              mm.media = {
                mimetype: media.mimetype,
                data: media.data,
                filename: m._data?.filename || null,
              };
          } catch {}
        }
        mapped.push(mm);
      }
      atomicWrite(msgFile(id), {
        results: mapped,
        savedAt: Date.now(),
      });
      return res.json({ results: mapped, live: true });
    } catch {
      return fallback();
    }
  } catch {
    return fallback();
  }
});

// ---- MARK SEEN ----
app.post("/mark-seen", async (req, res) => {
  const id = sanitizeId((req.body || {}).chatId);
  if (!id) return res.status(400).json({ error: "BAD_REQUEST" });

  let live = false;
  if (isReady) {
    try {
      const chat = await client.getChatById(String(id));
      await chat.sendSeen();
      live = true;
    } catch {}
  }
  try {
    const stored = safeRead(chatsFile(), { results: [] });
    const arr = stored.results || [];
    const ix = arr.findIndex((x) => x.id === id);
    if (ix >= 0) {
      arr[ix].unreadCount = 0;
      atomicWrite(chatsFile(), {
        results: sortChats(arr),
        savedAt: Date.now(),
      });
      io.emit("chat-patch", { id, unreadCount: 0 });
    }
  } catch {}
  return res.json({ ok: true, live });
});

// ---- SEND TEXT/MEDIA/LOCATION ----
app.post("/send", async (req, res) => {
  try {
    if (!isReady)
      return res
        .status(409)
        .json({ error: "WHATSAPP_NOT_READY" });
    const { text, quotedMessageId } = req.body || {};
    const target = normalizeTarget(req.body || {});
    if (!text || !target)
      return res.status(400).json({ error: "BAD_REQUEST" });
    const options = {};
    if (quotedMessageId) options.quotedMessageId = quotedMessageId;
    const sent = await client.sendMessage(target, text, options);

    const mapped = mapMessage(sent, target);
    persistAndEmit(target, mapped);

    const ts = Number(mapped.timestamp || nowSec());
    upsertChatLast(
      target,
      mapped.preview || mapped.body || "(chat)",
      ts
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "SEND_FAILED" });
  }
});

app.post(
  "/send-media",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!isReady)
        return res
          .status(409)
          .json({ error: "WHATSAPP_NOT_READY" });
      const target = normalizeTarget(req.body || {});
      if (!req.file || !target)
        return res
          .status(400)
          .json({ error: "BAD_REQUEST" });
      const media = MessageMedia.fromFilePath(req.file.path);
      const options = {};
      if (req.body?.caption) options.caption = req.body.caption;
      if (req.body?.quotedMessageId)
        options.quotedMessageId = req.body.quotedMessageId;
      const sent = await client.sendMessage(
        target,
        media,
        options
      );

      const mapped = mapMessage(sent, target);
      persistAndEmit(target, mapped);

      const ts = Number(mapped.timestamp || nowSec());
      upsertChatLast(
        target,
        mapped.preview || "(media)",
        ts
      );

      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "SEND_MEDIA_FAILED" });
    }
  }
);

app.post("/send-location", async (req, res) => {
  try {
    if (!isReady)
      return res
        .status(409)
        .json({ error: "WHATSAPP_NOT_READY" });
    const target = normalizeTarget(req.body || {});
    const {
      latitude,
      longitude,
      description,
      quotedMessageId,
    } = req.body || {};
    if (
      !target ||
      typeof latitude !== "number" ||
      typeof longitude !== "number"
    )
      return res.status(400).json({ error: "BAD_REQUEST" });
    const options = {};
    if (quotedMessageId) options.quotedMessageId = quotedMessageId;
    const sent = await client.sendMessage(
      target,
      new Location(
        latitude,
        longitude,
        description || ""
      ),
      options
    );

    const mapped = mapMessage(sent, target);
    persistAndEmit(target, mapped);

    const ts = Number(mapped.timestamp || nowSec());
    upsertChatLast(
      target,
      mapped.preview || "(location)",
      ts
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "SEND_LOCATION_FAILED" });
  }
});

// ---- STATUS & FLAG ----
const statusHandler = (req, res) => {
  try {
    const { chatId, status } = req.body || {};
    if (
      !chatId ||
      !["lead", "client", "declined"].includes(
        String(status)
      )
    )
      return res.status(400).json({ error: "BAD_REQUEST" });
    const id = sanitizeId(chatId);
    const stored = safeRead(chatsFile(), { results: [] });
    const arr = stored.results || [];
    const ix = arr.findIndex((x) => x.id === id);
    if (ix < 0)
      return res
        .status(404)
        .json({ error: "NOT_FOUND" });

    const prev =
      arr[ix].status ||
      (arr[ix].isLead === true ? "lead" : "client");
    arr[ix].status = status;
    arr[ix].isLead = status === "lead";

    atomicWrite(chatsFile(), {
      results: sortChats(arr),
      savedAt: Date.now(),
    });
    io.emit("chat-patch", {
      id,
      status,
      isLead: arr[ix].isLead,
    });

    const nowTs = nowSec();
    if (prev !== "client" && status === "client")
      pushEventUniqueMonthly("client_new", id, nowTs);
    if (prev !== "declined" && status === "declined")
      pushEventUniqueMonthly("decline", id, nowTs);

    res.json({ ok: true, id, status });
  } catch {
    res.status(500).json({ error: "STATUS_FAILED" });
  }
};
app.patch("/chat/status", statusHandler);
app.post("/chat/status", statusHandler);

const flagHandler = (req, res) => {
  try {
    const { chatId, isLead } = req.body || {};
    if (!chatId || typeof isLead !== "boolean")
      return res.status(400).json({ error: "BAD_REQUEST" });
    const id = sanitizeId(chatId);
    const stored = safeRead(chatsFile(), { results: [] });
    const arr = stored.results || [];
    const ix = arr.findIndex((x) => x.id === id);
    if (ix < 0)
      return res
        .status(404)
        .json({ error: "NOT_FOUND" });

    arr[ix].isLead = isLead;
    const prev =
      arr[ix].status ||
      (isLead ? "lead" : "client");
    arr[ix].status = isLead ? "lead" : "client";

    atomicWrite(chatsFile(), {
      results: sortChats(arr),
      savedAt: Date.now(),
    });
    io.emit("chat-patch", {
      id,
      isLead: arr[ix].isLead,
      status: arr[ix].status,
    });

    const nowTs = nowSec();
    if (prev !== "client" && arr[ix].status === "client")
      pushEventUniqueMonthly("client_new", id, nowTs);

    res.json({
      ok: true,
      id,
      isLead: arr[ix].isLead,
      status: arr[ix].status,
    });
  } catch {
    res.status(500).json({ error: "FLAG_FAILED" });
  }
};
app.patch("/chat/flag", flagHandler);
app.post("/chat/flag", flagHandler);

// ---- ANALYTICS ----
app.get("/analytics", (req, res) => {
  try {
    const from = req.query.from
      ? new Date(req.query.from + "T00:00:00").getTime() / 1000
      : 0;
    const to = req.query.to
      ? new Date(req.query.to + "T23:59:59").getTime() / 1000
      : nowSec();
    const a = readAnalytics();
    const inRange = (ts) =>
      Number(ts) >= from && Number(ts) <= to;
    let leadsNew = 0,
      clientsNew = 0,
      declines = 0;
    for (const ev of a.events || []) {
      if (!inRange(ev.ts)) continue;
      if (ev.type === "lead_new") leadsNew++;
      else if (ev.type === "client_new") clientsNew++;
      else if (ev.type === "decline") declines++;
    }
    res.json({ leadsNew, clientsNew, declines });
  } catch {
    res.status(500).json({ error: "ANALYTICS_FAILED" });
  }
});

app.post("/logout", async (req, res) => {
  try {
    isReady = false;
    io.emit("status", { ready: false, step: "logout" });
    try {
      await client.logout();
    } catch {}
    try {
      await client.destroy();
    } catch {}
    try {
      await fsp.rm(SESS_PATH, { recursive: true, force: true });
    } catch {}
    lastQR = null;
    bootClient();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "LOGOUT_FAILED" });
  }
});

server.listen(PORT, () => {
  console.log(`WhatsApp backend listening on port ${PORT}`);
});
