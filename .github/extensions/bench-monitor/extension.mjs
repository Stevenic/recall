// Extension: bench-monitor
// Track and monitor recall bench runs with tabs, polling, and run management

import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..", "..");

const servers = new Map();
const sseClients = new Map(); // instanceId → Set<res>

// ─── Data Loading ───────────────────────────────────────────────────────────

async function discoverSystems() {
    const benchDir = join(REPO_ROOT, "bench-results");
    const systems = new Set();
    try {
        const entries = await readdir(benchDir);
        for (const e of entries) {
            const p = join(benchDir, e);
            const s = await stat(p).catch(() => null);
            if (s?.isDirectory()) systems.add(e);
        }
    } catch { /* no bench-results dir */ }
    // Also check bench-harnesses for known systems
    const harnessDir = join(REPO_ROOT, "bench-harnesses");
    try {
        const entries = await readdir(harnessDir);
        for (const e of entries) systems.add(e);
    } catch { /* no bench-harnesses dir */ }
    return [...systems].sort();
}

async function loadAllResults() {
    const benchDir = join(REPO_ROOT, "bench-results");
    const results = [];
    try {
        const systems = await readdir(benchDir);
        for (const system of systems) {
            const systemDir = join(benchDir, system);
            const s = await stat(systemDir).catch(() => null);
            if (!s?.isDirectory()) continue;
            let runs;
            try { runs = await readdir(systemDir); } catch { continue; }
            for (const run of runs) {
                const runDir = join(systemDir, run);
                const rs = await stat(runDir).catch(() => null);
                if (!rs?.isDirectory()) continue;
                const resultPath = join(runDir, "result.json");
                const progressPath = join(runDir, "progress.jsonl");
                // Try result.json first (complete run)
                if (existsSync(resultPath)) {
                    try {
                        const raw = await readFile(resultPath, "utf-8");
                        const data = JSON.parse(raw);
                        results.push({ system, runId: run, status: "complete", ...data });
                    } catch { /* skip invalid */ }
                } else if (existsSync(progressPath)) {
                    // In-progress run: parse progress.jsonl
                    try {
                        const lines = (await readFile(progressPath, "utf-8")).trim().split("\n");
                        const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                        const header = parsed.find(p => p.type === "header");
                        const checkpoints = parsed.filter(p => p.type === "checkpoint");
                        const last = checkpoints[checkpoints.length - 1];
                        results.push({
                            system,
                            runId: run,
                            status: "in-progress",
                            timestamp: header?.timestamp,
                            adapterName: header?.adapterName ?? system,
                            metadata: { judgeModel: header?.judgeModel, sample: header?.sample },
                            checkpointsCompleted: last?.checkpointIndex ?? 0,
                            totalCheckpoints: last?.totalCheckpoints ?? 0,
                            latestScore: last?.overallScore ?? null,
                            latestRange: last?.range,
                            ranges: header?.ranges ?? [],
                        });
                    } catch { /* skip invalid */ }
                }
            }
        }
    } catch { /* bench-results dir missing */ }
    return results;
}

async function loadSystemResults(system) {
    const results = await loadAllResults();
    return results.filter(r => r.system === system);
}

