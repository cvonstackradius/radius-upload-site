const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod !== "DELETE" && event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const params = event.queryStringParameters || {};
  const key = params.key;

  if (!key) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing key parameter" }) };
  }

  try {
    const store = getStore("files");

    // key is the metaKey like "meta/folder/uuid"
    // Read metadata to get the fileKey
    const metaData = await store.get(key);
    if (metaData) {
      const meta = JSON.parse(metaData);
      // Delete the actual file blob
      if (meta.fileKey) {
        await store.delete(meta.fileKey);
      }
    }

    // Delete the metadata blob
    await store.delete(key);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true }),
    };
  } catch (err) {
    console.error("Delete error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Delete failed" }) };
  }
};
