import { LanguageCode, RuntimeVendureConfig } from '@vendure/core';

const label = (v: string) => [{ languageCode: LanguageCode.en, value: v }];

/**
 * A variant becomes a subscription by setting an interval on it. The
 * price on the variant is the price per period; the order charges the
 * first period and the provider (or the plugin's scheduler) bills the
 * rest.
 */
export function registerSubscriptionCustomFields(config: RuntimeVendureConfig): void {
    const fields = (config.customFields.ProductVariant = config.customFields.ProductVariant || []);
    const add = (f: any) => { if (!fields.some((x: any) => x.name === f.name)) fields.push(f); };
    add({
        name: 'huloSubscriptionInterval', type: 'string', defaultValue: 'none', public: true,
        label: label('Subscription billing interval'), description: label('none = one-off purchase'),
        options: [{ value: 'none', label: label('None (one-off)') }, { value: 'day', label: label('Daily') }, { value: 'week', label: label('Weekly') }, { value: 'month', label: label('Monthly') }, { value: 'year', label: label('Yearly') }],
    });
    add({ name: 'huloSubscriptionIntervalCount', type: 'int', defaultValue: 1, min: 1, max: 52, public: true, label: label('Every N intervals'), description: label('e.g. 3 with Monthly = quarterly') });
    add({ name: 'huloSubscriptionTrialDays', type: 'int', defaultValue: 0, min: 0, max: 365, public: true, label: label('Free trial days'), description: label('Renewals start this many days after the first order instead of one interval later') });
}
