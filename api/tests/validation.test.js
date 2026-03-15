'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/middleware/validate');

/**
 * Create minimal mock req/res/next for unit-testing middleware.
 */
function createMocks(body) {
  const req = { body };

  let statusCode = 200;
  let jsonBody = null;
  let nextCalled = false;

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      jsonBody = data;
    },
  };

  const next = () => { nextCalled = true; };

  return { req, res, next, getStatus: () => statusCode, getJson: () => jsonBody, wasNextCalled: () => nextCalled };
}

// ---------------------------------------------------------------------------
// validate middleware
// ---------------------------------------------------------------------------
describe('validate middleware', () => {
  const schema = {
    name: { type: 'string', required: true, maxLength: 50 },
    age: { type: 'number', required: false, min: 0, max: 150 },
    code: { type: 'string', required: true, pattern: /^[A-Z]{3}\d{3}$/ },
  };

  it('passes validation with valid data', () => {
    const { req, res, next, wasNextCalled, getStatus } = createMocks({
      name: 'Alice',
      age: 30,
      code: 'ABC123',
    });

    validate(schema)(req, res, next);
    assert.ok(wasNextCalled(), 'next() should be called');
    assert.equal(getStatus(), 200);
  });

  it('fails when required field is missing', () => {
    const { req, res, next, wasNextCalled, getStatus, getJson } = createMocks({
      age: 25,
      code: 'ABC123',
    });

    validate(schema)(req, res, next);
    assert.ok(!wasNextCalled(), 'next() should NOT be called');
    assert.equal(getStatus(), 400);
    assert.ok(getJson().details.some((d) => d.includes('name')));
  });

  it('fails when required field is empty string', () => {
    const { req, res, next, wasNextCalled, getStatus } = createMocks({
      name: '',
      code: 'ABC123',
    });

    validate(schema)(req, res, next);
    assert.ok(!wasNextCalled());
    assert.equal(getStatus(), 400);
  });

  it('fails on type mismatch — string expected, number given', () => {
    const { req, res, next, wasNextCalled, getStatus, getJson } = createMocks({
      name: 12345,
      code: 'ABC123',
    });

    validate(schema)(req, res, next);
    assert.ok(!wasNextCalled());
    assert.equal(getStatus(), 400);
    assert.ok(getJson().details.some((d) => d.includes('string')));
  });

  it('fails on type mismatch — number expected, string given', () => {
    const { req, res, next, wasNextCalled, getStatus } = createMocks({
      name: 'Alice',
      age: 'thirty',
      code: 'ABC123',
    });

    validate(schema)(req, res, next);
    assert.ok(!wasNextCalled());
    assert.equal(getStatus(), 400);
  });

  it('fails when pattern does not match', () => {
    const { req, res, next, wasNextCalled, getStatus, getJson } = createMocks({
      name: 'Alice',
      code: 'abc123', // lowercase not allowed
    });

    validate(schema)(req, res, next);
    assert.ok(!wasNextCalled());
    assert.equal(getStatus(), 400);
    assert.ok(getJson().details.some((d) => d.includes('format')));
  });

  it('fails when number is below min', () => {
    const { req, res, next, wasNextCalled, getStatus } = createMocks({
      name: 'Alice',
      age: -5,
      code: 'ABC123',
    });

    validate(schema)(req, res, next);
    assert.ok(!wasNextCalled());
    assert.equal(getStatus(), 400);
  });

  it('fails when number exceeds max', () => {
    const { req, res, next, wasNextCalled, getStatus } = createMocks({
      name: 'Alice',
      age: 200,
      code: 'ABC123',
    });

    validate(schema)(req, res, next);
    assert.ok(!wasNextCalled());
    assert.equal(getStatus(), 400);
  });

  it('skips optional fields when absent', () => {
    const { req, res, next, wasNextCalled, getStatus } = createMocks({
      name: 'Bob',
      code: 'XYZ789',
      // age is optional — omitted
    });

    validate(schema)(req, res, next);
    assert.ok(wasNextCalled(), 'Should pass when optional fields are absent');
    assert.equal(getStatus(), 200);
  });

  it('collects multiple errors at once', () => {
    const { req, res, next, getJson, getStatus } = createMocks({
      // missing name (required), missing code (required)
    });

    validate(schema)(req, res, next);
    assert.equal(getStatus(), 400);
    assert.ok(getJson().details.length >= 2, 'Should report multiple errors');
  });
});
