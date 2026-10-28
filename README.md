# Feature Board

A small web app where customers suggest features and vote on each other's ideas.
The most-requested ideas rise to the top, so you always know what to build next.
Your team gets a password-protected dashboard to manage everything.

**Customers can:**
- Post a suggestion (title, details, category, name, email)
- See "Already suggested?" matches while typing, and vote for those instead
- See, right after posting, how many other people asked for something similar
- Vote (one vote per email per idea; click again to remove it) and comment
- Sort by most votes or newest, filter by status or category, and search

**Your team can (at `/admin.html`):**
- Review new ideas and comments before they go public (can be switched off)
- See totals: suggestions, votes, customers taking part, this week's activity
- See ideas by status and votes by category
- Work from a priority list ranked by votes, with "+N this week" trends
- Change status (Under review, Planned, In progress, Done, Not planned) and category
- Post official replies that customers see on the board
- Merge duplicates (voters combine; someone who voted on both counts once)
- See every voter's name and email, spot suspicious voting, remove fake votes, and download voters as a spreadsheet
- Download all suggestions as a CSV file (opens in Excel or Google Sheets)
- Add, rename and remove categories

---

## Quick start (about 10 minutes)

For people who are comfortable with GitHub and a hosting service. If you would rather be
walked through every click, use the **[step-by-step install guide](docs/INSTALL.md)**.

1. **Get the code on GitHub.** Create a new repository and upload this folder (the included
   `.gitignore` leaves out `node_modules`, `.env` and the database).
2. **Make it yours.** Edit `branding/brand.json` (name, colors, fonts, wording) and replace
   `branding/logo.svg` with your logo. See the **[branding guide](docs/BRANDING.md)**.
   Check it any time with `npm run check-brand`.
3. **Deploy on any Node 22+ host** (Railway, Render, Fly.io, a VPS...): connect the repository,
   build command `npm install`, start command `npm start`.
4. **Add a persistent volume** (for example mounted at `/data`). Without it the database is wiped on every redeploy.
5. **Set these environment variables:**

   | Name | Value |
   |---|---|
   | `ADMIN_PASSWORD` | a long, private password for the staff dashboard |
   | `DB_PATH` | `/data/data.db` (a path inside the volume) |
   | `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | optional: Cloudflare's free bot check (section 5) |
   | `RESEND_API_KEY`, `DIGEST_FROM`, `DIGEST_TO` | optional: a daily summary email (see *Daily summary email*) |

6. **Open your address.** The board is at `/`, the staff dashboard at `/admin.html`.
7. Optional: point a subdomain such as `feedback.yourcompany.com` at it (your host's "custom domain" setting).

To try it on your own computer first: `npm install`, then `ADMIN_PASSWORD=your-password npm start`,
then open <http://localhost:3000>.

---

## How the pieces fit together

```
 Customer's browser                Your server                     Database file
 ┌──────────────────┐   requests   ┌──────────────────┐   reads/   ┌─────────────┐
 │ index.html       │ ───────────▶ │ server.js        │   writes   │ data.db     │
 │ app.js           │ ◀─────────── │ (Node + Express) │ ─────────▶ │ (SQLite)    │
 │ styles.css       │   answers    │ similarity.js    │            │             │
 └──────────────────┘              └──────────────────┘            └─────────────┘
 Staff browser: admin.html + admin.js talk to the same server (password required)
