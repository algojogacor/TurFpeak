/**
 * Flash Peak TMS - Three-Party Approval Engine (Task 5.4)
 * 
 * Manages the authoritative three-party approval lifecycle (FR-APR-001 to FR-APR-004).
 * 
 * Rules:
 * 1. Three-Party Consensus: Requires approval from TEAM_A delegate, TEAM_B delegate,
 *    and ORGANIZER (FR-APR-001).
 * 2. Immutable Binding: Approvals are bound strictly to immutable report_version_id (FR-APR-002).
 * 3. Invalidation: Any new version creates a fresh version with 0 approvals (FR-APR-003).
 * 4. Lock on Full Consensus: When all 3 approve the same version -> transitions to `LOCKED`
 *    and triggers player statistics writing (Task 5.6).
 * 5. Rejection Flow: A rejection transitions report status to `NEEDS_CORRECTION` / `REJECTED`.
 * 6. Organizer Override: Organizer may unilaterally lock, reopen, or override with audit log (FR-APR-004).
 * 7. Immutability: Once `LOCKED`, no new approvals can be submitted unless reopened.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  Approval,
  ApproverType,
  ApprovalDecision,
  ReportVersion,
  ReportVersionStatus,
  UUID,
  ISODateString,
} from '../shared/types/index.js';
import { getReportVersion, updateReportVersionStatus } from './versioning.js';
import { onReportLocked } from './stats.js';

export interface SubmitApprovalInput {
  report_version_id: UUID;
  approver_type: ApproverType;
  approver_id: string; // delegate_id or organizer identifier
  decision: ApprovalDecision; // 'APPROVE' | 'REJECT'
  is_organizer?: boolean;
  rejection_reason?: string;
  correlation_id?: string;
}

export interface ApprovalOutcome {
  report_version_id: UUID;
  status: ReportVersionStatus;
  isLocked: boolean;
  approvals: Approval[];
  missingApprovers: ApproverType[];
  message: string;
}

export interface OrganizerOverrideLockInput {
  report_version_id: UUID;
  organizer_id: string;
  reason: string;
  correlation_id?: string;
}

export interface OrganizerReopenInput {
  report_version_id: UUID;
  organizer_id: string;
  reason: string;
  correlation_id?: string;
}

/**
 * Validates whether the approver has authority for the claimed ApproverType.
 */
async function verifyApproverAuthority(
  db: Client,
  fixtureId: UUID,
  approverType: ApproverType,
  approverId: string,
  isOrganizerExplicit?: boolean
): Promise<{ authorized: boolean; reason?: string }> {
  if (approverType === 'ORGANIZER') {
    if (isOrganizerExplicit || approverId === 'ORGANIZER' || approverId.startsWith('org_') || approverId.includes('organizer')) {
      return { authorized: true };
    }
    return {
      authorized: false,
      reason: `Approver "${approverId}" is not recognized as an authorized tournament organizer.`,
    };
  }

  // Look up fixture and registered delegates
  const res = await db.execute({
    sql: `
      SELECT f.id,
             ta.delegate_id AS delegate_a,
             tb.delegate_id AS delegate_b
      FROM fixtures f
      LEFT JOIN teams ta ON f.team_a_id = ta.id
      LEFT JOIN teams tb ON f.team_b_id = tb.id
      WHERE f.id = ?
    `,
    args: [fixtureId],
  });

  if (res.rows.length === 0) {
    return { authorized: false, reason: `Fixture not found: ${fixtureId}` };
  }

  const row = res.rows[0];
  const delegateA = row[1] ? String(row[1]) : null;
  const delegateB = row[2] ? String(row[2]) : null;

  if (approverType === 'TEAM_A') {
    if (!delegateA || approverId !== delegateA) {
      return {
        authorized: false,
        reason: `Approver "${approverId}" is not the registered delegate for Team A.`,
      };
    }
    return { authorized: true };
  }

  if (approverType === 'TEAM_B') {
    if (!delegateB || approverId !== delegateB) {
      return {
        authorized: false,
        reason: `Approver "${approverId}" is not the registered delegate for Team B.`,
      };
    }
    return { authorized: true };
  }

  return { authorized: false, reason: 'Invalid approver type.' };
}

