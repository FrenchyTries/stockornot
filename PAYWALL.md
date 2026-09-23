# The paywall, and the part of it that does not exist yet

> **Switched off for development.** `DEV_UNLIMITED = true` in `lib/tier.mjs`
> treats every visitor as a member: unlimited companies, unlimited cart. Flip it
> back to `false` to restore the tiers below. Nothing else needs to change.

The tiers are built. The enforcement is not. This file is the honest account of
the gap, so nobody ships a payment button on top of a gate that does not hold.

## What works today

`lib/tier.mjs` decides what the interface offers:

| | Companies | Cart | Earnings emails |
|---|---|---|---|
| Signed out | 5 | 3 | — |
| Free account | 10 | 10 | — |
| Member | all | unlimited | yes |

`lib/tier.mjs` also carries `screens` and `search` flags for members. Neither
feature is built yet, so neither is offered on the pricing page.

The count is of distinct companies opened, held in `localStorage` under
`ts.viewed`. Companies already opened stay open permanently. Tier comes from a
single row in `public.subscriptions`, readable only by its owner and writable
only by the service_role key.

## What does not work

**`data/snapshot.json` is a public URL.** Every company, every figure, in one
file, served by the site and mirrored on GitHub. Anyone who opens developer
tools, or simply types the address, has every company regardless of tier.

So the gate in the browser is a product decision, not a security boundary. It
shapes what an ordinary visitor is offered. It stops nobody who looks.

That is a reasonable place to be for a free product. It is **not** a reasonable
place to be the day money changes hands, because the first person to notice will
post the URL, and the paywall will have been decoration.

## What closing it actually takes

Three things, in order:

1. **Split the data.** A small public `data/free.json` carrying the companies a
   signed-out visitor is entitled to, plus whatever the company pages show. The
   full snapshot stops being served.

2. **Serve the rest through an authenticated endpoint.** A Supabase Edge
   Function or Vercel serverless function that reads the caller's session,
   checks `subscriptions`, and returns data only to a member. The browser asks
   for a company; the server decides.

3. **Make the repository private.** Otherwise the full snapshot stays readable
   at `raw.githubusercontent.com` and steps 1 and 2 achieve nothing. Vercel
   deploys private repositories without complaint; the GitHub Pages mirror at
   `respectking.github.io/tikstock/` would stop working and should be retired.

Roughly a day of work. None of it is hard, and all of it must be done before the
first charge.

## The other blockers, which are not code

- **Data licensing.** Finnhub's free tier is personal, non-commercial use only.
  Charging for a product built on it requires their paid tier, from about $50 a
  month. Yahoo's chart endpoint has no commercial licence at any price and must
  be replaced outright.

  SEC EDGAR is US government work in the public domain: the filings, the
  five-year financials and the risk factors carry no such restriction. The
  score does not escape the licence, though: most of its inputs (P/E, P/B,
  P/S, margins, returns on equity and assets, growth rates, beta, the 52-week
  range, dividend yield) are Finnhub's. Only free-cash-flow yield, cash
  conversion and years-to-repay-debt come from the filings alone.

- **Vercel Hobby is non-commercial.** Pro is $20 a month once revenue exists.

- **Regulation.** A paid subscription that scores securities engages the
  Investment Advisers Act. The publisher's exemption may well apply and is
  fact-specific. This needs a securities lawyer, not a guess.

- **A privacy policy and terms.** Required once money and email addresses are
  involved, and required by both app stores.

## Why the button says "Opening soon"

Because taking a card for a thing that cannot yet be delivered legally is worse
than waiting. The pricing page states this plainly rather than collecting
payment details into a drawer.
