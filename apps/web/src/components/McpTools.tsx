import { useEffect } from 'react';
import '@mcp-b/global';
import { searchHmrc } from '../api/hmrc';
import { titleCase } from '../utils';

export function McpTools() {
  useEffect(() => {
    const ctx = navigator.modelContext;
    if (!ctx) return;

    ctx.registerTool({
      name: 'search_uk_visa_sponsors',
      description:
        'Search for UK companies licensed to sponsor skilled worker visas. Returns company name, location, visa route, and sponsor rating.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Company name or partial name to search for (minimum 3 characters)',
          },
          offset: {
            type: 'number',
            description:
              'Pagination offset. Start at 0, increment by 50 to get the next page. Only use when hasMore is true in a previous response.',
          },
        },
        required: ['query'],
      },
      execute: async ({
        query,
        offset = 0,
      }: {
        query: string;
        offset?: number;
      }) => {
        if (!query || query.length < 3) {
          return {
            content: [
              {
                type: 'text',
                text: 'Please provide at least 3 characters to search.',
              },
            ],
          };
        }

        const result = await searchHmrc({
          data: { query, offset },
        });

        if (!result.rows.length) {
          return {
            content: [
              {
                type: 'text',
                text: `No UK visa sponsors found matching "${query}".`,
              },
            ],
          };
        }

        const formatted = result.rows.map((row) => ({
          name: titleCase(row.organisationName),
          location: [row.townCity, row.county]
            .filter(Boolean)
            .map(titleCase)
            .join(', '),
          visaRoute: titleCase(row.route),
          rating: titleCase(row.typeRating),
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  query,
                  totalResults: formatted.length,
                  hasMore: result.hasMore,
                  sponsors: formatted,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    });

    return () => {
      ctx.unregisterTool('search_uk_visa_sponsors');
    };
  }, []);

  return null;
}
