# Automation AI Ingestion Dashboard

Single Node.js app with MongoDB + jQuery dashboard to:
- submit comma-separated URLs into document extractor API one-by-one,
- store each job in MongoDB,
- refresh one or all job statuses,
- maintain global settings (`knowledge_source`, `knowledge_tags`, etc.),
- ask QnA via extractor chat endpoint.

## Stack
- Node.js + Express
- MongoDB + Mongoose
- jQuery + HTML + CSS

## Setup
1. Copy `.env.example` to `.env`.
2. Update MongoDB and endpoint values if needed.
3. Install dependencies:
   - `npm install`
4. Run app:
   - `npm run dev`
   - or `npm start`

Open dashboard at `http://localhost:9001`.

## Main API endpoints
- `POST /api/jobs/ingest` with body `{ "urls": "a.com,b.pdf,c.xlsx" }`
- `GET /api/jobs`
- `POST /api/jobs/:jobId/refresh`
- `POST /api/jobs/refresh-all`
- `POST /api/jobs/:jobId/cancel`
- `POST /api/jobs/cancel-all`
- `GET /api/settings`
- `PUT /api/settings`
- `POST /api/qna` with body `{ "question": "..." }`

## External endpoints used
- Health: `http://16.79.175.142:806/`
- Extract: `http://16.79.175.142:806/api/v1/jobs/extract`
- Status: `http://16.79.175.142:806/api/v1/jobs/{job_id}`
- QnA: `http://16.79.175.142:806/api/v1/chat/qna`
