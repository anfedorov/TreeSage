import { env } from '$env/dynamic/private';
import type { ProviderId } from '$lib/beam/types';

export const OLLAMA_BASE_URL = env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

export const DEFAULT_PROVIDER: ProviderId =
  env.DEFAULT_PROVIDER === 'fake' ? 'fake' : 'ollama';

export const DEFAULT_MODEL = env.DEFAULT_MODEL ?? 'llama3.2:3b';

export const MAX_TOP_K = 10;
export const DEFAULT_TOP_K = 3;
export const MODEL_TOP_K = 20;
export const MAX_DEPTH = 48;
export const DEFAULT_DEPTH = 12;
export const MAX_NODE_BUDGET = 720;
export const DEFAULT_NODE_BUDGET = 40;
