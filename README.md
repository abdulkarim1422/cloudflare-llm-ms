# Cloudflare Workers AI LLM Worker

This Worker exposes an OpenAI-compatible API on Cloudflare Workers AI, so it can be used directly from AnythingLLM Desktop and Continue.

## Auth token setup (required)

All requests require:

- `Authorization: Bearer <your-token>`
- `x-api-key: <your-token>` (also supported for OpenAI-compatible clients)

Set token in environment variable `AUTH_TOKEN`.

### Local development

Create `.dev.vars` in project root:

```txt
AUTH_TOKEN=your-local-token
```

### Production (Cloudflare)

Set as Worker secret:

```txt
npx wrangler secret put AUTH_TOKEN
```

## Run locally

```txt
npm install
npm run dev
```

## Deploy

```txt
npm run deploy
```

## Endpoint

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `GET /api/tags` (Ollama-compatible)
- `POST /api/chat` (Ollama-compatible)
- `POST /api/generate` (Ollama-compatible)

Legacy aliases (also supported):

- `POST /chat`
- `POST /chat/completions`

## AnythingLLM Desktop setup

In AnythingLLM Desktop, use the OpenAI-compatible provider and configure:

- **Base URL**: `https://<your-worker-subdomain>.workers.dev/v1`
- **API Key**: your `AUTH_TOKEN` value
- **Model**: `@cf/meta/llama-3.1-8b-instruct`

AnythingLLM will call `/models` and `/chat/completions` under this base URL.

The Worker now advertises multiple Workers AI chat models via `/v1/models` (for example `@cf/meta/llama-3.1-70b-instruct`, `@cf/openai/gpt-oss-20b`, `@cf/qwen/qwen3-30b-a3b-fp8`, etc.).

## Continue setup

Continue can use this Worker via an OpenAI-compatible model/provider config.

Use:

- **Base URL**: `https://<your-worker-subdomain>.workers.dev/v1`
- **API Key**: your `AUTH_TOKEN` value
- **Model**: one of `GET /v1/models` (for example `@cf/meta/llama-3.1-8b-instruct`)

Compatibility notes for Continue/OpenAI-style clients:

- Auth headers supported: `Authorization: Bearer ...`, `x-api-key`, `api-key`
- Request APIs supported: Chat Completions (`/v1/chat/completions`), Completions (`/v1/completions`), Responses (`/v1/responses`)

## GitHub Copilot (custom OpenAI endpoint)

When using a Copilot-compatible custom provider/openai endpoint setup, use:

- **Base URL**: `https://<your-worker-subdomain>.workers.dev/v1`
- **API Key / Token**: your `AUTH_TOKEN`
- **Model**: a Workers AI model id (for example `@cf/google/gemma-4-26b-a4b-it`)

Supported auth headers include `Authorization: Bearer ...`, `x-api-key`, and `api-key`.

## Ollama-compatible local configuration

This worker now exposes Ollama-style APIs so Ollama-compatible clients can use it:

- `GET /api/tags`
- `POST /api/chat`
- `POST /api/generate`

Use:

- **Base URL**: `https://<your-worker-subdomain>.workers.dev`
- **Model**: Workers AI model id (e.g. `@cf/meta/llama-3.1-8b-instruct`, `@cf/google/gemma-4-26b-a4b-it`, or newer models)
- **Auth**: send your token via `Authorization: Bearer <AUTH_TOKEN>` (or `x-api-key`)

Request body (prompt style):

```json
{
  "model": "@cf/meta/llama-3.1-8b-instruct",
  "messages": [{ "role": "user", "content": "Write a short haiku about edge computing" }]
}
```

Request body (full messages style):

```json
{
  "model": "@cf/meta/llama-3.1-8b-instruct",
  "messages": [
    { "role": "system", "content": "You are concise." },
    { "role": "user", "content": "Explain Workers AI in one sentence." }
  ]
}
```

Example curl:

```txt
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'authorization: Bearer your-local-token' \
  -H 'content-type: application/json' \
  -d '{"model":"@cf/meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"Write a short haiku about edge computing"}]}'
```

Example streaming curl (`stream: true`):

```txt
curl -N -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'authorization: Bearer your-local-token' \
  -H 'content-type: application/json' \
  -d '{"model":"@cf/meta/llama-3.1-8b-instruct","stream":true,"messages":[{"role":"user","content":"Write a short haiku about edge computing"}]}'
```

## Notes

- Workers AI is bound in `wrangler.jsonc` as `AI`.
- Default model is `@cf/meta/llama-3.1-8b-instruct` if `model` is not provided.
- `AUTH_TOKEN` must be configured, or requests will return `500`.
- `stream: true` is supported with OpenAI-style SSE chunks.
