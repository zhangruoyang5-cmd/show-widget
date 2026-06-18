/*
 * widget-host.js — 宿主页编排（运行在 index.html，非 iframe 内）
 * ------------------------------------------------------------------------------
 * 职责：
 *  - sanitizeWidgetCode：按 widget_code 契约清洗模型/示例产出的 HTML。
 *  - buildSrcdoc：把 设计系统 CSS + widget_code (+ widget.js) 拼成 iframe srcdoc。
 *  - 渲染 widget 气泡（含 loading、桌面内嵌 / 移动端全屏两种形态）。
 *  - 监听 iframe 的 postMessage（ready/height/submit/dismiss）。
 *  - 在线模式：POST /api/chat 读取 SSE 流，驱动文本与 widget 的流式渲染。
 *  - 离线模式：直接加载 widgets/*.html 示例，演示组件库与交互回路（无需 API key）。
 */
(function () {
  "use strict";

  var IS_MOBILE = window.matchMedia("(max-width: 640px)");

  var dom = {
    messages: document.getElementById("messages"),
    composer: document.getElementById("composer-input"),
    send: document.getElementById("send-btn"),
    suggestions: document.getElementById("suggestions"),
    modeOnline: document.getElementById("mode-online"),
    modeOffline: document.getElementById("mode-offline"),
    status: document.getElementById("status"),
    overlay: document.getElementById("overlay"),
    overlaySheet: document.getElementById("overlay-sheet"),
  };

  var state = {
    mode: "offline", // 'offline' | 'online'
    online: false, // 后端是否配置了 API key
    sessionId: "sess-" + Math.random().toString(36).slice(2) + Date.now().toString(36),
    assets: { css: "", js: "" },
    busy: false,
  };

  // iframe.contentWindow -> widget 控制器，供 postMessage 路由
  var frameRegistry = new Map();

  /* ============================================================== *
   *  资源加载
   * ============================================================== */
  function loadAssets() {
    return Promise.all([
      fetch("src/design-system.css").then(function (r) { return r.text(); }),
      fetch("src/widget.js").then(function (r) { return r.text(); }),
    ]).then(function (res) {
      state.assets.css = res[0];
      state.assets.js = res[1];
    });
  }

  function probeBackend() {
    return fetch("api/health")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) { state.online = !!(info && info.configured); })
      .catch(function () { state.online = false; });
  }

  /* ============================================================== *
   *  widget_code 清洗（契约第 4 节）
   * ============================================================== */
  function sanitizeWidgetCode(html) {
    var violations = [];
    var doc = new DOMParser().parseFromString(html, "text/html");

    doc.querySelectorAll("script").forEach(function (n) { n.remove(); violations.push("<script>"); });
    doc.querySelectorAll("style").forEach(function (n) { n.remove(); violations.push("<style>"); });

    doc.querySelectorAll("*").forEach(function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        if (name === "style") { el.removeAttribute(attr.name); violations.push("style="); }
        else if (name.indexOf("on") === 0) { el.removeAttribute(attr.name); violations.push(name); }
      });
    });

    if (violations.length) {
      console.warn(
        "[widget sanitize] 移除了违反 widget_code 契约的内容：",
        violations.join(", ")
      );
    }
    return doc.body.innerHTML;
  }

  /* ============================================================== *
   *  srcdoc 组装
   * ============================================================== */
  function buildSrcdoc(widgetCode, interactive) {
    var clean = sanitizeWidgetCode(widgetCode);
    var script = interactive ? "<scr" + "ipt>" + state.assets.js + "</scr" + "ipt>" : "";
    return (
      "<!doctype html><html><head><meta charset='utf-8'>" +
      "<meta name='viewport' content='width=device-width, initial-scale=1'>" +
      "<style>" + state.assets.css + "</style></head><body>" +
      clean +
      script +
      "</body></html>"
    );
  }

  function makeFrame(widgetCode, interactive) {
    var iframe = document.createElement("iframe");
    iframe.className = "widget-frame";
    iframe.setAttribute("sandbox", "allow-scripts"); // 无 allow-same-origin：不可访问宿主
    iframe.setAttribute("scrolling", "no");
    iframe.style.height = "120px";
    iframe.srcdoc = buildSrcdoc(widgetCode, interactive);
    return iframe;
  }

  /* ============================================================== *
   *  DOM 辅助 / 消息气泡
   * ============================================================== */
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function scrollDown() {
    requestAnimationFrame(function () {
      dom.messages.scrollTop = dom.messages.scrollHeight;
    });
  }

  function addMessage(role, text) {
    var row = el("div", "msg " + role);
    var avatar = el("div", "avatar", role === "user" ? "你" : "K");
    var bubble = el("div", "bubble");
    bubble.textContent = text || "";
    row.appendChild(avatar);
    row.appendChild(bubble);
    dom.messages.appendChild(row);
    scrollDown();
    return {
      row: row,
      bubble: bubble,
      append: function (delta) { bubble.textContent += delta; scrollDown(); },
      set: function (t) { bubble.textContent = t; scrollDown(); },
      setTyping: function (on) { bubble.classList.toggle("cursor", !!on); },
    };
  }

  function addSystemNote(text) {
    var row = el("div", "msg assistant");
    var avatar = el("div", "avatar", "K");
    var bubble = el("div", "bubble system-note");
    bubble.textContent = text;
    row.appendChild(avatar);
    row.appendChild(bubble);
    dom.messages.appendChild(row);
    scrollDown();
  }

  /* ============================================================== *
   *  widget 气泡控制器（桌面内嵌 / 移动全屏）
   * ============================================================== */
  function createWidgetBubble(title) {
    var row = el("div", "msg widget");
    var shell = el("div", "widget-shell");

    // loading 占位
    var loading = el("div", "widget-loading widget-inline");
    var spinner = el("div", "spinner");
    var loadingText = el("span", "loading-text");
    loadingText.textContent = "准备表单…";
    loading.appendChild(spinner);
    loading.appendChild(loadingText);

    // 桌面：内嵌容器
    var inlineHost = el("div", "widget-inline");

    // 移动：启动按钮
    var launch = el("button", "widget-launch");
    launch.type = "button";
    launch.innerHTML =
      '<span class="lw-icon">▤</span><span><div class="lw-title"></div>' +
      '<div class="lw-sub">点击填写表单</div></span>';
    launch.querySelector(".lw-title").textContent = title || "请填写";
    launch.disabled = true;

    shell.appendChild(loading);
    shell.appendChild(inlineHost);
    shell.appendChild(launch);
    row.appendChild(shell);
    dom.messages.appendChild(row);
    scrollDown();

    var loadingTimer = null;
    var iframe = null;
    var resultCb = null;
    var done = false;

    function rotateLoading(messages) {
      if (!messages || !messages.length) return;
      var i = 0;
      loadingText.textContent = messages[0];
      clearInterval(loadingTimer);
      loadingTimer = setInterval(function () {
        i = (i + 1) % messages.length;
        loadingText.textContent = messages[i];
        loadingText.style.animation = "none";
        void loadingText.offsetWidth;
        loadingText.style.animation = "";
      }, 1400);
    }

    // 必须在 frame 连接到 DOM 后「同步」注册路由：iframe 内 widget.js 会在自己的
    // DOMContentLoaded 即 postMessage 上报高度，这早于宿主 iframe 的 load 事件。
    // 若改在 load 里注册，首个高度消息会因 frameRegistry 尚无该 source 而被丢弃，
    // iframe 卡在默认 120px —— 表现为「只渲染一半，点一下就无法再交互」。
    function registerFrame(frame) {
      if (frame && frame.contentWindow) frameRegistry.set(frame.contentWindow, controller);
    }

    function placeFrame(frame) {
      if (iframe && iframe.contentWindow) frameRegistry.delete(iframe.contentWindow);
      iframe = frame;
      if (IS_MOBILE.matches) {
        // 移动端：iframe 此刻尚未入 DOM，待点击启动按钮放进全屏遮罩后再注册
        launch.disabled = false;
        launch.onclick = function () { openOverlay(frame); registerFrame(frame); };
      } else {
        inlineHost.appendChild(frame);
        registerFrame(frame);
      }
    }

    var controller = {
      // 流式预览（非交互，仅展示生成中的 HTML）
      preview: function (widgetCode) {
        if (done || IS_MOBILE.matches) return; // 移动端不做流式预览
        if (!iframe || iframe.dataset.interactive === "1") {
          var f = makeFrame(widgetCode, false);
          loading.style.display = "none";
          if (iframe) inlineHost.replaceChild(f, iframe); else inlineHost.appendChild(f);
          iframe = f;
        } else {
          iframe.srcdoc = buildSrcdoc(widgetCode, false);
        }
      },
      // 渲染最终交互版
      mount: function (widgetCode) {
        clearInterval(loadingTimer);
        loading.style.display = "none";
        var f = makeFrame(widgetCode, true);
        f.dataset.interactive = "1";
        if (!IS_MOBILE.matches) {
          loadingText.parentNode && loading.remove();
          if (iframe && iframe.parentNode === inlineHost) inlineHost.replaceChild(f, iframe);
          else inlineHost.appendChild(f);
          iframe = f;
          registerFrame(f);
        } else {
          placeFrame(f);
        }
        scrollDown();
      },
      loading: rotateLoading,
      setHeight: function (h) {
        if (iframe) iframe.style.height = h + "px";
        scrollDown();
      },
      onResult: function (cb) { resultCb = cb; },
      finish: function (text, dismissed) {
        if (done) return;
        done = true;
        clearInterval(loadingTimer);
        if (iframe && iframe.contentWindow) frameRegistry.delete(iframe.contentWindow);
        closeOverlay();
        // 把 widget 折叠为一条简短系统提示，避免占用空间
        row.remove();
        addSystemNote(dismissed ? "（已跳过表单）" : "（已提交表单）");
        if (resultCb) resultCb(text, dismissed);
      },
    };

    return { controller: controller, placeFrame: placeFrame };
  }

  /* ============================================================== *
   *  移动端全屏遮罩
   * ============================================================== */
  function openOverlay(frame) {
    dom.overlaySheet.innerHTML = "";
    frame.classList.add("overlay-frame");
    frame.style.height = "auto";
    frame.style.minHeight = "320px";
    dom.overlaySheet.appendChild(frame);
    dom.overlay.classList.add("open");
  }
  function closeOverlay() {
    dom.overlay.classList.remove("open");
    dom.overlaySheet.innerHTML = "";
  }
  dom.overlay.addEventListener("click", function (e) {
    if (e.target === dom.overlay) closeOverlay();
  });

  /* ============================================================== *
   *  postMessage 路由（来自 iframe 内 widget.js）
   * ============================================================== */
  window.addEventListener("message", function (e) {
    var ctrl = frameRegistry.get(e.source);
    if (!ctrl || !e.data || !e.data.type) return;
    switch (e.data.type) {
      case "widget:ready":
        break;
      case "widget:height":
        ctrl.setHeight(e.data.height);
        break;
      case "widget:submit":
        ctrl.finish(e.data.text, false);
        break;
      case "widget:dismiss":
        ctrl.finish(e.data.text, true);
        break;
    }
  });

  /* ============================================================== *
   *  在线模式：SSE 流
   * ============================================================== */
  function setBusy(b) {
    state.busy = b;
    dom.send.disabled = b;
  }

  function sendOnline(message, asUser) {
    if (asUser) addMessage("user", message);
    setBusy(true);
    dom.suggestions.classList.add("hidden");

    var assistantMsg = null;
    var widget = null;
    var widgetCode = "";
    var rafQueued = false;

    function ensureAssistant() {
      if (!assistantMsg) { assistantMsg = addMessage("assistant", ""); assistantMsg.setTyping(true); }
      return assistantMsg;
    }

    function flushPreview() {
      rafQueued = false;
      if (widget && widgetCode) widget.controller.preview(widgetCode);
    }

    return fetch("api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, message: message }),
    })
      .then(function (res) {
        if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = "";

        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            buf += decoder.decode(r.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              var raw = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              var data = raw.split("\n")
                .filter(function (l) { return l.indexOf("data:") === 0; })
                .map(function (l) { return l.slice(5).replace(/^ /, ""); })
                .join("");
              if (!data) continue;
              var evt;
              try { evt = JSON.parse(data); } catch (err) { continue; }
              handleEvent(evt);
            }
            return pump();
          });
        }

        function handleEvent(evt) {
          switch (evt.type) {
            case "text":
              ensureAssistant().append(evt.delta || "");
              break;
            case "widget_start":
              if (assistantMsg) assistantMsg.setTyping(false);
              widget = createWidgetBubble(evt.title);
              widget.controller.loading(evt.loading_messages || ["生成表单…"]);
              widget.controller.onResult(function (text) {
                // 用户填写结果作为下一条 user message 回流
                sendOnline(text, true);
              });
              widgetCode = "";
              break;
            case "widget_delta":
              widgetCode += evt.html || "";
              if (widget && !rafQueued) { rafQueued = true; requestAnimationFrame(flushPreview); }
              break;
            case "widget_end":
              if (widget) widget.controller.mount(widgetCode);
              break;
            case "error":
              addSystemNote("⚠️ 出错：" + (evt.message || "unknown"));
              break;
            case "done":
              break;
          }
        }

        return pump();
      })
      .then(function () {
        if (assistantMsg) assistantMsg.setTyping(false);
        setBusy(false);
      })
      .catch(function (err) {
        if (assistantMsg) assistantMsg.setTyping(false);
        addSystemNote("⚠️ 请求失败：" + err.message + "（在线模式需要后端配置 MOONSHOT_API_KEY）");
        setBusy(false);
      });
  }

  /* ============================================================== *
   *  离线模式：本地示例 widget
   * ============================================================== */
  var SCENARIOS = {
    travel: {
      label: "✈️ 规划一次东京旅行",
      file: "widgets/travel.html",
      title: "Plan your trip",
      intro: "好的，我先确认几个关键偏好，这样规划出来的行程更贴合你 👇",
      loading: ["读取你的需求…", "搭建偏好表单…", "马上好…"],
      after: "收到！我会按你选的目的地、兴趣、出发日期和预算来规划行程。",
    },
    preferences: {
      label: "🎧 收集我的内容偏好",
      file: "widgets/preferences.html",
      title: "Your preferences",
      intro: "为了更懂你的口味，先花十秒选几项 👇",
      loading: ["整理选项…", "搭建表单…"],
      after: "好的，已记录你的偏好，后续推荐会据此调整。",
    },
    feedback: {
      label: "⭐ 给这次体验打个分",
      file: "widgets/feedback.html",
      title: "Quick feedback",
      intro: "想听听你的反馈，几个小问题 👇",
      loading: ["准备问卷…"],
      after: "感谢反馈！这对我们改进很有帮助。",
    },
  };

  function runOffline(key) {
    var s = SCENARIOS[key];
    if (!s) return;
    dom.suggestions.classList.add("hidden");
    addMessage("user", s.label.replace(/^[^\s]+\s/, ""));
    var intro = addMessage("assistant", s.intro);
    setBusy(true);

    fetch(s.file)
      .then(function (r) { return r.text(); })
      .then(function (code) {
        var widget = createWidgetBubble(s.title);
        widget.controller.loading(s.loading);
        widget.controller.onResult(function (text, dismissed) {
          addMessage("user", text);
          addMessage("assistant", dismissed ? "没问题，我先按通用思路继续。" : s.after);
          setBusy(false);
        });
        // 模拟流式：稍作延迟再渲染
        setTimeout(function () { widget.controller.mount(code); }, 700);
      })
      .catch(function (err) {
        addSystemNote("⚠️ 加载示例失败：" + err.message);
        setBusy(false);
      });
  }

  /* ============================================================== *
   *  输入与模式切换
   * ============================================================== */
  function submitComposer() {
    var text = dom.composer.value.trim();
    if (!text || state.busy) return;
    dom.composer.value = "";
    autosize();
    if (state.mode === "online") {
      sendOnline(text, true);
    } else {
      addMessage("user", text);
      addSystemNote(
        '离线演示模式下不调用模型。点击下方场景按钮体验 widget；或切到「在线」模式（需后端配置 API key）与真实模型对话。'
      );
      dom.suggestions.classList.remove("hidden");
    }
  }

  function autosize() {
    dom.composer.style.height = "auto";
    dom.composer.style.height = Math.min(dom.composer.scrollHeight, 140) + "px";
  }

  function setMode(mode) {
    if (mode === "online" && !state.online) {
      addSystemNote("在线模式不可用：后端未检测到 MOONSHOT_API_KEY。已留在离线模式。");
      return;
    }
    state.mode = mode;
    dom.modeOnline.classList.toggle("active", mode === "online");
    dom.modeOffline.classList.toggle("active", mode === "offline");
    dom.suggestions.classList.toggle("hidden", mode === "online");
    dom.composer.placeholder =
      mode === "online"
        ? "和 Kimi 说点什么，例如「帮我规划一次东京旅行」…"
        : "离线演示：点下方场景按钮，或在此输入查看说明…";
  }

  function updateStatus() {
    if (state.online) {
      dom.status.innerHTML = '<span class="status-dot ok"></span>后端已就绪（在线模式可用）';
    } else {
      dom.status.innerHTML = '<span class="status-dot warn"></span>未配置 API key（仅离线模式）';
    }
  }

  /* ============================================================== *
   *  初始化
   * ============================================================== */
  function bindUI() {
    dom.send.addEventListener("click", submitComposer);
    dom.composer.addEventListener("input", autosize);
    dom.composer.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitComposer(); }
    });
    dom.modeOnline.addEventListener("click", function () { setMode("online"); });
    dom.modeOffline.addEventListener("click", function () { setMode("offline"); });
    Array.prototype.forEach.call(dom.suggestions.querySelectorAll(".chip"), function (chip) {
      chip.addEventListener("click", function () { runOffline(chip.dataset.scenario); });
    });
  }

  // 渲染场景按钮
  function renderSuggestions() {
    dom.suggestions.innerHTML = "";
    Object.keys(SCENARIOS).forEach(function (key) {
      var chip = el("button", "chip");
      chip.type = "button";
      chip.dataset.scenario = key;
      chip.textContent = SCENARIOS[key].label;
      dom.suggestions.appendChild(chip);
    });
  }

  renderSuggestions();
  bindUI();
  addMessage(
    "assistant",
    "你好，我是 Kimi。当任务需要确认偏好或收集结构化信息时，我会弹出一个可点选的小表单（widget），省去你来回打字。\n\n下面是几个示例场景，点一下就能体验 👇"
  );

  Promise.all([loadAssets(), probeBackend()]).then(function () {
    updateStatus();
    if (state.online) {
      // 默认仍停在离线场景演示，但允许切到在线
      setMode("offline");
    } else {
      setMode("offline");
    }
  });
})();
