---
title: Prompts
layout: default
parent: Recall Memory System
nav_order: 4
has_children: true
---

# Prompts

The LLM prompts that drive Recall's compaction, dreaming, query expansion, typed-memory extraction, and wisdom distillation passes.

| Prompt | Drives |
|---|---|
| [Compaction defaults](./compaction-defaults.html) | Shared defaults across compaction passes |
| [Daily → Weekly](./daily-to-weekly.html) | Summarizes a week of daily logs into a weekly summary file |
| [Weekly → Monthly](./weekly-to-monthly.html) | Summarizes a month of weekly summaries into a monthly file |
| [Wisdom distillation](./wisdom-distillation.html) | Periodically consolidates principles into WISDOM.md |
| [Typed memory extraction](./typed-memory-extraction.html) | Pulls structured user/feedback/project/reference memories out of daily logs |
| [Multi-query fusion](./query-expansion.html) | Expands a query into keyword and noun-phrase variants for search |
