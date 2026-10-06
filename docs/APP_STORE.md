# Getting StockOrNot on the App Store

*Started October 2026. Claude reads this before any app work; tick steps off
here as they are done.*

No Mac is needed. The app stays the website it already is, wrapped for the
iPhone with [Capacitor](https://capacitorjs.com), and built and sent to Apple
by a cloud service running Apple's tools on its own Macs. An iPhone is needed
only to try the test builds.

The account rules in [`CLAUDE.md`](../CLAUDE.md) still apply: one pull request
a day, and a new connected app (the build service) or a large number of new
files only with the owner's OK.

## Decisions for the owner

1. **Business or personal developer account.** Apple wants finance apps
   published by a legal business, not a person (App Review Guideline
   5.1.1(ix)), and placing brokerage orders is what makes this one a finance
   app. Either:
   - form an LLC and enrol as that business (recommended if the iPhone app
     keeps order placing; sensible for a finance site anyway), or
   - enrol personally and leave order placing out of the iPhone app, keeping
     the deck, the score, the cart and alerts.
2. **Android as well?** Google Play costs $25 once and needs no Mac.
3. **Which build service.** Capawesome Cloud, Capgo Build or Codemagic. Each
   needs read access to the `stockornot` repository, which counts as a new
   connected app.
4. **Membership in the app.** Selling it inside an iPhone app means Apple's
   in-app purchase, or (in the US) a link to a web checkout while Apple's
   appeal runs. Recommended: the app is free at launch, as the site is today.

## Steps only the owner can do

Never paste a key, password or code into the chat; each goes straight into
the service that needs it.

- [ ] **(Business route) Form the LLC** in your state, online.
- [ ] **(Business route) Get an EIN** from the IRS, free, online, minutes.
- [ ] **(Business route) Get a D-U-N-S number**, free, through Apple's
      D-U-N-S lookup on developer.apple.com. Allow about a week.
- [ ] **Enrol in the Apple Developer Program** at
      developer.apple.com/programs/enroll with your Apple ID (two-factor on),
      $99 a year. As a business: its legal name, the D-U-N-S number, a website
      (stockornot.com) and an email at that domain. Allow a few days.
- [ ] **In App Store Connect:** accept the agreements, then create the app:
      name StockOrNot, bundle ID `com.stockornot.app`, primary language
      English, SKU `stockornot-ios`.
- [ ] **Create an App Store Connect API key** (Users and Access → Integrations
      → Team keys, role App Manager) and enter it in the build service only.
- [ ] **Create an Apple push key** (Certificates, Identifiers & Profiles →
      Keys → Apple Push Notifications service) for earnings alerts; it goes
      into the GitHub Actions secrets, where the alerts are sent from, never
      the repository.
- [ ] **Approve the build service** and let it read `FrenchyTries/stockornot`
      only.
- [ ] **Install TestFlight** on your iPhone and accept the first test build.
- [ ] **(Android) Open a Google Play Console account.**

## Steps Claude does, one pull request a day

- [ ] **1. Installable from the browser.** A manifest, icons and a service
      worker, so "Add to Home Screen" gives a full-screen app with its own
      icon. Needs nothing from Apple.
- [ ] **2. The iPhone shell.** Capacitor's settings and the build service's
      pipeline, with the Xcode project generated in the cloud on each build
      rather than committed, so dozens of generated files stay out of git.
      First TestFlight build.
- [ ] **3. Bottom tabs.** Deck, Compare, Cart and Track record, the way phone
      apps are navigated, on the site and in the app alike.
- [ ] **4. Things only an app does.** A small vibration on each swipe, the
      phone's share sheet, and push notifications a week before anything in
      the cart reports. Apple turns down a website in a wrapper (Guideline
      4.2), and these are the difference.
- [ ] **5. Delete your account in the app.** Apple requires it (Guideline
      5.1.1(v)); today it is an email.
- [ ] **6. First-run guide.** Three short screens: what the score is, how to
      swipe, what the cart does.
- [ ] **7. The store listing.** Screenshots from `marketing/capture.cjs`
      (already 1290 × 2796), description and keywords, the privacy answers
      (an email address and a cart; no tracking, no ads), age rating, and notes
      for the reviewer with a test account.
- [ ] **8. Submit,** and answer the review.

## Before submitting, check

- Nothing in the app reads as advice: the "not investment advice" line is on
  every screen that shows a score.
- The privacy page matches the App Store privacy answers.
- A reviewer can reach every feature without paying and without a brokerage
  account.
- Order placing is either absent (personal account) or behind a clear
  confirmation, with Alpaca named (business account).

## How long

Mostly waiting on Apple and, on the business route, the D-U-N-S number: two
to four weeks from enrolment to the first submission, at one pull request a
day.
