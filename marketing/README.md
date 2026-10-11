# Marketing images

Screenshots of StockOrNot, captured from the running site rather than mocked
up, so what they show is what the product actually does. Last captured on
2026-09-23, after the redesign.

**None of these can go on the App Store as they are.** They come from the
website, before the bottom tabs, and the cart shot shows order amounts, the
Planned / Split bar and a Pricing link, none of which the iPhone app has. The
App Store set is taken again from the app itself, below.

## Files

| File | Use |
|---|---|
| `appstore-01-deck.png` … `appstore-04-cart.png` | The website at iPhone size, framed, 1290 x 2796. Out of date: before the tabs |
| `raw/01-deck.png` … `raw/04-cart.png` | The same shots without frame or headline |
| `raw/05-desktop.png` | Desktop view, for the README and the Play Store tablet slot |
| `app-icon-1024.png` | Store icon, 1024 x 1024, square (the stores round it) |

The same script writes the site's link preview (`/og.png`, 1200 x 630, named by
every page's `og:image`) and its home-screen icon (`/apple-touch-icon.png`).

## Why these are real screenshots

Apple requires store screenshots to represent the actual app. Generated or
illustrated approximations get rejected at review, and they misrepresent the
product to whoever is deciding whether to install it. These are captured with a
headless browser at 3x device pixel ratio against real market data, so every
number on screen is one the app really produced.

## Regenerating them

```bash
node scripts/dev-server.mjs &
NODE_PATH=$(npm root -g) node marketing/capture.cjs     # needs Playwright
```

`capture.cjs` shoots the raw screens at 430 x 932 CSS pixels and device scale
factor 3, then frames them on a 1290 x 2796 canvas. The cart it shows is seeded
with real closing prices from `data/detail`, so nothing on screen is invented.

Worth redoing whenever the card layout changes. The first run caught two
layout bugs that only appeared once the cart held three real companies: the
sheet title wrapped onto two lines, and a long price change wrapped so its
arrow was orphaned. The second caught a third that only a 430px phone showed:
the financial checks split into two columns too narrow for their own labels.
That is a decent argument for regenerating these before a release rather than
reusing old ones.

## App Store screenshots: from the app, in the Simulator

Apple wants screenshots of the app being submitted, so these are taken from
the app build itself, on the Mac, after the last change to any screen they
show (docs/APP_STORE.md, Monday's step 12):

1. `cd mobile && npm run ios`, then run it on a simulated iPhone from Xcode.
2. On each screen to show, click the Screenshot button under the device in
   Xcode 27's Device Hub (⌘S in the older Simulator app). The PNG lands on
   the Desktop at the device's full size.
3. Do it twice: on the **iPhone 17 Pro Max** simulator (1320 x 2868, the 6.9"
   size) and the **iPhone 17 Pro** (1206 x 2622, the 6.3" size).

Why both: Apple's screenshot page requires at least one set for iPhones with
the Dynamic Island (1179 x 2556 or 1206 x 2622), while its table of devices
still says a 6.9" or 6.5" set is required. Two sets satisfy both readings;
Apple scales the largest set down for smaller iPhones. PNG or JPEG, no
transparency, up to 10 a size. The app is iPhone only, so no iPad set.

What they may show (App Review Guideline 2.3.3 and 2.3.7):

- Real screens of the build being submitted, and more than half of them with
  the app in use. A headline above the screen is fine; a mock-up is not.
- Nothing the app cannot do: no brokerage, no order amounts or order bar, no
  membership, and no price for the app or a membership.
- Simulated data is not needed: the Simulator shows the real day's data.

A framed version in the style of `capture.cjs` can come later; it would have
to frame these Simulator shots rather than the website. Committing them is
optional, and more than a few images in one pull request needs the owner's
OK first (CLAUDE.md rule 4).

## Still needed for an actual store listing

- The App Store screenshots above, and the listing text drafted in
  `docs/APP_STORE.md` ("Store listing").
- Feature graphic, 1024 x 500, for Play Store, if Android goes ahead.
- The privacy policy, terms and support pages the stores ask for are at
  `/privacy`, `/terms` and `/support`.
