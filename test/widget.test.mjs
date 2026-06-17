/*
 * 单元测试（node --test）：
 *  1) server.js 的流式 widget_code 增量提取器（按 tool-call arguments 逐片喂入）
 *  2) widget.js 的真实交互 + 序列化（用 jsdom 加载示例 widget 并模拟点击/提交）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createWidgetExtractor } from "../server.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/* ============================================================== *
 *  1) 流式提取器
 * ============================================================== */
test("createWidgetExtractor: 跨任意分片重组 widget_code 并解码转义", () => {
  const widgetCode =
    '<form class="clarify">\n\t<span>AB</span>\\x "q" </form>';
  const fullArgs = JSON.stringify({
    title: "Plan your trip",
    loading_messages: ["读取需求…", "生成表单…"],
    widget_code: widgetCode,
  });

  const events = [];
  const ext = createWidgetExtractor((e) => events.push(e));

  // 模拟 Moonshot 流式：每次喂入「累积到目前」的 arguments 串，分片故意很碎
  let acc = "";
  for (let i = 0; i < fullArgs.length; i += 3) {
    acc += fullArgs.slice(i, i + 3);
    ext.feed(acc);
  }
  ext.finalize(acc);

  const start = events.find((e) => e.type === "widget_start");
  assert.ok(start, "应发出 widget_start");
  assert.equal(start.title, "Plan your trip");
  assert.deepEqual(start.loading_messages, ["读取需求…", "生成表单…"]);

  const reassembled = events
    .filter((e) => e.type === "widget_delta")
    .map((e) => e.html)
    .join("");
  assert.equal(reassembled, widgetCode, "重组的 widget_code 应与原文逐字相等");
});

test("createWidgetExtractor: widget_code 在 title 之前也能正确处理", () => {
  const widgetCode = "<form class=\"clarify\">X</form>";
  const fullArgs =
    '{"widget_code":' + JSON.stringify(widgetCode) + ',"title":"T","loading_messages":["L"]}';
  const events = [];
  const ext = createWidgetExtractor((e) => events.push(e));
  ext.feed(fullArgs);
  ext.finalize(fullArgs);
  const reassembled = events
    .filter((e) => e.type === "widget_delta")
    .map((e) => e.html)
    .join("");
  assert.equal(reassembled, widgetCode);
});

/* ============================================================== *
 *  2) widget.js 交互 + 序列化（jsdom）
 * ============================================================== */
const WIDGET_JS = read("../src/widget.js");

function mountWidget(widgetHtml) {
  const dom = new JSDOM(
    `<!doctype html><html><body>${widgetHtml}</body></html>`,
    { runScripts: "dangerously", pretendToBeVisual: true }
  );
  const { window } = dom;
  const messages = [];
  window.addEventListener("message", (e) => messages.push(e.data));
  const script = window.document.createElement("script");
  script.textContent = WIDGET_JS;
  window.document.body.appendChild(script);
  const tick = () => new Promise((r) => window.setTimeout(r, 0));
  return { window, doc: window.document, messages, tick };
}

const lastByType = (messages, type) =>
  [...messages].reverse().find((m) => m && m.type === type);

test("widget.js: travel 默认提交 → 序列化与文档 §6.2 完全一致", async () => {
  const { doc, messages, tick } = mountWidget(read("../widgets/travel.html"));
  await tick(); // 等 ready/height
  doc.querySelector(".clarify-submit").click();
  await tick();

  const submit = lastByType(messages, "widget:submit");
  assert.ok(submit, "应收到 widget:submit");
  assert.equal(
    submit.text,
    [
      "Form submitted:",
      "• destination: Tokyo",
      "• interests: Food, Culture, Nature",
      "• depart: 2026-05-12",
      "• budget: 30,000",
    ].join("\n")
  );
});

test("widget.js: 单选互斥 + 多选切换 后再提交", async () => {
  const { doc, messages, tick } = mountWidget(read("../widgets/travel.html"));
  await tick();

  // 单选：改选 Kyoto（应取消 Tokyo）
  [...doc.querySelectorAll('[data-name="destination"] .clarify-pill')]
    .find((b) => b.dataset.value === "Kyoto")
    .click();
  // 多选：取消 Food，加选 Nightlife
  const interestPills = [...doc.querySelectorAll('[data-name="interests"] .clarify-pill')];
  interestPills.find((b) => b.dataset.value === "Food").click();
  interestPills.find((b) => b.dataset.value === "Nightlife").click();
  await tick();

  doc.querySelector(".clarify-submit").click();
  await tick();

  const text = lastByType(messages, "widget:submit").text;
  assert.match(text, /• destination: Kyoto/);
  assert.match(text, /• interests: Culture, Nature, Nightlife/);
  assert.doesNotMatch(text, /Tokyo/);
  assert.doesNotMatch(text, /Food/);
});

test("widget.js: Skip 发送固定 dismissed 文案", async () => {
  const { doc, messages, tick } = mountWidget(read("../widgets/travel.html"));
  await tick();
  doc.querySelector(".clarify-skip").click();
  await tick();
  const dismiss = lastByType(messages, "widget:dismiss");
  assert.ok(dismiss);
  assert.equal(
    dismiss.text,
    "(Form dismissed: use your best judgment or just ask me directly)"
  );
});

test("widget.js: 空字段被跳过（preferences：未选 topics / 未填 other）", async () => {
  const { doc, messages, tick } = mountWidget(read("../widgets/preferences.html"));
  await tick();
  // 默认只有 length=Medium 被预选；topics 全不选、other 留空
  doc.querySelector(".clarify-submit").click();
  await tick();
  const text = lastByType(messages, "widget:submit").text;
  assert.equal(text, ["Form submitted:", "• length: Medium"].join("\n"));
});
