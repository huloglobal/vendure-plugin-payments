import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createDbAdapter, TranslateOptions } from '@huloglobal/vendure-licence-sdk';

/**
 * Postgres corpus: every SQL template literal in `src/**` is translated by
 * the licence-sdk adapter and checked against a scratch PostgreSQL. DDL is
 * executed for real (in a private schema); every other statement is
 * `PREPARE`d, which makes Postgres parse and plan it against the real
 * tables without needing valid row data. Vendure's own tables are stood in
 * with quoted camelCase columns, exactly as TypeORM creates them.
 *
 * Skipped unless HULO_PG_URL is set, e.g.
 *   HULO_PG_URL=postgres://hulo_pg:hulo_pg_local@localhost:5432/hulo_pay_pg npx vitest run pg-corpus
 */
const PG_URL = process.env.HULO_PG_URL;
const run = PG_URL ? describe : describe.skip;

/** A statement, not a word that happens to start with one (`'DELETE'` as an HTTP method, `'select-form-input'`). */
const SQL_START = /^\s*(SELECT\s+\S|INSERT\s+(IGNORE\s+)?INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s|CREATE\s+(TABLE|(UNIQUE\s+)?INDEX)\s|ALTER\s+TABLE\s|DROP\s+(TABLE|INDEX)\s)/i;

/** Values for `${…}` interpolations, by the expression's text. Unknown expressions skip the statement. */
const SUBSTITUTIONS: Array<[RegExp, string]> = [
    [/^whereSql$/, ''],
    [/^where$/, 'WHERE'],
    [/^\(page - 1\) \* perPage$/, '0'],
    [/^perPage$/, '50'],
    [/^Number\(days\) \|\| 30$/, '30'],
    [/^Math\.min\(200, limit\)$/, '50'],
    [/^keys\.map\(/, 'status = ?'],
    [/^scope$/, 'table_catalog = current_database() AND table_schema = current_schema()'],
    // addColumnIfMissing's template is expanded from its call sites instead (see extractSql).
    [/^table$/, '__CALL_SITES__'],
    [/^column$/, ''],
    [/^ddl$/, ''],
];

interface Extracted { file: string; sql: string; opts: TranslateOptions; skip?: string }

/** Skip the closing `}` of a `${` expression, honouring nested template literals, strings and braces. */
function skipExpression(src: string, i: number): number {
    let depth = 1;
    while (i < src.length) {
        const c = src[i];
        if (c === '`') { i = skipTemplate(src, i + 1); continue; }
        if (c === "'" || c === '"') { i++; while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; } i++; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i + 1; }
        i++;
    }
    return i;
}

/** Skip to just past the closing backtick of a template literal that starts at `i`. */
function skipTemplate(src: string, i: number): number {
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`') return i + 1;
        if (c === '$' && src[i + 1] === '{') { i = skipExpression(src, i + 2); continue; }
        i++;
    }
    return i;
}

/** Read a template literal starting at `i` (just after the opening backtick) into SQL text. */
function readTemplate(src: string, i: number): { sql: string; end: number; skip?: string } {
    let out = ''; let skip: string | undefined;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') { out += src[i + 1]; i += 2; continue; }
        if (c === '`') return { sql: out, end: i + 1, skip };
        if (c === '$' && src[i + 1] === '{') {
            const end = skipExpression(src, i + 2);
            const expr = src.slice(i + 2, end - 1).trim();
            const sub = SUBSTITUTIONS.find(([re]) => re.test(expr));
            if (sub) out += sub[1]; else skip = skip || `unknown interpolation \${${expr.slice(0, 40)}}`;
            i = end; continue;
        }
        out += c; i++;
    }
    return { sql: out, end: i, skip };
}

/** `{ needAffected: true }`, `{ conflictColumns: [...] }` from the rest of the call. */
function optsAfter(src: string, i: number): TranslateOptions {
    const tail = src.slice(i, i + 800);
    const opts: TranslateOptions = {};
    const m = tail.match(/conflictColumns:\s*\[([^\]]*)\]/);
    if (m) opts.conflictColumns = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (/needAffected:\s*true/.test(tail)) opts.needAffected = true;
    if (/needInsertId:\s*true/.test(tail)) opts.needInsertId = true;
    return opts;
}

export function extractSql(file: string, src: string): Extracted[] {
    const out: Extracted[] = [];
    for (const m of src.matchAll(/addColumnIfMissing\('(\w+)',\s*'(\w+)',\s*`([^`]*)`\)/g)) out.push({ file, sql: `ALTER TABLE ${m[1]} ADD COLUMN ${m[2]} ${m[3]}`, opts: {} });
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
        if (c === "'" || c === '"') {
            let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
            const lit = src.slice(i + 1, j);
            if (SQL_START.test(lit)) out.push({ file, sql: lit, opts: optsAfter(src, j) });
            i = j; continue;
        }
        if (c === '`') {
            const rest = src.slice(i + 1, i + 40);
            if (!SQL_START.test(rest)) { i = skipTemplate(src, i + 1) - 1; continue; }
            const t = readTemplate(src, i + 1);
            out.push({ file, sql: t.sql, opts: optsAfter(src, t.end), skip: t.skip });
            i = t.end - 1;
        }
    }
    return out;
}

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap(f => {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) return f === 'ui' ? [] : walk(p);
        return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
    });
}

