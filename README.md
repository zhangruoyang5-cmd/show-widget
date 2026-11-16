# Show Widget

**Interactive clarification forms for AI chat apps.** The assistant calls a `show_widget` tool to generate plain HTML, the host renders it in a sandboxed iframe, and selected values return as the next user message. Users can choose options instead of answering several separate questions.

This is a working **reference implementation**, built with vanilla HTML, CSS, JavaScript and a lightweight Node.js backend. It connects to an OpenAI-compatible chat-completions API through the OpenAI JavaScript SDK. It is not a hosted product or a universal plug-in.

## How it works

```text
Browser chat UI --POST /api/chat (SSE)--> Node server --> Compatible model API
      ^                                     |
      | text / widget_start / widget_delta  | show_widget tool call (streamed)
      | / widget_end / done                 |
      +-------------------------------------+
      |
      +-- sandboxed iframe: CSS + generated widget_code + widget.js
          user selections --> postMessage --> next user message
```

The model generates `widget_code` as semantic HTML using `.clarify*` classes and `data-*` attributes. A preloaded stylesheet and interaction script provide the appearance and behavior. The iframe uses `sandbox="allow-scripts"` without `allow-same-origin`. The host strips script/style tags and inline event handlers. Submitted fields are serialized to a bullet list and sent as a **new user message**, not a tool result.

See [Widget Skill](docs/widget-skill.md) for when to request a form, and [HTML Contract](docs/widget-code-spec.md) for supported components.

## Project structure

| File | Role |
| --- | --- |
| `server.js` | Static server, streaming `/api/chat`, and `/api/health` |
| `index.html` | Demo chat UI with offline and online modes |
| `src/widget-host.js` | Streaming client, sanitization, iframe lifecycle, messaging |
| `src/widget.js` | Widget interaction and submission inside the iframe |
| `src/design-system.css` | Replaceable styles for `.clarify*` components |
| `src/app.css` | Demo page styling |
| `widgets/*.html` | Offline sample forms |
| `docs/widget-skill.md` | Model behavior rules, loaded as system prompt |
| `docs/widget-code-spec.md` | Markup and serialization contract |
| `test/widget.test.mjs` | Node tests for streaming and form interactions |

## Run locally

Requires **Node.js 18 or newer**.

```bash
npm install
npm test
npm start
```

Open **http://localhost:5173**.

### Offline demo

Leave the interface on **Offline demo** and select a scenario. The examples show the entire render, select, submit, and serialize flow **without an API key**.

### Online demo

```bash
cp .env.example .env
# Set LLM_API_KEY in .env
npm start
```

Choose **Online (AI)** and try **"Help me plan a trip to Tokyo."** The assistant can use `show_widget` to ask for destination, interests, dates, and budget.

| Environment variable | Description | Default |
| --- | --- | --- |
| `LLM_API_KEY` | Server-side API key | None (offline only) |
| `LLM_BASE_URL` | OpenAI-compatible base URL | `https://api.openai.com/v1` |
| `LLM_MODEL` | Model with streaming and function-tool support | `gpt-4o-mini` |
| `PORT` | Local HTTP port | `5173` |

Other providers may be used if they implement compatible chat-completions streaming and function calls; support varies by model.

## Minimal widget example

```html
<form class="clarify">
  <div class="clarify-header">
    <span>Your interests</span>
    <button type="button" class="clarify-close">×</button>
  </div>
  <div class="clarify-body">
    <div class="clarify-field">
      <label class="clarify-label">Interests</label>
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

Sample result:

```text
Form submitted:
• interests: Food, Culture
```

## Deployment and security

This is **not production-ready**. The static server serves only allowlisted demo assets; `.env`, `server.js`, and package files are not publicly exposed through it. Do not deploy the `/api/chat` endpoint publicly without authentication, abuse protection, quotas, session expiration, stronger HTML sanitization, and API cost controls. Keep `LLM_API_KEY` on the server. See [SECURITY.md](SECURITY.md).

A static preview can run on GitHub Pages, but online mode requires a configured Node backend. The demo intentionally omits accounts, durable session storage, CI deployment, and a published SDK. Complex branching clarification flows are out of scope.
