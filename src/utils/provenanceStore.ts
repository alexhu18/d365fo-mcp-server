/**
 * In-memory provenance store for grounding tokens.
 *
 * A grounding token proves that the model queried the real D365FO codebase
 * (via prepare_change) before generating extension code. Tokens expire after
 * TTL_MS to prevent stale context being reused across sessions.
 *
 * Enforcement: when GROUNDING_ENFORCE=true, extension patterns in generate_object(mode="pattern")
 * and extension objectTypes in create_d365fo_file will reject calls without a
 * valid token.
 */

import crypto from 'crypto';
import { SERVER_MODE } from '../server/serverMode.js';

const TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface ProvenanceContext {
  goal: string;
  objectName: string;
  methodName?: string;
  objectType?: string;
  /** Proposed name of the new extension object, when supplied to prepare_change */
  proposedName?: string;
  /** Condensed facts gathered by prepare_change */
  methodSignature?: string;
  cocExtensions?: string;
  extensionEligibility?: string;
  recommendedStrategy?: string;
  namingValidation?: string;
  patterns?: string;
}

export interface ProvenanceBundle {
  token: string;
  context: ProvenanceContext;
  timestamp: number;
  expiresAt: number;
}

const store = new Map<string, ProvenanceBundle>();

function prune(): void {
  const now = Date.now();
  for (const [key, bundle] of store.entries()) {
    if (bundle.expiresAt < now) store.delete(key);
  }
}

// Signed (portable) tokens: the in-memory store only works when the SAME
// process issues and validates a token, which breaks in hybrid deployments
// (separate read-only/write-only instances) or scaled-out App Service. When
// GROUNDING_SECRET is set on all instances, tokens are HMAC-signed and carry
// their own object binding + expiry, so any process holding the secret can
// validate them statelessly.

const SIGNED_PREFIX = 'g1.';

function getGroundingSecret(): string | null {
  return process.env.GROUNDING_SECRET?.trim() || null;
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 24);
}

/** Verify a signed token and reconstruct a minimal bundle from its payload. */
function verifySignedToken(token: string): ProvenanceBundle | undefined {
  const secret = getGroundingSecret();
  if (!secret || !token.startsWith(SIGNED_PREFIX)) return undefined;
  const parts = token.slice(SIGNED_PREFIX.length).split('.');
  if (parts.length !== 2) return undefined;
  const [payload, mac] = parts;
  const expected = signPayload(payload, secret);
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (macBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(macBuf, expectedBuf)) {
    return undefined;
  }
  let decoded: { o?: string; p?: string; e?: number };
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof decoded.e !== 'number' || decoded.e < Date.now()) return undefined;
  return {
    token,
    context: { goal: '(signed token)', objectName: decoded.o ?? '', proposedName: decoded.p },
    timestamp: decoded.e - TTL_MS,
    expiresAt: decoded.e,
  };
}

export function createProvenanceToken(context: ProvenanceContext): string {
  prune();
  const now = Date.now();
  const expiresAt = now + TTL_MS;
  const secret = getGroundingSecret();
  let token: string;
  if (secret) {
    // Portable HMAC token: payload carries object binding + expiry so another
    // process can validate it.
    const payload = Buffer.from(JSON.stringify({
      o: context.objectName,
      ...(context.proposedName ? { p: context.proposedName } : {}),
      e: expiresAt,
    }), 'utf8').toString('base64url');
    token = `${SIGNED_PREFIX}${payload}.${signPayload(payload, secret)}`;
  } else {
    const payload = `${context.goal}:${context.objectName}:${context.methodName ?? ''}:${now}`;
    token = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
  }
  store.set(token, {
    token,
    context,
    timestamp: now,
    expiresAt,
  });
  return token;
}

export function getProvenanceBundle(token: string): ProvenanceBundle | undefined {
  prune();
  const bundle = store.get(token);
  if (bundle) {
    if (bundle.expiresAt < Date.now()) {
      store.delete(token);
      return undefined;
    }
    return bundle;
  }
  // Not issued by this process — try stateless validation of a signed token.
  return verifySignedToken(token);
}

export function isValidToken(token: string): boolean {
  return getProvenanceBundle(token) !== undefined;
}

