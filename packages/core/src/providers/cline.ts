import type { ChatResponse, ModelInfo, ProviderId, StreamChunk } from '../types.js';
import { BaseProvider } from './base.js';

export class ClineProvider extends BaseProvider {
  readonly id: ProviderId = 'cline';
  readonly displayName = 'Cline';

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async chat(): Promise<ChatResponse> {
    throw new Error('cline provider not yet implemented');
  }

  async *stream(): AsyncIterable<StreamChunk> {
    yield* [];
    throw new Error('cline provider not yet implemented');
  }
}
