SELECT session_key AS id, version, created_at, cwd, parent_session, seed_length, origin,
       delegation_depth, agent_preset, application_id, tenant_id, user_id, incarnation, revision
FROM sessions;
