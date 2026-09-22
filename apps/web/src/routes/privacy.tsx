import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/privacy')({
  head: () => ({
    meta: [
      { title: 'Privacy Policy — SponsorSearch.co.uk' },
      {
        name: 'description',
        content: 'Privacy policy for SponsorSearch.co.uk',
      },
    ],
  }),
  component: PrivacyPolicy,
});

/**
 * Static `/privacy` page detailing what the site does and does not collect,
 * plus UK GDPR rights and contact info. Purely presentational.
 */
function PrivacyPolicy() {
  return (
    <main className="page-wrap mx-auto max-w-2xl px-4 py-12 text-(--sea-ink) [&_a]:text-(--link-blue) [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:mt-2 [&_li]:leading-relaxed [&_p]:mt-3 [&_p]:leading-relaxed [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-6">
      <h1>Privacy Policy</h1>
      <p className="text-(--sea-ink-soft)">Last updated: 22 September 2026</p>

      <h2>Who we are</h2>
      <p>
        SponsorSearch.co.uk is a free tool that helps people search the UK Home
        Office register of licensed skilled worker visa sponsors. It is operated
        by Nikil Kuruvilla.
      </p>

      <h2>What data we collect</h2>
      <p>
        We collect <strong>minimal data</strong> to operate this service:
      </p>
      <ul>
        <li>
          <strong>Search queries.</strong> When you search for a company, the
          search term is logged on our server for operational and debugging
          purposes. These logs are not linked to your identity.
        </li>
        <li>
          <strong>Basic request data.</strong> Our hosting provider (Vercel)
          automatically collects standard web server logs including IP
          addresses, browser type, and pages visited. These are retained for up
          to 30 days.
        </li>
        <li>
          <strong>Aggregate usage and performance measurement.</strong> Our
          hosting provider&apos;s Vercel Web Analytics and Speed Insights count
          page views and measure page load times, using coarse request
          properties such as the page URL, referrer, country, and device and
          browser type. They set no cookies and do not track you across sites.
        </li>
        <li>
          <strong>Site protection.</strong> To detect and limit automated
          abuse of the service, your browser sends a technical identifier
          derived from its general characteristics while you use the site. It
          is used only for keeping the service secure and available, not for
          product analytics or advertising. We keep aggregate daily counts for
          up to six months, and the identifier is never linked to your name or
          any account.
        </li>
        <li>
          <strong>Theme preference.</strong> Your light/dark mode choice is
          stored in your browser&apos;s local storage. This never leaves your
          device.
        </li>
      </ul>

      <h2>What we do not collect</h2>
      <ul>
        <li>
          We do not use advertising, profiling or cross-site tracking cookies
        </li>
        <li>We do not use advertising or cross-site tracking scripts</li>
        <li>
          We do not require user accounts or collect account or profile
          information
        </li>
        <li>We do not sell or share data with third parties</li>
      </ul>

      <h2>Third-party services</h2>
      <p>
        We use third-party services to host this website and to fetch publicly
        available company data from UK government sources. These services may
        process basic request data (such as IP addresses) in accordance with
        their own privacy policies.
      </p>

      <h2>Data retention</h2>
      <p>
        Server logs including search queries are automatically deleted after a
        short retention period (up to 30 days). We do not store search queries
        in our own database.
      </p>

      <h2>Your rights</h2>
      <p>
        Under UK GDPR, you have the right to access, correct, or delete any
        personal data we hold. The request logs described above are not linked
        to a name or an account and are deleted within 30 days, so we usually
        cannot identify which records are yours. If you have concerns, please
        contact us.
      </p>

      <h2>Contact</h2>
      <p>
        If you have questions about this privacy policy, you can reach us on{' '}
        <a href="https://x.com/NikilKuruvilla" target="_blank" rel="noreferrer">
          X (Twitter)
        </a>
        .
      </p>

      <div className="mt-8">
        <Link to="/" search={{ search: '' }} className="text-(--link-blue)">
          &larr; Back to search
        </Link>
      </div>
    </main>
  );
}
