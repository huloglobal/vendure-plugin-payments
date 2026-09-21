import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SharedModule } from '@vendure/admin-ui/core';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';
import { HuloPaymentsComponent } from './components/hulo-payments.component';

@NgModule({
    imports: [
        SharedModule, FormsModule, HttpClientModule,
        RouterModule.forChild([
            { path: '', pathMatch: 'full', component: HuloPaymentsComponent, data: { breadcrumb: 'Payments' } },
        ]),
    ],
    declarations: [HuloPaymentsComponent],
})
export class HuloPaymentsModule {}
