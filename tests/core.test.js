import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  mediaTypeOf,
  basenameOf,
  blocksHaveImage,
  eventHasImage,
  classifyFailure,
  createChunkAssembler,
  providersOf,
  rewriteImageBlocks,
  extractJson,
  createCache,
  downscaleImage,
  toOpenAIContent,
  callOpenAICompatible,
  cacheKeyFor,
  adapterAvailable,
  httpProvidersOf,
  DEFAULT_HTTP_PROVIDERS,
  reverseRouteTarget,
  stripImageBlocks,
  switchRoute,
  estimateTokens,
  estimateMessages,
  trimMessagesToBudget,
} from '../index.js'

test('mediaTypeOf maps extensions', () => {
  assert.equal(mediaTypeOf('/a/b.PNG'), 'image/png')
  assert.equal(mediaTypeOf('x.jpeg'), 'image/jpeg')
  assert.equal(mediaTypeOf('x.jpg'), 'image/jpeg')
  assert.equal(mediaTypeOf('x.webp'), 'image/webp')
  assert.equal(mediaTypeOf('x.gif'), 'image/gif')
  assert.equal(mediaTypeOf('x.tiff'), undefined)
  assert.equal(mediaTypeOf('x.heic'), undefined)
  assert.equal(mediaTypeOf('noext'), undefined)
})

test('basenameOf returns the last path segment', () => {
  assert.equal(basenameOf('/a/b/c.png'), 'c.png')
  assert.equal(basenameOf('c.png'), 'c.png')
})

test('blocksHaveImage detects image blocks and nested tool results', () => {
  assert.equal(blocksHaveImage([]), false)
  assert.equal(blocksHaveImage([{ type: 'text', text: 'hi' }]), false)
  assert.equal(blocksHaveImage([{ type: 'image' }]), true)
  assert.equal(blocksHaveImage([{ type: 'tool-result', content: [{ type: 'image' }] }]), true)
  assert.equal(
    blocksHaveImage([{ type: 'tool-result', content: [{ type: 'text', text: 'nope' }] }]),
    false,
  )
  assert.equal(blocksHaveImage('not an array'), false)
  assert.equal(blocksHaveImage(undefined), false)
})

test('eventHasImage scans the three known event shapes', () => {
  assert.equal(eventHasImage({ data: { content: [{ type: 'image' }] } }), true)
  assert.equal(eventHasImage({ data: { message: { content: [{ type: 'image' }] } } }), true)
  assert.equal(
    eventHasImage({ data: { inserted: [{ content: [{ type: 'text', text: 'x' }] }] } }),
    false,
  )
  assert.equal(eventHasImage({ data: { inserted: [{ content: [{ type: 'image' }] }] } }), true)
  assert.equal(eventHasImage({ data: {} }), false)
  assert.equal(eventHasImage({}), false)
  assert.equal(eventHasImage(undefined), false)
})

test('classifyFailure recognizes the provider failure vocabulary', () => {
  assert.equal(classifyFailure('This model is not available in your region.'), 'region')
  assert.equal(
    classifyFailure('The request is prohibited due to a violation of provider Terms Of Service.'),
    'tos',
  )
  assert.equal(classifyFailure('Insufficient credits: balance 0'), 'quota')
  assert.equal(classifyFailure('402 Payment Required'), 'quota')
  assert.equal(classifyFailure('429 rate limited'), 'rate-limit')
  assert.equal(classifyFailure('fetch failed ECONNREFUSED'), 'network')
  assert.equal(classifyFailure('something entirely different'), 'other')
})

test('chunk assembler builds text from the raw chunk protocol', () => {
  const a = createChunkAssembler()
  a.push({ type: 'block-start', index: 0, blockType: 'text' })
  a.push({ type: 'text-delta', index: 0, text: 'hel' })
  a.push({ type: 'text-delta', index: 0, text: 'lo' })
  a.push({ type: 'block-start', index: 1, blockType: 'reasoning' })
  a.push({ type: 'reasoning-delta', index: 1, text: 'ignored' })
  a.push({ type: 'usage', usage: {} })
  a.push({ type: 'finish', reason: { kind: 'stop' } })
  assert.equal(a.finish(), 'hello')
})

