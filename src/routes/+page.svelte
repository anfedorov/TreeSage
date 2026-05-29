<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type {
    BeamNode,
    BeamResponse,
    BeamTokenAlternative,
    ModelsResponse,
    ModelOption,
    NextTokenResponse,
    ProviderId
  } from '$lib/beam/types';

  type EdgePath = {
    id: string;
    d: string;
    parentId: string;
    childId?: string;
    highlightOnly?: boolean;
  };

  type TokenRect = {
    left: number;
    right: number;
    centerY: number;
    top: number;
    bottom: number;
  };

  let text = $state('The model');
  let visibleDepth = $state(12);
  let generatedDepth = $state(20);
  let selectedProvider = $state<ProviderId>('fake');
  let selectedModel = $state('fake-sage-small');
  let models = $state<ModelOption[]>([]);
  let beam = $state<BeamResponse | null>(null);
  let loadingModels = $state(true);
  let statusMessage = $state('');
  let hoveredNodeId = $state<string | null>(null);
  let alternativePopoverNodeId = $state<string | null>(null);
  let alternativePopoverX = $state(0);
  let alternativePopoverY = $state(0);
  let hoveredAlternativeRank = $state<number | null>(null);
  let alternativesByParentId = $state(new Map<string, BeamTokenAlternative[]>());
  let debugScrollMode = $state(false);
  let renderTerminalNodeIds = $state(new Set<string>());
  let edgePaths = $state<EdgePath[]>([]);
  let edgeLayerWidth = $state(0);
  let edgeLayerHeight = $state(0);
  let treeFrameElement = $state<HTMLElement>();
  let beamListElement = $state<HTMLElement>();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let renderPruneTimer: ReturnType<typeof setTimeout> | undefined;
  let edgeMeasureFrame: number | undefined;
  let alternativePopoverShowTimer: ReturnType<typeof setTimeout> | undefined;
  let alternativePopoverHideTimer: ReturnType<typeof setTimeout> | undefined;
  let explorationController: AbortController | undefined;
  let explorationRunning = false;
  let explorationQueued = false;
  let fittingDepth = false;

  const modelTopK = 20;
  const maxClientNodes = 2000;
  const alternativePopoverPadding = 8;
  const alternativePopoverBorder = 1;
  const alternativePopoverRowPitch = 41;
  const nextTokenGap = 4;
  const minimumVisibleNextTokenWidth = 1;
  const treeRowPitch = 41;
  const maxGeneratedDepth = 96;
  const edgeCornerRadius = 2;

  const availableModels = $derived(models.filter((model) => model.available));
  const currentNodes = $derived(beam?.nodes ?? []);
  const nodesById = $derived(new Map(currentNodes.map((node) => [node.id, node])));
  const rootNode = $derived(beam ? nodesById.get(beam.rootId) : undefined);
  const highlightedNodeIds = $derived(
    new Set(
      hoveredNodeId
        ? pathToNode(hoveredNodeId).map((node) => node.id)
        : alternativePopoverNodeId
          ? pathToNode(alternativePopoverNodeId)
              .slice(0, -1)
              .map((node) => node.id)
          : []
    )
  );
  const alternativePopoverNode = $derived(
    alternativePopoverNodeId ? nodesById.get(alternativePopoverNodeId) : undefined
  );
  const alternativePopoverAlternatives = $derived(alternativesForNode(alternativePopoverNode));

  function modelKey(model: ModelOption): string {
    return JSON.stringify([model.provider, model.id]);
  }

  async function loadModels() {
    loadingModels = true;
    statusMessage = '';

    try {
      const response = await fetch('/api/models');
      const payload = (await response.json()) as ModelsResponse;
      models = payload.models;
      selectedProvider = payload.defaults.provider;
      selectedModel = payload.defaults.model;
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : 'Could not load models.';
    } finally {
      loadingModels = false;
    }
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

  function createRootNode(rootText: string): BeamNode {
    return {
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
  }

  function createChildNode(parent: BeamNode, alternative: BeamTokenAlternative): BeamNode {
    return {
      id: nodeId(parent.id, parent.depth + 1, alternative.rank, alternative.text),
      parentId: parent.id,
      depth: parent.depth + 1,
      text: alternative.text,
      rank: alternative.rank,
      logprob: alternative.logprob,
      prob: alternative.prob ?? probability(alternative.logprob),
      cumulativeLogprob: parent.cumulativeLogprob + alternative.logprob,
      children: [],
      status: 'leaf'
    };
  }

  function loadBeam() {
    explorationController?.abort();
    const root = createRootNode(text);
    beam = {
      rootId: root.id,
      nodes: [root]
    };
    alternativesByParentId = new Map();
    renderTerminalNodeIds = new Set();
    edgePaths = [];
    statusMessage = '';

    explorationController = new AbortController();
    void continueExploration(explorationController.signal);
    scheduleEdgeMeasure();
  }

  function scheduleBeamRefresh(delay = 250) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      loadBeam();
    }, delay);
  }

  function handleModelChange(value: string) {
    const [provider, model] = JSON.parse(value) as [ProviderId, string];
    selectedProvider = provider;
    selectedModel = model;
    scheduleBeamRefresh(0);
  }

  function toggleDebugMode() {
    debugScrollMode = !debugScrollMode;
    if (alternativePopoverHideTimer) clearTimeout(alternativePopoverHideTimer);
    alternativePopoverHideTimer = undefined;
  }

  async function getAlternatives(parent: BeamNode, signal: AbortSignal): Promise<BeamTokenAlternative[]> {
    const cached = alternativesByParentId.get(parent.id);
    if (cached) return cached;

    const response = await fetch('/api/next-token', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        provider: selectedProvider,
        model: selectedModel,
        text: pathPrefix(parent),
        topK: modelTopK
      })
    });

    if (!response.ok) {
      throw new Error(`Next-token request failed with ${response.status}`);
    }

    const payload = (await response.json()) as NextTokenResponse;
    alternativesByParentId = new Map(alternativesByParentId).set(parent.id, payload.alternatives);
    return payload.alternatives;
  }

  function pathPrefix(node: BeamNode): string {
    if (!node.parentId) return node.text;
    return `${text}${pathText(node)}`;
  }

  function addChild(parent: BeamNode, alternative: BeamTokenAlternative): BeamNode | undefined {
    if (!beam) return undefined;
    const freshParent = nodesById.get(parent.id);
    if (!freshParent) return undefined;

    const existingChild = freshParent.children
      .map((childId) => nodesById.get(childId))
      .find((child) => child?.rank === alternative.rank);
    if (existingChild) return existingChild;

    const child = createChildNode(freshParent, alternative);
    const parentChildren = [...freshParent.children, child.id].sort((leftId, rightId) => {
      const left = leftId === child.id ? child : nodesById.get(leftId);
      const right = rightId === child.id ? child : nodesById.get(rightId);
      return (left?.rank ?? 0) - (right?.rank ?? 0);
    });
    const updatedParent: BeamNode = {
      ...freshParent,
      children: parentChildren,
      status: 'expanded'
    };

    const nextNodes = beam.nodes.map((node) => (node.id === updatedParent.id ? updatedParent : node));
    nextNodes.push(child);
    beam = {
      ...beam,
      nodes: nextNodes
    };
    scheduleRenderPrune();
    scheduleEdgeMeasure();
    return child;
  }

  function nextHiddenAlternative(parent: BeamNode): BeamTokenAlternative | undefined {
    const alternatives = alternativesByParentId.get(parent.id);
    if (!alternatives) return undefined;

    const childRanks = new Set(
      parent.children
        .map((childId) => nodesById.get(childId)?.rank)
        .filter((rank): rank is number => typeof rank === 'number')
    );
    return alternatives.find((alternative) => !childRanks.has(alternative.rank));
  }

  function visibleChildProbSum(parent: BeamNode): number {
    return parent.children.reduce((sum, childId) => sum + (nodesById.get(childId)?.prob ?? 0), 0);
  }

  function hiddenMass(parent: BeamNode): number {
    return Math.max(0, 1 - visibleChildProbSum(parent));
  }

  async function continueExploration(signal = explorationController?.signal) {
    if (!signal || signal.aborted) return;
    if (explorationRunning) {
      explorationQueued = true;
      return;
    }

    explorationRunning = true;
    try {
      do {
        explorationQueued = false;
        await exploreUntilFull(signal);
      } while (explorationQueued && !signal.aborted);
    } finally {
      explorationRunning = false;
    }
  }

  async function exploreUntilFull(signal: AbortSignal) {
    if (!rootNode) return;

    try {
      await extendGreedyPath(rootNode, signal);

      while (!signal.aborted && currentNodes.length < maxClientNodes) {
        await updateRenderTerminals();
        const parent = parentWithMostHiddenMass();
        if (!parent) break;

        const next = nextHiddenAlternative(parent);
        if (!next) break;

        const child = addChild(parent, next);
        if (!child) break;
        await tick();
        await extendGreedyPath(child, signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        statusMessage = error instanceof Error ? error.message : 'Tree exploration failed.';
      }
    }
  }

  async function extendGreedyPath(start: BeamNode, signal: AbortSignal) {
    let cursor: BeamNode | undefined = start;

    while (cursor && !signal.aborted && cursor.depth < generatedDepth && currentNodes.length < maxClientNodes) {
      await updateRenderTerminals();
      if (cursor.parentId && !nodeHasRoomForChild(cursor)) return;

      const alternatives = await getAlternatives(cursor, signal);
      if (signal.aborted || alternatives.length === 0) return;

      const topAlternative = alternatives[0];
      const child = addChild(cursor, topAlternative);
      if (!child || child.id === cursor.id) return;

      await tick();
      cursor = child;
    }
  }

  function parentWithMostHiddenMass(): BeamNode | undefined {
    const canAddRow = hasRoomForAnotherRenderedRow();
    const candidates = visibleTokenNodes()
      .filter((node) => node.depth < generatedDepth && nodeHasRoomForChild(node));

    let best: BeamNode | undefined;
    let bestHiddenMass = -Infinity;

    for (const candidate of candidates) {
      if (!alternativesByParentId.has(candidate.id)) {
        if (candidate.children.length === 0) return candidate;
        continue;
      }

      if (candidate.children.length > 0 && !canAddRow) continue;
      if (!nextHiddenAlternative(candidate)) continue;
      const candidateHiddenMass = hiddenMass(candidate);
      if (candidateHiddenMass > bestHiddenMass) {
        best = candidate;
        bestHiddenMass = candidateHiddenMass;
      }
    }

    return best;
  }

  function hasRoomForAnotherRenderedRow(): boolean {
    if (!treeFrameElement) return true;

    const frameRect = treeFrameElement.getBoundingClientRect();
    const frameStyle = getComputedStyle(treeFrameElement);
    const verticalSpace =
      frameRect.height -
      (Number.parseFloat(frameStyle.paddingTop) || 0) -
      (Number.parseFloat(frameStyle.paddingBottom) || 0);
    const maxRows = Math.max(1, Math.floor(verticalSpace / treeRowPitch));
    const renderedRows = new Set(
      Array.from(treeFrameElement.querySelectorAll<HTMLElement>('.token-button')).map((element) =>
        Math.round(element.getBoundingClientRect().top)
      )
    );

    return renderedRows.size < maxRows;
  }

  function visibleTokenNodes(): BeamNode[] {
    if (!treeFrameElement) return rootNode ? [rootNode] : [];

    const frameRect = treeFrameElement.getBoundingClientRect();
    const frameStyle = getComputedStyle(treeFrameElement);
    const bottomEdge = frameRect.bottom - (Number.parseFloat(frameStyle.paddingBottom) || 0);
    const nodes: BeamNode[] = [];

    if (rootNode && rootNode.children.length === 0) nodes.push(rootNode);

    for (const element of treeFrameElement.querySelectorAll<HTMLElement>('.token-button')) {
      const nodeId = element.dataset.nodeId;
      const node = nodeId ? nodesById.get(nodeId) : undefined;
      if (!node) continue;

      const rect = element.getBoundingClientRect();
      if (rect.bottom <= bottomEdge + 1 && rect.top >= frameRect.top) {
        nodes.push(node);
      }
    }

    return nodes;
  }

  function nodeHasRoomForChild(node: BeamNode): boolean {
    if (!treeFrameElement || !node.parentId) return true;

    const selector = `[data-node-id="${CSS.escape(node.id)}"]`;
    const element = treeFrameElement.querySelector<HTMLElement>(selector);
    if (!element) return false;

    const frameRect = treeFrameElement.getBoundingClientRect();
    const frameStyle = getComputedStyle(treeFrameElement);
    const rightEdge = frameRect.right - (Number.parseFloat(frameStyle.borderRightWidth) || 0);
    const bottomEdge = frameRect.bottom - (Number.parseFloat(frameStyle.paddingBottom) || 0);
    const rect = element.getBoundingClientRect();
    return rect.bottom <= bottomEdge + 1 && rect.right + nextTokenGap + minimumVisibleNextTokenWidth <= rightEdge;
  }

  function pathToNode(nodeId: string): BeamNode[] {
    const path: BeamNode[] = [];
    let cursor = nodesById.get(nodeId);

    while (cursor) {
      path.push(cursor);
      if (!cursor.parentId) break;
      cursor = nodesById.get(cursor.parentId);
    }

    return path.reverse();
  }

  function pathText(node: BeamNode): string {
    return pathToNode(node.id)
      .filter((pathNode) => pathNode.parentId)
      .map((pathNode) => pathNode.text)
      .join('');
  }

  function appendBeam(node: BeamNode) {
    if (!node.parentId) return;
    hideAlternativePopover();
    text = `${text}${pathText(node)}`;
    scheduleBeamRefresh(0);
  }

  function appendAlternative(node: BeamNode, alternative: BeamTokenAlternative) {
    if (!node.parentId) return;

    const parent = nodesById.get(node.parentId);
    if (!parent) return;

    hideAlternativePopover();
    text = `${text}${pathText(parent)}${alternative.text}`;
    scheduleBeamRefresh(0);
  }

  function highlightNode(node: BeamNode) {
    if (node.parentId) hoveredNodeId = node.id;
  }

  function hideAlternativePopover() {
    if (alternativePopoverShowTimer) clearTimeout(alternativePopoverShowTimer);
    if (alternativePopoverHideTimer) clearTimeout(alternativePopoverHideTimer);
    alternativePopoverShowTimer = undefined;
    alternativePopoverHideTimer = undefined;
    alternativePopoverNodeId = null;
    hoveredAlternativeRank = null;
  }

  function handleNodeHoverStart(node: BeamNode, event: MouseEvent) {
    highlightNode(node);
    if (alternativePopoverShowTimer) clearTimeout(alternativePopoverShowTimer);
    if (alternativePopoverHideTimer) clearTimeout(alternativePopoverHideTimer);
    alternativePopoverShowTimer = undefined;
    alternativePopoverHideTimer = undefined;
    alternativePopoverNodeId = null;
    hoveredAlternativeRank = null;

    if (!node.parentId) return;

    const alternatives = alternativesForNode(node);
    if (alternatives.length === 0) return;

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const currentAlternativeIndex = Math.max(
      0,
      alternatives.findIndex((alternative) => alternative.rank === node.rank)
    );
    alternativePopoverX = rect.left - alternativePopoverPadding - 1;
    alternativePopoverY =
      rect.top -
      alternativePopoverPadding -
      alternativePopoverBorder -
      currentAlternativeIndex * alternativePopoverRowPitch;
    alternativePopoverShowTimer = setTimeout(() => {
      alternativePopoverNodeId = node.id;
      alternativePopoverShowTimer = undefined;
    }, 1000);
  }

  function handleNodeHoverEnd() {
    hoveredNodeId = null;
    if (alternativePopoverShowTimer) clearTimeout(alternativePopoverShowTimer);
    alternativePopoverShowTimer = undefined;
    scheduleAlternativePopoverHide();
  }

  function scheduleAlternativePopoverHide() {
    if (alternativePopoverHideTimer) clearTimeout(alternativePopoverHideTimer);
    alternativePopoverHideTimer = setTimeout(() => {
      alternativePopoverNodeId = null;
      alternativePopoverHideTimer = undefined;
    }, 220);
  }

  function keepAlternativePopover() {
    if (alternativePopoverHideTimer) clearTimeout(alternativePopoverHideTimer);
    alternativePopoverHideTimer = undefined;
    hoveredNodeId = null;
  }

  function handleAlternativeHover(rank: number) {
    keepAlternativePopover();
    hoveredAlternativeRank = rank;
  }

  function handleAlternativePopoverLeave() {
    hoveredAlternativeRank = null;
    scheduleAlternativePopoverHide();
  }

  function displayTokenParts(token: string): Array<{ text: string; control: boolean }> {
    if (token.length === 0) return [{ text: '∅', control: true }];

    return Array.from(token).map((char) => {
      if (char === ' ') return { text: '·', control: true };
      if (char === '\n') return { text: '↵', control: true };
      if (char === '\t') return { text: '⇥', control: true };
      return { text: char, control: false };
    });
  }

  function handleTextInput(event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement;
    text = target.value;
    scheduleBeamRefresh();
  }

  function reset() {
    text = '';
    renderTerminalNodeIds = new Set();
    scheduleBeamRefresh(0);
  }

  function updateVisibleBeamShape() {
    const width = treeFrameElement?.clientWidth ?? 900;
    const nextDepth = Math.max(1, Math.min(48, Math.floor((width - 120) / 54)));
    const nextGeneratedDepth = generatedDepthForVisibleDepth(nextDepth);
    const needsMoreDepth = nextGeneratedDepth > generatedDepth;

    if (nextDepth === visibleDepth && !needsMoreDepth) return false;

    visibleDepth = nextDepth;
    if (needsMoreDepth) {
      generatedDepth = nextGeneratedDepth;
    }
    return needsMoreDepth;
  }

  function scheduleRenderPrune() {
    if (renderPruneTimer) clearTimeout(renderPruneTimer);
    renderPruneTimer = setTimeout(() => {
      void updateRenderTerminals();
    }, 0);
  }

  function scheduleEdgeMeasure() {
    if (typeof requestAnimationFrame === 'undefined') return;
    if (edgeMeasureFrame !== undefined) cancelAnimationFrame(edgeMeasureFrame);
    edgeMeasureFrame = requestAnimationFrame(() => {
      edgeMeasureFrame = undefined;
      void updateEdgePaths();
    });
  }

  function roundedHorizontalVerticalPath(startX: number, startY: number, cornerX: number, endY: number) {
    const horizontalDirection = Math.sign(cornerX - startX) || 1;
    const verticalDirection = Math.sign(endY - startY) || 1;
    const radius = Math.min(
      edgeCornerRadius,
      Math.abs(cornerX - startX) / 2,
      Math.abs(endY - startY) / 2
    );

    if (radius < 0.5) return `M ${startX} ${startY} H ${cornerX} V ${endY}`;

    return [
      `M ${startX} ${startY}`,
      `H ${cornerX - horizontalDirection * radius}`,
      `Q ${cornerX} ${startY} ${cornerX} ${startY + verticalDirection * radius}`,
      `V ${endY}`
    ].join(' ');
  }

  function roundedBranchArmPath(trunkX: number, parentY: number, childY: number, childLeft: number) {
    const verticalDirection = Math.sign(childY - parentY) || 1;
    const horizontalDirection = Math.sign(childLeft - trunkX) || 1;
    const radius = Math.min(
      edgeCornerRadius,
      Math.abs(childY - parentY) / 2,
      Math.abs(childLeft - trunkX) / 2
    );

    if (radius < 0.5) return `M ${trunkX} ${childY} H ${childLeft}`;

    return [
      `M ${trunkX} ${childY - verticalDirection * radius}`,
      `Q ${trunkX} ${childY} ${trunkX + horizontalDirection * radius} ${childY}`,
      `H ${childLeft}`
    ].join(' ');
  }

  function roundedHorizontalVerticalHorizontalPath(
    startX: number,
    startY: number,
    cornerX: number,
    endY: number,
    endX: number
  ) {
    const firstHorizontalDirection = Math.sign(cornerX - startX) || 1;
    const verticalDirection = Math.sign(endY - startY) || 1;
    const secondHorizontalDirection = Math.sign(endX - cornerX) || 1;
    const radius = Math.min(
      edgeCornerRadius,
      Math.abs(cornerX - startX) / 2,
      Math.abs(endY - startY) / 2,
      Math.abs(endX - cornerX) / 2
    );

    if (radius < 0.5) {
      return `M ${startX} ${startY} H ${cornerX} V ${endY} H ${endX}`;
    }

    return [
      `M ${startX} ${startY}`,
      `H ${cornerX - firstHorizontalDirection * radius}`,
      `Q ${cornerX} ${startY} ${cornerX} ${startY + verticalDirection * radius}`,
      `V ${endY - verticalDirection * radius}`,
      `Q ${cornerX} ${endY} ${cornerX + secondHorizontalDirection * radius} ${endY}`,
      `H ${endX}`
    ].join(' ');
  }

  async function updateEdgePaths() {
    if (!treeFrameElement || !beamListElement || !rootNode) {
      edgePaths = [];
      edgeLayerWidth = 0;
      edgeLayerHeight = 0;
      return;
    }

    await tick();

    const frameRect = treeFrameElement.getBoundingClientRect();
    const frameStyle = getComputedStyle(treeFrameElement);
    const borderLeft = Number.parseFloat(frameStyle.borderLeftWidth) || 0;
    const borderTop = Number.parseFloat(frameStyle.borderTopWidth) || 0;
    const bottomEdge = frameRect.bottom - (Number.parseFloat(frameStyle.paddingBottom) || 0);
    const scrollLeft = treeFrameElement.scrollLeft;
    const scrollTop = treeFrameElement.scrollTop;
    const rectsByNodeId = new Map<string, TokenRect>();

    const toLayerX = (x: number) => x - frameRect.left - borderLeft + scrollLeft;
    const toLayerY = (y: number) => y - frameRect.top - borderTop + scrollTop;

    for (const element of treeFrameElement.querySelectorAll<HTMLElement>('.token-button')) {
      const nodeId = element.dataset.nodeId;
      if (!nodeId) continue;

      const rect = element.getBoundingClientRect();
      if (rect.bottom < frameRect.top || rect.top > bottomEdge + 1) continue;

      rectsByNodeId.set(nodeId, {
        left: toLayerX(rect.left),
        right: toLayerX(rect.right),
        centerY: toLayerY(rect.top + rect.height / 2),
        top: toLayerY(rect.top),
        bottom: toLayerY(rect.bottom)
      });
    }

    const nextEdges: EdgePath[] = [];
    for (const parent of currentNodes) {
      const parentRect = rectsByNodeId.get(parent.id);
      if (!parentRect) continue;

      const children: Array<{ node: BeamNode; rect: TokenRect }> = [];
      for (const child of childNodes(parent)) {
        const rect = rectsByNodeId.get(child.id);
        if (rect) children.push({ node: child, rect });
      }
      children.sort((left, right) => left.rect.centerY - right.rect.centerY);

      if (children.length === 0) continue;

      const firstChildLeft = Math.min(...children.map((child) => child.rect.left));
      const trunkX = Math.min(firstChildLeft - 1, parentRect.right + Math.max(2, (firstChildLeft - parentRect.right) / 2));
      const lastChild = children[children.length - 1];
      const lastChildY = lastChild.rect.centerY;
      nextEdges.push({
        id: `${parent.id}:trunk`,
        parentId: parent.id,
        d: roundedHorizontalVerticalPath(parentRect.right, parentRect.centerY, trunkX, lastChildY)
      });

      for (const child of children) {
        nextEdges.push({
          id: `${parent.id}:${child.node.id}:arm`,
          parentId: parent.id,
          childId: child.node.id,
          d: roundedBranchArmPath(trunkX, parentRect.centerY, child.rect.centerY, child.rect.left)
        });
        nextEdges.push({
          id: `${parent.id}:${child.node.id}:highlight`,
          parentId: parent.id,
          childId: child.node.id,
          highlightOnly: true,
          d: roundedHorizontalVerticalHorizontalPath(
            parentRect.right,
            parentRect.centerY,
            trunkX,
            child.rect.centerY,
            child.rect.left
          )
        });
      }
    }

    edgeLayerWidth = Math.ceil(Math.max(treeFrameElement.clientWidth, beamListElement.scrollWidth));
    edgeLayerHeight = Math.ceil(Math.max(treeFrameElement.clientHeight, beamListElement.scrollHeight));
    edgePaths = nextEdges;
  }

  async function updateRenderTerminals() {
    if (!treeFrameElement) return;

    await tick();
    const frameRect = treeFrameElement.getBoundingClientRect();
    const frameStyle = getComputedStyle(treeFrameElement);
    const contentRight = frameRect.right - (Number.parseFloat(frameStyle.borderRightWidth) || 0);
    const nextTerminalNodeIds = new Set<string>();

    for (const element of treeFrameElement.querySelectorAll<HTMLElement>('.token-button')) {
      const nodeId = element.dataset.nodeId;
      if (!nodeId) continue;

      const node = nodesById.get(nodeId);
      if (!node || node.children.length === 0) continue;

      const tokenRect = element.getBoundingClientRect();
      if (tokenRect.right + nextTokenGap + minimumVisibleNextTokenWidth > contentRight) {
        nextTerminalNodeIds.add(node.id);
      }
    }

    if (sameStringSet(renderTerminalNodeIds, nextTerminalNodeIds)) return;

    renderTerminalNodeIds = nextTerminalNodeIds;
    scheduleEdgeMeasure();
    setTimeout(() => {
      void updateRenderTerminals();
    }, 0);
  }

  function sameStringSet(left: Set<string>, right: Set<string>) {
    if (left.size !== right.size) return false;
    for (const item of left) {
      if (!right.has(item)) return false;
    }
    return true;
  }

  function generatedDepthForVisibleDepth(depth: number) {
    return maxGeneratedDepth;
  }

  function topRolloutNodes(): BeamNode[] {
    const rollout: BeamNode[] = [];
    let cursor = rootNode;

    while (cursor) {
      const nextId = cursor.children
        .map((childId) => nodesById.get(childId))
        .filter((child): child is BeamNode => child !== undefined)
        .find((child) => child.rank === 1)?.id;
      if (!nextId) break;

      const next = nodesById.get(nextId);
      if (!next) break;
      rollout.push(next);
      cursor = next;
    }

    return rollout;
  }

  async function fitDepthToRightEdge(allowGrow: boolean) {
    if (fittingDepth || !treeFrameElement || !rootNode) return;
    fittingDepth = true;

    try {
      await tick();
      const frameRect = treeFrameElement.getBoundingClientRect();
      const frameStyle = getComputedStyle(treeFrameElement);
      const rightBorder = Number.parseFloat(frameStyle.borderRightWidth) || 0;
      const rightEdge = frameRect.right - rightBorder;
      const topNodes = topRolloutNodes();

      const firstOverflowIndex = topNodes.findIndex((node) => {
        const selector = `[data-node-id="${CSS.escape(node.id)}"]`;
        const element = treeFrameElement?.querySelector(selector);
        if (!element) return false;
        return element.getBoundingClientRect().right > rightEdge + 1;
      });

      let nextDepth = visibleDepth;
      if (firstOverflowIndex >= 0) {
        nextDepth = firstOverflowIndex + 1;
      } else if (allowGrow && topNodes.length >= visibleDepth && visibleDepth < generatedDepth) {
        nextDepth = visibleDepth + 1;
      }

      const nextGeneratedDepth = generatedDepthForVisibleDepth(nextDepth);
      const needsMoreDepth = nextGeneratedDepth > generatedDepth;

      if (nextDepth !== visibleDepth || needsMoreDepth) {
        visibleDepth = nextDepth;
        if (needsMoreDepth) {
          generatedDepth = nextGeneratedDepth;
        }
      }

      if (allowGrow) void continueExploration();
    } finally {
      fittingDepth = false;
    }
  }

  function childNodes(node: BeamNode): BeamNode[] {
    if (renderTerminalNodeIds.has(node.id)) return [];

    return node.children
      .map((childId) => nodesById.get(childId))
      .filter((child): child is BeamNode => child !== undefined && child.depth <= generatedDepth);
  }

  function alternativesForNode(node: BeamNode | undefined): BeamTokenAlternative[] {
    if (!node?.parentId) return [];
    return alternativesByParentId.get(node.parentId) ?? [];
  }

  function isTextEditingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable
    );
  }

  onMount(() => {
    updateVisibleBeamShape();
    void loadModels().then(() => loadBeam());

    const handleResize = () => {
      renderTerminalNodeIds = new Set();
      updateVisibleBeamShape();
      scheduleRenderPrune();
      scheduleEdgeMeasure();
      void continueExploration();
    };
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'd') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextEditingTarget(event.target)) return;

      toggleDebugMode();
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', handleKeydown);

    return () => {
      explorationController?.abort();
      if (renderPruneTimer) clearTimeout(renderPruneTimer);
      if (edgeMeasureFrame !== undefined) cancelAnimationFrame(edgeMeasureFrame);
      hideAlternativePopover();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeydown);
    };
  });
