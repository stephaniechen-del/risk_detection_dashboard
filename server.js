const http = require("node:http");
const { execFile } = require("node:child_process");
const { readFile, writeFile, mkdir } = require("node:fs/promises");
const { promisify } = require("node:util");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DASHBOARD_DATA_FILE = path.join(DATA_DIR, "risk-dashboard.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const execFileAsync = promisify(execFile);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

async function parseMultipartBody(req) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error("上传请求必须是 multipart/form-data。");
    error.statusCode = 400;
    throw error;
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const bodyText = Buffer.concat(chunks).toString("latin1");
  const parts = bodyText.split(`--${boundary}`);
  const fields = {};
  const files = {};

  for (const part of parts) {
    if (!part || part === "--\r\n" || part === "--") {
      continue;
    }

    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      continue;
    }

    const rawHeaders = part.slice(0, headerEnd);
    let content = part.slice(headerEnd + 4);
    if (content.endsWith("\r\n")) {
      content = content.slice(0, -2);
    }

    const disposition = rawHeaders.match(/content-disposition:[^\r\n]+/i)?.[0] || "";
    const name = disposition.match(/name="([^"]+)"/)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/)?.[1];
    if (!name) {
      continue;
    }

    if (filename !== undefined && filename !== "") {
      files[name] = {
        filename: path.basename(filename),
        buffer: Buffer.from(content, "latin1"),
      };
    } else {
      fields[name] = Buffer.from(content, "latin1").toString("utf8").trim();
    }
  }

  return { fields, files };
}

async function rebuildDashboard(sourcePath, lookupIps) {
  const args = [path.join(ROOT, "scripts/build_dashboard_data.py"), "--source", sourcePath];
  if (lookupIps) {
    args.push("--lookup-ips", "--max-lookup-ips", "120");
  }

  await execFileAsync("python3", args, {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 8,
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/dashboard-data" && req.method === "GET") {
    try {
      const raw = await readFile(DASHBOARD_DATA_FILE, "utf8");
      sendJson(res, 200, JSON.parse(raw));
    } catch (error) {
      if (error.code === "ENOENT") {
        sendError(res, 404, "Dashboard 数据不存在，请先运行 python3 scripts/build_dashboard_data.py。");
        return;
      }
      throw error;
    }
    return;
  }

  if (url.pathname === "/api/upload-dashboard-data" && req.method === "POST") {
    const { fields, files } = await parseMultipartBody(req);
    const upload = files.dataFile;
    if (!upload || upload.buffer.length === 0) {
      sendError(res, 400, "请选择要上传的 CSV 文件。");
      return;
    }

    if (!upload.filename.toLowerCase().endsWith(".csv")) {
      sendError(res, 400, "目前只支持 CSV 文件。");
      return;
    }

    await mkdir(UPLOAD_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const savedPath = path.join(UPLOAD_DIR, `${stamp}-${upload.filename}`);
    await writeFile(savedPath, upload.buffer);

    try {
      await rebuildDashboard(savedPath, fields.lookupIps === "on");
      const raw = await readFile(DASHBOARD_DATA_FILE, "utf8");
      sendJson(res, 200, {
        ok: true,
        filename: upload.filename,
        savedPath,
        dashboard: JSON.parse(raw),
      });
    } catch (error) {
      sendError(res, 400, `数据处理失败：${error.stderr || error.message}`);
    }
    return;
  }

  sendError(res, 404, "接口不存在。");
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, "禁止访问。");
    return;
  }

  try {
    const file = await readFile(filePath);
    const contentType = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      const indexFile = await readFile(path.join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
      res.end(indexFile);
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendError(res, statusCode, statusCode === 500 ? "服务器内部错误。" : error.message);
    if (statusCode === 500) {
      console.error(error);
    }
  }
});

mkdir(DATA_DIR, { recursive: true })
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Risk dashboard is running at http://${HOST}:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize dashboard:", error);
    process.exit(1);
  });
