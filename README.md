# TreeSage

TreeSage is a local-first LLM beam-search typing tutor. This first milestone runs as a SvelteKit full-stack app with Ollama for local model logprob data.

## Goal

TreeSage's goal is to remove implicit stochasticity from the way we interact
with LLMs. Instead of sampling one completion and treating it as "the" answer,
TreeSage lets a user traverse the next-token selection tree directly. The
interface is designed to make those branches intuitive to explore while exposing
the language semantics encoded in the model's weights.

## Model Examples

The same prompt can reveal very different next-token landscapes across local
models.

| llama3.2:3b | qwen2.5:7b |
| --- | --- |
| <img src="docs/images/llama.png" alt="TreeSage next-token tree for llama3.2:3b" width="420"> | <img src="docs/images/qwen.png" alt="TreeSage next-token tree for qwen2.5:7b" width="420"> |

| deepseek-r1:latest | mistral:latest |
| --- | --- |
| <img src="docs/images/deepseek.png" alt="TreeSage next-token tree for deepseek-r1:latest" width="420"> | <img src="docs/images/mistral.png" alt="TreeSage next-token tree for mistral:latest" width="420"> |

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

Ollama can struggle to return logprobs for long prompts with `phi4` and some
other models.
