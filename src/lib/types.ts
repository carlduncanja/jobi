export type AttachmentKind = 'document' | 'image' | 'text' | 'audio' | 'video' | 'other';

export interface NormalizedAttachment {
  id: string;
  filename?: string;
  mimeType: string;
  kind: AttachmentKind;
  bytes: Uint8Array;
  caption?: string;
  sha256?: string;
  source: 'whatsapp' | 'api';
}

export interface AgentRequestAttachmentInput {
  filename?: string;
  mimeType: string;
  kind?: AttachmentKind;
  base64: string;
  caption?: string;
}

export interface AgentRequestInput {
  sessionId: string;
  chatId: string;
  userId: string;
  messageId?: string;
  text: string;
  attachments?: AgentRequestAttachmentInput[];
  allowSending?: boolean;
}

export interface NormalizedIncomingMessage {
  sessionId: string;
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  attachments: NormalizedAttachment[];
  receivedAt: string;
}

export interface OutboundTextMessage {
  chatId: string;
  text: string;
  quotedMessageId?: string;
}

export interface OutboundAudioMessage {
  chatId: string;
  audioBytes: Uint8Array;
  mimeType: string;
}

export interface ResumeDocumentRecord {
  id: string;
  userId: string;
  attachmentIds: string[];
  source: 'document' | 'image' | 'mixed';
  rawText: string;
  extractedAt: string;
  updatedAt: string;
}

export interface ResumeProfile {
  userId: string;
  fullName?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  titles: string[];
  skills: string[];
  preferredLocations: string[];
  industries: string[];
  yearsOfExperience?: number;
  seniority?: string;
  rawText: string;
  sourceAttachmentIds: string[];
  updatedAt: string;
}

export interface SearchProfile {
  userId: string;
  summary: string;
  targetTitles: string[];
  relatedTitles: string[];
  skills: string[];
  preferredLocations: string[];
  remotePreference?: string;
  excludedKeywords: string[];
  updatedAt: string;
}

export interface SearchResultSnippet {
  text: string;
  score?: number;
}

export interface SearchResultHit {
  title: string;
  url: string;
  publishedAt?: string;
  text?: string;
  highlights?: SearchResultSnippet[];
  author?: string;
}

export interface JobPosting {
  id: string;
  canonicalUrl: string;
  title: string;
  company: string;
  location: string;
  remoteType?: string;
  employmentType?: string;
  salary?: string;
  summary: string;
  description?: string;
  source: string;
  publishedAt?: string;
  tags: string[];
  updatedAt: string;
}

export interface JobMatch {
  id: string;
  userId: string;
  jobId: string;
  score: number;
  reasons: string[];
  matchedSkills: string[];
  missingSkills: string[];
  status: 'new' | 'sent' | 'saved' | 'dismissed' | 'applied';
  createdAt: string;
  updatedAt: string;
}

export interface NotificationPreference {
  userId: string;
  subscribed: boolean;
  slotMinute: number;
  updatedAt: string;
}

export interface BroadcastRun {
  id: string;
  dateKey: string;
  windowStart: string;
  windowEnd: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface BroadcastDelivery {
  id: string;
  runId: string;
  userId: string;
  chatId: string;
  scheduledFor: string;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'skipped';
  error?: string;
  sentAt?: string;
  updatedAt: string;
}

export interface RankedJob {
  job: JobPosting;
  score: number;
  reasons: string[];
  matchedSkills: string[];
  missingSkills: string[];
}

export interface JobSearchCompletion {
  summary: string;
  queries: string[];
  jobs: RankedJob[];
}

export interface SendMessageResult {
  delivered: boolean;
  providerMessageId?: string;
}

export type WhatsAppConnectionState = 'connecting' | 'open' | 'close';

export interface WhatsAppSessionStatus {
  sessionId: string;
  state: WhatsAppConnectionState;
  qr?: string;
  pairingCode?: string;
  lastDisconnectReason?: string;
}

export type WhatsAppProviderEvent =
  | {
      type: 'message';
      message: NormalizedIncomingMessage;
    }
  | {
      type: 'connection';
      session: WhatsAppSessionStatus;
    };
