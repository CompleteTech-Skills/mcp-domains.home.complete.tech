import { config } from './config.js';
import { splitDomain } from './domain-utils.js';
import type {
  AvailabilitySignal,
  DomainComparison,
  PriceQuote,
  ProviderStatus,
  PurchasePlan,
  RegistrationResult,
  RegistrarId,
} from './types.js';
import { CloudflareProvider } from './providers/cloudflare.js';
import { NamecheapProvider } from './providers/namecheap.js';
import { PorkbunProvider } from './providers/porkbun.js';
import { RdapProvider } from './providers/rdap.js';
import type { RegistrarProvider } from './providers/base.js';

export class ProviderManager {
  private readonly rdap = new RdapProvider(config.userAgent);
  private readonly porkbun = new PorkbunProvider(config.userAgent, config.purchaseMode);
  private readonly namecheap = new NamecheapProvider();
  private readonly cloudflare = new CloudflareProvider(config.purchaseMode);

  getProviderStatuses(): ProviderStatus[] {
    return [this.rdap.status, this.porkbun.status, this.namecheap.status, this.cloudflare.status];
  }

  async compareDomain(domain: string): Promise<DomainComparison> {
    const { sld, tld } = splitDomain(domain);
    const availabilitySignals = await this.rdap.checkAvailability([domain]);
    const quotes: PriceQuote[] = [];

    for (const provider of [this.porkbun, this.namecheap, this.cloudflare] as RegistrarProvider[]) {
      const exactQuote = provider.getExactQuote ? await provider.getExactQuote(domain) : null;
      if (exactQuote) {
        quotes.push(exactQuote);
      }
      // An exact availability check can omit standard registration pricing.
      // Keep that result and expose the TLD estimate separately as an estimate.
      if (exactQuote?.registrationCost === undefined && provider.getEstimatedPricing) {
        const estimated = await provider.getEstimatedPricing(tld);
        if (estimated) {
          quotes.push(estimated);
        }
      }
    }

    const exactAvailability = quotes.find((quote) => quote.exact && quote.available !== undefined);
    const consensusAvailable =
      exactAvailability?.available ?? availabilitySignals[0]?.available ?? null;

    const cheapestQuote =
      quotes
        .filter((quote) => quote.registrationCost !== undefined)
        .sort((left, right) => (left.registrationCost ?? Number.POSITIVE_INFINITY) - (right.registrationCost ?? Number.POSITIVE_INFINITY))[0] ??
      null;

    return {
      domain,
      sld,
      tld,
      consensusAvailable,
      availabilitySignals,
      quotes,
      cheapestQuote,
      livePurchasableVia: [this.porkbun, this.cloudflare]
        .filter((provider) => provider.status.supportsLivePurchase && provider.status.configured)
        .map((provider) => provider.status.id),
    };
  }

  async getEstimatedTldQuotes(tld: string): Promise<PriceQuote[]> {
    const quotes = await Promise.all(
      ([this.porkbun, this.namecheap] as RegistrarProvider[])
        .filter((provider) => provider.getEstimatedPricing)
        .map((provider) => provider.getEstimatedPricing?.(tld))
    );

    return quotes.filter((quote): quote is PriceQuote => quote !== null);
  }

  createPurchasePlan(comparison: DomainComparison): PurchasePlan {
    const purchasableProviders = [this.porkbun, this.cloudflare].filter(
      (provider) => provider.status.configured && provider.status.supportsLivePurchase
    );

    const preferredLiveQuote = comparison.quotes
      .filter((quote) =>
        purchasableProviders.some((provider) => provider.status.id === quote.registrar) &&
        quote.exact &&
        quote.available === true &&
        quote.currency === 'USD' &&
        typeof quote.registrationCost === 'number' &&
        Number.isFinite(quote.registrationCost) &&
        quote.registrationCost > 0
      )
      .sort((left, right) => (left.registrationCost ?? Number.POSITIVE_INFINITY) - (right.registrationCost ?? Number.POSITIVE_INFINITY))[0];

    const recommendedRegistrar = preferredLiveQuote?.registrar ?? comparison.cheapestQuote?.registrar ?? null;
    const canPurchaseNow =
      comparison.consensusAvailable === true &&
      config.purchaseMode !== 'disabled' &&
      preferredLiveQuote !== undefined;

    const guardPhrase =
      canPurchaseNow && preferredLiveQuote?.registrationCost !== undefined
        ? `BUY ${comparison.domain} VIA ${preferredLiveQuote.registrar.toUpperCase()} FOR ${preferredLiveQuote.registrationCost.toFixed(2)} USD`
        : null;

    const warnings: string[] = [];
    const nextSteps: string[] = [];

    if (comparison.consensusAvailable !== true) {
      warnings.push('The domain is not clearly registrable right now. Do not attempt a purchase.');
    }

    if (!recommendedRegistrar) {
      warnings.push('No registrar quote is available, so there is nothing actionable to buy yet.');
    } else if (!preferredLiveQuote) {
      warnings.push('No configured purchase provider returned an available exact USD registration quote.');
    }

    if (config.purchaseMode === 'disabled') {
      warnings.push('Purchase mode is disabled, so registration is intentionally blocked.');
    } else if (config.purchaseMode === 'manual') {
      warnings.push('Purchase mode is manual, so register_domain will only dry-run the request.');
    }

    nextSteps.push('Re-run compare_domain_prices immediately before any purchase decision.');
    if (guardPhrase) {
      nextSteps.push(`Use this exact guard phrase if you intentionally call register_domain: ${guardPhrase}`);
    }

    if (recommendedRegistrar === 'cloudflare') {
      nextSteps.push('Verify Cloudflare billing, default registrant contact, and registrar permissions first.');
    }

    if (recommendedRegistrar === 'porkbun') {
      nextSteps.push('Verify the Porkbun account has enough credit and that the account is eligible for API registration.');
    }

    return {
      domain: comparison.domain,
      recommendedRegistrar,
      canPurchaseNow,
      purchaseMode: config.purchaseMode,
      cheapestQuote: comparison.cheapestQuote,
      guardPhrase,
      nextSteps,
      warnings,
    };
  }

  async registerDomain(domain: string, registrar: RegistrarId, guardPhrase: string): Promise<RegistrationResult> {
    const comparison = await this.compareDomain(domain);
    const plan = this.createPurchasePlan(comparison);

    if (!plan.guardPhrase) {
      throw new Error('No active purchase guard phrase is available for this domain.');
    }

    if (guardPhrase !== plan.guardPhrase) {
      throw new Error('Guard phrase mismatch. Re-run plan_domain_purchase and use the fresh guard phrase.');
    }

    if (registrar !== plan.recommendedRegistrar) {
      throw new Error('Registrar mismatch. Use the registrar authorized by the fresh purchase guard phrase.');
    }

    if (comparison.consensusAvailable !== true) {
      throw new Error('The domain is not currently registrable according to the latest comparison.');
    }

    const providerMap: Record<string, { registerDomain?: (requestedDomain: string) => Promise<RegistrationResult> }> = {
      porkbun: this.porkbun,
      cloudflare: this.cloudflare,
    };

    const provider = providerMap[registrar];
    if (!provider?.registerDomain) {
      throw new Error(`Registrar ${registrar} does not support guarded registration in this server.`);
    }

    return provider.registerDomain(domain);
  }
}
