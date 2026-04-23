import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import '@mcp-b/global';
import { companyProfileQueryOptions } from '../api/companiesHouse';
import { searchHmrcQueryOptions } from '../api/hmrc';
import { titleCase } from '../utils';

/**
 * Registers browser-side MCP tools with `navigator.modelContext` (via
 * `@mcp-b/global`) so AI agents can query UK visa sponsor data through the
 * same server fns the UI uses: `search_uk_visa_sponsors` for paginated
 * fuzzy search and `get_uk_visa_sponsor_details` for combined HMRC +
 * Companies House detail. Renders nothing; returns early when the MCP host
 * is not available and unregisters all tools on unmount.
 */
export function McpTools() {
  const queryClient = useQueryClient();

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

        const result = await queryClient.ensureQueryData(
          searchHmrcQueryOptions(query, offset),
        );

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

    ctx.registerTool({
      name: 'get_uk_visa_sponsor_details',
      description:
        'Get detailed information about a specific UK visa sponsor by company name, combining HMRC sponsorship data (location, visa routes, sponsor ratings) with Companies House registration data (company number, status, incorporation date, registered address, industry/SIC descriptions). Use the exact name returned by search_uk_visa_sponsors for best results.',
      inputSchema: {
        type: 'object',
        properties: {
          companyName: {
            type: 'string',
            description:
              'Full or partial company name (minimum 3 characters). Prefer the exact name returned by search_uk_visa_sponsors.',
          },
        },
        required: ['companyName'],
      },
      execute: async ({ companyName }: { companyName: string }) => {
        if (!companyName || companyName.length < 3) {
          return {
            content: [
              {
                type: 'text',
                text: 'Please provide a company name with at least 3 characters.',
              },
            ],
          };
        }

        const hmrcResult = await queryClient.ensureQueryData(
          searchHmrcQueryOptions(companyName, 0),
        );

        if (!hmrcResult.rows.length) {
          return {
            content: [
              {
                type: 'text',
                text: `No UK visa sponsor found matching "${companyName}".`,
              },
            ],
          };
        }

        const top = hmrcResult.rows[0];
        const profile = await queryClient.ensureQueryData(
          companyProfileQueryOptions(top.organisationName),
        );

        const sponsorship = hmrcResult.rows
          .filter(
            (row) =>
              row.organisationName.toLowerCase() ===
              top.organisationName.toLowerCase(),
          )
          .map((row) => ({
            visaRoute: titleCase(row.route),
            rating: titleCase(row.typeRating),
          }));

        const details = {
          name: titleCase(top.organisationName),
          location:
            [top.townCity, top.county]
              .filter(Boolean)
              .map(titleCase)
              .join(', ') || null,
          sponsorship,
          companiesHouse: profile
            ? {
                companyNumber: profile.company_number,
                status: profile.company_status,
                type: profile.type,
                incorporatedOn: profile.date_of_creation,
                lastAccountsFiledTo:
                  profile.accounts?.last_accounts?.made_up_to ?? null,
                registeredAddress: profile.registered_office_address,
                industries: profile.sicDescriptions,
              }
            : null,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(details, null, 2),
            },
          ],
        };
      },
    });

    return () => {
      ctx.unregisterTool('search_uk_visa_sponsors');
      ctx.unregisterTool('get_uk_visa_sponsor_details');
    };
  }, [queryClient]);

  return null;
}
