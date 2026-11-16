/*
 * Browser host for streamed interactive form widgets.
 * ------------------------------------------------------------------------------
 *
 *
 *
 *
 *
 *
 *
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
    online: false,
    sessionId: "sess-" + Math.random().toString(36).slice(2) + Date.now().toString(36),
    assets: { css: "", js: "" },
    busy: false,
  };

  // Widget lifecycle and state.
  var frameRegistry = new Map();

  /* ============================================================== *
 *
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
 *
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
        "[widget sanitize] Removed content that violates the widget HTML contract:",
        violations.join(", ")
      );
    }
    return doc.body.innerHTML;
  }

  /* ============================================================== *
 *
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
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("scrolling", "no");
    iframe.style.height = "120px";
    iframe.srcdoc = buildSrcdoc(widgetCode, interactive);
    return iframe;
  }

  /* ============================================================== *
 *
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
    var avatar = el("div", "avatar", role === "user" ? "You" : "W");
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
 *
   * ============================================================== */
  function createWidgetBubble(title) {
    var row = el("div", "msg widget");
    var shell = el("div", "widget-shell");

    // Widget lifecycle and state.
    var loading = el("div", "widget-loading widget-inline");
    var spinner = el("div", "spinner");
    var loadingText = el("span", "loading-text");
    loadingText.textContent = "Preparing form…";
    loading.appendChild(spinner);
    loading.appendChild(loadingText);

    // Widget lifecycle and state.
    var inlineHost = el("div", "widget-inline");

    // Widget lifecycle and state.
    var launch = el("button", "widget-launch");
    launch.type = "button";
    launch.innerHTML =
      '<span class="lw-icon">▤</span><span><div class="lw-title"></div>' +
      '<div class="lw-sub">Open the form</div></span>';
    launch.querySelector(".lw-title").textContent = title || "Fill in the form";
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

    // Widget lifecycle and state.
    // Widget lifecycle and state.
    // Widget lifecycle and state.
    // Widget lifecycle and state.
    function registerFrame(frame) {
      if (frame && frame.contentWindow) frameRegistry.set(frame.contentWindow, controller);
    }

    function placeFrame(frame) {
      if (iframe && iframe.contentWindow) frameRegistry.delete(iframe.contentWindow);
      iframe = frame;
      if (IS_MOBILE.matches) {
        // Widget lifecycle and state.
        launch.disabled = false;
        launch.onclick = function () { openOverlay(frame); registerFrame(frame); };
      } else {
        inlineHost.appendChild(frame);
        registerFrame(frame);
      }
    }

    var controller = {
      // Widget lifecycle and state.
      preview: function (widgetCode) {
        if (done || IS_MOBILE.matches) return;
        if (!iframe || iframe.dataset.interactive === "1") {
          var f = makeFrame(widgetCode, false);
          loading.style.display = "none";
          if (iframe) inlineHost.replaceChild(f, iframe); else inlineHost.appendChild(f);
          iframe = f;
        } else {
          iframe.srcdoc = buildSrcdoc(widgetCode, false);
        }
      },
      // Widget lifecycle and state.
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
        // Widget lifecycle and state.
        row.remove();
        addSystemNote(dismissed ? "(Form skipped)" : "(Form submitted)");
        if (resultCb) resultCb(text, dismissed);
      },
    };

    return { controller: controller, placeFrame: placeFrame };
  }

  /* ============================================================== *
 *
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
 *
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
 *
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
              widget.controller.loading(evt.loading_messages || ["Building form…"]);
              widget.controller.onResult(function (text) {
                // Widget lifecycle and state.
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
              addSystemNote("⚠️ Error: " + (evt.message || "unknown"));
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
        addSystemNote("⚠️ Request failed: " + err.message + "(online mode requires LLM_API_KEY on the server)");
        setBusy(false);
      });
  }

  /* ============================================================== *
 *
   * ============================================================== */
  var SCENARIOS = {
    travel: {
      label: "✈️ Plan a trip to Tokyo",
      file: "widgets/travel.html",
      title: "Plan your trip",
      intro: "Before planning, let me confirm a few key preferences 👇",
      loading: ["Reading your request…", "Creating preference form…", "Almost ready…"],
      after: "Got it! I can plan around your destination, interests, dates, and budget.",
    },
    preferences: {
      label: "🎧 Set content preferences",
      file: "widgets/preferences.html",
      title: "Your preferences",
      intro: "Choose a few options so I can tailor the suggestions 👇",
      loading: ["Organizing options…", "Building form…"],
      after: "Got it! Future suggestions can follow these preferences.",
    },
    feedback: {
      label: "⭐ Rate this experience",
      file: "widgets/feedback.html",
      title: "Quick feedback",
      intro: "We'd love your feedback. Just a few quick questions 👇",
      loading: ["Preparing survey…"],
      after: "Thanks for your feedback! It helps us improve.",
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
          addMessage("assistant", dismissed ? "No problem. I'll continue with general assumptions." : s.after);
          setBusy(false);
        });
        // Widget lifecycle and state.
        setTimeout(function () { widget.controller.mount(code); }, 700);
      })
      .catch(function (err) {
        addSystemNote("⚠️ Failed to load example: " + err.message);
        setBusy(false);
      });
  }

  /* ============================================================== *
 *
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
        'Offline demo does not call a model. Choose a scenario below to try a widget, or switch to Online mode after configuring a server API key.'
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
      addSystemNote("Online mode is unavailable: the server has no LLM_API_KEY. Staying in offline mode.");
      return;
    }
    state.mode = mode;
    dom.modeOnline.classList.toggle("active", mode === "online");
    dom.modeOffline.classList.toggle("active", mode === "offline");
    dom.suggestions.classList.toggle("hidden", mode === "online");
    dom.composer.placeholder =
      mode === "online"
        ? "Ask the assistant something, e.g. 'Help me plan a trip to Tokyo'…"
        : "Offline demo: choose a scenario below, or type to see instructions…";
  }

  function updateStatus() {
    if (state.online) {
      dom.status.innerHTML = '<span class="status-dot ok"></span>Server ready (online mode available)';
    } else {
      dom.status.innerHTML = '<span class="status-dot warn"></span>API key missing (offline mode only)';
    }
  }

  /* ============================================================== *
 *
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

  // Widget lifecycle and state.
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
    "Hi! I'm your AI assistant. When a task needs structured preferences, I can show a quick interactive form instead of asking several questions.\n\nTry one of these examples 👇"
  );

  Promise.all([loadAssets(), probeBackend()]).then(function () {
    updateStatus();
    if (state.online) {
      // Widget lifecycle and state.
      setMode("offline");
    } else {
      setMode("offline");
    }
  });
})();
