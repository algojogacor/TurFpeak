# AGENT.md — Mandatory Instructions for Coding Agents
## Flash Peak TMS

**Read this file before inspecting or modifying the project.**  
This repository is expected to be developed using a multi-agent / swarm workflow.

---

## 0. Mission

Build Flash Peak TMS according to the documentation in this repository. The system is a WhatsApp-first tournament management application. It is not a game bot and must not attempt to control or reverse-engineer the Flash Peak game client.

The backend is authoritative. LLMs are evidence extractors and language interpreters only.

## 1. Mandatory document reading

Before implementation, read in full:
- `README.md`
- `PRD.md`
- `FRD.md`
- `COMPETITION_RULES.md`
- `DECISIONS.md`
- `ARCHITECTURE.md`
- `DATA_MODEL.md`
- `WORKFLOWS.md`
- `AI_PIPELINE.md`
- `PROMPT_CATALOG.md`
- `INFRASTRUCTURE.md`
- `TESTING.md`
- `SWARM_PLAN.md`

If a conflict exists, stop and report it. Do not silently pick a version.

## 2. Baileys documentation and repository — mandatory research gate

Baileys changes over time and has breaking releases. **Do not implement from memory or stale tutorials.**

Before writing WhatsApp integration code:

1. Identify the official/current repository: `https://github.com/WhiskeySockets/Baileys`.
2. Inspect the latest repository state, release tags, changelog, migration guide, current README, TypeScript types, examples, and official guide at `https://baileys.wiki/`.
3. Check the current npm package tags and published version.
4. Check whether the latest version is stable, release candidate, beta, or edge.
5. Read the migration guide for any major version change.
6. If current Baileys documentation is not already available locally, clone the official repository into the project root under:
   `./vendor/baileys-reference/`
   Use a shallow clone for disk efficiency, but record the exact commit SHA and tag inspected. Example:
   `git clone --depth 1 https://github.com/WhiskeySockets/Baileys.git vendor/baileys-reference`
7. Also obtain the current official docs repository/guide if needed. Keep reference materials in `vendor/` or a clearly named reference directory at project root.
8. Treat cloned source/docs as a reference, not as application source. Do not modify the reference clone to make application code compile.
9. Record the research date, commit SHA, tag, package version, stability status, and source links in `docs/BAILEYS_RESEARCH.md`.
10. Pin the chosen dependency version in the lockfile. Do not use a floating dependency in production.
11. If the newest release is a release candidate and the stable release is behind, compare both. Prefer stable for MVP unless a documented required feature/fix justifies the RC and the organizer accepts the risk.
12. Re-check the upstream repository before production release.

Research snapshot available when this package was authored (18 Nov 2026):
- WhiskeySockets repository warns that v7.0.0 introduces breaking changes.
- npm surfaced `7.0.0-rc14` as `latest` and `6.7.24` as `legacy` at research time.
- The new guide `baileys.wiki` was described as a work in progress.
- This snapshot is not a substitute for rechecking at implementation time.
- Sources:
  - https://github.com/WhiskeySockets/Baileys
  - https://github.com/WhiskeySockets/Baileys/releases
  - https://www.npmjs.com/package/@whiskeysockets/baileys
  - https://baileys.wiki/

Baileys is not an official WhatsApp API and is not affiliated with WhatsApp. Respect WhatsApp terms and avoid spam/bulk messaging. The system is intended for a single tournament group and authorized participants.

## 3. General engineering rules

- Use TypeScript unless repository constraints justify otherwise.
- Keep modules small and domain-oriented.
- Validate all external input.
- Use structured logs with correlation IDs.
- Never log secrets, session credentials, or full auth files.
- Use transactions for state transitions that must be atomic.
- Every inbound event handler must be idempotent.
- No business rule may exist only in an LLM prompt.
- Do not use LLM output as SQL or shell commands.
- Never trust file paths supplied by a user or model.
- Preserve raw Unicode nicknames.
- Keep all admin overrides auditable.
- Do not silently change tournament rules.
- Avoid overengineering; the existing VM has limited resources and existing services.

## 4. Database

- Use Turso/libSQL.
- Use `@libsql/client` and evaluate Drizzle ORM compatibility against current versions.
- Migrations are mandatory.
- Use stable internal IDs.
- Keep raw nickname and derived search fields separate.
- Store image metadata/references only; do not put image BLOBs in Turso.
- Store provider credentials and Baileys auth state outside business tables.
- Do not add unnecessary field-level encryption. Protect credentials and sensitive access paths appropriately.

## 5. Verax media reuse — mandatory inspection

Before building image storage:
1. Inspect the local Verax reference project at `D:\Projects\verax` for its architectural pattern (storage tree shape, metadata-sidecar approach, visibility separation).
2. Do NOT inspect or integrate against the live Verax production media service for this purpose — organizer decision (O-011/D-022) requires Flash Peak evidence to live in a fully separate storage instance, never commingled with Verax editorial media.
3. Confirm whether the historical details in `INFRASTRUCTURE.md` §2 (pattern reference only, not live paths) are still representative of the local reference project.
4. Build a new, Flash Peak-dedicated media service/storage instance that follows the Verax pattern structurally (own PM2 process, own storage path, own `media.sqlite`-equivalent) — this is a deliberate duplication, not an error; approval for this separate instance is already granted (O-011).
5. Record the actual endpoint contract and integration in `docs/MEDIA_INTEGRATION.md`.
6. Do not expose private match evidence publicly by default.

