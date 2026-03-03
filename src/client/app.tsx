import { Route, Switch, Link } from "wouter";
import { Dashboard } from "./pages/dashboard.js";
import { LinkNew } from "./pages/link-new.js";
import { LinkEdit } from "./pages/link-edit.js";
import { LinkHistory } from "./pages/link-history.js";

export function App() {
  return (
    <>
      <nav class="border-b border-stone-200 dark:border-stone-800">
        <div class="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/dashboard" class="font-serif text-xl">
            Lunchwise
          </Link>
          <a
            href="/auth/logout"
            class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
          >
            Log out
          </a>
        </div>
      </nav>
      <main class="max-w-4xl mx-auto px-6 py-8">
        <Switch>
          <Route path="/dashboard" component={Dashboard} />
          <Route path="/dashboard/links/new" component={LinkNew} />
          <Route path="/dashboard/links/:id/history" component={LinkHistory} />
          <Route path="/dashboard/links/:id" component={LinkEdit} />
          <Route>
            <p>Page not found.</p>
          </Route>
        </Switch>
      </main>
    </>
  );
}
