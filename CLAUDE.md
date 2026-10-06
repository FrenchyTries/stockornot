# Working on StockOrNot

## Account safety: read this first

In September 2026 GitHub's anti-spam system flagged the owner's previous
account. Actions stopped, the repos were hidden, Vercel stopped deploying, and
the site froze for weeks. The likely causes and the full story are in
`docs/LESSONS.md`. These rules exist so it never happens again. They apply to
every repository on the account, not just this one. When a rule and a request
conflict, say so and ask; don't quietly break the rule.

### Pace: one pull request a day

1. **One pull request a day, at most, across the whole account.** That is the
   owner's rule. Everything for the day goes into that one pull request. If
   more is asked for after it's open, add it to the same pull request; if that
   one is already merged, the work waits for tomorrow's. Tell the owner which.
2. **No direct pushes to `main`.** Every change arrives through the day's pull
   request, merged by the owner. The only other commits on `main` are the
   scheduled data commits.
3. **Few pushes.** Test locally first, so a pull request takes one push and
   maybe a fix or two, not a stream. Never force-push, never rewrite history
   on `main`, and never push an empty commit to set off a build or a check.
4. **Small pull requests.** If one would change more than about 50 files, or
   add more than a few images or other large files, ask the owner first.
5. **Never merge a pull request yourself.** Open it and tell the owner; the
   owner merges.
6. **One Claude session at a time** works on the account's repositories, so
   two sessions never push at once.

### What gets published

7. **Never turn on GitHub Pages**, for any repository. The sites are hosted on
   Vercel and nowhere else. A second, auto-generated copy of 500 finance pages
   on github.io looks like an SEO content farm.
8. **Never commit build output.** `stock/`, `sitemap.xml` and `robots.txt` are
   built by Vercel on every deploy (`buildCommand` and `outputDirectory` in
   `vercel.json`) and are in `.gitignore`. Don't take them out of `.gitignore`
   or "fix" a missing page by committing it.
9. **No encoded or compressed payloads**: no base64 blobs, no embedded
   archives, no script that unpacks something and runs it. Installers copy
   plain, readable files.
10. **No keys or passwords in any repository, issue, commit or chat.** They live
    in GitHub's Actions secrets and in Vercel's environment variables.

### Automation

11. **Scheduled jobs commit data only**, one commit per run, and only when
    something changed. For this repository that is at most once a day,
    touching only `data/`.
12. **No new scheduled workflows, and no more frequent schedules, without a
    reason written in the workflow file.**
13. **Workflows never comment or open issues in bulk.** A job may open one
    issue and update it; it never posts a new comment on every run.
14. **At most one manual workflow run a day.** Never re-run a job in a loop to
    "see if it passes".

### The account

15. **No new repositories, forks, collaborators or connected apps unless the
    owner asks.** The Claude and Vercel apps stay limited to the repositories
    they need.
16. **Never touch the old account**: no transfers from it, no links to it.
    **Never create, or help set up, another account** to get around a
    restriction.
17. **If GitHub says the account is flagged**, or answers "Actions has been
    disabled for this user": stop pushing, tell the owner, and follow
    "If it happens again" in `docs/LESSONS.md`.

## Day to day

- Work on a branch; open that day's pull request; the owner reviews and merges.
- Tests: `node --test tests/*.test.mjs`
- Company pages, as Vercel builds them: `node scripts/build-pages.mjs`
- Local server: `node scripts/dev-server.mjs` (port 8080; `PORT` to change)
- Deploying without GitHub: see "Deploying without GitHub" in `README.md`.
