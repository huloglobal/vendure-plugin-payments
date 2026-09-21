import { NgModule } from '@angular/core';
import { SharedModule, addNavMenuItem } from '@vendure/admin-ui/core';

/** "Payments" entry in the admin nav, under the built-in Sales section. */
@NgModule({
    imports: [SharedModule],
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
    ],
})
export class HuloPaymentsSharedModule {}
