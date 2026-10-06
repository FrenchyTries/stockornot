# Lessons learned: the GitHub account flag

*September–October 2026. The short rules that come out of this are in
[`CLAUDE.md`](../CLAUDE.md), which Claude reads at the start of every session.*

## What happened

On **23 September 2026 at 15:29 UTC**, GitHub's automated anti-spam system
flagged the account `respectking`. Nobody at GitHub looked at it first, and
GitHub never said why. From that minute:

- **GitHub Actions stopped.** The nightly price refresh never ran again, so the
  site stayed on the 22 September close.
- **The repositories were hidden** from everyone but the owner. Vercel could no
  longer see them, so merged changes, including the whole redesign, never
  reached stockornot.com.
- **"Sign in with GitHub" was blocked** on other sites, Vercel included.

Support: ticket 4787177 went in the same day. One person replied that evening,
asking how the account is used, and got a full answer on 24 September. After
that came only automated replies. A second ticket followed on 30 September.
The account was still flagged on 5 October.

## What probably set it off

GitHub never told us, so this is a judgement. Most likely first:

1. **GitHub Pages was publishing a second copy of the site.** That meant 500
   machine-written finance pages, full of tickers and outbound links, rewritten
   every night, on github.io. To a spam filter that is an SEO content farm. A
   Pages deploy was running in the very minute the flag landed.
2. **Every night a bot committed about 1,000 files**: the 500 company pages
   plus 500 data files.
3. **A burst of activity that day.** Several pull requests from an AI coding
   assistant were merged within hours, some of them touching 500+ files.
4. **Btc15's `install.sh`** was a public script that unpacked a hidden encoded
   blob and installed itself as always-on admin services, in a Bitcoin
   repository. The blob was only the project's own code, but to a malware
   scanner the shape is exactly right.
5. **sentinel-x-site's scheduled job commits under the owner's own name** up
   to twelve times a day: automation that looks like a person.

None of these is against the rules on its own. Together they look like an
account run by a bot.

## What we changed

- **tikstock no longer commits its pages.** Vercel builds the company pages,
  sitemap and robots.txt on every deploy, and `.gitignore` keeps them out. The
  nightly commit now touches data files only, about half of what it was.
  The page-rebuild workflow is gone. The pages Vercel builds are byte for byte
  the ones that used to be committed.
- **GitHub Pages is off**, and the rules say it stays off.
- **The rules are written down** in `CLAUDE.md`, so every future session follows
  them without anyone having to remember.
- **There is a way to deploy without GitHub**: "Deploying without GitHub" in
  the README.

- **Btc15 was deleted** and is not coming to the new account. A copy of its
  code was kept outside GitHub, and the paper trader on its own server is
  unaffected.

Still to do when the repositories move (see the end of this page): sentinel's
commit name comes from a setting instead of being written into the file.

## Rules from now on

The full list that Claude follows is in `CLAUDE.md`. In short:

**Pace**
- **One pull request a day, at most, across the account.** Everything for the
  day goes into it; anything more waits for tomorrow.
- **Nothing goes straight onto `main`** except the nightly data commit. Every
  other change is a pull request you merge.
- **Few, tested pushes**: no streams of fix-ups, no force-pushes, no empty
  commits to kick a build.
- **Small pull requests**: anything touching more than about 50 files, or
  adding lots of images, gets your OK first.
- **One Claude session at a time** on the account.

**What gets published**
- **GitHub Pages stays off**, on every repository.
- **No generated files in git.** Build them where they're served.
- **No hidden or encoded payloads.**
- **No keys in repos, issues or chat.** Keys go in GitHub secrets and Vercel.

**Automation**
- **Scheduled jobs commit data only**, once per run, only when something changed.
- **No bulk comments or issues from workflows**: one issue, updated, never a
  comment per run.
- **At most one manual workflow run a day.**

**Your account (things only you can do)**
- **Two-factor authentication on**, recovery codes saved, email verified.
- **Make it look like a person runs it**: a profile picture, a name and a
  line of bio.
- **Keep connected apps to the minimum**, just Claude and Vercel, each limited
  to the repos it needs.
- **No mass starring, following or forking**, and no new repositories in
  bursts.
- **Keep experiments private.**
- **Never link it to the old account**, and never make a third.
- **Always keep a second way to deploy** (a Vercel token) and a second copy
  of the code outside GitHub, so one company's spam filter can never take the
  site down.

## If it happens again

1. **Recognise it.** You'll see a red banner, "This account is flagged…", or
   GitHub answers "Actions has been disabled for this user".
2. **Keep the site running first.** Deploy straight to Vercel with the token
   (see the README). The data can be refreshed by hand the same way, with
   `FINNHUB_TOKEN` set: `node scripts/refresh.mjs`.
3. **Appeal once.** Go to support.github.com/contact/reinstatement and choose
   "I can login, but my profile and contributions are not visible to others".
   List every repository and what it does. Answer their question the same
   day. Keep it to one ticket and follow up weekly, not daily. Posting to
   @GitHubSupport on X with the ticket number can help.
4. **Don't open a second account to get around it.** GitHub can ban both, and
   then there is no one left to appeal for.
5. **If there's no human reply within about two weeks, move to GitLab**: a paid
   plan, so there is a support line, and 10,000 job minutes a month, about
   three times what these sites use.

## Moving the repositories to a new home

Two repositories move: **tikstock** and **sentinel-x-site**. Btc15 does not.
What has to come across, whichever host it is:

**Code.** Push each repository with its full history from a working copy. The
host's "import" tools cannot read a flagged account.

**Secrets**, entered again by hand. GitHub never shows a saved secret.
- **tikstock:**
  - secrets `FINNHUB_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`
    (Resend shows a key only once, so make a new one)
  - variables `ALERT_FROM`, `SEC_USER_AGENT`
- **sentinel-x-site:** `ODDS_API_KEY`, plus `_2` and `_3` if used, and the new
  account's commit name and email for its scheduled job.

**Vercel.** For each project: Settings → Git → disconnect the old repository →
connect the new one. The domain and the environment variables stay as they are.

**Claude.** Connect the new account at claude.ai and install the Claude app on
the new repositories.

**Fix on the way:**
- sentinel's commit identity. Vercel's free plan only deploys a private
  repository's commits when the account owner wrote them.
- The README's clone link.

**Afterwards:**
- Turn GitHub Pages off on the new account and leave it off.
- If the old account is ever unflagged, turn off Actions there, so jobs don't
  run in two places.
