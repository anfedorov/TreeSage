import type {
  BeamEvent,
  BeamNode,
  BeamRequest,
  BeamResponse,
  TokenAlternative
} from '$lib/beam/types';
import {
  DEFAULT_DEPTH,
  DEFAULT_NODE_BUDGET,
  DEFAULT_TOP_K,
  MAX_DEPTH,
  MAX_NODE_BUDGET,
  MAX_TOP_K,
  MODEL_TOP_K
} from '$lib/server/config';
import { providers } from '$lib/server/providers';

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function probability(logprob: number): number {
  if (!Number.isFinite(logprob)) return 0;
  return Math.exp(logprob);
}

function nodeId(parentId: string, depth: number, rank: number, token: string): string {
  const encoded =
    Array.from(token)
      .map((char) => char.charCodeAt(0).toString(36))
      .join('')
      .slice(0, 16) || 'empty';
  return `${parentId}-${depth}-${rank}-${encoded}`;
}

function createChildNode(
  parent: BeamNode,
  alternative: TokenAlternative,
  rank: number
): BeamNode {
  return {
    id: nodeId(parent.id, parent.depth + 1, rank, alternative.text),
    parentId: parent.id,
    depth: parent.depth + 1,
    text: alternative.text,
    rank,
    logprob: alternative.logprob,
    prob: probability(alternative.logprob),
    cumulativeLogprob: parent.cumulativeLogprob + alternative.logprob,
    children: [],
    status: 'leaf'
  };
}

function textForPath(nodesById: Map<string, BeamNode>, node: BeamNode, rootText: string): string {
  const pieces: string[] = [];
  let cursor: BeamNode | undefined = node;

  while (cursor && cursor.parentId) {
    pieces.push(cursor.text);
    cursor = nodesById.get(cursor.parentId);
  }

  return `${rootText}${pieces.reverse().join('')}`;
}

