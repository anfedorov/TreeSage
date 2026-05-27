import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { NextTokenRequest, ProviderId } from '$lib/beam/types';
import { MODEL_TOP_K } from '$lib/server/config';
import { providers } from '$lib/server/providers';

function isProviderId(value: unknown): value is ProviderId {
  return value === 'fake' || value === 'ollama';
}

function clampTopK(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MODEL_TOP_K;
  return Math.min(MODEL_TOP_K, Math.max(1, Math.floor(parsed)));
}

function probability(logprob: number): number {
  if (!Number.isFinite(logprob)) return 0;
  return Math.exp(logprob);
}

export const POST: RequestHandler = async ({ request }) => {
  const payload = (await request.json()) as Partial<NextTokenRequest>;
  const providerId = isProviderId(payload.provider) ? payload.provider : 'fake';
  const provider = providers[providerId] ?? providers.fake;
  const topK = clampTopK(payload.topK);
  const alternatives = await provider.nextTokens({
    model: typeof payload.model === 'string' ? payload.model : 'fake-sage-small',
    text: typeof payload.text === 'string' ? payload.text : '',
    topK,
    signal: request.signal
  });

  return json({
    alternatives: alternatives.slice(0, topK).map((alternative, index) => ({
      ...alternative,
      rank: index + 1,
      prob: probability(alternative.logprob)
    }))
  });
};
