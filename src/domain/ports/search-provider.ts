import type { SearchResultHit } from '../../lib/types';

export interface SearchProviderQuery {
  query: string;
  numResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchProvider {
  search(input: SearchProviderQuery): Promise<SearchResultHit[]>;
}