Historical reference: `verax-media`, port `4188`, canonical path `/var/lib/verax/media`, metadata DB `media.sqlite`; all must be verified live before use.

## 6. WhatsApp identity handling

- Do not use JID as the canonical database primary key.
- Model a canonical delegate and multiple verified WhatsApp address aliases.
- Inspect current Baileys message key/addressing types for JID/LID and linked-device behavior.
- Store raw observed identifiers and their source.
- Do not assume phone-only operation is required.
- Do not merge aliases without evidence.
- If identity cannot be resolved, deny privileged action and ask organizer to verify.
- One registered delegate per team/division.

## 7. AI architecture and prompt discipline

- Implement provider adapters.
- Check exact model capabilities for image input and structured output.
- Pin model identifiers and record provider/model metadata.
- Use JSON Schema/Zod validation.
- Store prompts in source control and version them.
- Use clear instruction hierarchy and explicit untrusted-input delimiters.
- Include examples only when grounded in actual game screenshots.
- Maintain golden evaluation fixtures.
- Model output must not mutate records directly.
- No auto-approval based only on model confidence.
- Use provider quotas according to current provider terms; never rotate accounts to evade free-tier limits.
- If all capable providers fail, enter manual mode.

## 8. Screenshot and goalkeeper rules

- Main match summary is primary evidence.
- Individual detail is a one-player screen with no nickname/UID in the supplied example.
- Visual goalkeeper cues: cap, gloves, ball held in front of abdomen/chest.
- Summary `DEFENSE` maps to saves per organizer rule.
- Preserve `defense_raw` and `goalkeeper_saves`.
- Do not require all detail tabs to be opened in MVP.
- Link detail to main screen by score/result and unique statistic fingerprint.
- If multiple candidates or no candidate, ask for human confirmation.
- Do not use visual avatar alone as account identity.
- One goalkeeper detail image per game actually played in a BO3/BO5 series is expected from the series-winning team's goalkeeper/delegate after the series ends.

## 9. Five-second debounce

- Implement a five-second sliding quiet window per report session.
- Every new relevant message resets that session's due time to now + 5 seconds.
- Do not use a global timer.
- Persist pending state and make it restart-safe.
- Use idempotency keys.
- Use atomic claim/lease to avoid two workers processing the same batch.
- Late evidence must attach to the correct open session.
- Never assume five seconds means all expected evidence has arrived; completeness checks still apply.

## 10. Draw

- Backend randomizes; LLM never does.
- Use cryptographically secure unbiased shuffle.
- Persist full assignment before first reveal.
- Reveal one team at a time.
- Persist reveal progress after each successful send.
- Resume after restart without rerolling.
- Record input snapshot, algorithm version, commitment/seed handling, result, and overrides.

## 11. Corrections and approvals

- Persist report context; do not rely on model chat memory.
- Correction model returns a typed patch only.
- Backend verifies sender, target report/version, team, player, metric, and value.
- Ask clarification if ambiguous.
- Every correction creates a new report version.
- All prior approvals are invalidated after a correction.
- Official lock requires both team delegates and organizer.

## 12. Manual fallback

- Admin-only command provisional name: `!manualreport`.
- AI outage message must say processing is unavailable and direct delegate to organizer.
- Manual entry uses same validation and approval lifecycle.
- Provenance is `MANUAL_ENTRY`.
- Never fabricate unreadable values.

## 13. Swarm mode coordination

- Follow `SWARM_PLAN.md`.
- One integration lead owns shared architecture and merges.
- Assign exclusive file/module ownership.
- Agents must not concurrently modify shared schema, migrations, core event router, or prompt contracts without coordination.
- Every agent returns: files changed, decisions, tests run, results, known gaps, and commit/patch reference.
- Integrate in dependency order.
- Run full tests after each integration.
- No agent may mark a task complete without evidence.

## 14. Required implementation artifacts

Create/update:
- `docs/BAILEYS_RESEARCH.md`
- `docs/MEDIA_INTEGRATION.md`
- `docs/ARCHITECTURE_DECISIONS.md`
- `docs/OPERATIONS_RUNBOOK.md`
- `.env.example` with placeholder names only
- migrations
- tests and fixtures manifest
- provider capability matrix
- deployment and rollback instructions

## 15. Definition of done

A feature is done only when:
- Requirements traced to FRD IDs.
- Types and validation exist.
- Unit/integration tests pass.
- Failure path tested.
- Logs and audit events exist where required.
- Documentation updated.
- No secrets committed.
- No unresolved TODO hidden as success.

---

## 16. Mandatory Session Worklog Logging (`worklog.md`)

Every agent or developer working in this repository MUST maintain and update `worklog.md` at the root of the project.
Before any working session is considered complete:
1. **Log Every Task/Session**: Record date, session/task ID, and purpose.
2. **Document Concrete Changes**: Detail which files were modified and provide a concise summary of what was changed and why.
3. **Record Empirical Verification**: Include the exact tests or dry-run scripts executed, along with concrete command outputs and evidence of success. Claims of "done" without concrete verification output are invalid.
4. **Report New Bugs/Gaps Promptly**: If unexpected bugs or gaps outside the assigned scope are uncovered, log them explicitly in `worklog.md` with their status (e.g. `REPORTED / PENDING_APPROVAL`) and report them to the project owner before attempting uncoordinated fixes.

