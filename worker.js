export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/+/, ""); // e.g. index.json, notes/123.html, todos.json
    const method = req.method;

    const cors = (extra = {}) => ({
      "Access-Control-Allow-Origin": req.headers.get("origin") || "*",
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type,If-Match,If-None-Match",
      "Access-Control-Expose-Headers": "ETag",
      ...extra
    });

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    // Auth (single token in env)
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${env.LN_TOKEN}`) {
      return new Response("Unauthorized", { status: 401, headers: cors() });
    }

    const bucket = env.LIGHTNOTES; // bound R2 bucket

    if (method === "HEAD") {
      const obj = await bucket.head(path).catch(() => null);
      if (!obj) return new Response(null, { status: 404, headers: cors() });
      const etag = (obj.httpEtag || '').replace(/^W\//, '').replace(/"/g, '');
      return new Response(null, { status: 200, headers: { ...cors(), ETag: etag, "Cache-Control": "no-store" } });
    }

    if (method === "GET") {
      // List objects helper: /list?prefix=notes/
      if (path === "list") {
        const prefix = url.searchParams.get("prefix") || "";
        const out = [];
        let cursor = undefined;
        // paginate defensively
        for (let i = 0; i < 10; i++) {
          const { objects, truncated, cursor: next } = await bucket.list({ prefix, cursor });
          for (const o of objects || []) out.push(o.key);
          if (!truncated) break;
          cursor = next;
        }
        return new Response(JSON.stringify({ keys: out }), {
          headers: { ...cors(), "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      }
      const obj = await bucket.get(path);
      if (!obj) return new Response("Not found", { status: 404, headers: cors() });
      const etag = (obj.httpEtag || '').replace(/^W\//, '').replace(/"/g, '');
      if ((req.headers.get("if-none-match") || '') === etag) {
        return new Response(null, { status: 304, headers: cors({ ETag: etag, "Cache-Control": "no-store" }) });
      }
      return new Response(obj.body, {
        headers: {
          "Content-Type": guessType(path),
          "ETag": etag,
          "Cache-Control": "no-store",
          ...cors()
        }
      });
    }

    if (method === "PUT") {
      // Handle optimistic concurrency
      const current = await bucket.head(path).catch(() => null);
      const ifMatch = req.headers.get("if-match");
      const currentTag = current ? (current.httpEtag || '').replace(/^W\//, '').replace(/"/g, '') : '';
      const normalizedIfMatch = (ifMatch || '').replace(/^W\//, '').replace(/"/g, '');
      if (current && ifMatch && normalizedIfMatch !== currentTag) {
        return new Response("Precondition failed", { status: 412, headers: cors() });
      }

      const body = await req.arrayBuffer();
      const obj = await bucket.put(path, body, {
        httpMetadata: { contentType: guessType(path) }
      });
      const newTag = (obj.httpEtag || '').replace(/^W\//, '').replace(/"/g, '');
      return new Response(null, { status: 204, headers: { ...cors(), "ETag": newTag } });
    }

    if (method === "DELETE") {
      await bucket.delete(path);
      return new Response(null, { status: 204, headers: cors() });
    }

    return new Response("Method not allowed", { status: 405, headers: cors() });
  }
};

function guessType(path) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}