test('chunk assembler keeps partial text on max-tokens', () => {
  const a = createChunkAssembler()
  a.push({ type: 'block-start', index: 0, blockType: 'text' })
  a.push({ type: 'text-delta', index: 0, text: 'partial' })
  a.push({ type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(a.finish(), 'partial')
})

test('chunk assembler throws the failure message carried by the finish chunk', () => {
  const a = createChunkAssembler()
  a.push({
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'Insufficient credits', code: 'QUOTA' } },
  })
  assert.throws(() => a.finish(), /Insufficient credits/)
})

test('chunk assembler throws on unexpected finish kinds', () => {
  const a = createChunkAssembler()
  a.push({ type: 'finish', reason: { kind: 'weird' } })
  assert.throws(() => a.finish(), /weird/)
})

test('chunk assembler ignores unknown chunk types and malformed chunks', () => {
  const a = createChunkAssembler()
  a.push(null)
  a.push({ type: 'mystery' })
  a.push({})
  a.push({ type: 'block-start', index: 0, blockType: 'text' })
  a.push({ type: 'text-delta', index: 0, text: 'ok' })
  a.push({ type: 'finish', reason: undefined })
  assert.equal(a.finish(), 'ok')
})

test('providersOf flattens the single-provider shorthand', () => {
  assert.deepEqual(
    providersOf({ provider: 'openrouter', model: 'm1', fallbacks: ['m2'] }),
    [
      { provider: 'openrouter', model: 'm1' },
      { provider: 'openrouter', model: 'm2' },
    ],
  )
  assert.deepEqual(providersOf({}), [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }])
})

test('providersOf flattens the multi-provider form and prefers it', () => {
  assert.deepEqual(
    providersOf({
      provider: 'ignored',
      model: 'ignored',
      providers: [
        { provider: 'p1', model: 'a', fallbacks: ['b'] },
        { provider: 'p2', model: 'c' },
      ],
    }),
    [
      { provider: 'p1', model: 'a' },
      { provider: 'p1', model: 'b' },
      { provider: 'p2', model: 'c' },
    ],
  )
})

test('rewriteImageBlocks replaces image blocks with attachment markers', () => {
  const ref = { attachmentId: 'att-1', mediaType: 'image/png' }
  const { messages, attachments } = rewriteImageBlocks([
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: ref }] },
  ])
  assert.equal(messages[0].content[0].type, 'text')
  assert.match(messages[0].content[1].text, /att-1/)
  assert.match(messages[0].content[1].text, /vision_describe/)
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0], ref)
})

test('rewriteImageBlocks leaves image-less messages untouched', () => {
  const input = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  const { messages, attachments } = rewriteImageBlocks(input)
  assert.equal(messages, input)
  assert.equal(attachments.length, 0)
})

test('extractJson tolerates fences and surrounding prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('here you go: [1,2,3] trailing'), [1, 2, 3])
  assert.equal(extractJson('no json here'), undefined)
  assert.equal(extractJson(''), undefined)
})

test('createCache applies TTL and LRU eviction', async () => {
  const cache = createCache(2, 50)
  cache.set('a', 1)
  cache.set('b', 2)
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('c'), 3)
  await new Promise((resolve) => setTimeout(resolve, 70))
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('c'), undefined)
  assert.equal(cache.size, 0)
})

test('createCache with ttl 0 keeps entries forever', () => {
  const cache = createCache(10, 0)
  cache.set('a', 1)
  assert.equal(cache.get('a'), 1)
})

