/*
 * Node HTTP backend for the streamed show_widget reference demo.
 * ------------------------------------------------------------------------------
 *
 *  - GET  /api/health  → { configured, model }
 *
 *
 *
 *
 *
 *     → SSE {type:'widget_start'} / {type:'widget_delta'} / {type:'widget_end'}
 *
 *
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* Widget implementation details */
function loadEnv() {
  const f = path.join(__dirname, ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

const API_KEY = process.env.LLM_API_KEY || "";
const BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const PORT = Number(process.env.PORT || 5173);

const client = API_KEY ? new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL }) : null;

/* Widget implementation details */
const SYSTEM_PROMPT = readFileSync(
  path.join(__dirname, "docs", "widget-skill.md"),
  "utf8"
);

/* Widget implementation details */
const SHOW_WIDGET_TOOL = {
  type: "function",
  function: {
    name: "show_widget",
    description:
      "Render an in-conversation interactive form (widget) to collect structured input. " +
      "Use ONLY when the task has high irreversible cost, the needed parameters are weakly " +
      "coupled (a flat checklist, not a decision tree), and interrupting with a form is " +
      "worthwhile. Do NOT use for simple yes/no, one or two params, strongly-dependent params, " +
      "or when the user already gave full info. After the user fills it, their selections " +
      "return as the next user message.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short form title." },
        loading_messages: {
          type: "array",
          items: { type: "string" },
          description: "2-4 short rotating placeholder messages shown while rendering.",
        },
        widget_code: {
          type: "string",
          description:
            "Pure HTML for the form following the .clarify contract. No <style>, <script>, " +
            "inline style=, on* handlers, or position:fixed. Use .clarify / .clarify-header / " +
            ".clarify-body / .clarify-footer, fields with data-name, and components " +
            ".clarify-pills (data-multi, data-value pills), .clarify-range, .clarify-date, " +
            ".clarify-textarea, .clarify-other.",
        },
      },
      required: ["title", "loading_messages", "widget_code"],
    },
  },
};

/* Widget implementation details */
const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, [{ role: "system", content: SYSTEM_PROMPT }]);
  }
  return sessions.get(id);
}

/* ====================================================================== *
 *
 * ====================================================================== */
function createWidgetExtractor(send) {
  let startSent = false;
  let title = null;
  let loading = null;
  let valueStart = -1;
  let rawPos = -1;
  let decoded = "";
  let emittedLen = 0;
  let escaping = false;
  let closed = false;

  function tryMeta(args) {
    if (title === null) {
      const m = args.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (m) { try { title = JSON.parse('"' + m[1] + '"'); } catch { title = m[1]; } }
    }
    if (loading === null) {
      const m = args.match(/"loading_messages"\s*:\s*(\[(?:[^[\]]|\\.)*\])/);
      if (m) { try { loading = JSON.parse(m[1]); } catch {  } }
    }
  }

  function locateValueStart(args) {
    if (valueStart >= 0) return;
    const kIdx = args.indexOf('"widget_code"');
    if (kIdx < 0) return;
    let i = kIdx + '"widget_code"'.length;
    while (i < args.length && args[i] !== ":") i++;
    if (i >= args.length) return;
    i++;
    while (i < args.length && /\s/.test(args[i])) i++;
    if (i >= args.length || args[i] !== '"') return;
    valueStart = i + 1;
    rawPos = valueStart;
  }

  function maybeStart(args) {
    if (startSent) return;
    locateValueStart(args);
    // Widget lifecycle and state.
    if ((title !== null && loading !== null) || valueStart >= 0) {
      send({
        type: "widget_start",
        title: title || "",
        loading_messages: loading && loading.length ? loading : ["Reading your request…", "Building your form…"],
      });
      startSent = true;
    }
  }

  function scan(args) {
    if (valueStart < 0 || closed) return;
    while (rawPos < args.length && !closed) {
      const c = args[rawPos];
      if (escaping) {
        if (c === "u") {
          if (rawPos + 5 > args.length) break;
          decoded += String.fromCharCode(parseInt(args.slice(rawPos + 1, rawPos + 5), 16));
          rawPos += 5;
        } else {
          const map = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
          decoded += map[c] != null ? map[c] : c;
          rawPos += 1;
        }
        escaping = false;
      } else if (c === "\\") {
        escaping = true;
        rawPos += 1;
      } else if (c === '"') {
        closed = true;
        rawPos += 1;
      } else {
        decoded += c;
        rawPos += 1;
      }
    }
  }

  return {
    feed(args) {
      tryMeta(args);
      maybeStart(args);
      scan(args);
      if (startSent && decoded.length > emittedLen) {
        send({ type: "widget_delta", html: decoded.slice(emittedLen) });
        emittedLen = decoded.length;
      }
    },
    finalize(args) {
      if (!startSent) {
        send({ type: "widget_start", title: title || "", loading_messages: ["Reading your request…", "Building your form…"] });
        startSent = true;
      }
      try {
        const obj = JSON.parse(args);
        if (obj.widget_code && obj.widget_code.length > emittedLen) {
          send({ type: "widget_delta", html: obj.widget_code.slice(emittedLen) });
          emittedLen = obj.widget_code.length;
        }
      } catch {  }
    },
  };
}

