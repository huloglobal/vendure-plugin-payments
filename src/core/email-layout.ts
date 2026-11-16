/**
 * The shared HULO plugin e-mail design: a 600px white card on a grey
 * background, the merchant's logo (or store name) over a 3px accent bar,
 * Arial text, info and warning boxes, a primary button, a sign-off and a
 * footer strip. Inline styles and tables only (some senders strip <style>);
 * every interpolated value is escaped. A plain-text alternative is built
 * from the same input, so the two never drift apart.
 *
 * The plugin sends merchant/ops alerts with it (the compact variant); the
 * renderer is exported so hosts can reuse it for their own payment mails.
 */

export const DEFAULT_ACCENT = '#155dfc';
const FONT = 'Arial, Helvetica, sans-serif';
const MONO = 'Consolas, Menlo, Monaco, monospace';

export interface EmailBranding {
    /** Store name: shown when there is no logo, and in the sign-off. */
    storeName: string;
    /** `#rgb`/`#rrggbb`; anything else falls back to the default accent. */
    accentColor?: string | null;
    /** Absolute http(s) URL of the merchant's logo. */
    logoUrl?: string | null;
    /** Logo width in px (default 140). */
    logoWidth?: number | null;
    supportEmail?: string | null;
    /** Merchant's footer or legal text. */
    footerText?: string | null;
}

export interface EmailRow {
    label: string;
    value: string;
    /** Codes, references and ids: shown in a monospace font. */
    mono?: boolean;
}

export interface EmailContent {
    /** Inbox preview line (hidden in the body). */
    preheader?: string;
    heading: string;
    /** Paragraphs of body text. */
    paragraphs?: string[];
    /** A labelled info box of label/value rows. */
    details?: { title?: string; rows: EmailRow[] } | null;
    /** A yellow warning box. */
    warning?: { title?: string; text: string } | null;
    primaryButton?: { label: string; url: string } | null;
    secondaryButton?: { label: string; url: string } | null;
    /** Tighter spacing for merchant/admin notifications. */
    compact?: boolean;
}

export interface RenderedEmail { html: string; text: string }

