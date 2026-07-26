/** Meta entries emitting each schema as its own <script type="application/ld+json"> tag. 'script:ld+json' is supported at runtime but not exposed in the framework's meta types, hence the cast. */
export function jsonLdMeta(schemas: object[]) {
  return schemas.map(
    (schema) => ({ 'script:ld+json': schema }) as unknown as { name: string },
  );
}

/** Build a page's SEO head — title, matching description, the og:/twitter: overrides that share that copy, any JSON-LD blocks, and the canonical link. Site-wide tags (og:image, og:site_name, twitter:card, PWA) stay in __root and are inherited. */
export function buildSeoHead(input: {
  title: string;
  description: string;
  canonicalUrl: string;
  jsonLd?: object[];
}) {
  return {
    meta: [
      { title: input.title },
      { name: 'description', content: input.description },
      { property: 'og:title', content: input.title },
      { property: 'og:description', content: input.description },
      { property: 'og:url', content: input.canonicalUrl },
      { name: 'twitter:title', content: input.title },
      { name: 'twitter:description', content: input.description },
      { name: 'twitter:url', content: input.canonicalUrl },
      ...jsonLdMeta(input.jsonLd ?? []),
    ],
    links: [{ rel: 'canonical', href: input.canonicalUrl }],
  };
}
