// Minimal static server for the test harness.
const http = require("http");
const fs = require("fs");
const path = require("path");
const root = __dirname;
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".mjs": "text/javascript" };
http
  .createServer((req, res) => {
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
