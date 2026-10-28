# Branding guide

Everything that makes the board look like **your** company lives in one folder, `branding`.
You never need to edit the code.

```
branding/
  brand.json          <- the settings (a plain text file you edit)
  logo.svg            <- your logo (SVG, PNG, JPG or WebP)
  favicon.svg         <- the small icon in the browser tab (optional, see below)
  favicon.png
  favicon.ico
  apple-touch-icon.png
  custom.css          <- extra styling for advanced users (optional)
```

**To apply a change:** save the file, then restart the app (on a host, upload the changed
files to GitHub and it redeploys by itself). Branding is read when the app starts.

**To check your work:** run `npm run check-brand`. It prints what the app understood and lists
anything that needs fixing, in plain English. A mistake in `brand.json` never takes the site
down: the bad value is replaced by a default, and a warning appears in the app's log.

> Want a head start? The `examples` folder holds two complete brands. Copy the files from one
> of them into `branding` (replacing what is there), then change what you like.

---

## 1. A complete `brand.json`

This is the whole file with every setting. You can delete any line you don't want to change:
whatever you leave out uses the default shown in the tables below.

```json
{
  "name": "Your Company",
  "productName": "Feature Requests",
  "website": "https://www.yourcompany.com",

  "logo": "logo.svg",
  "logoHeight": 32,

  "colors": {
    "primary": "#17806f",
    "action": "#1f5f8b",
    "accent": "#2e9e5b",
    "text": "#444444"
  },

  "fonts": {
    "body": "Open Sans",
    "heading": "Open Sans",
    "headingItalic": false,
    "googleFonts": true,
    "weights": [400, 600, 700]
  },

  "text": {
    "heroTitle": "Help Us Build What You Need Next",
    "introText": "Tell us what would make things easier for you, or vote for an idea that's already here. The most-requested ideas rise to the top, and that's how we decide what to build.",
    "suggestPlaceholder": "I'd like {name} to…",
    "detailsPlaceholder": "What would this help you do?",
    "listHeading": "Ideas from Our Customers",
    "adminHeading": "What Customers Are Asking For",
    "emptyList": "No ideas yet. Be the first: tell us what would help.",
    "firstToSuggest": "You're the first to suggest this. Share the board with others; every vote moves it up the list.",
    "loginNote": "For the {name} team only. Enter the admin password to continue."
  },

  "categories": ["Ease of use", "Reporting", "Integrations", "Mobile", "Billing & Payments", "Other"]
}
```

**Editing rules for this file** (it is the one place a typo can bite):
- Keep every piece of text inside straight double quotes `"like this"`.
- Put a comma after every line **except the last one** in each `{ }` or `[ ]` block.
- `true` and `false` have **no quotes**. Numbers have no quotes.
- To use a double quote *inside* text, write `\"`. A normal apostrophe `'` is fine as it is.
- If you're unsure, paste the file into a free checker such as jsonlint.com, or run `npm run check-brand`.

---

## 2. Names and links

| Setting | What it does | Default |
|---|---|---|
| `name` | Your company name. Shown in the browser tab title, as the logo's alt text, in the daily email, and wherever `{name}` appears in the wording. Up to 60 characters. | `Your Company` |
| `productName` | The label next to the logo and in the tab title. | `Feature Requests` |
| `website` | Where clicking the logo goes (opens in a new tab). Must start with `https://`. Leave `""` for no link. | none |

---

## 3. Your logo

| Setting | What it does | Default |
|---|---|---|
| `logo` | The file name of your logo, inside the `branding` folder. SVG, PNG, JPG, WebP or GIF. Set it to `""` to show your company name as text instead. | `logo.svg` |
| `logoHeight` | How tall the logo is shown, in pixels (16 to 120). The width follows automatically, so the logo is never stretched. | `32` |

