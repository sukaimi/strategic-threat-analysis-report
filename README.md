# STAR -- Strategic Threat Analysis Report

AI-native maritime and airspace intelligence platform for monitoring strategic waterways.

## Theaters

- **MERLION** -- Singapore Strait
- **DJINN** -- Strait of Hormuz

## Features

- Real-time AIS vessel tracking (AISStream WebSocket)
- ADS-B flight monitoring (adsb.fi)
- Multi-provider AI threat analysis (DeepSeek, Gemini, Ollama)
- 15+ automated anomaly detection checks
- Sanctions screening (OFAC SDN, OpenSanctions)
- OSINT intelligence aggregation (CENTCOM, Dryad, GDELT, ACLED)
- Cross-theater vessel transit correlation
- PDF SITREP export
- Real-time WebSocket dashboard

## Tech Stack

- **Backend**: Node.js, Express, better-sqlite3
- **Frontend**: Next.js 14, React-Leaflet, Tailwind CSS
- **AI**: DeepSeek V3, Gemini 2.0 Flash, Ollama (circuit-breaker pattern)
- **Data**: SQLite with 72-hour rolling retention

## Quick Start

```bash
cp .env.example .env
# Edit .env with your API keys
npm install
cd frontend && npm install && cd ..
npm run dev:api    # API on :3001
npm run dev:frontend  # Frontend on :3000
```

## License

MIT
