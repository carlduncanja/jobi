import type { Database } from './surreal';
import { recordId } from './surreal';
import type {
  BroadcastDelivery,
  BroadcastRun,
  JobMatch,
  JobPosting,
  NotificationPreference,
  ResumeDocumentRecord,
  ResumeProfile,
  SearchProfile,
  WhatsAppSessionStatus,
} from '../lib/types';
import { isoNow } from '../lib/utils';

type StoredUser = {
  id?: string;
  chatId: string;
  phoneNumber?: string;
  referredBy?: string;
  createdAt: string;
  updatedAt: string;
};

type StoredReferralCode = {
  id?: string;
  userId: string;
  code: string;
  createdAt: string;
};

type StoredReferral = {
  id?: string;
  referrerId: string;
  referredUserId: string;
  referralCode: string;
  qualified: boolean;
  createdAt: string;
};

type StoredAttachment = {
  id?: string;
  userId: string;
  chatId: string;
  filename?: string;
  mimeType: string;
  kind: string;
  storagePath: string;
  sha256: string;
  textContent?: string;
  ocrStatus: string;
  createdAt: string;
};

type StoredSession = {
  id?: string;
  sessionId: string;
  creds?: Record<string, unknown>;
  keys?: Record<string, unknown>;
  status?: WhatsAppSessionStatus;
  updatedAt: string;
};

type StoredMessage = {
  id?: string;
  userId: string;
  chatId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  attachmentIds: string[];
  createdAt: string;
};

// SurrealDB SDK types don't align with our domain types — RecordId, .content(), and
// .merge() all require `any` casts because the SDK uses internal branded types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asRecordId(table: string, id: string): any {
  return recordId(table, id);
}

function normalizeId(id: unknown, table: string): string {
  if (typeof id === 'string') {
    return id.startsWith(`${table}:`) ? id.slice(table.length + 1) : id;
  }

  if (typeof id === 'object' && id && 'id' in id) {
    return String((id as { id: unknown }).id);
  }

  return String(id);
}

function normalizeRecord<T extends { id?: unknown }>(record: T | undefined, table: string): T | undefined {
  if (!record) {
    return undefined;
  }

  return {
    ...record,
    id: record.id ? normalizeId(record.id, table) : record.id,
  } as T;
}

