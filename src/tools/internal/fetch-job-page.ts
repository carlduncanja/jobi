import { tool, zodSchema } from 'ai';
import { load } from 'cheerio';
import { z } from 'zod/v4';

import { normalizeWhitespace, truncate } from '../../lib/utils';

export function createFetchJobPageTool() {
  return tool({
    description: 'Fetch a job page URL and extract readable page text for normalization.',
    inputSchema: zodSchema(
      z.object({
        url: z.string().url(),
      }),
    ),
    execute: async ({ url }) => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: {
          'user-agent': 'JobBot/1.0',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch ${url} with status ${response.status}`);
      }

      const html = await response.text();
      const $ = load(html);

      $('script, style, noscript').remove();

      const title = normalizeWhitespace($('title').first().text());
      const bodyText = normalizeWhitespace($('body').text());

      return {
        url,
        title,
        text: truncate(bodyText, 8000),
      };
    },
  });
}
