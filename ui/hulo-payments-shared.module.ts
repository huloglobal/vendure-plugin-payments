import { NgModule } from '@angular/core';
import { Router } from '@angular/router';
import { SharedModule, addActionBarItem, addNavMenuItem, registerCustomDetailComponent } from '@vendure/admin-ui/core';
import { HuloPaymentMethodPanelComponent } from './components/payment-method-panel.component';

/**
 * Always-loaded part of the extension: the "Payments" nav entry, a
 * "Connect a payment provider" button on Settings → Payment methods, and the
 * explanatory panel under any payment method that uses a HULO handler.
 */
@NgModule({
    imports: [SharedModule],
    declarations: [HuloPaymentMethodPanelComponent],
    providers: [
        addNavMenuItem(
            {
                id: 'hulo-payments',
                label: 'Payments',
                routerLink: ['/extensions/hulo-payments'],
                icon: 'credit-card',
                requiresPermission: 'ReadOrder',
            },
            'sales',
        ),
        addActionBarItem({
            id: 'hulo-payments-connect',
            label: 'Connect a payment provider',
            locationId: 'payment-method-list',
            icon: 'plugin',
            buttonColor: 'primary',
            buttonStyle: 'outline',
            requiresPermission: 'UpdateSettings',
            onClick: (_event, context) => {
                context.injector.get(Router).navigate(['/extensions/hulo-payments'], { queryParams: { tab: 'providers' } });
            },
        }),
        registerCustomDetailComponent({
            locationId: 'payment-method-detail',
            component: HuloPaymentMethodPanelComponent,
        }),
    ],
})
export class HuloPaymentsSharedModule {}
