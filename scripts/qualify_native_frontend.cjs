/* Local rendered qualification of the actual built TypeScript frontend and
 * source Python observer pages. API traffic is intercepted with explicit
 * UNAVAILABLE fixtures; no provider, authority, inference or receipt is invoked.
 * SPDX-License-Identifier: Apache-2.0 */
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.env.IMMUNE_QA_OUT || path.join(root, 'reports/native-frontend'));
const ports = [Number(process.env.IMMUNE_QA_PORT || 7893), Number(process.env.IMMUNE_PY_QA_PORT || 7894)];
assert.ok(ports.every(p => Number.isInteger(p) && p > 1024 && p < 65536) && ports[0] !== ports[1]);
const origins = ports.map(p => `http://127.0.0.1:${p}`);
const checks = [], observations = [], servers = [];
const source = {
  checkoutRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim(),
  checkoutTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim(),
  declaredRevision: process.env.SOURCE_REVISION || null,
  localChanges: execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'frontend', 'python', 'scripts', 'tests', '.github/workflows/ci.yml'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim().split('\n').filter(Boolean),
  untrackedSource: execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'frontend', 'python', 'scripts', 'tests', '.github/workflows/ci.yml'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim().split('\n').filter(Boolean),
};
if (source.declaredRevision) assert.equal(source.checkoutRevision, source.declaredRevision, 'Declared candidate must be the actual checkout');

const check = (name, pass, detail = null) => checks.push({ name, pass: Boolean(pass), detail });
const hash = b => createHash('sha256').update(b).digest('hex');
async function inspect(page, forced = false) {
  return page.evaluate(({ forced }) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function rgba(value) {
      if (!CSS.supports('color', value)) throw new Error('Unsupported computed color: ' + value);
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
      const c = [...ctx.getImageData(0, 0, 1, 1).data]; c[3] /= 255; return c;
    }
    function over(a, b) { const alpha = a[3] + b[3] * (1 - a[3]); return alpha ? [0, 1, 2].map(i => (a[i] * a[3] + b[i] * b[3] * (1 - a[3])) / alpha).concat(alpha) : [0, 0, 0, 0]; }
    function luminance(c) { return c.slice(0, 3).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((n, x, i) => n + x * [.2126, .7152, .0722][i], 0); }
    function ratio(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
    const backgrounds = new WeakMap();
    function backdrop(el) {
      if (!el) return [[255, 255, 255, 1]];
      if (backgrounds.has(el)) return backgrounds.get(el);
      const s = getComputedStyle(el), lower = backdrop(el.parentElement), base = lower.map(c => over(rgba(s.backgroundColor), c));
      const colors = s.backgroundImage === 'none' ? [] : (s.backgroundImage.match(/(?:rgba?|color)\([^()]+\)/g) || []).map(rgba);
      const values = colors.length ? base.flatMap(c => [c, ...colors.map(stop => over(stop, c))]) : base;
      const unique = [...new Map(values.map(c => [c.map(x => Math.round(x)).join(','), c])).values()].slice(0, 24);
      backgrounds.set(el, unique); return unique;
    }
    function visible(el) { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getBoundingClientRect().height > 0; }
    function boundedScroller(el) { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p), r = p.getBoundingClientRect(); if (/(auto|scroll)/.test(s.overflowX) && r.left >= -1 && r.right <= innerWidth + 1) return true; } return false; }
    const textFailures = [], overflow = [], uncertain = [];
    let textPairs = 0;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let text; (text = walk.nextNode());) {
      const label = text.textContent.trim(), el = text.parentElement;
      if (!label || !el || el.closest('script,style,svg') || !visible(el) || el.closest('[disabled]')) continue;
      const s = getComputedStyle(el), range = document.createRange(); range.selectNodeContents(text);
      const rect = range.getBoundingClientRect(); if (!rect.width || !rect.height) continue;
      if ((rect.left < -1 || rect.right > innerWidth + 1) && !boundedScroller(el) && !el.closest('.skip-link,.kanchay-skip,.skip')) overflow.push({ text: label.slice(0, 90), left: rect.left, right: rect.right });
      if (forced) continue;
      if (Number(s.opacity) !== 1) { uncertain.push(label.slice(0, 70)); continue; }
      const foreground = rgba(s.color), bg = backdrop(el), measured = Math.min(...bg.map(c => ratio(over(foreground, c), c)));
      const large = Number.parseFloat(s.fontSize) >= 24 || (Number.parseFloat(s.fontSize) >= 18.6667 && Number.parseFloat(s.fontWeight) >= 700);
      const minimum = large ? 3 : 4.5; textPairs++;
      if (measured < minimum) textFailures.push({ text: label.slice(0, 110), foreground: s.color, ratio: +measured.toFixed(3), minimum });
    }
    const targets = [], unlabeled = [];
    for (const el of document.querySelectorAll('button,input:not([type="hidden"]),select,textarea,nav a')) {
      if (!visible(el)) continue;
      const box = (el.matches('input[type="checkbox"]') && el.closest('label') || el).getBoundingClientRect();
      if (!el.disabled && (box.width < 43.9 || box.height < 43.9)) targets.push({ text: (el.textContent || el.getAttribute('aria-label') || el.name).trim().slice(0, 90), tag: el.tagName, width: box.width, height: box.height });
      if (el.matches('button,input,select,textarea') && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.labels?.length && !el.textContent.trim() && !el.getAttribute('title')) unlabeled.push(el.outerHTML.slice(0, 200));
    }
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, h1Count: [...document.querySelectorAll('h1')].filter(visible).length, textPairs, textFailures, uncertain, overflow, targets, unlabeled, animations: document.getAnimations().filter(a => a.playState === 'running').length };
  }, { forced });
}