export function escHtml(v: unknown): string {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function safeAccent(v: unknown): string {
    const s = String(v || '').trim();
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : DEFAULT_ACCENT;
}

function safeUrl(v: unknown): string | null {
    const s = String(v || '').trim();
    return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : null;
}

/** Render the HTML and plain-text bodies of one e-mail. Pure; no I/O. */
export function renderEmail(brand: EmailBranding, c: EmailContent): RenderedEmail {
    const accent = safeAccent(brand.accentColor);
    const store = String(brand.storeName || '').trim() || 'Our store';
    const logo = safeUrl(brand.logoUrl);
    const logoWidth = Math.max(40, Math.min(300, Math.round(Number(brand.logoWidth) || 140)));
    const pad = c.compact ? '20px 24px' : '28px 28px';
    const sidePad = c.compact ? '24px' : '28px';
    const p = (t: string) => `<p style="margin:0 0 12px 0;font-family:${FONT};font-size:14px;line-height:22px;color:#374151;">${escHtml(t)}</p>`;
    const btn = (b: { label: string; url: string }, primary: boolean) => {
        const url = safeUrl(b.url);
        if (!url) return '';
        const style = primary
            ? `background-color:${accent};border:1px solid ${accent};color:#ffffff;`
            : `background-color:#ffffff;border:1px solid ${accent};color:${accent};`;
        return `<td style="padding:0 10px 0 0;"><a href="${escHtml(url)}" style="${style}display:inline-block;font-family:${FONT};font-size:14px;font-weight:bold;line-height:20px;padding:11px 22px;border-radius:8px;text-decoration:none;">${escHtml(b.label)}</a></td>`;
    };

    const h: string[] = [];
    h.push(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(c.heading)}</title></head>`);
    h.push(`<body style="margin:0;padding:0;background-color:#f3f4f6;">`);
    if (c.preheader) h.push(`<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f3f4f6;font-size:1px;line-height:1px;">${escHtml(c.preheader)}</div>`);
    h.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">`);
    h.push(`<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;">`);
    // Header: logo or store name, then the accent bar.
    h.push(`<tr><td style="padding:${c.compact ? '16px 24px' : '22px 28px'};border-bottom:3px solid ${accent};">`);
    h.push(logo
        ? `<img src="${escHtml(logo)}" alt="${escHtml(store)}" width="${logoWidth}" style="display:block;width:${logoWidth}px;max-width:100%;height:auto;border:0;">`
        : `<span style="font-family:${FONT};font-size:18px;font-weight:bold;color:#111827;">${escHtml(store)}</span>`);
    h.push(`</td></tr>`);
    h.push(`<tr><td style="padding:${pad};">`);
    h.push(`<h1 style="margin:0 0 12px 0;font-family:${FONT};font-size:22px;line-height:28px;font-weight:bold;color:#111827;">${escHtml(c.heading)}</h1>`);
    for (const t of c.paragraphs || []) h.push(p(t));
    if (c.warning) {
        h.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px 0;"><tr><td style="padding:14px 16px;background-color:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-family:${FONT};">`);
        if (c.warning.title) h.push(`<div style="font-size:14px;font-weight:bold;color:#92400e;padding-bottom:4px;">${escHtml(c.warning.title)}</div>`);
        h.push(`<div style="font-size:13px;line-height:20px;color:#78350f;">${escHtml(c.warning.text)}</div></td></tr></table>`);
    }
    if (c.details && c.details.rows.length) {
        h.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px 0;"><tr><td style="padding:14px 16px;background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">`);
        if (c.details.title) h.push(`<div style="font-family:${FONT};font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#6b7280;padding-bottom:6px;">${escHtml(c.details.title)}</div>`);
        h.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">`);
        for (const r of c.details.rows) {
            h.push(`<tr><td valign="top" style="padding:4px 12px 4px 0;font-family:${FONT};font-size:12px;text-transform:uppercase;color:#6b7280;white-space:nowrap;">${escHtml(r.label)}</td>`
                + `<td align="right" style="padding:4px 0;font-family:${r.mono ? MONO : FONT};font-size:14px;font-weight:bold;color:#111827;word-break:break-word;">${escHtml(r.value)}</td></tr>`);
        }
        h.push(`</table></td></tr></table>`);
    }
    const buttons = [c.primaryButton ? btn(c.primaryButton, true) : '', c.secondaryButton ? btn(c.secondaryButton, false) : ''].join('');
    if (buttons) h.push(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px 0;"><tr>${buttons}</tr></table>`);
    // Sign-off.
    h.push(`<p style="margin:${c.compact ? '6px' : '12px'} 0 0 0;font-family:${FONT};font-size:14px;line-height:22px;color:#374151;">Kind regards,<br><strong style="color:#111827;">${escHtml(store)}</strong>`
        + (brand.supportEmail ? `<br><a href="mailto:${escHtml(brand.supportEmail)}" style="color:${accent};text-decoration:none;">${escHtml(brand.supportEmail)}</a>` : '') + `</p>`);
    h.push(`</td></tr>`);
    if (brand.footerText) {
        h.push(`<tr><td style="padding:12px ${sidePad};background-color:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 10px 10px;font-family:${FONT};font-size:11px;line-height:16px;color:#6b7280;">${escHtml(brand.footerText)}</td></tr>`);
    }
    h.push(`</table></td></tr></table></body></html>`);

    // Plain text.
    const t: string[] = [store, '', c.heading, ''];
    for (const para of c.paragraphs || []) t.push(para, '');
    if (c.warning) t.push(`${c.warning.title ? c.warning.title + ': ' : ''}${c.warning.text}`, '');
    if (c.details && c.details.rows.length) {
        if (c.details.title) t.push(c.details.title.toUpperCase());
        for (const r of c.details.rows) t.push(`${r.label}: ${r.value}`);
        t.push('');
    }
    for (const b of [c.primaryButton, c.secondaryButton]) if (b && safeUrl(b.url)) t.push(`${b.label}: ${b.url}`);
    if (c.primaryButton || c.secondaryButton) t.push('');
    t.push('Kind regards,', store);
    if (brand.supportEmail) t.push(String(brand.supportEmail));
    if (brand.footerText) t.push('', '--', String(brand.footerText));
    return { html: h.join(''), text: t.join('\n') };
}
