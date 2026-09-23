/**
 * The hosted checkout page: one HTML document that can drive every
 * provider's client (Stripe Payment Element, Adyen Drop-in, PayPal buttons,
 * Square Web Payments, Braintree Drop-in), redirect flows (Mollie,
 * GoCardless, Checkout.com, Coinbase) and offline instructions (bank
 * transfer, pay later). It only ever talks to the plugin's own endpoints
 * under `/hulo-payments/pay/<token>/…`.
 */

export interface HostedPageModel {
    token: string;
    orderCode: string;
    amount: number;
    currency: string;
    locale: string;
    customerEmail: string;
    brand: string;
    accent: string;
    logoUrl: string;
    cancelUrl: string;
    providers: Array<{ methodCode: string; provider: string; name: string; wallets: string[]; offline: boolean; surcharge: any }>;
    /** Query string the provider returned with (redirect flows). */
    returned: boolean;
    /** Method to open first (the storefront's choice, or the one used before a redirect). */
    preselect?: string;
    lines: Array<{ name: string; quantity: number; total: number }>;
}

const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function money(minor: number, currency: string, locale: string): string {
    try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
}

const ICONS: Record<string, string> = {
    'hulo-stripe': 'Card', 'hulo-adyen': 'Card', 'hulo-checkout-com': 'Card', 'hulo-square': 'Card', 'hulo-braintree': 'Card',
    'hulo-paypal': 'PayPal', 'hulo-mollie': 'iDEAL', 'hulo-gocardless': 'Bank', 'hulo-coinbase': '₿', 'hulo-bank-transfer': 'Bank', 'hulo-pay-later': 'Invoice',
};

