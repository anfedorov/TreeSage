import { OLLAMA_BASE_URL } from '$lib/server/config';
import type { ModelOption, TokenAlternative } from '$lib/beam/types';
import type { BeamProvider } from './types';

type OllamaTagsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
};

type OllamaGenerateResponse = {
  response?: string;
  logprobs?: Array<{
    token?: string;
    logprob?: number;
    top_logprobs?: Array<{
      token?: string;
      logprob?: number;
    }>;
  }>;
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function normalizeToken(token: string): string {
  return token.replace(/^Ġ/, ' ').replace(/^▁/, ' ');
}

function isSupportedModel(id: string): boolean {
  return !id.toLowerCase().startsWith('gemma4');
}

function isControlToken(token: string): boolean {
  const trimmed = token.trim();
  return /^<\|[^|]+(?:\|>|$)/.test(trimmed) || /^<[^>\s]+(?:>|$)/.test(trimmed);
}

function firstPromptWord(text: string): string | undefined {
  return text.trimStart().match(/^[\p{L}\p{N}'-]+/u)?.[0].toLowerCase();
}

function isLikelyPromptReplay(model: string, text: string, alternatives: TokenAlternative[]): boolean {
  if (!model.toLowerCase().startsWith('gemma4')) return false;

  const firstWord = firstPromptWord(text);
  if (!firstWord || alternatives.length === 0) return false;

  return alternatives.every((alternative) => {
    const candidate = alternative.text.trim().toLowerCase();
    return candidate === firstWord || firstWord.startsWith(candidate);
  });
}

function fallbackToken(payload: OllamaGenerateResponse): TokenAlternative[] {
  const firstLogprob = payload.logprobs?.[0];
  const text = firstLogprob?.token ?? payload.response;
  if (!text) return [];

  return [
    {
      text: normalizeToken(text),
      logprob: firstLogprob?.logprob ?? 0
    }
  ];
}

export const ollamaProvider: BeamProvider = {
  async listModels(): Promise<ModelOption[]> {
    try {
      const response = await fetch(joinUrl(OLLAMA_BASE_URL, '/api/tags'));
      if (!response.ok) {
        return [
          {
            provider: 'ollama',
            id: 'ollama-unavailable',
            label: 'Ollama unavailable',
            available: false,
            status: `Ollama returned ${response.status}`
          }
        ];
      }

      const payload = (await response.json()) as OllamaTagsResponse;
      const models = payload.models ?? [];

      if (models.length === 0) {
        return [
          {
            provider: 'ollama',
            id: 'ollama-empty',
            label: 'No Ollama models found',
            available: false,
            status: 'Run `ollama pull <model>` to add one.'
          }
        ];
      }

      return models
        .map((model) => model.name ?? model.model ?? 'unknown')
        .filter(isSupportedModel)
        .map((id) => ({
          provider: 'ollama',
          id,
          label: id,
          available: true
        }));
    } catch (error) {
      return [
        {
          provider: 'ollama',
          id: 'ollama-unavailable',
          label: 'Ollama unavailable',
          available: false,
          status: error instanceof Error ? error.message : 'Could not reach Ollama.'
        }
      ];
    }
  },

  async nextTokens({ model, text, topK, signal }): Promise<TokenAlternative[]> {
    const response = await fetch(joinUrl(OLLAMA_BASE_URL, '/api/generate'), {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        prompt: text,
        stream: false,
        raw: true,
        logprobs: true,
        top_logprobs: topK,
        options: {
          temperature: 0,
          num_predict: 1
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama generate failed with ${response.status}`);
    }

    const payload = (await response.json()) as OllamaGenerateResponse;
    const firstTopLogprobs = payload.logprobs?.[0]?.top_logprobs;
    if (!firstTopLogprobs) return fallbackToken(payload);

    const alternatives = firstTopLogprobs
      .filter(
        (token): token is { token: string; logprob: number } =>
          typeof token.token === 'string' &&
          typeof token.logprob === 'number' &&
          !isControlToken(token.token)
      )
      .sort((left, right) => right.logprob - left.logprob)
      .slice(0, topK)
      .map((token) => ({
        text: normalizeToken(token.token),
        logprob: token.logprob
      }));

    if (isLikelyPromptReplay(model, text, alternatives)) {
      throw new Error(
        `${model} is returning prompt-replay tokens through Ollama generate logprobs, not next-token continuations for this prompt.`
      );
    }

    return alternatives;
  }
};
