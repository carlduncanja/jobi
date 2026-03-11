import type {
  OutboundTextMessage,
  SendMessageResult,
  WhatsAppProviderEvent,
  WhatsAppSessionStatus,
} from '../../lib/types';

export interface WhatsAppProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (event: WhatsAppProviderEvent) => Promise<void> | void): () => void;
  sendText(message: OutboundTextMessage): Promise<SendMessageResult>;
  getSessionStatus(): Promise<WhatsAppSessionStatus>;
  requestPairingCode(phoneNumber: string): Promise<string>;
}
