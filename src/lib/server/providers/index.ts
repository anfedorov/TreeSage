import type { ProviderId } from '$lib/beam/types';
import { fakeProvider } from './fake';
import { ollamaProvider } from './ollama';
import type { BeamProvider } from './types';

export const providers: Record<ProviderId, BeamProvider> = {
  fake: fakeProvider,
  ollama: ollamaProvider
};
