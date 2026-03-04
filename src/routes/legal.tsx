import { Hono } from "hono";
import type { FC, PropsWithChildren } from "hono/jsx";

const Section: FC<PropsWithChildren<{ title: string }>> = ({
  title,
  children,
}) => (
  <section class="mb-10">
    <h2 class="font-serif text-2xl mb-4">{title}</h2>
    {children}
  </section>
);

const P: FC<PropsWithChildren> = ({ children }) => (
  <p class="text-stone-600 dark:text-stone-400 leading-relaxed mb-4">
    {children}
  </p>
);

const LegalPage: FC<PropsWithChildren<{ title: string }>> = ({
  title,
  children,
}) => (
  <>
    <nav class="px-6 py-5">
      <div class="max-w-3xl mx-auto flex items-center justify-between">
        <a href="/" class="font-serif text-xl">
          Lunchwise
        </a>
        <a
          href="/"
          class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
        >
          &larr; Home
        </a>
      </div>
    </nav>
    <main class="max-w-3xl mx-auto px-6 py-12">
      <h1 class="font-serif text-4xl mb-10">{title}</h1>
      {children}
    </main>
    <footer class="border-t border-stone-200 dark:border-stone-800 py-8 px-6">
      <div class="max-w-3xl mx-auto text-center text-sm text-stone-400 dark:text-stone-600">
        Lunchwise
      </div>
    </footer>
  </>
);

const legal = new Hono();

legal.get("/privacy", (c) => {
  return c.render(
    <LegalPage title="Privacy Policy">
      <P>
        Last updated: March 3, 2026. Lunchwise is operated by Evan Broder.
        This policy describes what data Lunchwise collects, how it is used, and
        your choices.
      </P>

      <Section title="What Lunchwise does">
        <P>
          Lunchwise syncs shared expenses from Splitwise into Lunch Money, a
          personal budgeting app. You authenticate with Splitwise via OAuth,
          provide a Lunch Money API key, and configure which Splitwise group maps
          to which Lunch Money account. A background job syncs enabled links
          every two hours.
        </P>
      </Section>

      <Section title="Data we collect">
        <P>When you sign in, Lunchwise stores:</P>
        <ul class="list-disc pl-6 text-stone-600 dark:text-stone-400 leading-relaxed mb-4 space-y-1">
          <li>
            Your <strong>Splitwise user ID</strong> (used to identify your
            account)
          </li>
          <li>
            Your <strong>Splitwise OAuth access token</strong> (to read your
            expenses)
          </li>
          <li>
            Your <strong>Lunch Money API key</strong> (to create and update
            transactions)
          </li>
          <li>
            <strong>Sync link configuration</strong> (which Splitwise group maps
            to which Lunch Money account, start date, and preferences)
          </li>
          <li>
            <strong>Transaction mapping IDs</strong> (which Splitwise expense
            corresponds to which Lunch Money transaction, for change detection)
          </li>
          <li>
            <strong>Sync logs</strong> (timestamps, success/error status, and
            counts of created/updated/deleted transactions)
          </li>
        </ul>
      </Section>

      <Section title="Data we access but do not store">
        <P>
          During each sync, Lunchwise reads your Splitwise expenses (including
          descriptions, amounts, dates, categories, and participant shares) and
          your Lunch Money transactions for the linked account. This data is used
          only to compute what needs to be created, updated, or deleted. Expense
          details are not persisted beyond the transaction mapping IDs listed
          above.
        </P>
      </Section>

      <Section title="How credentials are protected">
        <P>
          Your Splitwise access token and Lunch Money API key are encrypted at
          rest using AES-GCM authenticated encryption before being written to
          the database. Each user's data is stored in a dedicated, isolated
          database instance with no cross-user queries.
        </P>
      </Section>

      <Section title="Cookies">
        <P>
          Lunchwise uses a single <code>httpOnly</code> session cookie
          containing a signed JWT with your user ID. The cookie expires after 30
          days. No third-party cookies are set.
        </P>
      </Section>

      <Section title="Analytics">
        <P>
          Lunchwise may collect aggregated, non-identifying usage data (such as
          sync counts, error rates, and feature usage) to improve the service.
          This data cannot be tied to individual users. There is no third-party
          tracking or advertising.
        </P>
      </Section>

      <Section title="Third-party services">
        <P>Lunchwise relies on the following third-party services:</P>
        <ul class="list-disc pl-6 text-stone-600 dark:text-stone-400 leading-relaxed mb-4 space-y-1">
          <li>
            <strong>Splitwise</strong> (OAuth authentication and expense data)
          </li>
          <li>
            <strong>Lunch Money</strong> (transaction management via API)
          </li>
          <li>
            <strong>Turso</strong> (database hosting)
          </li>
          <li>
            <strong>Cloudflare Workers</strong> (application hosting)
          </li>
        </ul>
        <P>
          Each service has its own privacy policy. Lunchwise does not sell or
          share your data with any other parties.
        </P>
      </Section>

      <Section title="Data retention and deletion">
        <P>
          Your credentials and sync data are stored as long as your account is
          active. You can revoke Lunchwise's access at any time by removing the
          app from your Splitwise connected apps and deleting your Lunch Money
          API key. To request deletion of your stored data, email{" "}
          <a
            href="mailto:evan@lunchwise.app"
            class="underline hover:text-stone-900 dark:hover:text-stone-100"
          >
            evan@lunchwise.app
          </a>
          .
        </P>
      </Section>

      <Section title="Changes to this policy">
        <P>
          If this policy changes materially, the updated version will be posted
          here with a new date.
        </P>
      </Section>

      <Section title="Contact">
        <P>
          Questions or concerns? Email{" "}
          <a
            href="mailto:evan@lunchwise.app"
            class="underline hover:text-stone-900 dark:hover:text-stone-100"
          >
            evan@lunchwise.app
          </a>
          .
        </P>
      </Section>
    </LegalPage>,
    { title: "Privacy Policy", bare: true },
  );
});