async function loadProgressLines(system, runId) {
    const progressPath = join(REPO_ROOT, "bench-results", system, runId, "progress.jsonl");
    if (!existsSync(progressPath)) return [];
    try {
        const lines = (await readFile(progressPath, "utf-8")).trim().split("\n");
        return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
}

function getProfiles() {
    const profileDir = join(REPO_ROOT, "packages", "recall-bench", "profiles");
    if (!existsSync(profileDir)) return [];
    try {
        return readFileSync ? 
            require("fs").readdirSync(profileDir).filter(f => f.endsWith(".yaml")).map(f => f.replace(".yaml", "")) :
            [];
    } catch { return []; }
}

// ─── HTML Rendering ─────────────────────────────────────────────────────────

function formatDuration(ms) {
    if (!ms) return "N/A";
    const mins = Math.floor(ms / 60000);
    if (mins > 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    return `${mins}m`;
}

function renderApp(instanceId) {
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
    overflow: hidden;
    height: 100vh;
    display: flex;
    flex-direction: column;
}
.tabs {
    display: flex;
    align-items: center;
    background: rgba(0,0,0,0.2);
    border-bottom: 1px solid var(--border-color-default, #30363d);
    padding: 0 8px;
    min-height: 36px;
    overflow-x: auto;
    flex-shrink: 0;
}
.tab {
    padding: 8px 14px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    color: var(--text-color-muted, #8b949e);
    white-space: nowrap;
    transition: all 0.15s;
}
.tab:hover { color: var(--text-color-default, #e6edf3); }
.tab.active { color: var(--text-color-default, #e6edf3); border-bottom-color: #58a6ff; }
.tab-add {
    padding: 6px 10px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    color: var(--text-color-muted, #8b949e);
    border: 1px solid var(--border-color-default, #30363d);
    border-radius: 4px;
    margin-left: 4px;
    background: transparent;
    line-height: 1;
}
.tab-add:hover { color: #58a6ff; border-color: #58a6ff; }
.tab-close {
    margin-left: 6px; font-size: 10px; opacity: 0.5; cursor: pointer;
}
.tab-close:hover { opacity: 1; color: #ff7b72; }
.content { flex: 1; overflow-y: auto; padding: 16px; }
.section { margin-bottom: 24px; }
.section-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border-color-default, #30363d); }
th { color: var(--text-color-muted, #8b949e); font-weight: 500; font-size: 11px; text-transform: uppercase; }
tr:hover { background: rgba(255,255,255,0.03); }
.score { font-weight: 600; font-family: var(--font-mono, monospace); }
.mono { font-family: var(--font-mono, monospace); font-size: 11px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 500; }
.badge-complete { background: #3fb95033; color: #56d364; }
.badge-in-progress { background: #d2992033; color: #e3b341; }
.badge-drafts { background: #8b949e33; color: #8b949e; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin-bottom: 16px; }
.stat-card { background: rgba(255,255,255,0.03); border: 1px solid var(--border-color-default, #30363d); border-radius: 8px; padding: 10px; }
.stat-value { font-size: 20px; font-weight: 700; font-family: var(--font-mono, monospace); }
.stat-label { font-size: 10px; color: var(--text-color-muted, #8b949e); text-transform: uppercase; margin-top: 2px; }
.chart-container { position: relative; height: 200px; background: rgba(255,255,255,0.02); border-radius: 8px; border: 1px solid var(--border-color-default, #30363d); padding: 12px; }
canvas { width: 100% !important; height: 100% !important; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 6px; font-size: 11px; }
.legend-item { display: flex; align-items: center; gap: 4px; }
.legend-dot { width: 8px; height: 8px; border-radius: 50%; }
.btn {
    padding: 6px 14px; font-size: 12px; font-weight: 500; border-radius: 6px;
    cursor: pointer; border: 1px solid var(--border-color-default, #30363d);
    background: rgba(255,255,255,0.05); color: var(--text-color-default, #e6edf3);
    transition: all 0.15s;
}
.btn:hover { background: rgba(255,255,255,0.1); border-color: #58a6ff; }
.btn-primary { background: #1f6feb; border-color: #1f6feb; }
.btn-primary:hover { background: #388bfd; }
.progress-bar { height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-top: 4px; }
.progress-fill { height: 100%; background: #58a6ff; border-radius: 3px; transition: width 0.3s; }
.modal-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
    z-index: 100; opacity: 0; pointer-events: none; transition: opacity 0.2s;
}
.modal-overlay.visible { opacity: 1; pointer-events: all; }
.modal { background: var(--background-color-default, #161b22); border: 1px solid var(--border-color-default, #30363d); border-radius: 10px; padding: 20px; min-width: 280px; max-width: 360px; }
.modal h3 { margin-bottom: 12px; font-size: 15px; }
.modal label { display: block; font-size: 12px; color: var(--text-color-muted, #8b949e); margin-bottom: 4px; margin-top: 10px; }
.modal select, .modal input {
    width: 100%; padding: 6px 10px; font-size: 13px; border-radius: 6px;
    border: 1px solid var(--border-color-default, #30363d); background: rgba(0,0,0,0.3);
    color: var(--text-color-default, #e6edf3);
}
.modal .actions { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; }
.poll-indicator {
    position: fixed; bottom: 8px; right: 12px; font-size: 10px;
    color: var(--text-color-muted, #8b949e); opacity: 0.6;
}
</style>
</head>
<body>
<div class="tabs" id="tabBar">
    <div class="tab active" data-tab="dashboard">Dashboard</div>
    <button class="tab-add" id="addTabBtn" title="Add system tab">+</button>
</div>
<div class="content" id="content"></div>
<div class="poll-indicator" id="pollIndicator">Auto-refresh: 5m</div>

<!-- Add system tab modal -->
<div class="modal-overlay" id="addModal">
    <div class="modal">
        <h3>Add System Tab</h3>
        <label>Memory System</label>
        <select id="systemSelect"></select>
        <div class="actions">
            <button class="btn" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="addSystemTab()">Add</button>
        </div>
    </div>
</div>

<!-- Start run modal -->
<div class="modal-overlay" id="runModal">
    <div class="modal">
        <h3>Start Bench Run</h3>
        <label>Profile</label>
        <select id="profileSelect"></select>
        <label>Run ID</label>
        <input id="runIdInput" placeholder="e.g. ea-180d-my-test" />
        <div class="actions">
            <button class="btn" onclick="closeRunModal()">Cancel</button>
            <button class="btn btn-primary" onclick="startRun()">Start</button>
        </div>
    </div>
</div>

<script>
const COLORS = ['#58a6ff', '#56d364', '#f0883e', '#bc8cff', '#ff7b72', '#79c0ff', '#d2a8ff', '#a5d6ff'];
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

let state = { tabs: ['dashboard'], activeTab: 'dashboard', systems: [], allResults: [], profiles: [] };

// ─── Data fetching ──────────────────────────────────────────────────────
async function fetchData() {
    const [results, systems, profiles] = await Promise.all([
        fetch('/api/results').then(r => r.json()),
        fetch('/api/systems').then(r => r.json()),
        fetch('/api/profiles').then(r => r.json()),
    ]);
    state.allResults = results;
    state.systems = systems;
    state.profiles = profiles;
    render();
}

// ─── SSE for live updates ───────────────────────────────────────────────
let eventSource;
function connectSSE() {
    eventSource = new EventSource('/events');
    eventSource.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.type === 'refresh') fetchData();
        } catch {}
    };
    eventSource.onerror = () => { setTimeout(connectSSE, 5000); };
}
connectSSE();

// ─── Tab management ─────────────────────────────────────────────────────
function switchTab(tab) {
    state.activeTab = tab;
    render();
}

function removeTab(tab) {
    state.tabs = state.tabs.filter(t => t !== tab);
    if (state.activeTab === tab) state.activeTab = 'dashboard';
    render();
}

document.getElementById('addTabBtn').onclick = () => {
    const select = document.getElementById('systemSelect');
    select.innerHTML = state.systems.map(s => '<option value="' + s + '">' + s + '</option>').join('');
    document.getElementById('addModal').classList.add('visible');
};

function closeModal() { document.getElementById('addModal').classList.remove('visible'); }
function closeRunModal() { document.getElementById('runModal').classList.remove('visible'); }

function addSystemTab() {
    const system = document.getElementById('systemSelect').value;
    if (system && !state.tabs.includes(system)) {
        state.tabs.push(system);
    }
    state.activeTab = system;
    closeModal();
    render();
}

function showRunModal(system) {
    const select = document.getElementById('profileSelect');
    select.innerHTML = state.profiles.map(p => '<option value="' + p + '">' + p + '</option>').join('');
    // Default run ID
    document.getElementById('runIdInput').value = '';
    document.getElementById('runModal').dataset.system = system;
    document.getElementById('runModal').classList.add('visible');
}

async function startRun() {
    const profile = document.getElementById('profileSelect').value;
    const runId = document.getElementById('runIdInput').value.trim();
    const system = document.getElementById('runModal').dataset.system;
    if (!profile || !runId) return alert('Please fill in all fields');
    closeRunModal();
    try {
        const res = await fetch('/api/start-run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile, runId, system })
        });
        const data = await res.json();
        if (!data.ok) alert('Failed to start run: ' + (data.error || 'unknown'));
        else fetchData();
    } catch (e) { alert('Error: ' + e.message); }
}

// ─── Rendering ──────────────────────────────────────────────────────────
function render() {
    // Tabs
    const tabBar = document.getElementById('tabBar');
    const addBtn = document.getElementById('addTabBtn');
    tabBar.querySelectorAll('.tab').forEach(t => t.remove());
    
    // Dashboard tab
    const dashTab = document.createElement('div');
    dashTab.className = 'tab' + (state.activeTab === 'dashboard' ? ' active' : '');
    dashTab.textContent = 'Dashboard';
    dashTab.onclick = () => switchTab('dashboard');
    dashTab.dataset.tab = 'dashboard';
    tabBar.insertBefore(dashTab, addBtn);

    // System tabs
    state.tabs.filter(t => t !== 'dashboard').forEach(tab => {
        const el = document.createElement('div');
        el.className = 'tab' + (state.activeTab === tab ? ' active' : '');
        el.innerHTML = tab + '<span class="tab-close" onclick="event.stopPropagation(); removeTab(\\''+tab+'\\')">✕</span>';
        el.onclick = () => switchTab(tab);
        tabBar.insertBefore(el, addBtn);
    });

    // Content
    const content = document.getElementById('content');
    if (state.activeTab === 'dashboard') {
        content.innerHTML = renderDashboard();
    } else {
        content.innerHTML = renderSystemTab(state.activeTab);
    }

    // Draw charts after DOM update
    requestAnimationFrame(() => {
        if (state.activeTab === 'dashboard') drawDashboardCharts();
        else drawSystemCharts(state.activeTab);
    });
}

function renderDashboard() {
    const results = state.allResults;
    const complete = results.filter(r => r.status === 'complete');
    const inProgress = results.filter(r => r.status === 'in-progress');
    
    let html = '<div class="stats-grid">';
    html += '<div class="stat-card"><div class="stat-value">' + results.length + '</div><div class="stat-label">Total Runs</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + complete.length + '</div><div class="stat-label">Complete</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + inProgress.length + '</div><div class="stat-label">In Progress</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + state.systems.length + '</div><div class="stat-label">Systems</div></div>';
    html += '</div>';

    if (complete.length > 0) {
        html += '<div class="section"><div class="section-title">Score Over Time (All Systems)</div>';
        html += '<div class="chart-container"><canvas id="scoreChart"></canvas></div>';
        html += '<div class="legend" id="chartLegend"></div></div>';
    }

    // All runs table
    html += '<div class="section"><div class="section-title">All Runs</div><table><thead><tr>';
    html += '<th>System</th><th>Run</th><th>Status</th><th>Score</th><th>Progress</th><th>Date</th></tr></thead><tbody>';
    results.forEach(r => {
        const score = r.status === 'complete' ? (r.finalScore?.toFixed(2) ?? 'N/A') : (r.latestScore?.toFixed(2) ?? '—');
        const statusBadge = '<span class="badge badge-' + r.status + '">' + r.status + '</span>';
        const progress = r.status === 'in-progress'
            ? r.checkpointsCompleted + '/' + r.totalCheckpoints + ' checkpoints'
            : (r.metadata?.totalEvalsRun ?? '—') + ' evals';
        const date = r.timestamp ? new Date(r.timestamp).toLocaleDateString() : '—';
        html += '<tr><td><span class="badge badge-' + (r.system === 'drafts' ? 'drafts' : 'complete') + '">' + r.system + '</span></td>';
        html += '<td class="mono">' + r.runId + '</td>';
        html += '<td>' + statusBadge + '</td>';
        html += '<td class="score">' + score + '</td>';
        html += '<td>' + progress + '</td>';
        html += '<td>' + date + '</td></tr>';
    });
    html += '</tbody></table></div>';
    return html;
}

function renderSystemTab(system) {
    const results = state.allResults.filter(r => r.system === system);
    const inProgress = results.filter(r => r.status === 'in-progress');
    
    let html = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">';
    html += '<div class="section-title" style="margin:0">' + system + ' — ' + results.length + ' run(s)</div>';
    html += '<button class="btn btn-primary" onclick="showRunModal(\\''+system+'\\')">▶ Start Run</button>';
    html += '</div>';

    // In-progress runs with progress bars
    if (inProgress.length > 0) {
        html += '<div class="section"><div class="section-title">Active Runs</div>';
        inProgress.forEach(r => {
            const pct = r.totalCheckpoints ? Math.round((r.checkpointsCompleted / r.totalCheckpoints) * 100) : 0;
            html += '<div class="stat-card" style="margin-bottom:8px;">';
            html += '<div style="display:flex; justify-content:space-between;">';
            html += '<span class="mono">' + r.runId + '</span>';
            html += '<span class="score">' + (r.latestScore?.toFixed(2) ?? '—') + '</span>';
            html += '</div>';
            html += '<div style="font-size:11px; color:var(--text-color-muted); margin-top:4px;">';
            html += 'Checkpoint ' + r.checkpointsCompleted + '/' + r.totalCheckpoints;
            if (r.latestRange) html += ' • ' + r.latestRange.label;
            html += '</div>';
            html += '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>';
            html += '</div>';
        });
        html += '</div>';
    }

    // Score chart for this system
    const complete = results.filter(r => r.status === 'complete');
    if (complete.length > 0) {
        html += '<div class="section"><div class="section-title">Score Over Time</div>';
        html += '<div class="chart-container"><canvas id="systemScoreChart"></canvas></div>';
        html += '<div class="legend" id="systemChartLegend"></div></div>';
    }

    // Results table
    html += '<div class="section"><div class="section-title">Run History</div><table><thead><tr>';
    html += '<th>Run</th><th>Adapter</th><th>Status</th><th>Score</th><th>Questions</th><th>Duration</th><th>Date</th></tr></thead><tbody>';
    results.forEach(r => {
        const score = r.status === 'complete' ? (r.finalScore?.toFixed(2) ?? 'N/A') : (r.latestScore?.toFixed(2) ?? '—');
        const questions = r.questionsEvaluated ?? '—';
        const duration = r.durationMs ? formatDuration(r.durationMs) : '—';
        const date = r.timestamp ? new Date(r.timestamp).toLocaleDateString() : '—';
        html += '<tr><td class="mono">' + r.runId + '</td>';
        html += '<td>' + (r.adapterName ?? '—') + '</td>';
        html += '<td><span class="badge badge-' + r.status + '">' + r.status + '</span></td>';
        html += '<td class="score">' + score + '</td>';
        html += '<td>' + questions + '</td>';
        html += '<td>' + duration + '</td>';
        html += '<td>' + date + '</td></tr>';
    });
    html += '</tbody></table></div>';
    return html;
}

function formatDuration(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins > 60) return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
    return mins + 'm';
}

// ─── Chart drawing ──────────────────────────────────────────────────────
function drawLineChart(canvasId, legendId, series) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width - 24;
    canvas.height = rect.height - 24;
    const W = canvas.width, H = canvas.height;
    const pad = { top: 10, right: 10, bottom: 30, left: 36 };

    ctx.clearRect(0, 0, W, H);
    if (!series.length) return;

    const allDays = series.flatMap(s => s.points.map(p => p.days));
    const maxDays = Math.max(...allDays);

    const xScale = (d) => pad.left + (d / maxDays) * (W - pad.left - pad.right);
    const yScale = (s) => pad.top + (1 - s / 6) * (H - pad.top - pad.bottom);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let s = 0; s <= 6; s += 2) {
        ctx.beginPath(); ctx.moveTo(pad.left, yScale(s)); ctx.lineTo(W - pad.right, yScale(s)); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
        ctx.fillText(s.toString(), pad.left - 6, yScale(s) + 3);
    }
    // X labels
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.ceil(maxDays / 6));
    for (let d = 0; d <= maxDays; d += step) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fillText(d + 'd', xScale(d), H - pad.bottom + 16);
    }
    // Lines
    const legend = document.getElementById(legendId);
    if (legend) legend.innerHTML = '';
    series.forEach((s, i) => {
        const color = COLORS[i % COLORS.length];
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
        s.points.forEach((p, j) => {
            const x = xScale(p.days), y = yScale(p.score);
            j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
        if (legend) legend.innerHTML += '<div class="legend-item"><div class="legend-dot" style="background:'+color+'"></div>'+s.label+'</div>';
    });
}

function drawDashboardCharts() {
    const complete = state.allResults.filter(r => r.status === 'complete' && r.personas);
    const series = complete.map(r => {
        const persona = r.personas[0];
        if (!persona) return null;
        return { label: r.system + '/' + r.runId, points: persona.rangeResults.map(rr => ({ days: rr.range.days, score: rr.overallScore })) };
    }).filter(Boolean);
    drawLineChart('scoreChart', 'chartLegend', series);
}

function drawSystemCharts(system) {
    const complete = state.allResults.filter(r => r.system === system && r.status === 'complete' && r.personas);
    const series = complete.map(r => {
        const persona = r.personas[0];
        if (!persona) return null;
        return { label: r.runId, points: persona.rangeResults.map(rr => ({ days: rr.range.days, score: rr.overallScore })) };
    }).filter(Boolean);
    drawLineChart('systemScoreChart', 'systemChartLegend', series);
}

// ─── Init ───────────────────────────────────────────────────────────────
fetchData();
setInterval(fetchData, POLL_INTERVAL);

// Update poll indicator countdown
let lastFetch = Date.now();
setInterval(() => {
    const elapsed = Date.now() - lastFetch;
    const remaining = Math.max(0, Math.ceil((POLL_INTERVAL - elapsed) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    document.getElementById('pollIndicator').textContent = 'Next refresh: ' + mins + ':' + String(secs).padStart(2, '0');
}, 1000);
const origFetch = fetchData;
fetchData = async function() { lastFetch = Date.now(); return origFetch(); };

window.addEventListener('resize', render);
</script>
</body>
</html>`;
}

// ─── Server ─────────────────────────────────────────────────────────────────

async function startServer(instanceId) {
    const clients = new Set();
    sseClients.set(instanceId, clients);

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (url.pathname === "/events") {
            // SSE endpoint
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            });
            clients.add(res);
            req.on("close", () => clients.delete(res));
            return;
        }

        if (url.pathname === "/" || url.pathname === "/index.html") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(renderApp(instanceId));
            return;
        }

        if (url.pathname === "/api/results") {
            const results = await loadAllResults();
            // Attach full persona data for complete runs
            const enriched = results.map(r => {
                if (r.status === "complete") {
                    return {
                        ...r,
                        finalScore: (() => {
                            const p = r.personas?.[0];
                            const last = p?.rangeResults?.[p.rangeResults.length - 1];
                            return last?.overallScore ?? null;
                        })(),
                        questionsEvaluated: (() => {
                            const p = r.personas?.[0];
                            const last = p?.rangeResults?.[p.rangeResults.length - 1];
                            return last?.questionsEvaluated ?? 0;
                        })(),
                        durationMs: r.metadata?.durationMs,
                    };
                }
                return r;
            });
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(enriched));
            return;
        }

        if (url.pathname === "/api/systems") {
            const systems = await discoverSystems();
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(systems));
            return;
        }

        if (url.pathname === "/api/profiles") {
            const profileDir = join(REPO_ROOT, "packages", "recall-bench", "profiles");
            let profiles = [];
            try {
                const entries = await readdir(profileDir);
                profiles = entries.filter(f => f.endsWith(".yaml")).map(f => f.replace(".yaml", ""));
            } catch {}
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(profiles));
            return;
        }

        if (url.pathname === "/api/start-run" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const { profile, runId, system } = JSON.parse(body);
                const outDir = join(REPO_ROOT, "bench-results", system || "drafts", runId);
                const profilePath = join(REPO_ROOT, "packages", "recall-bench", "profiles", profile + ".yaml");
                if (!existsSync(profilePath)) {
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ ok: false, error: "Profile not found: " + profile }));
                    return;
                }
                // Create output directory
                const { mkdirSync } = await import("node:fs");
                mkdirSync(outDir, { recursive: true });

                // Start bench run in background
                const child = spawn("npx", ["recall-bench", "run",
                    "--profile", profilePath,
                    "--json-out", join(outDir, "result.json")
                ], {
                    cwd: REPO_ROOT,
                    stdio: "ignore",
                    detached: true,
                    shell: true,
                });
                child.unref();

                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, runId, outDir }));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
            return;
        }

        res.statusCode = 404;
        res.end("Not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    // Set up 5-minute polling to push refresh events via SSE
    const pollTimer = setInterval(() => {
        const msg = `data: ${JSON.stringify({ type: "refresh" })}\n\n`;
        for (const client of clients) {
            try { client.write(msg); } catch {}
        }
    }, 5 * 60 * 1000);

    return { server, url: `http://127.0.0.1:${port}/`, pollTimer };
}

// ─── Canvas Declaration ─────────────────────────────────────────────────────

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "bench-monitor",
            displayName: "Bench Monitor",
            description: "Dashboard to track and monitor recall bench run results, showing scores over time, category breakdowns, and run comparisons.",
            actions: [
                {
                    name: "get_results",
                    description: "Get a summary of all bench run results including drafts and in-progress runs",
                    handler: async (ctx) => {
                        const results = await loadAllResults();
                        return results.map(r => {
                            if (r.status === "complete") {
                                const persona = r.personas?.[0];
                                const lastRange = persona?.rangeResults?.[persona.rangeResults.length - 1];
                                return {
                                    system: r.system, runId: r.runId, status: r.status,
                                    adapterName: r.adapterName, timestamp: r.timestamp,
                                    finalScore: lastRange?.overallScore ?? null,
                                    questionsEvaluated: lastRange?.questionsEvaluated ?? 0,
                                    durationMs: r.metadata?.durationMs,
                                    judgeModel: r.metadata?.judgeModel,
                                };
                            }
                            return {
                                system: r.system, runId: r.runId, status: r.status,
                                adapterName: r.adapterName, timestamp: r.timestamp,
                                latestScore: r.latestScore,
                                checkpointsCompleted: r.checkpointsCompleted,
                                totalCheckpoints: r.totalCheckpoints,
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
                        const results = await loadAllResults();
                        const find = (id) => results.find(r => `${r.system}/${r.runId}` === id);
                        const r1 = find(ctx.input.run1);
                        const r2 = find(ctx.input.run2);
                        if (!r1 || !r2) {
                            return { error: "Run not found", available: results.map(r => `${r.system}/${r.runId}`) };
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
                {
                    name: "start_run",
                    description: "Start a new bench run with a given profile",
                    inputSchema: {
                        type: "object",
                        properties: {
                            profile: { type: "string", description: "Profile name (without .yaml extension)" },
                            runId: { type: "string", description: "Run ID for the output directory" },
                            system: { type: "string", description: "System name (folder under bench-results/). Defaults to 'drafts'." },
                        },
                        required: ["profile", "runId"],
                    },
                    handler: async (ctx) => {
                        const { profile, runId, system = "drafts" } = ctx.input;
                        const outDir = join(REPO_ROOT, "bench-results", system, runId);
                        const profilePath = join(REPO_ROOT, "packages", "recall-bench", "profiles", profile + ".yaml");
                        if (!existsSync(profilePath)) {
                            return { ok: false, error: "Profile not found: " + profile };
                        }
                        const { mkdirSync } = await import("node:fs");
                        mkdirSync(outDir, { recursive: true });
                        const child = spawn("npx", ["recall-bench", "run",
                            "--profile", profilePath,
                            "--json-out", join(outDir, "result.json")
                        ], { cwd: REPO_ROOT, stdio: "ignore", detached: true, shell: true });
                        child.unref();
                        return { ok: true, runId, outDir, profile };
                    },
                },
                {
                    name: "list_systems",
                    description: "List all known memory systems with bench harnesses or results",
                    handler: async () => {
                        return await discoverSystems();
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
                    sseClients.delete(ctx.instanceId);
                    if (entry.pollTimer) clearInterval(entry.pollTimer);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
