# Corpuscles Cloud Architecture

## Overview

```
┌─────────────────────────────────────────────────────┐
│                    Frontend (React)                  │
│  Vite + TypeScript + Plotly.js                      │
│  Tabbed workflow: Data → KK → DRT → Fitting → Plot  │
│  Client-side Pyodide for instant preview (Tier 1)   │
└────────────────────────┬────────────────────────────┘
                         │ HTTPS / WebSocket
┌────────────────────────┴────────────────────────────┐
│                FastAPI (API + WebSocket)              │
│  Auth, Projects, File upload, Analysis dispatch      │
└───────┬──────────────────┬──────────────┬───────────┘
        │                  │              │
   ┌────┴────┐      ┌─────┴─────┐  ┌─────┴─────┐
   │  Redis  │      │ PostgreSQL│  │Cloudflare  │
   │(Upstash)│      │  (Neon)   │  │    R2      │
   │ Queue + │      │ Projects, │  │   File     │
   │ Pub/Sub │      │ Results,  │  │  Storage   │
   └────┬────┘      │ Users     │  └───────────┘
        │           └───────────┘
   ┌────┴────┐
   │  arq    │
   │ Worker  │
   │         │
   │impedance│
   │pyDRTtools│
   │echem_parse│
   └─────────┘
```

## Two-Tier Analysis

**Tier 1 — Client-side (Pyodide, instant, no account needed):**
- File parsing (galvani for .mpr, custom for .DTA, pandas for CSV)
- Nyquist/Bode plotting
- Basic Randles circuit fit (scipy)
- Simple Tikhonov DRT (scipy)

**Tier 2 — Server-side (FastAPI + arq worker, requires login):**
- Arbitrary circuit fitting via impedance.py `CustomCircuit`
- Kramers-Kronig validation via impedance.py `linKK`
- DRT via pyDRTtools: Tikhonov (cvxopt), Bayesian (MCMC), BHT
- DRT peak analysis
- Batch analysis across multiple datasets

## Stack

| Component | Choice | Why |
|-----------|--------|-----|
| Backend | FastAPI + Uvicorn | Async, Pydantic models match echem_parse API |
| Task queue | arq (Redis-backed) | Simple, asyncio-native, one Redis for queue + pub/sub |
| Database | PostgreSQL (Neon) | JSONB for analysis results, free tier |
| File storage | Cloudflare R2 | S3-compatible, zero egress fees, free tier |
| Cache/queue | Upstash Redis | Serverless Redis, free tier |
| Auth | Supabase Auth or authlib OAuth | GitHub + Google OAuth |
| Deployment | Fly.io | Predictable CPU for numerical workloads, scale-to-zero workers |
| Frontend | React + Vite + Plotly.js | Already built |

## Cost (Research Scale)

| Service | Cost/month |
|---------|-----------|
| Fly.io API (shared-cpu-2x) | $6 |
| Fly.io Worker (performance-1x, auto-stop) | ~$15 |
| Neon PostgreSQL (free tier) | $0 |
| Upstash Redis (free tier) | $0 |
| Cloudflare R2 (free tier) | $0 |
| **Total** | **~$21/month** |

## API Endpoints

```
POST   /api/v1/projects                    # Create project
GET    /api/v1/projects                    # List projects
POST   /api/v1/projects/:id/datasets/upload # Upload file(s)
GET    /api/v1/datasets/:id/data           # Get parsed data
POST   /api/v1/datasets/:id/analyze        # Submit analysis job
GET    /api/v1/datasets/:id/results        # List results
POST   /api/v1/projects/:id/batch-analyze  # Batch analysis
WS     /ws/analysis                        # Real-time progress
```

## Database Schema

```sql
users(id, email, name, created_at)
projects(id, user_id, name, description, created_at)
datasets(id, project_id, filename, file_type, experiment_type, storage_key, metadata JSONB, columns, row_count)
analysis_results(id, dataset_id, analysis_type, parameters JSONB, result JSONB, status, duration_ms)
```

## Real-Time Progress (WebSocket)

```json
// Client subscribes
{"type": "subscribe", "job_id": "uuid"}

// Server sends progress
{"type": "progress", "job_id": "uuid", "percent": 45, "message": "MCMC sampling: 900/2000"}

// Server sends completion
{"type": "complete", "job_id": "uuid", "result_id": "uuid"}
```
