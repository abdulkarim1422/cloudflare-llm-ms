import { Hono } from 'hono'

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'developer'
  content: string
}

type AiBinding = {
  run: (model: string, inputs: Record<string, unknown>) => Promise<Record<string, unknown>>
}

type Bindings = {
  AI: AiBinding
  AUTH_TOKEN: string
}

type ChatCompletionsBody = {
  model?: string
  messages?: ChatMessage[]
  stream?: boolean
}

type TextCompletionsBody = {
  model?: string
  prompt?: string | string[]
  stream?: boolean
}

type ResponsesBody = {
  model?: string
  input?: string | Array<{ role?: string; content?: unknown }>
  stream?: boolean
}

const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct'
const SUPPORTED_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.1-70b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.2-1b-instruct',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/openai/gpt-oss-120b',
  '@cf/openai/gpt-oss-20b',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/mistral/mistral-small-3.1-24b-instruct',
  '@cf/google/gemma-3-12b-it',
  '@cf/google/gemma-4-26b-a4b-it'
] as const
type ErrorStatusCode = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500

const app = new Hono<{ Bindings: Bindings }>()

function createChunkPayload(id: string, model: string, content: string | null, finishReason: string | null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: content === null ? {} : { content },
        finish_reason: finishReason
      }
    ]
  }
}

function sseData(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function extractTextCandidates(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : []
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextCandidates(item))
  }

  if (typeof value === 'object' && value !== null) {
    const item = value as Record<string, unknown>
    const keys = ['response', 'text', 'content', 'delta', 'output_text']
    const results = keys.flatMap((key) => extractTextCandidates(item[key]))
    if (results.length > 0) return results
  }

  return []
}

function extractDeltaText(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []

  const obj = value as Record<string, unknown>
  const out: string[] = []

  if (typeof obj.response === 'string' && obj.response.length > 0) {
    out.push(obj.response)
  }

  if (typeof obj.output_text === 'string' && obj.output_text.length > 0) {
    out.push(obj.output_text)
  }

  if (typeof obj.text === 'string' && obj.text.length > 0) {
    out.push(obj.text)
  }

  const delta = obj.delta
  if (typeof delta === 'object' && delta !== null) {
    const deltaObj = delta as Record<string, unknown>
    if (typeof deltaObj.content === 'string' && deltaObj.content.length > 0) {
      out.push(deltaObj.content)
    }
  }

  const choices = obj.choices
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (typeof choice !== 'object' || choice === null) continue
      const choiceObj = choice as Record<string, unknown>
      const choiceDelta = choiceObj.delta
      if (typeof choiceDelta === 'object' && choiceDelta !== null) {
        const choiceDeltaObj = choiceDelta as Record<string, unknown>
        if (typeof choiceDeltaObj.content === 'string' && choiceDeltaObj.content.length > 0) {
          out.push(choiceDeltaObj.content)
        }
      }
      if (typeof choiceObj.text === 'string' && choiceObj.text.length > 0) {
        out.push(choiceObj.text)
      }
    }
  }

  return out
}

async function toOpenAiSseFromAiStream(params: {
  aiStream: ReadableStream
  id: string
  model: string
}): Promise<ReadableStream> {
  const { aiStream, id, model } = params
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = aiStream.getReader()

  return new ReadableStream({
    async start(controller) {
      let buffer = ''

      const emitContent = (text: string) => {
        if (!text) return
        controller.enqueue(encoder.encode(sseData(createChunkPayload(id, model, text, null))))
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          if (typeof value === 'string') {
            emitContent(value)
            continue
          }

          buffer += decoder.decode(value as Uint8Array, { stream: true })
          const parts = buffer.split(/\r?\n\r?\n/)
          buffer = parts.pop() ?? ''

          for (const part of parts) {
            const lines = part
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.startsWith('data:'))

            if (lines.length === 0) {
              const fallbacks = extractTextCandidates(part)
              fallbacks.forEach(emitContent)
              continue
            }

            for (const line of lines) {
              const raw = line.slice(5).trim()
              if (!raw || raw === '[DONE]') continue

              try {
                const parsed = JSON.parse(raw) as unknown
                const texts = extractDeltaText(parsed)
                if (texts.length > 0) {
                  texts.forEach(emitContent)
                }
              } catch {
                emitContent(raw)
              }
            }
          }
        }

        if (buffer.trim()) {
          const texts = extractTextCandidates(buffer)
          if (texts.length > 0) {
            texts.forEach(emitContent)
          }
        }

        controller.enqueue(encoder.encode(sseData(createChunkPayload(id, model, null, 'stop'))))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    }
  })
}

function createOpenAIError(message: string, status: ErrorStatusCode = 400) {
  return {
    status,
    body: {
      error: {
        message,
        type: 'invalid_request_error',
        param: null,
        code: null
      }
    }
  }
}

function normalizeAuthToken(authHeader: string | undefined, apiKeyHeader: string | undefined): string {
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }
  return apiKeyHeader?.trim() ?? ''
}

