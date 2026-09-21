import { Injectable } from '@nestjs/common';
import { TransactionalConnection } from '@vendure/core';
import { LicenceStore, PurchaseClaimClient, adapterFor } from '@huloglobal/vendure-licence-sdk';

export const PLUGIN_ID = 'vendure-plugin-payments';

/**
 * Licence persistence + buy-from-admin auto-install for the plugin. The
 * feature modules never touch this; it exists so the licence controller
 * has a home for the stored key and the purchase-claim client.
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class HuloPaymentsLicenceService {
    constructor(private connection: TransactionalConnection) {}

    private get db() {
        return adapterFor(this.connection.rawConnection);
    }

    private licenceStore = new LicenceStore((sql, params) => this.db.query(sql, params));

    private purchaseClaim: PurchaseClaimClient | null = null;

    /** Hooks are supplied by the controller so this file never imports the plugin class. */
    initPurchaseClaim(hooks: { packageName: string; instanceId: () => string | null; onLicence: (key: string) => Promise<boolean> }): PurchaseClaimClient {
        if (!this.purchaseClaim) {
            this.purchaseClaim = new PurchaseClaimClient({ ...hooks, query: (sql, params, opts) => this.db.query(sql, params, opts) });
        }
        return this.purchaseClaim;
    }

    async loadStoredLicenceKey(): Promise<string | null> {
        await this.licenceStore.ensureTable();
        return this.licenceStore.load(PLUGIN_ID);
    }

    async saveStoredLicenceKey(key: string): Promise<void> {
        await this.licenceStore.ensureTable();
        await this.licenceStore.save(PLUGIN_ID, key);
    }

    async clearStoredLicenceKey(): Promise<void> {
        await this.licenceStore.clear(PLUGIN_ID);
    }
}
