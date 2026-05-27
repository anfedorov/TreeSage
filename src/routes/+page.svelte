<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type {
    BeamEvent,
    BeamNode,
    BeamResponse,
    BeamTokenAlternative,
    ModelsResponse,
    ModelOption,
    ProviderId
  } from '$lib/beam/types';

  type DetailMode = 'clean' | 'detailed';

  let text = $state('The model');
  let detailMode = $state<DetailMode>('detailed');
  let visibleDepth = $state(12);
  let generatedDepth = $state(20);
  let nodeBudget = $state(80);
  let selectedProvider = $state<ProviderId>('fake');
  let selectedModel = $state('fake-sage-small');
  let models = $state<ModelOption[]>([]);
  let beam = $state<BeamResponse | null>(null);
  let pendingBeam = $state<BeamResponse | null>(null);
  let loadingModels = $state(true);
  let statusMessage = $state('');
  let hoveredNodeId = $state<string | null>(null);
  let alternativePopoverNodeId = $state<string | null>(null);
  let alternativePopoverX = $state(0);
  let alternativePopoverY = $state(0);
  let alternativesByParentId = $state(new Map<string, BeamTokenAlternative[]>());
  let debugScrollMode = $state(false);
  let renderTerminalNodeIds = $state(new Set<string>());
  let treeFrameElement = $state<HTMLElement>();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let renderPruneTimer: ReturnType<typeof setTimeout> | undefined;
  let alternativePopoverShowTimer: ReturnType<typeof setTimeout> | undefined;
  let alternativePopoverHideTimer: ReturnType<typeof setTimeout> | undefined;
  let beamStream: EventSource | undefined;
  let fittingDepth = false;

  const maxNodeBudget = 720;
  const alternativePopoverPadding = 8;
  const nextTokenGap = 8;
  const minimumVisibleNextTokenWidth = 1;
  const treeRowPitch = 48;

  const availableModels = $derived(models.filter((model) => model.available));
  const currentNodes = $derived(beam?.nodes ?? []);
  const nodesById = $derived(new Map(currentNodes.map((node) => [node.id, node])));
  const rootNode = $derived(beam ? nodesById.get(beam.rootId) : undefined);
  const highlightedNodeIds = $derived(new Set(hoveredNodeId ? pathToNode(hoveredNodeId).map((node) => node.id) : []));
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

  function upsertNode(response: BeamResponse | null, node: BeamNode): BeamResponse | null {
    if (!response) return response;

    const existingIndex = response.nodes.findIndex((existing) => existing.id === node.id);
    const nodes = [...response.nodes];
    if (existingIndex >= 0) {
      nodes[existingIndex] = node;
    } else {
      nodes.push(node);
    }

    return {
      ...response,
      nodes
    };
  }

  function promotePendingBeamIfReady() {
    if (!pendingBeam || !beam) return false;
    if (pendingBeam.nodes.length < beam.nodes.length) return false;

    beam = pendingBeam;
    pendingBeam = null;
    return true;
  }

  function beamStreamUrl(): string {
    const params = new URLSearchParams({
      provider: selectedProvider,
      model: selectedModel,
      text,
      depth: String(generatedDepth),
      nodeBudget: String(nodeBudget)
    });

    return `/api/beam/stream?${params.toString()}`;
  }

  function handleBeamEvent(event: BeamEvent, preserveCurrent: boolean) {
    if (event.type === 'reset') {
      alternativesByParentId = new Map();
      renderTerminalNodeIds = new Set();
      const nextBeam = {
        rootId: event.rootId,
        nodes: [event.node]
      };
      if (preserveCurrent) {
        pendingBeam = nextBeam;
      } else {
        beam = nextBeam;
      }
      statusMessage = '';
      return;
    }

    if (event.type === 'alternatives') {
      alternativesByParentId = new Map(alternativesByParentId).set(
        event.parentId,
        event.alternatives
      );
      return;
    }

    if (event.type === 'parent' || event.type === 'node') {
      if (preserveCurrent && pendingBeam) {
        pendingBeam = upsertNode(pendingBeam, event.node);
        promotePendingBeamIfReady();
      } else {
        beam = upsertNode(beam, event.node);
      }
      void fitDepthToRightEdge(false);
      scheduleRenderPrune();
      return;
    }

    if (event.type === 'node-error') {
      if (preserveCurrent && pendingBeam) {
        pendingBeam = upsertNode(pendingBeam, event.node);
        promotePendingBeamIfReady();
      } else {
        beam = upsertNode(beam, event.node);
      }
      statusMessage = event.message;
      scheduleRenderPrune();
      return;
    }

    if (event.type === 'done') {
      statusMessage = event.providerStatus ?? '';
      if (preserveCurrent && pendingBeam) {
        beam = pendingBeam;
        pendingBeam = null;
      }
      beamStream?.close();
      beamStream = undefined;
      void fitDepthToRightEdge(true);
      scheduleRenderPrune();
    }
  }

  function loadBeam(preserveCurrent = false) {
    beamStream?.close();
    pendingBeam = null;
    if (!preserveCurrent) beam = null;
    statusMessage = '';

    const stream = new EventSource(beamStreamUrl());
    beamStream = stream;

    stream.onmessage = (message) => {
      handleBeamEvent(JSON.parse(message.data) as BeamEvent, preserveCurrent);
    };

    for (const type of ['reset', 'alternatives', 'parent', 'node', 'node-error', 'done']) {
      stream.addEventListener(type, (message) => {
        handleBeamEvent(JSON.parse(message.data) as BeamEvent, preserveCurrent);
      });
    }

    stream.onerror = () => {
      statusMessage = 'Beam stream disconnected.';
      stream.close();
      if (beamStream === stream) beamStream = undefined;
    };
  }

  function scheduleBeamRefresh(delay = 250, preserveCurrent = false) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      loadBeam(preserveCurrent);
    }, delay);
  }

  function handleModelChange(value: string) {
    const [provider, model] = JSON.parse(value) as [ProviderId, string];
    selectedProvider = provider;
    selectedModel = model;
    scheduleBeamRefresh(0);
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
  }

  function handleNodeHoverStart(node: BeamNode, event: MouseEvent) {
    highlightNode(node);
    if (alternativePopoverShowTimer) clearTimeout(alternativePopoverShowTimer);
    if (alternativePopoverHideTimer) clearTimeout(alternativePopoverHideTimer);
    alternativePopoverShowTimer = undefined;
    alternativePopoverHideTimer = undefined;
    alternativePopoverNodeId = null;

    if (detailMode !== 'detailed') return;
    if (!node.parentId) return;

    const alternatives = alternativesForNode(node);
    if (alternatives.length === 0) return;

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const currentAlternativeIndex = Math.max(
      0,
      alternatives.findIndex((alternative) => alternative.rank === node.rank)
    );
    alternativePopoverX = rect.left - alternativePopoverPadding - 1;
    alternativePopoverY = rect.top - alternativePopoverPadding - currentAlternativeIndex * treeRowPitch - 1;
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
  }

  function handleAlternativePopoverLeave() {
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
    const height = treeFrameElement?.clientHeight ?? 420;
    const nextDepth = Math.max(1, Math.min(48, Math.floor((width - 120) / 54)));
    const nextGeneratedDepth = generatedDepthForVisibleDepth(nextDepth);
    const nextNodeBudget = nodeBudgetForDepth(nextGeneratedDepth, height);
    const needsRefresh = nextGeneratedDepth > generatedDepth || nextNodeBudget > nodeBudget;

    if (nextDepth === visibleDepth && !needsRefresh) return false;

    visibleDepth = nextDepth;
    if (needsRefresh) {
      generatedDepth = nextGeneratedDepth;
      nodeBudget = nextNodeBudget;
    }
    return needsRefresh;
  }

  function scheduleRenderPrune() {
    if (renderPruneTimer) clearTimeout(renderPruneTimer);
    renderPruneTimer = setTimeout(() => {
      void updateRenderTerminals();
    }, 0);
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

  function nodeBudgetForDepth(depth: number, height = treeFrameElement?.clientHeight ?? 420) {
    const visibleRows = Math.max(2, Math.ceil((height - 20) / 48) + 1);
    return Math.max(2, Math.min(maxNodeBudget, 1 + depth * visibleRows));
  }

  function generatedDepthForVisibleDepth(depth: number) {
    return Math.min(48, depth + 8);
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
      const bottomPadding = Number.parseFloat(frameStyle.paddingBottom) || 0;
      const rightEdge = frameRect.right - rightBorder;
      const bottomEdge = frameRect.bottom - bottomPadding;
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
      let nextNodeBudget = nodeBudgetForDepth(nextGeneratedDepth);

      if (allowGrow) {
        const tokenElements = Array.from(treeFrameElement.querySelectorAll<HTMLElement>('.token-button'));
        const hasBottomOverflow = tokenElements.some(
          (element) => element.getBoundingClientRect().bottom > bottomEdge + 1
        );
        const lowestBottom = tokenElements.reduce(
          (bottom, element) => Math.max(bottom, element.getBoundingClientRect().bottom),
          frameRect.top
        );
        const hasVerticalRoom = !hasBottomOverflow && lowestBottom < bottomEdge - 20;
        const hasVisibleLeafWithHorizontalRoom = tokenElements.some((element) => {
          const nodeId = element.dataset.nodeId;
          const node = nodeId ? nodesById.get(nodeId) : undefined;
          if (!node || node.children.length > 0 || node.depth >= generatedDepth) return false;

          const rect = element.getBoundingClientRect();
          const isVisible = rect.top >= frameRect.top && rect.bottom <= bottomEdge + 1;
          return isVisible && rect.right + nextTokenGap + minimumVisibleNextTokenWidth <= rightEdge;
        });

        if ((hasVerticalRoom || hasVisibleLeafWithHorizontalRoom) && currentNodes.length >= nodeBudget) {
          nextNodeBudget = Math.min(maxNodeBudget, Math.max(nextNodeBudget, nodeBudget + 48));
        }
      }

      const needsRefresh = nextGeneratedDepth > generatedDepth || nextNodeBudget > nodeBudget;

      if (nextDepth !== visibleDepth || needsRefresh) {
        visibleDepth = nextDepth;
        if (needsRefresh) {
          generatedDepth = nextGeneratedDepth;
          nodeBudget = nextNodeBudget;
          beamStream?.close();
          beamStream = undefined;
          scheduleBeamRefresh(0, true);
        }
      }
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
      if (updateVisibleBeamShape()) scheduleBeamRefresh(0);
      scheduleRenderPrune();
    };
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'd') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextEditingTarget(event.target)) return;

      debugScrollMode = !debugScrollMode;
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', handleKeydown);

    return () => {
      beamStream?.close();
      if (renderPruneTimer) clearTimeout(renderPruneTimer);
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
          <small class:visible={detailMode === 'detailed'} class="token-prob">
            {Math.round(node.prob * 1000) / 10}%
          </small>
        </span>
      {:else}
        <strong>{node.text || 'empty prompt'}</strong>
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

        <div class="segmented" role="group" aria-label="Detail">
          <button
            class:active={detailMode === 'clean'}
            type="button"
            onclick={() => {
              detailMode = 'clean';
              hideAlternativePopover();
            }}
          >
            Clean
          </button>
          <button
            class:active={detailMode === 'detailed'}
            type="button"
            onclick={() => (detailMode = 'detailed')}
          >
            Detailed
          </button>
        </div>

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
      >
        {#if rootNode}
          <ul class="beam-list">
            {@render treeNode(rootNode)}
          </ul>
        {:else}
          <p>No beam loaded.</p>
        {/if}
        <div class:active={debugScrollMode} class="debug-badge">[d]ebug</div>
      </section>
    </div>
  </section>
</main>

{#if detailMode === 'detailed' && alternativePopoverNode && alternativePopoverAlternatives.length > 0}
  <aside
    class="alternative-popover"
    style={`left: ${alternativePopoverX}px; top: ${alternativePopoverY}px;`}
    aria-label="Token alternatives"
    onmouseenter={keepAlternativePopover}
    onmouseleave={handleAlternativePopoverLeave}
  >
    <ol class="alternative-row">
      {#each alternativePopoverAlternatives as alternative}
        <li class:current={alternative.rank === alternativePopoverNode.rank}>
          <button
            type="button"
            class="alternative-option"
            onclick={() => appendAlternative(alternativePopoverNode, alternative)}
          >
            <span class="alternative-token">
              <span class="token-text">
                {#each displayTokenParts(alternative.text) as part}
                  <span class:control-char={part.control}>{part.text}</span>
                {/each}
              </span>
            </span>
            <small class="token-prob visible">{Math.round(alternative.prob * 1000) / 10}%</small>
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

  .segmented {
    display: grid;
    grid-template-columns: 1fr 1fr;
    height: 38px;
    overflow: hidden;
    border: 1px solid #bdc8c0;
    border-radius: 8px;
    background: #fbfcfb;
  }

  .segmented button,
  .ghost {
    border: 0;
    color: #425048;
    background: transparent;
    cursor: pointer;
  }

  .segmented button {
    width: 70px;
  }

  .segmented button.active {
    color: #ffffff;
    background: #24553e;
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
    background: #f7f9f7;
  }

  .tree-frame.debug-scroll {
    overflow-x: auto;
  }

  .debug-badge {
    position: absolute;
    right: 10px;
    bottom: 10px;
    z-index: 10;
    width: max-content;
    padding: 3px 7px;
    border: 1px solid #c9cfcb;
    border-radius: 6px;
    color: #7a837e;
    background: rgb(255 255 255 / 88%);
    font-size: 11px;
    font-weight: 700;
    pointer-events: none;
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
    min-width: max-content;
  }

  .beam-list li {
    position: relative;
    display: grid;
    grid-template-columns: max-content max-content;
    column-gap: 4px;
    align-items: start;
    justify-items: start;
    margin: 0;
  }

  .beam-list li > ul {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-left: 4px;
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
    min-height: 34px;
  }

  .tree-row.highlighted .token-button {
    border-color: #b48b28;
    background: #fff7df;
    box-shadow: 0 0 0 2px rgb(180 139 40 / 16%);
  }

  .root > .tree-row {
    padding: 5px 8px;
    color: #ffffff;
    border: 1px solid #24553e;
    border-radius: 8px;
    border-color: #24553e;
    background: #24553e;
  }

  .root > .tree-row.highlighted {
    border-color: #b48b28;
    background: #2f6a4f;
  }

  .node-stack {
    display: grid;
    justify-items: center;
    gap: 2px;
  }

  .token-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 48px;
    min-height: 34px;
    padding: 5px 3px;
    border: 1px solid #aebbb4;
    border-radius: 6px;
    color: #14201a;
    background: #ffffff;
    cursor: pointer;
    font-weight: 700;
  }

  .token-button:hover {
    border-color: #24553e;
  }

  .token-prob {
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
    background: #ffffff;
    box-shadow: 0 10px 30px rgb(23 33 27 / 18%);
    color: #17211b;
  }

  .alternative-row {
    display: flex;
    flex-direction: column;
    align-items: start;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .alternative-row li {
    display: flex;
    align-items: start;
    height: 44px;
  }

  .alternative-option {
    display: grid;
    justify-items: center;
    gap: 2px;
    padding: 0;
    border: 0;
    color: inherit;
    background: transparent;
    cursor: pointer;
  }

  .alternative-row li.current .alternative-token,
  .alternative-option:hover .alternative-token,
  .alternative-option:focus-visible .alternative-token {
    border-color: #b48b28;
    background: #fff7df;
    box-shadow: 0 0 0 2px rgb(180 139 40 / 14%);
  }

  .alternative-token {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 48px;
    min-height: 34px;
    padding: 5px 3px;
    border: 1px solid #aebbb4;
    border-radius: 6px;
    color: #14201a;
    background: #ffffff;
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