```

| File | What it is |
|---|---|
| `server.js` | The back end. Receives requests from the pages, checks them, reads and writes the database. Every "route" is commented. |
| `db.js` | Creates the database file and its tables (categories, ideas, votes, comments, plus settings and spam-limit counters). Also upgrades databases from older versions of the app, and lists the statuses. The starter categories come from `brand.json`. |
| `similarity.js` | The "similar ideas" matcher. Compares the important words in two ideas (ignoring words like "the" or "please"). |
| `security.js` | All the protection in one place: spam limits, bot checks, link detection and browser security rules. |
| `brand.js` | Reads `branding/brand.json`, checks every value, and turns it into the stylesheet, logo tag and wording the pages use. |
| `branding/` | **Your branding**: `brand.json` (settings), your logo, tab icons, optional `custom.css`. See [docs/BRANDING.md](docs/BRANDING.md). |
| `docs/` | The step-by-step install guide and the branding guide. |
| `examples/` | Two ready-made example brands you can copy into `branding/`. |
| `public/index.html` | Structure of the customer board (a template: the server fills in your branding). |
| `public/app.js` | Behavior of the customer board: loading ideas, voting, posting, comments. |
| `public/admin.html` / `admin.js` | The staff dashboard. |
| `public/styles.css` | The layout for both pages. Colors and fonts come from your branding. |
| `package.json` | Lists the two libraries the app needs (Express and better-sqlite3) and the start command. |
| `data.db` | Created automatically the first time you run the app. **This is your data. Back it up.** |

Every code file has plain-English comments explaining what each part does. A good
reading order: `db.js` → `server.js` → `public/app.js`.

---

## 1. Run it on your own computer (to try it out)

1. **Install Node.js** version 22 or newer: download the "LTS" version from
   [nodejs.org](https://nodejs.org) and run the installer.
2. **Open a terminal in this folder.**
   - Mac: open Terminal, type `cd ` (with a space), drag the folder into the window, press Enter.
   - Windows: open the folder in File Explorer, click the address bar, type `cmd`, press Enter.
3. **Install the libraries** (only needed once):
   ```
   npm install
   ```
4. **Start the app with your own admin password:**
   - Mac / Linux:
     ```
     ADMIN_PASSWORD=pick-a-strong-password npm start
     ```
   - Windows (Command Prompt):
     ```
     set ADMIN_PASSWORD=pick-a-strong-password
     npm start
     ```
5. Open **http://localhost:3000** for the customer board and
   **http://localhost:3000/admin.html** for the dashboard.

To stop the app, click the terminal and press `Ctrl + C`.

> If you don't set `ADMIN_PASSWORD`, the password is `changeme` and the app prints a
> warning. Always set a real one before customers can reach it.

---

## 2. Put it online

The app needs a host that runs **Node.js** and keeps a file saved between restarts
(a "persistent disk" or "volume"), because that's where `data.db` lives.
Render, Railway, Fly.io, DigitalOcean and any VPS all work. The steps are the same everywhere:

1. Put this folder in a GitHub repository (leave out `node_modules` and `data.db`; the
   included `.gitignore` already does that).
2. Create a new **Web Service / App** on your host and connect the repository.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Add a **persistent disk / volume**, for example mounted at `/data`.
5. Add these **environment variables** (settings the server reads when it starts):

   | Name | Value | Needed? |
   |---|---|---|
   | `ADMIN_PASSWORD` | your strong admin password | Yes |
   | `DB_PATH` | `/data/data.db` (a path inside the disk from step 4) | Yes |
   | `EMBED_ALLOWED_SITES` | the website(s) allowed to embed the board, separated by spaces, e.g. `https://www.yourcompany.com https://yourcompany.com` | Recommended |
   | `TRUST_PROXY` | leave unset (means `1`); set to `2` if you add Cloudflare in front (see section 5) | Only with Cloudflare |
   | `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` | Cloudflare's bot check (see section 5) | Optional |

   You don't need to set `PORT`; hosts set it automatically.

6. Deploy. Your host gives you a web address such as `https://feature-board.onrender.com`.

> ⚠️ **Don't skip the persistent disk.** Without it, many hosts wipe files on every
> restart or redeploy, and every suggestion would disappear. Free tiers often don't
> include disks; check your host's current plans.

