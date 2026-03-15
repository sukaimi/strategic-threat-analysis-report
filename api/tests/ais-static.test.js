'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseStaticDataMessage,
  mapShipType,
  AIS_SHIP_TYPE_MAP,
} = require('../src/collectors/ais');

// ---------------------------------------------------------------------------
// mapShipType
// ---------------------------------------------------------------------------
describe('mapShipType', () => {
  it('maps code 30 to Fishing', () => {
    assert.equal(mapShipType(30), 'Fishing');
  });

  it('maps code 70 to Cargo', () => {
    assert.equal(mapShipType(70), 'Cargo');
  });

  it('maps code 80 to Tanker', () => {
    assert.equal(mapShipType(80), 'Tanker');
  });

  it('maps code 60 to Passenger', () => {
    assert.equal(mapShipType(60), 'Passenger');
  });

  it('maps code 52 to Tug', () => {
    assert.equal(mapShipType(52), 'Tug');
  });

  it('returns null for null/undefined', () => {
    assert.equal(mapShipType(null), null);
    assert.equal(mapShipType(undefined), null);
  });

  it('returns null for out-of-range codes', () => {
    assert.equal(mapShipType(-1), null);
    assert.equal(mapShipType(100), null);
  });

  it('maps range 20-29 to Wing in Ground', () => {
    assert.equal(mapShipType(25), 'Wing in Ground');
  });

  it('maps range 90-99 to Other', () => {
    assert.equal(mapShipType(95), 'Other');
  });
});

// ---------------------------------------------------------------------------
// parseStaticDataMessage
// ---------------------------------------------------------------------------
describe('parseStaticDataMessage', () => {
  it('parses ShipStaticData message', () => {
    const msg = {
      MessageType: 'ShipStaticData',
      MetaData: {
        MMSI: 123456789,
        ShipName: '  MV TEST VESSEL  ',
        time_utc: '2024-06-01T12:00:00Z',
      },
      Message: {
        ShipStaticData: {
          Type: 80,
          ImoNumber: 9876543,
          Destination: 'SINGAPORE',
          MaximumStaticDraught: 12.5,
          Dimension: { A: 100, B: 150, C: 20, D: 15 },
          CallSign: 'V7AB3',
        },
      },
    };

    const result = parseStaticDataMessage(msg);
    assert.ok(result);
    assert.equal(result.mmsi, '123456789');
    assert.equal(result.vessel_name, 'MV TEST VESSEL');
    assert.equal(result.vessel_type, 'Tanker');
    assert.equal(result.ais_type_code, 80);
    assert.equal(result.imo_number, '9876543');
    assert.equal(result.destination, 'SINGAPORE');
    assert.equal(result.draught, 12.5);
    assert.equal(result.length, 250); // 100 + 150
    assert.equal(result.breadth, 35);  // 20 + 15
    assert.equal(result.call_sign, 'V7AB3');
  });

  it('parses StaticDataReport message', () => {
    const msg = {
      MessageType: 'StaticDataReport',
      MetaData: { MMSI: 987654321, ShipName: 'CARGO SHIP' },
      Message: {
        StaticDataReport: {
          ShipType: 70,
          ImoNumber: 1234567,
          CallSign: 'ABCD1',
        },
      },
    };

    const result = parseStaticDataMessage(msg);
    assert.ok(result);
    assert.equal(result.mmsi, '987654321');
    assert.equal(result.vessel_type, 'Cargo');
    assert.equal(result.imo_number, '1234567');
  });

  it('returns null for PositionReport messages', () => {
    const msg = {
      MessageType: 'PositionReport',
      MetaData: { MMSI: 111111111 },
      Message: { PositionReport: {} },
    };
    assert.equal(parseStaticDataMessage(msg), null);
  });

  it('returns null for null input', () => {
    assert.equal(parseStaticDataMessage(null), null);
  });

  it('returns null when MMSI is missing', () => {
    const msg = {
      MessageType: 'ShipStaticData',
      MetaData: {},
      Message: { ShipStaticData: { Type: 80 } },
    };
    assert.equal(parseStaticDataMessage(msg), null);
  });

  it('handles missing Dimension gracefully', () => {
    const msg = {
      MessageType: 'ShipStaticData',
      MetaData: { MMSI: 111222333 },
      Message: {
        ShipStaticData: {
          Type: 30,
          Destination: 'PORT KLANG',
        },
      },
    };

    const result = parseStaticDataMessage(msg);
    assert.ok(result);
    assert.equal(result.vessel_type, 'Fishing');
    assert.equal(result.length, null);
    assert.equal(result.breadth, null);
    assert.equal(result.destination, 'PORT KLANG');
  });
});