function resolveModelId(rawModel: string | undefined): string {
  const model = rawModel?.trim()
  if (!model) return DEFAULT_MODEL

  // Continue and some OpenAI-compatible clients can send placeholder model ids.
  if (model === 'local-model' || model === 'default') return DEFAULT_MODEL

  if (SUPPORTED_MODELS.includes(model as (typeof SUPPORTED_MODELS)[number])) {
    return model
  }

  if (model.startsWith('cf/')) {
    const withAt = `@${model}`
    if (SUPPORTED_MODELS.includes(withAt as (typeof SUPPORTED_MODELS)[number])) return withAt
  }

  if (model.startsWith('@cf/')) {
    return model
  }

  return model
}

function toArrayPrompt(prompt: string | string[] | undefined): string {
  if (typeof prompt === 'string') return prompt
  if (Array.isArray(prompt)) {
    return prompt.filter((part) => typeof part === 'string').join('\n')
  }
  return ''
}

function toMessagesFromResponsesInput(input: ResponsesBody['input']): ChatMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }

  if (!Array.isArray(input)) return []

  const normalized: ChatMessage[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const role = item.role
    const content = item.content
    if (
      (role === 'system' || role === 'user' || role === 'assistant' || role === 'developer') &&
      typeof content === 'string' &&
      content.trim()
    ) {
      normalized.push({ role, content })
      continue
    }

    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === 'string') return part
          if (typeof part === 'object' && part !== null) {
            const candidate = (part as Record<string, unknown>).text
            if (typeof candidate === 'string') return candidate
          }
          return ''
        })
        .join('\n')
        .trim()
      if (
        (role === 'system' || role === 'user' || role === 'assistant' || role === 'developer') &&
        text
      ) {
        normalized.push({ role, content: text })
      }
    }
  }

  return normalized
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function getUsageFromObject(source: Record<string, unknown>) {
  const promptTokens =
    toNumber(source.prompt_tokens) ??
    toNumber(source.input_tokens) ??
    toNumber(source.promptTokens) ??
    toNumber(source.inputTokens)

  const completionTokens =
    toNumber(source.completion_tokens) ??
    toNumber(source.output_tokens) ??
    toNumber(source.completionTokens) ??
    toNumber(source.outputTokens)

  const totalTokens =
    toNumber(source.total_tokens) ??
    toNumber(source.totalTokens) ??
    (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null)

  const hasAny = promptTokens !== null || completionTokens !== null || totalTokens !== null
  if (!hasAny) return null

  return {
    prompt_tokens: promptTokens ?? 0,
    completion_tokens: completionTokens ?? 0,
    total_tokens:
      totalTokens ??
      (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : 0)
  }
}

function extractUsageFromAiResult(result: Record<string, unknown>) {
  const direct = getUsageFromObject(result)
  if (direct) return direct

  const directUsage = result.usage
  if (typeof directUsage === 'object' && directUsage !== null) {
    const usage = getUsageFromObject(directUsage as Record<string, unknown>)
    if (usage) return usage
  }

  const nested = result.result
  if (typeof nested === 'object' && nested !== null) {
    const nestedObject = nested as Record<string, unknown>
    const nestedDirect = getUsageFromObject(nestedObject)
    if (nestedDirect) return nestedDirect

    const nestedUsage = nestedObject.usage
    if (typeof nestedUsage === 'object' && nestedUsage !== null) {
      const usage = getUsageFromObject(nestedUsage as Record<string, unknown>)
      if (usage) return usage
    }
  }

  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  }
}

function extractTextFromAiResult(result: Record<string, unknown>): string {
  if (typeof result.response === 'string') return result.response

  const resultContainer = result.result
  if (typeof resultContainer === 'object' && resultContainer !== null) {
    const nested = resultContainer as Record<string, unknown>
    if (typeof nested.response === 'string') return nested.response
    if (typeof nested.output_text === 'string') return nested.output_text
  }

  const output = result.output
  if (Array.isArray(output)) {
    const text = output
      .map((item) => {
        if (typeof item === 'string') return item
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>
          if (typeof obj.text === 'string') return obj.text
        }
        return ''
      })
      .join('')
      .trim()

    if (text) return text
  }

  return JSON.stringify(result)
}

app.use('*', async (c, next) => {
  const configuredToken = c.env.AUTH_TOKEN

  if (!configuredToken) {
    return c.json({ error: 'Server is missing AUTH_TOKEN configuration.' }, 500)
  }

  const authHeader = c.req.header('Authorization')
  const requestToken = normalizeAuthToken(
    authHeader,
    c.req.header('x-api-key') ?? c.req.header('api-key')
  )

  if (!requestToken || requestToken !== configuredToken) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
})

app.get('/', (c) => {
  return c.json({
    name: 'cloudflare-llm-ms',
    status: 'ok',
    endpoints: {
      models: 'GET /v1/models',
      chatCompletions: 'POST /v1/chat/completions'
    }
  })
})

