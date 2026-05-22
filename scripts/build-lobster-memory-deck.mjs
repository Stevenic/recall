#!/usr/bin/env node
/**
 * Build the 4-slide "Memory for Lobster on Teams" review deck for Sumi.
 *
 * Teams visual identity:
 *   - Teams purple #6264A7 as primary accent
 *   - White slide background, dark slate text (#242424)
 *   - Segoe UI Variable / Segoe UI font family
 *   - Generous whitespace; left-anchored content
 *
 * Output: docs/lobster-memory-plan-2026-05-19.pptx
 */

import PptxGenJS from "pptxgenjs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const OUT_PATH = resolve("C:/source/recall/docs/lobster-memory-plan-2026-05-19.pptx");
const HEATMAP_PATH = resolve(
  "C:/source/recall/packages/recall-bench/runs/ea-180d-baseline-azure-merged.png",
);
if (!existsSync(HEATMAP_PATH)) {
  console.error("Heatmap PNG missing:", HEATMAP_PATH);
  process.exit(1);
}

// ---- Teams palette ---------------------------------------------------------
const TEAMS_PURPLE = "6264A7";
const TEAMS_PURPLE_DARK = "464775";
const TEAMS_PURPLE_LIGHT = "E8E9F4";
const INK = "242424";
const SLATE = "424242";
const MUTED = "707070";
const WHITE = "FFFFFF";

const FONT = "Segoe UI";

// ---- Deck setup ------------------------------------------------------------
const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE"; // 13.33 × 7.5 in
pptx.title = "Memory for Lobster on Teams";
pptx.author = "Steve Ickman";
pptx.company = "Microsoft — Teams Engineering";
pptx.subject = "Lobster memory plan — VP review, May 19, 2026";

const W = 13.33;
const H = 7.5;

// Reusable footer / page accent
function addFooter(slide, page) {
  slide.addShape("rect", {
    x: 0,
    y: H - 0.3,
    w: W,
    h: 0.3,
    fill: { color: TEAMS_PURPLE_LIGHT },
    line: { type: "none" },
  });
  slide.addText("Microsoft Confidential · Teams Engineering · May 19, 2026", {
    x: 0.5,
    y: H - 0.32,
    w: 8,
    h: 0.3,
    fontFace: FONT,
    fontSize: 9,
    color: MUTED,
    valign: "middle",
  });
  slide.addText(`${page} / 4`, {
    x: W - 1.0,
    y: H - 0.32,
    w: 0.5,
    h: 0.3,
    fontFace: FONT,
    fontSize: 9,
    color: MUTED,
    valign: "middle",
    align: "right",
  });
}

// ---- Slide 1: Title --------------------------------------------------------
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };

  // Left full-height purple panel
  s.addShape("rect", {
    x: 0,
    y: 0,
    w: 5.0,
    h: H,
    fill: { color: TEAMS_PURPLE },
    line: { type: "none" },
  });
  // Subtle darker overlay block for depth
  s.addShape("rect", {
    x: 0,
    y: H - 2.0,
    w: 5.0,
    h: 2.0,
    fill: { color: TEAMS_PURPLE_DARK },
    line: { type: "none" },
  });

  // Teams hex motif on the right (concentric arcs as memory motif)
  s.addShape("ellipse", {
    x: 8.5,
    y: 1.0,
    w: 5.0,
    h: 5.0,
    fill: { color: TEAMS_PURPLE_LIGHT },
    line: { type: "none" },
  });
  s.addShape("ellipse", {
    x: 9.5,
    y: 2.0,
    w: 3.5,
    h: 3.5,
    fill: { color: WHITE },
    line: { color: TEAMS_PURPLE, width: 2 },
  });
  s.addShape("ellipse", {
    x: 10.5,
    y: 3.0,
    w: 1.5,
    h: 1.5,
    fill: { color: TEAMS_PURPLE },
    line: { type: "none" },
  });

  // Eyebrow
  s.addText("LOBSTER REVIEW · MEMORY", {
    x: 0.7,
    y: 1.2,
    w: 4.0,
    h: 0.4,
    fontFace: FONT,
    fontSize: 11,
    color: WHITE,
    bold: true,
    charSpacing: 4,
  });

  // Title
  s.addText("Memory for\nLobster on Teams", {
    x: 0.7,
    y: 1.8,
    w: 4.5,
    h: 2.4,
    fontFace: FONT,
    fontSize: 40,
    color: WHITE,
    bold: true,
    lineSpacingMultiple: 1.05,
  });

  // Subtitle
  s.addText("The plan, the hard problem,\nand how we'll measure it", {
    x: 0.7,
    y: 4.3,
    w: 4.5,
    h: 1.0,
    fontFace: FONT,
    fontSize: 18,
    color: WHITE,
    italic: true,
    lineSpacingMultiple: 1.2,
  });

  // Author block
  s.addText(
    [
      { text: "Steve Ickman", options: { fontSize: 14, bold: true, color: WHITE } },
      { text: "\nTeams Engineering", options: { fontSize: 12, color: WHITE } },
      { text: "\nMay 19, 2026", options: { fontSize: 12, color: WHITE } },
    ],
    {
      x: 0.7,
      y: H - 1.5,
      w: 4.0,
      h: 1.0,
      fontFace: FONT,
      lineSpacingMultiple: 1.3,
    },
  );

  // No footer on title slide — looks cleaner
}