legal.get("/terms", (c) => {
  return c.render(
    <LegalPage title="Terms of Service">
      <P>
        Last updated: March 3, 2026. These terms govern your use of Lunchwise,
        operated by Evan Broder.
      </P>

      <Section title="What Lunchwise is">
        <P>
          Lunchwise is a free tool that syncs shared expenses from Splitwise into
          Lunch Money. It reads expenses from a Splitwise group you choose and
          creates corresponding transactions in a Lunch Money manual account you
          designate.
        </P>
      </Section>

      <Section title="Account requirements">
        <P>
          To use Lunchwise, you need an existing Splitwise account and a Lunch
          Money account with an API key. Lunchwise does not create accounts on
          either platform on your behalf.
        </P>
      </Section>

      <Section title="Your responsibilities">
        <P>You are responsible for:</P>
        <ul class="list-disc pl-6 text-stone-600 dark:text-stone-400 leading-relaxed mb-4 space-y-1">
          <li>
            Keeping your Lunch Money API key confidential. Lunchwise encrypts it
            at rest, but you should not share it elsewhere.
          </li>
          <li>
            Ensuring your sync links are configured correctly (correct group,
            correct account).
          </li>
          <li>
            Reviewing synced transactions in Lunch Money. Lunchwise provides a
            dry-run preview feature for this purpose.
          </li>
        </ul>
      </Section>

      <Section title="Service availability">
        <P>
          Lunchwise is provided free of charge. The service may be modified,
          suspended, or discontinued at any time without notice. Syncs run on a
          schedule and depend on the availability of both Splitwise and Lunch
          Money APIs.
        </P>
      </Section>

      <Section title="Limitation of liability">
        <P>
          Lunchwise is provided "as is" without warranty of any kind. To the
          fullest extent permitted by law, the operator is not liable for any
          damages arising from your use of the service, including but not limited
          to incorrect transaction data, missed syncs, or data loss.
        </P>
      </Section>

      <Section title="Termination">
        <P>
          You can stop using Lunchwise at any time by disabling your sync links
          and revoking access from Splitwise. The operator may terminate or
          suspend your access at any time for any reason.
        </P>
      </Section>

      <Section title="Changes to these terms">
        <P>
          These terms may be updated from time to time. Continued use of
          Lunchwise after changes constitutes acceptance of the revised terms.
        </P>
      </Section>

      <Section title="Contact">
        <P>
          Questions? Email{" "}
          <a
            href="mailto:evan@lunchwise.app"
            class="underline hover:text-stone-900 dark:hover:text-stone-100"
          >
            evan@lunchwise.app
          </a>
          .
        </P>
      </Section>
    </LegalPage>,
    { title: "Terms of Service", bare: true },
  );
});

export { legal };
