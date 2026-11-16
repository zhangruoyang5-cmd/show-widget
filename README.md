# Show Widget

> 在 AI 对话流中内嵌**可交互的澄清表单**：模型通过 `show_widget` 工具产出纯 HTML，宿主在 sandboxed iframe 中渲染，用户点选/滑动后，结果被序列化为下一条 user message 回流给模型继续生成 —— 用「点选」替代多轮「打字」。

本仓库是该机制的一个**可运行参考实现**：原生 HTML/CSS/JS 前端 + 极简 Node 后端（真实接入 Kimi / Moonshot 模型）。

---

## 它解决什么问题

收集 3–5 个并列参数时，传统文字问答往往要 5–10 轮、易遗漏、不可视。Widget 把这一步压缩成一张可点选的小卡片：输入成本低、结构化、歧义少、1–2 轮完成。详见 [`docs/widget-skill.md`](docs/widget-skill.md)（何时/如何用）与 [`docs/widget-code-spec.md`](docs/widget-code-spec.md)（HTML 契约）。

## 架构

```
浏览器 (chat UI)  ──POST /api/chat (SSE)──▶  Node 后端 (server.js) ──OpenAI SDK──▶  Moonshot / Kimi
     ▲                                            │
     │  SSE: text / widget_start / widget_delta   │  stream:true + tools:[show_widget]
     │       / widget_end / done                  │  流式累积 tool 参数，增量提取 widget_code
     └────────────────────────────────────────────┘
                                                  │
渲染：宿主把 [设计系统 CSS + widget_code (+ widget.js)] 拼成 srcdoc
      → sandbox="allow-scripts" 的 iframe → 用户交互
      → widget.js 序列化为 bullet 列表 → postMessage → 作为新 user message 回流
```

- **`widget_code` 是纯 HTML**（禁止 `<script>`/`<style>`/内联样式/`on*`）。外观来自预加载的设计系统，交互由宿主注入的 `widget.js` 依据 class 与 `data-*` 代理。
- **iframe `sandbox="allow-scripts"`**（无 `allow-same-origin`）：widget 无法访问宿主页、cookie 或存储。宿主侧 `sanitizeWidgetCode()` 还会强制剔除违规标记。
- **结果以 user message 回流**（非 tool_result）—— 这是调研文档明确的设计。后端用一个占位 tool_result 闭合工具调用以满足 API 约束，再等待用户填写结果作为下一条 user message。

## 目录

| 路径 | 说明 |
| --- | --- |
| `server.js` | Node 后端：托管静态 + `/api/chat`(SSE) + `/api/health` |
| `index.html` | 演示宿主页（聊天 UI + 离线/在线开关） |
| `src/widget-host.js` | 宿主编排：SSE 客户端、sanitize、拼 srcdoc、postMessage、移动端全屏 |
| `src/widget.js` | iframe 内交互代理 + 序列化（注入到每个 widget） |
| `src/design-system.css` | 设计系统（`.clarify*` 全套组件，**占位诠释版，可替换**） |
| `src/app.css` | 聊天 UI 外壳样式 |
| `widgets/*.html` | 离线演示用示例 `widget_code`（纯 HTML） |
| `docs/widget-skill.md` | 模型行为规范，**同时被 server.js 当 system prompt 注入** |
| `docs/widget-code-spec.md` | `widget_code` HTML 契约（结构/组件/序列化/限制） |

## 运行

需要 Node ≥ 18。

```bash
npm install
node server.js          # 默认 http://localhost:5173
```

### 离线演示模式（无需 API key）
直接打开页面，保持「离线演示」，点击场景按钮即可体验完整交互回路（渲染 → 填写 → 提交 → 序列化）。适合查看组件库与序列化格式。

### 在线模式（真实模型）
```bash
cp .env.example .env
# 编辑 .env，填入 MOONSHOT_API_KEY（从 https://platform.moonshot.ai 获取）
node server.js
```
页面右上切到「在线（真模型）」，输入如 *“帮我规划一次东京旅行”*：模型会判断并调用 `show_widget`，widget_code 流式渲染，你填写提交后结果回流，模型据此产出最终回复。

`.env` 可配项：`MOONSHOT_API_KEY` / `MOONSHOT_BASE_URL`（海外 `api.moonshot.ai`，国内 `api.moonshot.cn`）/ `MOONSHOT_MODEL`（默认 `kimi-k2.6`）/ `PORT`。

## 编写一个 widget

`widget_code` 是一段遵循 `.clarify` 契约的纯 HTML（见 `widgets/travel.html` 与 `docs/widget-code-spec.md`）。最小骨架：

```html
<form class="clarify">
  <div class="clarify-header"><span>标题</span>
    <button type="button" class="clarify-close">×</button></div>
  <div class="clarify-body">
    <div class="clarify-field">
      <label class="clarify-label">兴趣</label>
      <div class="clarify-pills" data-multi="true" data-name="interests">
        <button type="button" class="clarify-pill" data-value="Food">Food</button>
        <button type="button" class="clarify-pill" data-value="Culture">Culture</button>
      </div>
    </div>
  </div>
  <div class="clarify-footer">
    <button type="button" class="clarify-skip">Skip</button>
    <button type="button" class="clarify-submit">Continue</button>
  </div>
</form>
```

提交后回流：
```
Form submitted:
• interests: Food, Culture
```

## 部署

这是零构建的静态前端 + 一个 Node 后端：

- **想要完整在线对话**：把 `server.js` 部署到任意 Node 主机（Render / Railway / 自有服务器等），配好 `MOONSHOT_API_KEY` 环境变量即可。
- **仅离线演示**：前端是纯静态资源，可直接托管到 GitHub Pages（仓库已含 `.nojekyll`）；在线模式按钮会因无后端而提示不可用。

> 安全：`MOONSHOT_API_KEY` 只存在于服务端，永不下发浏览器。`.env` 已被 `.gitignore` 忽略。

## 设计系统说明

`src/design-system.css` 是对调研文档「Kimi 设计系统」描述的**占位诠释版**（干净浅色主题、点选友好）。接入真实设计系统时，只需替换该文件，保持其中的 class / `data-*` 契约不变即可——示例 widget 与模型产出都会随之换肤。

## 不在本实现范围

- 不含账号体系、持久化、多会话存储（演示聚焦单会话链路）。
- 不含 CI / 自动上线。
- 一次澄清通常只触发一个 widget；多步决策树不适合用 widget（见 skill 文档）。

## 安全与公开部署提示

此仓库是参考演示，而非可直接用于公开服务的生产系统。静态文件由显式白名单提供，`.env`、`server.js` 等非公开文件不应被 HTTP 访问。在将在线聊天 API 暴露到公网前，仍须添加身份验证、请求频率限制、会话清理、模型费用保护与更严格的 HTML 安全策略。详见 [SECURITY.md](SECURITY.md)。

如希望在自己的 AI Chat 应用中实现类似交互，可参考 [Widget Skill](docs/widget-skill.md) 和 [HTML Contract](docs/widget-code-spec.md)；这是一个需要宿主应用集成的参考实现，并不是通用 AI 聊天客户端即装即用的插件。