// ---- Slide 2: The Plan -----------------------------------------------------
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };

  // Eyebrow + title bar
  s.addShape("rect", {
    x: 0,
    y: 0,
    w: 0.25,
    h: H - 0.3,
    fill: { color: TEAMS_PURPLE },
    line: { type: "none" },
  });
  s.addText("THE PLAN", {
    x: 0.6,
    y: 0.4,
    w: 5,
    h: 0.3,
    fontFace: FONT,
    fontSize: 10,
    color: TEAMS_PURPLE,
    bold: true,
    charSpacing: 4,
  });
  s.addText("LokiMemora: a brain-agnostic memory layer,\nbehind the Teams Connector", {
    x: 0.6,
    y: 0.7,
    w: 12.5,
    h: 1.2,
    fontFace: FONT,
    fontSize: 24,
    color: INK,
    bold: true,
    lineSpacingMultiple: 1.1,
  });

  // Left column: bullets
  const bullets = [
    {
      lead: "Where it sits",
      body: "In Aether, outside the OpenClaw container, behind the new Teams Connector we're building.",
    },
    {
      lead: "What it is",
      body: "Evolution of ClawPilot's Loki + Memora (MS Research, SoTA on memory benchmarks).",
    },
    {
      lead: "Brain-agnostic",
      body: "Memories survive when the brain swaps (OpenClaw → Hermes → next thing). User never loses context.",
    },
    {
      lead: "Surface-agnostic",
      body: "Same memories follow the user across ClawPilot, Teams, Outlook, Office comments.",
    },
    {
      lead: "Teams-first ask",
      body: "Every Teams user gets a personal EA-style agent — 1:1 and in group chats — same memory store.",
    },
  ];

  let by = 2.2;
  for (const b of bullets) {
    s.addShape("ellipse", {
      x: 0.7,
      y: by + 0.12,
      w: 0.15,
      h: 0.15,
      fill: { color: TEAMS_PURPLE },
      line: { type: "none" },
    });
    s.addText(
      [
        { text: b.lead + ": ", options: { bold: true, color: INK } },
        { text: b.body, options: { color: SLATE } },
      ],
      {
        x: 1.0,
        y: by,
        w: 6.4,
        h: 0.85,
        fontFace: FONT,
        fontSize: 13,
        valign: "top",
        lineSpacingMultiple: 1.2,
      },
    );
    by += 0.85;
  }

  // Right column: architecture diagram (boxes)
  const dx = 8.2;
  const dy = 2.2;
  const dw = 4.6;
  const boxH = 0.85;
  const boxes = [
    { label: "Teams\n(1:1 + group chats)", fill: TEAMS_PURPLE_LIGHT, color: INK },
    { label: "Teams Connector\n(in Aether)", fill: TEAMS_PURPLE_LIGHT, color: INK },
    { label: "LokiMemora\n(memory layer)", fill: TEAMS_PURPLE, color: WHITE, bold: true },
    { label: "OpenClaw  (brain)\n— or Hermes, or next —", fill: TEAMS_PURPLE_LIGHT, color: INK },
  ];

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const y = dy + i * (boxH + 0.35);
    s.addShape("roundRect", {
      x: dx,
      y,
      w: dw,
      h: boxH,
      fill: { color: b.fill },
      line: { color: TEAMS_PURPLE_DARK, width: 1 },
      rectRadius: 0.08,
    });
    s.addText(b.label, {
      x: dx,
      y,
      w: dw,
      h: boxH,
      fontFace: FONT,
      fontSize: 13,
      color: b.color,
      align: "center",
      valign: "middle",
      bold: !!b.bold,
      lineSpacingMultiple: 1.1,
    });
    if (i < boxes.length - 1) {
      // Arrow between boxes
      const ay = y + boxH;
      s.addShape("rect", {
        x: dx + dw / 2 - 0.025,
        y: ay,
        w: 0.05,
        h: 0.25,
        fill: { color: TEAMS_PURPLE_DARK },
        line: { type: "none" },
      });
      s.addShape("triangle", {
        x: dx + dw / 2 - 0.12,
        y: ay + 0.2,
        w: 0.24,
        h: 0.18,
        fill: { color: TEAMS_PURPLE_DARK },
        line: { type: "none" },
        rotate: 180,
      });
    }
  }

  s.addText(
    "Every Teams user is about to get their own personal EA agent. The memory layer is what makes it actually feel personal. Here's the plan in three slides.",
    { x: 0, y: 0, w: 0, h: 0 } /* fallback */,
  );
  // Speaker notes
  s.addNotes(
    "We're not inventing the memory engine — LokiMemora extends what ClawPilot already runs in production. The thing we are doing on the Teams side is putting it behind the Teams Connector so it's brain-independent. If we swap OpenClaw for Hermes next quarter, no user loses memory. Same if a user moves from ClawPilot to Teams.",
  );

  addFooter(s, 2);
}

