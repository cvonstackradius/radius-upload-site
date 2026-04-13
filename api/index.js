const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const META_FILE = path.join(UPLOADS_DIR, "meta.json");

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json());

// --- Auth ---
const VALID_USERNAME = "vonstack";
const VALID_PASSWORD = "2026";
const AUTH_TOKEN = crypto.createHash("sha256").update("vonstack:2026:radius-secret").digest("hex");

function requireAuth(req, res, next) {
  const token = req.headers["authorization"]?.replace("Bearer ", "");
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === VALID_USERNAME && password === VALID_PASSWORD) {
    return res.json({ token: AUTH_TOKEN });
  }
  return res.status(401).json({ error: "Invalid credentials" });
});

// --- Helpers ---
function loadMeta() {
  if (fs.existsSync(META_FILE)) {
    return JSON.parse(fs.readFileSync(META_FILE, "utf-8"));
  }
  return {};
}

function saveMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

const ALLOWED_TYPES = {
  "audio/mpeg": ".mp3",
  "application/pdf": ".pdf",
};

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const id = uuidv4();
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${id}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error("Only MP3 and PDF files are allowed"));
    }
  },
});

app.use(express.static(path.join(__dirname, "..", "public")));

// Upload endpoint (requires auth)
app.post("/api/upload", requireAuth, (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const message =
        err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
          ? "File too large (max 50 MB)"
          : err.message;
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }

    const id = path.parse(req.file.filename).name;
    const folder = req.body?.folder || "";
    const meta = loadMeta();
    meta[id] = {
      originalName: req.file.originalname,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
      folder: folder,
      uploadedAt: new Date().toISOString(),
    };
    saveMeta(meta);

    const shareUrl = `${req.protocol}://${req.get("host")}/share/${id}`;
    res.json({ id, shareUrl, name: req.file.originalname });
  });
});

// List files (requires auth)
app.get("/api/files", requireAuth, (_req, res) => {
  const meta = loadMeta();
  const files = Object.entries(meta).map(([id, info]) => ({
    id,
    name: info.originalName,
    size: info.size,
    type: info.mimetype,
    folder: info.folder || "",
    uploadedAt: info.uploadedAt,
  }));
  files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(files);
});

// Delete file (requires auth)
app.delete("/api/files/:id", requireAuth, (req, res) => {
  const meta = loadMeta();
  const info = meta[req.params.id];
  if (!info) return res.status(404).json({ error: "File not found" });

  const filePath = path.join(UPLOADS_DIR, info.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  delete meta[req.params.id];
  saveMeta(meta);
  res.json({ ok: true });
});

// Download endpoint (public - shared links should work without login)
app.get("/api/download/:id", (req, res) => {
  const meta = loadMeta();
  const info = meta[req.params.id];
  if (!info) return res.status(404).json({ error: "File not found" });

  const filePath = path.join(UPLOADS_DIR, info.filename);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "File missing from disk" });

  res.download(filePath, info.originalName);
});

// Share page (serves the same frontend, handled client-side)
app.get("/share/:id", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`File Share running at http://localhost:${PORT}`);
});

module.exports = app;
