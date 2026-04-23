import { describe, it, expect } from 'vitest';
import { crawlDApp, type CrawlResult } from '../src/phases/context.js';

describe('Context Phase', () => {
  it('exports crawlDApp function', () => {
    expect(typeof crawlDApp).toBe('function');
  });

  it('CrawlResult type has required shape', () => {
    // Validate the expected shape of CrawlResult at the type level
    const mockResult: CrawlResult = {
      context: {
        url: 'https://example.com',
        title: 'Test',
        description: 'A test dApp',
        docsContent: '',
        features: ['trading'],
      },
      pages: [],
      navLinks: [],
    };

    expect(mockResult.context.url).toBe('https://example.com');
    expect(mockResult.context.features).toContain('trading');
    expect(mockResult.pages).toEqual([]);
    expect(mockResult.navLinks).toEqual([]);
  });
});