/**
 * Submits an approval or rejection for a specific immutable report version.
 */
export async function submitReportApproval(
  db: Client,
  input: SubmitApprovalInput
): Promise<ApprovalOutcome> {
  const now: ISODateString = new Date().toISOString();
  const correlationId = input.correlation_id || randomUUID();

  // 1. Fetch report version
  const version = await getReportVersion(db, input.report_version_id);
  if (!version) {
    throw new Error(`Report version not found: ${input.report_version_id}`);
  }

  // 2. Immutability check: cannot vote on an already LOCKED report
  if (version.status === 'LOCKED') {
    throw new Error(
      `Cannot submit approval on an already LOCKED report (${version.id}). Organizer must reopen the report first.`
    );
  }

  // 3. Authority check
  const auth = await verifyApproverAuthority(
    db,
    version.fixture_id,
    input.approver_type,
    input.approver_id,
    input.is_organizer
  );

  if (!auth.authorized) {
    throw new Error(`Unauthorized approval: ${auth.reason}`);
  }

  // 4. Record or update approval decision
  const approvalId: UUID = randomUUID();
  await db.execute({
    sql: `
      INSERT INTO approvals (id, report_version_id, approver_type, approver_id, decision, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (report_version_id, approver_type, approver_id)
      DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at
    `,
    args: [
      approvalId,
      input.report_version_id,
      input.approver_type,
      input.approver_id,
      input.decision,
      now,
    ],
  });

  // 5. Audit event for the vote
  await db.execute({
    sql: `
      INSERT INTO audit_events (
        id, actor_type, actor_id, event_type, entity_type, entity_id,
        before_json, after_json, reason, correlation_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      randomUUID(),
      input.approver_type === 'ORGANIZER' ? 'ORGANIZER' : 'DELEGATE',
      input.approver_id,
      `REPORT_VOTE_${input.decision}`,
      'report_versions',
      version.id,
      JSON.stringify({ status: version.status }),
      JSON.stringify({ approver_type: input.approver_type, decision: input.decision }),
      input.rejection_reason || null,
      correlationId,
      now,
    ],
  });

  // 6. If rejection: transition report to NEEDS_CORRECTION
  if (input.decision === 'REJECT') {
    await updateReportVersionStatus(db, version.id, 'NEEDS_CORRECTION');
    const allApprovals = await getReportApprovals(db, version.id);

    return {
      report_version_id: version.id,
      status: 'NEEDS_CORRECTION',
      isLocked: false,
      approvals: allApprovals,
      missingApprovers: [],
      message: `Report rejected by ${input.approver_type}: ${input.rejection_reason || 'No reason specified'}`,
    };
  }

  // 7. Check if all three parties have approved (TEAM_A, TEAM_B, ORGANIZER)
  const allApprovals = await getReportApprovals(db, version.id);
  const approvedTypes = new Set<ApproverType>(
    allApprovals.filter((a) => a.decision === 'APPROVE').map((a) => a.approver_type)
  );

  const requiredTypes: ApproverType[] = ['TEAM_A', 'TEAM_B', 'ORGANIZER'];
  const missingApprovers = requiredTypes.filter((t) => !approvedTypes.has(t));

  if (missingApprovers.length === 0) {
    // All 3 parties approved -> transition to LOCKED!
    await updateReportVersionStatus(db, version.id, 'LOCKED');

    // Trigger post-lock stats writing and game finalization (Task 5.6)
    await onReportLocked(db, version.id);

    // Audit event for final lock
    await db.execute({
      sql: `
        INSERT INTO audit_events (
          id, actor_type, actor_id, event_type, entity_type, entity_id,
          before_json, after_json, reason, correlation_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        randomUUID(),
        'SYSTEM',
        'SYSTEM',
        'REPORT_LOCKED_THREE_PARTY_CONSENSUS',
        'report_versions',
        version.id,
        JSON.stringify({ status: 'PENDING_APPROVAL' }),
        JSON.stringify({ status: 'LOCKED' }),
        'All three parties (Team A, Team B, Organizer) approved.',
        correlationId,
        now,
      ],
    });

    return {
      report_version_id: version.id,
      status: 'LOCKED',
      isLocked: true,
      approvals: allApprovals,
      missingApprovers: [],
      message: 'Report approved by all three parties and successfully LOCKED.',
    };
  }

  // Partial approvals: remains PENDING_APPROVAL
  return {
    report_version_id: version.id,
    status: 'PENDING_APPROVAL',
    isLocked: false,
    approvals: allApprovals,
    missingApprovers,
    message: `Vote recorded. Waiting for approval from: ${missingApprovers.join(', ')}`,
  };
}

