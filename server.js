import http from "node:http";
import fs from "node:fs";
import path from "node:path";

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

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MESSAGE_FLAG_SUPPRESS_EMBEDS = 1 << 2; // 4

fs.mkdirSync(ARTICLES_DIR, { recursive: true });

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

      return sendJson(res, 201, {
        ok: true,
        file: path.basename(targetPath),
        url: buildArticleLink(path.basename(targetPath)),
        discordSynced,
        discordError,
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