// Capacitor skips HTTP patching for its own local hostname. The app uses
// the VPS hostname locally so SameSite Chat cookies and WebSocket Origin remain
// valid, but must explicitly send API fetches to the real VPS.
export function installApiTransport(target, nativeHttp) {
  const originalFetch = target.fetch.bind(target);
  target.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://spiloveure.org" || !url.pathname.startsWith("/api/")) {
      return originalFetch(input, init);
    }
    const headers = Object.fromEntries(request.headers.entries());
    let data;
    let dataType;
    if (init?.body instanceof FormData) {
      dataType = "formData";
      // Native Capacitor creates its own multipart boundary.
      headers["content-type"] = "multipart/form-data";
      data = [];
      for (const [key, value] of init.body.entries()) {
        if (value instanceof Blob) {
          const encoded = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(value);
          });
          data.push({ key, value: encoded, type: "base64File",
            contentType: value.type || "application/octet-stream", fileName: value.name || "upload" });
        } else {
          data.push({ key, value, type: "string" });
        }
      }
    } else if (!["GET", "HEAD"].includes(request.method)) {
      const text = await request.text();
      data = text && headers["content-type"]?.includes("application/json") ? JSON.parse(text) : text;
      dataType = "json";
    }
    if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const result = await nativeHttp.request({
      url: url.href, method: request.method, headers, data, dataType,
      responseType: "text", connectTimeout: 20000, readTimeout: 60000,
      disableRedirects: true,
    });
    if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const body = [204, 205, 304].includes(result.status) || request.method === "HEAD"
      ? null : typeof result.data === "string" ? result.data : JSON.stringify(result.data);
    return new Response(body, { status: result.status, headers: result.headers });
  };
}
