import { Hono } from "hono";
import { getUserId } from "../lib/auth.js";

const landing = new Hono();

landing.get("/", async (c) => {
  const userId = await getUserId(c);
  if (userId) {
    return c.redirect("/dashboard");
  }

  return c.render(
    <>
      {/* Nav */}
      <nav class="px-6 py-5">
        <div class="max-w-5xl mx-auto flex items-center justify-between">
          <span class="font-serif text-xl">Lunchwise</span>
          <a
            href="/auth/splitwise"
            class="text-sm font-medium text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 transition-colors cursor-pointer"
          >
            Sign in
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section class="hero-glow pt-20 pb-28 px-6">
        <div class="max-w-2xl mx-auto text-center">
          <p class="animate-fade-up text-amber-700 dark:text-amber-500 font-semibold text-xs tracking-[0.2em] uppercase mb-6">
            Splitwise &rarr; Lunch Money
          </p>
          <h1
            class="animate-fade-up font-serif text-5xl md:text-6xl leading-[1.1]"
            style="animation-delay: 0.1s"
          >
            Your shared expenses,
            <br />
            always in your budget.
          </h1>
          <p
            class="animate-fade-up text-lg text-stone-500 dark:text-stone-400 mt-8 max-w-lg mx-auto leading-relaxed"
            style="animation-delay: 0.2s"
          >
            Lunchwise syncs your Splitwise expenses into Lunch Money automatically. No more manual
            entry, no missed transactions.
          </p>
          <div class="animate-fade-up mt-12" style="animation-delay: 0.3s">
            <a
              href="/auth/splitwise"
              class="inline-block bg-stone-900 dark:bg-white text-white dark:text-stone-900 px-8 py-4 rounded-full text-base font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition-colors shadow-sm cursor-pointer"
            >
              Connect with Splitwise &rarr;
            </a>
          </div>
        </div>
      </section>

      {/* Divider */}
      <div class="max-w-5xl mx-auto px-6">
        <hr class="border-stone-200 dark:border-stone-800" />
      </div>

      {/* Features */}
      <section class="py-20 px-6">
        <div class="max-w-4xl mx-auto grid md:grid-cols-3 gap-12 md:gap-16">
          <div>
            <div class="font-serif text-2xl text-amber-700/70 dark:text-amber-500/70 mb-3">01</div>
            <h3 class="font-semibold mb-2">Automatic sync</h3>
            <p class="text-sm text-stone-500 dark:text-stone-400 leading-relaxed">
              New Splitwise expenses appear in Lunch Money within hours. Amounts and descriptions
              all carry over.
            </p>
          </div>
          <div>
            <div class="font-serif text-2xl text-amber-700/70 dark:text-amber-500/70 mb-3">02</div>
            <h3 class="font-semibold mb-2">Preview first</h3>
            <p class="text-sm text-stone-500 dark:text-stone-400 leading-relaxed">
              Dry run any sync to see exactly what will be created, updated, or removed before it
              touches your data.
            </p>
          </div>
          <div>
            <div class="font-serif text-2xl text-amber-700/70 dark:text-amber-500/70 mb-3">03</div>
            <h3 class="font-semibold mb-2">Isolated by design</h3>
            <p class="text-sm text-stone-500 dark:text-stone-400 leading-relaxed">
              Your credentials live in a dedicated database. No shared tables, no cross-user
              queries.
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section class="py-20 px-6 bg-stone-100/80 dark:bg-stone-900/60">
        <div class="max-w-3xl mx-auto text-center">
          <h2 class="font-serif text-3xl mb-14">How it works</h2>
          <div class="flex flex-col md:flex-row items-center justify-center gap-6 md:gap-10">
            <div class="bg-white dark:bg-stone-800 rounded-xl px-8 py-6 border border-stone-200 dark:border-stone-700 shadow-sm w-56">
              <div class="text-[10px] font-semibold text-stone-400 dark:text-stone-500 uppercase tracking-[0.15em] mb-1">
                From
              </div>
              <div class="font-serif text-xl">Splitwise</div>
              <div class="text-sm text-stone-500 dark:text-stone-400 mt-1">
                Shared expenses &amp; payments
              </div>
            </div>
            <div class="text-stone-300 dark:text-stone-600 text-2xl font-light hidden md:block">
              &rarr;
            </div>
            <div class="text-stone-300 dark:text-stone-600 text-2xl font-light md:hidden">
              &darr;
            </div>
            <div class="bg-white dark:bg-stone-800 rounded-xl px-8 py-6 border border-stone-200 dark:border-stone-700 shadow-sm w-56">
              <div class="text-[10px] font-semibold text-stone-400 dark:text-stone-500 uppercase tracking-[0.15em] mb-1">
                Into
              </div>
              <div class="font-serif text-xl">Lunch Money</div>
              <div class="text-sm text-stone-500 dark:text-stone-400 mt-1">
                Your personal budget
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Bottom CTA */}
      <section class="py-24 px-6">
        <div class="max-w-2xl mx-auto text-center">
          <h2 class="font-serif text-3xl mb-4">Ready to connect?</h2>
          <p class="text-stone-500 dark:text-stone-400 mb-10">
            Link your Splitwise account to get started. You'll add your Lunch Money API key after.
          </p>
          <a
            href="/auth/splitwise"
            class="inline-block bg-stone-900 dark:bg-white text-white dark:text-stone-900 px-8 py-4 rounded-full text-base font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition-colors shadow-sm cursor-pointer"
          >
            Connect with Splitwise &rarr;
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer class="border-t border-stone-200 dark:border-stone-800 py-8 px-6">
        <div class="max-w-5xl mx-auto flex items-center justify-center gap-4 text-sm text-stone-400 dark:text-stone-600">
          <span>Lunchwise</span>
          <span>&middot;</span>
          <a
            href="/privacy"
            class="hover:text-stone-600 dark:hover:text-stone-400 transition-colors"
          >
            Privacy
          </a>
          <a href="/terms" class="hover:text-stone-600 dark:hover:text-stone-400 transition-colors">
            Terms
          </a>
          <span>&middot;</span>
          <a
            href="https://github.com/ebroder/lunchwise"
            class="hover:text-stone-600 dark:hover:text-stone-400 transition-colors"
          >
            GitHub
          </a>
        </div>
      </footer>
    </>,
    { title: "Home", bare: true },
  );
});

export { landing };
