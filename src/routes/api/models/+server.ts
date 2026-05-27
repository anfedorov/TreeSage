import { json } from '@sveltejs/kit';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '$lib/server/config';
import { providers } from '$lib/server/providers';
import type { ModelsResponse } from '$lib/beam/types';

export async function GET() {
  const ollamaModels = await providers.ollama.listModels();

  const availableModels = ollamaModels.filter((model) => model.available);
  const defaultModel =
    availableModels.find(
      (model) => model.provider === DEFAULT_PROVIDER && model.id === DEFAULT_MODEL
    ) ?? availableModels[0];

  const response: ModelsResponse = {
    defaults: {
      provider: defaultModel?.provider ?? DEFAULT_PROVIDER,
      model: defaultModel?.id ?? DEFAULT_MODEL
    },
    models: ollamaModels
  };

  return json(response);
}
