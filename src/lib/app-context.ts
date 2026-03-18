import type { Env } from '../config/env';
import type { Logger } from '../config/logger';
import type { Database } from '../db/surreal';
import type { SearchProvider } from '../domain/ports/search-provider';
import type { WhatsAppProvider } from '../domain/ports/whatsapp-provider';
import type { NormalizedAttachment } from './types';

export interface AppContext {
  env: Env;
  logger: Logger;
  db: Database;
  searchProvider: SearchProvider;
  whatsappProvider: WhatsAppProvider | null;
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface MainAgentRequestContext {
  sessionId: string;
  userId: string;
  chatId: string;
  messageId?: string;
  text: string;
  attachments: NormalizedAttachment[];
  allowSending: boolean;
  sentMessages: Array<{
    text: string;
    providerMessageId?: string;
  }>;
  history: ChatHistoryMessage[];
  abortSignal?: AbortSignal;
}
