import { AsyncLocalStorage } from "node:async_hooks";

// Workers Free allows 50 outgoing subrequests per invocation, Sentry's sends included. A user
// sync stops at the budget so the rest can carry its Sentry reports, and warns past 35.
const SUBREQUEST_LIMIT = 50;
export const REQUEST_BUDGET = SUBREQUEST_LIMIT - 5;
export const REQUEST_WARNING = 35;

export class RequestBudgetExceededError extends Error {
  constructor(used: number) {
    super(`Request budget of ${REQUEST_BUDGET} exhausted after ${used} requests`);
    this.name = "RequestBudgetExceededError";
  }
}

interface Budget {
  used: number;
  exceeded: boolean;
}

// per invocation, not per isolate: concurrent invocations can share an isolate
const budgets = new AsyncLocalStorage<Budget>();

export function withRequestBudget<T>(fn: () => Promise<T>): Promise<T> {
  return budgets.run({ used: 0, exceeded: false }, fn);
}

export function requestsUsed(): number {
  return budgets.getStore()?.used ?? 0;
}

export function requestBudgetExceeded(): boolean {
  return budgets.getStore()?.exceeded ?? false;
}

export async function countedFetch(
  input: RequestInfo | URL,
  init?: RequestInit<RequestInitCfProperties>,
): Promise<Response> {
  const budget = budgets.getStore();
  if (budget) {
    if (budget.used >= REQUEST_BUDGET) {
      budget.exceeded = true;
      throw new RequestBudgetExceededError(budget.used);
    }
    budget.used++;
  }
  return globalThis.fetch(input, init);
}