Tips:
- **SVG is best** (sharp at every size). If you use PNG, make it at least **twice** the height you show it at (for example 80 pixels tall for a `logoHeight` of 40) so it stays crisp on phones.
- A logo with a **transparent or white background** looks best, because the header is white.
- Keep the file name simple: letters, numbers, dashes and underscores. No folders.
- If the file isn't found, the app shows your company name as text and tells you in the log.

---

## 4. Colors

| Setting | Where it shows up | Default |
|---|---|---|
| `primary` | The big colored band at the top of the page, the dashboard's title band, the colored edge on vote buttons and cards, the "In progress" status dot | `#17806f` |
| `action` | Buttons, links, small headings, the vote you've cast, the message band under the headline, the "Planned" status dot | `#1f5f8b` |
| `accent` | The "Done" status dot | `#2e9e5b` |
| `text` | Normal text | `#444444` |

Colors are written as **hex codes**: a `#` followed by 6 characters (or 3), like `#1f5f8b`.
Find yours in your brand guide, or pick one with any free "color picker" site.

**Readable text is chosen for you.** Text on top of your colored bands and buttons is
automatically white or near-black, whichever is easier to read on your color. So a pale yellow
`primary` gets dark text and a deep blue one gets white text.

**Keep `action` and `text` fairly dark.** They are used for words on a white page, so pale
colors become hard to read. `npm run check-brand` tells you if one is too light. A good rule:
if the color looks fine as *text* on white paper, it's fine.

### Optional fine-tuning

You rarely need these. If you leave them out, they are worked out automatically.

| Setting | What it controls | When you'd set it |
|---|---|---|
| `onPrimary` | Text color on the big colored band | You prefer white (or dark) text than the automatic choice |
| `onAction` | Text color on buttons and the message band | Same |
| `titles` | Color of the large section titles ("Ideas from Our Customers") | Automatic: your `primary`, or your `action` if `primary` is too pale to read on white |

---

## 5. Fonts

| Setting | What it does | Default |
|---|---|---|
| `body` | The font for all normal text | `Open Sans` |
| `heading` | The font for headlines and titles. Leave out to use the body font. | same as body |
| `headingItalic` | `true` slants the big headline | `false` |
| `realItalic` | `true` also downloads the font's own italic. Only use it if the font has one (see below). | `false` |
| `googleFonts` | `true` loads the fonts for you from Google Fonts. `false` uses fonts already on the visitor's device, or your own font files. | `true` |
| `weights` | Which boldness levels to download: `400` regular, `600` semibold, `700` bold | `[400, 600, 700]` |

### Using a Google Font

1. Browse [fonts.google.com](https://fonts.google.com) and pick a font.
2. Put its name **exactly as Google spells it** in `body` (and/or `heading`), for example `"Lora"`, `"Montserrat"` or `"Source Sans 3"`.
3. Check the font's page: if it lists fewer weights than 400, 600 and 700, set `weights` to what it offers. For example a font that only comes in regular: `"weights": [400]`. (If you ask for a weight the font doesn't have, Google refuses the whole request and the page falls back to a plain font. `npm run check-brand` can't see this, so look at the font's page.)
4. Restart, and look at the page.

Pairing idea: a friendly serif for headings with a clean sans for body text, for example
`"heading": "Playfair Display"`, `"body": "Source Sans 3"`.

### Using a font that isn't on Google Fonts (your own font files)

1. Put the font file(s) in the `branding` folder (`.woff2` is best; `.woff`, `.ttf` and `.otf` also work). You need the right to use the font on the web.
2. Create `branding/custom.css` and describe the font:

   ```css
   @font-face {
     font-family: "My Brand Font";
     src: url("/brand/MyBrandFont-Regular.woff2") format("woff2");
     font-weight: 400;
     font-display: swap;
   }
   @font-face {
     font-family: "My Brand Font";
     src: url("/brand/MyBrandFont-Bold.woff2") format("woff2");
     font-weight: 700;
     font-display: swap;
   }
   ```
3. In `brand.json`, set `"body": "My Brand Font"` and `"googleFonts": false`.

