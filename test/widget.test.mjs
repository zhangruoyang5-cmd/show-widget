/*
 * Unit tests for streamed widget extraction and form interactions.
 *
 *
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createWidgetExtractor } from "../server.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/* ============================================================== *
 *
 * ============================================================== */
test("createWidgetExtractor: reassembles widget_code across chunks and decodes escapes", () => {
  const widgetCode =
    '<form class="clarify">\n\t<span>AB</span>\\x "q" </form>';
  const fullArgs = JSON.stringify({
    title: "Plan your trip",
    loading_messages: ["Reading request…", "Building form…"],
    widget_code: widgetCode,
  });

  const events = [];
  const ext = createWidgetExtractor((e) => events.push(e));

  // Test or UI state.
  let acc = "";
  for (let i = 0; i < fullArgs.length; i += 3) {
    acc += fullArgs.slice(i, i + 3);
    ext.feed(acc);
  }
  ext.finalize(acc);

  const start = events.find((e) => e.type === "widget_start");
  assert.ok(start, "Expected a widget_start event");
  assert.equal(start.title, "Plan your trip");
  assert.deepEqual(start.loading_messages, ["Reading request…", "Building form…"]);

  const reassembled = events
    .filter((e) => e.type === "widget_delta")
    .map((e) => e.html)
    .join("");
  assert.equal(reassembled, widgetCode, "Reassembled widget_code must match exactly");
});

test("createWidgetExtractor: handles widget_code before title", () => {
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
 *
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

test("widget.js: travel defaults serialize to documented values", async () => {
  const { doc, messages, tick } = mountWidget(read("../widgets/travel.html"));
  await tick();
  doc.querySelector(".clarify-submit").click();
  await tick();

  const submit = lastByType(messages, "widget:submit");
  assert.ok(submit, "Expected widget:submit");
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

test("widget.js: updates single and multi selections before submission", async () => {
  const { doc, messages, tick } = mountWidget(read("../widgets/travel.html"));
  await tick();

  // Test or UI state.
  [...doc.querySelectorAll('[data-name="destination"] .clarify-pill')]
    .find((b) => b.dataset.value === "Kyoto")
    .click();
  // Test or UI state.
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

test("widget.js: Skip sends the standard dismissal message", async () => {
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

test("widget.js: skips empty optional fields", async () => {
  const { doc, messages, tick } = mountWidget(read("../widgets/preferences.html"));
  await tick();
  // Test or UI state.
  doc.querySelector(".clarify-submit").click();
  await tick();
  const text = lastByType(messages, "widget:submit").text;
  assert.equal(text, ["Form submitted:", "• length: Medium"].join("\n"));
});