test('downscaleImage shrinks oversized images and keeps small ones', async () => {
  const big = await sharp({
    create: { width: 4000, height: 3000, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer()
  const shrunk = await downscaleImage(big, 8000000)
  assert.ok(shrunk.length > 0)
  assert.ok(shrunk.length < big.length)
  const meta = await sharp(shrunk).metadata()
  assert.ok(meta.width * meta.height <= 8000000)

  const small = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer()
  assert.equal(await downscaleImage(small, 8000000), small)
})

test('downscaleImage returns original bytes for corrupt input', async () => {
  const bytes = Buffer.from('not an image')
  assert.equal(await downscaleImage(bytes, 8000000), bytes)
})

test('toOpenAIContent converts harness blocks to OpenAI wire content', () => {
  const ref = { attachmentId: 'a1', mediaType: 'image/png' }
  const blocks = [
    { type: 'image', attachment: ref },
    { type: 'text', text: 'describe' },
  ]
  const content = toOpenAIContent(blocks, () => Buffer.from('PNGBYTES'))
  assert.equal(content[0].type, 'image_url')
  assert.equal(
    content[0].image_url.url,
    `data:image/png;base64,${Buffer.from('PNGBYTES').toString('base64')}`,
  )
  assert.deepEqual(content[1], { type: 'text', text: 'describe' })
})

test('callOpenAICompatible posts keyless when apiKeyEnv is empty', async () => {
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const text = await callOpenAICompatible(
      { name: 't', baseURL: 'https://example.com/v1/', model: 'm' },
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    )
    assert.equal(text, 'OK')
    assert.equal(captured.url, 'https://example.com/v1/chat/completions')
    assert.equal(captured.init.headers.authorization, undefined)
    assert.equal(JSON.parse(captured.init.body).stream, false)
  } finally {
    globalThis.fetch = original
  }
})

test('callOpenAICompatible surfaces non-ok responses as errors', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('{"message":"quota"}', { status: 402, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(
      () =>
        callOpenAICompatible(
          { name: 't', baseURL: 'https://example.com/v1', model: 'm' },
          [{ role: 'user', content: [] }],
        ),
      /402/,
    )
  } finally {
    globalThis.fetch = original
  }
})

test('adapterAvailable reports registered adapters only', () => {
  const llm = {
    registration(provider) {
      if (provider === 'nope') throw new Error('NO_ADAPTER')
      return {}
    },
  }
  assert.equal(adapterAvailable(llm, 'openrouter'), true)
  assert.equal(adapterAvailable(llm, 'nope'), false)
})

test('cacheKeyFor covers chains, content, mode and question', () => {
  const base = {
    pairs: [{ provider: 'p', model: 'm' }],
    httpProviders: [{ name: 'ovh', model: 'qwen' }],
    contentIds: ['b', 'a'],
    wantJson: false,
    question: 'q',
  }
  const k1 = cacheKeyFor(base)
  assert.equal(k1, 'p:m,http:ovh/qwen|a,b|text|q')
  assert.equal(cacheKeyFor({ ...base, wantJson: true }), 'p:m,http:ovh/qwen|a,b|json|q')
  assert.equal(cacheKeyFor({ ...base, httpProviders: [] }), 'p:m|a,b|text|q')
  assert.equal(cacheKeyFor({ ...base, contentIds: ['b'] }), 'p:m,http:ovh/qwen|b|text|q')
})

test('httpProvidersOf falls back to the built-in default unless disabled', () => {
  assert.equal(httpProvidersOf({}), DEFAULT_HTTP_PROVIDERS)
  assert.deepEqual(httpProvidersOf({}, false), [])
  const custom = [{ name: 'x', baseURL: 'https://x/v1', model: 'm' }]
  assert.deepEqual(httpProvidersOf({ httpProviders: custom }), custom)
  assert.deepEqual(httpProvidersOf({ httpProviders: custom }, false), custom)
})

test('reverseRouteTarget rewrites vision-entry text turns back to the text provider', () => {
  const opts = {
    pairs: [{ provider: 'openrouter', model: 'qwen-vl' }],
    textProvider: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    hasAdapter: (provider) => provider === 'deepseek-official',
  }
  assert.deepEqual(
    reverseRouteTarget({ provider: 'openrouter', model: 'qwen-vl' }, opts),
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  )
  // already on the text provider — untouched
  assert.equal(
    reverseRouteTarget({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, opts),
    undefined,
  )
  // a non-vision provider must never be hijacked
  assert.equal(reverseRouteTarget({ provider: 'some-other', model: 'x' }, opts), undefined)
  // text provider without an adapter — fall through untouched
  assert.equal(
    reverseRouteTarget({ provider: 'openrouter', model: 'qwen-vl' }, {
      ...opts,
      hasAdapter: () => false,
    }),
    undefined,
  )
})

test('switchRoute drops reasoningEffort and keeps the rest', () => {
  assert.deepEqual(
    switchRoute({ provider: 'a', model: 'm', reasoningEffort: 'max', maxTokens: 4096 }, 'b', 'n'),
    { provider: 'b', model: 'n', maxTokens: 4096 },
  )
  assert.deepEqual(switchRoute({ provider: 'a', model: 'm' }, 'b', 'n'), { provider: 'b', model: 'n' })
})

test('reverseRouteTarget keeps wrapper entries native and routes vision entries through the wrapper', () => {
  const base = {
    pairs: [{ provider: 'openrouter', model: 'qwen-vl' }],
    wrapperRoute: 'deepseek-vision',
    wrapperRegistered: true,
    textProvider: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    hasAdapter: () => true,
  }
  // wrapper entry handles text natively (strips images) — no rewrite
  assert.equal(
    reverseRouteTarget({ provider: 'deepseek-vision', model: 'deepseek-v4-pro' }, base),
    undefined,
  )
  // openrouter entry -> text turns go through the wrapper (strips + delegates)
  assert.deepEqual(
    reverseRouteTarget({ provider: 'openrouter', model: 'qwen-vl' }, base),
    { provider: 'deepseek-vision', model: 'deepseek-v4-pro' },
  )
  // wrapper disabled -> fall back to the text provider directly
  assert.deepEqual(
    reverseRouteTarget({ provider: 'openrouter', model: 'qwen-vl' }, {
      ...base,
      wrapperRoute: undefined,
      wrapperRegistered: false,
    }),
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  )
  // non-vision providers are never hijacked
  assert.equal(
    reverseRouteTarget({ provider: 'some-other', model: 'x' }, base),
    undefined,
  )
})

test('stripImageBlocks removes image blocks and leaves the rest', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { attachmentId: 'a' } }] },
    { role: 'user', content: [{ type: 'text', text: 'plain' }] },
  ]
  const out = stripImageBlocks(messages)
  assert.equal(out[0].content.length, 1)
  assert.equal(out[0].content[0].type, 'text')
  assert.equal(out[1], messages[1])
  assert.deepEqual(stripImageBlocks(undefined), [])
})

