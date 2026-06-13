-- Runs once on first boot of the pgvector/pgvector:pg16 container.
-- The application's setup_db.py also ensures these, but creating the
-- extension here means it's ready before the backend connects.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS results;
