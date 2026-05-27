import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildBeam } from '$lib/server/beam';
import type { BeamRequest, ProviderId } from '$lib/beam/types';

function isProviderId(value: unknown): value is ProviderId {
  return value === 'fake' || value === 'ollama';
}

export const POST: RequestHandler = async ({ request }) => {
  const payload = (await request.json()) as Partial<BeamRequest>;
  const beamRequest: BeamRequest = {
    provider: isProviderId(payload.provider) ? payload.provider : 'fake',
    model: typeof payload.model === 'string' ? payload.model : 'fake-sage-small',
    text: typeof payload.text === 'string' ? payload.text : '',
    topK: payload.topK === undefined ? undefined : Number(payload.topK),
    depth: Number(payload.depth),
    nodeBudget: Number(payload.nodeBudget)
  };

  const response = await buildBeam(beamRequest);
  return json(response);
};