export async function ensureUser(
  db: Database,
  params: { userId: string; chatId: string; phoneNumber?: string },
): Promise<StoredUser> {
  const id = asRecordId('users', params.userId);
  const existing = ((await db.select<StoredUser>(id)) ?? undefined) as StoredUser | undefined;
  const now = isoNow();

  const next: StoredUser = {
    id: params.userId,
    chatId: params.chatId,
    phoneNumber: params.phoneNumber ?? existing?.phoneNumber,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await db.upsert<StoredUser>(id).merge(next as any);
  return next;
}

export async function getUser(
  db: Database,
  userId: string,
): Promise<StoredUser | undefined> {
  const record = ((await db.select<StoredUser>(asRecordId('users', userId))) ?? undefined) as
    | StoredUser
    | undefined;

  return normalizeRecord(record, 'users');
}

export async function saveMessage(
  db: Database,
  message: Omit<StoredMessage, 'createdAt'> & { createdAt?: string },
): Promise<StoredMessage> {
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const next: StoredMessage = {
    id,
    ...message,
    createdAt: message.createdAt ?? isoNow(),
  };

  await db.create<StoredMessage>(asRecordId('messages', id)).content(next as any);
  return next;
}

export async function listRecentMessages(
  db: Database,
  chatId: string,
  limit = 20,
): Promise<StoredMessage[]> {
  const [rows] = await db
    .query<[StoredMessage[]]>(
      `
      SELECT * FROM messages
      WHERE chatId = $chatId
      ORDER BY createdAt DESC
      LIMIT $limit
      `,
      { chatId, limit },
    )
    .collect();

  return (rows ?? [])
    .map((row) => normalizeRecord(row, 'messages') as StoredMessage)
    .reverse();
}

export async function saveAttachmentRecord(
  db: Database,
  input: Omit<StoredAttachment, 'createdAt'> & { createdAt?: string },
): Promise<StoredAttachment> {
  const next: StoredAttachment = {
    id: input.sha256,
    ...input,
    createdAt: input.createdAt ?? isoNow(),
  };

  await db.upsert<StoredAttachment>(asRecordId('attachments', input.sha256)).merge(next as any);
  return next;
}

export async function saveResumeDocument(
  db: Database,
  document: ResumeDocumentRecord,
): Promise<ResumeDocumentRecord> {
  await db.upsert<ResumeDocumentRecord>(asRecordId('resume_documents', document.id)).content(
    document as any,
  );
  return document;
}

export async function saveResumeProfile(
  db: Database,
  profile: ResumeProfile,
): Promise<ResumeProfile> {
  await db.upsert<ResumeProfile>(asRecordId('resume_profiles', profile.userId)).content(profile as any);
  return profile;
}

export async function saveSearchProfile(
  db: Database,
  profile: SearchProfile,
): Promise<SearchProfile> {
  await db.upsert<SearchProfile>(asRecordId('search_profiles', profile.userId)).content(profile as any);
  return profile;
}

export async function getSearchProfile(db: Database, userId: string): Promise<SearchProfile | undefined> {
  return ((await db.select<SearchProfile>(asRecordId('search_profiles', userId))) ?? undefined) as
    | SearchProfile
    | undefined;
}

export async function upsertNotificationPreference(
  db: Database,
  preference: NotificationPreference,
): Promise<NotificationPreference> {
  await db
    .upsert<NotificationPreference>(asRecordId('notification_preferences', preference.userId))
    .content(preference as any);
  return preference;
}

export async function getNotificationPreference(
  db: Database,
  userId: string,
): Promise<NotificationPreference | undefined> {
  return ((await db.select<NotificationPreference>(asRecordId('notification_preferences', userId))) ??
    undefined) as NotificationPreference | undefined;
}

export async function listSubscribedUsers(
  db: Database,
): Promise<Array<{ userId: string; chatId: string; slotMinute: number }>> {
  const [preferenceRows] = await db
    .query<[Array<{ userId: string; chatId: string; slotMinute: number }>]>(
      `
      SELECT
        userId,
        slotMinute
      FROM notification_preferences
      WHERE subscribed = true
      `,
    )
    .collect();

  const preferences = (preferenceRows ?? []) as Array<{ userId: string; slotMinute: number }>;
  const users = await Promise.all(
    preferences.map(async (row) => {
      const user = await getUser(db, row.userId);

      if (!user) {
        return undefined;
      }

      return {
        userId: row.userId,
        chatId: user.chatId,
        slotMinute: row.slotMinute,
      };
    }),
  );

  return users.filter((user): user is { userId: string; chatId: string; slotMinute: number } => Boolean(user));
}

export async function saveJobPosting(db: Database, job: JobPosting): Promise<JobPosting> {
  await db.upsert<JobPosting>(asRecordId('job_postings', job.id)).content(job as any);
  return job;
}

export async function getJobPosting(db: Database, jobId: string): Promise<JobPosting | undefined> {
  const record = ((await db.select<JobPosting>(asRecordId('job_postings', jobId))) ?? undefined) as
    | JobPosting
    | undefined;

  return normalizeRecord(record, 'job_postings');
}

export async function findJobPostingByUrl(
  db: Database,
  canonicalUrl: string,
): Promise<JobPosting | undefined> {
  const [rows] = await db
    .query<[JobPosting[]]>(
      'SELECT * FROM job_postings WHERE canonicalUrl = $canonicalUrl LIMIT 1',
      { canonicalUrl },
    )
    .collect();

  return normalizeRecord(rows?.[0], 'job_postings');
}

export async function saveJobMatch(db: Database, match: JobMatch): Promise<JobMatch> {
  await db.upsert<JobMatch>(asRecordId('job_matches', match.id)).content(match as any);
  return match;
}

export async function getJobMatch(
  db: Database,
  matchId: string,
): Promise<JobMatch | undefined> {
  const record = ((await db.select<JobMatch>(asRecordId('job_matches', matchId))) ?? undefined) as
    | JobMatch
    | undefined;

  return normalizeRecord(record, 'job_matches');
}

export async function listFreshJobMatches(
  db: Database,
  userId: string,
  limit = 5,
): Promise<JobMatch[]> {
  const [rows] = await db
    .query<[JobMatch[]]>(
      `
      SELECT * FROM job_matches
      WHERE userId = $userId
        AND status = "new"
      ORDER BY score DESC
      LIMIT $limit
      `,
      { userId, limit },
    )
    .collect();

  return (rows ?? []).map((row) => normalizeRecord(row, 'job_matches') as JobMatch);
}

export async function markJobMatchesSent(db: Database, matchIds: string[]): Promise<void> {
  const now = isoNow();

  for (const matchId of matchIds) {
    await db.upsert<JobMatch>(asRecordId('job_matches', matchId)).merge({
      status: 'sent',
      updatedAt: now,
    } as any);
  }
}

export async function getOrCreateBroadcastRun(
  db: Database,
  dateKey: string,
  windowStart: string,
  windowEnd: string,
): Promise<BroadcastRun> {
  const id = asRecordId('broadcast_runs', dateKey);
  const existing = normalizeRecord(
    ((await db.select<BroadcastRun>(id)) ?? undefined) as BroadcastRun | undefined,
    'broadcast_runs',
  );
  const now = isoNow();

  const next: BroadcastRun = {
    id: dateKey,
    dateKey,
    windowStart,
    windowEnd,
    status: existing?.status ?? 'pending',
    createdAt: (existing as any)?.createdAt ?? now,
    updatedAt: now,
  } as BroadcastRun & { createdAt?: string };

  await db.upsert<BroadcastRun>(id).merge(next as any);
  return next as BroadcastRun;
}

export async function saveBroadcastDelivery(
  db: Database,
  delivery: BroadcastDelivery,
): Promise<BroadcastDelivery> {
  await db
    .upsert<BroadcastDelivery>(asRecordId('broadcast_deliveries', delivery.id))
    .content(delivery as any);
  return delivery;
}

export async function listBroadcastDeliveriesForRun(
  db: Database,
  runId: string,
): Promise<BroadcastDelivery[]> {
  const [rows] = await db
    .query<[BroadcastDelivery[]]>(
      'SELECT * FROM broadcast_deliveries WHERE runId = $runId ORDER BY scheduledFor ASC',
      { runId },
    )
    .collect();

  return (rows ?? []).map((row) => normalizeRecord(row, 'broadcast_deliveries') as BroadcastDelivery);
}

export async function listDueBroadcastDeliveries(
  db: Database,
  scheduledThrough: string,
  limit = 20,
): Promise<BroadcastDelivery[]> {
  const [rows] = await db
    .query<[BroadcastDelivery[]]>(
      `
      SELECT * FROM broadcast_deliveries
      WHERE status = "pending"
        AND scheduledFor <= $scheduledThrough
      ORDER BY scheduledFor ASC
      LIMIT $limit
      `,
      { scheduledThrough, limit },
    )
    .collect();

  return (rows ?? []).map((row) => normalizeRecord(row, 'broadcast_deliveries') as BroadcastDelivery);
}

export async function updateBroadcastDeliveryStatus(
  db: Database,
  deliveryId: string,
  patch: Partial<BroadcastDelivery>,
): Promise<BroadcastDelivery> {
  const existing = normalizeRecord(
    ((await db.select<BroadcastDelivery>(asRecordId('broadcast_deliveries', deliveryId))) ??
      undefined) as BroadcastDelivery | undefined,
    'broadcast_deliveries',
  );

  const next: BroadcastDelivery = {
    ...(existing ?? {
      id: deliveryId,
      runId: '',
      userId: '',
      chatId: '',
      scheduledFor: isoNow(),
      status: 'pending',
      updatedAt: isoNow(),
    }),
    ...patch,
    id: deliveryId,
    updatedAt: isoNow(),
  };

  await db
    .upsert<BroadcastDelivery>(asRecordId('broadcast_deliveries', deliveryId))
    .merge(next as any);
  return next;
}

export async function getSessionRecord(
  db: Database,
  sessionId: string,
): Promise<StoredSession | undefined> {
  const record = ((await db.select<StoredSession>(asRecordId('wa_sessions', sessionId))) ?? undefined) as
    | StoredSession
    | undefined;

  return normalizeRecord(record, 'wa_sessions');
}

export async function saveSessionAuthState(
  db: Database,
  sessionId: string,
  data: {
    creds: Record<string, unknown>;
    keys: Record<string, unknown>;
  },
): Promise<StoredSession> {
  const next: StoredSession = {
    id: sessionId,
    sessionId,
    creds: data.creds,
    keys: data.keys,
    updatedAt: isoNow(),
  };

  await db.upsert<StoredSession>(asRecordId('wa_sessions', sessionId)).merge(next as any);
  return next;
}

export async function saveSessionStatus(
  db: Database,
  sessionId: string,
  status: WhatsAppSessionStatus,
): Promise<StoredSession> {
  const next: StoredSession = {
    id: sessionId,
    sessionId,
    status,
    updatedAt: isoNow(),
  };

  await db.upsert<StoredSession>(asRecordId('wa_sessions', sessionId)).merge(next as any);
  return next;
}

export async function clearSessionAuthState(
  db: Database,
  sessionId: string,
): Promise<void> {
  await db.delete(asRecordId('wa_sessions', sessionId));
}

// --- Referral system ---

function generateReferralCode(userId: string, displayName?: string): string {
  const suffix = userId.slice(-4);
  const prefix = (displayName ?? 'USER')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .slice(0, 4) || 'USER';
  return `${prefix}${suffix}`;
}

export async function getOrCreateReferralCode(
  db: Database,
  userId: string,
  displayName?: string,
): Promise<string> {
  const [existing] = await db
    .query<[StoredReferralCode[]]>(
      'SELECT * FROM referral_codes WHERE userId = $userId LIMIT 1',
      { userId },
    )
    .collect();

  if (existing?.[0]) {
    return existing[0].code;
  }

  let code = generateReferralCode(userId, displayName);

  const [clash] = await db
    .query<[StoredReferralCode[]]>(
      'SELECT * FROM referral_codes WHERE code = $code LIMIT 1',
      { code },
    )
    .collect();

  if (clash?.[0]) {
    code = `${code}${Math.floor(Math.random() * 90 + 10)}`;
  }

  const id = `${userId}-${code}`;
  const record: StoredReferralCode = {
    id,
    userId,
    code,
    createdAt: isoNow(),
  };

  await db.create<StoredReferralCode>(asRecordId('referral_codes', id)).content(record as any);
  return code;
}

export async function lookupReferralCode(
  db: Database,
  code: string,
): Promise<string | undefined> {
  const [rows] = await db
    .query<[StoredReferralCode[]]>(
      'SELECT * FROM referral_codes WHERE code = $code LIMIT 1',
      { code: code.toUpperCase() },
    )
    .collect();

  return rows?.[0]?.userId;
}

export async function createReferral(
  db: Database,
  params: { referrerId: string; referredUserId: string; referralCode: string },
): Promise<StoredReferral> {
  const id = `ref-${params.referredUserId}`;
  const record: StoredReferral = {
    id,
    referrerId: params.referrerId,
    referredUserId: params.referredUserId,
    referralCode: params.referralCode,
    qualified: false,
    createdAt: isoNow(),
  };

  await db.create<StoredReferral>(asRecordId('referrals', id)).content(record as any);

  await db.upsert(asRecordId('users', params.referredUserId)).merge({
    referredBy: params.referrerId,
    updatedAt: isoNow(),
  } as any);

  return record;
}

export async function qualifyReferral(
  db: Database,
  referredUserId: string,
): Promise<{ qualified: boolean; referrerId?: string }> {
  const [rows] = await db
    .query<[StoredReferral[]]>(
      'SELECT * FROM referrals WHERE referredUserId = $referredUserId LIMIT 1',
      { referredUserId },
    )
    .collect();

  const referral = rows?.[0];
  if (!referral || referral.qualified) {
    return { qualified: false };
  }

  const id = normalizeId(referral.id, 'referrals') ?? `ref-${referredUserId}`;
  await db.upsert(asRecordId('referrals', id)).merge({
    qualified: true,
  } as any);

  return { qualified: true, referrerId: referral.referrerId };
}

export async function getReferralStats(
  db: Database,
  userId: string,
  month?: string,
): Promise<{ count: number; rank: number }> {
  const monthPrefix = month ?? isoNow().slice(0, 7);
  const monthStart = `${monthPrefix}-01T00:00:00.000Z`;
  const nextMonth = monthPrefix.slice(0, 5) +
    String(Number(monthPrefix.slice(5, 7)) + 1).padStart(2, '0');
  const monthEnd = `${nextMonth}-01T00:00:00.000Z`;

  const [countRows] = await db
    .query<[Array<{ count: number }>]>(
      `SELECT count() AS count FROM referrals
       WHERE referrerId = $userId AND qualified = true
         AND createdAt >= $monthStart AND createdAt < $monthEnd
       GROUP ALL`,
      { userId, monthStart, monthEnd },
    )
    .collect();

  const count = countRows?.[0]?.count ?? 0;

  const [leaderboardRows] = await db
    .query<[Array<{ referrerId: string; count: number }>]>(
      `SELECT referrerId, count() AS count FROM referrals
       WHERE qualified = true
         AND createdAt >= $monthStart AND createdAt < $monthEnd
       GROUP BY referrerId
       ORDER BY count DESC`,
      { monthStart, monthEnd },
    )
    .collect();

  const leaderboard = leaderboardRows ?? [];
  const rank = leaderboard.findIndex((r) => r.referrerId === userId) + 1;

  return { count, rank: rank || leaderboard.length + 1 };
}

export async function getLeaderboard(
  db: Database,
  month?: string,
  limit = 5,
): Promise<Array<{ userId: string; count: number }>> {
  const monthPrefix = month ?? isoNow().slice(0, 7);
  const monthStart = `${monthPrefix}-01T00:00:00.000Z`;
  const nextMonth = monthPrefix.slice(0, 5) +
    String(Number(monthPrefix.slice(5, 7)) + 1).padStart(2, '0');
  const monthEnd = `${nextMonth}-01T00:00:00.000Z`;

  const [rows] = await db
    .query<[Array<{ referrerId: string; count: number }>]>(
      `SELECT referrerId, count() AS count FROM referrals
       WHERE qualified = true
         AND createdAt >= $monthStart AND createdAt < $monthEnd
       GROUP BY referrerId
       ORDER BY count DESC
       LIMIT $limit`,
      { monthStart, monthEnd, limit },
    )
    .collect();

  return (rows ?? []).map((r) => ({ userId: r.referrerId, count: r.count }));
}
