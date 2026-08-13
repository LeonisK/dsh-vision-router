# dsh-vision-router

**Eyes for text-only agents on DeepSeek Harness.** Route image turns to a vision model — keep DeepSeek for everything else.

[中文](./README.md)

[![License: LGPL-3.0](https://img.shields.io/badge/License-LGPL--3.0-blue.svg)](https://github.com/ysr666/dsh-vision-router/blob/main/LICENSE)
[![Node >=22](https://img.shields.io/badge/Node-%3E%3D22-green.svg)]()
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-8A2BE2.svg)]()
[![CI](https://img.shields.io/github/actions/workflow/status/ysr666/dsh-vision-router/ci.yml?branch=main)](https://github.com/ysr666/dsh-vision-router/actions/workflows/ci.yml)
[![npm v0.1.0](https://img.shields.io/badge/npm-v0.1.0-orange.svg)]()

---

## Why dsh-vision-router

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is *everything-is-a-plugin*:
capabilities are Cordis rows, models route per request, and tools live in a shared registry.
This plugin is built **on those exact seams** instead of working around them:

| dsh capability | how this plugin rides it |
|---|---|
| Agent-loop waterfalls | `agent/pre-step` sees the turn's messages; `agent/request` rewrites the model route; `agent/request-error` drives fallbacks |
| Tool registry | `vision_describe` registers like any first-party tool — every preset gets it automatically |
| Sandbox & attachment services | file reads go through `ctx.fs` (sandbox-aware); images persist through `ctx.attachments` (content-addressed) |
| Plugin composition | one `insert` row in your profile patch; no preset edits, no source changes |

The result is **not** a text-description bridge (information loss), **not** a session-wide model
swap (bills every turn), but *turn-level routing*: the exact turn that contains an image gets
raw pixel access on a vision model; every other turn stays on your daily model.

## Features

<table>
<tr>
<td width="50%">

### 🎯 Turn-level routing
An image in the turn — from a drag-and-drop upload or a mid-turn `read_image` result —
switches the whole turn to the vision model. Text turns never leave DeepSeek.

</td>
<td width="50%">

### 🔁 Provider fallback chains
Region blocks, provider ToS refusals, 402 quota, 429 rate limits, network errors —
each failure walks to the next model automatically, even for error codes the default
retry policy would abort on.

</td>
</tr>
<tr>
<td width="50%">

### 🔍 vision_describe tool
Convert 1–4 images (local files or uploaded attachments) into a text answer on demand.
Supports side-by-side comparison — design mock vs. implementation screenshot.

</td>
<td width="50%">

### 🧾 JSON mode
Ask for structured output; invalid JSON is detected and retried once with a stricter
prompt before falling back.

</td>
</tr>
<tr>
<td width="50%">

### 🖼️ Image downscaling
Oversized images are downscaled with `sharp` before submission, instead of failing
the harness admission limits.

</td>
<td width="50%">

### 💾 Result caching
Answers are cached by content-addressed image id + question + model chain (LRU + TTL).
The same screenshot asked twice costs nothing.

</td>
</tr>
<tr>
<td width="50%">

### 🔌 Per-host proxy
Route only the vision provider's hosts through a local proxy (`http://` or `socks://`);
DeepSeek and everything else stay direct.

</td>
<td width="50%">

### 📎 Uploaded-attachment reuse
With routing disabled, uploaded images are rewritten into attachment markers, so the
text model can re-examine them later via `vision_describe`.

</td>
</tr>
</table>

## Architecture

```mermaid
flowchart TD
    U[User turn] --> PS{agent/pre-step<br/>image in claimed messages?}
    PS -- no --> TEXT[Session model<br/>e.g. DeepSeek]
    PS -- yes --> R{agent/request<br/>rewrite route}
    R --> V1[Vision provider 1<br/>raw pixels]
    V1 -- fails --> ERR[agent/request-error<br/>force retry]
    ERR --> V2[Vision provider 2]
    V2 -- fails --> ERR2[... until chain exhausted]
    ERR2 --> E[Classified actionable error]
    V1 -- ok --> DONE[Whole turn on vision model]
    T[vision_describe tool] --> C{cache hit?}
    C -- no --> DS[downscale?] --> LLM[ctx.llm.stream<br/>provider chain]
    C -- yes --> OUT[Cached answer]
    LLM -- ok --> OUT
    LLM -- all failed --> F[Friendly failure text]
```

## Installation

```sh
# from GitHub (this repository)
dsh plugin --profile web add github:ysr666/dsh-vision-router

# or, once published to npm:
# dsh plugin --profile web add dsh-vision-router
```

Add the row to your profile patch (`$DSH_HOME/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: vision-router
      name: 'dsh-vision-router'
      config:
        provider: openrouter
        model: openai/gpt-5.6-sol
        fallbacks:
          - qwen/qwen3-vl-235b-a22b-instruct
```

Restart `dsh web`.

> **Prerequisite**: every vision model you name must exist in your OpenRouter
> settings (`$DSH_HOME/settings.yaml` → `llm-pi-ai.providers.openrouter.models`)
> with `input: [text, image]`, otherwise the harness rejects image content for it.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `provider` | `openrouter` | Provider route for the shorthand chain. |
| `model` | `openai/gpt-5.6-sol` | Primary vision model (shorthand). |
| `fallbacks` | `[]` | Fallback models of the same provider (shorthand). |
| `providers` | `[]` | **Multi-provider form**: list of `{ provider, model, fallbacks[] }`; each entry is tried in order. Takes precedence over the shorthand. |
| `routing` | `true` | Turn-level routing. `false` = tool only. |
| `tool` | `true` | Register `vision_describe`. `false` = routing only. |
| `rewriteImages` | `true` | With routing disabled, rewrite uploaded image blocks into attachment markers. |
| `downscale` | `true` | Downscale images above `downscaleMaxPixels`. |
| `downscaleMaxPixels` | `8000000` | Pixel budget (≈8 MP) for tool images. |
| `cache` | `true` | Cache `vision_describe` answers. |
| `cacheTtlSeconds` | `3600` | Cache lifetime (`0` = forever). |
| `cacheMaxEntries` | `200` | LRU capacity. |
| `timeoutMs` | `120000` | Per vision call timeout (tool path). |
| `proxy` | `""` | Optional `http://host:port` or `socks://host:port`. |
| `proxyHosts` | `api.openrouter.ai`, `openrouter.ai` | Only these hosts go through `proxy`. |

### Multi-provider chains

```yaml
config:
  providers:
    - provider: openrouter
      model: openai/gpt-5.6-sol
      fallbacks: [openai/gpt-5.6-sol-pro]
    - provider: openrouter
      model: qwen/qwen3-vl-235b-a22b-instruct
    - provider: pi-ai-custom
      model: glm-4.6v
```

Each provider/model pair is an independent link in the chain — a failure on one
moves to the next, regardless of provider.

### Proxy

```yaml
config:
  proxy: http://127.0.0.1:10808
  proxyHosts: [openrouter.ai]
```

Useful when the provider region-blocks your IP or your exit node is ToS-flagged.
Only the listed hosts are proxied; DeepSeek stays on the direct connection.

## Comparison

| | Manual model switching | MCP vision bridge | dsh-vision-router |
|---|---|---|---|
| Pixel fidelity | ✅ full (when switched) | ❌ text description only | ✅ full, on the image turn |
| Automatic | ❌ | ✅ | ✅ |
| Daily model untouched | ❌ (whole session swapped) | ✅ | ✅ |
| Provider failure recovery | ❌ | ❌ | ✅ fallback chains |
| Reusable structured queries | — | partial | ✅ JSON mode + caching |
| Fits dsh composition | — | external server | ✅ one plugin row |

## FAQ

**Why turn-level instead of session-sticky routing?**
You wanted "everything except images on my daily model". The image turn gets full
pixel fidelity; the vision model's text conclusions stay in history for the text
model to read afterwards.

**Why 403 "not available in your region"?**
The provider enforces region availability. Route the provider hosts through a proxy
with an allowed exit IP, or use a region-available fallback model.

**Why "provider Terms Of Service" even through my proxy?**
Your exit node's IP is flagged by the provider (common for datacenter IPs). Switch
to a cleaner node, or use a fallback model.

**Why does `api.openrouter.ai` fail while `openrouter.ai` works?**
Some regions and exit nodes reset the `api.` subdomain specifically. Point your
OpenRouter `baseURL` at `https://openrouter.ai/api/v1` in your provider settings.

**Which image formats work?**
The harness attachment path accepts `png`/`jpeg`/`webp`/`gif` only. Convert
`heic`/`tiff` first. Uploaded images are limited by the deployment's
`attachment-local` limits (default 5 MB / 40 MP; override that row to raise them).

## Development

```sh
pnpm install
pnpm test
```

The exported helpers (`providersOf`, `blocksHaveImage`, `eventHasImage`,
`rewriteImageBlocks`, `extractJson`, `createCache`, `downscaleImage`,
`createChunkAssembler`, `classifyFailure`) are the testable core; `apply` wires
them into the harness waterfalls. Pull requests welcome.

## License

[LGPL-3.0](./LICENSE)
