import { createGateway } from 'ai';

import type { AppContext } from '../lib/app-context';

export function getMainAgentModel(app: AppContext) {
  return getGatewayProvider(app)(normalizeGatewayModelId(app.env.mainAgentModel));
}

export function getSearchAgentModel(app: AppContext) {
  return getGatewayProvider(app)(normalizeGatewayModelId(app.env.searchAgentModel));
}

function getGatewayProvider(app: AppContext) {
  return createGateway({
    apiKey: app.env.aiGatewayApiKey,
  });
}

function normalizeGatewayModelId(modelId: string): string {
  if (modelId.includes('/')) {
    return modelId;
  }

  if (modelId.startsWith('gpt-')) {
    return `openai/${modelId}`;
  }

  if (modelId.startsWith('claude-')) {
    return `anthropic/${modelId}`;
  }

  if (modelId.startsWith('gemini-')) {
    return `google/${modelId}`;
  }

  if (modelId.startsWith('grok-')) {
    return `xai/${modelId}`;
  }

  return `openai/${modelId}`;
}
