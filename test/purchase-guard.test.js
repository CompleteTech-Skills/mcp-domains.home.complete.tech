import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { config } from '../build/config.js';
import { ProviderManager } from '../build/provider-manager.js';

const originalMode = config.purchaseMode;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  config.purchaseMode = 'live';
  globalThis.fetch = async () => {
    assert.fail('Purchase guard tests must not make network requests');
  };
});

afterEach(() => {
  config.purchaseMode = originalMode;
  globalThis.fetch = originalFetch;
});

function quote(registrar, registrationCost, overrides = {}) {
  return {
    registrar,
    registrarName: registrar,
    currency: 'USD',
    registrationCost,
    exact: true,
    available: true,
    checkedAt: '2026-10-25T00:00:00Z',
    ...overrides,
  };
}

function fixture(quotes = [quote('namecheap', 4), quote('porkbun', 12), quote('cloudflare', 20)]) {
  const manager = new ProviderManager();
  const calls = [];
  // Replace provider capabilities and methods on this instance only. No real
  // credentials are needed and no adapter can send a registration request.
  for (const id of ['porkbun', 'cloudflare']) {
    manager[id].status.configured = true;
    manager[id].status.supportsLivePurchase = true;
    manager[id].registerDomain = async (domain) => {
      calls.push({ registrar: id, domain });
      return { registrar: id, mode: config.purchaseMode, liveAttempted: false, success: true };
    };
  }
  const comparison = {
    domain: 'example.test',
    sld: 'example',
    tld: 'test',
    consensusAvailable: true,
    availabilitySignals: [],
    quotes,
    cheapestQuote: quotes[0] ?? null,
    livePurchasableVia: ['porkbun', 'cloudflare'],
  };
  manager.compareDomain = async (domain) => ({ ...comparison, domain });
  return { manager, comparison, calls };
}

test('guard uses the recommended registrar price, preserving the cheapest comparison quote', () => {
  const { manager, comparison } = fixture();
  const plan = manager.createPurchasePlan(comparison);
  assert.equal(plan.recommendedRegistrar, 'porkbun');
  assert.equal(plan.guardPhrase, 'BUY example.test VIA PORKBUN FOR 12.00 USD');
  assert.equal(plan.cheapestQuote.registrationCost, 4);
  assert.equal(plan.canPurchaseNow, true);
});

test('guard cannot authorize a different requested registrar', async () => {
  const { manager, comparison, calls } = fixture();
  const { guardPhrase } = manager.createPurchasePlan(comparison);
  await assert.rejects(manager.registerDomain('example.test', 'cloudflare', guardPhrase), /Registrar mismatch/);
  assert.deepEqual(calls, []);
});

test('matching guard invokes only the selected registrar with the selected domain', async () => {
  const { manager, comparison, calls } = fixture();
  const { guardPhrase } = manager.createPurchasePlan(comparison);
  const result = await manager.registerDomain('example.test', 'porkbun', guardPhrase);
  assert.equal(result.success, true);
  assert.deepEqual(calls, [{ registrar: 'porkbun', domain: 'example.test' }]);
});

test('changed domain and stale price guards fail before registration', async () => {
  const { manager, comparison, calls } = fixture();
  const { guardPhrase } = manager.createPurchasePlan(comparison);
  await assert.rejects(manager.registerDomain('other.test', 'porkbun', guardPhrase), /Guard phrase mismatch/);
  comparison.quotes[1].registrationCost = 15;
  await assert.rejects(manager.registerDomain('example.test', 'porkbun', guardPhrase), /Guard phrase mismatch/);
  assert.deepEqual(calls, []);
});

test('unusable purchase quotes cannot generate a guard or invoke registration', async (t) => {
  const cases = [
    ['no price', { registrationCost: undefined }],
    ['negative price', { registrationCost: -1 }],
    ['zero price', { registrationCost: 0 }],
    ['NaN price', { registrationCost: Number.NaN }],
    ['infinite price', { registrationCost: Number.POSITIVE_INFINITY }],
    ['non-USD currency', { currency: 'EUR' }],
    ['estimated price', { exact: false }],
    ['unavailable at registrar', { available: false }],
    ['unknown availability', { available: null }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const { manager, comparison, calls } = fixture([quote('porkbun', 12, overrides)]);
      const plan = manager.createPurchasePlan(comparison);
      assert.equal(plan.guardPhrase, null);
      assert.equal(plan.canPurchaseNow, false);
      await assert.rejects(manager.registerDomain('example.test', 'porkbun', 'unused'), /No active purchase guard/);
      assert.deepEqual(calls, []);
    });
  }
});

test('unavailable consensus or unconfigured providers cannot generate a guard', () => {
  const { manager, comparison } = fixture();
  comparison.consensusAvailable = false;
  assert.equal(manager.createPurchasePlan(comparison).guardPhrase, null);
  comparison.consensusAvailable = true;
  manager.porkbun.status.configured = false;
  manager.cloudflare.status.configured = false;
  assert.equal(manager.createPurchasePlan(comparison).guardPhrase, null);
});

test('disabled mode rejects registration before calling an adapter', async () => {
  const { manager, comparison, calls } = fixture();
  const { guardPhrase } = manager.createPurchasePlan(comparison);
  config.purchaseMode = 'disabled';
  assert.equal(manager.createPurchasePlan(comparison).canPurchaseNow, false);
  await assert.rejects(manager.registerDomain('example.test', 'porkbun', guardPhrase), /No active purchase guard/);
  assert.deepEqual(calls, []);
});

test('manual mode preserves guarded dry-run routing', async () => {
  config.purchaseMode = 'manual';
  const { manager, comparison, calls } = fixture();
  const { guardPhrase } = manager.createPurchasePlan(comparison);
  const result = await manager.registerDomain('example.test', 'porkbun', guardPhrase);
  assert.equal(result.mode, 'manual');
  assert.equal(result.liveAttempted, false);
  assert.deepEqual(calls, [{ registrar: 'porkbun', domain: 'example.test' }]);
});
