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

const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct'

const app = new Hono<{ Bindings: Bindings }>()

function createOpenAIError(message: string, status = 400) {
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
  const isBearer = authHeader?.startsWith('Bearer ')
  const requestToken = isBearer && authHeader ? authHeader.slice(7).trim() : ''

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
    data: [
      {
        id: DEFAULT_MODEL,
        object: 'model',
        created: 0,
        owned_by: 'cloudflare-workers-ai'
      }
    ]
  })
})

app.get('/models', (c) => {
  return c.redirect('/v1/models', 307)
})

app.post('/v1/chat/completions', async (c) => {
  let body: {
    model?: string
    messages?: ChatMessage[]
    stream?: boolean
  }

  try {
    body = await c.req.json()
  } catch {
    const error = createOpenAIError('Invalid JSON body.')
    return c.json(error.body, error.status)
  }

  const model = body.model ?? DEFAULT_MODEL
  const messages = Array.isArray(body.messages) ? body.messages : []

  if (body.stream) {
    const error = createOpenAIError('Streaming is not enabled on this endpoint.')
    return c.json(error.body, error.status)
  }

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
    const result = await c.env.AI.run(model, { messages })
    const content = extractTextFromAiResult(result)
    const created = Math.floor(Date.now() / 1000)
    const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

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
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
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
