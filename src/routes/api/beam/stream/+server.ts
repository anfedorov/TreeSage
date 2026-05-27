import type { RequestHandler } from './$types';
import { streamBeam } from '$lib/server/beam';
import type { BeamRequest, ProviderId } from '$lib/beam/types';

function isProviderId(value: string | null): value is ProviderId {
  return value === 'fake' || value === 'ollama';
}

function beamRequestFromUrl(url: URL): BeamRequest {
  const provider = url.searchParams.get('provider');
  const model = url.searchParams.get('model');
  const text = url.searchParams.get('text');
  const topK = url.searchParams.get('topK');
  const depth = url.searchParams.get('depth');
  const nodeBudget = url.searchParams.get('nodeBudget');

  return {
    provider: isProviderId(provider) ? provider : 'fake',
    model: model ?? 'fake-sage-small',
    text: text ?? '',
    topK: topK === null ? undefined : Number(topK),
    depth: Number(depth),
    nodeBudget: Number(nodeBudget)
  };
}

export const GET: RequestHandler = ({ url, request }) => {
  const encoder = new TextEncoder();
  const beamRequest = beamRequestFromUrl(url);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of streamBeam(beamRequest, request.signal)) {
          if (request.signal.aborted) return;
          controller.enqueue(encoder.encode(`event: ${event.type}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Beam stream failed.';
        controller.enqueue(encoder.encode('event: node-error\n'));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'node-error', message })}\n\n`));
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    }
  });
};
