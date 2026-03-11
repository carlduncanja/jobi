import type { Logger } from '../../config/logger';
import type { SearchProvider, SearchProviderQuery } from '../../domain/ports/search-provider';
import type { SearchResultHit } from '../../lib/types';

interface ExaSearchOptions {
  apiKey: string;
  logger: Logger;
}

interface ExaApiResponse {
  results?: Array<{
    title?: string;
    url?: string;
    text?: string;
    publishedDate?: string;
    author?: string;
    highlights?: string[];
    highlightScores?: number[];
  }>;
}

export class ExaSearchProvider implements SearchProvider {
  constructor(private readonly options: ExaSearchOptions) {}

  async search(input: SearchProviderQuery): Promise<SearchResultHit[]> {
    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
      },
      body: JSON.stringify({
        query: input.query,
        type: 'fast',
        numResults: input.numResults ?? 5,
        includeDomains: input.includeDomains,
        excludeDomains: input.excludeDomains,
        contents: {
          text: { maxCharacters: 3000 },
          highlights: {
            numSentences: 3,
            highlightsPerUrl: 3,
            query: input.query,
          },
          livecrawl: 'fallback',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.options.logger.error({ errorText, query: input.query }, 'Exa search failed');
      throw new Error(`Exa search failed with status ${response.status}`);
    }

    const payload = (await response.json()) as ExaApiResponse;

    return (payload.results ?? [])
      .filter((result): result is Required<Pick<typeof result, 'title' | 'url'>> & typeof result => {
        return Boolean(result.title && result.url);
      })
      .map((result) => ({
        title: result.title,
        url: result.url,
        text: result.text,
        author: result.author,
        publishedAt: result.publishedDate,
        highlights: (result.highlights ?? []).map((text, index) => ({
          text,
          score: result.highlightScores?.[index],
        })),
      }));
  }
}
