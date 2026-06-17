/*
 * server.js — Node 后端（仅依赖 openai）
 * ------------------------------------------------------------------------------
 *  - 托管静态前端（/、src/、widgets/、docs/）。
 *  - GET  /api/health  → { configured, model }
 *  - POST /api/chat    → SSE 流式对话循环 + show_widget 工具
 *
 * 链路：浏览器 messages → Moonshot(OpenAI 兼容, stream:true, tools:[show_widget])
 *   - 文本增量 → SSE {type:'text'}
 *   - show_widget 工具调用：按 index 累积 arguments，增量提取 widget_code
 *     → SSE {type:'widget_start'} / {type:'widget_delta'} / {type:'widget_end'}
 *   - 工具调用结束后，按 Moonshot 要求 append assistant(tool_calls)+tool(占位结果)
 *     闭合调用，并暂停本轮，等用户填写结果作为下一条 user message 回流。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 极简 .env 加载（不引 dotenv） ---------- */
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

const API_KEY = process.env.MOONSHOT_API_KEY || "";
const BASE_URL = process.env.MOONSHOT_BASE_URL || "https://api.moonshot.ai/v1";
const MODEL = process.env.MOONSHOT_MODEL || "kimi-k2.6";
const PORT = Number(process.env.PORT || 5173);

const client = API_KEY ? new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL }) : null;

/* ---------- system prompt：widget skill 单一来源 ---------- */
const SYSTEM_PROMPT = readFileSync(
  path.join(__dirname, "docs", "widget-skill.md"),
  "utf8"
);

/* ---------- show_widget 工具定义 ---------- */
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

/* ---------- 会话状态（内存，演示用） ---------- */
const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, [{ role: "system", content: SYSTEM_PROMPT }]);
  }
  return sessions.get(id);
}

/* ====================================================================== *
 *  流式提取 widget_code（从累积的 tool-call arguments JSON 串中）
 * ====================================================================== */
function createWidgetExtractor(send) {
  let startSent = false;
  let title = null;
  let loading = null;
  let valueStart = -1; // widget_code 字符串值在 args 中的起始下标
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
      if (m) { try { loading = JSON.parse(m[1]); } catch { /* 等更多数据 */ } }
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
    // 优先等 title 与 loading_messages 都就绪；但 widget_code 一旦开始就不再等（兜底）
    if ((title !== null && loading !== null) || valueStart >= 0) {
      send({
        type: "widget_start",
        title: title || "",
        loading_messages: loading && loading.length ? loading : ["读取你的需求…", "生成表单…"],
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
          if (rawPos + 5 > args.length) break; // 需要 4 位十六进制
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
        send({ type: "widget_start", title: title || "", loading_messages: ["读取你的需求…", "生成表单…"] });
        startSent = true;
      }
      try {
        const obj = JSON.parse(args);
        if (obj.widget_code && obj.widget_code.length > emittedLen) {
          send({ type: "widget_delta", html: obj.widget_code.slice(emittedLen) });
          emittedLen = obj.widget_code.length;
        }
      } catch { /* arguments 不完整则忽略，以已流出的为准 */ }
    },
  };
}

/* ====================================================================== *
 *  /api/chat —— 一轮流式对话
 * ====================================================================== */
async function handleChat(req, res, body) {
  const sse = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  if (!client) {
    sse({ type: "error", message: "后端未配置 MOONSHOT_API_KEY。" });
    sse({ type: "done" });
    return res.end();
  }

  const { sessionId, message } = body || {};
  if (!sessionId || typeof message !== "string") {
    sse({ type: "error", message: "缺少 sessionId 或 message。" });
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
      // 闭合工具调用：先 append 带 tool_calls 的 assistant 消息
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
      // 再为每个工具调用 append tool 结果（占位），否则 Moonshot 报 tool_call_id not found
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
      // 暂停本轮：等用户填写结果作为下一条 user message 回流
    } else {
      // 普通文本回复
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
 *  静态文件托管
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

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  // 防目录穿越
  const filePath = path.join(__dirname, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
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
 *  HTTP 入口
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
      if (raw.length > 1e6) req.destroy(); // 防滥用
    });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { /* 交给 handler 校验 */ }
      handleChat(req, res, body).catch((err) => {
        try {
          res.write("data: " + JSON.stringify({ type: "error", message: String(err) }) + "\n\n");
          res.write("data: " + JSON.stringify({ type: "done" }) + "\n\n");
          res.end();
        } catch { /* 已断开 */ }
      });
    });
    return;
  }

  if (req.method === "GET") return serveStatic(req, res, url);

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method Not Allowed");
});

// 仅在直接运行时监听（被测试 import 时不启动服务）
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  server.listen(PORT, () => {
    console.log("\n  Kimi Widget 运行中：");
    console.log("  → http://localhost:" + PORT);
    console.log("  → 模型：" + MODEL + "  (" + BASE_URL + ")");
    console.log(
      "  → 在线模式：" + (client ? "已就绪 ✅" : "未配置 API key（仅离线演示）⚠️  cp .env.example .env 并填入 MOONSHOT_API_KEY") + "\n"
    );
  });
}

export { createWidgetExtractor };
