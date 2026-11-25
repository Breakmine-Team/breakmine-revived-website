import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT) || 3000;
const ARTICLES_DIR = path.resolve(process.env.ARTICLES_DIR || "./articles");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const PASSWORD = process.env.PASSWORD || "";

fs.mkdirSync(ARTICLES_DIR, { recursive: true });

function safeFilePath(fileName) {
  const base = path.basename(String(fileName || ""));
  if (!base || base !== fileName || !/\.html$/i.test(base)) return null;
  const resolved = path.resolve(ARTICLES_DIR, base);
  return resolved.startsWith(ARTICLES_DIR + path.sep) ? resolved : null;
}

function escapeAttr(str) {
  return String(str || "")
    .replace(/&/g, "&")
    .replace(/"/g, """)
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

  const bodyMatch = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);

  return {
    title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "",
    author: authorMatch ? authorMatch[1].trim() : "",
    html: bodyMatch ? bodyMatch[1].trim() : raw.trim(),
  };
}

function buildArticleHtml({ title, author, html }) {
  const safeTitle = String(title || "Untitled").trim();
  const safeAuthor = String(author || "").trim();
  const bodyContent = String(html || "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="title" content="${escapeAttr(safeTitle)}" />
  <meta name="author" content="${escapeAttr(safeAuthor)}" />
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
    input, textarea { background: #0b0b0b; color: #eee; border: 1px solid #333; border-radius: 4px; padding: 7px 9px; font-family: inherit; }
    button { padding: 7px 12px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; color: #fff; cursor: pointer; }
    button.primary { background: #1f6feb; border-color: #1f6feb; }
    button.danger { background: #a4262c; border-color: #a4262c; }
    main { display: grid; grid-template-columns: 240px 1fr 1fr; min-height: 0; }
    aside { border-right: 1px solid #333; padding: 10px; overflow-y: auto; }
    .item { padding: 8px; border-radius: 4px; cursor: pointer; margin-bottom: 4px; }
    .item:hover { background: #222; }
    .item.active { background: #1f6feb; }
    .item small { display: block; opacity: 0.75; }
    .pane { padding: 12px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
    .pane + .pane { border-left: 1px solid #333; }
    .meta-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    textarea { flex: 1; resize: none; font-family: ui-monospace, monospace; font-size: 14px; line-height: 1.5; }
    #preview { flex: 1; overflow-y: auto; background: #0b0b0b; border: 1px solid #333; border-radius: 4px; padding: 12px; }
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
      </div>
      <textarea id="html" placeholder="<p>Write HTML here...</p>"></textarea>
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
    const htmlEl = document.getElementById("html");
    const previewEl = document.getElementById("preview");
    const statusEl = document.getElementById("status");

    let currentFile = null;
    pwEl.value = sessionStorage.getItem("article_pw") || "";

    function setStatus(msg) { statusEl.textContent = msg; }
    function getPw() {
      const pw = pwEl.value;
      sessionStorage.setItem("article_pw", pw);
      return pw;
    }
    function renderPreview() { previewEl.innerHTML = htmlEl.value; }

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
        s.textContent = [item.file, item.author].filter(Boolean).join(" • ");
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
      htmlEl.value = data.html || "";
      renderPreview();
      loadList();
      setStatus("Editing " + data.file);
    }

    function newArticle() {
      currentFile = null;
      fileEl.value = "";
      titleEl.value = "";
      authorEl.value = "";
      htmlEl.value = "<p>Hello world</p>";
      renderPreview();
      loadList();
      setStatus("New article");
    }

    async function saveArticle() {
      const file = fileEl.value.trim();
      if (!file.endsWith(".html")) return setStatus("Filename must end in .html");
      const payload = {
        file: currentFile ? undefined : file,
        newName: currentFile ? file : undefined,
        title: titleEl.value,
        author: authorEl.value,
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
    htmlEl.addEventListener("input", renderPreview);

    loadList();
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
        const outHtml = buildArticleHtml({
          title: body.title ?? existing.title,
          author: body.author ?? existing.author,
          html: body.html ?? existing.html,
        });
        fs.writeFileSync(nextPath, outHtml, "utf8");
        if (nextPath !== targetPath) fs.unlinkSync(targetPath);
        return sendJson(res, 200, { ok: true, file: path.basename(nextPath) });
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
      const outHtml = buildArticleHtml({
        title: body.title,
        author: body.author,
        html: body.html,
      });
      fs.writeFileSync(targetPath, outHtml, "utf8");
      return sendJson(res, 201, { ok: true, file: path.basename(targetPath) });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 400, { error: err.message || "Bad request" });
  }
});

server.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});