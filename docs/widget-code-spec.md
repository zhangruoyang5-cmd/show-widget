# `widget_code` HTML 契约

`widget_code` 是模型产出、宿主在 sandboxed iframe 中渲染的**纯 HTML**。它只描述结构与语义，
**不含任何样式与脚本**——外观来自预加载的设计系统（`src/design-system.css`），交互来自宿主
注入的 `src/widget.js`（依据 class 与 `data-*` 代理）。手写示例（`widgets/*.html`）与模型产出走
完全相同的渲染/序列化路径，因此两者可互换。

---

## 1. 外层骨架

```html
<form class="clarify">
  <div class="clarify-header">
    <span>表单标题</span>
    <button type="button" class="clarify-close" aria-label="Close">×</button>
  </div>

  <div class="clarify-body">
    <!-- 若干 .clarify-field -->
  </div>

  <div class="clarify-footer">
    <button type="button" class="clarify-skip">Skip</button>
    <button type="button" class="clarify-submit">Continue</button>
  </div>
</form>
```

- `clarify-close`（×）与 `clarify-skip` 行为相同：发送 dismissed 文案。
- `clarify-submit`：收集所有 `[data-name]` 的当前值并序列化提交。

每个问题组：

```html
<div class="clarify-field">
  <label class="clarify-label">问题文案</label>
  <!-- 一个带 data-name 的组件 -->
</div>
```

`data-name` 的值 = 回流 bullet 的字段名（小写英文短词，如 `destination`）。

---

## 2. 组件清单

### 2.1 单选胶囊 `.clarify-pills[data-multi="false"]`

```html
<div class="clarify-field">
  <label class="clarify-label">Trip length</label>
  <div class="clarify-pills" data-multi="false" data-name="length">
    <button type="button" class="clarify-pill" data-value="Weekend">Weekend</button>
    <button type="button" class="clarify-pill" data-value="One week">One week</button>
    <button type="button" class="clarify-pill" data-value="Two weeks">Two weeks</button>
  </div>
</div>
```
点击互斥选中；提交值 = 选中胶囊的 `data-value`。

### 2.2 多选胶囊 `.clarify-pills[data-multi="true"]`

```html
<div class="clarify-field">
  <label class="clarify-label">Interests</label>
  <div class="clarify-pills" data-multi="true" data-name="interests">
    <button type="button" class="clarify-pill" data-value="Food">Food</button>
    <button type="button" class="clarify-pill" data-value="Culture">Culture</button>
    <button type="button" class="clarify-pill" data-value="Nature">Nature</button>
    <button type="button" class="clarify-pill" data-value="Nightlife">Nightlife</button>
  </div>
</div>
```
可多选；提交值 = 选中项 `data-value` 以 `, ` 连接（如 `Food, Culture, Nature`）。

### 2.3 滑块 `.clarify-range`

```html
<div class="clarify-field">
  <label class="clarify-label">Budget (USD)</label>
  <div class="clarify-range">
    <input type="range" data-name="budget"
           min="5000" max="80000" step="1000" value="30000"
           data-format="thousands">
    <output class="clarify-range-value"></output>
  </div>
</div>
```
提交值 = `input.value`。可选 `data-format="thousands"` 让显示与提交值带千分位（`30,000`）。
`<output class="clarify-range-value">` 用于实时显示当前值（由 widget.js 填充）。

### 2.4 日期 `.clarify-date`

```html
<div class="clarify-field">
  <label class="clarify-label">Departure date</label>
  <div class="clarify-date">
    <input type="date" data-name="depart" value="2026-05-12">
  </div>
</div>
```
提交值 = `input.value`（`YYYY-MM-DD`）。

### 2.5 文本域 `.clarify-textarea`

```html
<div class="clarify-field">
  <label class="clarify-label">Anything else?</label>
  <textarea class="clarify-textarea" data-name="notes"
            rows="3" placeholder="Optional details…"></textarea>
</div>
```
提交值 = `textarea.value`。

### 2.6 其他输入 `.clarify-other`

```html
<div class="clarify-field">
  <label class="clarify-label">Other destination</label>
  <input type="text" class="clarify-other" data-name="destination_other"
         placeholder="Type a city…">
</div>
```
当胶囊选项不穷尽时补充；提交值 = `input.value`。

---

## 3. 序列化规则（宿主 widget.js 实现）

点击 **Continue** 时：

1. 按文档顺序遍历所有带 `data-name` 的元素。
2. 取值：若元素是 `input`/`textarea` 取 `.value`；否则取 `data-value` 属性（胶囊容器由 widget.js 维护）。
3. **跳过空值**（未选/未填的字段不出现在结果里）。
4. 拼成 bullet 列表：

```
Form submitted:
• destination: Tokyo
• interests: Food, Culture, Nature
• depart: 2026-05-12
• budget: 30,000
```

点击 **Skip / ×** 时发送固定文案：

```
(Form dismissed: use your best judgment or just ask me directly)
```

结果通过 `postMessage` 回传宿主页，宿主把它作为**下一条 user message** 发给模型。

---

## 4. 严格限制（`sanitizeWidgetCode` 会强制执行）

| 禁止 | 原因 | 宿主处理 |
| --- | --- | --- |
| `<script>` | XSS / 越权 | 移除 + console 告警 |
| `<style>`、内联 `style=` | 破坏设计系统一致性 | 移除 + 告警 |
| `on*`（onclick 等） | 事件应由 widget.js 代理 | 移除属性 + 告警 |
| `position: fixed` | 破坏对话内嵌布局 | （随 style 一并移除） |
| tabs / carousel / 隐藏块 | 一次性清单不需要 | 不提供对应 class |

iframe 以 `sandbox="allow-scripts"`（无 `allow-same-origin`）渲染，无法访问宿主页上下文、
cookie 或存储；唯一运行的脚本是宿主注入的 `widget.js`。
