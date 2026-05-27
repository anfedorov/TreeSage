import { env } from '$env/dynamic/private';
import type { ProviderId } from '$lib/beam/types';

export const OLLAMA_BASE_URL = env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

export const DEFAULT_PROVIDER: ProviderId =
  env.DEFAULT_PROVIDER === 'fake' ? 'fake' : 'ollama';

export const DEFAULT_MODEL = env.DEFAULT_MODEL ?? 'llama3.2:3b';

export const MODEL_TOP_K = 20;
