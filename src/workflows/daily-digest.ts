import {
  getJobPosting,
  getOrCreateBroadcastRun,
  listFreshJobMatches,
  listBroadcastDeliveriesForRun,
  listDueBroadcastDeliveries,
  listSubscribedUsers,
  markJobMatchesSent,
  saveBroadcastDelivery,
  saveMessage,
  updateBroadcastDeliveryStatus,
} from '../db/store';
import type { AppContext } from '../lib/app-context';
import type { JobSearchCompletion, RankedJob } from '../lib/types';
import { getBroadcastWindow, computeScheduledDelivery, isInsideBroadcastWindow } from './digest-batching';
import { runJobSearchLoop } from '../ai/job-search-loop-agent';
import { isoNow } from '../lib/utils';

export async function processDailyDigestWindow(
  app: AppContext,
  now = new Date(),
): Promise<void> {
  if (
    !isInsideBroadcastWindow(
      now,
      app.env.broadcastWindow.startUtcHour,
      app.env.broadcastWindow.durationMinutes,
    )
  ) {
    return;
  }

  const window = getBroadcastWindow(
    now,
    app.env.broadcastWindow.startUtcHour,
    app.env.broadcastWindow.durationMinutes,
  );
  const run = await getOrCreateBroadcastRun(app.db, window.dateKey, window.windowStart, window.windowEnd);
  const existingDeliveries = await listBroadcastDeliveriesForRun(app.db, window.dateKey);

  if (existingDeliveries.length === 0) {
    const subscribers = await listSubscribedUsers(app.db);

    for (const subscriber of subscribers) {
      await saveBroadcastDelivery(app.db, {
        id: `${window.dateKey}-${subscriber.userId}`,
        runId: window.dateKey,
        userId: subscriber.userId,
        chatId: subscriber.chatId,
        scheduledFor: computeScheduledDelivery(
          now,
          subscriber.slotMinute,
          app.env.broadcastWindow.startUtcHour,
        ),
        status: 'pending',
        updatedAt: isoNow(),
      });
    }

    app.logger.info({ count: subscribers.length, runId: run.id }, 'Created daily digest deliveries');
  }

  const dueDeliveries = await listDueBroadcastDeliveries(app.db, now.toISOString(), 10);

  for (const delivery of dueDeliveries) {
    await updateBroadcastDeliveryStatus(app.db, delivery.id, {
      status: 'processing',
    });

    try {
      const search =
        (await buildDigestFromFreshMatches(app, delivery.userId)) ??
        (await runJobSearchLoop(app, {
          userId: delivery.userId,
          chatId: delivery.chatId,
          prompt: 'Find fresh daily digest jobs for this user and prefer new, relevant openings.',
        }));

      if (!search.jobs.length) {
        await updateBroadcastDeliveryStatus(app.db, delivery.id, {
          status: 'skipped',
        });
        continue;
      }

      const digestText = formatDigestMessage(search);

      if (!app.whatsappProvider) {
        throw new Error('WhatsApp provider is not configured');
      }

      await app.whatsappProvider.sendText({
        chatId: delivery.chatId,
        text: digestText,
      });

      await saveMessage(app.db, {
        userId: delivery.userId,
        chatId: delivery.chatId,
        direction: 'outbound',
        text: digestText,
        attachmentIds: [],
      });
      await markJobMatchesSent(
        app.db,
        search.jobs.map((item) => `${delivery.userId}-${item.job.id}`),
      );
      await updateBroadcastDeliveryStatus(app.db, delivery.id, {
        status: 'sent',
        sentAt: isoNow(),
      });
    } catch (error) {
      await updateBroadcastDeliveryStatus(app.db, delivery.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown delivery error',
      });
      app.logger.error({ error }, 'Failed daily digest delivery');
    }
  }
}

export function formatDigestMessage(search: Awaited<ReturnType<typeof runJobSearchLoop>>): string {
  const lines = ['Daily Job Bot update:'];

  for (const [index, item] of search.jobs.slice(0, 5).entries()) {
    lines.push(
      `${index + 1}. ${item.job.title} at ${item.job.company} - ${item.job.location}`,
      `   ${item.job.canonicalUrl}`,
      `   ${item.reasons.join('; ')}`,
    );
  }

  lines.push('', search.summary);

  return lines.join('\n');
}

async function buildDigestFromFreshMatches(
  app: AppContext,
  userId: string,
): Promise<JobSearchCompletion | undefined> {
  const matches = await listFreshJobMatches(app.db, userId, 5);

  if (!matches.length) {
    return undefined;
  }

  const jobs = (
    await Promise.all(
      matches.map(async (match) => {
        const job = await getJobPosting(app.db, match.jobId);

        if (!job) {
          return undefined;
        }

        const ranked: RankedJob = {
          job,
          score: match.score,
          reasons: match.reasons,
          matchedSkills: match.matchedSkills,
          missingSkills: match.missingSkills,
        };

        return ranked;
      }),
    )
  ).filter((item): item is RankedJob => Boolean(item));

  if (!jobs.length) {
    return undefined;
  }

  return {
    summary: 'Here are your fresh saved matches for today.',
    queries: [],
    jobs,
  };
}
