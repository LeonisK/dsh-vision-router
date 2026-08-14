// dsh-vision-router: turn-level vision routing + an on-demand vision tool.
//
// Routing: the turn that contains an image — from a user upload or a mid-turn
// tool result such as `read_image` — runs entirely on the vision model with
// raw pixel access; every other turn keeps the session's own model. Failures
// walk the configured provider/model chain, and when every vision model has
// failed in one turn the next attempt raises a classified, actionable error.
//
// vision_describe(paths?, attachmentIds?, question, json?): converts 1-4
// images (local files and/or session-uploaded attachments) into a text answer
// on demand. File access goes through ctx.fs (sandbox-aware), oversized images
// are downscaled with sharp, results are cached by content hash + question,
// and an optional JSON mode validates structured output.
//
// Proxy: an optional `proxy` config (e.g. http://127.0.0.1:10808) patches the
// process fetch to route only the `proxyHosts` domains through it; everything
// else (DeepSeek and the rest) stays on the direct connection.

import { ProxyAgent } from 'undici'
import z from '@deepseek-ai/schemastery'
import sharp from 'sharp'

export const name = 'vision-router'
export const inject = ['tools', 'llm']

export const Config = z.object({
  provider: z.string().default('openrouter'),
  model: z.string().default('qwen/qwen3-vl-235b-a22b-instruct'),
  fallbacks: z.array(z.string()).default([]),
  providers: z
    .array(
      z.object({
        provider: z.string(),
        model: z.string(),
        fallbacks: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  routing: z.boolean().default(true),
  reverseRouting: z.boolean().default(true),
  wrapperRoute: z.string().default('deepseek-vision'),
  chainRoute: z.string().default('vision-chain'),
  textProvider: z
    .object({
      provider: z.string().default('deepseek-official'),
      model: z.string().default('deepseek-v4-pro'),
    })
    .default({}),
  tool: z.boolean().default(true),
  rewriteImages: z.boolean().default(true),
  downscale: z.boolean().default(true),
  downscaleMaxPixels: z.number().step(1).min(1000).default(8000000),
  cache: z.boolean().default(true),
  cacheTtlSeconds: z.number().step(1).min(0).default(3600),
  cacheMaxEntries: z.number().step(1).min(1).default(200),
  timeoutMs: z.number().step(1).min(1000).max(600000).default(120000),
  proxy: z.string().default(''),
  proxyHosts: z.array(z.string()).default(['api.openrouter.ai', 'openrouter.ai']),
  freeFallback: z.boolean().default(true),
  httpProviders: z
    .array(
      z.object({
        name: z.string(),
        baseURL: z.string(),
        model: z.string(),
        apiKeyEnv: z.string().default(''),
        maxTokens: z.number().step(1).min(1).default(4096),
      }),
    )
    .default([]),
})

export const IMAGE_EXTENSIONS = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

export function mediaTypeOf(path) {
  const match = String(path).toLowerCase().match(/\.([a-z0-9]+)$/)
  return match ? IMAGE_EXTENSIONS[match[1]] : undefined
}

export function basenameOf(path) {
  const parts = String(path).split('/')
  return parts[parts.length - 1] || undefined
}

export function blocksHaveImage(content) {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (!block) continue
    if (block.type === 'image') return true
    if (Array.isArray(block.content) && blocksHaveImage(block.content)) return true
  }
  return false
}

export function eventHasImage(event) {
  const data = event && event.data
  if (!data) return false
  if (blocksHaveImage(data.content)) return true
  if (data.message && blocksHaveImage(data.message.content)) return true
  if (Array.isArray(data.inserted)) {
    for (const item of data.inserted) {
      if (item && blocksHaveImage(item.content)) return true
    }
  }
  return false
}

/** Flatten the single-provider shorthand and the multi-provider form into one ordered chain. */
export function providersOf(config = {}) {
  const list = []
  if (Array.isArray(config.providers)) {
    for (const entry of config.providers) {
      if (!entry || typeof entry.provider !== 'string' || typeof entry.model !== 'string') continue
      list.push({ provider: entry.provider, model: entry.model })
      for (const fallback of entry.fallbacks ?? []) {
        if (typeof fallback === 'string' && fallback !== '') {
          list.push({ provider: entry.provider, model: fallback })
        }
      }
    }
  }
  if (list.length > 0) return list
  const provider =
    typeof config.provider === 'string' && config.provider !== '' ? config.provider : 'openrouter'
  const models = []
  if (typeof config.model === 'string' && config.model !== '') models.push(config.model)
  for (const fallback of config.fallbacks ?? []) {
    if (typeof fallback === 'string' && fallback !== '') models.push(fallback)
  }
  if (models.length === 0) models.push('qwen/qwen3-vl-235b-a22b-instruct')
  return models.map((model) => ({ provider, model }))
}

const FAILURE_ADVICE = {
  region:
    'the provider rejected the request for this region; route it through a proxy or pick another model',
  tos: 'the provider refused the request for Terms-of-Service reasons (often a datacenter IP); switch proxy node or model',
  quota: 'OpenRouter reports insufficient credits (402); top up or switch model/provider',
  'rate-limit': 'rate limited (429); retry later',
  network: 'network failure; check connectivity or the proxy',
}

export function classifyFailure(message) {
  const text = String(message ?? '')
  if (/not available in your region|prohibited region|region/i.test(text)) return 'region'
  if (/terms of service|\btos\b/i.test(text)) return 'tos'
  if (/insufficient|balance|credits|\b402\b/i.test(text)) return 'quota'
  if (/\b429\b|rate.?limit/i.test(text)) return 'rate-limit'
  if (/ECONN|ETIMEDOUT|ENOTFOUND|timed? ?out|network|fetch failed|socket/i.test(text)) return 'network'
  return 'other'
}

export function failureAdvice(message) {
  return FAILURE_ADVICE[classifyFailure(message)]
}

/**
 * Rewrite image blocks into text markers that name the durable attachment id,
 * so a text-only model can later re-examine them via vision_describe.
 * @returns the rewritten messages and every attachment reference found.
 */
export function rewriteImageBlocks(messages) {
  const attachments = []
  let anyChanged = false
  const rewritten = (messages ?? []).map((message) => {
    if (!message || !Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((block) => {
      if (block && block.type === 'image' && block.attachment) {
        changed = true
        anyChanged = true
        attachments.push(block.attachment)
        const id = block.attachment.attachmentId ?? 'unknown'
        return {
          type: 'text',
          text: `[attached image: ${id}] The current model cannot see images. To examine it, call vision_describe with attachmentIds: ["${id}"] and a specific question.`,
        }
      }
      return block
    })
    return changed ? { ...message, content } : message
  })
  return { messages: anyChanged ? rewritten : (messages ?? []), attachments }
}

/** Extract a JSON object/array from model output (tolerates fences and prose). */
export function extractJson(text) {
  const source = String(text ?? '')
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : source
  const start = candidate.search(/[[{]/)
  if (start === -1) return undefined
  const trimmed = candidate.slice(start)
  for (let end = trimmed.length; end > 0; end--) {
    try {
      const value = JSON.parse(trimmed.slice(0, end))
      if (typeof value === 'object' && value !== null) return value
    } catch {
      /* keep shrinking */
    }
  }
  return undefined
}

/** Tiny LRU cache with TTL; keys are opaque strings. */
export function createCache(maxEntries, ttlMs) {
  const entries = new Map()
  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key)
        return undefined
      }
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value) {
      if (entries.has(key)) entries.delete(key)
      entries.set(key, { value, expiresAt: ttlMs <= 0 ? Infinity : Date.now() + ttlMs })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        entries.delete(oldest)
      }
    },
    get size() {
      return entries.size
    },
  }
}

