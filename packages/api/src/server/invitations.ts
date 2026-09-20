/**
 * Invitation / provisioning flow (Phase 3).
 *
 * An admin creates an invitation (email + role + client/profile scopes);
 * the API returns a single-use invite token (plaintext shown exactly once).
 * There is NO email delivery — the admin passes the token to the invitee
 * out-of-band (chat, password manager, …). The invitee redeems it via
 * POST /v1/invitations/redeem with their name and password.
 *
 * Invite tokens are scrypt-hashed like API tokens (`mli_` prefix); only a
 * lookup prefix is stored alongside the hash.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DatabaseSchema, InvitationsTable } from '../db/schema.js';
import {
  burnDummyVerification,
  hashTokenSecret,
  verifyTokenSecret,
} from './auth.js';
import { hashPassword } from './passwords.js';
import { getStringField, requireObjectBody, ValidationError } from './router.js';
import { validateEmail } from './users.js';

export const INVITE_PREFIX = 'mli_';
export const INVITE_LOOKUP_LENGTH = 12;

export function generateInviteToken(): string {
  return `${INVITE_PREFIX}${randomBytes(24).toString('base64url')}`;
}

function inviteTokenLookup(token: string): string {
  return token.slice(0, INVITE_LOOKUP_LENGTH);
}

export function isInviteTokenFormat(token: string): boolean {
  return token.startsWith(INVITE_PREFIX) && token.length === INVITE_PREFIX.length + 32;
}

export class InvitationNotFoundError extends Error {
  constructor(public readonly invitationId: string) {
    super(`Invitation not found: ${invitationId}`);
    this.name = 'InvitationNotFoundError';
  }
}

export class InvitationInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvitationInvalidError';
  }
}

/** Expired invitations get their own class so they map to 410 GONE. */
export class InvitationExpiredError extends InvitationInvalidError {
  constructor() {
    super('Invitation has expired');
    this.name = 'InvitationExpiredError';
  }
}

