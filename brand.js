// ============================================================================
// brand.js — reads your branding settings (name, colors, fonts, logo, wording)
// ----------------------------------------------------------------------------
// Everything you can customize lives in ONE folder called "branding":
//
//     branding/brand.json     <- the settings (a plain text file you edit)
//     branding/logo.svg       <- your logo (png, jpg or webp also work)
//     branding/favicon.*      <- the small icon in the browser tab (optional)
//     branding/custom.css     <- extra styling for advanced users (optional)
//
// This file's job is to:
//   1. read branding/brand.json,
//   2. check every value (a typo should never break the site: a bad value
//      is replaced by the default and a clear warning is printed), and
//   3. turn the result into what the pages need: a stylesheet of colors and
//      fonts, the logo tag, the wording, and so on.
//
// To check your settings without starting the app, run:  npm run check-brand
// ============================================================================

const fs = require('fs');
const path = require('path');

// The folder holding your branding. BRAND_DIR lets you point somewhere else.
function brandDir() {
  return path.resolve(process.env.BRAND_DIR || path.join(__dirname, 'branding'));
}

// What you get for anything you leave out of brand.json.
const DEFAULTS = {
  name: 'Your Company',
  productName: 'Feature Requests',
  website: '',
  logo: 'logo.svg',
  logoHeight: 32,
  colors: {
    primary: '#2a9d8f',   // the big colored band at the top, accents
    action: '#e9c46a',    // buttons, links, headings
    accent: '#264653',    // the "Done" status dot
    text: '#444444',      // normal text
  },
  fonts: {
    body: 'Open Sans',
    heading: '',          // empty = same as body
    headingItalic: false, // true = the big headline is slanted
    realItalic: false,    // true = also download the font's true italic (only if it has one)
    googleFonts: true,    // true = download the fonts from Google Fonts
    weights: [400, 600, 700],
  },
  text: {
    heroTitle: 'Help Us Choose What to Build Next',
    introText: "Tell us what you woild like to see next, or vote for an idea that's already here.",
    suggestPlaceholder: "I'd like {name} to…",
    detailsPlaceholder: 'What would this help you do?',
    listHeading: 'Ideas from Our Customers',
    adminHeading: 'What Customers Are Asking For',
    emptyList: 'No ideas yet. Be the first: tell us what would help.',
    firstToSuggest: "You're the first to suggest this. Share the board with others; every vote moves it up the list.",
    loginNote: 'For the {name} team only. Enter the admin password to continue.',
  },
  categories: ['Ease of use', 'Reporting', 'Integrations', 'Mobile', 'Billing & Payments', 'Other'],
};

// ---------- Small helpers --------------------------------------------------

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// "#abc" -> "#aabbcc", always lower-case, so the maths below is simple.
function normalizeHex(hex) {
  let h = hex.toLowerCase();
  if (h.length === 4) h = '#' + [...h.slice(1)].map((c) => c + c).join('');
  return h;
}
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// How bright a color looks to the eye (0 = black, 1 = white), per the web
// accessibility (WCAG) formula. Used to decide whether text on a color
// should be white or dark.
function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
// Contrast between two colors: 1 (identical) to 21 (black on white). 4.5+ is
// the accessibility target for normal text.
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
// White or near-black, whichever reads better on this background.
const readableOn = (bg) => (contrast(bg, '#ffffff') >= contrast(bg, '#1a1a1a') ? '#ffffff' : '#1a1a1a');
// Mix a color with black (amount 0..1) for hover shades.
const darken = (hex, amount) => toHex(toRgb(hex).map((v) => v * (1 - amount)));
// Mix a color with white (amount 0..1).
const lighten = (hex, amount) => toHex(toRgb(hex).map((v) => v + (255 - v) * amount));

// Font names go into a web address and a stylesheet, so only plain
// characters are allowed (this also blocks anyone sneaking code in).
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 \-]{0,48}$/;

// Escape text for putting inside HTML.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LOGO_TYPES = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif'];
const ICON_FILES = {
  svg: ['favicon.svg', 'image/svg+xml'],
  png: ['favicon.png', 'image/png'],
  ico: ['favicon.ico', 'image/x-icon'],
  apple: ['apple-touch-icon.png', 'image/png'],
};

// ---------- The main function ----------------------------------------------

