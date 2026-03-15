'use strict';

const fs = require('fs');
const path = require('path');

const VAULT_ROOT = path.resolve(__dirname, '..', 'vault', 'star-merlion');

const directories = [
  'analyses',
  'incidents',
  'vessels',
  'patterns',
  'daily-summaries',
  'weekly-summaries',
  'archive',
];

console.log('[init-vault] Creating vault directory structure...');

for (const dir of directories) {
  const fullPath = path.join(VAULT_ROOT, dir);
  fs.mkdirSync(fullPath, { recursive: true });
  console.log(`[init-vault] Created: ${fullPath}`);
}

// --- SPECTRE-INDEX.md ---
const indexPath = path.join(VAULT_ROOT, 'SPECTRE-INDEX.md');
if (!fs.existsSync(indexPath)) {
  fs.writeFileSync(indexPath, `# SPECTRE Intelligence Vault Index

## Purpose
Central index for all maritime and airspace intelligence artefacts produced by
the STAR MERLION platform.

## Structure
- **analyses/** — AI-generated composite threat analyses
- **incidents/** — Individual incident reports
- **vessels/** — Vessel profile and tracking notes
- **patterns/** — Baseline traffic patterns and anomaly references
- **daily-summaries/** — End-of-day operational summaries
- **weekly-summaries/** — Weekly strategic roll-ups
- **archive/** — Aged-off records retained for trend analysis

## Conventions
- File names use ISO-8601 dates: \`YYYY-MM-DD-<slug>.md\`
- Each file begins with a YAML front-matter block
- Tags: \`#critical\`, \`#high\`, \`#medium\`, \`#low\`, \`#pattern\`, \`#vessel\`, \`#airspace\`
`);
  console.log('[init-vault] Created: SPECTRE-INDEX.md');
}

// --- AGENTS.md ---
const agentsPath = path.join(VAULT_ROOT, 'AGENTS.md');
if (!fs.existsSync(agentsPath)) {
  fs.writeFileSync(agentsPath, `# AI Agent Conventions — STAR MERLION Vault

## File Authoring
- Always include YAML front-matter with \`date\`, \`type\`, \`severity\`, and \`tags\`.
- Keep prose concise and factual — no speculative language without explicit caveats.
- Reference MMSI or callsign identifiers inline where applicable.

## Analysis Notes
- Composite threat scores are on a 0-100 scale.
- When citing AIS data, include the \`recorded_at\` timestamp.
- Cross-reference related vault files using \`[[wikilink]]\` syntax.

## Retention
- Daily summaries are auto-generated; do not manually edit.
- Weekly summaries may be annotated by human operators.
- Archive files are read-only after migration.
`);
  console.log('[init-vault] Created: AGENTS.md');
}

// --- Baseline pattern files ---
const patterns = {
  'malacca-baseline.md': `---
date: 2026-03-11
type: pattern
region: Malacca Strait
tags: [pattern, baseline, malacca]
---

# Malacca Strait — Baseline Traffic Pattern

Placeholder for baseline vessel traffic density, typical transit times,
and seasonal variation notes for the Strait of Malacca.
`,
  'scs-activity.md': `---
date: 2026-03-11
type: pattern
region: South China Sea
tags: [pattern, baseline, scs]
---

# South China Sea — Activity Pattern

Placeholder for South China Sea activity patterns, including military
exercise zones, fishing fleet movements, and commercial shipping lanes.
`,
  'changi-fir.md': `---
date: 2026-03-11
type: pattern
region: Changi FIR
tags: [pattern, baseline, airspace, changi]
---

# Changi FIR — Airspace Baseline

Placeholder for Changi Flight Information Region baseline patterns,
including typical flight volumes, military activity corridors,
and weather-related diversions.
`,
  'psa-port.md': `---
date: 2026-03-11
type: pattern
region: PSA Singapore
tags: [pattern, baseline, port, psa]
---

# PSA Port Singapore — Operational Baseline

Placeholder for PSA port operational baselines, including average berth
utilisation, vessel queue lengths, and channel flow percentages.
`,
};

const patternsDir = path.join(VAULT_ROOT, 'patterns');
for (const [filename, content] of Object.entries(patterns)) {
  const filePath = path.join(patternsDir, filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
    console.log(`[init-vault] Created: patterns/${filename}`);
  }
}

console.log('[init-vault] Vault initialisation complete.');
process.exit(0);