/**
 * Organizer unilateral lock override (FR-APR-004).
 * Directly transitions report version to LOCKED with audit record.
 */
export async function organizerOverrideLock(
  db: Client,
  input: OrganizerOverrideLockInput
): Promise<ReportVersion> {
  const version = await getReportVersion(db, input.report_version_id);
  if (!version) {
    throw new Error(`Report version not found: ${input.report_version_id}`);
  }

  const now: ISODateString = new Date().toISOString();
  const correlationId = input.correlation_id || randomUUID();

  // Update status to LOCKED
  const updated = await updateReportVersionStatus(db, version.id, 'LOCKED', {
    isOrganizer: true,
    reason: input.reason,
  });

  // Finalize stats
  await onReportLocked(db, version.id);

  // Record audit trail
  await db.execute({
    sql: `
      INSERT INTO audit_events (
        id, actor_type, actor_id, event_type, entity_type, entity_id,
        before_json, after_json, reason, correlation_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      randomUUID(),
      'ORGANIZER',
      input.organizer_id,
      'ORGANIZER_OVERRIDE_LOCK',
      'report_versions',
      version.id,
      JSON.stringify({ status: version.status }),
      JSON.stringify({ status: 'LOCKED' }),
      input.reason,
      correlationId,
      now,
    ],
  });

  return updated;
}

/**
 * Organizer reopen report (FR-APR-004).
 * Transitions report from LOCKED back to NEEDS_CORRECTION so new corrections can be applied.
 */
export async function organizerReopenReport(
  db: Client,
  input: OrganizerReopenInput
): Promise<ReportVersion> {
  const version = await getReportVersion(db, input.report_version_id);
  if (!version) {
    throw new Error(`Report version not found: ${input.report_version_id}`);
  }

  const now: ISODateString = new Date().toISOString();
  const correlationId = input.correlation_id || randomUUID();

  // Reopen status
  const updated = await updateReportVersionStatus(db, version.id, 'NEEDS_CORRECTION', {
    isOrganizer: true,
    reason: input.reason,
  });

  // Record audit trail
  await db.execute({
    sql: `
      INSERT INTO audit_events (
        id, actor_type, actor_id, event_type, entity_type, entity_id,
        before_json, after_json, reason, correlation_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      randomUUID(),
      'ORGANIZER',
      input.organizer_id,
      'ORGANIZER_REOPEN_REPORT',
      'report_versions',
      version.id,
      JSON.stringify({ status: version.status }),
      JSON.stringify({ status: 'NEEDS_CORRECTION' }),
      input.reason,
      correlationId,
      now,
    ],
  });

  return updated;
}

/**
 * Retrieves all approvals for a specific report version.
 */
export async function getReportApprovals(
  db: Client,
  reportVersionId: UUID
): Promise<Approval[]> {
  const res = await db.execute({
    sql: `
      SELECT id, report_version_id, approver_type, approver_id, decision, created_at
      FROM approvals
      WHERE report_version_id = ?
      ORDER BY created_at ASC
    `,
    args: [reportVersionId],
  });

  return res.rows.map((row) => ({
    id: String(row[0]),
    report_version_id: String(row[1]),
    approver_type: String(row[2]) as ApproverType,
    approver_id: String(row[3]),
    decision: String(row[4]) as ApprovalDecision,
    created_at: String(row[5]),
  }));
}
