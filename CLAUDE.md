# Working on StockOrNot

## Account safety: read this first

In September 2026 GitHub's anti-spam system flagged the owner's account. Actions
stopped, the repos were hidden, Vercel stopped deploying, and the site froze for
weeks. The likely causes and the full story are in `docs/LESSONS.md`. These
rules exist so it does not happen again. Follow them on this repository and any
other repository on the same account.

1. **Never turn on GitHub Pages**, for this repository or any other. The site is
   hosted on Vercel and nowhere else. A second, auto-generated copy of 500
   finance pages on github.io looks like an SEO content farm.
2. **Never commit build output.** `stock/`, `sitemap.xml` and `robots.txt` are
   built by Vercel on every deploy (`buildCommand` in `vercel.json`) and are in
   `.gitignore`. Do not take them out of `.gitignore` or "fix" a missing page
   by committing it.
3. **Automated commits carry data only**: one commit per scheduled run, at most
   once a day for this repository, touching only `data/`.
4. **Pace the work.** One pull request per piece of work, with related changes
   grouped together. No more than about two pull requests or a handful of
   pushes in an hour, and never a burst of large commits. If the owner asks
   for many changes, batch them.
5. **No encoded or compressed payloads in any repository**: no base64 blobs, no
   embedded archives, no script that unpacks something and runs it. Installers
   copy plain, readable files.
6. **Never merge a pull request yourself.** Open it and tell the owner; the
   owner merges.
7. **No new scheduled workflows without a reason written in the file**, and no
   schedule more frequent than the data actually changes.
8. **Never create, or help set up, another account to get around a restriction.**
9. **If GitHub says the account is flagged**, or answers "Actions has been
   disabled for this user": stop pushing, tell the owner, and follow
   "If it happens again" in `docs/LESSONS.md`.

## Day to day

- Work on a branch and open a pull request; the owner reviews and merges.
- Tests: `node --test tests/*.test.mjs`
- Company pages, as Vercel builds them: `node scripts/build-pages.mjs`
- Local server: `node scripts/dev-server.mjs` (port 8080; `PORT` to change)
- Deploying without GitHub: see "Deploying without GitHub" in `README.md`.
