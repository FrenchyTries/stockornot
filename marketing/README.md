# Marketing images

> **Out of date.** These were captured on 2026-08-12. Since then the deck's
> filter chip and "1 of 501" counter were removed, "within 1% of its 52-week
> high" moved from the cons to the pros, and the cart gained the brokerage
> panel, the order bar and the earnings button. Recapture them from the current
> build before they go into a store listing.

Store-ready screenshots of StockOrNot, captured from the running site rather
than mocked up, so what they show is what the product actually does.

## Files

| File | Use |
|---|---|
| `appstore-01-deck.png` … `appstore-04-cart.png` | App Store / Play Store listing, 1290 x 2796 (iPhone 6.7") |
| `raw/01-deck.png` … `raw/04-cart.png` | The same shots without frame or headline |
| `raw/05-desktop.png` | Desktop view, for the README and the Play Store tablet slot |

## Why these are real screenshots

Apple requires store screenshots to represent the actual app. Generated or
illustrated approximations get rejected at review, and they misrepresent the
product to whoever is deciding whether to install it. These are captured with a
headless browser at 3x device pixel ratio against real market data, so every
number on screen is one the app really produced.

## Regenerating them

1. Serve the repo root on any port, with `data/snapshot.json` in place.
2. Capture the raw shots at 430 x 932 CSS pixels, device scale factor 3.
3. Compose the framed versions on a 1290 x 2796 canvas.

Worth redoing whenever the card layout changes. This first run already caught
two layout bugs that only appeared once the cart held three real companies:
the sheet title wrapped onto two lines, and a long price change wrapped so its
arrow was orphaned. Neither showed up on an empty cart. That is a decent
argument for regenerating these before a release rather than reusing old ones.

## Still needed for an actual store listing

- App icon, 1024 x 1024
- Feature graphic, 1024 x 500, for Play Store
- Screenshots at 6.5" and 5.5" if targeting older iPhones
- A privacy policy URL, which the stores require and the site does not have yet
