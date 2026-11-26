import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT) || 3000;
const ARTICLES_DIR = path.resolve(process.env.ARTICLES_DIR || "./articles");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const PASSWORD = process.env.PASSWORD || "";
const ARTICLE_BASE_URL = (
  process.env.ARTICLE_BASE_URL || "https://breakmine.com/#article/"
).trim();

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || "").trim();
const DISCORD_CHANNEL_ID = (process.env.DISCORD_CHANNEL_ID || "").trim();
const DISCORD_STATE_FILE = path.resolve(
  process.env.DISCORD_STATE_FILE || "./discord-posts.json"
);

const PUSH_SUBS_FILE = path.resolve(
  process.env.PUSH_SUBS_FILE || "./push-subscriptions.json"
);
const VAPID_KEYS_FILE = path.resolve(
  process.env.VAPID_KEYS_FILE || "./vapid-keys.json"
);
const VAPID_SUBJECT = (
  process.env.VAPID_SUBJECT || "mailto:admin@breakmine.com"
).trim();

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MESSAGE_FLAG_SUPPRESS_EMBEDS = 1 << 2; // 4

fs.mkdirSync(ARTICLES_DIR, { recursive: true });

/* -------------------- Web Push (VAPID + RFC 8291 / 8188) -------------------- */

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(str) {
  const padded = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}

function loadOrCreateVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY.trim(),
      privateKey: process.env.VAPID_PRIVATE_KEY.trim(),
    };
  }
  try {
    if (fs.existsSync(VAPID_KEYS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(VAPID_KEYS_FILE, "utf8"));
      if (parsed?.publicKey && parsed?.privateKey) return parsed;
    }
  } catch (err) {
    console.warn("Failed to read VAPID keys file:", err.message);
  }

  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = {
    publicKey: b64urlEncode(ecdh.getPublicKey()),
    privateKey: b64urlEncode(ecdh.getPrivateKey()),
  };

  try {
    fs.writeFileSync(VAPID_KEYS_FILE, JSON.stringify(keys, null, 2), "utf8");
  } catch (err) {
    console.warn("Failed to save VAPID keys file:", err.message);
  }
  return keys;
}

const vapidKeys = loadOrCreateVapidKeys();

function loadPushSubscriptions() {
  try {
    if (!fs.existsSync(PUSH_SUBS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("Failed to load push subscriptions:", err.message);
    return [];
  }
}

function savePushSubscriptions(subs) {
  try {
    fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(subs, null, 2), "utf8");
  } catch (err) {
    console.warn("Failed to save push subscriptions:", err.message);
  }
}

let pushSubscriptions = loadPushSubscriptions();

function savePushSubscription(sub) {
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error("Invalid push subscription");
  }
  const idx = pushSubscriptions.findIndex((s) => s.endpoint === sub.endpoint);
  if (idx >= 0) {
    pushSubscriptions[idx] = sub;
  } else {
    pushSubscriptions.push(sub);
  }
  savePushSubscriptions(pushSubscriptions);
}

