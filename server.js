const http = require("node:http");
const { execFile } = require("node:child_process");
const { createWriteStream } = require("node:fs");
const { readFile, mkdir } = require("node:fs/promises");
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

async function writeChunk(stream, chunk) {
  if (!chunk.length) {
    return;
  }
  if (!stream.write(chunk)) {
    await new Promise((resolve) => stream.once("drain", resolve));
  }
}

async function endStream(stream) {
  await new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.once("error", reject);
  });
}

async function parseMultipartUpload(req) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error("上传请求必须是 multipart/form-data。");
    error.statusCode = 400;
    throw error;
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const boundaryBuffer = Buffer.from(`--${boundary}`, "latin1");
  const delimiterBuffer = Buffer.from(`\r\n--${boundary}`, "latin1");
  const headerBreakBuffer = Buffer.from("\r\n\r\n", "latin1");
  const keepBytes = delimiterBuffer.length + 4;
  const fields = {};
  let upload = null;
  let buffer = Buffer.alloc(0);
  let state = "seek-boundary";
  let currentPart = null;

  await mkdir(UPLOAD_DIR, { recursive: true });

  async function appendPartData(data) {
    if (!currentPart || !data.length) {
      return;
    }
    if (currentPart.stream) {
      await writeChunk(currentPart.stream, data);
    } else {
      currentPart.chunks.push(data);
    }
  }

  async function closePart() {
    if (!currentPart) {
      return;
    }
    if (currentPart.stream) {
      await endStream(currentPart.stream);
    } else {
      fields[currentPart.name] = Buffer.concat(currentPart.chunks).toString("utf8").trim();
    }
    currentPart = null;
  }

  function startPart(rawHeaders) {
    const disposition = rawHeaders.match(/content-disposition:[^\r\n]+/i)?.[0] || "";
    const name = disposition.match(/name="([^"]+)"/)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/)?.[1];
    if (!name) {
      currentPart = { name: "", chunks: [] };
      return;
    }

    if (filename !== undefined && filename !== "") {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeFilename = path.basename(filename);
      const savedPath = path.join(UPLOAD_DIR, `${stamp}-${safeFilename}`);
      const stream = createWriteStream(savedPath);
      upload = {
        fieldName: name,
        filename: safeFilename,
        savedPath,
        size: 0,
      };
      currentPart = {
        name,
        stream,
      };
    } else {
      currentPart = {
        name,
        chunks: [],
      };
    }
  }

  for await (const chunk of req) {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (state === "seek-boundary") {
        const boundaryIndex = buffer.indexOf(boundaryBuffer);
        if (boundaryIndex === -1) {
          buffer = buffer.slice(Math.max(0, buffer.length - boundaryBuffer.length));
          break;
        }
        buffer = buffer.slice(boundaryIndex + boundaryBuffer.length);
        if (buffer.slice(0, 2).toString("latin1") === "--") {
          await closePart();
          return { fields, upload };
        }
        if (buffer.slice(0, 2).toString("latin1") === "\r\n") {
          buffer = buffer.slice(2);
        }
        state = "headers";
      }

      if (state === "headers") {
        const headerEnd = buffer.indexOf(headerBreakBuffer);
        if (headerEnd === -1) {
          break;
        }
        const rawHeaders = buffer.slice(0, headerEnd).toString("latin1");
        buffer = buffer.slice(headerEnd + headerBreakBuffer.length);
        startPart(rawHeaders);
        state = "body";
      }

      if (state === "body") {
        const delimiterIndex = buffer.indexOf(delimiterBuffer);
        if (delimiterIndex !== -1) {
          const data = buffer.slice(0, delimiterIndex);
          if (upload && currentPart?.stream) {
            upload.size += data.length;
          }
          await appendPartData(data);
          await closePart();
          buffer = buffer.slice(delimiterIndex + delimiterBuffer.length);
          if (buffer.slice(0, 2).toString("latin1") === "--") {
            return { fields, upload };
          }
          if (buffer.slice(0, 2).toString("latin1") === "\r\n") {
            buffer = buffer.slice(2);
          }
          state = "headers";
          continue;
        }

        const safeLength = buffer.length - keepBytes;
        if (safeLength > 0) {
          const data = buffer.slice(0, safeLength);
          if (upload && currentPart?.stream) {
            upload.size += data.length;
          }
          await appendPartData(data);
          buffer = buffer.slice(safeLength);
        }
        break;
      }
    }
  }

  if (state === "body" && buffer.length) {
    await appendPartData(buffer);
  }
  await closePart();
  return { fields, upload };
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
    const { fields, upload } = await parseMultipartUpload(req);
    if (!upload || upload.fieldName !== "dataFile" || upload.size === 0) {
      sendError(res, 400, "请选择要上传的 CSV 文件。");
      return;
    }

    if (!upload.filename.toLowerCase().endsWith(".csv")) {
      sendError(res, 400, "目前只支持 CSV 文件。");
      return;
    }

    try {
      await rebuildDashboard(upload.savedPath, fields.lookupIps === "on");
      const raw = await readFile(DASHBOARD_DATA_FILE, "utf8");
      sendJson(res, 200, {
        ok: true,
        filename: upload.filename,
        savedPath: upload.savedPath,
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