/**
 * Check that a token was issued for the object actually being written.
 *
 * A token issued for `CustTable` is accepted for targets that EMBED that name
 * at the start (`CustTable.ContosoExtension`, `CustTableContoso_Extension`, …)
 * and for the proposedName recorded by prepare_change. D365FO extension naming
 * always leads with the base object name, so a prefix match is used rather
 * than a bare substring match. Names shorter than 4 chars are compared exactly
 * to avoid trivial matches.
 */
export function tokenMatchesTarget(
  bundle: ProvenanceBundle,
  targetObjectName: string,
): boolean {
  const target = targetObjectName.trim().toLowerCase();
  if (!target) return true;
  const candidates = [bundle.context.objectName, bundle.context.proposedName]
    .filter((c): c is string => !!c)
    .map(c => c.trim().toLowerCase());
  return candidates.some(c => {
    if (c === target) return true;
    if (c.length < 4 || target.length < 4) return false;
    return target.startsWith(c) || c.startsWith(target);
  });
}

/**
 * Enforce grounding for extension write operations.
 *
 * Returns an error result if GROUNDING_ENFORCE=true is set in the environment AND:
 *   - no valid grounding token was provided, OR
 *   - the token was issued for a different object than `targetObjectName`.
 *
 * Returns null when enforcement passes (either disabled or token is valid).
 */
let warnedWriteOnlyBypass = false;

export function enforceGrounding(
  groundingToken: string | undefined,
  operationDescription: string,
  targetObjectName?: string,
): { isError: true; content: [{ type: 'text'; text: string }] } | null {
  if (process.env.GROUNDING_ENFORCE !== 'true') return null;
  // Hybrid-deployment guard: in write-only mode prepare_change runs on a
  // separate read-only instance. Without a shared GROUNDING_SECRET, no token
  // issued there can ever validate here, so enforcing would dead-loop the
  // agent between the two servers. With a shared secret, tokens are verified
  // statelessly and this bypass is unnecessary.
  if (SERVER_MODE === 'write-only' && !getGroundingSecret()) {
    if (!warnedWriteOnlyBypass) {
      warnedWriteOnlyBypass = true;
      console.error(
        '[provenance] ⚠️ GROUNDING_ENFORCE=true is ignored in write-only mode — ' +
        'prepare(mode="change") tokens are issued by the read-only instance and cannot be ' +
        'validated in this process. To enforce grounding in hybrid deployments, set the ' +
        'same GROUNDING_SECRET on both instances; otherwise remove GROUNDING_ENFORCE ' +
        'from the local companion .env.',
      );
    }
    return null;
  }
  if (groundingToken && isValidToken(groundingToken)) {
    if (!targetObjectName) return null;
    const bundle = getProvenanceBundle(groundingToken)!;
    if (tokenMatchesTarget(bundle, targetObjectName)) return null;
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `❌ Grounding token mismatch for ${operationDescription} (GROUNDING_ENFORCE=true).\n\n` +
          `The provided token was issued for object \`${bundle.context.objectName}\`` +
          (bundle.context.proposedName ? ` (proposed: \`${bundle.context.proposedName}\`)` : '') +
          `, but this call targets \`${targetObjectName}\`.\n\n` +
          `**Required workflow:**\n` +
          `1. Call \`prepare(mode="change", goal="...", objectName="${targetObjectName}")\` for THIS object.\n` +
          `2. Pass the returned \`groundingToken\` to this tool.\n\n` +
          `Tokens are object-bound — one token cannot authorize writes to a different object.`,
      }],
    };
  }
  const reason = groundingToken
    ? 'the provided groundingToken has expired or is invalid'
    : 'no groundingToken was provided';
  return {
    isError: true,
    content: [{
      type: 'text',
      text:
        `❌ Grounding required for ${operationDescription} (GROUNDING_ENFORCE=true).\n\n` +
        `Reason: ${reason}.\n\n` +
        `**Required workflow:**\n` +
        `1. Call \`prepare(mode="change", goal="...", objectName="...")\` to gather facts from the D365FO index.\n` +
        `2. Pass the returned \`groundingToken\` as a parameter to this tool.\n\n` +
        `This ensures generated extension code is grounded in your actual codebase, not AI training data.\n\n` +
        `To disable enforcement (direct API / human use): set \`GROUNDING_ENFORCE=false\` in the server .env.`,
    }],
  };
}