function createVapidAuthHeader(endpointUrl) {
  const origin = new URL(endpointUrl).origin;
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64urlEncode(
    JSON.stringify({ aud: origin, exp: now + 12 * 3600, sub: VAPID_SUBJECT })
  );
  const unsigned = `${header}.${payload}`;

  const privBuf = b64urlDecode(vapidKeys.privateKey);
  const pubBuf = b64urlDecode(vapidKeys.publicKey);
  const pkcs8Header = Buffer.from(
    "308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420",
    "hex"
  );
  const pubTag = Buffer.from("a123032100", "hex");
  const der = Buffer.concat([pkcs8Header, privBuf, pubTag, pubBuf]);
  const keyObj = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const sig = crypto.sign("sha256", Buffer.from(unsigned), {
    key: keyObj,
    dsaEncoding: "ieee-p1363",
  });

  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${vapidKeys.publicKey}`;
}

function hkdfExtractAndExpand(salt, ikm, info, len) {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  const t = crypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();
  return t.subarray(0, len);
}

function encryptWebPushPayload(subscription, jsonPayload) {
  const clientPub = b64urlDecode(subscription.keys.p256dh);
  const clientAuth = b64urlDecode(subscription.keys.auth);

  const serverEcdh = crypto.createECDH("prime256v1");
  serverEcdh.generateKeys();
  const serverPub = serverEcdh.getPublicKey(); // 65 bytes uncompressed
  const sharedSecret = serverEcdh.computeSecret(clientPub);

  const salt = crypto.randomBytes(16);
  const authInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    clientPub,
    serverPub,
  ]);
  const ikm = hkdfExtractAndExpand(clientAuth, sharedSecret, authInfo, 32);

  const cek = hkdfExtractAndExpand(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdfExtractAndExpand(salt, ikm, "Content-Encoding: nonce\0", 12);

  const plainBuf = Buffer.from(JSON.stringify(jsonPayload), "utf8");
  const padded = Buffer.concat([plainBuf, Buffer.from([2])]); // delimiter 0x02

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();

  // RFC 8188 aes128gcm header: salt(16) + rs(4) + idlen(1) + keyid(65)
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(4096, 0);
  const header = Buffer.concat([
    salt,
    rsBuf,
    Buffer.from([serverPub.length]),
    serverPub,
  ]);

  return Buffer.concat([header, encrypted, tag]);
}

async function notifySubscribersNewArticle(fileName, article) {
  if (!pushSubscriptions.length) return { sent: 0, failed: 0 };

  const payload = {
    title: `New Breakmine Article: ${article.title || "Untitled"}`,
    body: [article.category || "update", article.author ? `by ${article.author}` : ""]
      .filter(Boolean)
      .join(" / "),
    url: buildArticleLink(fileName),
  };

  let sent = 0;
  let failed = 0;
  const remaining = [];

  for (const sub of pushSubscriptions) {
    try {
      const body = encryptWebPushPayload(sub, payload);
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          Authorization: createVapidAuthHeader(sub.endpoint),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: "86400",
        },
        body,
      });

      if (res.ok || res.status === 201) {
        sent++;
        remaining.push(sub);
      } else if (res.status === 404 || res.status === 410) {
        // Subscription expired or unsubscribed
        failed++;
      } else {
        failed++;
        remaining.push(sub);
      }
    } catch {
      failed++;
      remaining.push(sub);
    }
  }

  pushSubscriptions = remaining;
  savePushSubscriptions(pushSubscriptions);
  return { sent, failed };
}

/* -------------------- Discord Sync -------------------- */

function loadDiscordState() {
  try {
    if (!fs.existsSync(DISCORD_STATE_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(DISCORD_STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.warn("Failed to load Discord state file:", err.message);
    return {};
  }
}

function saveDiscordState(state) {
  try {
    fs.writeFileSync(DISCORD_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn("Failed to save Discord state file:", err.message);
  }
}

let discordState = loadDiscordState();

function formatUploadDate(date = new Date()) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function buildArticleLink(fileName) {
  const slug = encodeURIComponent(path.basename(String(fileName || ""), ".html"));
  if (!ARTICLE_BASE_URL) return "";
  if (ARTICLE_BASE_URL.includes("#")) {
    const prefix = ARTICLE_BASE_URL.endsWith("/")
      ? ARTICLE_BASE_URL
      : `${ARTICLE_BASE_URL}/`;
    return `${prefix}${slug}`;
  }
  const normalizedBase = ARTICLE_BASE_URL.replace(/\/+$/, "");
  return `${normalizedBase}/#article/${slug}`;
}

function formatDiscordMessage({ title, author, category, dateUploaded, fileName }) {
  const cleanTitle = String(title || "Untitled").trim();
  const cleanAuthor = String(author || "Unknown").trim();
  const cleanCategory = String(category || "update").trim();
  const cleanDate = String(dateUploaded || formatUploadDate()).trim();
  const articleUrl = buildArticleLink(fileName);

  const lines = [
    "@here",
    `# ${cleanTitle}`,
    `By ${cleanAuthor}`,
    `-# ${cleanCategory} / ${cleanDate}`,
  ];

  if (articleUrl) {
    lines.push(articleUrl);
  }

  return lines.join("\n");
}

function isDiscordConfigured() {
  return Boolean(DISCORD_TOKEN && DISCORD_CHANNEL_ID);
}