// ---- Slide 3: The Hard Problem --------------------------------------------
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };

  s.addShape("rect", {
    x: 0,
    y: 0,
    w: 0.25,
    h: H - 0.3,
    fill: { color: TEAMS_PURPLE },
    line: { type: "none" },
  });
  s.addText("THE HARD PROBLEM", {
    x: 0.6,
    y: 0.4,
    w: 5,
    h: 0.3,
    fontFace: FONT,
    fontSize: 10,
    color: TEAMS_PURPLE,
    bold: true,
    charSpacing: 4,
  });
  s.addText("No memory system today handles groups safely —\nthat's our biggest unknown", {
    x: 0.6,
    y: 0.7,
    w: 12.5,
    h: 1.2,
    fontFace: FONT,
    fontSize: 24,
    color: INK,
    bold: true,
    lineSpacingMultiple: 1.1,
  });

  // Problem statement
  const problems = [
    "Every memory system built so far — including LokiMemora — is designed for 1:1 conversations.",
    "In Teams, agents live in many chats at once: SLT, AMA, project rooms, customer threads.",
    "Risk: Satya's agent in the SLT chat leaks information into the company-wide AMA chat. Confidentiality dies the first time it happens.",
  ];
  let py = 2.2;
  for (const p of problems) {
    s.addShape("ellipse", {
      x: 0.7,
      y: py + 0.13,
      w: 0.13,
      h: 0.13,
      fill: { color: TEAMS_PURPLE },
      line: { type: "none" },
    });
    s.addText(p, {
      x: 1.0,
      y: py,
      w: 11.5,
      h: 0.7,
      fontFace: FONT,
      fontSize: 14,
      color: SLATE,
      valign: "top",
      lineSpacingMultiple: 1.25,
    });
    py += 0.7;
  }

  // Solution callout — purple-bordered box
  const cy = 4.6;
  const ch = 2.3;
  s.addShape("roundRect", {
    x: 0.7,
    y: cy,
    w: W - 1.4,
    h: ch,
    fill: { color: TEAMS_PURPLE_LIGHT },
    line: { color: TEAMS_PURPLE, width: 2 },
    rectRadius: 0.12,
  });

  s.addText("Group Memory Orchestrator", {
    x: 1.0,
    y: cy + 0.15,
    w: 11.5,
    h: 0.45,
    fontFace: FONT,
    fontSize: 17,
    color: TEAMS_PURPLE_DARK,
    bold: true,
  });
  s.addText("A layer above LokiMemora in Aether", {
    x: 1.0,
    y: cy + 0.6,
    w: 11.5,
    h: 0.3,
    fontFace: FONT,
    fontSize: 12,
    color: SLATE,
    italic: true,
  });

  const solutionBullets = [
    "Each conversation's memories stored in a separate silo",
    "At retrieval, all silos queried in parallel",
    "Cross-silo memories must pass a policy gate: sensitivity labels + a model-driven disclosure check",
    "Detailed design in flight. Heuristics paper drafted.",
  ];
  let sy = cy + 1.0;
  for (const b of solutionBullets) {
    s.addText("•", {
      x: 1.0,
      y: sy,
      w: 0.3,
      h: 0.3,
      fontFace: FONT,
      fontSize: 14,
      color: TEAMS_PURPLE,
      bold: true,
    });
    s.addText(b, {
      x: 1.3,
      y: sy,
      w: 11.0,
      h: 0.3,
      fontFace: FONT,
      fontSize: 13,
      color: INK,
      valign: "top",
    });
    sy += 0.3;
  }

  s.addNotes(
    "This is the one piece I can't point at someone else's work for. Every memory system in the industry assumes 1:1. Teams isn't 1:1. So we're inserting an orchestrator above LokiMemora that silos memory per conversation and runs a policy gate before any cross-silo recall can leave. I have a heuristics paper drafted; detailed design is the next month.",
  );

  addFooter(s, 3);
}

