import type { ModelOption, TokenAlternative } from '$lib/beam/types';

export type BeamProvider = {
  listModels(): Promise<ModelOption[]>;
  nextTokens(input: {
    model: string;
    text: string;
    topK: number;
    signal?: AbortSignal;
  }): Promise<TokenAlternative[]>;
};
