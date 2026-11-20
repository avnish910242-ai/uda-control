BEGIN;

CREATE TABLE IF NOT EXISTS uda_deployment_jobs (
    job_id UUID PRIMARY KEY,
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    repository_name TEXT NOT NULL CHECK (repository_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
    branch_ref TEXT NOT NULL CHECK (branch_ref ~ '^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$'),
    commit_sha VARCHAR(64) NOT NULL CHECK (
        commit_sha ~ '^([0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$'
        AND commit_sha !~ '^0+$'
    ),
    job_status TEXT NOT NULL DEFAULT 'queued' CHECK (
        job_status IN ('queued', 'processing', 'needs_reconciliation', 'succeeded', 'failed')
    ),
    execution_stage TEXT NOT NULL DEFAULT 'queued' CHECK (
        execution_stage IN ('queued', 'triggering', 'polling', 'verifying', 'reporting', 'reconciling', 'complete', 'failed')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    worker_id TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    render_deploy_id TEXT,
    last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (repository_id, branch_ref, commit_sha),
    CHECK (
        (job_status = 'processing' AND worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR job_status <> 'processing'
    )
);

CREATE TABLE IF NOT EXISTS uda_webhook_deliveries (
    delivery_id UUID PRIMARY KEY,
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    repository_name TEXT NOT NULL CHECK (repository_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
    branch_ref TEXT NOT NULL CHECK (branch_ref ~ '^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$'),
    commit_sha VARCHAR(64) NOT NULL CHECK (
        commit_sha ~ '^([0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$'
        AND commit_sha !~ '^0+$'
    ),
    job_id UUID REFERENCES uda_deployment_jobs(job_id) ON DELETE RESTRICT,
    delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (
        delivery_status IN ('pending', 'queued', 'duplicate_commit')
    ),
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (delivery_status = 'pending' AND job_id IS NULL)
        OR (delivery_status IN ('queued', 'duplicate_commit') AND job_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS uda_deployment_jobs_queue_idx
    ON uda_deployment_jobs (created_at, job_id)
    WHERE job_status = 'queued';

CREATE INDEX IF NOT EXISTS uda_deployment_jobs_expired_lease_idx
    ON uda_deployment_jobs (lease_expires_at, created_at)
    WHERE job_status = 'processing';

CREATE INDEX IF NOT EXISTS uda_webhook_deliveries_job_idx
    ON uda_webhook_deliveries (job_id, received_at);

COMMIT;
