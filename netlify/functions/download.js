const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const key = params.key;

  if (!key) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing key parameter" }) };
  }

  try {
    const store = getStore("files");

    // Get metadata to find original name and mimetype
    // key is the fileKey like "files/folder/uuid-filename"
    const data = await store.get(key, { type: "arrayBuffer" });

    if (!data) {
      return { statusCode: 404, body: JSON.stringify({ error: "File not found" }) };
    }

    // Extract filename from key: "files/folder/uuid-originalname"
    const parts = key.split("/");
    const filenamePart = parts[parts.length - 1];
    // Remove uuid prefix (36 chars + 1 dash)
    const originalName = filenamePart.substring(37) || filenamePart;

    // Guess mimetype from extension
    const ext = originalName.split(".").pop().toLowerCase();
    const mimeMap = {
      pdf: "application/pdf",
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      txt: "text/plain",
      zip: "application/zip",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    const mimetype = mimeMap[ext] || "application/octet-stream";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": mimetype,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(originalName)}"`,
        "Access-Control-Allow-Origin": "*",
      },
      body: Buffer.from(data).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error("Download error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Download failed" }) };
  }
};