</script>

{#snippet treeNode(node: BeamNode)}
  <li class:error={node.status === 'error'} class:root={node.parentId === null}>
    <div class:highlighted={highlightedNodeIds.has(node.id)} class="tree-row">
      {#if node.parentId}
        <span class="node-stack">
          <button
            type="button"
            class="token-button"
            data-node-id={node.id}
            onclick={() => appendBeam(node)}
            onfocus={() => highlightNode(node)}
            onblur={handleNodeHoverEnd}
            onmouseenter={(event) => handleNodeHoverStart(node, event)}
            onmouseleave={handleNodeHoverEnd}
          >
            <span class="token-text">
              {#each displayTokenParts(node.text) as part}
                <span class:control-char={part.control}>{part.text}</span>
              {/each}
            </span>
          </button>
          <small class:visible={debugScrollMode} class="token-prob">
            {Math.round(node.prob * 1000) / 10}
          </small>
        </span>
      {:else}
        <span class="root-ellipsis">...</span>
      {/if}
    </div>

    {#if childNodes(node).length > 0}
      <ul>
        {#each childNodes(node) as child}
          {@render treeNode(child)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<svelte:head>
  <title>TreeSage</title>
  <meta
    name="description"
    content="A local-first LLM beam search typing tutor and visualization."
  />
</svelte:head>

<main class="shell">
  <section class="workspace" aria-label="TreeSage workspace">
    <header class="topbar">
      <div>
        <h1>TreeSage</h1>
        <p>Local beam-search typing tutor</p>
      </div>

      <div class="controls" aria-label="Beam controls">
        <label>
          Model
          <select
            disabled={loadingModels || availableModels.length === 0}
            value={JSON.stringify([selectedProvider, selectedModel])}
            onchange={(event) => handleModelChange((event.currentTarget as HTMLSelectElement).value)}
          >
            {#each availableModels as model}
              <option value={modelKey(model)}>{model.provider}: {model.label}</option>
            {/each}
          </select>
        </label>

        <button type="button" class="ghost" onclick={reset}>Reset</button>
      </div>
    </header>

    <div class="editor-row">
      <label class="prompt-editor">
        Text
        <textarea
          value={text}
          placeholder="Start typing..."
          oninput={handleTextInput}
        ></textarea>
      </label>
    </div>

    <div class="tree-area">
      {#if statusMessage}
        <div class="status" role="status">{statusMessage}</div>
      {/if}

      <section
        bind:this={treeFrameElement}
        class:debug-scroll={debugScrollMode}
        class="tree-frame"
        aria-label="Beam tree"
        onscroll={scheduleEdgeMeasure}
      >
        {#if rootNode}
          {#if edgeLayerWidth > 0 && edgeLayerHeight > 0}
            <svg
              class="edge-layer"
              aria-hidden="true"
              width={edgeLayerWidth}
              height={edgeLayerHeight}
              viewBox={`0 0 ${edgeLayerWidth} ${edgeLayerHeight}`}
            >
              {#each edgePaths as edge (edge.id)}
                <path
                  class:highlight-only={edge.highlightOnly}
                  class:highlighted={edge.highlightOnly &&
                    edge.childId !== undefined &&
                    highlightedNodeIds.has(edge.parentId) &&
                    highlightedNodeIds.has(edge.childId)}
                  class="edge-path"
                  d={edge.d}
                  pathLength="1"
                />
              {/each}
            </svg>
          {/if}
          <ul bind:this={beamListElement} class="beam-list">
            {@render treeNode(rootNode)}
          </ul>
        {:else}
          <p>No beam loaded.</p>
        {/if}
      </section>
    </div>
  </section>
  <button
    class:active={debugScrollMode}
    class="debug-badge"
    type="button"
    aria-pressed={debugScrollMode}
    onclick={toggleDebugMode}
  >
    [d]ebug
  </button>
</main>

{#if alternativePopoverNode && alternativePopoverAlternatives.length > 0}
  <aside
    class="alternative-popover"
    style={`left: ${alternativePopoverX}px; top: ${alternativePopoverY}px;`}
    aria-label="Token alternatives"
    onmouseenter={keepAlternativePopover}
    onmousemove={keepAlternativePopover}
    onwheel={keepAlternativePopover}
    onscroll={keepAlternativePopover}
    onmouseleave={handleAlternativePopoverLeave}
  >
    <ol class="alternative-row">
      {#each alternativePopoverAlternatives as alternative}
        <li class:current={hoveredAlternativeRank === null && alternative.rank === alternativePopoverNode.rank}>
          <button
            type="button"
            class="alternative-option"
            onmouseenter={() => handleAlternativeHover(alternative.rank)}
            onmousemove={() => handleAlternativeHover(alternative.rank)}
            onfocus={() => handleAlternativeHover(alternative.rank)}
            onclick={() => appendAlternative(alternativePopoverNode, alternative)}
          >
            <span class="alternative-token">
              <span class="token-text">
                {#each displayTokenParts(alternative.text) as part}
                  <span class:control-char={part.control}>{part.text}</span>
                {/each}
              </span>
            </span>
            <small class:visible={debugScrollMode} class="token-prob">{Math.round(alternative.prob * 1000) / 10}</small>
          </button>
        </li>
      {/each}
    </ol>
  </aside>
{/if}

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    --tree-surface-background: #f7f9f7;
    --token-background: #f7f9f7;
    --token-highlight-background: #fff7df;

    margin: 0;
    min-width: 320px;
    color: #17211b;
    background: #eef1ee;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  button,
  select,
  textarea {
    font: inherit;
  }

  .shell {
    height: 100vh;
    padding: 18px;
    overflow: hidden;
  }

  .workspace {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: 14px;
    height: 100%;
    min-height: 0;
  }

  .topbar {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 18px;
  }

  h1 {
    margin: 0;
    font-size: 28px;
    line-height: 1.05;
    font-weight: 750;
  }

  p {
    margin: 4px 0 0;
    color: #607068;
  }

  .controls {
    display: flex;
    align-items: end;
    justify-content: end;
    flex-wrap: wrap;
    gap: 10px;
  }

  label {
    display: grid;
    gap: 6px;
    color: #425048;
    font-size: 12px;
    font-weight: 650;
  }

  select,
  textarea {
    border: 1px solid #bdc8c0;
    border-radius: 8px;
    color: #152019;
    background: #fbfcfb;
  }

  select {
    height: 38px;
    padding: 0 10px;
  }

  .ghost {
    border: 0;
    color: #425048;
    background: transparent;
    cursor: pointer;
  }

  .ghost {
    height: 38px;
    padding: 0 14px;
    border: 1px solid #bdc8c0;
    border-radius: 8px;
    background: #fbfcfb;
  }

  .editor-row {
    display: block;
  }

  .prompt-editor textarea {
    min-height: 118px;
    resize: vertical;
    padding: 12px;
    font-size: 18px;
    line-height: 1.45;
  }

  .control-char {
    color: #aeb8b2;
   }

  .status {
    min-height: 28px;
    padding: 7px 10px;
    border: 1px solid #e1c27f;
    border-radius: 8px;
    color: #704600;
    background: #fff8e8;
    font-size: 13px;
  }

  .tree-area {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 14px;
    min-height: 0;
  }

  .tree-frame {
    position: relative;
    grid-row: 2;
    min-height: 0;
    height: 100%;
    overflow-x: hidden;
    overflow-y: hidden;
    border: 1px solid #c6d0ca;
    border-radius: 8px;
    padding: 18px;
    background: var(--token-background);
  }

  .tree-frame.debug-scroll {
    overflow-x: auto;
  }

  .edge-layer {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 0;
    overflow: visible;
    pointer-events: none;
  }

  .edge-path {
    fill: none;
    stroke: #cdd8d1;
    stroke-width: 1;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
    animation: edge-draw 140ms ease-out both;
  }

  .edge-path.highlighted {
    stroke: #d7be73;
  }

  .edge-path.highlight-only {
    opacity: 0;
    animation: none;
  }

  .edge-path.highlight-only.highlighted {
    opacity: 1;
  }

  @keyframes edge-draw {
    from {
      opacity: 0;
      stroke-dasharray: 1;
      stroke-dashoffset: 1;
    }

    to {
      opacity: 1;
      stroke-dasharray: 1;
      stroke-dashoffset: 0;
    }
  }

  .debug-badge {
    position: fixed;
    right: 25px;
    bottom: 2px;
    z-index: 10;
    width: max-content;
    height: 14px;
    padding: 0 4px;
    border: 1px solid #c9cfcb;
    border-radius: 4px;
    color: #7a837e;
    background: rgb(255 255 255 / 88%);
    font-size: 8px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
  }

  .debug-badge.active {
    border-color: #7a1f1f;
    color: #ffffff;
    background: #7a1f1f;
  }

  .beam-list,
  .beam-list ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .beam-list {
    position: relative;
    z-index: 1;
    min-width: max-content;
  }

  .beam-list li {
    position: relative;
    display: grid;
    grid-template-columns: max-content max-content;
    column-gap: 2px;
    align-items: start;
    justify-items: start;
    margin: 0;
  }

  .beam-list li > ul {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 2px;
  }

  .beam-list li.error > .tree-row {
    border-color: #b44436;
    background: #fff0ed;
  }

  .tree-row {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    min-height: 28px;
  }

  .tree-row.highlighted .token-button {
    border-color: #e2d6b6;
    background: var(--token-highlight-background);
    box-shadow: 0 0 0 2px rgb(180 139 40 / 16%);
  }

  .root > .tree-row {
    color: #87928c;
    font-weight: 700;
  }

  .root > .tree-row.highlighted {
    color: #57645d;
  }

  .root-ellipsis {
    line-height: 1;
  }

  .node-stack {
    position: relative;
    display: inline-flex;
    align-items: flex-start;
    justify-content: center;
    min-height: 39px;
  }

  .token-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 28px;
    padding: 1px 3px;
    border: 1px solid #dce4df;
    border-radius: 6px;
    color: #14201a;
    background: var(--token-background);
    cursor: pointer;
    font-weight: 700;
  }

  .token-button:hover {
    border-color: #c9d7d0;
  }

  .token-prob {
    position: absolute;
    top: 29px;
    left: 50%;
    width: max-content;
    transform: translateX(-50%);
    color: #6b7c73;
    font-size: 8px;
    font-weight: 650;
    line-height: 1;
    visibility: hidden;
  }

  .token-prob.visible {
    visibility: visible;
  }

  .token-text {
    line-height: 1.15;
  }

  .alternative-popover {
    position: fixed;
    z-index: 20;
    width: max-content;
    max-width: min(320px, calc(100vw - 24px));
    max-height: min(520px, calc(100vh - 24px));
    overflow: auto;
    padding: 8px;
    border: 1px solid #b7c4bc;
    border-radius: 8px;
    background: var(--token-background);
    box-shadow: 0 10px 30px rgb(23 33 27 / 18%);
    color: #17211b;
  }

  .alternative-row {
    display: flex;
    flex-direction: column;
    align-items: start;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .alternative-row li {
    display: flex;
    align-items: start;
    height: 39px;
  }

  .alternative-option {
    position: relative;
    display: inline-flex;
    align-items: flex-start;
    justify-content: center;
    min-height: 39px;
    padding: 0;
    border: 0;
    color: inherit;
    background: transparent;
    cursor: pointer;
  }

  .alternative-row li.current .alternative-token,
  .alternative-option:hover .alternative-token,
  .alternative-option:focus-visible .alternative-token {
    border-color: #e2d6b6;
    background: var(--token-highlight-background);
    box-shadow: 0 0 0 2px rgb(180 139 40 / 14%);
  }

  .alternative-token {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 28px;
    padding: 1px 3px;
    border: 1px solid #dce4df;
    border-radius: 6px;
    color: #14201a;
    background: var(--token-background);
    font-weight: 700;
  }

  @media (max-width: 860px) {
    .shell {
      padding: 12px;
    }

    .workspace {
      min-height: 0;
    }

    .topbar {
      align-items: stretch;
      flex-direction: column;
    }

    .controls {
      justify-content: start;
    }
  }
</style>
