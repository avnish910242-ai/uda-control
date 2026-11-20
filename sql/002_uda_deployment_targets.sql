BEGIN;

CREATE TABLE IF NOT EXISTS uda_deployment_targets (
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    repository_name TEXT NOT NULL CHECK (repository_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
    branch_ref TEXT NOT NULL CHECK (branch_ref ~ '^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$'),
    installation_id BIGINT NOT NULL CHECK (installation_id > 0),
    target_status TEXT NOT NULL CHECK (target_status IN ('provisioning', 'active', 'failed')),
    render_owner_id TEXT NOT NULL CHECK (render_owner_id ~ '^tea-[a-z0-9]+$'),
    render_service_name TEXT NOT NULL CHECK (render_service_name ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    render_service_id TEXT,
    live_url TEXT,
    runtime_profile TEXT NOT NULL CHECK (runtime_profile IN ('node-npm')),
    build_command TEXT NOT NULL CHECK (length(build_command) BETWEEN 1 AND 512),
    start_command TEXT NOT NULL CHECK (length(start_command) BETWEEN 1 AND 256),
    approval_id UUID NOT NULL UNIQUE,
    approved_at TIMESTAMPTZ NOT NULL,
    activated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (repository_id, branch_ref),
    UNIQUE (render_owner_id, render_service_name),
    UNIQUE (render_service_id),
    CHECK (target_status <> 'active' OR (render_service_id IS NOT NULL AND live_url LIKE 'https://%' AND activated_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS uda_deployment_targets_active_idx
    ON uda_deployment_targets (repository_id, branch_ref)
    WHERE target_status = 'active';

COMMIT;