// ---- Slide 4: Validation ---------------------------------------------------
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };

  s.addShape("rect", {
    x: 0,
    y: 0,
    w: 0.25,
    h: H - 0.3,
    fill: { color: TEAMS_PURPLE },
    line: { type: "none" },
  });
  s.addText("VALIDATION", {
    x: 0.6,
    y: 0.4,
    w: 5,
    h: 0.3,
    fontFace: FONT,
    fontSize: 10,
    color: TEAMS_PURPLE,
    bold: true,
    charSpacing: 4,
  });
  s.addText("Recall Bench: measuring memory before users do", {
    x: 0.6,
    y: 0.7,
    w: 12.5,
    h: 1.0,
    fontFace: FONT,
    fontSize: 24,
    color: INK,
    bold: true,
  });

  // Left column bullets
  const bullets = [
    {
      lead: "Internal benchmark I built",
      body: "10 dimensions including factual recall, temporal reasoning, information disclosure.",
    },
    {
      lead: "EA persona, 180-day corpus",
      body: "Closest analog to how Teams users will actually use Lobster.",
    },
    {
      lead: "OpenClaw baseline",
      body: "~91% composite. Strong overall, but weak on time-ordered fact retrieval.",
    },
    {
      lead: "Group / disclosure disabled",
      body: "OpenClaw doesn't support yet — would have been red across the board.",
    },
  ];
  let by = 2.0;
  for (const b of bullets) {
    s.addShape("ellipse", {
      x: 0.7,
      y: by + 0.12,
      w: 0.13,
      h: 0.13,
      fill: { color: TEAMS_PURPLE },
      line: { type: "none" },
    });
    s.addText(
      [
        { text: b.lead + ": ", options: { bold: true, color: INK } },
        { text: b.body, options: { color: SLATE } },
      ],
      {
        x: 1.0,
        y: by,
        w: 6.0,
        h: 0.7,
        fontFace: FONT,
        fontSize: 13,
        valign: "top",
        lineSpacingMultiple: 1.2,
      },
    );
    by += 0.75;
  }

  // "Next week" callout
  const ncy = 5.2;
  s.addShape("roundRect", {
    x: 0.7,
    y: ncy,
    w: 6.5,
    h: 1.65,
    fill: { color: TEAMS_PURPLE_LIGHT },
    line: { color: TEAMS_PURPLE, width: 1.5 },
    rectRadius: 0.1,
  });
  s.addText("Next week", {
    x: 0.95,
    y: ncy + 0.12,
    w: 6.0,
    h: 0.3,
    fontFace: FONT,
    fontSize: 12,
    color: TEAMS_PURPLE_DARK,
    bold: true,
    charSpacing: 2,
  });
  const nextItems = [
    "500-day corpus with personal/work boundary scenarios baked in",
    "LokiMemora baseline run — first apples-to-apples comparison",
    "First measurement of the Group Memory Orchestrator policy gate",
  ];
  let ny = ncy + 0.45;
  for (const it of nextItems) {
    s.addText("•", {
      x: 0.95,
      y: ny,
      w: 0.2,
      h: 0.3,
      fontFace: FONT,
      fontSize: 12,
      color: TEAMS_PURPLE,
      bold: true,
    });
    s.addText(it, {
      x: 1.15,
      y: ny,
      w: 6.0,
      h: 0.3,
      fontFace: FONT,
      fontSize: 12,
      color: INK,
      valign: "top",
    });
    ny += 0.35;
  }

  // Right side: the heatmap
  s.addImage({
    path: HEATMAP_PATH,
    x: 7.6,
    y: 2.0,
    w: 5.5,
    h: 4.85,
    sizing: { type: "contain", w: 5.5, h: 4.85 },
  });
  s.addText("OpenClaw · 30 checkpoints · 180-day EA corpus", {
    x: 7.6,
    y: 6.85,
    w: 5.5,
    h: 0.25,
    fontFace: FONT,
    fontSize: 9,
    color: MUTED,
    italic: true,
    align: "center",
  });

  s.addNotes(
    "I'm not relying on vibes — every piece of this plan has a measurable axis on Recall Bench. The OpenClaw baseline is already in: it's strong, but you can see the time-ordered retrieval is weaker. Next week I'll have LokiMemora on the same chart, plus the first numbers on whether the orchestrator's policy gate actually holds the boundary.",
  );

  addFooter(s, 4);
}

await pptx.writeFile({ fileName: OUT_PATH });
console.log(`Wrote ${OUT_PATH}`);
