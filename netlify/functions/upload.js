const { getStore } = require("@netlify/blobs");
const Busboy = require("busboy");
const crypto = require("crypto");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  try {
    const result = await parseMultipart(event);
    const { file, fields } = result;

    if (!file) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "No file uploaded" }) };
    }

    const folder = (fields.folder || "root").trim() || "root";
    const id = crypto.randomUUID();
    const fileKey = `files/${folder}/${id}-${file.filename}`;
    const metaKey = `meta/${folder}/${id}`;

    const store = getStore("files");

    await store.set(fileKey, file.data);

    const metadata = {
      id,
      originalName: file.filename,
      folder,
      size: file.data.length,
      mimetype: file.mimetype,
      uploadedAt: new Date().toISOString(),
      fileKey,
    };

    await store.set(metaKey, JSON.stringify(metadata));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        name: file.filename,
        folder,
        size: file.data.length,
        id,
      }),
    };
  } catch (err) {
    console.error("Upload error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Upload failed: " + err.message }) };
  }
};

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const contentType = event.headers["content-type"] || event.headers["Content-Type"];
    const bb = Busboy({ headers: { "content-type": contentType } });

    let file = null;
    const fields = {};
    const chunks = [];

    bb.on("file", (fieldname, stream, info) => {
      const { filename, mimeType } = info;
      file = { filename, mimetype: mimeType };
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        file.data = Buffer.concat(chunks);
      });
    });

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("finish", () => {
      resolve({ file, fields });
    });

    bb.on("error", reject);

    const body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body);

    bb.end(body);
  });
}