/** True when the harness llm service has a registered adapter for the provider route. */
export function adapterAvailable(llm, provider) {
  try {
    llm.registration(provider)
    return true
  } catch {
    return false
  }
}

/** Stable cache key for vision_describe answers: chains + content + question + mode. */
export function cacheKeyFor({ pairs, httpProviders, contentIds, wantJson, question }) {
  const chains = [
    ...(pairs ?? []).map((pair) => `${pair.provider}:${pair.model}`),
    ...(httpProviders ?? []).map((provider) => `http:${provider.name}/${provider.model}`),
  ]
  return `${chains.join(',')}|${[...(contentIds ?? [])].sort().join(',')}|${wantJson ? 'json' : 'text'}|${question}`
}

/**
 * Strip image blocks from messages so a text-only provider never sees them —
 * the DeepSeek adapter throws on image content rather than dropping it.
 */
export function stripImageBlocks(messages) {
  return (messages ?? []).map((message) => {
    if (!message || !Array.isArray(message.content)) return message
    if (!message.content.some((block) => block && block.type === 'image')) return message
    return { ...message, content: message.content.filter((block) => !(block && block.type === 'image')) }
  })
}

/** Rough token estimate for one message (no tokenizer; conservative on purpose). */
export function estimateTokens(message) {
  let chars = 0
  let images = 0
  const walk = (block) => {
    if (block === null || block === undefined) return
    if (typeof block === 'string') {
      chars += block.length
      return
    }
    if (typeof block.text === 'string') chars += block.text.length
    if (typeof block.arguments === 'string') chars += block.arguments.length
    if (typeof block.name === 'string') chars += block.name.length
    if (block.type === 'image') images += 1
    if (Array.isArray(block.content)) block.content.forEach(walk)
  }
  if (message === null || message === undefined) return 0
  if (typeof message.content === 'string') chars += message.content.length
  else if (Array.isArray(message.content)) message.content.forEach(walk)
  return Math.ceil(chars / 2.5) + images * 1445
}