app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: SUPPORTED_MODELS.map((modelId) => ({
      id: modelId,
      object: 'model',
      created: 0,
      owned_by: 'cloudflare-workers-ai'
    }))
  })
})

app.get('/models', (c) => {
  return c.redirect('/v1/models', 307)
})

app.post('/v1/chat/completions', async (c) => {
  let body: ChatCompletionsBody

  try {
    body = await c.req.json()
  } catch {
    const error = createOpenAIError('Invalid JSON body.')
    return c.json(error.body, error.status)
  }

  const model = resolveModelId(body.model)
  const messages = Array.isArray(body.messages) ? body.messages : []
  const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  if (messages.length === 0) {
    const error = createOpenAIError('`messages` must be a non-empty array.')
    return c.json(error.body, error.status)
  }

  const hasInvalidMessage = messages.some(
    (message) => typeof message?.content !== 'string' || !message.content.trim() || !message.role
  )

  if (hasInvalidMessage) {
    const error = createOpenAIError('Each message must include string `role` and non-empty string `content`.')
    return c.json(error.body, error.status)
  }

  try {
    if (body.stream) {
      const streamedResult = await c.env.AI.run(model, { messages, stream: true })

      let aiStream: ReadableStream | null = null
      if (streamedResult instanceof ReadableStream) {
        aiStream = streamedResult
      } else if (
        typeof streamedResult === 'object' &&
        streamedResult !== null &&
        (streamedResult as Record<string, unknown>).response instanceof ReadableStream
      ) {
        aiStream = (streamedResult as { response: ReadableStream }).response
      }

      if (!aiStream) {
        const fallbackText = extractTextFromAiResult(streamedResult)
        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sseData(createChunkPayload(requestId, model, fallbackText, null))))
            controller.enqueue(encoder.encode(sseData(createChunkPayload(requestId, model, null, 'stop'))))
            controller.enqueue(encoder.encode('data: [DONE]\\n\\n'))
            controller.close()
          }
        })

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive'
          }
        })
      }

      const openAiStream = await toOpenAiSseFromAiStream({ aiStream, id: requestId, model })
      return new Response(openAiStream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive'
        }
      })
    }

    const result = await c.env.AI.run(model, { messages })
    const content = extractTextFromAiResult(result)
    const usage = extractUsageFromAiResult(result)
    const created = Math.floor(Date.now() / 1000)

    return c.json({
      id: requestId,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }
      ],
      usage
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workers AI call failed.'
    return c.json(
      {
        error: {
          message,
          type: 'server_error',
          param: null,
          code: null
        }
      },
      500
    )
  }
})

app.post('/v1/completions', async (c) => {
  let body: TextCompletionsBody

  try {
    body = await c.req.json()
  } catch {
    const error = createOpenAIError('Invalid JSON body.')
    return c.json(error.body, error.status)
  }

  const prompt = toArrayPrompt(body.prompt).trim()
  if (!prompt) {
    const error = createOpenAIError('`prompt` must be a non-empty string or string array.')
    return c.json(error.body, error.status)
  }

  const model = resolveModelId(body.model)
  const requestId = `cmpl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  try {
    const result = await c.env.AI.run(model, {
      messages: [{ role: 'user', content: prompt }]
    })
    const text = extractTextFromAiResult(result)
    const usage = extractUsageFromAiResult(result)

    return c.json({
      id: requestId,
      object: 'text_completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          text,
          index: 0,
          finish_reason: 'stop'
        }
      ],
      usage
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workers AI call failed.'
    return c.json(
      {
        error: {
          message,
          type: 'server_error',
          param: null,
          code: null
        }
      },
      500
    )
  }
})

app.post('/v1/responses', async (c) => {
  let body: ResponsesBody

  try {
    body = await c.req.json()
  } catch {
    const error = createOpenAIError('Invalid JSON body.')
    return c.json(error.body, error.status)
  }

  const model = resolveModelId(body.model)
  const messages = toMessagesFromResponsesInput(body.input)
  if (messages.length === 0) {
    const error = createOpenAIError('`input` must include at least one text message.')
    return c.json(error.body, error.status)
  }

  const responseId = `resp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  try {
    const result = await c.env.AI.run(model, { messages })
    const text = extractTextFromAiResult(result)
    const usage = extractUsageFromAiResult(result)

    return c.json({
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model,
      output: [
        {
          id: `msg-${Math.random().toString(36).slice(2, 10)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }]
        }
      ],
      output_text: text,
      usage: {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workers AI call failed.'
    return c.json(
      {
        error: {
          message,
          type: 'server_error',
          param: null,
          code: null
        }
      },
      500
    )
  }
})

app.post('/chat', (c) => c.redirect('/v1/chat/completions', 307))
app.post('/chat/completions', (c) => c.redirect('/v1/chat/completions', 307))

export default app
