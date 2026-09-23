import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { getServerLocation } from '@vendure/admin-ui/core';
import { Observable, of, shareReplay } from 'rxjs';
import { catchError } from 'rxjs/operators';

/**
 * One fetch of /hulo-payments/providers shared by every list row and panel
 * (the payment-method list renders a cell per row; without this each cell
 * would hit the API). Reset with `invalidate()` after a connect or save.
 */
@Injectable({ providedIn: 'root' })
export class HuloProvidersCacheService {
    private cached$: Observable<any> | null = null;

    constructor(private http: HttpClient) {}

    providers(): Observable<any> {
        if (!this.cached$) {
            const api = `${getServerLocation().replace(/\/$/, '')}/hulo-payments`;
            this.cached$ = this.http.get<any>(`${api}/providers`, this.options()).pipe(catchError(() => of(null)), shareReplay(1));
        }
        return this.cached$;
    }

    invalidate() { this.cached$ = null; }

    options(): { headers: { [k: string]: string }; withCredentials: boolean; observe: 'body'; responseType: 'json' } {
        const headers: { [k: string]: string } = {};
        try {
            const raw = localStorage.getItem('vnd_authToken');
            const token = raw ? (raw.startsWith('"') ? JSON.parse(raw) : raw) : '';
            if (token) headers['Authorization'] = `Bearer ${token}`;
        } catch { /* storage unavailable */ }
        return { headers, withCredentials: true, observe: 'body', responseType: 'json' };
    }
}