function loadBrand(dir = brandDir()) {
  const warnings = [];
  const warn = (msg) => warnings.push(msg);

  // 1. Read the file. A missing file means "use all defaults"; a broken file
  //    (usually a missing comma or quote) is reported, then defaults are used.
  let raw = {};
  const file = path.join(dir, 'brand.json');
  if (!fs.existsSync(file)) {
    warn(`No brand.json found in ${dir}. Using the built-in defaults.`);
  } else {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the file must contain one { ... } block');
    } catch (err) {
      warn(`brand.json could not be read (${err.message}). Using the built-in defaults. Tip: this is usually a missing or extra comma or quote mark.`);
      raw = {};
    }
  }

  // Pick a text value: trimmed, within a length limit, else the default.
  const str = (obj, key, def, { max = 300, allowEmpty = false, where = key } = {}) => {
    const v = obj ? obj[key] : undefined;
    if (v === undefined || v === null) return def;
    if (typeof v !== 'string') { warn(`"${where}" should be text in quotes. Using the default.`); return def; }
    const t = v.trim();
    if (!t) return allowEmpty ? '' : def;
    if (t.length > max) { warn(`"${where}" is longer than ${max} characters. Using the default.`); return def; }
    return t;
  };

  const name = str(raw, 'name', DEFAULTS.name, { max: 60 });
  const productName = str(raw, 'productName', DEFAULTS.productName, { max: 60 });

  let website = str(raw, 'website', DEFAULTS.website, { max: 200, allowEmpty: true });
  if (website && !/^https?:\/\/[^\s"'<>]+$/i.test(website)) {
    warn('"website" must start with https:// (or http://). The logo will not link anywhere.');
    website = '';
  }

  // 2. Colors.
  const colors = {};
  for (const key of Object.keys(DEFAULTS.colors)) {
    const v = raw.colors && raw.colors[key];
    if (v === undefined || v === null || v === '') { colors[key] = DEFAULTS.colors[key]; continue; }
    if (typeof v !== 'string' || !HEX.test(v.trim())) {
      warn(`colors.${key} is "${v}", which is not a hex color like #17806f. Using the default.`);
      colors[key] = DEFAULTS.colors[key];
    } else colors[key] = normalizeHex(v.trim());
  }
  // Optional extras. Leave them out and they are worked out for you:
  //   onPrimary  text color on the big colored band   (white or dark, whichever reads better)
  //   onAction   text color on buttons                (same rule)
  //   titles     color of the large section titles    (your primary color, unless it is too
  //                                                    pale to read on white, then your action color)
  const optional = {};
  for (const key of ['onPrimary', 'onAction', 'titles']) {
    const v = raw.colors && raw.colors[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !HEX.test(v.trim())) warn(`colors.${key} is "${v}", which is not a hex color like #ffffff. Working it out automatically instead.`);
    else optional[key] = normalizeHex(v.trim());
  }
  // Readability checks (advice only: your colors are still used).
  if (contrast(colors.action, '#ffffff') < 4.5) {
    warn(`colors.action (${colors.action}) is a bit light for links and headings on a white page (contrast ${contrast(colors.action, '#ffffff').toFixed(1)}, aim for 4.5 or more). Try a darker shade.`);
  }
  if (contrast(colors.text, '#ffffff') < 4.5) {
    warn(`colors.text (${colors.text}) is a bit light for reading on white (contrast ${contrast(colors.text, '#ffffff').toFixed(1)}, aim for 4.5 or more). Try a darker shade.`);
  }

  // 3. Fonts.
  const rawFonts = raw.fonts && typeof raw.fonts === 'object' ? raw.fonts : {};
  const fontName = (key, def) => {
    const v = rawFonts[key];
    if (v === undefined || v === null || v === '') return def;
    if (typeof v !== 'string' || !FONT_NAME.test(v.trim())) {
      warn(`fonts.${key} ("${v}") should be just a font name, like Open Sans (letters, numbers, spaces and dashes). Using the default.`);
      return def;
    }
    return v.trim();
  };
  const fonts = {
    body: fontName('body', DEFAULTS.fonts.body),
    heading: fontName('heading', ''),
    headingItalic: rawFonts.headingItalic === undefined ? DEFAULTS.fonts.headingItalic : rawFonts.headingItalic === true,
    realItalic: rawFonts.realItalic === true,
    googleFonts: rawFonts.googleFonts === undefined ? DEFAULTS.fonts.googleFonts : rawFonts.googleFonts !== false,
    weights: DEFAULTS.fonts.weights,
  };
  for (const k of ['headingItalic', 'realItalic']) {
    if (rawFonts[k] !== undefined && typeof rawFonts[k] !== 'boolean') warn(`fonts.${k} should be true or false (no quotes). Using false.`);
  }
  if (rawFonts.googleFonts !== undefined && typeof rawFonts.googleFonts !== 'boolean') warn('fonts.googleFonts should be true or false (no quotes).');
  if (rawFonts.weights !== undefined) {
    const w = rawFonts.weights;
    const ok = Array.isArray(w) && w.length > 0 && w.length <= 6 && w.every((n) => Number.isInteger(n) && n >= 100 && n <= 900 && n % 100 === 0);
    if (ok) fonts.weights = [...new Set(w)].sort((a, b) => a - b);
    else warn('fonts.weights should be a list like [400, 600, 700]. Using the default.');
  }
  if (!fonts.heading) fonts.heading = fonts.body;

  // Google Fonts web address. Fonts that only come in one weight (for
  // example Pacifico) need "weights": [400] or Google refuses the request.
  let fontsUrl = '';
  if (fonts.googleFonts) {
    const family = (f, italic) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:` +
      (italic ? 'ital,wght@0,' + fonts.weights.join(';0,') + ';1,400' : 'wght@' + fonts.weights.join(';'));
    const families = [fonts.body];
    if (fonts.heading !== fonts.body) families.push(fonts.heading);
    // A true italic is only requested when you say the font has one
    // (realItalic). Otherwise the browser slants the letters itself, which
    // always works. Asking Google for an italic that doesn't exist makes it
    // refuse the whole request, so we never do that by default.
    const parts = families.map((f) => family(f, f === fonts.heading && fonts.headingItalic && fonts.realItalic));
    fontsUrl = `https://fonts.googleapis.com/css2?${parts.join('&')}&display=swap`;
  }

  // 4. Wording.
  const rawText = raw.text && typeof raw.text === 'object' ? raw.text : {};
  const text = {};
  for (const key of Object.keys(DEFAULTS.text)) {
    text[key] = str(rawText, key, DEFAULTS.text[key], { max: 400, where: `text.${key}` });
    text[key] = text[key].split('{name}').join(name);
  }

  // 5. Starter categories (used only the very first time the app starts).
  let categories = DEFAULTS.categories;
  if (raw.categories !== undefined) {
    const c = raw.categories;
    const clean = Array.isArray(c) ? [...new Set(c.filter((x) => typeof x === 'string').map((x) => x.trim()).filter((x) => x && x.length <= 60))] : [];
    if (clean.length >= 1 && clean.length <= 40) categories = clean;
    else warn('"categories" should be a list of 1 to 40 short names, like ["Reports", "Mobile"]. Using the default list.');
  }

  // 6. Files: logo and icons.
  let logoFile = '';
  const logoGiven = raw.logo !== undefined;     // only complain about a missing logo you asked for
  const wantedLogo = str(raw, 'logo', DEFAULTS.logo, { max: 100, allowEmpty: true });
  if (wantedLogo) {
    const base = path.basename(wantedLogo);      // never allow folders or ../ tricks
    const ext = path.extname(base).toLowerCase();
    if (base !== wantedLogo || !LOGO_TYPES.includes(ext)) {
      warn(`"logo" ("${wantedLogo}") must be a file name in the branding folder ending in ${LOGO_TYPES.join(', ')}. Showing the name as text instead.`);
    } else if (!fs.existsSync(path.join(dir, base))) {
      if (logoGiven) warn(`The logo file "${base}" was not found in the branding folder. Showing the name as text instead.`);
    } else logoFile = base;
  }
  let logoHeight = DEFAULTS.logoHeight;
  if (raw.logoHeight !== undefined) {
    if (Number.isInteger(raw.logoHeight) && raw.logoHeight >= 16 && raw.logoHeight <= 120) logoHeight = raw.logoHeight;
    else warn('"logoHeight" should be a whole number from 16 to 120 (pixels). Using 32.');
  }

  const icons = {};
  for (const [key, [fileName]] of Object.entries(ICON_FILES)) {
    if (fs.existsSync(path.join(dir, fileName))) icons[key] = fileName;
  }
  const hasCustomCss = fs.existsSync(path.join(dir, 'custom.css'));

  // ----- Put it together -----------------------------------------------------
  const c = colors;
  const onPrimary = optional.onPrimary || readableOn(c.primary);
  const onAction = optional.onAction || readableOn(c.action);
  const titles = optional.titles || (contrast(c.primary, '#ffffff') >= 3 ? c.primary : c.action);
  const [ar, ag, ab] = toRgb(c.action);
  const quoted = (f) => `"${f}"`;

  // The stylesheet. It only sets the "variables" that styles.css uses.
  const css = `/* Generated from branding/brand.json: do not edit here. */
:root {
  --brand: ${c.primary};
  --on-brand: ${onPrimary};
  --action: ${c.action};
  --action-hover: ${darken(c.action, 0.15)};
  --on-action: ${onAction};
  --heading: ${c.action};
  --title: ${titles};
  --ink: ${c.text};
  --muted: ${c.text};
  --s-planned: ${c.action};
  --s-in_progress: ${c.primary};
  --s-done: ${c.accent};
  --backdrop: rgba(${ar}, ${ag}, ${ab}, 0.6);
  --font: ${quoted(fonts.body)}, Arial, sans-serif;
  --font-heading: ${quoted(fonts.heading)}, Arial, sans-serif;
  --hero-style: ${fonts.headingItalic ? 'italic' : 'normal'};
  --logo-height: ${logoHeight}px;
}
`;

  const logoUrl = logoFile ? '/brand/' + encodeURIComponent(logoFile) : '';
  const logoHtml = logoFile
    ? `<img class="logo-img" src="${logoUrl}" alt="${esc(name)}">`
    : `<span class="logo-text">${esc(name)}</span>`;

  // Tags that go in every page's <head>: icons, fonts, and our stylesheet.
  const iconTags = [];
  if (icons.svg) iconTags.push('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
  if (icons.png) iconTags.push('<link rel="icon" href="/favicon.png" type="image/png" sizes="512x512">');
  if (icons.ico) iconTags.push('<link rel="icon" href="/favicon.ico" sizes="48x48">');
  if (icons.apple) iconTags.push('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  const headTags = [
    ...iconTags,
    ...(fontsUrl ? ['<link rel="preconnect" href="https://fonts.googleapis.com">', '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>', `<link href="${fontsUrl}" rel="stylesheet">`] : []),
    '<link rel="stylesheet" href="/styles.css">',
    '<link rel="stylesheet" href="/brand.css">',
    ...(hasCustomCss ? ['<link rel="stylesheet" href="/brand/custom.css">'] : []),
  ].join('\n  ');

  // The few words app.js needs, handed to the page as plain data.
  const clientData = { name, text: { emptyList: text.emptyList, firstToSuggest: text.firstToSuggest } };

  return {
    dir, name, productName, website, text, categories, colors, fonts, fontsUrl,
    logoFile, logoHtml, logoHeight, icons, hasCustomCss, css, headTags, clientData, warnings,
    onPrimary, onAction, titles,
  };
}

// Fill the {{placeholders}} in a page template with the brand's values.
function renderPage(template, brand, { pageTitle }) {
  const values = {
    head: brand.headTags,
    title: `${esc(pageTitle)} | ${esc(brand.name)}`,
    name: esc(brand.name),
    productName: esc(brand.productName),
    logo: brand.logoHtml,
    logoLink: brand.website ? `href="${esc(brand.website)}" target="_blank" rel="noopener"` : '',
    heroTitle: esc(brand.text.heroTitle),
    introText: esc(brand.text.introText),
    suggestPlaceholder: esc(brand.text.suggestPlaceholder),
    detailsPlaceholder: esc(brand.text.detailsPlaceholder),
    listHeading: esc(brand.text.listHeading),
    adminHeading: esc(brand.text.adminHeading),
    loginNote: esc(brand.text.loginNote),
    // "<" is escaped so this data can never close its own <script> tag early.
    brandData: JSON.stringify(brand.clientData).replace(/</g, '\\u003c'),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in values ? values[key] : m));
}

module.exports = { loadBrand, renderPage, brandDir, DEFAULTS, ICON_FILES, contrast, readableOn, esc };

// `npm run check-brand` runs this file directly and prints a short report.
if (require.main === module) {
  const brand = loadBrand();
  console.log(`Branding folder: ${brand.dir}`);
  console.log(`Name:            ${brand.name}`);
  console.log(`Logo:            ${brand.logoFile || '(none, the name is shown as text)'}`);
  console.log(`Colors:          primary ${brand.colors.primary}, action ${brand.colors.action}, accent ${brand.colors.accent}, text ${brand.colors.text}`);
  console.log(`Fonts:           ${brand.fonts.body}${brand.fonts.heading !== brand.fonts.body ? ' + ' + brand.fonts.heading : ''}${brand.fonts.googleFonts ? ' (Google Fonts)' : ' (installed fonts only)'}`);
  console.log(`Tab icons:       ${Object.keys(brand.icons).join(', ') || '(none)'}`);
  if (brand.warnings.length) {
    console.log('\nThings to look at:');
    brand.warnings.forEach((w) => console.log('  - ' + w));
    process.exitCode = 1;
  } else console.log('\nAll good: no problems found.');
}