/** Sum of token estimates over a message array. */
export function estimateMessages(messages) {
  return (messages ?? []).reduce((sum, message) => sum + estimateTokens(message), 0)
}

/**
 * Truncate a conversation to fit a token budget: keep every system message,
 * always keep the last (current) message, then fill backwards from the end.
 * Used to fit a long session into a vision model's smaller context window.
 */
export function trimMessagesToBudget(messages, budgetTokens) {
  const list = messages ?? []
  if (list.length === 0) return list
  const system = list.filter((message) => message && message.role === 'system')
  const rest = list.filter((message) => !message || message.role !== 'system')
  if (rest.length === 0) return system
  const last = rest[rest.length - 1]
  const kept = [last]
  let used = estimateTokens(last)
  for (let i = rest.length - 2; i >= 0; i--) {
    const message = rest[i]
    const cost = estimateTokens(message)
    if (used + cost > budgetTokens) break
    kept.push(message)
    used += cost
  }
  kept.reverse()
  return [...system, ...kept]
}

/**
 * Reverse routing: the session's ENTRY model must declare image input or the
 * harness prompt admission rejects image messages before any plugin runs.
 * Text-only turns are sent back through the wrapper route (which strips
 * images and delegates to the text provider), or directly to the text
 * provider when the wrapper is disabled.
 */
export function reverseRouteTarget(config, { pairs, wrapperRoute, wrapperRegistered, textProvider, hasAdapter }) {
  if (config === undefined || config.provider === undefined) return undefined
  if (config.provider === textProvider.provider) return undefined
  if (wrapperRoute !== undefined && config.provider === wrapperRoute) return undefined
  const isVisionEntry = (pairs ?? []).some((pair) => pair.provider === config.provider)
  if (!isVisionEntry) return undefined
  const target =
    wrapperRegistered && wrapperRoute !== undefined
      ? { provider: wrapperRoute, model: textProvider.model }
      : textProvider
  if (!hasAdapter(target.provider)) return undefined
  return target
}

/**
 * Route switch: when the provider changes, drop `reasoningEffort` — the
 * persisted effort belongs to the previous provider and unsupported providers
 * reject the request outright (issue #1).
 */
export function switchRoute(config, provider, model) {
  const { reasoningEffort: _reasoningEffort, ...rest } = config ?? {}
  return { ...rest, provider, model }
}

/** Downscale bytes whose intrinsic pixel count exceeds maxPixels; returns original bytes on failure. */
export async function downscaleImage(bytes, maxPixels) {
  try {
    const image = sharp(bytes, { failOn: 'none' })
    const meta = await image.metadata()
    if (!meta.width || !meta.height) return bytes
    if (meta.width * meta.height <= maxPixels) return bytes
    const scale = Math.sqrt(maxPixels / (meta.width * meta.height))
    const width = Math.max(1, Math.round(meta.width * scale))
    const height = Math.max(1, Math.round(meta.height * scale))
    const resized = await image.resize({ width, height, fit: 'inside' }).toBuffer()
    return resized.length > 0 && resized.length < bytes.length ? resized : bytes
  } catch {
    return bytes
  }
}

/**
 * Direct OpenAI-compatible HTTP providers (no harness llm service involved).
 * `httpProviders` is an explicit list; when the config leaves it empty, the
 * built-in default is the OVHcloud AI Endpoints anonymous layer — a free,
 * registration-free vision endpoint (2 requests/min/IP, best-effort).
 */
export const DEFAULT_HTTP_PROVIDERS = [
  {
    name: 'ovh',
    baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    model: 'Qwen2.5-VL-72B-Instruct',
    apiKeyEnv: '',
    maxTokens: 4096,
  },
]

export function httpProvidersOf(config, allowDefault = true) {
  if (Array.isArray(config.httpProviders) && config.httpProviders.length > 0) {
    return config.httpProviders.filter(
      (p) => p && typeof p.baseURL === 'string' && typeof p.model === 'string',
    )
  }
  return allowDefault ? DEFAULT_HTTP_PROVIDERS : []
}

/** Convert harness image/text blocks plus resolved image bytes into OpenAI wire content. */
export function toOpenAIContent(blocks, bytesOf) {
  return blocks.map((block) => {
    if (block && block.type === 'image' && block.attachment) {
      const bytes = bytesOf(block.attachment)
      const data = Buffer.from(bytes).toString('base64')
      return {
        type: 'image_url',
        image_url: { url: `data:${block.attachment.mediaType};base64,${data}` },
      }
    }
    return { type: 'text', text: block && typeof block.text === 'string' ? block.text : '' }
  })
}

