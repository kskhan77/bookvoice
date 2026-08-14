// Minimal static server for the test harness.
const http = require("http");
const fs = require("fs");
const path = require("path");
const root = __dirname;
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".mjs": "text/javascript" };
const https = require("https");

function proxyFetch(url, res, depth = 0) {
  if (depth > 3) {
    res.writeHead(508);
    res.end("too many redirects");
    return;
  }
  https
    .get(url, { headers: { "User-Agent": "Mozilla/5.0 (repro-harness)" } }, (up) => {
      if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
        up.resume();
        proxyFetch(new URL(up.headers.location, url).href, res, depth + 1);
        return;
      }
      res.writeHead(200, {
        "Content-Type": up.headers["content-type"] || "text/html",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      });
      up.pipe(res);
    })
    .on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
}

http
  .createServer((req, res) => {
    if (req.url.startsWith("/fetch?u=")) {
      const target = decodeURIComponent(req.url.slice("/fetch?u=".length));
      proxyFetch(target, res);
      return;
    }
    const file = path.join(root, req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        // Cross-origin isolation enables multi-threaded WASM (SharedArrayBuffer)
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      });
      res.end(data);
    });
  })
  .listen(8734, () => console.log("test server on http://localhost:8734"));
