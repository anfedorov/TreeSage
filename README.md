# TreeSage

TreeSage is a local-first LLM beam-search typing tutor. This first milestone runs as a SvelteKit full-stack app with a deterministic fake provider and an Ollama provider for local model logprob data.

## Local Development

Install dependencies:

```sh
npm install
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
