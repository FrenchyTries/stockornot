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
- [ ] **Run all of `supabase/schema.sql`** in Supabase's SQL editor, if not
      done since pull request #3. Until it runs, Delete my account tells
      people to email instead, and "email us to delete" is one of the most
      common reasons Apple sends an app back.
- [ ] **Create the App Review account.** Supabase → Authentication → Users →
      Add user → Create new user: `review@stockornot.com`, a long password
      from a password manager, and tick Auto Confirm User. It is the one
      account that signs in with a password (see step 7); the password goes
      in App Store Connect's review notes and nowhere else. Optionally have
      `review@stockornot.com` forward to `hello@`, so anything sent to it
      lands somewhere.
- [ ] **Put a code in the sign-in email.** Supabase → Authentication →
      Emails → Magic Link: add `{{ .Token }}` to the template (it needs your
      own sender, under SMTP Settings; Resend, which sends the alerts, works).
      In the iPhone app the emailed link opens Safari, which signs Safari in
      and leaves the app signed out, so the app signs in with the code.
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
      Order placing is switched off in the app build, and so is everything
      about membership, including the Pricing link in the header and footer
      of the method, privacy and terms pages: the app is free at launch, and
      a page with a price and no way to pay reads as unfinished. Sign-in in
      the app asks for the emailed code rather than relying on the link (see
      "Put a code in the sign-in email" above). First TestFlight build.
- [ ] **4. Things only an app does.** A small vibration on each swipe, the
      phone's share sheet, and push notifications a week before anything in
      the cart reports. Apple turns down a website in a wrapper (Guideline
      4.2), and these are the difference.
- [x] **5. Delete your account in the app.** Apple requires it (Guideline
      5.1.1(v)). Account → Delete my account, through `delete_my_account()`
      in `supabase/schema.sql`, which the owner runs once in Supabase's SQL
      editor. Download my data sits beside it.
- [ ] **6. First-run guide.** Three short screens: what the score is, how to
      swipe, what the cart does.
- [ ] **7. The store listing.** Screenshots from `marketing/capture.cjs`
      (1290 × 2796), retaken from the app build after the last change to any
      screen they show: the ones in `marketing/` date from September 23,
      before the tabs, so none of them can be used as they are. Description
      and keywords, the privacy answers (an email address and a cart; no
      tracking, no ads), age rating, and notes for the reviewer: sign-in is
      optional and everything works without it; to try the account features,
      including Delete my account, sign in as `review@stockornot.com` with the
      password given there. That address alone is asked for a password rather
      than sent an email (`REVIEW_EMAIL` in `lib/supabase-config.js`).
- [ ] **8. Submit,** and answer the review.

## Before submitting, check

The five things that most often send an app back, crashes and controls that
do nothing far ahead of the rest:

1. **It works on a real phone.** Every tab, button and link, tried in the
   TestFlight build on an iPhone, not only in a browser. Nothing crashes and
   nothing does nothing. (On October 10 a script tapped all 77 controls in the
   five tabs of the website at iPhone size and followed 518 links: none dead.)
2. **The reviewer can get in.** The App Review account signs in with the
   password in the review notes, and the notes say sign-in is optional.
3. **Nothing looks unfinished.** No "coming soon", "not yet", "opening soon",
   disabled buttons or dead links anywhere in the app. Membership stays out
   of the app until it can be bought there.
4. **Every screenshot is a real screen** of the build being submitted, showing
   nothing the app cannot do: no brokerage, no order placing, no membership.
5. **Delete my account works inside the app,** end to end, on the review
   account (then recreate it), not by asking for an email (Guideline
   5.1.1(v)).

And for this app in particular:

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
