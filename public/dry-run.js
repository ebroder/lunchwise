import {
  h,
  render,
} from "https://esm.sh/preact@10.25.4?bundle-deps&target=es2022";
import { useState, useEffect } from "https://esm.sh/preact@10.25.4/hooks?bundle-deps&target=es2022";
import htm from "https://esm.sh/htm@3.1.1?bundle-deps&target=es2022";

var html = htm.bind(h);

var card =
  "bg-white dark:bg-stone-900 rounded-lg border border-stone-200 dark:border-stone-800";
var btnClass =
  "bg-stone-900 dark:bg-white text-white dark:text-stone-900 px-6 py-2 rounded-lg text-sm font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition-colors";

function badgeClass(type) {
  if (type === "create")
    return "text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-950/50 border-green-200 dark:border-green-800";
  if (type === "update")
    return "text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/50 border-blue-200 dark:border-blue-800";
  return "text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/50 border-red-200 dark:border-red-800";
}

function formatAmount(amount, currency) {
  var abs = Math.abs(amount).toFixed(2);
  if (amount < 0) return "-" + currency + " " + abs + " (credit)";
  return currency + " " + abs;
}

function DryRunResults({ linkId }) {
  var [state, setState] = useState("idle"); // idle | loading | done | error
  var [data, setData] = useState(null);
  var [error, setError] = useState(null);

  function run() {
    setState("loading");
    setError(null);
    fetch("/api/links/" + linkId + "/dry-run")
      .then(function (r) {
        return r.json();
      })
      .then(function (result) {
        if (result.error) {
          setError(result.error);
          setState("error");
        } else {
          setData(result);
          setState("done");
        }
      })
      .catch(function (err) {
        setError(String(err));
        setState("error");
      });
  }

  useEffect(
    function () {
      if (location.search.indexOf("dry-run") !== -1) run();

      var btn = document.getElementById("dry-run-btn");
      if (btn) btn.addEventListener("click", run);
      return function () {
        if (btn) btn.removeEventListener("click", run);
      };
    },
    [linkId],
  );

  if (state === "idle") return null;

  if (state === "loading") {
    return html`<p class="text-sm text-stone-500 dark:text-stone-400">
      Loading dry run...
    </p>`;
  }

  if (state === "error") {
    return html`<div
      class="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-4 py-3 text-sm"
    >
      ${error}
    </div>`;
  }

  var actions = data.actions || [];

  return html`
    <h2 class="text-lg font-semibold mb-1">Dry Run Results</h2>
    <p class="text-sm text-stone-500 dark:text-stone-400 mb-4">
      No changes were made. This shows what a sync would do.
    </p>

    <div class="${card} p-4 mb-4">
      <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span
          >Expenses fetched:${" "}
          <span class="font-medium">${data.expenses_fetched}</span></span
        >
        <span
          >Would create:${" "}
          <span class="font-medium text-green-700 dark:text-green-400"
            >${data.created}</span
          ></span
        >
        <span
          >Would update:${" "}
          <span class="font-medium text-blue-700 dark:text-blue-400"
            >${data.updated}</span
          ></span
        >
        <span
          >Would delete:${" "}
          <span class="font-medium text-red-700 dark:text-red-400"
            >${data.deleted}</span
          ></span
        >
      </div>
    </div>

    ${actions.length === 0
      ? html`<p class="text-sm text-stone-500 dark:text-stone-400">
          Nothing to sync.
        </p>`
      : html`
          <div class="${card} overflow-hidden">
            <table class="w-full text-sm">
              <thead
                class="bg-stone-50 dark:bg-stone-800/50 border-b border-stone-200 dark:border-stone-800"
              >
                <tr>
                  <th
                    class="text-left px-4 py-2 font-medium text-stone-600 dark:text-stone-400"
                  >
                    Action
                  </th>
                  <th
                    class="text-left px-4 py-2 font-medium text-stone-600 dark:text-stone-400"
                  >
                    Date
                  </th>
                  <th
                    class="text-left px-4 py-2 font-medium text-stone-600 dark:text-stone-400"
                  >
                    Payee
                  </th>
                  <th
                    class="text-right px-4 py-2 font-medium text-stone-600 dark:text-stone-400"
                  >
                    Your Share
                  </th>
                  <th
                    class="text-right px-4 py-2 font-medium text-stone-600 dark:text-stone-400"
                  >
                    Expense ID
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-stone-100 dark:divide-stone-800">
                ${actions.map(
                  (a) => html`
                    <tr>
                      <td class="px-4 py-2">
                        <span
                          class="inline-block px-2 py-0.5 rounded border text-xs font-medium ${badgeClass(
                            a.type,
                          )}"
                          >${a.type}</span
                        >
                      </td>
                      <td class="px-4 py-2 text-stone-700 dark:text-stone-300">
                        ${a.date}
                      </td>
                      <td
                        class="px-4 py-2 text-stone-700 dark:text-stone-300 max-w-xs truncate"
                      >
                        ${a.payee}
                      </td>
                      <td
                        class="px-4 py-2 text-right tabular-nums ${a.amount < 0
                          ? "text-green-700 dark:text-green-400"
                          : "text-stone-700 dark:text-stone-300"}"
                      >
                        ${formatAmount(a.amount, a.currency)}
                      </td>
                      <td
                        class="px-4 py-2 text-right text-stone-400 dark:text-stone-500 tabular-nums"
                      >
                        ${a.expenseId}
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
          <div class="mt-4 flex gap-3">
            <form method="post" action="${"/api/sync/" + linkId}">
              <button type="submit" class="${btnClass}">
                Run Sync for Real
              </button>
            </form>
          </div>
        `}
  `;
}

var el = document.getElementById("dry-run-results");
if (el) {
  var linkId = el.getAttribute("data-link-id");
  el.className = "mt-8";
  render(html`<${DryRunResults} linkId=${linkId} />`, el);
}
