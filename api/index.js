const handler = require("../server");

module.exports = (req, res) => {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url, `http://${host}`);
  const rewrittenPath = url.searchParams.get("__pathname");

  if (rewrittenPath) {
    url.searchParams.delete("__pathname");
    const query = url.searchParams.toString();
    req.url = `${rewrittenPath}${query ? `?${query}` : ""}`;
  }

  return handler(req, res);
};
