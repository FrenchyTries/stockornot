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

## Decided (October 7, 2026)

- **A personal developer account for now.** Apple wants finance apps from a
  legal business (App Review Guideline 5.1.1(ix)), and placing brokerage
  orders is what makes this one a finance app. So the iPhone app launches
  without order placing: the deck, the score, the cart, earnings alerts and
  the track record. Order placing stays on the website.
- **A company later, when order placing comes to the app.** Apple converts a
  personal membership to an organization one (Account → Membership details →
  Update your information → Switch to organization membership; about three
  weeks to verify), so the app does not have to start over. Reviving the
  family's old California corporation was ruled out: every missed year since
  2015 owes at least $800 plus penalties before it can be revived. A new
  California LLC is about $70 to file and $800 a year.
- **Free at launch.** Membership can be sold later on a personal account too,
  through Apple's in-app purchase (15% with the Small Business Program); the
  website keeps its own checkout.

## Still open

1. **Android as well?** Google Play costs $25 once and needs no Mac.
2. **Which build service.** Capawesome Cloud, Capgo Build or Codemagic. Each
   needs read access to the `stockornot` repository, which counts as a new
   connected app.
3. **US only at first?** Selling in the EU on a personal account means the
   App Store shows your address and phone number (EU Digital Services Act).

## Steps only the owner can do

Never paste a key, password or code into the chat; each goes straight into
the service that needs it.

Now:

- [ ] **Enrol in the Apple Developer Program** as an individual, $99 a year,
      with your Apple ID (two-factor on). Easiest from the Apple Developer app
      on your iPhone, which checks your ID; or developer.apple.com/programs/enroll.
      Usually approved within a couple of days.
- [ ] **In App Store Connect:** accept the agreements, then create the app:
      name StockOrNot, bundle ID `com.stockornot.app`, primary language
      English, SKU `stockornot-ios`.
- [ ] **Choose the build service and approve it** to read
      `FrenchyTries/stockornot` only.
- [ ] **Create an App Store Connect API key** (Users and Access → Integrations
      → Team keys, role App Manager) and enter it in the build service only.
- [ ] **Install TestFlight** on your iPhone and accept the first test build.
- [ ] **Create an Apple push key** (Certificates, Identifiers & Profiles →
      Keys → Apple Push Notifications service) for earnings alerts; it goes
      into the GitHub Actions secrets, where the alerts are sent from, never
      the repository.
- [ ] **(Android) Open a Google Play Console account.**

Later, before charging for membership in the app:

- [ ] Accept the Paid Apps agreement and add bank and tax details in App
      Store Connect, and join the App Store Small Business Program.

Later, before order placing comes to the app:

- [ ] Form the company (an LLC), get its EIN from the IRS and a D-U-N-S
      number through Apple, then switch the Apple membership to organization.

## Steps Claude does, one pull request a day

- [x] **1. Installable from the browser.** A manifest, icons and a service
      worker, so "Add to Home Screen" gives a full-screen app with its own
      icon. Needs nothing from Apple. (Pull request #2.)
- [x] **2. Bottom tabs.** Track, Compare, Deck in the middle, Cart and
      Account, the way phone apps are navigated, on the site and in the app
      alike. The cart and sign-in became tabs rather than pop-ups, and Compare
      is new. Needs nothing from Apple, so it goes first while the enrolment
      is approved.
- [ ] **3. The iPhone shell.** Capacitor's settings and the build service's
      pipeline, with the Xcode project generated in the cloud on each build
      rather than committed, so dozens of generated files stay out of git.
      Order placing is switched off in the app build. First TestFlight build.
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
- Order placing is absent from the app build: no brokerage connection, no
  "Review orders". It returns only once the membership is an organization.

## How long

About two weeks from enrolment to the first submission at one pull request a
day; Apple's review then usually takes a day or two.