Font names may contain only letters, numbers, spaces and dashes.

---

## 6. Wording

Everything customers and staff read that you might want to change. Use `{name}` anywhere
and it becomes your company name. Each entry is up to 400 characters.

| Setting | Where it appears | Default |
|---|---|---|
| `heroTitle` | The big headline on the board | Help Us Build What You Need Next |
| `introText` | The paragraph in the band under the headline | Tell us what would make things easier for you… |
| `suggestPlaceholder` | The grey hint inside the suggestion box | I'd like {name} to… |
| `detailsPlaceholder` | The hint in the "Details" box | What would this help you do? |
| `listHeading` | The title above the list of ideas | Ideas from Our Customers |
| `adminHeading` | The title band on the staff dashboard | What Customers Are Asking For |
| `emptyList` | Shown when there are no ideas yet | No ideas yet. Be the first: tell us what would help. |
| `firstToSuggest` | Shown after someone posts an idea nobody else suggested | You're the first to suggest this… |
| `loginNote` | Under the title on the dashboard login | For the {name} team only… |

Plain text only: HTML tags are shown as typed (so nobody, including a typo, can break the page).

---

## 7. Starter categories

`categories` is the list customers choose from when they post an idea. It is used **only the
very first time the app starts with a new database**. After that, add, rename and remove
categories from the staff dashboard, so editing this list later changes nothing for a board
that is already running.

Give 1 to 40 short names (up to 60 characters each).

---

## 8. Browser tab icon (favicon)

Add any of these files to the `branding` folder. The app only links the ones that exist.

| File | Size | Used for |
|---|---|---|
| `favicon.svg` | any (a square design) | Modern browsers: sharpest |
| `favicon.png` | 512 × 512 | Backup for browsers that don't use SVG |
| `favicon.ico` | 16, 32 and 48 pixels | Older browsers |
| `apple-touch-icon.png` | 180 × 180 | When someone adds the page to a phone's home screen |

Don't have these? Upload one square logo image to a free site such as
[realfavicongenerator.net](https://realfavicongenerator.net), download the result and copy the
files in. Browsers keep tab icons for a long time, so you may need to refresh a few times
(or open a private window) to see a new one.

---

## 9. Advanced: `custom.css`

If `branding/custom.css` exists it is loaded **after** everything else, so you can override
anything. Examples:

```css
/* Squarer buttons and inputs */
:root { --radius-button: 2px; --radius-input: 2px; --radius-card: 4px; }

/* A photo behind the headline (put hero.jpg in the branding folder) */
.hero-band { background: var(--brand) url("/brand/hero.jpg") center / cover; }

/* Tighter header */
.topbar .wrap { min-height: 60px; }
```

Useful variables: `--brand`, `--action`, `--ink` (text), `--line` (borders), `--radius-button`,
`--radius-input`, `--radius-card`, `--font`, `--font-heading`.
Files in `branding` are reachable at `/brand/<file name>`, but only pictures, fonts and
stylesheets: `brand.json` is never published.

---

## 10. Quick troubleshooting

| What you see | What to do |
|---|---|
| No change after editing | Restart the app (or redeploy). Then refresh the page; hold Shift while clicking refresh if it still looks old. |
| Everything is generic ("Your Company") | `brand.json` has a typo. Run `npm run check-brand`: it names the problem. Look for a missing comma or quote mark. |
| My logo doesn't show, just text | The file name in `logo` doesn't match the file in `branding` exactly (capital letters count), or the file isn't an image type from the list. |
| My font doesn't show | Google Fonts: check the spelling against fonts.google.com, and `weights` against what the font offers. Own font: check the `url("/brand/…")` file name matches. |
| Text on the colored band is hard to read | Set `onPrimary` to `#ffffff` or `#000000` (section 4), or pick a darker/lighter `primary`. |
| The tab icon didn't change | Browsers cache icons hard. Try a private window, or clear the site's data. |

Still stuck? Run `npm run check-brand` and copy what it says when you ask for help.
