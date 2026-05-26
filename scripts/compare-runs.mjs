// Usage: node scripts/compare-runs.mjs <run-A-dir> <label-A> <run-B-dir> <label-B>
import { readFileSync } from 'node:fs';

function summarize(dir, label) {
    const r = JSON.parse(readFileSync(`${dir}/result.json`, 'utf-8'));
    const byRange = {};
    const byCat = {};
    for (const row of r.heatmap) {
        if (!byRange[row.range]) byRange[row.range] = { t: 0, n: 0 };
        byRange[row.range].t += (row.score || 0) * (row.questionCount || 0);
        byRange[row.range].n += (row.questionCount || 0);
        if (!byCat[row.category]) byCat[row.category] = { t: 0, n: 0 };
        byCat[row.category].t += (row.score || 0) * (row.questionCount || 0);
        byCat[row.category].n += (row.questionCount || 0);
    }
    const t = Object.values(byCat).reduce((a, c) => a + c.t, 0);
    const n = Object.values(byCat).reduce((a, c) => a + c.n, 0);
    return { label, adapter: r.adapterName, byRange, byCat, t, n, meta: r.metadata };
}

const [, , dirA, labA, dirB, labB] = process.argv;
const a = summarize(dirA, labA);
const b = summarize(dirB, labB);

console.log('=== overall composite ===');
for (const x of [a, b]) {
    const pct = (100 * x.t / x.n / 6).toFixed(1);
    console.log(`  ${(x.label + ' [' + x.adapter + ']').padEnd(40)}${(x.t / x.n).toFixed(2)}/6  ${(pct + '%').padStart(7)}  evals=${x.n}  dur=${(x.meta.durationMs / 1000 / 60).toFixed(0)}m  appellate=${x.meta.appellateInvocations}`);
}

console.log('\n=== by category (% score) ===');
const cats = [...new Set([...Object.keys(a.byCat), ...Object.keys(b.byCat)])];
console.log(`  ${'category'.padEnd(28)}${a.label.padEnd(20)}${b.label.padEnd(20)}delta`);
for (const c of cats) {
    const m = a.byCat[c], o = b.byCat[c];
    const ap = (m && m.n > 0) ? 100 * m.t / m.n / 6 : null;
    const bp = (o && o.n > 0) ? 100 * o.t / o.n / 6 : null;
    const aS = ap != null ? `${ap.toFixed(1)}% (n=${m.n})`.padEnd(18) : '--'.padEnd(18);
    const bS = bp != null ? `${bp.toFixed(1)}% (n=${o.n})`.padEnd(18) : '--'.padEnd(18);
    const d = (ap != null && bp != null) ? `${(ap - bp >= 0 ? '+' : '')}${(ap - bp).toFixed(1)}pp` : '';
    console.log(`  ${c.padEnd(28)}${aS}  ${bS}  ${d}`);
}

console.log('\n=== by checkpoint (% score) ===');
const ranges = [...new Set([...Object.keys(a.byRange), ...Object.keys(b.byRange)])].sort((x, y) => parseInt(x) - parseInt(y));
console.log(`  ${'range'.padStart(6)}   ${a.label.padStart(8)}    ${b.label.padStart(8)}   delta`);
for (const r of ranges) {
    const m = a.byRange[r], o = b.byRange[r];
    const ap = (m && m.n > 0) ? 100 * m.t / m.n / 6 : null;
    const bp = (o && o.n > 0) ? 100 * o.t / o.n / 6 : null;
    const aS = ap != null ? ap.toFixed(1) + '%' : '  --';
    const bS = bp != null ? bp.toFixed(1) + '%' : '  --';
    const d = (ap != null && bp != null) ? `${(ap - bp >= 0 ? '+' : '')}${(ap - bp).toFixed(1)}pp` : '';
    console.log(`  ${r.padStart(6)}   ${aS.padStart(7)}     ${bS.padStart(7)}   ${d}`);
}
