export type ProviderId = 'fake' | 'ollama';

export type BeamNodeStatus = 'expanded' | 'leaf' | 'error';

export type BeamNode = {
  id: string;
  parentId: string | null;
  depth: number;
  text: string;
  rank: number;
  logprob: number;
  prob: number;
  cumulativeLogprob: number;
  children: string[];
  status: BeamNodeStatus;
};

export type NextTokenRequest = {
  provider: ProviderId;
  model: string;
  text: string;
  topK?: number;
};

export type BeamResponse = {
  rootId: string;
  nodes: BeamNode[];
  providerStatus?: string;
};

export type NextTokenResponse = {
  alternatives: BeamTokenAlternative[];
};

export type BeamTokenAlternative = TokenAlternative & {
  rank: number;
  prob: number;
};

export type ModelOption = {
  provider: ProviderId;
  id: string;
  label: string;
  available: boolean;
  status?: string;
};

export type ModelsResponse = {
  defaults: {
    provider: ProviderId;
    model: string;
  };
  models: ModelOption[];
};

export type TokenAlternative = {
  text: string;
  logprob: number;
};
