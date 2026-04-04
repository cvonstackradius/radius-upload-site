// Netlify serverless function — replaces the Express server.
// Uses @netlify/blobs for persistent file + metadata storage.
// Uses busboy for multipart/form-data parsing (no disk required).

const { getStore } = require("@netlify/blobs");
const Busboy = require("busboy");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const ALLOWED_MIMETYPES = new Set(["audio/mpeg", "application/pdf"]);
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function storeOptions(name) {
  const opts = { name, consistency: "strong" };
  // When deployed via CLI (not Netlify CI), the Blobs context isn't auto-injected.
  // Fall back to explicit credentials from env vars.
  if (!process.env.NETLIFY_BLOBS_CONTEXT && process.env.NETLIFY_SITE_ID && process.env.NETLIFY_TOKEN) {
    opts.siteID = process.env.NETLIFY_SITE_ID;
    opts.token = process.env.NETLIFY_TOKEN;
  }
  return opts;
}

async function getMetaStore() {
  return getStore(storeOptions("file-meta"));
}

async function getFileStore() {
  return getStore(storeOptions("file-data"));
}

async function loadMeta(store) {
  try {
    const raw = await store.get("index");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function saveMeta(store, meta) {
  await store.set("index", JSON.stringify(meta));
}

// ── upload ─────────────────────────────────────────────────────────────────

async function handleUpload(event) {
  const contentType = event.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    return json(400, { error: "Expected multipart/form-data" });
  }

  return new Promise((resolve) => {
    let fileBuffer = null;
    let originalName = "";
    let mimetype = "";
    let sizeExceeded = false;

    const busboy = Busboy({
      headers: event.headers,
      limits: { fileSize: MAX_FILE_SIZE },
    });

    busboy.on("file", (_fieldname, stream, info) => {
      originalName = info.filename || "upload";
      mimetype = info.mimeType || "";

      if (!ALLOWED_MIMETYPES.has(mimetype)) {
        stream.resume(); // drain the stream
        resolve(json(400, { error: "Only MP3 and PDF files are allowed" }));
        return;
      }

      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => {
        sizeExceeded = true;
        stream.resume();
      });
      stream.on("end", () => {
        if (sizeExceeded) return; // handled below
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on("finish", async () => {
      if (sizeExceeded) {
        return resolve(json(400, { error: "File too large (max 50 MB)" }));
      }
      if (!fileBuffer) {
        return resolve(json(400, { error: "No file provided" }));
      }

      try {
        const id = uuidv4();
        const ext = path.extname(originalName).toLowerCase();
        const storedName = `${id}${ext}`;

        const fileStore = await getFileStore();
        const metaStore = await getMetaStore();

        // Store file bytes
        await fileStore.set(storedName, fileBuffer, {
          metadata: {
            originalName,
            mimetype,
            size: fileBuffer.length,
            uploadedAt: new Date().toISOString(),
          },
        });

        // Update index
        const meta = await loadMeta(metaStore);
        meta[id] = {
          originalName,
          filename: storedName,
          size: fileBuffer.length,
          mimetype,
          uploadedAt: new Date().toISOString(),
        };
        await saveMeta(metaStore, meta);

        const host = event.headers["host"] || "radius-file-share.netlify.app";
        const proto = event.headers["x-forwarded-proto"] || "https";
        const shareUrl = `${proto}://${host}/share/${id}`;

        resolve(json(200, { id, shareUrl, name: originalName }));
      } catch (err) {
        console.error("Upload error:", err);
        resolve(json(500, { error: "Storage error: " + err.message }));
      }
    });

    busboy.on("error", (err) => {
      console.error("Busboy error:", err);
      resolve(json(500, { error: "Parse error: " + err.message }));
    });

    // Feed body into busboy
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : Buffer.from(event.body || "", "utf-8");
    busboy.write(body);
    busboy.end();
  });
}

// ── list files ─────────────────────────────────────────────────────────────

async function handleList() {
  const metaStore = await getMetaStore();
  const meta = await loadMeta(metaStore);
  const files = Object.entries(meta).map(([id, info]) => ({
    id,
    name: info.originalName,
    size: info.size,
    type: info.mimetype,
    uploadedAt: info.uploadedAt,
  }));
  files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return json(200, files);
}

// ── delete ─────────────────────────────────────────────────────────────────

async function handleDelete(id) {
  const metaStore = await getMetaStore();
  const fileStore = await getFileStore();
  const meta = await loadMeta(metaStore);

  const info = meta[id];
  if (!info) return json(404, { error: "File not found" });

  try {
    await fileStore.delete(info.filename);
  } catch {
    // ignore if already gone
  }
  delete meta[id];
  await saveMeta(metaStore, meta);
  return json(200, { ok: true });
}

// ── download ───────────────────────────────────────────────────────────────

async function handleDownload(id) {
  const metaStore = await getMetaStore();
  const fileStore = await getFileStore();
  const meta = await loadMeta(metaStore);

  const info = meta[id];
  if (!info) return json(404, { error: "File not found" });

  let arrayBuffer;
  try {
    arrayBuffer = await fileStore.get(info.filename, { type: "arrayBuffer" });
  } catch {
    return json(404, { error: "File missing from storage" });
  }

  if (!arrayBuffer) return json(404, { error: "File missing from storage" });

  const b64 = Buffer.from(arrayBuffer).toString("base64");
  const encoded = encodeURIComponent(info.originalName);
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      "Content-Type": info.mimetype,
      "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
      "Content-Length": String(info.size),
    },
    body: b64,
  };
}

// ── router ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const method = event.httpMethod;
  const rawPath = event.path || "";

  // Strip /.netlify/functions/api prefix if present
  const urlPath = rawPath
    .replace(/^\/.netlify\/functions\/api/, "")
    .replace(/^\/api/, "") || "/";

  // POST /upload
  if (method === "POST" && urlPath === "/upload") {
    return handleUpload(event);
  }

  // GET /files
  if (method === "GET" && urlPath === "/files") {
    return handleList();
  }

  // DELETE /files/:id
  const delMatch = urlPath.match(/^\/files\/([^/]+)$/);
  if (method === "DELETE" && delMatch) {
    return handleDelete(delMatch[1]);
  }

  // GET /download/:id
  const dlMatch = urlPath.match(/^\/download\/([^/]+)$/);
  if (method === "GET" && dlMatch) {
    return handleDownload(dlMatch[1]);
  }

  return json(404, { error: "Not found" });
};