/** One non-streaming OpenAI-compatible chat completion; keyless when apiKeyEnv is empty. */
export async function callOpenAICompatible(provider, messages, options = {}) {
  const headers = { 'content-type': 'application/json' }
  const apiKeyEnv = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv : ''
  if (apiKeyEnv !== '') {
    let apiKey = ''
    if (typeof options.resolveCredential === 'function') {
      const hit = await options.resolveCredential(apiKeyEnv)
      if (hit) apiKey = String(hit)
    }
    if (apiKey === '' && typeof process !== 'undefined' && process.env) {
      apiKey = process.env[apiKeyEnv] ?? ''
    }
    if (apiKey === '') throw new Error(`http provider "${provider.name}": ${apiKeyEnv} is not set`)
    headers.authorization = `Bearer ${apiKey}`
  }
  const body = {
    model: provider.model,
    messages,
    max_tokens: options.maxTokens ?? provider.maxTokens ?? 4096,
    stream: false,
  }
  const response = await fetch(`${provider.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(`http provider "${provider.name}": ${response.status} ${detail}`)
  }
  const data = await response.json()
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : undefined
  if (typeof content !== 'string') throw new Error(`http provider "${provider.name}": unexpected response shape`)
  return content.trim()
}

/**
 * Minimal harness-chunk assembler (no dsh imports required). Feeds the raw
 * `llm/stream` chunk protocol and produces the final text of text blocks.
 * Terminal failures throw; a `max-tokens` finish returns the partial text.
 */
export function createChunkAssembler() {
  const parts = new Map()
  const order = []
  let finishKind
  let failure

  const push = (chunk) => {
    if (!chunk || typeof chunk.type !== 'string') return
    switch (chunk.type) {
      case 'block-start': {
        if (!parts.has(chunk.index)) {
          order.push(chunk.index)
          parts.set(chunk.index, { type: chunk.blockType, text: '' })
        }
        break
      }
      case 'text-delta': {
        const part = parts.get(chunk.index)
        if (part) part.text += chunk.text ?? ''
        break
      }
      case 'reasoning-delta':
      case 'tool-call-delta':
      case 'usage':
        break
      case 'block-end': {
        const part = parts.get(chunk.index)
        if (part && chunk.block && typeof chunk.block.text === 'string') {
          part.text = chunk.block.text
        }
        break
      }
      case 'finish': {
        const reason = chunk.reason
        if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
          failure = reason.failure
        }
        finishKind = reason && reason.kind ? reason.kind : 'stop'
        break
      }
      case 'error':
      case 'aborted':
        failure = chunk.failure
        break
      default:
        break
    }
  }

  const finish = () => {
    if (failure) {
      throw new Error(failure && failure.message ? failure.message : String(failure))
    }
    if (finishKind !== undefined && finishKind !== 'stop' && finishKind !== 'max-tokens') {
      throw new Error(`vision call finished with "${finishKind}"`)
    }
    return order
      .map((index) => parts.get(index))
      .filter((part) => part && part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim()
  }

  return { push, finish }
}

async function visionAnswer(llm, options) {
  const assembler = createChunkAssembler()
  for await (const chunk of llm.stream(options)) {
    assembler.push(chunk)
  }
  return assembler.finish()
}

export function apply(ctx, config = {}) {
  const pairs = providersOf(config)
  const timeoutMs =
    Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 120000
  const routingEnabled = config.routing !== false
  const reverseRoutingEnabled = routingEnabled && config.reverseRouting !== false
  const wrapperRoute =
    typeof config.wrapperRoute === 'string' && config.wrapperRoute !== ''
      ? config.wrapperRoute
      : undefined
  let wrapperRegistered = false
  const textProvider = {
    provider:
      config.textProvider && typeof config.textProvider.provider === 'string' && config.textProvider.provider !== ''
        ? config.textProvider.provider
        : 'deepseek-official',
    model:
      config.textProvider && typeof config.textProvider.model === 'string' && config.textProvider.model !== ''
        ? config.textProvider.model
        : 'deepseek-v4-pro',
  }
  const toolEnabled = config.tool !== false
  const rewriteEnabled = config.rewriteImages !== false
  const downscaleEnabled = config.downscale !== false
  const downscaleMaxPixels =
    Number.isFinite(config.downscaleMaxPixels) && config.downscaleMaxPixels > 0
      ? config.downscaleMaxPixels
      : 8000000
  const cacheEnabled = config.cache !== false
  const cache = createCache(
    Number.isFinite(config.cacheMaxEntries) ? config.cacheMaxEntries : 200,
    (Number.isFinite(config.cacheTtlSeconds) ? config.cacheTtlSeconds : 3600) * 1000,
  )
  const httpProviders = httpProvidersOf(config, config.freeFallback !== false)
  const resolveCredential = async (ref) => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return undefined
    try {
      return (await credentials.resolve(ref))?.value
    } catch {
      return undefined
    }
  }

  // ── wrapper route: admission + display shim ────────────────────────────────
  //
  // The harness prompt admission rejects image messages when the selected
  // session model does not declare image input, and the DeepSeek adapter
  // hardcodes text-only. This wrapper route (`deepseek-vision` by default)
  // declares image input so the admission passes, shows up in the model
  // picker as "DeepSeek + 自动识图", and delegates to the real text-provider
  // adapter for anything the waterfalls did not rewrite.
  if (wrapperRoute !== undefined) {
    const WRAPPER_MODEL_IDS = ['deepseek-v4-pro', 'deepseek-v4-flash']
    const wrapName = (name) => `${name ?? 'DeepSeek'}（自动识图）`
    const delegateAdapter = () => {
      try {
        return ctx.llm.registration(textProvider.provider).adapter
      } catch {
        return undefined
      }
    }
    const wrapperAdapter = {
      providerInfo(provider) {
        return { id: provider, name: 'DeepSeek + 自动识图' }
      },
      providerRetryPolicy() {
        try {
          return ctx.llm.registration(textProvider.provider).retryPolicy
        } catch {
          return undefined
        }
      },
      async listModels() {
        const real = delegateAdapter()
        if (real === undefined) return []
        try {
          const listed = await real.listModels(textProvider.provider)
          return listed
            .filter((model) => WRAPPER_MODEL_IDS.includes(model.id))
            .map((model) => ({
              ...model,
              provider: wrapperRoute,
              name: wrapName(model.name),
              inputModalities: ['text', 'image'],
            }))
        } catch {
          return []
        }
      },
      async resolveModel(provider, model) {
        const real = delegateAdapter()
        if (real === undefined) {
          throw new Error('vision-router: the text provider adapter is not available')
        }
        const base = await real.resolveModel(textProvider.provider, model)
        return {
          ...base,
          provider: wrapperRoute,
          name: wrapName(base.name),
          inputModalities: ['text', 'image'],
        }
      },
      async *stream(options) {
        yield* ctx.llm.stream({
          ...options,
          provider: textProvider.provider,
          messages: stripImageBlocks(options.messages),
        })
      },
    }
    const handle = ctx.llm.registerAdapter([wrapperRoute], wrapperAdapter)
    wrapperRegistered = true
    ctx.effect(() => handle, 'vision-router: wrapper route')
  }

  // ── vision chain route: fallback under our own control ─────────────────────
  //
  // The agent-loop's request-error retry is owned by dsh-llm-retry, which sits
  // OUTSIDE this plugin in the waterfall and can overrule a plugin's
  // model-switch retry. To make fallback reliable, image turns are routed to
  // this chain adapter instead; it walks the configured providers itself and
  // only surfaces a failure once every model has failed.
  const chainRoute =
    typeof config.chainRoute === 'string' && config.chainRoute !== ''
      ? config.chainRoute
      : undefined

  if (chainRoute !== undefined && routingEnabled) {
    const chainAdapter = {
      providerInfo(provider) {
        return { id: provider, name: 'Vision Chain' }
      },
      providerRetryPolicy() {
        return undefined
      },
      async listModels() {
        return pairs.map((pair) => ({
          provider: chainRoute,
          id: `${pair.provider}/${pair.model}`,
          name: `${pair.provider}/${pair.model}`,
          inputModalities: ['text', 'image'],
        }))
      },
      async resolveModel(provider, model) {
        return {
          provider: chainRoute,
          id: model,
          name: model,
          inputModalities: ['text', 'image'],
          context: { contextWindow: 128000 },
        }
      },
      async *stream(options) {
        const failures = []
        // Fit the conversation into the target model's context window: a long
        // session easily exceeds the 200-260k windows of typical vision models.
        let defaultBudget = 256000
        try {
          const base = await ctx.llm.resolveModelInfo(pairs[0].provider, pairs[0].model)
          if (base.context && base.context.contextWindow > 0) {
            defaultBudget = base.context.contextWindow
          }
        } catch {
          /* keep default */
        }
        for (const pair of pairs) {
          let budget = defaultBudget
          try {
            const info = await ctx.llm.resolveModelInfo(pair.provider, pair.model)
            if (info.context && info.context.contextWindow > 0) {
              budget = info.context.contextWindow
            }
          } catch {
            /* keep default */
          }
          const reserve = 32768
          const messages =
            estimateMessages(options.messages) > budget - reserve
              ? trimMessagesToBudget(options.messages, Math.max(budget - reserve, 16384))
              : options.messages
          let succeeded = false
          let failed = false
          let failMessage = 'unknown error'
          try {
            for await (const chunk of ctx.llm.stream({
              ...options,
              provider: pair.provider,
              model: pair.model,
              reasoningEffort: undefined,
              messages,
            })) {
              if (chunk && chunk.type === 'finish') {
                const kind = chunk.reason && chunk.reason.kind
                if (kind === 'error' || kind === 'aborted') {
                  failMessage =
                    (chunk.reason && chunk.reason.failure && chunk.reason.failure.message) || kind
                  failed = true
                  break
                }
                // 'stop' / 'max-tokens' / 'tool-calls' are success.
                succeeded = true
                yield chunk
                break
              }
              yield chunk
            }
          } catch (error) {
            failed = true
            failMessage = error && error.message ? error.message : String(error)
          }
          if (failed) {
            failures.push(`${pair.provider}/${pair.model}: ${failMessage}`)
            ctx.logger?.warn('vision-router: chain fallback -> %s', failMessage)
            continue
          }
          return
        }
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: `all vision models failed: ${failures.join(' | ')}`,
              code: 'VISION_CHAIN_EXHAUSTED',
            },
          },
        }
      },
    }
    const handle = ctx.llm.registerAdapter([chainRoute], chainAdapter)
    ctx.effect(() => handle, 'vision-router: chain route')
  }
  // session -> Map<attachmentId, ref> (uploaded images visible to vision_describe)
  const sessionAttachments = new WeakMap()
  // secondary index by session id string (agent.session object identity can change across turns)
  const sessionAttachmentsById = new Map()

  // ── optional fetch proxy for the vision provider hosts ─────────────────────

  const proxyUrl =
    typeof config.proxy === 'string' && config.proxy !== '' ? config.proxy : undefined
  const proxyHosts = Array.isArray(config.proxyHosts)
    ? config.proxyHosts.filter((host) => typeof host === 'string' && host !== '')
    : ['api.openrouter.ai', 'openrouter.ai']

  if (proxyUrl !== undefined && proxyHosts.length > 0) {
    const proxyAgent = new ProxyAgent(proxyUrl)
    const originalFetch = globalThis.fetch
    const shouldProxy = (hostname) =>
      proxyHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
    const patchedFetch = (input, init) => {
      let url
      try {
        url = new URL(
          typeof input === 'string' ? input : input && input.url ? input.url : String(input),
        )
      } catch {
        return originalFetch(input, init)
      }
      if (!shouldProxy(url.hostname)) return originalFetch(input, init)
      return originalFetch(input, { ...(init ?? {}), dispatcher: proxyAgent })
    }
    ctx.effect(() => {
      globalThis.fetch = patchedFetch
      return () => {
        globalThis.fetch = originalFetch
      }
    }, 'vision-router: proxy fetch')
  }

  const recordUploadedAttachments = (session, attachments) => {
    if (!session || !Array.isArray(attachments) || attachments.length === 0) return
    let map = sessionAttachments.get(session)
    if (!map) {
      map = new Map()
      sessionAttachments.set(session, map)
    }
    let byId
    if (session.id !== undefined) {
      byId = sessionAttachmentsById.get(String(session.id))
      if (!byId) {
        byId = new Map()
        sessionAttachmentsById.set(String(session.id), byId)
      }
    }
    for (const ref of attachments) {
      if (ref && ref.attachmentId) {
        map.set(String(ref.attachmentId), ref)
        byId?.set(String(ref.attachmentId), ref)
      }
    }
  }

  const lookupAttachment = (session, id) => {
    const byId = session && session.id !== undefined
      ? sessionAttachmentsById.get(String(session.id))
      : undefined
    if (byId !== undefined) {
      const hit = byId.get(String(id))
      if (hit !== undefined) return hit
    }
    const map = session ? sessionAttachments.get(session) : undefined
    return map ? map.get(String(id)) : undefined
  }

  // session -> { turn, startIndex, hasImage, routed, failures, lastError }
  const turnState = new WeakMap()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision && decision.kind === 'reject') return decision
    const session = payload.agent && payload.agent.session
    if (!session) return decision
    const messages = decision.messages ?? payload.messages ?? []
    const hasImage = messages.some((message) => blocksHaveImage(message && message.content))
    if (hasImage) {
      const rewrite = rewriteImageBlocks(messages)
      recordUploadedAttachments(session, rewrite.attachments)
      // With routing disabled, rewrite uploaded image blocks into attachment
      // markers so the text-only model can still query them via vision_describe.
      if (rewriteEnabled && !routingEnabled) {
        return { ...decision, messages: rewrite.messages }
      }
    }
    if (routingEnabled) {
      const events = session.events ?? []
      turnState.set(session, {
        turn: payload.turn,
        startIndex: events.length,
        hasImage,
      })
    }
    return decision
  })

  if (routingEnabled) {
    ctx.on('agent/request', async (payload, next) => {
      const config0 = await next()
      const session = payload.agent && payload.agent.session
      if (!session) return config0
      const state = turnState.get(session)
      if (!state || state.turn !== payload.turn) return config0
      if (!state.hasImage) {
        const events = session.events ?? []
        for (let i = state.startIndex; i < events.length; i++) {
          if (eventHasImage(events[i])) {
            state.hasImage = true
            break
          }
        }
      }
      if (!state.hasImage) {
        // Reverse routing: the session's entry model is a vision provider
        // (needed to pass the prompt admission); send text-only turns back
        // to the text provider (DeepSeek) so daily work stays on it.
        if (reverseRoutingEnabled) {
          const target = reverseRouteTarget(config0, {
            pairs,
            wrapperRoute,
            wrapperRegistered,
            textProvider,
            hasAdapter: (provider) => adapterAvailable(ctx.llm, provider),
          })
          if (target !== undefined) {
            return switchRoute(config0, target.provider, target.model)
          }
        }
        return config0
      }
      // Route the image turn to the chain adapter (falls back under our own
      // control), or directly to the first vision model when the chain route
      // is disabled.
      if (chainRoute !== undefined) {
        if (config0.provider === chainRoute) return config0
        return switchRoute(config0, chainRoute, `${pairs[0].provider}/${pairs[0].model}`)
      }
      const current = pairs[0]
      if (config0.provider === current.provider) return config0
      return switchRoute(config0, current.provider, current.model)
    })
  }

  if (toolEnabled) {
    ctx.tools.register({
      name: 'vision_describe',
      description:
        'Look at images with a vision model and answer a question about them. The current ' +
        'session model cannot see image content, so use this tool to convert images into text ' +
        'conclusions. Supports comparing multiple images (e.g. a design mock vs an implementation ' +
        'screenshot). Provide `paths` (absolute local image file paths, png/jpeg/webp/gif) and/or ' +
        '`attachmentIds` (ids of images the user uploaded in this conversation), 1-4 images in ' +
        'total. `question` is the question to answer; be specific. Set `json: true` to require a ' +
        'single valid JSON object as the answer.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute local image file paths, 1-4 images',
          },
          attachmentIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Attachment ids of images uploaded earlier in this conversation',
          },
          question: {
            type: 'string',
            description:
              'The question for the vision model, e.g. "compare the two images and list the differences"',
          },
          json: {
            type: 'boolean',
            description: 'Require the answer to be a single valid JSON object',
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const attachments = ctx.get('attachments')
        if (attachments === undefined) {
          throw new Error(
            'vision_describe: the durable attachment service is not available in this deployment',
          )
        }
        const fs = ctx.get('fs')
        const blocks = []
        const contentIds = []

        const paths = Array.isArray(args.paths) ? args.paths : []
        const attachmentIds = Array.isArray(args.attachmentIds) ? args.attachmentIds : []
        if (paths.length + attachmentIds.length === 0 || paths.length + attachmentIds.length > 4) {
          throw new Error('vision_describe: provide 1-4 images via paths and/or attachmentIds')
        }

        for (const path of paths) {
          if (fs === undefined) {
            throw new Error('vision_describe: the fs service is not available in this deployment')
          }
          const mediaType = mediaTypeOf(path)
          if (mediaType === undefined) {
            throw new Error(
              `vision_describe: unsupported image format ${path} (png/jpeg/webp/gif only)`,
            )
          }
          let bytes
          try {
            const target = await fs.resolve(path)
            bytes = await fs.readBytes(target, undefined, 20 * 1024 * 1024)
          } catch (error) {
            throw new Error(
              `vision_describe: failed to read ${path} (${error && error.message ? error.message : String(error)})`,
            )
          }
          if (downscaleEnabled) {
            const resized = await downscaleImage(bytes, downscaleMaxPixels)
            if (resized !== bytes) {
              ctx.logger?.info('vision-router: downscaled %s for the vision call', path)
            }
            bytes = resized
          }
          let ref
          try {
            ref = await attachments.saveImage({
              data: bytes,
              mediaType,
              ...(basenameOf(path) === undefined ? {} : { name: basenameOf(path) }),
            })
          } catch (error) {
            throw new Error(
              `vision_describe: image ${path} was rejected (${error && error.message ? error.message : String(error)})`,
            )
          }
          contentIds.push(String(ref.attachmentId))
          blocks.push({ type: 'image', attachment: ref })
        }

        for (const id of attachmentIds) {
          const session = exec && exec.agent && exec.agent.session
          const ref = lookupAttachment(session, String(id))
          if (ref === undefined) {
            throw new Error(
              `vision_describe: unknown attachment id "${id}" (it must come from an image uploaded in this conversation)`,
            )
          }
          let stored
          try {
            stored = await attachments.readImage(ref)
          } catch (error) {
            throw new Error(
              `vision_describe: failed to read attachment ${id} (${error && error.message ? error.message : String(error)})`,
            )
          }
          contentIds.push(String(ref.attachmentId))
          blocks.push({ type: 'image', attachment: stored.ref })
        }

        const question = String(args.question ?? '')
        const wantJson = args.json === true
        const jsonInstruction = wantJson
          ? '\n\nAnswer with a SINGLE valid JSON object and nothing else (no markdown fences, no prose).'
          : ''
        const usablePairs = pairs.filter((pair) => adapterAvailable(ctx.llm, pair.provider))
        const key = cacheKeyFor({
          pairs,
          httpProviders,
          contentIds,
          wantJson,
          question,
        })
        if (cacheEnabled) {
          const hit = cache.get(key)
          if (hit !== undefined) return hit
        }

        const baseMessages = [
          {
            role: 'user',
            content: [...blocks, { type: 'text', text: question + jsonInstruction }],
            source: { kind: 'plugin', plugin: 'dsh-vision-router' },
          },
        ]
        const signal = AbortSignal.timeout(timeoutMs)
        const errors = []

        for (const pair of usablePairs) {
          try {
            let messages = baseMessages
            let text = await visionAnswer(ctx.llm, {
              provider: pair.provider,
              model: pair.model,
              messages,
              maxTokens: 4096,
              signal,
            })
            if (wantJson) {
              for (let attempt = 0; attempt < 2; attempt++) {
                const parsed = extractJson(text)
                if (parsed !== undefined) {
                  const compact = JSON.stringify(parsed)
                  if (cacheEnabled) cache.set(key, compact)
                  return compact
                }
                if (attempt === 0) {
                  messages = [
                    ...baseMessages,
                    {
                      role: 'user',
                      content: [
                        {
                          type: 'text',
                          text: 'That output was not valid JSON. Respond with ONLY a valid JSON object now.',
                        },
                      ],
                      source: { kind: 'plugin', plugin: 'dsh-vision-router' },
                    },
                  ]
                  text = await visionAnswer(ctx.llm, {
                    provider: pair.provider,
                    model: pair.model,
                    messages,
                    maxTokens: 4096,
                    signal,
                  })
                }
              }
              const fallback = `vision_describe: the model did not produce valid JSON. Raw output:\n${text.slice(0, 2000)}`
              if (cacheEnabled) cache.set(key, fallback)
              return fallback
            }
            if (text !== '') {
              if (cacheEnabled) cache.set(key, text)
              return text
            }
            const empty = '(the vision model returned empty content)'
            if (cacheEnabled) cache.set(key, empty)
            return empty
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            errors.push(`${pair.provider}/${pair.model}: ${message}`)
            ctx.logger?.warn('vision-router: vision_describe fallback: %s', message)
          }
        }

        // Direct HTTP providers (built-in keyless OVHcloud by default) are the
        // final fallbacks: they bypass the harness llm service entirely, so the
        // anonymous free endpoint works without any credential.
        for (const provider of httpProviders) {
          try {
            // Precompute bytes once per block (attachments.readImage is async).
            const openAIBlocks = []
            for (const block of blocks) {
              if (block.type === 'image' && block.attachment) {
                const stored = await attachments.readImage(block.attachment)
                openAIBlocks.push(toOpenAIContent([block], () => stored.data)[0])
              } else {
                openAIBlocks.push({ type: 'text', text: block.text })
              }
            }
            const askHttp = async (correction) => {
              const content = correction === undefined ? openAIBlocks : [{ type: 'text', text: correction }]
              const answer = await callOpenAICompatible(
                provider,
                correction === undefined
                  ? [{ role: 'user', content }]
                  : [
                      { role: 'user', content: openAIBlocks },
                      { role: 'user', content: [{ type: 'text', text: correction }] },
                    ],
                { maxTokens: provider.maxTokens ?? 4096, signal, resolveCredential },
              )
              return answer
            }
            let text = await askHttp(undefined)
            if (wantJson) {
              for (let attempt = 0; attempt < 2; attempt++) {
                const parsed = extractJson(text)
                if (parsed !== undefined) {
                  const compact = JSON.stringify(parsed)
                  if (cacheEnabled) cache.set(key, compact)
                  return compact
                }
                if (attempt === 0) {
                  text = await askHttp(
                    'That output was not valid JSON. Respond with ONLY a valid JSON object now.',
                  )
                }
              }
              const fallback = `vision_describe: the model did not produce valid JSON. Raw output:\n${text.slice(0, 2000)}`
              if (cacheEnabled) cache.set(key, fallback)
              return fallback
            }
            if (text !== '') {
              if (cacheEnabled) cache.set(key, text)
              return text
            }
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            errors.push(`http:${provider.name}/${provider.model}: ${message}`)
            ctx.logger?.warn('vision-router: http provider fallback: %s', message)
          }
        }

        const last = errors.length > 0 ? errors[errors.length - 1] : 'unknown error'
        return (
          `All vision models failed: ${errors.join(' | ')}.` +
          (failureAdvice(last) ? ` ${failureAdvice(last)}.` : '')
        )
      },
    })
  }
}
