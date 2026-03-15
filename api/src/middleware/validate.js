'use strict';

// ---------------------------------------------------------------------------
// Lightweight input-validation middleware — zero external dependencies
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags from a string to prevent XSS.
 */
function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '');
}

/**
 * Trim whitespace and strip HTML from a string value.
 */
function sanitize(value) {
  if (typeof value !== 'string') return value;
  return stripHtml(value.trim());
}

/**
 * Build a validation middleware from a rules object.
 *
 * Each key in `rules` maps to a body field. The value is an object with any of:
 *   required   – boolean
 *   type       – 'string' | 'number'
 *   pattern    – RegExp the string value must match
 *   min        – minimum numeric value (inclusive)
 *   max        – maximum numeric value (inclusive)
 *   maxLength  – max string length
 *   oneOf      – array of allowed values
 *   sanitize   – boolean – trim & strip HTML (default true for strings)
 *
 * Returns Express middleware that validates `req.body` and responds 400 on
 * failure with `{ error: "Validation failed", details: [...] }`.
 */
function validate(rules) {
  return (req, _res, next) => {
    const errors = [];
    const body = req.body || {};

    for (const [field, rule] of Object.entries(rules)) {
      let value = body[field];

      // --- sanitize strings ------------------------------------------------
      if (typeof value === 'string' && rule.sanitize !== false) {
        value = sanitize(value);
        body[field] = value;
      }

      // --- required --------------------------------------------------------
      if (rule.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} is required`);
        continue; // skip further checks for this field
      }

      // If the value is absent and not required, skip remaining checks
      if (value === undefined || value === null || value === '') {
        continue;
      }

      // --- type ------------------------------------------------------------
      if (rule.type === 'number') {
        const num = Number(value);
        if (Number.isNaN(num)) {
          errors.push(`${field} must be a valid number`);
          continue;
        }
        // Use the numeric form for range checks below
        value = num;
        body[field] = num;
      }

      if (rule.type === 'string' && typeof value !== 'string') {
        errors.push(`${field} must be a string`);
        continue;
      }

      // --- pattern ---------------------------------------------------------
      if (rule.pattern && typeof value === 'string' && !rule.pattern.test(value)) {
        errors.push(rule.patternMsg || `${field} has an invalid format`);
        continue;
      }

      // --- numeric range ---------------------------------------------------
      if (rule.min !== undefined && typeof value === 'number' && value < rule.min) {
        errors.push(`${field} must be >= ${rule.min}`);
      }
      if (rule.max !== undefined && typeof value === 'number' && value > rule.max) {
        errors.push(`${field} must be <= ${rule.max}`);
      }

      // --- string length ---------------------------------------------------
      if (rule.maxLength && typeof value === 'string' && value.length > rule.maxLength) {
        errors.push(`${field} must be at most ${rule.maxLength} characters`);
      }

      // --- oneOf -----------------------------------------------------------
      if (rule.oneOf && !rule.oneOf.includes(value)) {
        errors.push(`${field} must be one of: ${rule.oneOf.join(', ')}`);
      }
    }

    if (errors.length > 0) {
      return _res.status(400).json({ error: 'Validation failed', details: errors });
    }

    next();
  };
}

module.exports = { validate, sanitize, stripHtml };
