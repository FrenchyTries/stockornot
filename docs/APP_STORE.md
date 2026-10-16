# Getting StockOrNot on the App Store

*Started October 2026. Claude reads this before any app work; tick steps off
here as they are done.*

The app is built on the owner's Mac, in Xcode, from the `mobile/` folder of
this repository. It is [Capacitor](https://capacitorjs.com): the site's own
interface (`index.html`, `app.js`, `styles.css`, `lib/`) is copied inside the
app, so the screens Apple reviews are the screens that ship and the app opens
without a connection. Only data comes from stockornot.com: the same
`data/*.json` files the website reads, and the headlines. An iPhone is needed
to try it.

There is no build service, no App Store Connect API key and no Apple push key.
Building on the Mac needs none of them, and earnings reminders are scheduled
by the phone itself (local notifications), so nothing is sent from a server.

The account rules in [`CLAUDE.md`](../CLAUDE.md) still apply: one pull request
a day, and a large number of new files only with the owner's OK.

## Decided

October 7, 2026:

- **A personal developer account for now.** Apple wants finance apps from a
  legal business (App Review Guideline 5.1.1(ix)), and placing brokerage
  orders is what makes this one a finance app. So the iPhone app launches
  without order placing: the deck, the score, the cart, earnings reminders and
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

October 11, 2026:

- **Built on the owner's Mac**, not by a cloud build service, so no outside
  service needs access to the repository and no API key exists.
- **The interface inside the app, the data from the website.** Apple turns
  down "websites served in an iOS app" (Guideline 4.2) and apps that download
  new features (2.5.2). Loading stockornot.com in a frame would be both.
- **Local notifications instead of push.** No push key, no device tokens, no
  server sending anything, and nothing extra on the privacy label.
- **iPhone only, portrait only, iOS 16 or later.** An iPad version would need
  its own set of screenshots.
- **United States only at launch.** Selling in the EU on a personal account
  shows your address and phone number on the App Store (EU Digital Services
  Act); Australia, Brazil and Singapore add age checks for an 18+ app.
- **Support page:** https://stockornot.com/support.

## Still open

1. **Android as well?** Google Play costs $25 once and needs no Mac.
2. **The EU and other countries,** once the app has been out a while.

## How the app is put together

| Where | What |
|---|---|
| `mobile/package.json` | The Capacitor packages, at exact versions. `npm run ios` builds, syncs and opens Xcode. |
| `mobile/capacitor.config.json` | The app's id (`com.stockornot.app`), name and settings. |
| `mobile/ios/` | The Xcode project, committed: iPhone only, portrait, iOS 16.0, the icon, a plain dark launch screen, the privacy manifest. |
| `mobile/broker-stub.js` | Takes the place of `lib/broker.mjs` in the app, so no brokerage code can reach the network. |
| `scripts/build-app.mjs` | Copies the interface and a copy of the data into `mobile/www`, marks the page as the app, and checks the result. |
| `scripts/etf-ready.mjs` | Whether the funds are ready for App Review; the build carries them only then. |
| `lib/native.mjs` | What the app does differently: data from stockornot.com, links in an in-app Safari sheet, haptics, the share sheet, notifications. |
| `in-app.js` | On the website's pages opened from the app (`?app=1`): takes every way back to the website's deck off them. |

`mobile/www`, `mobile/node_modules` and the copy inside `mobile/ios/App/App/public`
are build output and are never committed (rule 8).

In the app, the brokerage, order amounts, the order bar, membership and every
limit are gone, sign-in asks for the emailed code, and Pricing is out of the
navigation of every page on the site, because the in-app Safari sheet shows
those pages as they are. For the same reason the app opens the site's pages
with `?app=1`, and `in-app.js` then takes every way back to the website's
deck off them: no "Open the deck", and the logo is not a link. In the sheet
that deck would look just like the app, yet offer the brokerage.

### Rules that come with the app

- **`data/*.json` may only gain fields.** Every copy of the app already on a
  phone reads tonight's data files, and an old copy cannot be updated from
  here. A field can be added; it is never renamed, removed, or changed in type
  or meaning. Anything that would break that moves to a new path (for example
  `data/v2/`), and the old files keep being written until old versions of the
  app are gone. The same goes for what `/api/news` returns.
- **`data/etfs.json` and `data/etf-closes.json` follow the same rule** from
  the first night they are written: a field can be added, never renamed,
  removed, or changed in type or meaning (`docs/ETFS.md` has the format).
  Funds stay out of `data/snapshot.json`, which every copy of the app reads as
  companies, and a fund record never carries `cik`, `s` or `mc`, which the
  app's code reads as a company's.
- **A build shows funds only if it carries them.** The app asks
  stockornot.com for `data/etfs.json` only when its own copy, built in, has
  funds to show (`loadFundsFile` in `lib/funds.mjs`). So a build that went to
  App Review without the ETF side never grows one when the website's data
  gains funds, which Apple would count as a hidden feature (Guideline
  2.3.1). Keep it that way: any new kind of screen that appears with the data
  is gated on the build's own copy in the same way.
- **A build carries the funds only once they are ready.**
  `scripts/build-app.mjs` asks `scripts/etf-ready.mjs`, and until every fund
  with holdings has a fee, five closes and holdings under 200 days old, it
  puts an empty list in their place and says why. Keep the rule in that one
  file.
- **Every page the app can open loads `in-app.js`** in its `<head>`: the
  hand-written pages and the ones `scripts/build-pages.mjs` writes.
  `tests/pages.test.mjs` checks them; a new page the app links to gets the
  same line.
- **The website and the app ship separately.** A change to `app.js` reaches
  the website on the next deploy, but the app only with a new version through
  App Review. Test both.
- **`vercel.json` keeps `Access-Control-Allow-Origin: capacitor://localhost`**
  on `/data/(.*)` and `/api/news`, and never on `/api/broker*`. Without it the
  app quietly falls back to the data it was built with. `tests/app.test.mjs`
  checks the file; the `curl` in "The day on the Mac", step 5, checks the live
  site.
- **Never change the app's id or its origin** (`capacitor://localhost`) after
  release: carts and sign-ins saved on phones belong to it and would be lost.
- **Capacitor stays at the exact versions in `mobile/package.json`.** Upgrade
  on purpose, then test on the phone again. Never run `npm audit fix --force`
  there: it downgrades Capacitor to a version Xcode 27 cannot run.

## Steps only the owner can do

Never paste a key, password or code into the chat; each goes straight into
the service that needs it.

First, no Mac needed (in this order):

- [ ] **Enrol in the Apple Developer Program** as an individual, $99 a year,
      with your Apple ID (two-factor on). Easiest from the Apple Developer app
      on your iPhone, which checks your ID; or developer.apple.com/programs/enroll.
      Usually approved within a couple of days. Then check it is active:
      developer.apple.com/account → Membership details, and note the **Team
      ID** (ten letters and digits; not a secret, and giving it to Claude lets
      the Xcode project be preset). If it is still pending on the day on the
      Mac, the app can run on your own iPhone but cannot go to TestFlight or
      Apple.
- [ ] **Register the App ID.** developer.apple.com/account → Certificates,
      Identifiers & Profiles → Identifiers → + → App IDs → App → Explicit
      Bundle ID `com.stockornot.app`, description StockOrNot. Tick no
      capabilities: local notifications need none.
- [ ] **In App Store Connect:** accept the agreements (Business), then Apps →
      + → New App: iOS, name **StockOrNot** (have a second name ready in case
      it is taken), primary language English (U.S.), bundle ID
      `com.stockornot.app`, SKU `stockornot-ios`, Full Access.
- [ ] **Fill in what needs no build,** from "Store listing" below: App
      Information (category Finance, Content Rights), Age Rating, Pricing and
      Availability, App Privacy (then **Publish**), and the version page's
      text.
- [ ] **Check the data terms** before answering Content Rights: does the
      Finnhub plan allow showing its data in an app, ETF prices included?
      Answer truthfully (Guideline 5.2.2). Yahoo and Stooq are no longer
      asked for anything: the nightly job stops calling them with pull
      request #4, as neither ever answered it. The last of their data, a
      weekly chart for one company (CRH), is dropped by the first nightly
      run after the merge that gets a price for CRH. A build made before
      then still carries it, so the build for Apple waits for that run's
      data commit, or leaves the chart out by hand (step 10 of "The day on
      the Mac").
- [ ] **Run all of `supabase/schema.sql`** in Supabase's SQL editor, if not
      done since pull request #3. Until it runs, Delete my account tells
      people to email instead, and "email us to delete" is one of the most
      common reasons Apple sends an app back.
- [ ] **Give Supabase your own email sender.** Supabase → Authentication →
      Emails → SMTP Settings, with Resend, which already sends the alerts.
      Without it Supabase sends no email to anyone outside your Supabase
      team, so nobody else, App Review included, can sign in by email.
- [ ] **Put a code in the sign-in emails.** Supabase → Authentication →
      Emails: add `{{ .Token }}` to **both** the Confirm signup and the Magic
      Link templates (a new address gets the first, a returning one the
      second), above the link. In the iPhone app the emailed link opens
      Safari, which signs Safari in and leaves the app signed out, so the app
      signs in with the code. Also check: Site URL `https://stockornot.com`,
      and nothing starting `capacitor://` in the Redirect URLs.
- [ ] **Create the App Review account.** Supabase → Authentication → Users →
      Add user → Create new user: `review@stockornot.com`, a long password
      from a password manager, and tick Auto Confirm User. It is the one
      account that signs in with a password; the password goes in App Store
      Connect's sign-in fields and nowhere else. Optionally have
      `review@stockornot.com` forward to `hello@`, so anything sent to it
      lands somewhere.
- [ ] **Keep the sign-in log short.** Supabase → Authentication → Audit Logs
      → turn on "Disable writing auth audit logs to project database". The
      privacy page now says Supabase's log of sign-ins is kept for up to 7
      days. By default Supabase also writes that log into the database, where
      it stays for good; with the switch on, it is kept only in Supabase's log
      storage, which its pricing page gives as 7 days on the Pro plan and 28
      on Team (tell Claude if the project is on Team). Entries already in the
      database stay there; to clear those older than a week, run this in the
      SQL editor (if it is refused, tell Claude):
      `delete from auth.audit_log_entries where created_at < now() - interval '7 days';`
      Also note which plan the project is on: free projects pause after about
      a week without activity, and a paused project fails App Review.
- [ ] **Confirm two sentences on the privacy page** (Apple requires both,
      Guideline 5.1.1(i)), or tell Claude what to change:
      - "Each gets only what its part needs, uses it only to provide that
        part, and is bound by its own privacy and data-protection terms to
        protect it at least as well as this page does." Supabase, Vercel and
        Resend each publish a data processing agreement; check you have
        accepted or signed each.
      - The retention paragraph under "How long it is kept": Vercel's request
        logs a day or less (Vercel's documentation: an hour on Hobby, a day on
        Pro), Supabase's sign-in log up to 7 days (after the step above),
        Resend's record of each email 30 days (from third-party summaries;
        check Resend's dashboard or pricing page).
- [ ] **Merge pull request #4,** after reading it, ideally on a weekday
      before the day on the Mac: the build for Apple waits for the data
      commit of the nightly run after the merge (step 10 of "The day on the
      Mac"). The app can be tried from the branch before that, but the
      site's pages lose their Pricing link and the data files gain the
      header the app needs only once it is merged. Then run the `curl` in
      "The day on the Mac", step 5, from any computer.
- [ ] **Have ready for the day on the Mac:** the iPhone on iOS 17 or later,
      its cable, and the TestFlight app installed from the App Store.

Later, before charging for membership in the app:

- [ ] Accept the Paid Apps agreement and add bank and tax details in App
      Store Connect, and join the App Store Small Business Program.

Later, before order placing comes to the app:

- [ ] Form the company (an LLC), get its EIN from the IRS and a D-U-N-S
      number through Apple, then switch the Apple membership to organization.

No longer needed (dropped on October 11): choosing a build service and
approving its access to the repository, an App Store Connect API key, and an
Apple push key.

## The day on the Mac

About a day, most of it waiting for Xcode to download. Commands go in
**Terminal** (Applications → Utilities → Terminal): paste one block, press
Return, and wait for it to finish before the next. When `sudo` asks for a
password, it is the Mac's own login password, and nothing shows as you type.

1. **Update the Mac.** Sign in with the Apple ID you enrolled with. System
   Settings → General → Software Update: install **macOS Tahoe 26.6 or
   later**, which Xcode 27 needs. To see the version now:
   ```bash
   sw_vers
   ```
2. **Install Xcode.** App Store → search Xcode → Get. Start this first; it is
   the slowest step (many gigabytes). While it downloads, install **Node.js**
   with the "LTS" macOS installer from https://nodejs.org (version 22 or
   later; the LTS is 24 now, which is fine).
3. **Finish setting up Xcode,** once it has installed:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   xcodebuild -runFirstLaunch
   xcodebuild -downloadPlatform iOS
   node -v && git --version
   ```
   The last line should print `v22` or `v24` something and a git version.
4. **Sign Xcode in.** Open Xcode → Settings → Accounts → + → Apple Account,
   and sign in. Your team shows with "(Individual)" after it.
5. **Check the website is ready for the app** (needs pull request #4
   merged):
   ```bash
   for u in /data/snapshot.json '/api/news?t=AAPL' '/api/broker?action=status'; do
     echo "== $u"; curl -sI -H 'Origin: capacitor://localhost' "https://stockornot.com$u" | grep -iE '^(HTTP|access-control)'; done
   ```
   - The first two should each show `HTTP/2 200` and exactly **one** line
     `access-control-allow-origin: capacitor://localhost`.
   - The broker line should show **no** `access-control` line at all.
   - Anything else (two such lines, or none on the first two): tell Claude.
     The app still works, on the data it was built with, until it is fixed.
6. **Get the code and build the app:**
   ```bash
   cd ~
   git clone https://github.com/FrenchyTries/stockornot.git
   cd stockornot
   git checkout main
   node --test tests/*.test.mjs
   cd mobile
   npm ci
   npx cap telemetry off
   npm run ios
   ```
   Use `git checkout claude/hopeful-ritchie-6yx5s1` instead of `main` if the
   pull request is not merged yet: a build from the branch is for steps 7 to
   9, and step 10 waits for the merge. The tests should end with `fail 0`.
   `npm run ios` builds the app's copy of the site, copies it into the Xcode
   project and opens Xcode.
7. **Signing, in Xcode.** In the left column click the blue **App** icon at
   the top, then under TARGETS click **App**.
   - **Signing & Capabilities:** tick "Automatically manage signing", choose
     your team, and check the Bundle Identifier is `com.stockornot.app`.
   - Wait while Xcode fetches the packages (the left column shows "Package
     Dependencies"; the first time it downloads from GitHub).
   - If Xcode offers to convert or update the project format, **decline**:
     it would stop `npm run ios` updating the project.
   - **General:** Supported Destinations shows iPhone only; Minimum
     Deployments iOS 16.0; Version 1.0, Build 1; Device Orientation Portrait
     only.
   - `PrivacyInfo.xcprivacy` is in the App folder of the left column.
   - If the project will not open cleanly, see "If the Xcode project will not
     open" below.
8. **Try it in the Simulator.** At the top of Xcode pick **iPhone 17 Pro** and
   press ⌘R (use Xcode's Run button; `npx cap run` does not work with Xcode
   27). In Xcode 27 the simulated iPhone appears in the **Device Hub** window
   (there is no separate Simulator app any more). Then, to look inside it:
   Mac Safari → Settings → Advanced → tick "Show features for web
   developers", then Safari's Develop menu → the simulated iPhone →
   localhost.
   - **Console:** no red errors mentioning MIME, Content Security Policy or
     CORS.
   - **Network:** `snapshot.json` comes from stockornot.com with status 200.
   - In the Console, type `Object.keys(Capacitor.Plugins)` and press Return:
     the list includes Haptics, Share, LocalNotifications, Browser and
     Filesystem.
   - **Stocks | ETFs:** the Deck shows this switch only when the build
     carries the funds, which it does only once every fund card is complete
     ("When to make the ETF build"); `npm run ios` says which in its last
     line. Note whether it shows: the listing must match ("ETFs in the
     listing", under "Store listing").
   - If the Console shows something blocked by the Content Security Policy:
     in Terminal (still in the `mobile` folder) run `CSP=off npm run sync`,
     press ⌘R again, and tell Claude. A `CSP=off` build is only for finding
     the problem: never archive it. If you needed it, stop after step 9 and
     do step 10 only once Claude's fix is merged and a plain `npm run sync`
     shows no Content Security Policy errors here.
9. **Try it on the iPhone.** Plug it in and tap Trust on the phone. If the
   iPhone is not offered at the top of Xcode: Xcode → Open Developer Tool →
   Device Hub → select the iPhone → Pair. Then on the iPhone: Settings →
   Privacy & Security → **Developer Mode** → on → restart (the switch appears
   once the phone has been paired). Also turn on Settings → Apps → Safari →
   Advanced → **Web Inspector**, so the Mac's Safari can look inside the app.
   Pick the iPhone at the top of Xcode and press ⌘R. If the phone says
   "Untrusted Developer": Settings → General → VPN & Device Management → your
   Apple ID → Trust. Then check, about 30 minutes:
   - It opens with Wi-Fi on. Force-quit it, turn on Airplane Mode, open it
     again: the deck still shows.
   - Swiping a card gives a small tap, and a tick as it crosses the line.
   - Tap a card → Share at the top → the share sheet. Cancelling it shows
     no error.
   - Every link opens in a Safari sheet inside the app with a Done button:
     "Not investment advice", "How the score works", Terms and Privacy in the
     sign-in box, the rows at the bottom of Account, the SEC filing links, a
     headline. None of those pages shows Pricing, and none leads back to
     the deck: no "Open the deck" button, and the logo at the top is not a
     link, on the next page either (tap Companies, then a company). (Contact
     support is the exception: it opens Mail.)
   - Cart: no Amount boxes, no order bar, nothing about a brokerage. Export
     CSV → Save to Files works.
   - Cart → Earnings dates → "Notify me on this iPhone" → iOS asks for
     permission.
   - To see a notification without waiting a week: in Safari's Develop menu
     → your iPhone → localhost, paste this into the Console, press Return,
     lock the phone, wait a minute and tap the notification:
     ```js
     Capacitor.Plugins.LocalNotifications.schedule({notifications:[{id:1,title:"Test",body:"x",schedule:{at:new Date(Date.now()+60000)}}]})
     ```
   - Sign in with your own email and the code from it. Force-quit the app
     and reopen it: still signed in.
   - Sign out, then sign in as `review@stockornot.com`: tick the terms box
     first, then the app asks for the password.
   - Account → Download my data → the share sheet.
   - Account → Delete my account on the review account. Then recreate it in
     Supabase, exactly as before.
   - The header and the close buttons of the sheets sit clear of the camera
     cut-out at the top.
10. **Send it to Apple,** only once pull request #4 is merged and the
    nightly run after the merge has made its data commit, which normally
    drops the last of Yahoo's data ("Check the data terms" above). First,
    in Terminal in the `mobile` folder, bring in the merge and that night's
    data, whichever branch step 6 left you on, and check:
    ```bash
    git pull origin main
    node -e 'console.log(require("../data/detail/CRH.json").chart ? "Wait: CRH has no nightly data since the merge yet" : "Ready")'
    ```
    Go on only when it prints `Ready`. If it still says `Wait` once two
    nightly data commits have come in since the merge (`git log --oneline -5`
    lists them as "Data refresh", above the merge), CRH got no price on
    those nights, and its file stays as it is until it does. Do not wait for
    it: take the chart out of your copy of the file (the check then prints
    `Ready`), and once the sync below has run, put the file back with
    `git checkout -- ../data/detail/CRH.json`:
    ```bash
    node -e 'const f="../data/detail/CRH.json", d=require(f); delete d.chart; require("fs").writeFileSync(f, JSON.stringify(d))'
    ```
    Then run `npm run sync` (exactly that, with no `CSP=off` in front), so
    the build that goes to Apple is the current code with its security
    policy. Its last line says whether the build carries the funds; the
    listing has to match ("ETFs in the listing"). Then at the top of Xcode
    pick "Any iOS Device (arm64)", then
    Product → Archive. When the Organizer window opens: Distribute App →
    App Store Connect → Distribute. Xcode makes the certificates it needs.
11. **TestFlight.** App Store Connect → Apps → StockOrNot → TestFlight. Wait
    for the build to finish processing (an email comes; minutes to half an
    hour). Internal Testing → + → a group with yourself in it, then install
    from the TestFlight app on the iPhone and go through step 9 again
    quickly, leaving out the Console test (a TestFlight build cannot be
    looked inside). Internal testing needs no review by Apple.
12. **Screenshots.** Run the app on the simulated iPhone 17 Pro Max
    (1320 × 2868) and again on the iPhone 17 Pro (1206 × 2622). In Device
    Hub, go to each screen to show and click the **Screenshot** button under
    the device (on an older Xcode with the Simulator app: ⌘S); the PNG lands
    on the Desktop at full size. See "Store listing" for what to show.
13. **Submit.** On the version page in App Store Connect: the screenshots,
    the text from "Store listing", the build (+ next to Build), and App Review
    Information. Then Add for Review → Submit to App Review. For every later
    upload, raise the Build number first (Xcode → General → Build: 2, 3…).
14. **Tell Claude what changed** for that day's pull request: the Team ID,
    anything that had to be fixed, and the contents of
    `mobile/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`
    if Xcode made it (package names and versions only; no secrets). One
    Claude session at a time.

### If the Xcode project will not open

In Terminal, in the `mobile` folder:
```bash
rm -rf ios
npx cap add ios
npx cap sync ios
npx cap open ios
```
Then set by hand, about ten minutes: the team (step 7); General → Supported
Destinations: remove iPad; Minimum Deployments: iOS 16.0; Device Orientation:
Portrait only; Info → + → "App Uses Non-Exempt Encryption" = NO; the icon:
drag `marketing/app-icon-1024.png` onto App → Assets → AppIcon; and the
privacy manifest: in Terminal, `git checkout -- ios/App/App/PrivacyInfo.xcprivacy`
brings back the committed one, then in Xcode File → Add Files to "App"…,
choose `App/PrivacyInfo.xcprivacy`, and tick the App target. If Info lists "Required device capabilities" as `armv7`,
change it to `arm64`. Then, back in Terminal, run `npx cap sync ios` once
more: it reads the new minimum from the project and writes it into the
package list (`ios/App/CapApp-SPM/Package.swift`). The launch screen keeps
Capacitor's own picture in this project, which is fine for testing. Tell
Claude, so the next pull request carries the new project.

## Steps Claude does, one pull request a day

- [x] **1. Installable from the browser.** A manifest, icons and a service
      worker, so "Add to Home Screen" gives a full-screen app with its own
      icon. Needs nothing from Apple. (Pull request #2.)
- [x] **2. Bottom tabs.** Track, Compare, Deck in the middle, Cart and
      Account, the way phone apps are navigated, on the site and in the app
      alike. The cart and sign-in became tabs rather than pop-ups, and Compare
      is new. Needs nothing from Apple, so it goes first while the enrolment
      is approved.
- [ ] **3. The iPhone shell.** `mobile/` committed, the Xcode project
      included, and built locally in Xcode on the owner's Mac
      (`cd mobile && npm run ios`). `scripts/build-app.mjs` puts the site's
      own interface inside the app with a copy of the data, and the app reads
      fresh data from stockornot.com. Order placing is switched off in the app
      build, and so is everything about membership; Pricing is out of the
      header and footer of every page on the site, because the app opens those
      pages as they are, and a page with a price and no way to pay reads as
      unfinished. Sign-in in the app asks for the emailed code. Code in pull
      request #4; done once the first TestFlight build works.
- [ ] **4. Things only an app does.** A small vibration on each swipe, the
      phone's share sheet for a company, the CSV and Download my data, and a
      notification on the phone a week before anything in the cart reports,
      scheduled by the phone itself. Apple turns down a website in a wrapper
      (Guideline 4.2), and these are the difference. Code in pull request #4;
      done once each is tried on the iPhone.
- [x] **5. Delete your account in the app.** Apple requires it (Guideline
      5.1.1(v)). Account → Delete my account, through `delete_my_account()`
      in `supabase/schema.sql`, which the owner runs once in Supabase's SQL
      editor. Download my data sits beside it.
- [ ] **6. First-run guide.** Three short screens: what the score is, how to
      swipe, what the cart does.
- [ ] **7. The store listing.** The drafts are below. The screenshots have to
      be taken again from the app in the Simulator ("The day on the Mac",
      step 12): the ones in `marketing/` date from September 23, before the
      tabs, and come from the website, so none of them can be used as they
      are.
- [ ] **8. Submit,** and answer the review.

## Before submitting, check

The five things that most often send an app back, crashes and controls that
do nothing far ahead of the rest:

1. **It works on a real phone.** Every tab, button and link, tried in the
   TestFlight build on an iPhone, not only in the Simulator or a browser,
   with Wi-Fi on and in Airplane Mode. Nothing crashes and nothing does
   nothing. (On October 10 a script tapped all 77 controls in the five tabs of
   the website at iPhone size and followed 518 links: none dead. The app
   build changes how links, files and sign-in work, so that is no proof for
   the app.)
2. **The reviewer can get in.** The App Review account signs in with the
   password given in App Store Connect, after ticking the terms box, and the
   notes say sign-in is optional. Sign in with it on the day you submit:
   Supabase must not be paused, and the account must exist again if a
   reviewer deleted it last time.
3. **Nothing looks unfinished.** No "coming soon", "not yet", "opening soon",
   disabled buttons or dead links anywhere in the app, or in the site's pages
   it opens. Membership and Pricing stay out of the app until it can be
   bought there.
4. **Every screenshot is a real screen** of the build being submitted, taken
   in the Simulator, showing nothing the app cannot do: no brokerage, no order
   amounts, no membership, no prices for the app.
5. **Delete my account works inside the app,** end to end, on the review
   account (then recreate it), not by asking for an email (Guideline
   5.1.1(v)).

And for this app in particular:

- Nothing in the app reads as advice: the "not investment advice" line is on
  every screen that shows a score.
- The privacy page matches the App Privacy answers below, and the owner has
  confirmed its two new sentences.
- A reviewer can reach every feature without paying and without a brokerage
  account.
- Order placing is absent from the app build: no brokerage connection, no
  "Review orders", no Amount fields. It returns only once the membership is an
  organization.
- The website serves the data the app needs: the `curl` in "The day on the
  Mac", step 5.
- The listing matches the build. With the Stocks | ETFs switch on the
  Deck, the ETF description paragraph, keywords and review-notes paragraph
  are all in; without it, nothing in the listing mentions ETFs ("ETFs in the
  listing" below).
- Until the ETF build, the App Review account's cart holds no ETF. A fund
  put in that cart on the website shows in every copy of the app signed in
  to it, marked ETF, even one built without funds, where it is a feature the
  listing does not mention. When you sign in with it on the day you submit
  (check 2), remove any row marked ETF from its cart.

## Store listing

Drafts for App Store Connect. Lengths are Apple's limits; the drafts are
within them. Keep "S&P 500", other companies' names and any prices out of the
name, subtitle and keywords (Guideline 2.3.7).

**Name** (30): `StockOrNot`

**Subtitle** (30): `Read the filings, then decide` (29). Another:
`Stock research, one card each` (29).

**Promotional text** (170; can be changed without a new version):

> Each card puts a large US company's filings, price, score and next earnings date in one place, with the case for and against. Swipe to keep it or pass. Free, no ads.

**Description** (4,000):

> StockOrNot puts one company in front of you at a time, with what you need to make up your own mind about it, and shows its working.
>
> Each card covers one of 500 large US companies:
> • The price, the day's move, the company's size, and a score from 1 to 99 that places it among the 500, with its rank in its sector.
> • Five plain questions, each answered with the figures behind it: is the business growing, is it generating real cash, are its margins improving, is its balance sheet healthy, and is the price reasonable?
> • The case for and against, every line naming the figure behind it.
> • The next earnings date and what analysts expect.
> • The company's own description of its business and the risks it lists, from its latest annual report, with links to the filing.
>
> Swipe right to keep a company in your cart, left to pass. Tap a card for the full record: five years of filings, the price history, the closest peers, insider activity and recent headlines.
>
> Compare puts two companies side by side. The cart keeps your notes, shows what each pick has done since you added it, and exports to a spreadsheet. Track follows each week's highest and lowest scores forward against the whole index, so you can see whether the score means anything.
>
> Switch on a reminder and your iPhone tells you a week before anything in your cart reports. Without a connection, the deck, the cart and Compare still work on the figures built into the app.
>
> The score can be read in six styles, from balanced to value, growth or defensive. "How the score works" sets out every threshold.
>
> Signing in is optional, with a code sent to your email and no password. An account keeps your cart in step across devices and can email you before earnings. You can download your data or delete your account in the app.
>
> Figures come from companies' SEC filings and from market data providers, and are refreshed each weekday evening after the US market closes. They are not live prices, and they can be stale or wrong.
>
> StockOrNot is not investment advice. It does not place trades, connect to a brokerage, hold money or know your circumstances. Read the filing before you decide anything.
>
> No ads and no tracking.

**Keywords** (100, commas, no spaces):
`stocks,investing,research,10-K,SEC,filings,earnings,fundamentals,valuation,watchlist,swipe` (90)

**ETFs in the listing.** A build shows the ETF side (the Stocks | ETFs
switch on the Deck and in Compare, the fund cards and their full record) only
when it carries its own copy of `data/etfs.json` with at least two funds whose
holdings have been read. A build without one (it carries an empty list in its
place) never shows funds, even once the website has them: it does not ask
stockornot.com for the file. A build with one reads the website's newer file
when online, and its own copy offline.
`scripts/build-app.mjs` copies the file in only once every fund card is
complete ("When to make the ETF build" below), and says in its last line
whether it did.

So the listing follows the build:

- **No switch** (any build made before the funds are ready): the text above
  as it is, and nothing about ETFs
  in the description, keywords, screenshots or review notes. ETFs join the
  listing with the next version.
- **The switch shows:** the ETF description paragraph, keywords and
  review-notes paragraph below are all required, in the same submission as
  the build. An app with features its review was not told about is turned
  down (Guideline 2.3.1).

**When to make the ETF build.** Only once every fund card is complete, or the
reviewer meets the empty states check 3 rules out. On the first ETF night
each fund has one closing price, and its chart needs five, so until the data
commit of the fifth trading day, counting the first, every fund's full record
says "Not enough price history for a chart". The fees come in a few a
night from the funds' shareholder reports, and SPY's and DIA's only by hand
from their prospectus on sec.gov (`docs/ETFS.md`, "The quarterly half hour");
until a fund has one, its card says "Not read". So about a week after the
merge, ask Claude to add every fee still missing to `data/etf-list.json` in
that day's pull request, each copied from its filing on sec.gov with that
filing's address; the data commit of the night after it is merged carries
them. Then `git pull origin main` in the `stockornot` folder and run this
there:
```bash
node scripts/etf-ready.mjs
```
It lists the funds with no fee, with fewer than five closes, and out of
date, and ends "Ready" only when all three say `none`; until then every app
build leaves the funds out by itself (`scripts/build-app.mjs` asks the same
script). If some funds still have fewer than five closes a week on, Finnhub
is probably not quoting them, and a fund "out of date" has missed its
quarterly filings: either way, tell Claude. Once it says "Ready", build as
usual, then check in the Simulator that the switch shows, with Wi-Fi on and
again in Airplane Mode, and go
through the fund cards and a few full records against "Before submitting",
check 3 in particular. A fund that cannot be read in full says "Partly read",
"Holdings only" or "Out of date" where the number would be, with the figure
behind it (how much was matched, how much is cash, or how old its holdings
are): that is what it is, not something still loading, and the review notes
say so.

Until then, a build for App Review (a fix after a rejection, say) leaves the
funds out by itself: `npm run sync` ends "Without the funds". Press ⌘R and
check the Deck shows no Stocks | ETFs switch before archiving, and submit the
listing without ETFs, with no ETF in the App Review account's cart ("Before
submitting").

When the build shows ETFs, all of these:

- **Description:** add this paragraph after the list that ends "…with links
  to the filing." (the description is then about 2,770 characters of the
  4,000), and in the paragraph on where the figures come from, read
  "companies' and funds' SEC filings" for "companies' SEC filings":

  > A Stocks | ETFs switch opens about fifty US stock ETFs, the funds that hold those same companies. Each fund's card shows its largest holdings, its sectors, its fee in dollars where its SEC filings give it, and the filing its holdings come from. A fund read in full gets a fund reading out of 100 from what it owns, read through the company scores, what it costs and how spread out it is; a fund that cannot be read in full says so instead, with the figure behind it. Funds go in the same cart, and Compare sets two funds side by side, with how much they hold in common.

  "About fifty" is the number of funds on the list; if the check above
  counts far fewer funds with holdings, say "dozens of" instead.
- **Keywords:**
  `stocks,ETF,funds,investing,research,10-K,SEC,filings,earnings,fundamentals,valuation,watchlist,swipe`
  (100, Apple's limit exactly; drop `,swipe` if App Store Connect refuses it).
  No fund names or tickers, for the same reason as company names.
- **Review notes:** the ETF first line and paragraph below.
- **Screenshots** (optional): one of the ETF deck or a fund's full record can
  take the place of one of the suggestions below.

**Support URL:** https://stockornot.com/support
**Marketing URL** (optional): https://stockornot.com
**Privacy Policy URL:** https://stockornot.com/privacy
**Copyright:** `2026` followed by your full legal name, for example `2026 Jane Doe`
(the person who owns the app; no URL).

**Category:** Finance. No secondary category needed.

**Screenshots:** two sets, 1320 × 2868 (iPhone 17 Pro Max simulator) and
1206 × 2622 (iPhone 17 Pro simulator), up to 10 each, PNG, taken from the
build being submitted. Suggested: the deck with a card; a card's five checks;
the case for and against; the cart; Compare; the earnings sheet with "Notify
me on this iPhone"; Track. More than half must show the app in use (2.3.3).
None may show a brokerage, order amounts, membership, or the app's or
membership's price.

**App Review Information:**
- Tick **Sign-in required**. User name `review@stockornot.com`; password: the
  one in your password manager, typed there and nowhere else.
- Contact: your name, phone and email.
- Notes (fill in the last line):

> StockOrNot is a free research app for large US companies. Each card shows a score built from the company's SEC filings and market data, the case for and against, and the company's own filing text. It does not place trades, hold money, connect to a brokerage or give personalised advice, and "Not investment advice" is on every screen that shows a score. There are no purchases and no ads.
>
> Sign-in is optional; everything else works without it. To try the account features (cart sync, Download my data, Delete my account), open the Account tab, type review@stockornot.com, tick the box agreeing to the terms, and continue: this one address is asked for the password above instead of being emailed a code. Please try Account → Delete my account last, as it deletes this account.
>
> Where the native features are:
> 1. Haptics: a tap on each swipe in the Deck, and a tick as a card crosses the line (on a device).
> 2. Share sheet: the Share button at the top of a company's full record (tap any card); Cart → Export CSV (the cart's buttons appear once it holds a company: swipe a card right or tap Add to cart); Account → Download my data (signed in).
> 3. Local notifications: Account → Earnings alerts (or Cart → Earnings dates, once the cart holds a company) → "Notify me on this iPhone". Permission is asked only when it is switched on, and the app works without it. The phone schedules a notification at 9 a.m. a week before each company in the cart reports; nothing is sent to a server.
> 4. Offline: in Airplane Mode the Deck, Cart, Compare and Track still work, on the data built into the app.
> 5. Links to the method, terms, privacy policy and SEC filings open in an in-app Safari view.
>
> External services: SEC EDGAR and Finnhub (data), Supabase (accounts), Resend (email). Available in the United States only. Tested on [iPhone model], iOS [version].

When the build shows ETFs (and only then), start the notes "StockOrNot is a
free research app for large US companies and the stock ETFs that hold
them.", and add this paragraph before the last one:

> ETFs: the Stocks | ETFs switch at the top of the Deck opens about fifty US stock funds; tap one for its full record. Compare has the same switch, to set two funds side by side. A fund's reading is built from its holdings and its fee as filed with the SEC, is never a place among the companies, and like the company score is not advice. A fund whose holdings cannot be read in full shows "Partly read", "Holdings only" or "Out of date", with the figure behind it, where the number would be: that is deliberate, not a screen still loading.

**App Privacy** (then click **Publish**). Data collected, all for App
Functionality, linked to the user, not used for tracking:
- Contact Info → **Email Address** (sign-in, and alerts if switched on).
- Identifiers → **User ID** (the account's id).
- User Content → **Other User Content** (the cart and its notes).
- Other Data → **Other Data Types**: recommended, for the IP addresses in the
  sign-in and request logs, kept for security.

Not collected: location, contacts, health, financial info (the cart's prices
and amounts are filed under User Content), browsing or search history, usage
data, diagnostics, purchases, sensitive info. "Do you or your third-party
partners use data for tracking?": No. These must match the privacy page.

**Age rating** (answers for each section):
- In-App Controls: Parental Controls No; Age Assurance No.
- Capabilities: Unrestricted Web Access No; User-Generated Content No;
  Messaging and Chat No; Social Media No; Advertising No.
- Mature Themes, Medical or Wellness, Sexuality or Nudity, Violence: None
  throughout.
- Chance-Based Activities: Gambling No; Simulated Gambling No; Contests No;
  Loot Boxes No.

That works out at 4+. Then choose **Override to higher age rating → 18+**,
because the terms say StockOrNot is for people 18 and over, and Apple
requires the rating to match.

**Pricing and Availability:** Free. Availability: **United States only**.
Untick "Make this app available" on Apple silicon Macs and on Apple Vision
Pro. EU Digital Services Act: **not a trader** (the app is not offered in the
EU). If a Digital Goods and Services questionnaire appears, the app sells
nothing; ask Claude if its options do not fit that.

**Encryption:** nothing to answer. The app only uses the encryption built into
iOS for HTTPS, and says so in its settings (`ITSAppUsesNonExemptEncryption`
is NO), so App Store Connect does not ask on each upload.

## How long

If nothing goes wrong: pull request #4 merged on a weekday, and the nightly
run's data commit that evening, which the build for Apple waits for (step 10
of "The day on the Mac"); steps 1 to 9 can come before it. Then a TestFlight
build on the iPhone by the evening of the day on the Mac (the Xcode download
is the slow part), and the app submitted that night or the next day. Apple
reviews half of all apps within a day and nine in ten within two, so the app
could be live two or three days after the day on the Mac. A rejection costs
two to four days a round; for a "minimum functionality" (4.2) rejection, reply
in App Store Connect naming each native feature, and ask for an App Review
appointment if it persists.