(async () => {
  fs.mkdirSync(out, { recursive: true });
  let browser;
  function launch(command, args, env, name) {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(out, name + '.log'));
    child.stdout.pipe(log); child.stderr.pipe(log);
    child.on('error', error => check(name + ' starts', false, error.message));
    servers.push(child); return child;
  }
  async function open(index, pathname = '/', options = {}, scenario = 'unavailable') {
    const origin = origins[index];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', ...options });
    const page = await context.newPage(), errors = [], requests = [], denied = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      requests.push({ method: request.method(), path: url.pathname });
      if (url.origin !== origin) { denied.push(request.method() + ' ' + url.origin + url.pathname); return route.abort(); }
      if (url.pathname.startsWith('/api/') || url.pathname === '/readyz') {
        if (request.method() === 'POST' && scenario !== 'explicit-read-only') { denied.push(request.method() + ' ' + url.pathname); return route.abort(); }
        if (scenario === 'explicit-read-only' && request.method() === 'POST' && ['/api/immune/brain', '/api/immune/nexus/verify'].includes(url.pathname)) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(url.pathname.endsWith('/brain') ? { hits: [{ handle: 'LOCAL_FIXTURE', excerpt: '<img src=x onerror=alert(1)>', score: 0 }] } : { verified: false, observedOutputHash: 'a'.repeat(64) }) });
        }
        if (scenario === 'zero' && url.pathname.endsWith('/dashboard')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ brain: { chunks: 0 }, mesh: { liveCount: 0, of: 4, reached: false } }) });
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, status: 'READ_ONLY', write_ready: false, error: 'LOCAL_UNAVAILABLE_FIXTURE' }) });
      }
      if (!['GET', 'HEAD'].includes(request.method())) { denied.push(request.method() + ' ' + url.pathname); return route.abort(); }
      return route.continue();
    });
    await page.goto(origin + pathname, { waitUntil: 'networkidle', timeout: 15000 });
    return { context, page, errors, requests, denied };
  }
  function traffic(name, current, explicitPostCount = 0) {
    check(name + ': no page errors, external calls or unrequested writes', !current.errors.length && !current.denied.length && current.requests.filter(r => r.method === 'POST').length === explicitPostCount, { errors: current.errors, denied: current.denied, posts: current.requests.filter(r => r.method === 'POST') });
  }
  function record(name, result) {
    observations.push({ name, ...result });
    check(name + ': reflow, text, labels, controls and reduced motion', result.documentWidth <= result.viewport + 1 && result.h1Count === 1 && !result.overflow.length && !result.targets.length && !result.unlabeled.length && !result.textFailures.length && !result.uncertain.length && !result.animations, result);
  }
  try {
    launch(process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js'), 'preview', '--config', path.join(root, 'frontend/vite.config.ts'), '--host', '127.0.0.1', '--port', String(ports[0]), '--strictPort'], { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(ports[0]), BASE_PATH: '/' }, 'typescript-preview');
    const python = 'from http.server import ThreadingHTTPServer;import immune.server as s;\ndef denied(): raise RuntimeError("Runtime is forbidden in presentation qualification")\ns.get_runtime=denied\nThreadingHTTPServer(("127.0.0.1",'+ports[1]+'),s.Handler).serve_forever()';
    launch(process.env.PYTHON || 'python3', ['-B', '-c', python], { PATH: process.env.PATH, PYTHONPATH: path.join(root, 'python'), PYTHONDONTWRITEBYTECODE: '1' }, 'python-preview');
    for (const origin of origins) {
      let ready = false;
      for (let i = 0; i < 100; i++) { try { if ((await fetch(origin, { signal: AbortSignal.timeout(1000), redirect: 'error' })).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
      assert.ok(ready, 'Local source preview starts: ' + origin);
    }
    browser = await chromium.launch({ headless: true, ...(process.env.IMMUNE_BROWSER ? { executablePath: process.env.IMMUNE_BROWSER } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const pages = [{ index: 0, route: '/', name: 'workspace' }, { index: 1, route: '/', name: 'observer' }, { index: 1, route: '/nexus.html', name: 'nexus' }];
    const widths = process.env.IMMUNE_QA_FOCUS === 'print' ? [] : process.env.IMMUNE_QA_QUICK ? [1440, 320] : [2560, 1920, 1440, 1024, 768, 375, 320];
    for (const surface of pages) {
      for (const width of widths) {
        const current = await open(surface.index, surface.route, { viewport: { width, height: 1000 } });
        for (const theme of ['dark', 'light']) {
          if (theme === 'light') await current.page.getByRole('button', { name: 'Use light appearance' }).click();
          record(`${surface.name} ${width}px ${theme}`, await inspect(current.page));
          if (width === 1440 || width === 320) {
            await current.page.screenshot({ path: path.join(out, `${surface.name}-${width}-${theme}.png`), fullPage: true });
            await current.page.screenshot({ path: path.join(out, `${surface.name}-${width}-${theme}-viewport.png`) });
          }
          if (surface.index === 0 && [1440, 320].includes(width)) {
            for (const tab of ['ghost', 'wraith', 'echo', 'mesh', 'graph', 'range']) {
              await current.page.locator('#lattice-tab-' + tab).click();
              record(`${surface.name} ${width}px ${theme} ${tab}`, await inspect(current.page));
              check(tab + ' has one selected tab and associated panel', await current.page.locator('[role=tab][aria-selected=true]').count() === 1 && await current.page.locator('#lattice-panel-' + tab).count() === 1);
            }
          }
        }
        if (surface.index === 0) check('Three.js is not requested before opt-in', !current.requests.some(r => /ThreeScene-/.test(r.path)));
        traffic(surface.name + ' ' + width, current);
        await current.context.close();
      }
      if (process.env.IMMUNE_QA_QUICK) continue;
      for (const mode of [{ label: 'forced', forcedColors: 'active' }, { label: 'contrast', contrast: 'more' }, { label: 'no-js', javaScriptEnabled: false }, { label: 'print' }, { label: 'landscape', viewport: { width: 844, height: 390 } }]) {
        const { label, ...options } = mode;
        if (process.env.IMMUNE_QA_FOCUS === 'print' && label !== 'print') continue;
        const current = await open(surface.index, surface.route, options);
        if (label === 'print') await current.page.emulateMedia({ media: 'print' });
        record(surface.name + ' ' + label, await inspect(current.page, label === 'forced'));
        traffic(surface.name + ' ' + label, current);
        await current.context.close();
      }
    }
    const keyboard = await open(0);
    await keyboard.page.keyboard.press('Tab');
    check('Workspace skip link is first keyboard stop', await keyboard.page.locator('.kanchay-skip').evaluate(el => el === document.activeElement));
    await keyboard.page.keyboard.press('Enter');
    check('Skip link focuses main evidence', await keyboard.page.locator('main').evaluate(el => el === document.activeElement));
    await keyboard.page.locator('#lattice-tab-range').focus();
    for (const [key, target] of [['ArrowRight', 'ghost'], ['End', 'graph'], ['Home', 'range'], ['ArrowLeft', 'graph']]) {
      await keyboard.page.keyboard.press(key);
      check('Lattice keyboard ' + key, await keyboard.page.locator('#lattice-tab-' + target).evaluate(el => el === document.activeElement && el.getAttribute('aria-selected') === 'true'));
    }
    await keyboard.page.getByRole('button', { name: 'Show 3D illustration', exact: true }).click();
    await keyboard.page.waitForFunction(() => document.querySelector('#immune-illustration canvas') || /WebGL/.test(document.querySelector('#immune-illustration').textContent));
    check('3D chunk is fetched only on explicit visual request', keyboard.requests.some(r => /ThreeScene-/.test(r.path)));
    const illustrationCanvas = keyboard.page.locator('#immune-illustration canvas');
    if (await illustrationCanvas.count()) {
      const before = await illustrationCanvas.screenshot();
      await keyboard.page.waitForTimeout(300);
      check('Reduced-motion 3D illustration remains static', hash(before) === hash(await illustrationCanvas.screenshot()));
    }
    await keyboard.page.waitForFunction(() => document.querySelector('[data-testid="immune-hud"]').textContent.includes('UNAVAILABLE'), { timeout: 15000 });
    check('Unavailable fixture cannot admit a governed cycle', await keyboard.page.locator('[data-testid="whole-system-readiness"]').innerText() !== 'READY');
    record('Workspace failed source observation', await inspect(keyboard.page));
    await keyboard.page.getByRole('button', { name: 'Hide 3D illustration', exact: true }).click();
    check('Hiding illustration releases the canvas', await keyboard.page.locator('#immune-illustration canvas').count() === 0);
    traffic('Workspace keyboard and optional illustration', keyboard);
    await keyboard.context.close();
    const zero = await open(1, '/', {}, 'zero');
    check('Observed zero counts are preserved', /^0 handles/.test(await zero.page.locator('#brainMeta').innerText()) && await zero.page.locator('#meshMeta').innerText() === '0-of-4 · OPEN');
    traffic('Observer zero', zero); await zero.context.close();
    for (const [route, control] of [['/', 'retrieve'], ['/nexus.html', 'verify']]) {
      const current = await open(1, route, {}, 'explicit-read-only');
      check('Opening ' + route + ' does not send POST', !current.requests.some(r => r.method === 'POST'));
      if (control === 'verify') await current.page.locator('#expectedHash').fill('a'.repeat(64));
      await current.page.locator('#' + control).click();
      await current.page.waitForTimeout(100);
      check('Python governed control remains unavailable', await current.page.locator(control === 'verify' ? '#run' : '#cycle').isDisabled());
      traffic('Explicit ' + control + ' uses only intercepted read-only fixture', current, 1);
      record('Python ' + control + ' response', await inspect(current.page));
      await current.context.close();
    }
    const missing = await open(0, '/unknown-local-route');
    check('Unknown document has useful native recovery', await missing.page.getByRole('heading', { name: 'Page unavailable' }).count() === 1 && await missing.page.getByRole('link', { name: 'Open the workspace' }).count() === 1);
    traffic('Unknown document', missing); await missing.context.close();
    for (const [index, prefix] of [[0, 'frontend/public/assets/szl'], [1, 'python/immune/static/szl']]) {
      for (const name of ['szl-tokens.css', 'SOURCE.json', 'PROJECTION.json', 'szl-icon-32.svg', 'favicon.svg', 'apple-touch-icon.png', ...(index ? ['surface.css', 'appearance.js'] : [])]) {
        const response = await fetch(origins[index] + '/assets/szl/' + name, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        const bytes = Buffer.from(await response.arrayBuffer());
        check('Served native byte identity ' + prefix + '/' + name, response.ok && hash(bytes) === hash(fs.readFileSync(path.join(root, prefix, name))));
      }
    }
  } catch (error) { check('Qualification completes', false, error.stack); }
  finally {
    if (browser) await browser.close();
    for (const server of servers) server.kill('SIGTERM');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ schema: 'szl.local-presentation-observation.v1', unsigned: true, source, node: process.version, playwright: require('playwright/package.json').version, scope: 'Built TypeScript/source Python pages; explicit API fixtures intercepted locally; no deployment or operational evidence', focus: process.env.IMMUNE_QA_FOCUS || null, quick: Boolean(process.env.IMMUNE_QA_QUICK), createdAt: new Date().toISOString(), checks, observations }, null, 2) + '\n');
    const failed = checks.filter(c => !c.pass);
    console.log(JSON.stringify({ checks: checks.length, passed: checks.length - failed.length, failed }, null, 2));
    process.exitCode = failed.length ? 1 : 0;
  }
})();
