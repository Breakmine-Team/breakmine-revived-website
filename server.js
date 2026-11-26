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
    button.primary:hover { background: #2b7af0; }
    button.danger { background: #a4262c; border-color: #a4262c; }
    button.active-tab { background: #1f6feb; border-color: #1f6feb; }
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
    .toolbar-sep { width: 1px; height: 20px; background: #333; margin: 0 4px; }
    .toolbar input[type="color"] { padding: 0; width: 28px; height: 28px; border: 1px solid #444; cursor: pointer; background: none; }
    #wysiwyg { flex: 1; overflow-y: auto; background: #0b0b0b; border: 1px solid #333; border-radius: 4px; padding: 14px; outline: none; line-height: 1.6; }
    #wysiwyg:focus { border-color: #1f6feb; }
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
        <button type="button" data-mode="visual" class="active-tab" id="tabVisual">Visual</button>
        <button type="button" data-mode="code" id="tabCode">HTML</button>
        <div class="toolbar-sep"></div>

        <button type="button" data-action="bold" title="Bold"><b>B</b></button>
        <button type="button" data-action="italic" title="Italic"><i>I</i></button>
        <button type="button" data-action="underline" title="Underline"><u>U</u></button>
        <button type="button" data-action="strike" title="Strikethrough"><s>S</s></button>
        <div class="toolbar-sep"></div>

        <button type="button" data-action="h1" title="Heading 1">H1</button>
        <button type="button" data-action="h2" title="Heading 2">H2</button>
        <button type="button" data-action="h3" title="Heading 3">H3</button>
        <button type="button" data-action="p" title="Paragraph">P</button>
        <div class="toolbar-sep"></div>

        <button type="button" data-action="ul" title="Bullet List">• List</button>
        <button type="button" data-action="ol" title="Numbered List">1. List</button>
        <button type="button" data-action="quote" title="Blockquote">“Quote</button>
        <div class="toolbar-sep"></div>

        <button type="button" data-action="mono" title="Inline Monospace"></> Mono</button>
        <button type="button" data-action="codeblock" title="Code Block">Block</button>
        <button type="button" data-action="link" title="Insert Link">Link</button>
        <button type="button" data-action="img" title="Insert Image URL">Image</button>
        <div class="toolbar-sep"></div>

        <input type="color" id="textColor" value="#ffffff" title="Text Color" />
        <button type="button" data-action="clear" title="Clear Formatting">Clear</button>
      </div>

      <div id="wysiwyg" contenteditable="true"></div>
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
    const wysiwygEl = document.getElementById("wysiwyg");
    const htmlEl = document.getElementById("html");
    const previewEl = document.getElementById("preview");
    const statusEl = document.getElementById("status");
    const tabVisual = document.getElementById("tabVisual");
    const tabCode = document.getElementById("tabCode");

    let currentFile = null;
    let editorMode = "visual";
    pwEl.value = sessionStorage.getItem("article_pw") || "";

    function setStatus(msg) { statusEl.textContent = msg; }
    function getPw() {
      const pw = pwEl.value;
      sessionStorage.setItem("article_pw", pw);
      return pw;
    }

    function syncFromVisual() {
      htmlEl.value = wysiwygEl.innerHTML;
      previewEl.innerHTML = htmlEl.value;
    }

    function syncFromCode() {
      wysiwygEl.innerHTML = htmlEl.value;
      previewEl.innerHTML = htmlEl.value;
    }

    function setMode(mode) {
      editorMode = mode;
      if (mode === "visual") {
        syncFromCode();
        wysiwygEl.classList.remove("hidden");
        htmlEl.classList.add("hidden");
        tabVisual.classList.add("active-tab");
        tabCode.classList.remove("active-tab");
      } else {
        syncFromVisual();
        wysiwygEl.classList.add("hidden");
        htmlEl.classList.remove("hidden");
        tabCode.classList.add("active-tab");
        tabVisual.classList.remove("active-tab");
      }
    }

    tabVisual.onclick = () => setMode("visual");
    tabCode.onclick = () => setMode("code");

    // Helper: Wrap current selection in an inline-styled element
    function wrapSelection(tagName, styleStr, fallbackText = "text") {
      wysiwygEl.focus();
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      if (!wysiwygEl.contains(range.commonAncestorContainer)) return;

      const el = document.createElement(tagName);
      if (styleStr) el.setAttribute("style", styleStr);

      if (range.collapsed) {
        el.textContent = fallbackText;
        range.insertNode(el);
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        const fragment = range.extractContents();
        el.appendChild(fragment);
        range.insertNode(el);
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      syncFromVisual();
    }

    // Helper: Insert an HTML node at caret
    function insertHtmlNode(node) {
      wysiwygEl.focus();
      const sel = window.getSelection();
      let range;
      if (sel && sel.rangeCount > 0 && wysiwygEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        range = sel.getRangeAt(0);
        range.deleteContents();
      } else {
        range = document.createRange();
        range.selectNodeContents(wysiwygEl);
        range.collapse(false);
      }
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      syncFromVisual();
    }

    // Helper: Apply block-level tag with inline styles
    function applyBlockStyle(tag, styleStr) {
      wysiwygEl.focus();
      document.execCommand("formatBlock", false, tag);
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        let node = sel.anchorNode;
        while (node && node !== wysiwygEl) {
          if (node.nodeType === 1 && node.tagName.toLowerCase() === tag.toLowerCase()) {
            if (styleStr) node.setAttribute("style", styleStr);
            else node.removeAttribute("style");
            break;
          }
          node = node.parentNode;
        }
      }
      syncFromVisual();
    }

    // Toolbar actions
    document.getElementById("toolbar").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      if (editorMode !== "visual") setMode("visual");

      const action = btn.dataset.action;

      switch (action) {
        case "bold":
          wrapSelection("span", "font-weight: bold;");
          break;
        case "italic":
          wrapSelection("span", "font-style: italic;");
          break;
        case "underline":
          wrapSelection("span", "text-decoration: underline;");
          break;
        case "strike":
          wrapSelection("span", "text-decoration: line-through;");
          break;
        case "h1":
          applyBlockStyle("h1", "font-size: 2em; font-weight: bold; margin: 16px 0 8px 0;");
          break;
        case "h2":
          applyBlockStyle("h2", "font-size: 1.5em; font-weight: bold; margin: 14px 0 8px 0;");
          break;
        case "h3":
          applyBlockStyle("h3", "font-size: 1.25em; font-weight: bold; margin: 12px 0 6px 0;");
          break;
        case "p":
          applyBlockStyle("p", "margin: 0 0 12px 0;");
          break;
        case "ul":
          document.execCommand("insertUnorderedList");
          wysiwygEl.querySelectorAll("ul").forEach(ul => {
            if (!ul.getAttribute("style")) ul.setAttribute("style", "margin: 8px 0; padding-left: 24px;");
          });
          syncFromVisual();
          break;
        case "ol":
          document.execCommand("insertOrderedList");
          wysiwygEl.querySelectorAll("ol").forEach(ol => {
            if (!ol.getAttribute("style")) ol.setAttribute("style", "margin: 8px 0; padding-left: 24px;");
          });
          syncFromVisual();
          break;
        case "quote":
          applyBlockStyle("blockquote", "border-left: 3px solid #555; padding-left: 12px; margin: 12px 0; color: #bbb; font-style: italic;");
          break;
        case "mono":
          wrapSelection("span", "font-family:monospace; margin-left: 3px; margin-right: 3px;", "/tp");
          break;
        case "codeblock": {
          const pre = document.createElement("pre");
          pre.setAttribute("style", "font-family: monospace; background: #161616; color: #e6edf3; padding: 12px; border-radius: 6px; overflow-x: auto; margin: 12px 0;");
          const sel = window.getSelection();
          const selectedText = sel && !sel.isCollapsed ? sel.toString() : "// code block";
          pre.textContent = selectedText;
          insertHtmlNode(pre);
          break;
        }
        case "link": {
          const url = prompt("Enter URL:", "https://");
          if (!url) return;
          const sel = window.getSelection();
          const label = sel && !sel.isCollapsed ? sel.toString() : url;
          const a = document.createElement("a");
          a.href = url.trim();
          a.textContent = label;
          a.setAttribute("style", "color: #58a6ff; text-decoration: underline;");
          insertHtmlNode(a);
          break;
        }
        case "img": {
          const url = prompt("Enter Image URL:", "https://");
          if (!url) return;
          const alt = prompt("Alt text (optional):", "") || "";
          const img = document.createElement("img");
          img.src = url.trim();
          if (alt) img.alt = alt;
          img.setAttribute("style", "max-width: 500px; width: 100%; height: auto; display: block; margin: 12px 0;");
          insertHtmlNode(img);
          break;
        }
        case "clear": {
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed) {
            const plain = document.createTextNode(sel.toString());
            insertHtmlNode(plain);
          }
          break;
        }
      }
    });

    // Text color picker (inline style)
    document.getElementById("textColor").addEventListener("change", (e) => {
      if (editorMode !== "visual") setMode("visual");
      wrapSelection("span", "color: " + e.target.value + ";");
    });

    // Ensure any pasted images also obey max-width: 500px inline
    wysiwygEl.addEventListener("input", () => {
      wysiwygEl.querySelectorAll("img").forEach(img => {
        if (!img.style.maxWidth) {
          img.style.maxWidth = "500px";
          img.style.height = "auto";
        }
      });
      syncFromVisual();
    });

    htmlEl.addEventListener("input", syncFromCode);

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
      syncFromCode();
      loadList();
      setStatus("Editing " + data.file);
    }

    function newArticle() {
      currentFile = null;
      fileEl.value = "";
      titleEl.value = "";
      authorEl.value = "";
      categoryEl.value = "update";
      htmlEl.value = '<p style="margin: 0 0 12px 0;">Hello world</p>';
      syncFromCode();
      loadList();
      setStatus("New article");
    }

    async function saveArticle() {
      if (editorMode === "visual") syncFromVisual();
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