export function renderHostedPage(m: HostedPageModel): string {
    const providerButtons = m.providers.map(p => `
        <button type="button" class="method" data-method="${esc(p.methodCode)}" data-provider="${esc(p.provider)}">
            <span class="icon">${esc(ICONS[p.provider] || 'Pay')}</span>
            <span class="label"><strong>${esc(p.name)}</strong>${p.wallets?.length ? `<small>${esc(p.wallets.slice(0, 4).map(w => w.replace(/_/g, ' ')).join(' · '))}</small>` : ''}${p.surcharge?.value ? `<small>${p.surcharge.type === 'percent' ? `+${p.surcharge.value}% fee` : `+${money(p.surcharge.value, m.currency, m.locale)} fee`}</small>` : ''}</span>
        </button>`).join('');
    const lines = m.lines.slice(0, 12).map(l => `<li><span>${l.quantity} × ${esc(l.name)}</span><span>${money(l.total, m.currency, m.locale)}</span></li>`).join('');
    return `<!doctype html><html lang="${esc(m.locale.split(/[-_]/)[0] || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Pay ${money(m.amount, m.currency, m.locale)} · ${esc(m.brand)}</title>
<style>
:root{--accent:${esc(m.accent || '#1d4ed8')};--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f6f7f9}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px;display:grid;gap:20px;grid-template-columns:1fr}
@media(min-width:820px){.wrap{grid-template-columns:1.2fr .8fr;padding:40px 24px}}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px}
header{display:flex;align-items:center;gap:12px;margin-bottom:12px}header img{height:36px;max-width:160px;object-fit:contain}header h1{font-size:18px;margin:0}
h2{font-size:15px;margin:0 0 12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.methods{display:grid;gap:10px}.method{display:flex;align-items:center;gap:14px;width:100%;text-align:left;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:#fff;cursor:pointer;font:inherit;color:inherit}
.method:hover{border-color:var(--accent)}.method.active{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}
.method .icon{flex:0 0 52px;height:36px;border-radius:8px;background:var(--bg);display:grid;place-items:center;font-size:12px;font-weight:700;color:var(--muted)}
.method .label{display:flex;flex-direction:column}.method small{color:var(--muted);font-size:12px}
#element{margin-top:16px}.pay{margin-top:16px;width:100%;padding:14px;border:0;border-radius:12px;background:var(--accent);color:#fff;font:inherit;font-weight:700;font-size:16px;cursor:pointer}.pay:disabled{opacity:.5;cursor:not-allowed}
.status{margin-top:12px;padding:12px 14px;border-radius:10px;font-size:14px}.status.ok{background:#ecfdf5;color:#047857}.status.bad{background:#fef2f2;color:#b91c1c}.status.info{background:#eff6ff;color:#1e40af}
.instructions{white-space:pre-wrap;background:var(--bg);border-radius:10px;padding:14px;font-size:14px;margin-top:12px}
.summary ul{list-style:none;margin:0;padding:0}.summary li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}
.summary .total{display:flex;justify-content:space-between;font-weight:800;font-size:18px;padding-top:12px}
.foot{margin-top:14px;font-size:12px;color:var(--muted)}.foot a{color:var(--muted)}
.hidden{display:none}
</style></head><body>
<div class="wrap">
  <main class="card">
    <header>${m.logoUrl ? `<img src="${esc(m.logoUrl)}" alt="${esc(m.brand)}">` : ''}<h1>${esc(m.brand)}</h1></header>
    <h2>Choose how to pay</h2>
    <div class="methods" id="methods">${providerButtons || '<p class="status bad">No payment methods are available for this order. Please contact us.</p>'}</div>
    <div id="element"></div>
    <div id="instructions" class="instructions hidden"></div>
    <button id="pay" class="pay hidden" type="button">Pay ${money(m.amount, m.currency, m.locale)}</button>
    <div id="status" class="status hidden"></div>
    <p class="foot">Payments are processed by the provider you choose; card details never touch this shop's servers. ${m.cancelUrl ? `<a href="${esc(m.cancelUrl)}">Back to the shop</a>` : ''}</p>
  </main>
  <aside class="card summary">
    <h2>Order ${esc(m.orderCode)}</h2>
    <ul>${lines}</ul>
    <div class="total"><span>Total</span><span>${money(m.amount, m.currency, m.locale)}</span></div>
    ${m.customerEmail ? `<p class="foot">Receipt to ${esc(m.customerEmail)}</p>` : ''}
  </aside>
</div>
<script>
(function(){
  var TOKEN = ${JSON.stringify(m.token)}, BASE = location.pathname.replace(/\\/$/, ''), AMOUNT_LABEL = ${JSON.stringify(money(m.amount, m.currency, m.locale))};
  var RETURNED = ${m.returned ? 'true' : 'false'};
  var PRESELECT = ${JSON.stringify(m.preselect || '')};
  var $ = function(id){ return document.getElementById(id); };
  var current = null, session = null, stripe = null, elements = null, btInstance = null, sqCard = null, sqPayments = null;
  function status(kind, text){ var s = $('status'); s.className = 'status ' + kind; s.textContent = text; s.classList.remove('hidden'); }
  function reset(){ $('element').innerHTML = ''; $('instructions').classList.add('hidden'); $('pay').classList.add('hidden'); $('pay').disabled = false; $('status').classList.add('hidden'); }
  function post(path, body){ return fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function(r){ return r.json().then(function(j){ if (!r.ok) throw new Error(j.message || j.error || 'Request failed'); return j; }); }); }
  function load(src){ return new Promise(function(res, rej){ if (document.querySelector('script[src="' + src + '"]')) return res(); var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function(){ rej(new Error('Could not load ' + src)); }; document.head.appendChild(s); }); }
  function finish(metadata){
    $('pay').disabled = true; status('info', 'Confirming your payment…');
    return post('/complete', { methodCode: current, metadata: metadata || {} }).then(function(r){
      if (r.paid) { status('ok', r.message || 'Payment received — taking you back to the shop…'); setTimeout(function(){ location.href = r.redirect; }, 900); }
      else { status('bad', r.message || 'The payment was not completed.'); $('pay').disabled = false; }
    }).catch(function(e){ status('bad', e.message); $('pay').disabled = false; });
  }
  function select(btn){
    document.querySelectorAll('.method').forEach(function(b){ b.classList.remove('active'); }); btn.classList.add('active');
    current = btn.dataset.method; reset(); status('info', 'Preparing ' + btn.querySelector('strong').textContent + '…');
    post('/session', { methodCode: current }).then(function(s){
      session = s; $('status').classList.add('hidden');
      var flow = s.flow || 'redirect';
      if (flow === 'instructions') { $('instructions').textContent = s.instructions || ''; $('instructions').classList.remove('hidden'); $('pay').textContent = 'Place order — ' + AMOUNT_LABEL; $('pay').classList.remove('hidden'); $('pay').onclick = function(){ finish({}); }; }
      else if (flow === 'stripe-element') {
        load('https://js.stripe.com/v3/').then(function(){ stripe = Stripe(s.publicKey); elements = stripe.elements({ clientSecret: s.clientSecret }); elements.create('payment', { layout: 'tabs' }).mount('#element'); $('pay').textContent = 'Pay ' + AMOUNT_LABEL; $('pay').classList.remove('hidden');
          $('pay').onclick = function(){ $('pay').disabled = true; stripe.confirmPayment({ elements: elements, confirmParams: { return_url: location.href.split('?')[0] + '?returned=1' }, redirect: 'if_required' }).then(function(r){ if (r.error) { status('bad', r.error.message); $('pay').disabled = false; } else finish({ paymentIntentId: r.paymentIntent.id }); }); }; }).catch(function(e){ status('bad', e.message); });
      }
      else if (flow === 'adyen-dropin') {
        load('https://cdn.jsdelivr.net/npm/@adyen/adyen-web@6.9.0/dist/adyen.js').then(function(){ var W = window.AdyenWeb; return W.AdyenCheckout({ environment: s.environment, clientKey: s.publicKey, session: { id: s.sessionId, sessionData: s.sessionData }, countryCode: (s.config && s.config.countryCode) || 'GB', locale: (s.config && s.config.locale) || 'en-GB', onPaymentCompleted: function(res){ finish({ sessionId: s.sessionId, sessionResult: res.sessionResult, resultCode: res.resultCode }); }, onPaymentFailed: function(res){ status('bad', 'Payment ' + (res.resultCode || 'failed')); }, onError: function(e){ status('bad', e.message || 'Adyen error'); } }).then(function(c){ new W.Dropin(c).mount('#element'); }); }).catch(function(e){ status('bad', e.message); });
      }
      else if (flow === 'paypal-buttons') {
        load('https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(s.publicKey) + '&currency=' + encodeURIComponent(s.currency) + '&intent=' + ((s.config && s.config.intent) || 'capture')).then(function(){ paypal.Buttons({ createOrder: function(){ return s.sessionId; }, onApprove: function(d){ finish({ paypalOrderId: d.orderID }); }, onError: function(e){ status('bad', String(e)); } }).render('#element'); }).catch(function(e){ status('bad', e.message); });
      }
      else if (flow === 'square-web') {
        var env = s.environment === 'live' ? 'https://web.squarecdn.com/v1/square.js' : 'https://sandbox.web.squarecdn.com/v1/square.js';
        load(env).then(function(){ sqPayments = window.Square.payments(s.config.applicationId, s.config.locationId); return sqPayments.card(); }).then(function(card){ sqCard = card; return card.attach('#element'); }).then(function(){ $('pay').textContent = 'Pay ' + AMOUNT_LABEL; $('pay').classList.remove('hidden'); $('pay').onclick = function(){ $('pay').disabled = true; sqCard.tokenize().then(function(t){ if (t.status === 'OK') finish({ sourceId: t.token }); else { status('bad', 'Card details were not accepted'); $('pay').disabled = false; } }); }; }).catch(function(e){ status('bad', e.message); });
      }
      else if (flow === 'braintree-dropin') {
        load('https://js.braintreegateway.com/web/dropin/1.43.0/js/dropin.min.js').then(function(){ return braintree.dropin.create({ authorization: s.clientSecret, container: '#element', paypal: { flow: 'checkout', amount: (s.amount / 100).toFixed(2), currency: s.currency } }); }).then(function(inst){ btInstance = inst; $('pay').textContent = 'Pay ' + AMOUNT_LABEL; $('pay').classList.remove('hidden'); $('pay').onclick = function(){ $('pay').disabled = true; inst.requestPaymentMethod(function(err, payload){ if (err) { status('bad', err.message); $('pay').disabled = false; return; } finish({ nonce: payload.nonce, deviceData: payload.deviceData }); }); }; }).catch(function(e){ status('bad', e.message); });
      }
      else { // redirect
        $('pay').textContent = 'Continue to ' + btn.querySelector('strong').textContent; $('pay').classList.remove('hidden'); $('pay').onclick = function(){ location.href = s.checkoutUrl; };
      }
    }).catch(function(e){ status('bad', e.message); });
  }
  document.querySelectorAll('.method').forEach(function(b){ b.addEventListener('click', function(){ select(b); }); });
  var q = new URLSearchParams(location.search);
  if (RETURNED || q.get('returned') || q.get('payment_intent') || q.get('token') || q.get('cko') || q.get('billing_request') ) {
    status('info', 'Checking your payment…');
    post('/complete', { returned: true, metadata: { paymentIntentId: q.get('payment_intent') || undefined, paypalOrderId: q.get('token') || undefined } }).then(function(r){ if (r.paid) { status('ok', r.message || 'Payment received — taking you back to the shop…'); setTimeout(function(){ location.href = r.redirect; }, 900); } else status('bad', r.message || 'The payment was not completed — choose a method to try again.'); }).catch(function(e){ status('bad', e.message); });
  } else if (document.querySelector('.method')) { var pre = null; PRESELECT && document.querySelectorAll('.method').forEach(function(b){ if (b.dataset.method === PRESELECT) pre = b; }); select(pre || document.querySelector('.method')); }
})();
</script></body></html>`;
}
