// Extension: bench-monitor
// Track and monitor recall bench runs with score charts and comparisons

import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// extension lives at .github/extensions/bench-monitor/extension.mjs → repo root is 3 levels up
const REPO_ROOT = join(__dirname, "..", "..", "..");

const servers = new Map();

// Load all bench result JSON files
async function loadBenchResults() {
    const benchDir = join(REPO_ROOT, "bench-results");
    const results = [];
    try {
        const systems = await readdir(benchDir);
        for (const system of systems) {
            const systemDir = join(benchDir, system);
            let runs;
            try { runs = await readdir(systemDir); } catch { continue; }
            for (const run of runs) {
                const resultPath = join(systemDir, run, "result.json");
                try {
                    const raw = await readFile(resultPath, "utf-8");
                    const data = JSON.parse(raw);
                    results.push({ system, runId: run, ...data });
                } catch { /* skip missing/invalid */ }
            }
        }
    } catch { /* bench-results dir missing */ }
    return results;
}

function formatDuration(ms) {
    if (!ms) return "N/A";
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    if (mins > 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    return `${mins}m ${secs}s`;
}

function renderDashboard(results) {
    const rows = results.map(r => {
        const persona = r.personas?.[0];
        const lastRange = persona?.rangeResults?.[persona.rangeResults.length - 1];
        const finalScore = lastRange?.overallScore?.toFixed(2) ?? "N/A";
        const totalQuestions = lastRange?.questionsEvaluated ?? 0;
        const duration = formatDuration(r.metadata?.durationMs);
        const date = r.timestamp ? new Date(r.timestamp).toLocaleDateString() : "N/A";
        return { system: r.system, runId: r.runId, adapter: r.adapterName, date, finalScore, totalQuestions, duration, metadata: r.metadata };
    });

    const tableRows = rows.map(r => `
        <tr>
            <td><span class="badge badge-${r.system}">${r.system}</span></td>
            <td class="run-name">${r.runId}</td>
            <td>${r.adapter}</td>
            <td>${r.date}</td>
            <td class="score">${r.finalScore}</td>
            <td>${r.totalQuestions}</td>
            <td>${r.duration}</td>
        </tr>`).join("");

    // Build score-over-range chart data for each run
    const chartData = results.map(r => {
        const persona = r.personas?.[0];
        if (!persona) return null;
        const points = persona.rangeResults.map(rr => ({
            days: rr.range.days,
            score: rr.overallScore
        }));
        return { label: `${r.system}/${r.runId}`, points };
    }).filter(Boolean);

    // Category comparison for all runs at final range
    const categories = results[0]?.personas?.[0]?.rangeResults?.[0]?.categoryScores?.map(c => c.category) ?? [];
    const categoryData = results.map(r => {
        const persona = r.personas?.[0];
        const lastRange = persona?.rangeResults?.[persona.rangeResults.length - 1];
        const scores = {};
        lastRange?.categoryScores?.forEach(c => { scores[c.category] = c.meanScore; });
        return { label: `${r.system}/${r.runId}`, scores };
    });

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Bench Monitor</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 14px);
    line-height: var(--leading-body-medium, 20px);
    background: var(--background-color-default, #0d1117);
    color: var(--text-color-default, #e6edf3);
    padding: 16px;
    overflow-y: auto;
}
h1 {
    font-size: var(--text-title-large, 22px);
    font-weight: var(--font-weight-semibold, 600);
    margin-bottom: 4px;
}
.subtitle { color: var(--text-color-muted, #8b949e); margin-bottom: 16px; }
.section { margin-bottom: 24px; }
.section-title {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 8px;
    color: var(--text-color-default, #e6edf3);
}
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border-color-default, #30363d); }
th { color: var(--text-color-muted, #8b949e); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
tr:hover { background: rgba(255,255,255,0.03); }
.score { font-weight: 600; font-family: var(--font-mono, monospace); }
.run-name { font-family: var(--font-mono, monospace); font-size: 12px; }
.badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 11px; font-weight: 500;
}
.badge-recall { background: #1f6feb33; color: #58a6ff; }
.badge-openclaw { background: #3fb95033; color: #56d364; }
.chart-container { position: relative; height: 220px; background: rgba(255,255,255,0.02); border-radius: 8px; border: 1px solid var(--border-color-default, #30363d); padding: 12px; }
canvas { width: 100% !important; height: 100% !important; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
.stat-card {
    background: rgba(255,255,255,0.03); border: 1px solid var(--border-color-default, #30363d);
    border-radius: 8px; padding: 12px;
}
.stat-value { font-size: 22px; font-weight: 700; font-family: var(--font-mono, monospace); }
.stat-label { font-size: 11px; color: var(--text-color-muted, #8b949e); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; }
.legend-item { display: flex; align-items: center; gap: 4px; }
.legend-dot { width: 10px; height: 10px; border-radius: 50%; }
</style>
</head>
<body>
<h1>Bench Monitor</h1>
<p class="subtitle">${results.length} bench run${results.length !== 1 ? "s" : ""} found</p>

<div class="stats-grid">
    ${rows.map(r => `
    <div class="stat-card">
        <div class="stat-value">${r.finalScore}</div>
        <div class="stat-label">${r.runId.replace(/^ea-/, "").replace(/-/g, " ")}</div>
    </div>`).join("")}
</div>

<div class="section">
    <div class="section-title">Score Over Time</div>
    <div class="chart-container">
        <canvas id="scoreChart"></canvas>
    </div>
    <div class="legend" id="chartLegend"></div>
</div>

<div class="section">
    <div class="section-title">Category Scores (Final Range)</div>
    <div class="chart-container" style="height: 180px;">
        <canvas id="categoryChart"></canvas>
    </div>
</div>

<div class="section">
    <div class="section-title">All Runs</div>
    <table>
        <thead><tr><th>System</th><th>Run</th><th>Adapter</th><th>Date</th><th>Score</th><th>Questions</th><th>Duration</th></tr></thead>
        <tbody>${tableRows}</tbody>
    </table>
</div>

<script>
const COLORS = ['#58a6ff', '#56d364', '#f0883e', '#bc8cff', '#ff7b72', '#79c0ff'];
const chartData = ${JSON.stringify(chartData)};
const categoryData = ${JSON.stringify(categoryData)};
const categories = ${JSON.stringify(categories)};

function drawScoreChart() {
    const canvas = document.getElementById('scoreChart');
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width - 24;
    canvas.height = rect.height - 24;
    const W = canvas.width, H = canvas.height;
    const pad = { top: 10, right: 10, bottom: 30, left: 40 };

    ctx.clearRect(0, 0, W, H);

    if (!chartData.length) return;

    const allDays = chartData.flatMap(d => d.points.map(p => p.days));
    const maxDays = Math.max(...allDays);
    const minScore = 0, maxScore = 6;

    const xScale = (d) => pad.left + (d / maxDays) * (W - pad.left - pad.right);
    const yScale = (s) => pad.top + (1 - (s - minScore) / (maxScore - minScore)) * (H - pad.top - pad.bottom);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let s = 0; s <= 6; s++) {
        ctx.beginPath();
        ctx.moveTo(pad.left, yScale(s));
        ctx.lineTo(W - pad.right, yScale(s));
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(s.toString(), pad.left - 6, yScale(s) + 3);
    }

    // X axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'center';
    const step = Math.ceil(maxDays / 6);
    for (let d = 0; d <= maxDays; d += step) {
        ctx.fillText(d + 'd', xScale(d), H - pad.bottom + 16);
    }

    // Lines
    const legend = document.getElementById('chartLegend');
    legend.innerHTML = '';
    chartData.forEach((series, i) => {
        const color = COLORS[i % COLORS.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        series.points.forEach((p, j) => {
            const x = xScale(p.days), y = yScale(p.score);
            j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();

        legend.innerHTML += '<div class="legend-item"><div class="legend-dot" style="background:' + color + '"></div>' + series.label + '</div>';
    });
}

function drawCategoryChart() {
    const canvas = document.getElementById('categoryChart');
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width - 24;
    canvas.height = rect.height - 24;
    const W = canvas.width, H = canvas.height;
    const pad = { top: 10, right: 10, bottom: 50, left: 40 };

    ctx.clearRect(0, 0, W, H);
    if (!categories.length || !categoryData.length) return;

    const numCats = categories.length;
    const numRuns = categoryData.length;
    const groupWidth = (W - pad.left - pad.right) / numCats;
    const barWidth = Math.min(16, (groupWidth - 8) / numRuns);

    const yScale = (s) => pad.top + (1 - s / 6) * (H - pad.top - pad.bottom);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let s = 0; s <= 6; s += 2) {
        ctx.beginPath();
        ctx.moveTo(pad.left, yScale(s));
        ctx.lineTo(W - pad.right, yScale(s));
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(s.toString(), pad.left - 6, yScale(s) + 3);
    }

    // Bars
    categories.forEach((cat, ci) => {
        const groupX = pad.left + ci * groupWidth + groupWidth / 2;
        categoryData.forEach((run, ri) => {
            const score = run.scores[cat] ?? 0;
            const x = groupX - (numRuns * barWidth) / 2 + ri * barWidth;
            const y = yScale(score);
            const h = yScale(0) - y;
            ctx.fillStyle = COLORS[ri % COLORS.length];
            ctx.globalAlpha = 0.8;
            ctx.fillRect(x, y, barWidth - 1, h);
            ctx.globalAlpha = 1;
        });
        // Label
        ctx.save();
        ctx.translate(groupX, H - pad.bottom + 8);
        ctx.rotate(-Math.PI / 5);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(cat.replace(/-/g, ' '), 0, 0);
        ctx.restore();
    });
}

drawScoreChart();
drawCategoryChart();
window.addEventListener('resize', () => { drawScoreChart(); drawCategoryChart(); });
</script>
</body>
</html>`;
}

async function startServer(instanceId) {
    const server = createServer(async (req, res) => {
        if (req.url === "/" || req.url === "/index.html") {
            const results = await loadBenchResults();
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(renderDashboard(results));
        } else if (req.url === "/api/results") {
            const results = await loadBenchResults();
            // Return summarized data
            const summary = results.map(r => {
                const persona = r.personas?.[0];
                const lastRange = persona?.rangeResults?.[persona.rangeResults.length - 1];
                return {
                    system: r.system,
                    runId: r.runId,
                    adapterName: r.adapterName,
                    timestamp: r.timestamp,
                    finalScore: lastRange?.overallScore ?? null,
                    questionsEvaluated: lastRange?.questionsEvaluated ?? 0,
                    metadata: r.metadata,
                    rangeCount: r.ranges?.length ?? 0,
                };
            });
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(summary, null, 2));
        } else {
            res.statusCode = 404;
            res.end("Not found");
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "bench-monitor",
            displayName: "Bench Monitor",
            description: "Dashboard to track and monitor recall bench run results, showing scores over time, category breakdowns, and run comparisons.",
            actions: [
                {
                    name: "get_results",
                    description: "Get a summary of all bench run results including scores, durations, and metadata",
                    handler: async (ctx) => {
                        const results = await loadBenchResults();
                        return results.map(r => {
                            const persona = r.personas?.[0];
                            const lastRange = persona?.rangeResults?.[persona.rangeResults.length - 1];
                            return {
                                system: r.system,
                                runId: r.runId,
                                adapterName: r.adapterName,
                                timestamp: r.timestamp,
                                finalScore: lastRange?.overallScore ?? null,
                                questionsEvaluated: lastRange?.questionsEvaluated ?? 0,
                                durationMs: r.metadata?.durationMs,
                                judgeModel: r.metadata?.judgeModel,
                            };
                        });
                    },
                },
                {
                    name: "compare_runs",
                    description: "Compare category scores between two bench runs",
                    inputSchema: {
                        type: "object",
                        properties: {
                            run1: { type: "string", description: "First run ID (e.g. 'recall/ea-180d-recall-baseline')" },
                            run2: { type: "string", description: "Second run ID (e.g. 'openclaw/ea-180d-openclaw')" },
                        },
                        required: ["run1", "run2"],
                    },
                    handler: async (ctx) => {
                        const results = await loadBenchResults();
                        const find = (id) => results.find(r => `${r.system}/${r.runId}` === id);
                        const r1 = find(ctx.input.run1);
                        const r2 = find(ctx.input.run2);
                        if (!r1 || !r2) {
                            const available = results.map(r => `${r.system}/${r.runId}`);
                            return { error: "Run not found", available };
                        }
                        const extract = (r) => {
                            const persona = r.personas?.[0];
                            const last = persona?.rangeResults?.[persona.rangeResults.length - 1];
                            const cats = {};
                            last?.categoryScores?.forEach(c => { cats[c.category] = c.meanScore; });
                            return { overallScore: last?.overallScore, categories: cats };
                        };
                        return { run1: { id: ctx.input.run1, ...extract(r1) }, run2: { id: ctx.input.run2, ...extract(r2) } };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Bench Monitor", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