/** Vendure tables the plugin reads with raw SQL, as TypeORM creates them on Postgres (quoted camelCase). */
const VENDURE_STAND_INS = [
    `CREATE TABLE payment (id SERIAL PRIMARY KEY, "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(), method VARCHAR(255) NOT NULL, amount INT NOT NULL, state VARCHAR(255) NOT NULL, "errorMessage" VARCHAR(255), "transactionId" VARCHAR(255), metadata TEXT NOT NULL DEFAULT '{}', "orderId" INT)`,
    `CREATE TABLE "order" (id SERIAL PRIMARY KEY, code VARCHAR(255) NOT NULL, state VARCHAR(255) NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, "currencyCode" VARCHAR(255) NOT NULL, "customerId" INT)`,
    `CREATE TABLE payment_method (id SERIAL PRIMARY KEY, code VARCHAR(255) NOT NULL, enabled BOOLEAN NOT NULL, handler TEXT NOT NULL, checker TEXT)`,
    `CREATE TABLE payment_method_channels_channel ("paymentMethodId" INT NOT NULL, "channelId" INT NOT NULL, PRIMARY KEY ("paymentMethodId", "channelId"))`,
    `CREATE TABLE channel (id SERIAL PRIMARY KEY, code VARCHAR(255) NOT NULL, token VARCHAR(255) NOT NULL)`,
    `CREATE TABLE customer (id SERIAL PRIMARY KEY, "emailAddress" VARCHAR(255) NOT NULL, "firstName" VARCHAR(255), "lastName" VARCHAR(255))`,
];

const DDL_ORDER = (sql: string) => /^\s*CREATE\s+TABLE/i.test(sql) ? 0 : /^\s*(ALTER|CREATE)/i.test(sql) ? 1 : 2;

run('Postgres corpus (HULO_PG_URL)', () => {
    it('every SQL statement in src/** translates and prepares against PostgreSQL', async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Client } = require('pg');
        const client = new Client({ connectionString: PG_URL });
        await client.connect();
        const failures: string[] = []; const skipped: string[] = []; let executed = 0;
        try {
            await client.query('DROP SCHEMA IF EXISTS hulo_corpus CASCADE');
            await client.query('CREATE SCHEMA hulo_corpus');
            await client.query('SET search_path TO hulo_corpus');
            for (const ddl of VENDURE_STAND_INS) await client.query(ddl);

            const raw = {
                options: { type: 'postgres' },
                async query(sql: string, _params?: any[]): Promise<any> {
                    if (/^\s*(CREATE|ALTER|DROP)\b/i.test(sql)) { await client.query(sql); return []; }
                    await client.query(`PREPARE hulo_corpus_stmt AS ${sql}`);
                    await client.query('DEALLOCATE hulo_corpus_stmt');
                    return [];
                },
            };
            const db = createDbAdapter(raw);

            const srcDir = join(__dirname);
            const all = walk(srcDir).flatMap(f => extractSql(f.replace(srcDir + '/', ''), readFileSync(f, 'utf8')));
            expect(all.length).toBeGreaterThan(60);
            all.sort((a, b) => DDL_ORDER(a.sql) - DDL_ORDER(b.sql));
            for (const s of all) {
                const first = s.sql.trim().split('\n')[0].slice(0, 110);
                if (s.skip) { skipped.push(`${s.file}: ${s.skip} — ${first}`); continue; }
                if (s.sql.includes('__CALL_SITES__')) continue; // covered by the expanded addColumnIfMissing calls
                if (/\bMODIFY\b/i.test(s.sql)) { skipped.push(`${s.file}: MySQL-only (the code runs it on MySQL only) — ${first}`); continue; }
                try { await db.query(s.sql, [], s.opts); executed++; }
                catch (e: any) { failures.push(`${s.file}: ${e.message}\n    ${first}`); }
            }
        } finally {
            await client.query('DROP SCHEMA IF EXISTS hulo_corpus CASCADE').catch(() => undefined);
            await client.end();
        }
        // eslint-disable-next-line no-console
        console.log(`PG corpus: ${executed} statements OK, ${skipped.length} skipped, ${failures.length} failed${skipped.length ? `\n  skipped:\n  ${skipped.join('\n  ')}` : ''}`);
        expect(failures, failures.join('\n')).toEqual([]);
    });
});

describe('SQL extraction', () => {
    it('reads escaped backticks, nested templates and interpolations', () => {
        const src = 'const a = db.query(`SELECT \\`orderId\\` FROM payment WHERE id = ? LIMIT ${perPage}`, [1]); const b = `UPDATE t SET ${keys.map(k => `${col(k)} = ?`).join(", ")} WHERE id = ?`; const c = \'CREATE INDEX IF NOT EXISTS i ON t (a)\'; const d = `not sql ${x}`;';
        const out = extractSql('x.ts', src);
        expect(out.map(o => o.sql)).toEqual(['SELECT `orderId` FROM payment WHERE id = ? LIMIT 50', 'UPDATE t SET status = ? WHERE id = ?', 'CREATE INDEX IF NOT EXISTS i ON t (a)']);
    });
});
