import type { ModelOption, TokenAlternative } from '$lib/beam/types';
import type { BeamProvider } from './types';

const FAKE_MODELS: ModelOption[] = [
  {
    provider: 'fake',
    id: 'fake-sage-small',
    label: 'Fake Sage Small',
    available: true
  },
  {
    provider: 'fake',
    id: 'fake-sage-poetic',
    label: 'Fake Sage Poetic',
    available: true
  }
];

const TOKEN_BANKS = {
  'fake-sage-small': [
    ' the',
    ' a',
    ' model',
    ' token',
    ' tree',
    ' learns',
    ' predicts',
    ' because',
    ' then',
    ' with',
    ' from',
    ' through'
  ],
  'fake-sage-poetic': [
    ' light',
    ' branch',
    ' whisper',
    ' river',
    ' hidden',
    ' pattern',
    ' turning',
    ' still',
    ' bright',
    ' beyond',
    ' under',
    ' seed'
  ]
} satisfies Record<string, string[]>;

function hashText(text: string): number {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

export const fakeProvider: BeamProvider = {
  async listModels() {
    return FAKE_MODELS;
  },

  async nextTokens({ model, text, topK }): Promise<TokenAlternative[]> {
    const bank = TOKEN_BANKS[model as keyof typeof TOKEN_BANKS] ?? TOKEN_BANKS['fake-sage-small'];
    const start = hashText(`${model}:${text}`) % bank.length;

    return Array.from({ length: Math.min(topK, bank.length) }, (_, index) => {
      const token = bank[(start + index) % bank.length];
      const logprob = -0.25 - index * 0.48;

      return {
        text: token,
        logprob
      };
    });
  }
};
