// ============================================================================
// tests/brand.test.js — the branding system (name, colors, fonts, logo, wording)
// ----------------------------------------------------------------------------
// Part 1 tests brand.js directly with small temporary branding folders.
// Part 2 starts the real server with different branding folders and checks
// what visitors would actually receive.
// ============================================================================
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBrand, renderPage, contrast, readableOn } = require('../brand');
const { startServer } = require('./helpers');

const FIXTURE = path.join(__dirname, 'fixtures', 'brand');
const tmpDirs = [];
// Make a temporary branding folder holding brand.json (an object, or raw text) and any extra files.
function makeBrand(json, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-board-brand-'));
  tmpDirs.push(dir);
  if (json !== null) fs.writeFileSync(path.join(dir, 'brand.json'), typeof json === 'string' ? json : JSON.stringify(json));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const warned = (b, pattern) => b.warnings.some((w) => pattern.test(w));
after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('reading brand.json', () => {
  test('no brand.json at all: built-in generic defaults, with a note', () => {
    const b = loadBrand(makeBrand(null));
    assert.equal(b.name, 'Your Company');
    assert.equal(b.colors.primary, '#17806f');
    assert.equal(b.fonts.body, 'Open Sans');
    assert.ok(b.categories.length >= 5);
    assert.ok(warned(b, /No brand\.json/));
  });

  test('a broken file (missing comma) falls back to defaults and says so', () => {
    const b = loadBrand(makeBrand('{ "name": "Acme" "productName": "Ideas" }'));
    assert.equal(b.name, 'Your Company');
    assert.ok(warned(b, /could not be read/));
    assert.ok(warned(b, /comma/));
  });

  test('not an object (a list or a number) is refused the same way', () => {
    assert.ok(warned(loadBrand(makeBrand('[1,2]')), /could not be read/));
    assert.ok(warned(loadBrand(makeBrand('42')), /could not be read/));
  });

  test('a good file is used and raises no warnings', () => {
    const dir = makeBrand({ name: 'Acme Tools', productName: 'Ideas', website: 'https://acme.example', logo: 'logo.svg', logoHeight: 40 }, { 'logo.svg': SVG });
    const b = loadBrand(dir);
    assert.equal(b.name, 'Acme Tools');
    assert.equal(b.productName, 'Ideas');
    assert.equal(b.website, 'https://acme.example');
    assert.equal(b.logoFile, 'logo.svg');
    assert.equal(b.logoHeight, 40);
    assert.deepEqual(b.warnings, []);
  });

  test('the test fixture brand loads cleanly', () => {
    const b = loadBrand(FIXTURE);
    assert.deepEqual(b.warnings, []);
    assert.equal(b.name, 'Test Brand');
    assert.deepEqual(Object.keys(b.icons).sort(), ['apple', 'ico', 'png', 'svg']);
  });

  test('wrong types are ignored with a warning, not a crash', () => {
    const b = loadBrand(makeBrand({ name: 123, productName: ['x'], colors: 'red', fonts: 5, text: [], categories: 'nope', logoHeight: 'tall' }));
    assert.equal(b.name, 'Your Company');
    assert.equal(b.productName, 'Feature Requests');
    assert.equal(b.colors.action, '#1f5f8b');
    assert.equal(b.fonts.body, 'Open Sans');
    assert.equal(b.logoHeight, 32);
    assert.ok(warned(b, /"name" should be text/));
    assert.ok(warned(b, /categories/));
    assert.ok(warned(b, /logoHeight/));
  });

  test('over-long text is refused, spaces are trimmed', () => {
    const b = loadBrand(makeBrand({ name: '  Acme  ', productName: 'x'.repeat(200) }));
    assert.equal(b.name, 'Acme');
    assert.equal(b.productName, 'Feature Requests');
    assert.ok(warned(b, /productName/));
  });

  test('{name} in the wording is replaced with the company name', () => {
    const b = loadBrand(makeBrand({ name: 'Acme', text: { suggestPlaceholder: "I'd like {name} to…", loginNote: 'For {name} staff only.' } }));
    assert.equal(b.text.suggestPlaceholder, "I'd like Acme to…");
    assert.equal(b.text.loginNote, 'For Acme staff only.');
    assert.equal(b.text.heroTitle.includes('{name}'), false);
  });
});

describe('colors', () => {
  test('hex colors are accepted (3 or 6 digits, any case) and tidied', () => {
    const b = loadBrand(makeBrand({ colors: { primary: '#ABC', action: '#112233' } }));
    assert.equal(b.colors.primary, '#aabbcc');
    assert.equal(b.colors.action, '#112233');
    assert.deepEqual(b.warnings, []);
  });

  test('anything else falls back to the default for that one color only', () => {
    for (const bad of ['teal', 'rgb(1,2,3)', '#12', '#12345g', '#1234567', '', 5, '#fff; } body { display:none']) {
      const b = loadBrand(makeBrand({ colors: { primary: bad, action: '#112233' } }));
      assert.equal(b.colors.primary, '#17806f', String(bad));
      assert.equal(b.colors.action, '#112233', 'the other colors are kept');
      if (bad !== '') assert.ok(warned(b, /colors\.primary/), String(bad));
    }
  });

  test('the generated stylesheet never contains anything but the checked values', () => {
    const b = loadBrand(makeBrand({ colors: { primary: '#fff; } body { display:none' }, fonts: { body: 'Evil"; } *{x:y' } }));
    assert.ok(!b.css.includes('display:none'));
    assert.ok(!b.css.includes('Evil'));
    assert.equal((b.css.match(/\{/g) || []).length, 1, 'one block only');
  });

  test('text color on the hero and on buttons is chosen for readability', () => {
    assert.equal(readableOn('#000000'), '#ffffff');
    assert.equal(readableOn('#1f5f8b'), '#ffffff');
    assert.equal(readableOn('#ffffff'), '#1a1a1a');
    assert.equal(readableOn('#ffe066'), '#1a1a1a');
    const pale = loadBrand(makeBrand({ colors: { primary: '#ffe066', action: '#ffd23f' } }));
    assert.equal(pale.onPrimary, '#1a1a1a');
    assert.equal(pale.onAction, '#1a1a1a');
    assert.match(pale.css, /--on-brand: #1a1a1a/);
    assert.match(pale.css, /--on-action: #1a1a1a/);
  });

  test('large section titles use the primary color, unless it is too pale to read on white', () => {
    assert.equal(loadBrand(makeBrand({ colors: { primary: '#1f5f8b', action: '#222222' } })).titles, '#1f5f8b');
    assert.equal(loadBrand(makeBrand({ colors: { primary: '#ffd23f', action: '#7a1f3d' } })).titles, '#7a1f3d');
    assert.match(loadBrand(makeBrand({ colors: { primary: '#ffd23f', action: '#7a1f3d' } })).css, /--title: #7a1f3d/);
  });

  test('onPrimary, onAction and titles can be set by hand, and bad values are ignored', () => {
    const b = loadBrand(makeBrand({ colors: { primary: '#46b3d1', onPrimary: '#FFF', onAction: '#000000', titles: '#46B3D1' } }));
    assert.equal(b.onPrimary, '#ffffff');
    assert.equal(b.onAction, '#000000');
    assert.equal(b.titles, '#46b3d1');
    assert.match(b.css, /--on-brand: #ffffff/);
    assert.deepEqual(b.warnings, []);
    const bad = loadBrand(makeBrand({ colors: { primary: '#46b3d1', onPrimary: 'white', titles: 7 } }));
    assert.equal(bad.onPrimary, '#1a1a1a', 'worked out automatically');
    assert.ok(warned(bad, /colors\.onPrimary/));
    assert.ok(warned(bad, /colors\.titles/));
  });

  test('contrast maths: black on white is 21, same color is 1', () => {
    assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.01);
    assert.ok(Math.abs(contrast('#777777', '#777777') - 1) < 0.001);
  });

  test('pale link/heading and text colors get a readability tip (but are still used)', () => {
    const b = loadBrand(makeBrand({ colors: { action: '#9ad0e0', text: '#bbbbbb' } }));
    assert.equal(b.colors.action, '#9ad0e0');
    assert.ok(warned(b, /colors\.action.*light/));
    assert.ok(warned(b, /colors\.text.*light/));
  });

  test('a hover shade and a backdrop are derived from the action color', () => {
    const b = loadBrand(makeBrand({ colors: { action: '#204060' } }));
    assert.match(b.css, /--action: #204060/);
    assert.match(b.css, /--action-hover: #1b3652/);
    assert.match(b.css, /--backdrop: rgba\(32, 64, 96, 0\.6\)/);
  });
});

describe('fonts', () => {
  test('default: Open Sans from Google Fonts, three weights, no italic', () => {
    const b = loadBrand(makeBrand({}));
    assert.equal(b.fontsUrl, 'https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap');
    assert.match(b.css, /--font: "Open Sans", Arial, sans-serif/);
    assert.match(b.css, /--hero-style: normal/);
  });

  test('two fonts, with spaces and dashes; the heading font is its own Google family', () => {
    const b = loadBrand(makeBrand({ fonts: { body: 'Source Sans 3', heading: 'Playfair Display', weights: [400, 700] } }));
    assert.equal(b.fontsUrl, 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;700&family=Playfair+Display:wght@400;700&display=swap');
    assert.match(b.css, /--font: "Source Sans 3"/);
    assert.match(b.css, /--font-heading: "Playfair Display"/);
  });

  test('a slanted headline uses the browser slant, unless you say the font has a true italic', () => {
    const slanted = loadBrand(makeBrand({ fonts: { headingItalic: true } }));
    assert.match(slanted.css, /--hero-style: italic/);
    assert.ok(!slanted.fontsUrl.includes('ital'), 'never asks Google for an italic that may not exist');
    const real = loadBrand(makeBrand({ fonts: { headingItalic: true, realItalic: true } }));
    assert.match(real.fontsUrl, /Open\+Sans:ital,wght@0,400;0,600;0,700;1,400/);
  });

  test('googleFonts:false means no Google link at all (installed or custom fonts)', () => {
    const b = loadBrand(makeBrand({ fonts: { body: 'Georgia', googleFonts: false } }));
    assert.equal(b.fontsUrl, '');
    assert.ok(!b.headTags.includes('fonts.googleapis.com'));
    assert.match(b.css, /--font: "Georgia"/);
  });

  test('weights must be a sensible list', () => {
    assert.deepEqual(loadBrand(makeBrand({ fonts: { weights: [700, 400, 400] } })).fonts.weights, [400, 700]);
    for (const bad of [[], 'bold', [450], [400, 'x'], [1000], [100, 200, 300, 400, 500, 600, 700]]) {
      const b = loadBrand(makeBrand({ fonts: { weights: bad } }));
      assert.deepEqual(b.fonts.weights, [400, 600, 700], JSON.stringify(bad));
      assert.ok(warned(b, /weights/), JSON.stringify(bad));
    }
  });

  test('font names that could carry code are refused', () => {
    for (const bad of ['Open Sans"; } body { display:none', '<script>', 'a/b', "x'y", 'Font;Name', '../../x', 'a'.repeat(80), 7]) {
      const b = loadBrand(makeBrand({ fonts: { body: bad, heading: bad } }));
      assert.equal(b.fonts.body, 'Open Sans', String(bad));
      assert.ok(warned(b, /fonts\.(body|heading)/), String(bad));
      assert.ok(!b.css.includes('display:none') && !b.css.includes('<script'), String(bad));
    }
  });

  test('true/false settings must be real booleans', () => {
    const b = loadBrand(makeBrand({ fonts: { headingItalic: 'yes', googleFonts: 'no' } }));
    assert.equal(b.fonts.headingItalic, false);
    assert.ok(warned(b, /headingItalic/));
    assert.ok(warned(b, /googleFonts/));
  });
});

describe('logo and icons', () => {
  test('the logo is used when the file exists; any picture type works', () => {
    for (const file of ['logo.svg', 'logo.png', 'Logo.JPG', 'x.webp']) {
      const b = loadBrand(makeBrand({ logo: file }, { [file]: 'x' }));
      assert.equal(b.logoFile, file);
      assert.match(b.logoHtml, new RegExp(`src="/brand/${file}"`));
      assert.deepEqual(b.warnings, [], file);
    }
  });

  test('no logo, or a missing file: the company name is shown as text', () => {
    const none = loadBrand(makeBrand({ name: 'Acme', logo: '' }));
    assert.deepEqual(none.warnings, []);
    assert.equal(none.logoFile, '');
    assert.equal(none.logoHtml, '<span class="logo-text">Acme</span>');
    const missing = loadBrand(makeBrand({ name: 'Acme', logo: 'nope.svg' }));
    assert.ok(warned(missing, /not found/));
    assert.match(missing.logoHtml, /logo-text/);
  });

  test('folder tricks and non-picture files are refused as a logo', () => {
    for (const bad of ['../server.js', '../../etc/passwd', 'sub/logo.svg', '/etc/hosts', 'brand.json', 'logo.exe', 'script.js']) {
      const b = loadBrand(makeBrand({ logo: bad }, { 'logo.svg': SVG }));
      assert.equal(b.logoFile, '', bad);
      assert.ok(warned(b, /"logo"/), bad);
    }
  });

  test('a company name with HTML in it is shown as harmless text', () => {
    const b = loadBrand(makeBrand({ name: '<img src=x onerror=alert(1)>', logo: '' }));
    assert.ok(!b.logoHtml.includes('<img'));
    assert.match(b.logoHtml, /&lt;img/);
  });

  test('logo height is limited to 16 to 120', () => {
    assert.equal(loadBrand(makeBrand({ logoHeight: 16 })).logoHeight, 16);
    assert.equal(loadBrand(makeBrand({ logoHeight: 120 })).logoHeight, 120);
    for (const bad of [15, 121, 30.5, -3, '40']) {
      const b = loadBrand(makeBrand({ logoHeight: bad }));
      assert.equal(b.logoHeight, 32, String(bad));
      assert.ok(warned(b, /logoHeight/));
    }
  });

  test('tab icons are only linked when the files exist', () => {
    const none = loadBrand(makeBrand({}));
    assert.ok(!none.headTags.includes('rel="icon"'));
    const some = loadBrand(makeBrand({}, { 'favicon.svg': SVG, 'favicon.ico': 'x' }));
    assert.deepEqual(Object.keys(some.icons).sort(), ['ico', 'svg']);
    assert.match(some.headTags, /rel="icon" href="\/favicon\.svg"/);
    assert.match(some.headTags, /rel="icon" href="\/favicon\.ico"/);
    assert.ok(!some.headTags.includes('favicon.png'));
    assert.ok(!some.headTags.includes('apple-touch-icon'));
  });

  test('custom.css is linked only when the file exists', () => {
    assert.ok(!loadBrand(makeBrand({})).headTags.includes('custom.css'));
    assert.match(loadBrand(makeBrand({}, { 'custom.css': 'body{}' })).headTags, /\/brand\/custom\.css/);
  });

  test('website must be an http(s) address', () => {
    assert.equal(loadBrand(makeBrand({ website: 'https://acme.example/x' })).website, 'https://acme.example/x');
    assert.equal(loadBrand(makeBrand({ website: '' })).website, '');
    for (const bad of ['javascript:alert(1)', 'acme.com', 'https://a b', 'https://x"onclick="y', 'ftp://x.y']) {
      const b = loadBrand(makeBrand({ website: bad }));
      assert.equal(b.website, '', bad);
      assert.ok(warned(b, /website/), bad);
    }
  });
});

describe('starter categories', () => {
  test('your own list is used; duplicates and blanks are dropped', () => {
    const b = loadBrand(makeBrand({ categories: [' Reports ', 'Mobile', 'Mobile', '', 5, 'Other'] }));
    assert.deepEqual(b.categories, ['Reports', 'Mobile', 'Other']);
  });
  test('an empty or unusable list falls back to the default list', () => {
    for (const bad of [[], 'x', {}, [1, 2], ['a'.repeat(61)]]) {
      const b = loadBrand(makeBrand({ categories: bad }));
      assert.ok(b.categories.length >= 5, JSON.stringify(bad));
      assert.ok(warned(b, /categories/), JSON.stringify(bad));
    }
  });
});

describe('filling in the page templates', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

  test('every {{placeholder}} in both real pages is filled in', () => {
    const b = loadBrand(FIXTURE);
    const idx = renderPage(read('index.html'), b, { pageTitle: b.productName });
    const adm = renderPage(read('admin.html'), b, { pageTitle: 'Suggestions Dashboard' });
    assert.ok(!/\{\{\w+\}\}/.test(idx), 'index has leftovers: ' + idx.match(/\{\{\w+\}\}/));
    assert.ok(!/\{\{\w+\}\}/.test(adm), 'admin has leftovers: ' + adm.match(/\{\{\w+\}\}/));
  });

  test('everything the brand puts in a page is escaped', () => {
    const evil = '"><script>alert(1)</script>';
    const b = loadBrand(makeBrand({ name: evil, productName: evil, website: 'https://ok.example', text: { heroTitle: evil, introText: evil, suggestPlaceholder: evil, detailsPlaceholder: evil, listHeading: evil, adminHeading: evil, loginNote: evil, emptyList: evil, firstToSuggest: evil } }));
    for (const f of ['index.html', 'admin.html']) {
      const html = renderPage(read(f), b, { pageTitle: evil });
      assert.ok(!html.includes('<script>alert(1)'), f);
      assert.ok(!html.includes('"><script'), f);
    }
  });

  test('the data block for app.js cannot close its own script tag', () => {
    const b = loadBrand(makeBrand({ name: 'A', text: { emptyList: '</script><script>alert(1)</script>' } }));
    const html = renderPage(read('index.html'), b, { pageTitle: 'x' });
    const block = html.match(/<script type="application\/json" id="brand-data">(.*?)<\/script>/s)[1];
    assert.ok(!block.includes('<'));
    assert.equal(JSON.parse(block).text.emptyList, '</script><script>alert(1)</script>');
  });

  test('a logo-less brand with no website still renders a sensible header', () => {
    const b = loadBrand(makeBrand({ name: 'Acme', logo: '', website: '' }));
    const html = renderPage(read('index.html'), b, { pageTitle: 'Ideas' });
    assert.match(html, /<a class="logo" >/);
    assert.match(html, /<span class="logo-text">Acme<\/span>/);
    assert.match(html, /<title>Ideas \| Acme<\/title>/);
  });
});

// ----------------------------------------------------------------------------
// The real server, with different branding folders
// ----------------------------------------------------------------------------
describe('the running server: fixture brand', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(async () => { await s.stop(); s.cleanup(); });

  test('customer page shows the brand: title, logo, wording, header link', async () => {
    const html = (await s.get('/')).text;
    assert.match(html, /<title>Feature Requests \| Test Brand<\/title>/);
    assert.match(html, /<img class="logo-img" src="\/brand\/test-logo\.svg" alt="Test Brand">/);
    assert.match(html, /<a class="logo" href="https:\/\/www\.example\.com" target="_blank" rel="noopener">/);
    assert.match(html, /<h1>Help Us Build What Your Clinic Needs Next<\/h1>/);
    assert.match(html, /placeholder="I&#39;d like Test Brand to…"/);
    assert.match(html, /<link rel="stylesheet" href="\/brand\.css">/);
    assert.ok(!/\{\{\w+\}\}/.test(html));
  });

  test('the same page is served at /index.html, and never as a raw template', async () => {
    const a = (await s.get('/')).text, b = (await s.get('/index.html')).text;
    assert.equal(a, b);
    assert.ok(!a.includes('{{'));
  });

  test('dashboard page shows the brand on the login screen and after', async () => {
    const res = await s.get('/admin.html');
    assert.match(res.text, /<title>Suggestions Dashboard \| Test Brand<\/title>/);
    assert.equal((res.text.match(/class="logo-img"/g) || []).length, 2);
    assert.match(res.text, /For the Test Brand team only/);
    assert.match(res.text, /<h1>What Clinics Are Asking For<\/h1>/);
    assert.ok(!res.text.includes('{{'));
  });

  test('/brand.css carries the colors and fonts', async () => {
    const res = await s.get('/brand.css');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/css/);
    assert.match(res.text, /--action: #31708f/);
    assert.match(res.text, /--brand: #46b3d1/);
    assert.match(res.text, /--font: "Open Sans"/);
  });

  test('the logo and tab icons are served from the branding folder', async () => {
    const logo = await s.get('/brand/test-logo.svg');
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get('content-type'), /image\/svg\+xml/);
    for (const f of ['/favicon.svg', '/favicon.png', '/favicon.ico', '/apple-touch-icon.png']) assert.equal((await s.get(f)).status, 200, f);
  });

  test('brand.json and other non-picture files in the folder are NOT public', async () => {
    for (const p of ['/brand/brand.json', '/brand/', '/brand', '/brand/%2e%2e/server.js', '/brand/..%2fserver.js', '/brand/.env', '/brand/x.js', '/brand/nope.png']) {
      const res = await s.get(p);
      assert.ok(res.status === 404 || res.status === 400, `${p} -> ${res.status}`);
      assert.ok(!res.text.includes('"name"') && !res.text.includes('require('), p);
    }
  });

  test('the security policy lets the page use your own font files and Google Fonts', async () => {
    const csp = (await s.get('/')).headers.get('content-security-policy');
    assert.match(csp, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
    assert.match(csp, /style-src [^;]*https:\/\/fonts\.googleapis\.com/);
  });

  test('starter categories come from brand.json', async () => {
    const names = (await s.get('/api/meta')).json.categories.map((c) => c.name);
    assert.equal(names.length, 7);
    assert.ok(names.includes('Forms') && names.includes('Scheduling'));
  });
});

describe('the running server: a completely different brand', () => {
  let s, dir;
  before(async () => {
    dir = makeBrand({
      name: 'Harbor & Co', productName: 'Ideas Box', website: 'https://harbor.example',
      logo: 'harbor.png', logoHeight: 44,
      colors: { primary: '#ffd23f', action: '#7a1f3d', accent: '#228833', text: '#222222' },
      fonts: { body: 'Lora', heading: 'Montserrat', googleFonts: true, weights: [400, 700] },
      text: { heroTitle: 'Tell {name} what to build', introText: 'Your ideas shape our roadmap.', listHeading: 'What others suggested', emptyList: 'Nothing yet, add the first idea!' },
      categories: ['Sailing', 'Gear'],
    }, { 'harbor.png': 'not-really-a-png', 'custom.css': '.hero-band{letter-spacing:1px}', 'MyFont.woff2': 'font-bytes' });
    s = await startServer({ env: { BRAND_DIR: dir } });
  });
  after(async () => { await s.stop(); s.cleanup(); });

  test('the page uses the new name, logo, wording and fonts', async () => {
    const html = (await s.get('/')).text;
    assert.match(html, /<title>Ideas Box \| Harbor &amp; Co<\/title>/);
    assert.match(html, /src="\/brand\/harbor\.png" alt="Harbor &amp; Co"/);
    assert.match(html, /<h1>Tell Harbor &amp; Co what to build<\/h1>/);
    assert.match(html, /What others suggested/);
    assert.match(html, /family=Lora:wght@400;700&family=Montserrat:wght@400;700/);
    assert.match(html, /href="\/brand\/custom\.css"/);
    assert.ok(!html.includes('Test Brand') && !html.includes('Clinic'));
  });

  test('colors apply, with readable text chosen for the pale hero color', async () => {
    const css = (await s.get('/brand.css')).text;
    assert.match(css, /--brand: #ffd23f/);
    assert.match(css, /--on-brand: #1a1a1a/);
    assert.match(css, /--action: #7a1f3d/);
    assert.match(css, /--on-action: #ffffff/);
    assert.match(css, /--font-heading: "Montserrat"/);
    assert.match(css, /--logo-height: 44px/);
  });

  test('custom.css and the logo file are served; no icons were supplied so none are linked', async () => {
    assert.equal((await s.get('/brand/custom.css')).status, 200);
    assert.equal((await s.get('/brand/harbor.png')).status, 200);
    assert.equal((await s.get('/brand/MyFont.woff2')).status, 200, 'your own font files can be served');
    const html = (await s.get('/')).text;
    assert.ok(!html.includes('rel="icon"'));
    assert.equal((await s.get('/favicon.ico')).status, 404);
    assert.equal((await s.get('/favicon.svg')).status, 404);
  });

  test('first-run categories come from this brand', async () => {
    assert.deepEqual((await s.get('/api/meta')).json.categories.map((c) => c.name), ['Gear', 'Sailing']);
  });

  test('the dashboard login uses the brand too, and posting still works', async () => {
    const adm = (await s.get('/admin.html')).text;
    assert.match(adm, /For the Harbor &amp; Co team only/);
    const idea = await s.makeIdea({ title: 'A brand new idea about sails' });
    assert.ok(idea.id);
  });
});

describe('the running server: a broken or missing brand never stops the site', () => {
  test('broken brand.json: starts with defaults and logs why', async () => {
    const s = await startServer({ env: { BRAND_DIR: makeBrand('{ "name": "Acme" oops }') } });
    try {
      assert.match(s.output, /Branding: brand\.json could not be read/);
      const html = (await s.get('/')).text;
      assert.match(html, /<title>Feature Requests \| Your Company<\/title>/);
      assert.equal((await s.get('/brand.css')).status, 200);
    } finally { await s.stop(); s.cleanup(); }
  });

  test('an empty folder works too', async () => {
    const s = await startServer({ env: { BRAND_DIR: makeBrand(null) } });
    try {
      assert.equal((await s.get('/')).status, 200);
      assert.equal((await s.get('/admin.html')).status, 200);
      assert.match((await s.get('/')).text, /logo-text">Your Company</);
    } finally { await s.stop(); s.cleanup(); }
  });
});