/* ====================================================================== *
 *
 * ====================================================================== */
async function handleChat(req, res, body) {
  const sse = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  if (!client) {
    sse({ type: "error", message: "Server API key is not configured (LLM_API_KEY)." });
    sse({ type: "done" });
    return res.end();
  }

  const { sessionId, message } = body || {};
  if (!sessionId || typeof message !== "string") {
    sse({ type: "error", message: "Missing sessionId or message." });
    sse({ type: "done" });
    return res.end();
  }

  const messages = getSession(sessionId);
  messages.push({ role: "user", content: message });

  try {
    const stream = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: [SHOW_WIDGET_TOOL],
      stream: true,
      temperature: 0.4,
    });

    let assistantText = "";
    const toolCalls = []; // [{ id, name, args, extractor }]

    for await (const chunk of stream) {
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) {
        assistantText += delta.content;
        sse({ type: "text", delta: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: "", name: "", args: "", extractor: null };
          const slot = toolCalls[idx];
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) {
            slot.args += tc.function.arguments;
            if (slot.name === "show_widget") {
              if (!slot.extractor) slot.extractor = createWidgetExtractor(sse);
              slot.extractor.feed(slot.args);
            }
          }
        }
      }
    }

    const widgetCall = toolCalls.find((t) => t && t.name === "show_widget");

    if (toolCalls.some((t) => t && t.name)) {
      // Widget lifecycle and state.
      messages.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCalls
          .filter((t) => t && t.id)
          .map((t) => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: t.args },
          })),
      });
      // Widget lifecycle and state.
      for (const t of toolCalls) {
        if (!t || !t.id) continue;
        if (t.name === "show_widget") {
          if (t.extractor) t.extractor.finalize(t.args);
          messages.push({
            role: "tool",
            tool_call_id: t.id,
            content:
              "Widget displayed to the user; their selections will arrive as the next user message.",
          });
        } else {
          messages.push({
            role: "tool",
            tool_call_id: t.id,
            content: "Tool not available in this demo.",
          });
        }
      }
      if (widgetCall) sse({ type: "widget_end" });
      // Widget lifecycle and state.
    } else {
      // Widget lifecycle and state.
      messages.push({ role: "assistant", content: assistantText });
    }

    sse({ type: "done" });
    res.end();
  } catch (err) {
    sse({ type: "error", message: String(err && err.message ? err.message : err) });
    sse({ type: "done" });
    res.end();
  }
}

/* ====================================================================== *
 *
 * ====================================================================== */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".ico": "image/x-icon",
};

// Explicit public-asset allowlist: never expose .env, source maps, package files or backend code.
// The reference demo is not a production-ready public API (see SECURITY.md).
const PUBLIC_ASSETS = new Set([
  "/index.html",
  "/src/app.css",
  "/src/design-system.css",
  "/src/widget-host.js",
  "/src/widget.js",
  "/widgets/feedback.html",
  "/widgets/preferences.html",
  "/widgets/travel.html",
]);

async function serveStatic(req, res, urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, "http://localhost").pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  if (!PUBLIC_ASSETS.has(pathname)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const filePath = path.join(__dirname, pathname.slice(1));
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found: " + rel);
  }
}

/* ====================================================================== *
 *
 * ====================================================================== */
const server = createServer((req, res) => {
  const url = req.url || "/";

  if (req.method === "GET" && url.startsWith("/api/health")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ configured: !!client, model: MODEL, baseUrl: BASE_URL }));
    return;
  }

  if (req.method === "POST" && url.startsWith("/api/chat")) {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch {  }
      handleChat(req, res, body).catch((err) => {
        try {
          res.write("data: " + JSON.stringify({ type: "error", message: String(err) }) + "\n\n");
          res.write("data: " + JSON.stringify({ type: "done" }) + "\n\n");
          res.end();
        } catch {  }
      });
    });
    return;
  }

  if (req.method === "GET") return serveStatic(req, res, url);

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method Not Allowed");
});

// Widget lifecycle and state.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  server.listen(PORT, () => {
    console.log("\n  Show Widget running:");
    console.log("  → http://localhost:" + PORT);
    console.log("  → Model: " + MODEL + "  (" + BASE_URL + ")");
    console.log(
      "  → Online mode: " + (client ? "Ready ✅" : "API key missing (offline demo only). Set LLM_API_KEY in .env") + "\n"
    );
  });
}

export { createWidgetExtractor };
