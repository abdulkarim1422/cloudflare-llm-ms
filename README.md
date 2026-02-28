# Cloudflare Workers AI LLM Worker

This Worker exposes a serverless LLM endpoint using Cloudflare Workers AI.

## Auth token setup (required)

All requests require:

- `Authorization: Bearer <your-token>`

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

- `POST /chat`

Request body (prompt style):

```json
{
	"prompt": "Write a short haiku about edge computing"
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
curl -X POST http://127.0.0.1:8787/chat \
	-H 'authorization: Bearer your-local-token' \
	-H 'content-type: application/json' \
	-d '{"prompt":"Write a short haiku about edge computing"}'
```

## Notes

- Workers AI is bound in `wrangler.jsonc` as `AI`.
- Default model is `@cf/meta/llama-3.1-8b-instruct` if `model` is not provided.
- `AUTH_TOKEN` must be configured, or requests will return `500`.
