/*
 * widget.js — iframe 侧交互代理 + 序列化（宿主注入到每个 widget 的 sandboxed iframe）
 * ------------------------------------------------------------------------------
 * widget_code 本身只有静态 HTML（禁止 <script>/onclick）。所有交互都由本脚本
 * 依据 class 与 data-* 属性代理处理，结果通过 postMessage 回传宿主页：
 *   { type: 'widget:ready' }              渲染完成
 *   { type: 'widget:height', height }     高度变化（让宿主调整 iframe）
 *   { type: 'widget:submit', text }       用户提交，text 为序列化 bullet 列表
 *   { type: 'widget:dismiss', text }      用户跳过/关闭，text 为固定文案
 */
(function () {
  "use strict";

  var DISMISS_TEXT =
    "(Form dismissed: use your best judgment or just ask me directly)";

  function post(msg) {
    // 沙箱 iframe 为 opaque origin，用 '*'；宿主侧以 event.source 校验来源。
    parent.postMessage(msg, "*");
  }

  /* ---------- 数值格式化（千分位） ---------- */
  function formatThousands(v) {
    var n = Number(String(v).replace(/,/g, ""));
    if (!isFinite(n)) return v;
    return n.toLocaleString("en-US");
  }

  /* ---------- 胶囊（单选 / 多选） ---------- */
  function syncPills(container) {
    var multi = container.getAttribute("data-multi") === "true";
    var selected = Array.prototype.slice
      .call(container.querySelectorAll(".clarify-pill.selected"))
      .map(function (p) {
        return p.getAttribute("data-value") || p.textContent.trim();
      });
    container.setAttribute("data-value", multi ? selected.join(", ") : (selected[0] || ""));
  }

  function wirePills() {
    var containers = document.querySelectorAll(".clarify-pills");
    Array.prototype.forEach.call(containers, function (container) {
      var multi = container.getAttribute("data-multi") === "true";
      container.addEventListener("click", function (e) {
        var pill = e.target.closest ? e.target.closest(".clarify-pill") : null;
        if (!pill || !container.contains(pill)) return;
        if (multi) {
          pill.classList.toggle("selected");
        } else {
          Array.prototype.forEach.call(
            container.querySelectorAll(".clarify-pill"),
            function (p) { p.classList.toggle("selected", p === pill); }
          );
        }
        syncPills(container);
      });
      syncPills(container); // 初始化（支持 widget_code 预选 .selected）
    });
  }

  /* ---------- 滑块实时显示 ---------- */
  function wireRanges() {
    var ranges = document.querySelectorAll(".clarify-range input[type='range']");
    Array.prototype.forEach.call(ranges, function (input) {
      var out = input.parentElement.querySelector(".clarify-range-value");
      var thousands = input.getAttribute("data-format") === "thousands";
      function render() {
        if (out) out.textContent = thousands ? formatThousands(input.value) : input.value;
      }
      input.addEventListener("input", render);
      render();
    });
  }

  /* ---------- 序列化 ---------- */
  function readValue(el) {
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      var v = (el.value || "").trim();
      if (el.getAttribute("data-format") === "thousands" && v !== "") v = formatThousands(v);
      return v;
    }
    return (el.getAttribute("data-value") || "").trim();
  }

  function serialize() {
    var fields = document.querySelectorAll("[data-name]");
    var lines = [];
    Array.prototype.forEach.call(fields, function (el) {
      var name = el.getAttribute("data-name");
      var value = readValue(el);
      if (name && value) lines.push("• " + name + ": " + value);
    });
    return "Form submitted:\n" + lines.join("\n");
  }

  /* ---------- 提交 / 跳过 ---------- */
  function wireActions() {
    document.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest("button") : null;
      if (!t) return;
      if (t.classList.contains("clarify-submit")) {
        e.preventDefault();
        post({ type: "widget:submit", text: serialize() });
      } else if (
        t.classList.contains("clarify-skip") ||
        t.classList.contains("clarify-close")
      ) {
        e.preventDefault();
        post({ type: "widget:dismiss", text: DISMISS_TEXT });
      }
    });
    // 阻止表单原生提交（widget_code 用 <form>，回车不应刷新）
    var form = document.querySelector("form.clarify");
    if (form) form.addEventListener("submit", function (e) { e.preventDefault(); });
  }

  /* ---------- 高度上报 ---------- */
  function reportHeight() {
    var h = Math.ceil(
      Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      )
    );
    if (h > 0) post({ type: "widget:height", height: h });
  }

  function init() {
    wirePills();
    wireRanges();
    wireActions();
    reportHeight();
    post({ type: "widget:ready" });

    if (typeof ResizeObserver !== "undefined") {
      var ro = new ResizeObserver(reportHeight);
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    } else {
      window.addEventListener("resize", reportHeight);
      setTimeout(reportHeight, 120);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
