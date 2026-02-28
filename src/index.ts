import { Hono } from 'hono'

type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
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
      chat: 'POST /chat'
    }
  })
})

app.post('/chat', async (c) => {
  let body: {
    prompt?: string
    system?: string
    model?: string
    messages?: ChatMessage[]
  }

  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400)
  }

  const model = body.model ?? DEFAULT_MODEL
  const hasMessages = Array.isArray(body.messages) && body.messages.length > 0

  const messages: ChatMessage[] = hasMessages
    ? body.messages!
    : [
        ...(body.system ? [{ role: 'system' as const, content: body.system }] : []),
        ...(body.prompt ? [{ role: 'user' as const, content: body.prompt }] : [])
      ]

  if (messages.length === 0) {
    return c.json({ error: 'Provide `prompt` or non-empty `messages`.' }, 400)
  }

  try {
    const result = await c.env.AI.run(model, { messages })
    return c.json({ model, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workers AI call failed.'
    return c.json({ error: message }, 500)
  }
})

export default app
