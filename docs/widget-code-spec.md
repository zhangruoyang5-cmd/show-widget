# `widget_code` HTML Contract

The model returns **pure structural HTML** in `widget_code`. The host renders it in a sandboxed iframe, injects `src/design-system.css` for styling and `src/widget.js` for delegated interactivity, and forwards submissions as user messages. Offline examples in `widgets/*.html` use the same code path.

## 1. Form skeleton

```html
<form class="clarify">
  <div class="clarify-header">
    <span>Form title</span>
    <button type="button" class="clarify-close" aria-label="Close">×</button>
  </div>
  <div class="clarify-body">
    <div class="clarify-field">
      <label class="clarify-label">Question</label>
      <!-- One control with a data-name attribute -->
    </div>
  </div>
  <div class="clarify-footer">
    <button type="button" class="clarify-skip">Skip</button>
    <button type="button" class="clarify-submit">Continue</button>
  </div>
</form>
```

Use a short, lowercase English key for each `data-name`, such as `destination`. **Close** and **Skip** send the same dismissal message; **Continue** submits values.

## 2. Supported fields

### Single-choice pills

```html
<div class="clarify-field">
  <label class="clarify-label">Destination</label>
  <div class="clarify-pills" data-multi="false" data-name="destination">
    <button type="button" class="clarify-pill" data-value="Tokyo">Tokyo</button>
    <button type="button" class="clarify-pill" data-value="Kyoto">Kyoto</button>
  </div>
</div>
```

Only one choice stays selected. The value is the selected button's `data-value`.

### Multiple-choice pills

```html
<div class="clarify-field">
  <label class="clarify-label">Interests</label>
  <div class="clarify-pills" data-multi="true" data-name="interests">
    <button type="button" class="clarify-pill selected" data-value="Food">Food</button>
    <button type="button" class="clarify-pill" data-value="Culture">Culture</button>
  </div>
</div>
```

More than one choice can be selected. Selected values are joined with `, `. The `selected` class preselects an option.

### Slider

```html
<div class="clarify-range">
  <input type="range" data-name="budget" min="5000" max="80000"
         step="1000" value="30000" data-format="thousands">
  <output class="clarify-range-value"></output>
</div>
```

The value comes from `input.value`. Optional `data-format="thousands"` displays and serializes the value with comma separators.

### Date

```html
<div class="clarify-date">
  <input type="date" data-name="depart" value="2026-05-12">
</div>
```

The value uses `YYYY-MM-DD`.

### Free text

```html
<textarea class="clarify-textarea" data-name="notes" rows="3"
          placeholder="Optional details…"></textarea>
```

### Other text input

```html
<input type="text" class="clarify-other" data-name="destination_other"
       placeholder="Type a city…">
```

Use these within `.clarify-field` alongside a `.clarify-label`.

## 3. Serialization

On **Continue**, `src/widget.js` traverses all `[data-name]` elements in document order. It reads `value` for inputs and textareas, and `data-value` for pill containers, skipping empty fields.

```text
Form submitted:
• destination: Tokyo
• interests: Food, Culture, Nature
• depart: 2026-05-12
• budget: 30,000
```

On **Skip** or **Close**, it sends:

```text
(Form dismissed: use your best judgment or just ask me directly)
```

The iframe forwards the serialized data using `postMessage`; the host then sends it to the model as the **next user message**, not as the previous tool result.

## 4. Restrictions and security

Generated code must not contain `<script>`, `<style>`, inline `style=`, `on*` handler attributes, fixed positioning, tabs, carousels, or hidden decision branches. The host strips scripts, styles, and inline event handlers. Styling and interactions belong to the host's controlled assets.

The iframe uses `sandbox="allow-scripts"` without `allow-same-origin`, so generated HTML cannot access the parent page's origin, cookies, or storage. The current sanitization is illustrative rather than a comprehensive production security solution.
