# Marketing images

Store-ready screenshots of StockOrNot, captured from the running site rather
than mocked up, so what they show is what the product actually does. Last
captured on 2026-09-23, after the redesign.

## Files

| File | Use |
|---|---|
| `appstore-01-deck.png` … `appstore-04-cart.png` | App Store / Play Store listing, 1290 x 2796 (iPhone 6.7") |
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

## Still needed for an actual store listing

- Feature graphic, 1024 x 500, for Play Store
- Screenshots at 6.5" and 5.5" if targeting older iPhones
- Terms of service. The privacy policy the stores ask for is at `/privacy`.
