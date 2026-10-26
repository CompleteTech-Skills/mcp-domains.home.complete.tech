import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { config } from '../build/config.js';
import { ProviderManager } from '../build/provider-manager.js';

const originalFetch = globalThis.fetch;
const originalMode = config.purchaseMode;

beforeEach(() => {
  config.purchaseMode = 'live';
  globalThis.fetch = async () => {
    assert.fail('Price comparison tests must not make network requests');
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.purchaseMode = originalMode;
});

function quote(registrar, registrationCost, overrides = {}) {
  return {
    registrar,
    registrarName: registrar,
    currency: 'USD',
    registrationCost,
    exact: true,
    available: true,
    checkedAt: '2026-10-26T00:00:00Z',
    ...overrides,
  };
}

function fixture(exact, estimate) {
  const manager = new ProviderManager();
  const lookups = [];
  manager.rdap.checkAvailability = async () => [{ source: 'rdap', available: false }];
  for (const id of ['porkbun', 'namecheap', 'cloudflare']) {
    manager[id].getExactQuote = async () => null;
    if (manager[id].getEstimatedPricing) {
      manager[id].getEstimatedPricing = async () => null;
    }
  }
  manager.namecheap.getExactQuote = async (domain) => {
    lookups.push(['exact', domain]);
    return exact;
  };
  manager.namecheap.getEstimatedPricing = async (tld) => {
    lookups.push(['estimate', tld]);
    return estimate;
  };
  return { manager, lookups };
}

test('an availability-only exact check retains a separately labelled standard price estimate', async () => {
  const exact = quote('namecheap', undefined);
  const estimate = quote('namecheap', 8, { exact: false, available: undefined });
  const { manager, lookups } = fixture(exact, estimate);
  manager.porkbun.getEstimatedPricing = async () => quote('porkbun', 12, { exact: false });

  const comparison = await manager.compareDomain('example.test');

  assert.deepEqual(lookups, [['exact', 'example.test'], ['estimate', 'test']]);
  assert.deepEqual(comparison.quotes.filter((item) => item.registrar === 'namecheap'), [exact, estimate]);
  assert.equal(comparison.consensusAvailable, true);
  assert.equal(comparison.cheapestQuote, estimate);
  assert.equal(comparison.cheapestQuote.exact, false);
});

test('a priced exact quote does not request a lower standard estimate', async () => {
  const premium = quote('namecheap', 120);
  const { manager, lookups } = fixture(premium, quote('namecheap', 8, { exact: false }));

  const comparison = await manager.compareDomain('example.test');

  assert.deepEqual(lookups, [['exact', 'example.test']]);
  assert.deepEqual(comparison.quotes, [premium]);
  assert.equal(comparison.cheapestQuote, premium);
});

test('a missing standard estimate preserves exact availability and leaves price unknown', async () => {
  const exact = quote('namecheap', undefined);
  const { manager, lookups } = fixture(exact, null);

  const comparison = await manager.compareDomain('example.test');

  assert.deepEqual(lookups, [['exact', 'example.test'], ['estimate', 'test']]);
  assert.deepEqual(comparison.quotes, [exact]);
  assert.equal(comparison.consensusAvailable, true);
  assert.equal(comparison.cheapestQuote, null);
});

test('an unsuccessful exact lookup still falls back to the TLD estimate', async () => {
  const estimate = quote('namecheap', 8, { exact: false, available: undefined });
  const { manager, lookups } = fixture(null, estimate);

  const comparison = await manager.compareDomain('example.co.uk');

  assert.deepEqual(lookups, [['exact', 'example.co.uk'], ['estimate', 'co.uk']]);
  assert.deepEqual(comparison.quotes, [estimate]);
  assert.equal(comparison.consensusAvailable, false);
  assert.equal(comparison.cheapestQuote, estimate);
});

test('a fallback estimate cannot become an exact purchasable quote', async () => {
  const exact = quote('porkbun', undefined);
  const estimate = quote('porkbun', 8, { exact: false, available: undefined });
  const { manager } = fixture(null, null);
  manager.porkbun.status.configured = true;
  manager.porkbun.status.supportsLivePurchase = true;
  manager.porkbun.getExactQuote = async () => exact;
  manager.porkbun.getEstimatedPricing = async () => estimate;

  const comparison = await manager.compareDomain('example.test');
  const plan = manager.createPurchasePlan(comparison);

  assert.equal(comparison.consensusAvailable, true);
  assert.equal(comparison.cheapestQuote, estimate);
  assert.equal(plan.guardPhrase, null);
  assert.equal(plan.canPurchaseNow, false);
});
