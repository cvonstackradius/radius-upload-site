const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  try {
    const store = getStore("files");
    const result = await store.list({ prefix: "meta/" });

    const files = [];
    for (const blob of result.blobs) {
      try {
        const data = await store.get(blob.key);
        if (data) {
          files.push(JSON.parse(data));
        }
      } catch (e) {
        console.error("Error reading blob:", blob.key, e);
      }
    }

    files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(files),
    };
  } catch (err) {
    console.error("List error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to list files" }) };
  }
};
