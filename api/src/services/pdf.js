'use strict';

const PDFDocument = require('pdfkit');

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date as a military Date-Time Group (DDHHMMZMmmYYYY).
 */
function formatDTG(date) {
  const d = date || new Date();
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const mon = months[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  return `${dd}${hh}${mm}Z ${mon} ${yyyy}`;
}

function threatLevel(score) {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 30) return 'ELEVATED';
  return 'LOW';
}

// ---------------------------------------------------------------------------
// Draw helpers
// ---------------------------------------------------------------------------

function drawHorizontalRule(doc) {
  const y = doc.y;
  doc.moveTo(doc.page.margins.left, y)
     .lineTo(doc.page.width - doc.page.margins.right, y)
     .strokeColor('#333333')
     .lineWidth(0.5)
     .stroke();
  doc.moveDown(0.3);
}

function sectionHeading(doc, number, title) {
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(11)
     .fillColor('#1a1a1a')
     .text(`${number}. ${title.toUpperCase()}`);
  doc.moveDown(0.2);
  drawHorizontalRule(doc);
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Generate a military-format SITREP PDF.
 * @param {object} data
 * @param {object} data.analysis    — latest AI analysis row
 * @param {object[]} data.alerts    — active (unacknowledged) alerts
 * @param {number} data.vesselCount
 * @param {number} data.flightCount
 * @param {object|null} data.weather
 * @returns {PDFDocument} — a readable stream (call .end() after piping)
 */
function generateSITREP(data) {
  const { analysis, alerts, vesselCount, flightCount, weather } = data;

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    info: {
      Title: 'STAR MERLION SITREP',
      Author: 'STAR MERLION Automated Analysis System',
    },
  });

  const now = new Date();
  const dtg = formatDTG(now);

  // Parse threat_json if available
  let threatData = {};
  if (analysis && analysis.threat_json) {
    try {
      threatData = typeof analysis.threat_json === 'string'
        ? JSON.parse(analysis.threat_json)
        : analysis.threat_json;
    } catch (_) { /* ignore */ }
  }

  const compositeScore = analysis?.composite_score ?? threatData.composite_score ?? 0;
  const level = threatData.threat_level || threatLevel(compositeScore);
  const tacticalBrief = analysis?.tactical_brief || threatData.tactical_brief || 'No tactical brief available.';

  // -----------------------------------------------------------------------
  // Classification banner
  // -----------------------------------------------------------------------
  doc.rect(0, 0, doc.page.width, 28).fill('#c0392b');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff')
     .text('RESTRICTED', 0, 8, { align: 'center', width: doc.page.width });

  // -----------------------------------------------------------------------
  // Header
  // -----------------------------------------------------------------------
  doc.moveDown(1.5);
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a1a1a')
     .text('STAR MERLION', { align: 'center' });
  doc.font('Helvetica').fontSize(12).fillColor('#333333')
     .text('SITUATION REPORT (SITREP)', { align: 'center' });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9).fillColor('#555555')
     .text(`DTG: ${dtg}`, { align: 'center' });
  doc.moveDown(0.3);
  drawHorizontalRule(doc);

  // -----------------------------------------------------------------------
  // Section 1 — Threat Summary
  // -----------------------------------------------------------------------
  sectionHeading(doc, 1, 'Threat Summary');

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a')
     .text(`Composite Threat Score: ${Math.round(compositeScore)} / 100`);
  doc.font('Helvetica-Bold').fontSize(10)
     .fillColor(compositeScore >= 60 ? '#c0392b' : compositeScore >= 30 ? '#d4580a' : '#27ae60')
     .text(`Threat Level: ${level}`);
  doc.moveDown(0.4);

  doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a')
     .text('Tactical Brief:', { underline: true });
  doc.font('Helvetica').fontSize(9).fillColor('#333333')
     .text(tacticalBrief, { lineGap: 2 });

  // -----------------------------------------------------------------------
  // Section 2 — Category Scores
  // -----------------------------------------------------------------------
  const categories = threatData.categories || threatData.category_scores || null;
  if (categories) {
    sectionHeading(doc, 2, 'Category Scores');

    const entries = Array.isArray(categories)
      ? categories
      : Object.entries(categories).map(([k, v]) => ({
          category: k,
          score: typeof v === 'object' ? v.score : v,
          detail: typeof v === 'object' ? v.detail : undefined,
        }));

    // Table header
    const colX = doc.page.margins.left;
    const colW1 = 260;
    const colW2 = 80;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a1a');
    doc.text('Category', colX, doc.y, { width: colW1, continued: false });

    for (const entry of entries) {
      const name = entry.category || entry.name || 'Unknown';
      const score = entry.score ?? 0;
      const detail = entry.detail || '';
      doc.font('Helvetica').fontSize(9).fillColor('#333333');
      const line = `  ${name}: ${Math.round(score)}/100${detail ? ' — ' + detail : ''}`;
      doc.text(line, { lineGap: 1 });
    }
  }

  // -----------------------------------------------------------------------
  // Section 3 — Key Findings
  // -----------------------------------------------------------------------
  const findings = threatData.key_findings || threatData.findings || threatData.key_observations || [];
  sectionHeading(doc, 3, 'Key Findings');

  if (findings.length === 0) {
    doc.font('Helvetica').fontSize(9).fillColor('#555555')
       .text('No key findings reported in the current analysis cycle.');
  } else {
    for (const finding of findings) {
      const text = typeof finding === 'string' ? finding : finding.description || finding.text || JSON.stringify(finding);
      doc.font('Helvetica').fontSize(9).fillColor('#333333')
         .text(`  - ${text}`, { lineGap: 2 });
    }
  }

  // -----------------------------------------------------------------------
  // Section 4 — Active Alerts
  // -----------------------------------------------------------------------
  sectionHeading(doc, 4, 'Active Alerts');

  if (!alerts || alerts.length === 0) {
    doc.font('Helvetica').fontSize(9).fillColor('#555555')
       .text('No active (unacknowledged) alerts.');
  } else {
    // Table header
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#1a1a1a');
    const aX = doc.page.margins.left;
    const alertY = doc.y;
    doc.text('SEV', aX, alertY, { width: 60 });
    doc.text('TITLE', aX + 65, alertY, { width: 280 });
    doc.text('TIME', aX + 350, alertY, { width: 100 });
    doc.moveDown(0.3);
    drawHorizontalRule(doc);

    const maxAlerts = Math.min(alerts.length, 25);
    for (let i = 0; i < maxAlerts; i++) {
      const a = alerts[i];
      const rowY = doc.y;

      // Check if we need a new page
      if (rowY > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage();
      }

      const sevColor = { CRITICAL: '#c0392b', HIGH: '#d4580a', MEDIUM: '#b8860b', LOW: '#27ae60' };
      doc.font('Helvetica-Bold').fontSize(8)
         .fillColor(sevColor[a.severity] || '#333333')
         .text(a.severity || '-', aX, doc.y, { width: 60 });
      const ly = doc.y - doc.currentLineHeight();
      doc.font('Helvetica').fontSize(8).fillColor('#333333')
         .text(a.title || 'Untitled', aX + 65, ly, { width: 280 });
      doc.text(a.created_at || '-', aX + 350, ly, { width: 100 });
      doc.moveDown(0.15);
    }

    if (alerts.length > 25) {
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(8).fillColor('#555555')
         .text(`... and ${alerts.length - 25} additional alerts.`);
    }
  }

  // -----------------------------------------------------------------------
  // Section 5 — Force Disposition
  // -----------------------------------------------------------------------
  sectionHeading(doc, 5, 'Force Disposition');

  doc.font('Helvetica').fontSize(9).fillColor('#333333');
  doc.text(`  Tracked Vessels:  ${vesselCount ?? 0}`);
  doc.text(`  Tracked Flights:  ${flightCount ?? 0}`);

  if (weather) {
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a1a')
       .text('  Weather Conditions:');
    doc.font('Helvetica').fontSize(9).fillColor('#333333');
    if (weather.wind_speed_kt != null) doc.text(`    Wind: ${weather.wind_speed_kt} kt, ${weather.wind_dir ?? '-'}deg`);
    if (weather.visibility_km != null) doc.text(`    Visibility: ${weather.visibility_km} km`);
    if (weather.sea_state) doc.text(`    Sea State: ${weather.sea_state}`);
    if (weather.cb_cells != null) doc.text(`    CB Cells: ${weather.cb_cells}`);
  }

  // -----------------------------------------------------------------------
  // Footer
  // -----------------------------------------------------------------------
  const footerY = doc.page.height - doc.page.margins.bottom - 30;
  if (doc.y < footerY) {
    doc.y = footerY;
  }
  doc.moveDown(1);
  drawHorizontalRule(doc);
  doc.font('Helvetica').fontSize(7).fillColor('#888888')
     .text('Generated by STAR MERLION Automated Analysis System', { align: 'center' });
  doc.font('Helvetica').fontSize(7).fillColor('#888888')
     .text(`Report timestamp: ${now.toISOString()}`, { align: 'center' });

  // Classification footer banner
  const bottomBannerY = doc.page.height - 28;
  doc.rect(0, bottomBannerY, doc.page.width, 28).fill('#c0392b');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff')
     .text('RESTRICTED', 0, bottomBannerY + 8, { align: 'center', width: doc.page.width });

  doc.end();
  return doc;
}

module.exports = { generateSITREP };
