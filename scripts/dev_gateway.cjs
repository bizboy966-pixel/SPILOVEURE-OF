// Development-only same-origin gateway for Expo, HTTP API and WebSockets.
const http = require("http");
const httpProxy = require("http-proxy");
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: false });
proxy.on("error", (_error, _request, response) => {
  if (response && response.writeHead && !response.headersSent) {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Le serveur démarre. Réessayez dans quelques secondes.");
  } else if (response?.destroy) response.destroy();
});
const target = request => request.url.startsWith("/api/") || ["/telecharger", "/telecharger/", "/sitemap-android.xml", "/robots.txt"].includes(request.url.split("?")[0]) ? "http://127.0.0.1:8000" : "http://127.0.0.1:8080";
const server = http.createServer((request, response) => proxy.web(request, response, { target: target(request) }));
server.on("upgrade", (request, socket, head) => proxy.ws(request, socket, head, { target: target(request) }));
server.listen(5000, "0.0.0.0", () => console.log("SPILOVEURE development gateway listening on port 5000"));
