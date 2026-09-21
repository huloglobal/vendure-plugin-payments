import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { EventBus, Logger, OrderService, OrderStateTransitionEvent, ProcessContext, RequestContext } from '@vendure/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { filter } from 'rxjs/operators';
import { SubscriptionService } from './subscription.service';
import { loggerCtx } from '../core/ledger.service';

/**
 * Starts subscriptions when an order's payment settles and runs the
 * renewal scheduler hourly (worker only, with a single-flight guard).
 */
@Injectable()
export class SubscriptionCron implements OnApplicationBootstrap {
    private running = false;

    constructor(private eventBus: EventBus, private orderService: OrderService, private subscriptions: SubscriptionService, private processContext: ProcessContext) {}

    onApplicationBootstrap() {
        this.eventBus.ofType(OrderStateTransitionEvent)
            .pipe(filter(e => e.toState === 'PaymentSettled' || e.toState === 'PaymentAuthorized'))
            .subscribe(async e => {
                try {
                    const order = await this.orderService.findOne(e.ctx as RequestContext, e.order.id, ['lines', 'lines.productVariant', 'customer', 'payments', 'channels']);
                    if (!order || !this.subscriptions.orderHasSubscriptionLines(order)) return;
                    const payment = (order.payments || []).find(p => p.state === 'Settled' || p.state === 'Authorized');
                    if (payment) await this.subscriptions.startForOrder(order, payment);
                } catch (err: any) {
                    Logger.error(`subscription start failed for order ${e.order.code}: ${err.message}`, loggerCtx);
                }
            });
    }

    @Cron(CronExpression.EVERY_HOUR)
    async tick() {
        if (!this.processContext.isWorker || this.running) return;
        this.running = true;
        try {
            const r = await this.subscriptions.runScheduler();
            if (r.charged || r.failed || r.canceled) Logger.info(`renewals: ${r.charged} charged, ${r.failed} failed, ${r.canceled} cancelled at period end`, loggerCtx);
        } catch (e: any) {
            Logger.error(`renewal scheduler failed: ${e.message}`, loggerCtx);
        } finally {
            this.running = false;
        }
    }
}