async function discordRequest(endpoint, method, body) {
  const res = await fetch(`${DISCORD_API_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Discord API ${method} ${endpoint} failed (${res.status}): ${errText}`);
  }

  return res.json();
}

async function postArticleToDiscord(fileName, article) {
  if (!isDiscordConfigured()) return;

  const uploadedAt = discordState[fileName]?.uploadedAt || formatUploadDate();
  const content = formatDiscordMessage({
    title: article.title,
    author: article.author,
    category: article.category,
    dateUploaded: uploadedAt,
    fileName,
  });

  const created = await discordRequest(
    `/channels/${encodeURIComponent(DISCORD_CHANNEL_ID)}/messages`,
    "POST",
    {
      content,
      flags: MESSAGE_FLAG_SUPPRESS_EMBEDS,
      allowed_mentions: { parse: ["users", "roles", "everyone"] },
    }
  );

  discordState[fileName] = {
    messageId: created.id,
    channelId: DISCORD_CHANNEL_ID,
    uploadedAt,
  };
  saveDiscordState(discordState);
}

async function updateArticleInDiscord(oldFileName, newFileName, article) {
  if (!isDiscordConfigured()) return;

  const existingRecord = discordState[oldFileName] || discordState[newFileName];
  if (!existingRecord?.messageId) {
    await postArticleToDiscord(newFileName, article);
    return;
  }

  const targetChannelId = existingRecord.channelId || DISCORD_CHANNEL_ID;
  const uploadedAt = existingRecord.uploadedAt || formatUploadDate();
  const content = formatDiscordMessage({
    title: article.title,
    author: article.author,
    category: article.category,
    dateUploaded: uploadedAt,
    fileName: newFileName,
  });

  await discordRequest(
    `/channels/${encodeURIComponent(targetChannelId)}/messages/${encodeURIComponent(existingRecord.messageId)}`,
    "PATCH",
    {
      content,
      flags: MESSAGE_FLAG_SUPPRESS_EMBEDS,
      allowed_mentions: { parse: ["users", "roles", "everyone"] },
    }
  );

  if (oldFileName !== newFileName) {
    delete discordState[oldFileName];
  }

  discordState[newFileName] = {
    messageId: existingRecord.messageId,
    channelId: targetChannelId,
    uploadedAt,
  };
  saveDiscordState(discordState);
}

/* -------------------- Article Storage & HTTP -------------------- */

function safeFilePath(fileName) {
  const base = path.basename(String(fileName || ""));
  if (!base || base !== fileName || !/\.html$/i.test(base)) return null;
  const resolved = path.resolve(ARTICLES_DIR, base);
  return resolved.startsWith(ARTICLES_DIR + path.sep) ? resolved : null;
}

function escapeAttr(str) {
  return String(str || "")
    .replace(/&/g, "&")
    .replace(/"/g, "\"")
    .replace(/</g, "<")
    .replace(/>/g, ">");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");
}

