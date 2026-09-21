import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, CustomerService, ForbiddenError, Permission, RequestContext, Transaction, UserInputError } from '@vendure/core';
import gql from 'graphql-tag';
import { PaymentsService } from './payments.service';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { PremiumRequiredError } from './runtime';

export const shopApiExtensions = gql`
    type HuloPaymentProviderInfo {
        methodCode: String!
        provider: String!
        name: String!
        capabilities: JSON!
        publicConfig: JSON!
        surcharge: JSON
        preferred: Boolean!
    }
    type HuloPaymentSession {
        provider: String!
        methodCode: String!
        clientSecret: String
        sessionId: String
        sessionData: String
        checkoutUrl: String
        publicKey: String
        environment: String
        config: JSON
        amount: Money!
        currency: String!
        expiresAt: String
    }
    type HuloSavedPaymentMethod {
        id: String!
        provider: String!
        type: String!
        brand: String
        last4: String
        expiry: String
    }
    type HuloSubscription {
        id: ID!
        provider: String!
        status: String!
        variantName: String!
        quantity: Int!
        amount: Money!
        currency: String!
        interval: String!
        intervalCount: Int!
        currentPeriodEnd: DateTime
        cancelAtPeriodEnd: Boolean!
        approveUrl: String
        orderCode: String!
        createdAt: DateTime!
    }
    input HuloSessionOptionsInput {
        savePaymentMethod: Boolean
        savedMethodId: String
        returnUrl: String
        locale: String
        countryCode: String
    }
    extend type Query {
        """Payment providers available for the active order, preferred first."""
        huloPaymentProviders: [HuloPaymentProviderInfo!]!
        """Cards / methods the signed-in customer has saved with any provider."""
        huloSavedPaymentMethods: [HuloSavedPaymentMethod!]!
        """The signed-in customer's subscriptions."""
        huloMySubscriptions: [HuloSubscription!]!
    }
    extend type Mutation {
        """Create the provider session for the active order (client secret / session data / checkout URL)."""
        huloCreatePaymentSession(methodCode: String!, options: HuloSessionOptionsInput): HuloPaymentSession!
        huloRemoveSavedPaymentMethod(provider: String!, id: String!): Boolean!
        """Cancel one of the customer's subscriptions, now or at the end of the paid period."""
        huloCancelSubscription(id: ID!, atPeriodEnd: Boolean): HuloSubscription!
        """Apply (or clear) the configured surcharge for a payment method to the active order."""
        huloApplyPaymentSurcharge(methodCode: String!): Order!
    }
`;

function friendly(e: any): never {
    if (e instanceof PremiumRequiredError) throw new UserInputError(e.message);
    throw e;
}

@Resolver()
export class HuloPaymentsShopResolver {
    constructor(private payments: PaymentsService, private subscriptions: SubscriptionService, private customerService: CustomerService) {}

    @Query()
    @Allow(Permission.Public)
    async huloPaymentProviders(@Ctx() ctx: RequestContext) {
        const order = await this.payments.activeOrderOrThrow(ctx).catch(() => null);
        if (!order) return [];
        return this.payments.offeredProviders(ctx, order);
    }

    @Query()
    @Allow(Permission.Owner)
    async huloSavedPaymentMethods(@Ctx() ctx: RequestContext) {
        const customer = await this.customerService.findOneByUserId(ctx, ctx.activeUserId!);
        if (!customer) return [];
        try { return await this.payments.savedMethods(ctx, customer); } catch (e) { return friendly(e); }
    }

    @Query()
    @Allow(Permission.Owner)
    async huloMySubscriptions(@Ctx() ctx: RequestContext) {
        const customer = await this.customerService.findOneByUserId(ctx, ctx.activeUserId!);
        if (!customer) return [];
        return this.subscriptions.listForCustomer(customer.id as number);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.Public)
    async huloCreatePaymentSession(@Ctx() ctx: RequestContext, @Args() args: { methodCode: string; options?: any }) {
        const order = await this.payments.activeOrderOrThrow(ctx);
        try { return await this.payments.createSession(ctx, order, args.methodCode, args.options || {}); } catch (e) { return friendly(e); }
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.Owner)
    async huloRemoveSavedPaymentMethod(@Ctx() ctx: RequestContext, @Args() args: { provider: string; id: string }) {
        const customer = await this.customerService.findOneByUserId(ctx, ctx.activeUserId!);
        if (!customer) throw new ForbiddenError();
        try { return await this.payments.removeSavedMethod(ctx, customer, args.provider, args.id); } catch (e) { return friendly(e); }
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.Owner)
    async huloCancelSubscription(@Ctx() ctx: RequestContext, @Args() args: { id: string; atPeriodEnd?: boolean }) {
        const customer = await this.customerService.findOneByUserId(ctx, ctx.activeUserId!);
        if (!customer) throw new ForbiddenError();
        const sub = await this.subscriptions.findOne(Number(args.id));
        if (!sub || Number(sub.customerId) !== Number(customer.id)) throw new ForbiddenError();
        return this.subscriptions.cancel(Number(args.id), args.atPeriodEnd !== false, `customer:${customer.emailAddress}`);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.Public)
    async huloApplyPaymentSurcharge(@Ctx() ctx: RequestContext, @Args() args: { methodCode: string }) {
        const order = await this.payments.activeOrderOrThrow(ctx);
        try { return await this.payments.applySurcharge(ctx, order, args.methodCode); } catch (e) { return friendly(e); }
    }
}