**Optional but nice:** point a subdomain such as `feedback.yourcompany.com` at it
(your host's "custom domain" setting walks you through this).

---

## 3. Add it to your website

Pick one:

**A link or button** (simplest, works on every website builder):
```html
<a href="https://feedback.yourcompany.com">Suggest a feature</a>
```

**Embed the board inside a page** (WordPress, Squarespace, Wix and others have an
"Embed" or "Custom HTML" block; paste this into it):
```html
<iframe src="https://feedback.yourcompany.com"
        style="width:100%; height:1200px; border:0;"
        title="Feature requests"></iframe>
```

Don't link the admin page from your public site. Bookmark
`https://your-address/admin.html` for your team instead.

---

## 4. Moderation: reviewing posts

**Review before publishing is on by default.** New ideas and comments go to the
"Waiting for review" list at the top of your dashboard, and only appear on the
public board after you click **Approve**. Customers still see the "N people asked
for something similar" count right away, and are told their idea will appear after review.

- **Edit or merge** opens the post, so you can fix a typo or merge a duplicate
  into an existing idea (its vote moves over) instead of publishing it.
- To publish posts instantly, untick **Review new posts before they're published**.
  Even then, any post containing a web link is still held for you, because spam almost
  always contains links.

---

## 5. Security and protection from abuse

All of this lives in `security.js`, with comments explaining each part.

**Malicious input**
- Anything customers type is displayed as plain text, so nobody can inject code into
  your pages ("XSS"). A strict *Content Security Policy* tells browsers to refuse any
  script that doesn't come from your own server, as a second line of defense.
- Database commands never include customer text directly ("SQL injection" is blocked).
- Every field has a length limit, requests over 20 KB are rejected, and broken or
  oddly-shaped data gets a short error message (never internal details).
- The CSV downloads neutralize text that Excel would treat as a formula.

**Spam and floods (rate limits)**
Each visitor (by network/IP address) is limited to:

| What | Limit |
|---|---|
| Loading data (lists, searches, opening ideas) | 1,200 per 5 minutes |
| "Already suggested?" checks while typing | 60 per minute |
| Any change (posts, votes, comments) | 120 per 10 minutes |
| New ideas + comments | 30 per hour |
| Votes | 100 per hour |
| Admin password attempts | 10 per 15 minutes |

The counters are stored in the database, so restarting the server doesn't reset them,
and old counters are cleaned up automatically. The limits are generous because everyone
in one office usually shares one IP address. Change the numbers at the `limits` section
of `security.js` if needed.

**Bots**
- A hidden "trap" field that people never see but bots fill in.
- A signed "form token" the page receives when it loads. Posts without a valid token,
  or sent less than 2 seconds after the page loaded, are rejected. This stops bots that
  fire requests straight at the server without loading the page.
- Optional: Cloudflare Turnstile, a free "Verify you are human" check (below).
- **Vote-stuffing:** each idea's voter list in the dashboard shows how many other
  voters used the same internet connection, flags unusual clusters with **Check**,
  and lets you remove individual votes. IP addresses are never stored as-is, only as
  scrambled fingerprints that can't be turned back into an address.

**Browser security rules**
- Your admin dashboard can't be embedded in any other website (blocks "clickjacking").
- The public board can only be embedded on the sites in `EMBED_ALLOWED_SITES`
  (any site, if you leave it unset).
- Admin data is never stored in browser caches, and the dashboard is hidden from search engines.

### Turning on Cloudflare Turnstile (optional, free)
Adds a "Verify you are human" check to the idea and comment forms. Most people just
see a checkmark; suspicious visitors get a quick puzzle.
1. Create a free account at [cloudflare.com](https://www.cloudflare.com) and open **Turnstile** in the dashboard.
2. **Add a widget**, enter your board's domain (e.g. `feedback.yourcompany.com`), and choose the "Managed" mode.
3. Copy the **Site Key** and **Secret Key** into the `TURNSTILE_SITE_KEY` and
   `TURNSTILE_SECRET_KEY` environment variables on your host, and redeploy.
4. Open your board and start typing an idea: the check appears above the **Post idea** button.

Cloudflare's Turnstile documentation also lists special *test keys* you can use on
your own computer to try it out before going live.

### Protecting against DDoS (large-scale floods)
A real distributed attack (thousands of machines at once) overwhelms the connection
before any code in the app runs, so no app can stop it alone. Put **Cloudflare's free
plan** in front of your board to absorb it:
1. Add your domain to Cloudflare and follow its steps to switch your domain's nameservers.
2. In Cloudflare's **DNS** settings, add a record for your board (e.g. `feedback`) pointing
   to your host's address, with the orange cloud (**Proxied**) switched on.
3. Under **SSL/TLS**, choose **Full (strict)**.
4. Set `TRUST_PROXY=2` on your host, so the spam limits see each visitor's real address
   rather than Cloudflare's. (If every visitor suddenly seems to share one limit, or
   nobody ever hits one, check this setting against your host's documentation.)
5. If your host charges by usage, set a **spending limit** there too.

---

## 6. Make it yours

Everything about the look and wording lives in the **`branding`** folder, so you never have to edit code:

| To change… | Do this |
|---|---|
| Company name, product name, website link | `name`, `productName`, `website` in `branding/brand.json` |
| The logo | Put your file in `branding/` and set `logo` (SVG, PNG, JPG or WebP), plus `logoHeight` |
| Colors | `colors` in `brand.json` (hex codes such as `#17806f`); readable text colors are chosen for you |
| Fonts | `fonts` in `brand.json`: any [Google Font](https://fonts.google.com) by name, or your own font files |
| Headline, intro text, headings, empty-state messages | `text` in `brand.json` |
| Browser tab icon | `favicon.svg`, `favicon.png`, `favicon.ico`, `apple-touch-icon.png` in `branding/` |
| Starter categories | `categories` in `brand.json` (used only the very first time the app starts; afterwards use the dashboard) |
| Anything else about the look | `branding/custom.css` (optional) |

Run **`npm run check-brand`** to see what the app understood and whether anything needs fixing.
Full details, with examples, are in the **[branding guide](docs/BRANDING.md)**.
The `examples` folder holds two complete example brands to copy from.

Other things you can change in code:

| To change… | Edit… |
|---|---|
| Status names | `STATUSES` list in `db.js` (change the `label`, keep the `key`) |
| How strict "similar" matching is | `threshold` in `similarity.js` (lower = more matches, e.g. `0.4`) |

After editing, stop the app (`Ctrl + C`) and start it again (`npm start`). On a host,
push your changes to GitHub and it redeploys.

---

## Good to know

- **Backups:** your data is the single file `data.db`. Copy it somewhere safe now and
  then. The dashboard's "Download CSV" also gives you a readable copy of all suggestions.
- **Privacy:** customer emails are only visible in the admin dashboard and CSV
  downloads, never on the public board. Tell customers how you'll use their email;
  the board says it's only used to update them on their idea.
- **One vote per email:** emails aren't verified, so someone could vote several times
  using made-up addresses. The rate limits slow this down and the voter list's
  "Same network" column helps you spot it.
- **Logging in:** you stay logged in for 7 days. Restarting the server logs everyone out.
- **HTTPS:** hosts like Render and Railway provide it automatically. Always use the
  `https://` address so your admin password travels encrypted.
- **Similar-idea matching** works by comparing keywords, not meaning. "Export to Excel"
  and "Excel export" match; "dark theme" and "night mode" won't. That's what
  the dashboard's Merge button is for.

### Saving your private settings (the `.env` file)

Instead of typing keys every time, keep them in a small private file:

1. In the project folder, make a copy of `.env.example` and name the copy `.env` (on a Mac the file is hidden in Finder; press Cmd + Shift + . to show hidden files).
2. Open `.env` in a text editor and type your keys after the `=` signs (no spaces, no quotes).
3. Save, then run `npm start`. The app reads the file automatically.

Never share or upload the `.env` file. On a hosting service, enter the same settings in the host's "Environment variables" page instead.

### Adding a request yourself

In the admin dashboard, click **Add a Request** (above the suggestions table) to log something you heard by phone, in a meeting or in a support ticket. Only the title is required. Requester name and email are optional (without a name, it is credited to "The team"). It is published right away and counts as 1 request, and if similar ideas already exist you are told so you can merge them. You can also set its category and status when you add it.

### Adjusting votes and the submitted date

Moving requests over from another tool, or collecting votes by phone or in meetings? You can set both of these on any idea:

- **Extra votes (added by the team):** open the idea in the dashboard (click its title). Whatever you enter is added to the real votes, so an idea with 1 real voter and 12 extra votes shows **13 votes** on the board and ranks accordingly. Real voters stay in the voter list. Customers never see the split. A negative number lowers the total (it never shows below 0). If you want to remove one suspicious voter instead, use **Remove Vote** next to that person.
- **Date submitted:** the same pop-up has a date field. It controls the "time ago" shown on the board (for example "3 months ago") and the "Newest" sort. The date can't be in the future.
- When you use **Add a Request**, you can fill in both from the start: its original date and the votes it had (not counting the requester).
- Merging two ideas adds their extra votes together. The dashboard totals, the CSV export and the daily summary email all use the adjusted totals. Extra votes do not count as extra people in the "People" figure.

## Daily summary email

Once a day you can get ONE email that says what is new on the board: new ideas (including ones waiting for your approval), new votes and comments, and the 5 most-requested ideas. On quiet days nothing is sent.

There are two ways to send it. Pick one.

### Option A (recommended, and needed on Railway): Resend

Some hosts, including Railway on its cheaper plans, block the normal email-sending method (SMTP). Resend sends through an ordinary web request instead, so it works everywhere and has a free tier.

1. Sign up at resend.com.
2. In Resend, go to **Domains**, add your domain (for example `yourcompany.com`) and add the DNS records it shows you at your DNS provider. Wait until it shows **Verified**.
3. In Resend, go to **API Keys**, create a key and copy it.
4. Add these settings (to `.env`, or to your host's Variables page):

| Setting | What it is |
| --- | --- |
| `RESEND_API_KEY` | The key from step 3. Keep it private. |
| `DIGEST_FROM` | Who the email comes from, on your verified domain, for example `Feature Board <feedback@yourcompany.com>`. |
| `DIGEST_TO` | Who receives the summary. Several addresses are fine, separated by commas. |

### Option B: SMTP (any email account)

| Setting | What it is |
| --- | --- |
| `SMTP_HOST` | The outgoing mail server of the email account that SENDS the summary, for example `smtp.yourcompany.com`. |
| `SMTP_USER` | The login for that account, usually the full email address. |
| `SMTP_PASS` | Its password. Many providers require a special "app password". |
| `DIGEST_TO` | Who receives the summary. |
| `SMTP_PORT` | Usually `587` (the default). Use `465` if your provider says so. |
| `DIGEST_FROM` | Optional "from" address. Defaults to `SMTP_USER`. |

### Settings for both options

| Setting | What it is |
| --- | --- |
| `DIGEST_HOUR` | Hour of the day to send, 0 to 23. Default `8`. |
| `DIGEST_TIMEZONE` | Your time zone, for example `America/Toronto`. Default is `UTC`, so set this or "8am" will be off. |
| `PUBLIC_URL` | The web address of your board, so the email can include an "Open Dashboard" link. |

If both `RESEND_API_KEY` and SMTP settings are present, Resend is used.

Restart the app. The Terminal should say `Daily summary email: on`. In the admin dashboard, scroll to **Daily Summary Email** and click **Send Test Summary** to check it works (the test looks back 7 days).

Good to know:
- The app must be running at the send time. On a hosting service that is always the case. If the app was off at 8:00, the summary goes out as soon as it starts later that day.
- It sends at most once per day, even if the app restarts.
- If the test button says it timed out, your host is probably blocking SMTP. Switch to Option A.
- If sending fails (wrong password, for example), the problem is written to the app's log and it tries again the next day. The next successful email still includes everything since the last one that was sent.
- Check your spam folder the first time.

## Testing

The project has an automated test suite  so you can change things safely.

```
npm test               # runs everything, about 20 seconds
npm run test:browser   # optional: drives a real browser (needs: pip install playwright)
```

Each test file starts its own copy of the server with a throwaway database, so your real `data.db` is never touched. The files:

| File | What it checks |
| --- | --- |
| `tests/similarity.test.js` | The "similar suggestions" matching |
| `tests/public-api.test.js` | Customer side: submitting, validation, similar counts, voting, ranking, search, comments, privacy |
| `tests/admin-api.test.js` | Staff only access, dashboard numbers, editing, merging, categories, CSV downloads |
| `tests/review-mode.test.js` | Review before publishing, links always held |
| `tests/protection.test.js` | Bot checks, bad input, rate limits, files that must not be downloadable, security headers |
| `tests/digest.test.js` | The daily summary email: content, schedule, time zones, failures |
| `tests/brand.test.js` | Branding: every setting, bad values, logo and font safety, both pages with different brands |
| `tests/security.test.js`, `tests/db.test.js` | Protection helpers; creating and upgrading the database |

Tests marked "KNOWN LIMITATION" describe behaviour that is deliberate for now (for example, matching works on words, not meanings, so use Merge for synonyms).

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm: command not found` | Node.js isn't installed, or you need to reopen the terminal after installing it. |
| `npm install` fails mentioning `better-sqlite3` | Check `node --version` shows 22 or higher. |
| `EADDRINUSE` when starting | The app is already running in another terminal. Close it, or start with `PORT=3001 npm start`. |
| Suggestions vanished after a redeploy | The host has no persistent disk, or `DB_PATH` doesn't point inside it. See step 2. |
| "That password is incorrect" | The password is whatever `ADMIN_PASSWORD` was set to when the server started. |
| "Too many login attempts" | Wait 15 minutes. The limit survives restarts on purpose. |
| Customers see "Please refresh the page and try again" | Their page was open more than a week, or a browser extension blocked part of it. Refreshing fixes it. |
| The board won't show inside your website | Add your website's address to `EMBED_ALLOWED_SITES`, exactly as it appears in the browser (including `https://`). |
