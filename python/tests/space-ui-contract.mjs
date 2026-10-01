import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'space');
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function element(id = '') {
  return {
    id, value: '', disabled: true, children: [], dataset: {}, textContent: '',
    set innerHTML(_) { throw new Error('Untrusted HTML insertion is forbidden'); },
    setAttribute() {}, addEventListener() {},
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    getContext() { return new Proxy({}, { get: () => () => {} }); },
  };
}

async function boot(file, scenario) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  const ids = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, element(id)]));
  for (const [id, value] of Object.entries({ steps: '8', dt: '0.01', chaos: '0.45', drive: '0.92' })) {
    if (ids.has(id)) ids.get(id).value = value;
  }
  const requests = [];
  const events = new Map();
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (scenario === 'offline') throw new Error('network unavailable');
    const write = scenario === 'contradictory';
    let body = {};
    let status = 200;
    if (url === '/readyz') { body = { ok: write, write_ready: write, status: write ? 'READY' : 'READ_ONLY' }; status = write ? 200 : 503; }
    if (url.endsWith('/nexus/status')) body = { state: 'EXECUTABLE', source: { revision: '<img src=x onerror=alert(1)>' }, immuneReadiness: { write_ready: write } };
    if (url.endsWith('/dashboard')) body = { readiness: { write_ready: write }, organs: { organs: [{ title: '<img>', provenance: 'UNAVAILABLE', detail: '<script>' }] }, mesh: { votes: [{ title: '<img>', stage: 'UNKNOWN' }] } };
    if (url.endsWith('/brain')) body = { hits: [{ handle: '<img>', excerpt: '<script>', score: 0 }] };
    if (url.endsWith('/nexus/verify')) body = { verified: true, observedOutputHash: 'a'.repeat(64) };
    return { ok: status === 200, status, json: async () => body };
  };
  const context = vm.createContext({
    console, fetch, AbortSignal,
    document: { hidden: false, getElementById: id => ids.get(id), createElement: () => element(), addEventListener: (id, fn) => events.set(id, fn) },
    window: { addEventListener: (id, fn) => events.set(id, fn) },
    setInterval: () => 1,
  });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, code]) => code).join('\n');
  vm.runInContext(script, context, { filename: file });
  await settle();
  return { ids, requests, events };
}

for (const file of ['nexus.html', 'index.html']) {
  for (const scenario of ['read-only', 'contradictory', 'offline']) {
    const { ids, requests, events } = await boot(file, scenario);
    const button = ids.get(file === 'nexus.html' ? 'run' : 'cycle');
    assert.equal(button.disabled, true, `${file}/${scenario}: initial action disabled`);
    button.disabled = false;
    await button.onclick();
    assert.equal(button.disabled, true, `${file}/${scenario}: programmatic action refuses`);
    assert.equal(requests.some(({ url }) => url.endsWith('/nexus/run') || url.endsWith('/cycle')), false);
    events.get('offline')?.();
    assert.equal(button.disabled, true);
    assert.ok(requests.some(({ url }) => url === '/readyz'));
  }
}
const replay = await boot('nexus.html', 'read-only');
await replay.ids.get('verify').onclick();
assert.equal(replay.requests.some(({ url }) => url.endsWith('/nexus/verify')), false);
replay.ids.get('expectedHash').value = 'a'.repeat(64);
await replay.ids.get('verify').onclick();
assert.equal(replay.requests.filter(({ url }) => url.endsWith('/nexus/verify')).length, 1);
assert.equal(replay.ids.get('receiptRead').textContent, 'NO NEW RECEIPT');
console.log('Channel B UI contract: 7 scenarios passed; no governed action POST, no innerHTML');
