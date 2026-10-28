# Step-by-step install guide

This guide takes you from "I have a folder of files" to "my board is live on the internet",
with every click explained. No coding is needed. Allow about **45 minutes** the first time.

> In a hurry, or comfortable with GitHub and hosting? The **Quick start** at the top of
> `README.md` is the short version.

**What you will end up with**
- A board where customers suggest and vote on ideas, branded as your company.
- A private staff dashboard at `/admin.html`, protected by a password only you know.
- Optionally: your own web address (like `feedback.yourcompany.com`), a "verify you are human"
  check against spam, and a daily summary email.

**What you need**
- A free **GitHub** account (github.com): stores your files.
- An account with a **hosting service** that runs Node.js programs. This guide uses
  **Railway** (railway.com) as the example. It is a paid service (there may be a small trial),
  so check its current pricing. Render, Fly.io and others work the same way; the steps below
  tell you what to look for.
- About 45 minutes, and your company logo as a file.

> Button names on these websites change from time to time. If a button isn't exactly where
> this guide says, look for the one with the closest name.

---

## Part 1: Get your files ready

### 1.1 Unzip the download
Double-click the downloaded `.zip` file (Mac) or right-click it and choose **Extract All**
(Windows). You get a folder containing files such as `server.js`, `package.json`, and folders
called `branding`, `public` and `docs`.

### 1.2 Make it yours (optional now, easy to do later)
Open the **`branding`** folder:
1. Replace **`logo.svg`** with your own logo (keep the name `logo.svg`, or use another name and
   tell `brand.json` about it).
2. Open **`brand.json`** in any plain text editor (Notepad on Windows, TextEdit on Mac; on a Mac
   choose *Format → Make Plain Text* first). Change `name` to your company name, then
   adjust colors, fonts and wording as you like.
3. Save the file.

The full list of settings, with examples, is in **`docs/BRANDING.md`**. You can come back to
this at any time, even after launch.

---

## Part 2: Put the files on GitHub

GitHub is where your hosting service will fetch the files from.

1. Sign in at **github.com**. Click the **+** at the top right, then **New repository**.
2. **Repository name:** for example `feature-board`.
3. Choose **Private** (so only you can see the files).
4. Click **Create repository**.
5. On the next page, click the **uploading an existing file** link.
6. Open your unzipped folder on your computer. Select **everything inside it** (all the files
   and folders: `server.js`, `branding`, `public`, `docs`, and the rest) and drag them onto
   the GitHub page. Drag the *contents*, not the outer folder itself.
   - If a file called `.gitignore` doesn't show in your file window, don't worry. It is a
     "hidden" file; GitHub works fine without it, but you can include it by turning on
     *Show hidden files* (Mac: press `Cmd + Shift + .`).
   - Don't upload a folder called `node_modules` or any `.db` file or a file named `.env`,
     if you happen to have them.
7. Wait for the uploads to finish. Scroll down, leave the message as it is, and click
   **Commit changes**.
8. Check the repository page: you should see the files listed, including `server.js`,
   `package.json` and the folders `branding` and `public`.

> **Tip for later:** the free **GitHub Desktop** app lets you change files on your computer
> and send them to GitHub with two clicks (Commit, then Push), instead of dragging files
> into the website every time.

---

## Part 3: Put it online with Railway

### 3.1 Create the project
1. Go to **railway.com** and sign up (using your GitHub login is the easiest).
2. Click **New Project**, then **Deploy from GitHub repo**.
3. The first time, Railway asks permission to see your repositories. Allow it (you can limit
   it to just the one repository).
4. Choose your `feature-board` repository. Railway starts building. The first build takes a
   minute or two. It may say it **failed** or **crashed** until you finish the next steps; that's normal.

### 3.2 Give it a place to save your data (important!)
The board stores ideas in a file. Without a **volume** (a permanent disk), that file would be
erased every time the app restarts, and every idea would be lost.

1. In your project, click your service (the box named after your repository).
2. Add a volume. In Railway, right-click an empty area of the project canvas (or use the
   **+ Create** button) and choose **Volume**, then attach it to your service.
3. For the **mount path**, type: `/data`
4. Save or confirm.

### 3.3 Set your private settings (variables)
1. Click your service, then the **Variables** tab.
2. Add these, one at a time (**New Variable**). Names must match exactly, and the values must
   have **no spaces** before or after them:

   | Name | Value |
   |---|---|
   | `ADMIN_PASSWORD` | A long password only you know. This opens your staff dashboard. Use a password manager to make one. |
   | `DB_PATH` | `/data/data.db` |

3. Railway restarts the service by itself when you add variables. If it doesn't, open the
   **Deployments** tab and click **Redeploy**.

### 3.4 Get your web address
1. Click your service, then the **Settings** tab.
2. Find **Networking** (sometimes called **Public Networking**) and click **Generate Domain**.
3. You get an address like `feature-board-production.up.railway.app`.

### 3.5 Look at it
1. Open that address in your browser. You should see your board, with your name and logo.
2. Add `/admin.html` to the end of the address, enter your `ADMIN_PASSWORD`, and you're in
   the staff dashboard.