export interface PublicInvitation {
  id: string;
  email: string;
  roleId: string;
  clientIds: string[];
  profileIds: string[];
  expiresAt: string;
  usedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

function parseIdList(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function toPublicInvitation(row: InvitationsTable): PublicInvitation {
  return {
    id: row.id,
    email: row.email,
    roleId: row.role_id,
    clientIds: parseIdList(row.client_ids),
    profileIds: parseIdList(row.profile_ids),
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export interface CreateInvitationInput {
  email: string;
  roleId: string;
  clientIds?: string[];
  profileIds?: string[];
  /** Hours until expiry; default 72, max 720 (30 days). */
  expiresInHours?: number;
  createdBy?: string;
}

export interface CreatedInvitation {
  invitation: PublicInvitation;
  /** Plaintext invite token. Shown ONCE — never stored, never recoverable. */
  token: string;
}

export async function createInvitation(
  db: Kysely<DatabaseSchema>,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  const email = validateEmail(input.email);
  const role = await db.selectFrom('roles').select('id').where('id', '=', input.roleId).executeTakeFirst();
  if (!role) {
    throw new ValidationError(`Unknown role: ${input.roleId}`);
  }
  const expiresInHours = input.expiresInHours ?? 72;
  if (!Number.isFinite(expiresInHours) || expiresInHours <= 0 || expiresInHours > 720) {
    throw new ValidationError('expiresInHours must be > 0 and <= 720');
  }
  const clientIds = [...new Set(input.clientIds ?? [])];
  const profileIds = [...new Set(input.profileIds ?? [])];
  for (const clientId of clientIds) {
    const row = await db.selectFrom('clients').select('id').where('id', '=', clientId).executeTakeFirst();
    if (!row) {
      throw new ValidationError(`Unknown client: ${clientId}`);
    }
  }
  for (const profileId of profileIds) {
    const row = await db.selectFrom('profiles').select('id').where('id', '=', profileId).executeTakeFirst();
    if (!row) {
      throw new ValidationError(`Unknown profile: ${profileId}`);
    }
  }
  const token = generateInviteToken();
  const { salt, hash } = await hashTokenSecret(token);
  const now = new Date().toISOString();
  const id = randomUUID();
  const row: InvitationsTable = {
    id,
    email,
    role_id: input.roleId,
    client_ids: JSON.stringify(clientIds),
    profile_ids: JSON.stringify(profileIds),
    prefix: inviteTokenLookup(token),
    salt,
    hash,
    expires_at: new Date(Date.now() + expiresInHours * 3600_000).toISOString(),
    used_at: null,
    created_by: input.createdBy ?? null,
    created_at: now,
  };
  await db.insertInto('invitations').values(row).execute();
  return { invitation: toPublicInvitation(row), token };
}

export async function listInvitations(db: Kysely<DatabaseSchema>): Promise<PublicInvitation[]> {
  const rows = await db.selectFrom('invitations').selectAll().orderBy('created_at', 'desc').execute();
  return rows.map(toPublicInvitation);
}

export async function revokeInvitation(db: Kysely<DatabaseSchema>, invitationId: string): Promise<void> {
  const row = await db.selectFrom('invitations').select('id').where('id', '=', invitationId).executeTakeFirst();
  if (!row) {
    throw new InvitationNotFoundError(invitationId);
  }
  await db.deleteFrom('invitations').where('id', '=', invitationId).execute();
}

export interface RedeemInvitationInput {
  token: string;
  name: string;
  password: string;
}

export interface RedeemedInvitation {
  userId: string;
  email: string;
  name: string;
  roles: string[];
}

/**
 * Redeem an invite token: validates it (single-use, unexpired, correct
 * secret), creates the user with the invited role + scopes, marks the
 * invitation used — all in one transaction. Throws InvitationInvalidError
 * for expired/used/wrong tokens and ValidationError for bad input.
 */
export async function redeemInvitation(
  db: Kysely<DatabaseSchema>,
  input: RedeemInvitationInput,
): Promise<RedeemedInvitation> {
  const presented = input.token;
  if (!isInviteTokenFormat(presented)) {
    await burnDummyVerification();
    throw new InvitationInvalidError('Invalid or expired invitation token');
  }
  const candidates = await db
    .selectFrom('invitations')
    .selectAll()
    .where('prefix', '=', inviteTokenLookup(presented))
    .where('used_at', 'is', null)
    .execute();
  let invitation: InvitationsTable | null = null;
  for (const row of candidates) {
    if (await verifyTokenSecret(presented, row.salt, row.hash)) {
      invitation = row;
      break;
    }
  }
  if (!invitation) {
    await burnDummyVerification();
    throw new InvitationInvalidError('Invalid or expired invitation token');
  }
  const valid = invitation;
  if (valid.expires_at <= new Date().toISOString()) {
    throw new InvitationExpiredError();
  }
  const name = input.name.trim();
  if (name.length === 0 || name.length > 200) {
    throw new ValidationError('Field must be 1-200 characters: name');
  }
  const existing = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', valid.email)
    .executeTakeFirst();
  if (existing) {
    throw new InvitationInvalidError('This invitation email is already registered');
  }
  const passwordHash = await hashPassword(input.password);
  const now = new Date().toISOString();
  const userId = randomUUID();
  const clientIds = parseIdList(valid.client_ids);
  const profileIds = parseIdList(valid.profile_ids);
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('users')
      .values({
        id: userId,
        name,
        email: valid.email,
        password_hash: passwordHash,
        disabled: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('user_roles')
      .values({ user_id: userId, role_id: valid.role_id, created_at: now })
      .execute();
    for (const clientId of clientIds) {
      await trx
        .insertInto('user_clients')
        .values({ user_id: userId, client_id: clientId, created_at: now })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    for (const profileId of profileIds) {
      await trx
        .insertInto('user_profiles')
        .values({ user_id: userId, profile_id: profileId, created_at: now })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    await trx
      .updateTable('invitations')
      .set({ used_at: now })
      .where('id', '=', valid.id)
      .execute();
  });
  return { userId, email: valid.email, name, roles: [valid.role_id] };
}

/** Parse the redeem body shared by the route handler. */
export function redeemInputFromBody(body: unknown): RedeemInvitationInput {
  const obj = requireObjectBody(body);
  const token = getStringField(obj, 'token', { required: true, maxLength: 100 });
  const name = getStringField(obj, 'name', { required: true, maxLength: 200 });
  const password = getStringField(obj, 'password', { required: true, maxLength: 256 });
  return { token: token ?? '', name: name ?? '', password: password ?? '' };
}