test('estimateTokens and trimMessagesToBudget fit long conversations', () => {
  const big = (n) => ({
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(n) }],
  })
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    big(3000),
    big(3000),
    big(3000),
    big(3000),
    { role: 'user', content: [{ type: 'text', text: 'last question' }, { type: 'image', attachment: { attachmentId: 'a' } }] },
  ]
  const trimmed = trimMessagesToBudget(messages, 5000)
  assert.equal(trimmed[0].role, 'system')
  assert.equal(trimmed[trimmed.length - 1].content[0].text, 'last question')
  const used = trimmed.reduce((sum, m) => sum + estimateTokens(m), 0)
  assert.ok(used <= 5000, `used ${used} > budget`)
  assert.ok(trimmed.length < messages.length)
})

test('estimateTokens counts image blocks at a fixed cost', () => {
  const withImage = estimateTokens({ content: [{ type: 'image', attachment: {} }] })
  assert.ok(withImage >= 1445)
})

test('estimateMessages sums the array (the call-site bug guard)', () => {
  const messages = [
    { content: [{ type: 'text', text: 'x'.repeat(300) }] },
    { content: [{ type: 'text', text: 'y'.repeat(300) }] },
  ]
  assert.ok(estimateMessages(messages) > 0)
  assert.equal(estimateTokens(messages), 0) // an array alone must not be counted
})