export async function* streamBeam(
  request: BeamRequest,
  signal?: AbortSignal
): AsyncGenerator<BeamEvent> {
  const provider = providers[request.provider] ?? providers.fake;
  const topK = clampInteger(request.topK, DEFAULT_TOP_K, 1, MAX_TOP_K);
  const modelTopK = Math.max(topK, MODEL_TOP_K);
  const depth = clampInteger(request.depth, DEFAULT_DEPTH, 1, MAX_DEPTH);
  const nodeBudget = clampInteger(request.nodeBudget, DEFAULT_NODE_BUDGET, 2, MAX_NODE_BUDGET);
  const rootText = request.text ?? '';
  const root: BeamNode = {
    id: 'root',
    parentId: null,
    depth: 0,
    text: rootText,
    rank: 0,
    logprob: 0,
    prob: 1,
    cumulativeLogprob: 0,
    children: [],
    status: 'leaf'
  };

  const nodes: BeamNode[] = [root];
  const nodesById = new Map<string, BeamNode>([[root.id, root]]);
  const alternativesByParentId = new Map<string, TokenAlternative[]>();
  const emittedAlternatives = new Set<string>();
  const addedChildKeys = new Set<string>();
  let nodeCount = 1;
  let providerStatus: string | undefined;

  yield {
    type: 'reset',
    rootId: root.id,
    node: structuredClone(root)
  };

  async function getAlternatives(parent: BeamNode): Promise<TokenAlternative[]> {
    if (signal?.aborted) return [];

    const cached = alternativesByParentId.get(parent.id);
    if (cached) return cached;

    const prompt = textForPath(nodesById, parent, rootText);
    const alternatives = (
      await provider.nextTokens({
        model: request.model,
        text: prompt,
        topK: modelTopK,
        signal
      })
    ).slice(0, modelTopK);
    alternativesByParentId.set(parent.id, alternatives);
    return alternatives;
  }

  function addChild(parent: BeamNode, alternative: TokenAlternative, rank: number): BeamNode {
    const child = createChildNode(parent, alternative, rank);
    const childKey = `${parent.id}:${rank}`;
    addedChildKeys.add(childKey);
    nodesById.set(child.id, child);
    nodes.push(child);
    nodeCount += 1;

    parent.children = [...parent.children, child.id].sort((leftId, rightId) => {
      const left = nodesById.get(leftId);
      const right = nodesById.get(rightId);
      return (left?.rank ?? 0) - (right?.rank ?? 0);
    });
    parent.status = 'expanded';
    return child;
  }

  function alternativesEvent(parent: BeamNode, alternatives: TokenAlternative[]): BeamEvent | undefined {
    if (emittedAlternatives.has(parent.id)) return undefined;
    emittedAlternatives.add(parent.id);

    return {
      type: 'alternatives',
      parentId: parent.id,
      alternatives: alternatives.map((alternative, index) => ({
        ...alternative,
        rank: index + 1,
        prob: probability(alternative.logprob)
      }))
    };
  }

  function nextHiddenAlternative(parent: BeamNode): { alternative: TokenAlternative; rank: number } | undefined {
    const alternatives = alternativesByParentId.get(parent.id);
    if (!alternatives) return undefined;

    const nextIndex = alternatives.findIndex((_, index) => !addedChildKeys.has(`${parent.id}:${index + 1}`));
    if (nextIndex < 0) return undefined;

    return {
      alternative: alternatives[nextIndex],
      rank: nextIndex + 1
    };
  }

  function visibleChildProbSum(parent: BeamNode): number {
    return parent.children.reduce((sum, childId) => sum + (nodesById.get(childId)?.prob ?? 0), 0);
  }

  function hiddenMass(parent: BeamNode): number {
    return Math.max(0, 1 - visibleChildProbSum(parent));
  }

  function parentWithMostHiddenMass(): BeamNode | undefined {
    let best: BeamNode | undefined;
    let bestHiddenMass = -Infinity;

    for (const parentId of alternativesByParentId.keys()) {
      const parent = nodesById.get(parentId);
      if (!parent || parent.parentId === null || parent.depth >= depth || !nextHiddenAlternative(parent)) continue;

      const candidateHiddenMass = hiddenMass(parent);
      if (candidateHiddenMass > bestHiddenMass) {
        best = parent;
        bestHiddenMass = candidateHiddenMass;
      }
    }

    return best;
  }

  async function* extendGreedyPath(start: BeamNode): AsyncGenerator<BeamEvent> {
    let cursor: BeamNode | undefined = start;

    while (cursor && cursor.depth < depth && nodeCount < nodeBudget) {
      if (signal?.aborted) return;

      const alternatives = await getAlternatives(cursor);
      if (signal?.aborted) return;
      if (alternatives.length === 0) return;

      const alternativesPayload = alternativesEvent(cursor, alternatives);
      if (alternativesPayload) yield alternativesPayload;

      const childKey = `${cursor.id}:1`;
      if (addedChildKeys.has(childKey)) return;

      const child = addChild(cursor, alternatives[0], 1);

      yield {
        type: 'parent',
        node: structuredClone(cursor)
      };
      yield {
        type: 'node',
        node: structuredClone(child)
      };

      cursor = child;
    }
  }

  try {
    yield* extendGreedyPath(root);
  } catch (error) {
    root.status = 'error';
    providerStatus = error instanceof Error ? error.message : 'Provider failed.';
    yield {
      type: 'node-error',
      node: structuredClone(root),
      message: providerStatus
    };
  }

  while (nodeCount < nodeBudget) {
    if (signal?.aborted) return;

    const parent = parentWithMostHiddenMass();
    if (!parent) break;

    const next = nextHiddenAlternative(parent);
    if (!next) break;

    try {
      const childKey = `${parent.id}:${next.rank}`;
      if (addedChildKeys.has(childKey)) continue;

      const child = addChild(parent, next.alternative, next.rank);
      yield {
        type: 'parent',
        node: structuredClone(parent)
      };
      yield {
        type: 'node',
        node: structuredClone(child)
      };

      yield* extendGreedyPath(child);
    } catch (error) {
      parent.status = 'error';
      providerStatus = error instanceof Error ? error.message : 'Provider failed.';
      yield {
        type: 'node-error',
        node: structuredClone(parent),
        message: providerStatus
      };
    }
  }

  yield {
    type: 'done',
    providerStatus
  };
}

export async function buildBeam(request: BeamRequest): Promise<BeamResponse> {
  let rootId = 'root';
  const nodes: BeamNode[] = [];
  const nodesById = new Map<string, BeamNode>();
  let providerStatus: string | undefined;

  for await (const event of streamBeam(request)) {
    if (event.type === 'reset') {
      rootId = event.rootId;
      nodes.length = 0;
      nodes.push(event.node);
      nodesById.set(event.node.id, event.node);
    }

    if (event.type === 'parent' || event.type === 'node' || event.type === 'node-error') {
      const existingIndex = nodes.findIndex((node) => node.id === event.node.id);
      if (existingIndex >= 0) {
        nodes[existingIndex] = event.node;
      } else {
        nodes.push(event.node);
      }
      nodesById.set(event.node.id, event.node);
    }

    if (event.type === 'done') {
      providerStatus = event.providerStatus;
    }
  }

  return {
    rootId,
    nodes,
    providerStatus
  };
}