3. Post a test idea on the board. Because new ideas wait for your approval by default
   (to keep spam off the public board), approve it from the dashboard under **Waiting for Review**.

If the page doesn't load, open the **Deployments** tab, click the latest deployment and read
the **Logs**. Common causes are listed in *Troubleshooting* below.

**You're live.** Everything after this is optional.

---

## Part 4 (optional): Use your own web address

Instead of `…up.railway.app`, use something like `feedback.yourcompany.com`.

1. In Railway: your service, **Settings**, **Networking**, **Custom Domain**. Type
   `feedback.yourcompany.com` and click **Add**. Railway shows you a **CNAME** record: a
   "name" (here `feedback`) and a "value" (an address ending in `.up.railway.app`).
2. Open the website where your **domain's DNS** is managed (the company you bought the domain
   from, such as GoDaddy, Namecheap or Cloudflare). Find **DNS Settings** or **Manage DNS**.
3. **Add a record:** Type **CNAME**, Name **feedback**, Value: what Railway showed you.
   Save.
4. Wait a few minutes (sometimes up to an hour). Railway shows a green tick when it's working
   and sets up the secure `https://` padlock for you.

---

## Part 5 (optional): Block spam bots with Cloudflare Turnstile

This adds a free "Verify you are human" check to the form.

1. Sign up (free) at **cloudflare.com**, then in the dashboard open **Turnstile** and click
   **Add widget**.
2. Name it, and under **Hostname** add your board's address (for example
   `feedback.yourcompany.com`). Choose the **Managed** widget type. Create it.
3. Cloudflare shows a **Site Key** and a **Secret Key**. In Railway's **Variables** tab add:

   | Name | Value |
   |---|---|
   | `TURNSTILE_SITE_KEY` | the Site Key |
   | `TURNSTILE_SECRET_KEY` | the Secret Key |

   Copy and paste carefully. A stray space before or after is the most common mistake
   (the app trims spaces for you, but a missing character is still an error).
4. The app restarts. Open the board, start typing an idea: the check appears above the button.

---

## Part 6 (optional): A daily summary email

Once a morning, the app can email you what's new: new ideas, votes and comments, and the most
requested ideas. If nothing happened, nothing is sent.

Railway's cheaper plans block the usual way of sending email, so this guide uses **Resend**
(resend.com), which has a free tier:

1. Sign up at **resend.com**. Open **Domains**, add your company domain, and add the DNS
   records it shows (the same place you added the CNAME in Part 4). Wait for **Verified**.
2. Open **API Keys**, create one and copy it.
3. In Railway's **Variables** tab add:

   | Name | Value |
   |---|---|
   | `RESEND_API_KEY` | the key you just copied |
   | `DIGEST_FROM` | `Feature Board <feedback@yourcompany.com>` (an address on the domain you verified) |
   | `DIGEST_TO` | where to send it; several addresses are fine, separated by commas |
   | `DIGEST_HOUR` | the hour to send, 0 to 23 (default 8) |
   | `DIGEST_TIMEZONE` | your time zone, for example `America/Toronto` (default is UTC) |
   | `PUBLIC_URL` | your board's address, for the "Open Dashboard" button in the email |

4. After the app restarts, open the staff dashboard, scroll to **Daily Summary Email** and
   click the test button to send one right away.

More detail, including sending through ordinary email (SMTP), is in `README.md` under
*Daily summary email*.

---

## Part 7: Making changes later

### Changing the branding or wording
1. Edit the files in the `branding` folder on your computer.
2. In your GitHub repository, open the `branding` folder, click **Add file**, then
   **Upload files**, drag in the changed files and click **Commit changes** (or use GitHub Desktop).
3. Railway notices and redeploys on its own within a minute or two. Refresh your board.

### Getting a new version of this app
Upload the new files over the old ones the same way. **Don't replace your `branding`
folder** (keep yours). Your ideas are safe: they live in the volume, not in the files.

### Backing up your ideas
In the staff dashboard click **Download CSV** for a copy you can open in Excel or Google Sheets.
The database itself is the file `data.db` in your volume.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| The page says "Application failed to respond" or won't load | Open the **Deployments** tab and read the **Logs**. Check that the service has finished deploying and that you generated a domain (3.4). |
| Ideas disappear after a restart | The volume isn't attached, or `DB_PATH` isn't exactly `/data/data.db`. Check 3.2 and 3.3. |
| The page shows "Your Company" instead of my name | `brand.json` has a typo (often a missing comma or quote), so the defaults were used. The logs say what's wrong. See `docs/BRANDING.md`. |
| "That password is incorrect" | The password is exactly what `ADMIN_PASSWORD` says in Variables (no spaces). Change it there if you've forgotten it. |
| The "Verify you are human" check shows an error | The Site Key is mistyped, or the board's address isn't listed under the widget's hostnames in Cloudflare. |
| The summary email says "Connection timeout" | SMTP is blocked on your plan. Use Resend (Part 6). |
| "npm error" lines in the logs when redeploying | Normal noise from the old copy shutting down. Ignore it if the new one starts ("Feature board running"). |

Other hosting services: the same three things matter anywhere: the **start command** is
`npm start`, you attach a **persistent disk**, and you set `ADMIN_PASSWORD` and `DB_PATH`.
