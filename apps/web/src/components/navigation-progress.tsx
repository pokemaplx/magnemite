"use client";

import { ProgressProvider } from "@bprogress/next/app";

/**
 * A bar across the top while the next page is on its way.
 *
 * Every dashboard route is rendered on the server per request, so between a
 * click and the page there is a round trip with nothing on screen to say it
 * was heard — worst on a phone, where the menu has already slid away. Links
 * start it on their own; `router.push` only does through the `useRouter` from
 * `@bprogress/next/app`, which the places that navigate in code use.
 *
 * The colour is the token rather than a hex, so the bar stays the brand yellow
 * if the brand yellow ever moves. No spinner: the bar is the whole signal, and
 * on a phone the spinner's corner is where the search button sits.
 */
export function NavigationProgress({ children }: { children: React.ReactNode }) {
  return (
    <ProgressProvider color="var(--primary)" height="3px" options={{ showSpinner: false }}>
      {children}
    </ProgressProvider>
  );
}