function parseArticleHtml(raw) {
  const titleMatch =
    raw.match(/<meta\s+name=["']title["']\s+content=["']([\s\S]*?)["']\s*\/?>/i) ||
    raw.match(/<title>([\s\S]*?)<\/title>/i) ||
    raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  const authorMatch = raw.match(
    /<meta\s+name=["']author["']\s+content=["']([\s\S]*?)["']\s*\/?>/i
  );

  const categoryMatch = raw.match(
    /<meta\s+name=["']category["']\s+content=["']([\s\S]*?)["']\s*\/?>/i
  );

  const bodyMatch = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);

  return {
    title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "",
    author: authorMatch ? authorMatch[1].trim() : "",
    category: categoryMatch ? categoryMatch[1].trim().toLowerCase() : "update",
    html: bodyMatch ? bodyMatch[1].trim() : raw.trim(),
  };
}

function buildArticleHtml({ title, author, category, html }) {
  const safeTitle = String(title || "Untitled").trim();
  const safeAuthor = String(author || "").trim();
  const safeCategory = String(category || "update").trim().toLowerCase();
  const bodyContent = String(html || "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="title" content="${escapeAttr(safeTitle)}" />
  <meta name="author" content="${escapeAttr(safeAuthor)}" />
  <meta name="category" content="${escapeAttr(safeCategory)}" />
  <title>${escapeHtml(safeTitle)}</title>
</head>
<body>
${bodyContent}
</body>
</html>
`;
}

function listArticles() {
  return fs
    .readdirSync(ARTICLES_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.html$/i.test(e.name))
    .map((e) => {
      const fullPath = path.join(ARTICLES_DIR, e.name);
      const raw = fs.readFileSync(fullPath, "utf8");
      const stats = fs.statSync(fullPath);
      const parsed = parseArticleHtml(raw);
      return {
        file: e.name,
        title: parsed.title || e.name.replace(/\.html$/i, ""),
        author: parsed.author,
        category: parsed.category,
        modified: stats.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

function isAuthorized(req) {
  if (!PASSWORD) return false;
  const auth = req.headers["authorization"] || "";
  return auth === `Bearer ${PASSWORD}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

const EDITOR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HTML Article Editor</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #111; color: #eee; display: grid; grid-template-rows: auto 1fr; height: 100vh; }
    header { display: flex; gap: 8px; padding: 10px; background: #1c1c1c; border-bottom: 1px solid #333; align-items: center; flex-wrap: wrap; }
    input, select, textarea { background: #0b0b0b; color: #eee; border: 1px solid #333; border-radius: 4px; padding: 7px 9px; font-family: inherit; }
    button { padding: 6px 10px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; color: #fff; cursor: pointer; font-size: 13px; }
    button:hover { background: #363636; }
    button.primary { background: #1f6feb; border-color: #1f6feb; }
    button.danger { background: #a4262c; border-color: #a4262c; }
    button.active { background: #1f6feb; border-color: #1f6feb; }
    main { display: grid; grid-template-columns: 240px 1fr 1fr; min-height: 0; }
    aside { border-right: 1px solid #333; padding: 10px; overflow-y: auto; }
    .item { padding: 8px; border-radius: 4px; cursor: pointer; margin-bottom: 4px; }
    .item:hover { background: #222; }
    .item.active { background: #1f6feb; }
    .item small { display: block; opacity: 0.75; }
    .pane { padding: 12px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
    .pane + .pane { border-left: 1px solid #333; }
    .meta-row { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px; background: #1c1c1c; border: 1px solid #333; border-radius: 4px; align-items: center; }
    .sep { width: 1px; height: 20px; background: #333; margin: 0 4px; }
    .toolbar input[type="color"] { padding: 0; width: 28px; height: 28px; border: 1px solid #444; cursor: pointer; background: none; }
    #richtext { flex: 1; overflow-y: auto; background: #0b0b0b; border: 1px solid #333; border-radius: 4px; padding: 14px; outline: none; line-height: 1.6; }
    #richtext:focus { border-color: #1f6feb; }
    textarea { flex: 1; resize: none; font-family: ui-monospace, monospace; font-size: 14px; line-height: 1.5; }
    #preview { flex: 1; overflow-y: auto; background: #0b0b0b; border: 1px solid #333; border-radius: 4px; padding: 14px; line-height: 1.6; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <header>
    <input id="pw" type="password" placeholder="Password" />
    <button id="refreshBtn">Refresh</button>
    <button id="newBtn">+ New</button>
    <span id="status"></span>
  </header>
  <main>
    <aside id="list"></aside>
    <div class="pane">
      <div class="meta-row">
        <input id="file" type="text" placeholder="my-article.html" />
        <input id="title" type="text" placeholder="Article Title" />
        <input id="author" type="text" placeholder="Author" />
        <select id="category">
          <option value="update">update</option>
          <option value="modding">modding</option>
          <option value="devlog">devlog</option>
          <option value="community">community</option>
        </select>
      </div>

      <div class="toolbar" id="toolbar">
        <button type="button" id="btnRich" class="active">Rich Text</button>
        <button type="button" id="btnHtml">HTML</button>
        <div class="sep"></div>

        <button type="button" data-cmd="bold" title="Bold"><b>B</b></button>
        <button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
        <button type="button" data-cmd="underline" title="Underline"><u>U</u></button>
        <button type="button" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
        <div class="sep"></div>

        <button type="button" data-block="H1">H1</button>
        <button type="button" data-block="H2">H2</button>
        <button type="button" data-block="H3">H3</button>
        <button type="button" data-block="P">P</button>
        <button type="button" data-block="BLOCKQUOTE">Quote</button>
        <div class="sep"></div>

        <button type="button" data-cmd="insertUnorderedList">• List</button>
        <button type="button" data-cmd="insertOrderedList">1. List</button>
        <div class="sep"></div>

        <button type="button" id="btnMono" title="Monospace">Mono</button>
        <button type="button" id="btnLink" title="Link">Link</button>
        <button type="button" id="btnImg" title="Image URL">Image</button>
        <input type="color" id="btnColor" value="#ffffff" title="Color" />
        <button type="button" data-cmd="removeFormat" title="Clear Format">Clear</button>
      </div>

      <div id="richtext" contenteditable="true"></div>
      <textarea id="html" class="hidden" placeholder="<p>Write HTML here...</p>"></textarea>

      <div style="display:flex; gap:8px;">
        <button class="primary" id="saveBtn">Save</button>
        <button class="danger" id="delBtn">Delete</button>
      </div>
    </div>
    <div class="pane">
      <strong>Preview</strong>
      <div id="preview"></div>
    </div>
  </main>
  <script>
    const pwEl = document.getElementById("pw");
    const listEl = document.getElementById("list");
    const fileEl = document.getElementById("file");
    const titleEl = document.getElementById("title");
    const authorEl = document.getElementById("author");
    const categoryEl = document.getElementById("category");
    const richEl = document.getElementById("richtext");
    const htmlEl = document.getElementById("html");
    const previewEl = document.getElementById("preview");
    const statusEl = document.getElementById("status");
    const btnRich = document.getElementById("btnRich");
    const btnHtml = document.getElementById("btnHtml");

    document.execCommand("styleWithCSS", false, true);

    let currentFile = null;
    let mode = "rich";
    pwEl.value = sessionStorage.getItem("article_pw") || "";

    function setStatus(msg) { statusEl.textContent = msg; }
    function getPw() {
      const pw = pwEl.value;
      sessionStorage.setItem("article_pw", pw);
      return pw;
    }

    function enforceInlineStyles(container) {
      container.querySelectorAll("img").forEach((img) => {
        img.style.maxWidth = "500px";
        img.style.height = "auto";
      });
      container.querySelectorAll("code").forEach((codeEl) => {
        const span = document.createElement("span");
        span.setAttribute("style", "font-family:monospace; margin-left: 3px; margin-right: 3px;");
        span.textContent = codeEl.textContent;
        codeEl.replaceWith(span);
      });
      container.querySelectorAll("span").forEach((span) => {
        const fam = (span.style.fontFamily || "").toLowerCase();
        if (fam.includes("monospace")) {
          span.setAttribute("style", "font-family:monospace; margin-left: 3px; margin-right: 3px;");
        }
      });
    }

    function syncFromRich() {
      enforceInlineStyles(richEl);
      htmlEl.value = richEl.innerHTML;
      previewEl.innerHTML = htmlEl.value;
    }

    function syncFromHtml() {
      richEl.innerHTML = htmlEl.value;
      enforceInlineStyles(richEl);
      previewEl.innerHTML = htmlEl.value;
    }

    function switchMode(nextMode) {
      mode = nextMode;
      if (mode === "rich") {
        syncFromHtml();
        richEl.classList.remove("hidden");
        htmlEl.classList.add("hidden");
        btnRich.classList.add("active");
        btnHtml.classList.remove("active");
      } else {
        syncFromRich();
        richEl.classList.add("hidden");
        htmlEl.classList.remove("hidden");
        btnHtml.classList.add("active");
        btnRich.classList.remove("active");
      }
    }

    btnRich.onclick = () => switchMode("rich");
    btnHtml.onclick = () => switchMode("html");

    document.querySelectorAll("button[data-cmd]").forEach((btn) => {
      btn.onclick = () => {
        if (mode !== "rich") switchMode("rich");
        richEl.focus();
        document.execCommand(btn.dataset.cmd, false, null);
        syncFromRich();
      };
    });

    document.querySelectorAll("button[data-block]").forEach((btn) => {
      btn.onclick = () => {
        if (mode !== "rich") switchMode("rich");
        richEl.focus();
        document.execCommand("formatBlock", false, btn.dataset.block);
        syncFromRich();
      };
    });

    document.getElementById("btnColor").addEventListener("change", (e) => {
      if (mode !== "rich") switchMode("rich");
      richEl.focus();
      document.execCommand("foreColor", false, e.target.value);
      syncFromRich();
    });

    document.getElementById("btnLink").onclick = () => {
      const url = prompt("Link URL:", "https://");
      if (!url) return;
      if (mode !== "rich") switchMode("rich");
      richEl.focus();
      document.execCommand("createLink", false, url.trim());
      syncFromRich();
    };

    document.getElementById("btnImg").onclick = () => {
      const url = prompt("Image URL:", "https://");
      if (!url) return;
      if (mode !== "rich") switchMode("rich");
      richEl.focus();
      const safeUrl = url.trim().replace(/"/g, """);
      document.execCommand(
        "insertHTML",
        false,
        '<img src="' + safeUrl + '" style="max-width: 500px; height: auto;" />'
      );
      syncFromRich();
    };

    document.getElementById("btnMono").onclick = () => {
      if (mode !== "rich") switchMode("rich");
      richEl.focus();
      const sel = window.getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString() : "/tp";
      document.execCommand(
        "insertHTML",
        false,
        '<span style="font-family:monospace; margin-left: 3px; margin-right: 3px;">' +
          text.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">") +
          "</span>"
      );
      syncFromRich();
    };

    richEl.addEventListener("input", syncFromRich);
    htmlEl.addEventListener("input", syncFromHtml);

    async function loadList() {
      const res = await fetch("/articles", { cache: "no-store" });
      const items = await res.json();
      listEl.replaceChildren();
      for (const item of items) {
        const div = document.createElement("div");
        div.className = "item" + (item.file === currentFile ? " active" : "");
        const t = document.createElement("div");
        t.textContent = item.title;
        const s = document.createElement("small");
        s.textContent = [item.file, item.category, item.author].filter(Boolean).join(" • ");
        div.append(t, s);
        div.onclick = () => openArticle(item.file);
        listEl.appendChild(div);
      }
      setStatus(items.length + " article(s)");
    }

    async function openArticle(file) {
      const res = await fetch("/articles/" + encodeURIComponent(file), { cache: "no-store" });
      if (!res.ok) return setStatus("Failed to load " + file);
      const data = await res.json();
      currentFile = data.file;
      fileEl.value = data.file;
      titleEl.value = data.title || "";
      authorEl.value = data.author || "";
      categoryEl.value = data.category || "update";
      htmlEl.value = data.html || "";
      syncFromHtml();
      loadList();
      setStatus("Editing " + data.file);
    }

    function newArticle() {
      currentFile = null;
      fileEl.value = "";
      titleEl.value = "";
      authorEl.value = "";
      categoryEl.value = "update";
      htmlEl.value = "<p>Hello world</p>";
      syncFromHtml();
      loadList();
      setStatus("New article");
    }

    async function saveArticle() {
      if (mode === "rich") syncFromRich();
      const file = fileEl.value.trim();
      if (!file.endsWith(".html")) return setStatus("Filename must end in .html");
      const payload = {
        file: currentFile ? undefined : file,
        newName: currentFile ? file : undefined,
        title: titleEl.value,
        author: authorEl.value,
        category: categoryEl.value,
        html: htmlEl.value,
      };
      const res = await fetch(
        currentFile ? "/articles/" + encodeURIComponent(currentFile) : "/articles",
        {
          method: currentFile ? "PUT" : "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + getPw(),
          },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setStatus("Error: " + (data.error || res.status));
      currentFile = data.file || file;
      fileEl.value = currentFile;
      await loadList();
      setStatus("Saved " + currentFile);
    }

    async function deleteArticle() {
      if (!currentFile) return setStatus("Select an article first");
      const res = await fetch("/articles/" + encodeURIComponent(currentFile), {
        method: "DELETE",
        headers: { "Authorization": "Bearer " + getPw() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setStatus("Error: " + (data.error || res.status));
      newArticle();
      await loadList();
      setStatus("Deleted");
    }

    document.getElementById("refreshBtn").onclick = loadList;
    document.getElementById("newBtn").onclick = newArticle;
    document.getElementById("saveBtn").onclick = saveArticle;
    document.getElementById("delBtn").onclick = deleteArticle;

    newArticle();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/editor") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(EDITOR_HTML);
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/push/vapid-public-key") {
      return sendJson(res, 200, { publicKey: vapidKeys.publicKey });
    }

    if (req.method === "POST" && url.pathname === "/push/subscribe") {
      const sub = await readJsonBody(req);
      savePushSubscription(sub);
      return sendJson(res, 201, { ok: true, subscribers: pushSubscriptions.length });
    }

    if (req.method === "GET" && url.pathname === "/articles") {
      return sendJson(res, 200, listArticles());
    }

    const match = url.pathname.match(/^\/articles\/([^/]+)$/);
    if (match) {
      const targetName = decodeURIComponent(match[1]);
      const targetPath = safeFilePath(targetName);
      if (!targetPath) {
        return sendJson(res, 400, { error: "Invalid .html filename" });
      }

      if (req.method === "GET") {
        if (!fs.existsSync(targetPath)) {
          return sendJson(res, 404, { error: "Not found" });
        }
        const parsed = parseArticleHtml(fs.readFileSync(targetPath, "utf8"));
        return sendJson(res, 200, { file: targetName, ...parsed });
      }

      if (!isAuthorized(req)) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }

      if (req.method === "PUT") {
        if (!fs.existsSync(targetPath)) {
          return sendJson(res, 404, { error: "Not found" });
        }
        const body = await readJsonBody(req);
        const nextName = body.newName || targetName;
        const nextPath = safeFilePath(nextName);
        if (!nextPath) {
          return sendJson(res, 400, { error: "Invalid filename" });
        }
        const existing = parseArticleHtml(fs.readFileSync(targetPath, "utf8"));
        const nextArticle = {
          title: body.title ?? existing.title,
          author: body.author ?? existing.author,
          category: body.category ?? existing.category,
          html: body.html ?? existing.html,
        };
        const outHtml = buildArticleHtml(nextArticle);
        fs.writeFileSync(nextPath, outHtml, "utf8");
        if (nextPath !== targetPath) fs.unlinkSync(targetPath);

        let discordSynced = false;
        let discordError = null;
        try {
          await updateArticleInDiscord(targetName, path.basename(nextPath), nextArticle);
          discordSynced = isDiscordConfigured();
        } catch (err) {
          discordError = err.message;
          console.error("Discord edit failed:", err.message);
        }

        return sendJson(res, 200, {
          ok: true,
          file: path.basename(nextPath),
          url: buildArticleLink(path.basename(nextPath)),
          discordSynced,
          discordError,
        });
      }

      if (req.method === "DELETE") {
        if (!fs.existsSync(targetPath)) {
          return sendJson(res, 404, { error: "Not found" });
        }
        fs.unlinkSync(targetPath);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (req.method === "POST" && url.pathname === "/articles") {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }
      const body = await readJsonBody(req);
      const targetPath = safeFilePath(body.file);
      if (!targetPath) {
        return sendJson(res, 400, { error: "Invalid .html filename" });
      }
      if (fs.existsSync(targetPath)) {
        return sendJson(res, 409, { error: "Already exists" });
      }
      const newArticle = {
        title: body.title,
        author: body.author,
        category: body.category,
        html: body.html,
      };
      const outHtml = buildArticleHtml(newArticle);
      fs.writeFileSync(targetPath, outHtml, "utf8");

      let discordSynced = false;
      let discordError = null;
      try {
        await postArticleToDiscord(path.basename(targetPath), newArticle);
        discordSynced = isDiscordConfigured();
      } catch (err) {
        discordError = err.message;
        console.error("Discord post failed:", err.message);
      }

      const pushResult = await notifySubscribersNewArticle(
        path.basename(targetPath),
        newArticle
      ).catch((err) => ({ sent: 0, failed: 0, error: err.message }));

      return sendJson(res, 201, {
        ok: true,
        file: path.basename(targetPath),
        url: buildArticleLink(path.basename(targetPath)),
        discordSynced,
        discordError,
        push: pushResult,
      });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 400, { error: err.message || "Bad request" });
  }
});

server.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});