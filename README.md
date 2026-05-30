# TreeSage

TreeSage is a local-first LLM beam-search typing tutor. This first milestone runs as a SvelteKit full-stack app with Ollama for local model logprob data.

## Local Development

Install Node dependencies:

```sh
npm install
```

Start Ollama in another terminal if it is not already running:

```sh
ollama serve
```

Download at least the default local model:

```sh
ollama pull llama3.2:3b
```

Useful optional models for comparison:

```sh
ollama pull phi4:14b
ollama pull mistral:latest
ollama pull mistral-small:latest
ollama pull qwen2.5:7b
ollama pull olmo2:latest
```

Run the app:

```sh
npm run dev
```

Open the printed local URL, usually `http://127.0.0.1:5173`.

## Ollama

The app defaults to `http://localhost:11434` for Ollama. Override it with:

```sh
OLLAMA_BASE_URL=http://localhost:11434 npm run dev
```

The fake provider remains available when Ollama is not running.

The Ollama provider uses `/api/generate`, not `/api/chat`, with `raw: true`,
`temperature: 0`, `num_predict: 1`, `logprobs: true`, and `top_logprobs: 20`.

### Logprob Caveat

Ollama logprob availability can depend on the model and prompt length. At high
token counts phi4 and maybe other models sometimes return `200 OK` with an empty `response` and no
`logprobs` field.