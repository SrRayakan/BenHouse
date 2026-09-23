import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalizeEmail } from './canonical-identifiers';
import {
  invitationTokenAuthenticator,
  serializeInvitationToken,
  verifyInvitationToken,
  type InvitationTokenClaims,
} from './invitation-token';

describe('HMAC de invitación B1.5', () => {
  const keys = { keys: new Map([[2, Buffer.alloc(32, 17)]]) };

  function claims(): InvitationTokenClaims {
    return {
      id: randomUUID(),
      purpose: 'ORGANIZATION_INVITATION',
      generation: 2,
      subjectType: 'ORGANIZATION_INVITATION',
      subjectId: randomUUID(),
      organizationId: randomUUID(),
      email: 'invited@example.test',
      role: 'ADMIN',
      keyVersion: 2,
    };
  }

  it('liga todos los claims en orden canónico y longitud inequívoca', () => {
    const original = claims();
    const authenticator = invitationTokenAuthenticator(original, keys)!;
    expect(verifyInvitationToken(authenticator, original, keys)).toBe(true);
    const variants: InvitationTokenClaims[] = [
      { ...original, id: randomUUID() },
      { ...original, purpose: 'PASSWORD_RESET' as InvitationTokenClaims['purpose'] },
      { ...original, generation: 3 },
      { ...original, subjectType: 'USER' as InvitationTokenClaims['subjectType'] },
      { ...original, subjectId: randomUUID() },
      { ...original, organizationId: randomUUID() },
      { ...original, email: 'other@example.test' },
      { ...original, role: 'PROFESSIONAL_MEMBER' },
      { ...original, keyVersion: 3 },
      { ...original, subjectId: original.organizationId, organizationId: original.subjectId },
    ];
    for (const variant of variants) {
      expect(verifyInvitationToken(authenticator, variant, keys)).toBe(false);
    }
    expect(invitationTokenAuthenticator({ ...original, email: '' }, keys)).toBeUndefined();
    expect(
      invitationTokenAuthenticator(
        { ...original, role: undefined } as unknown as InvitationTokenClaims,
        keys,
      ),
    ).toBeUndefined();
    expect(serializeInvitationToken(original, keys)).toMatch(
      /^v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/,
    );
  });

  it('exige un objeto plano con el conjunto exacto de claims', () => {
    const original = claims();
    expect(invitationTokenAuthenticator(original, keys)).toBeDefined();
    expect(
      invitationTokenAuthenticator(
        { ...original, extra: 'ignorado' } as unknown as InvitationTokenClaims,
        keys,
      ),
    ).toBeUndefined();
    const missing = { ...original } as Partial<InvitationTokenClaims>;
    delete missing.organizationId;
    expect(invitationTokenAuthenticator(missing as InvitationTokenClaims, keys)).toBeUndefined();

    const symbol = { ...original, [Symbol('extra')]: true };
    expect(invitationTokenAuthenticator(symbol, keys)).toBeUndefined();

    const nonEnumerable = { ...original };
    Object.defineProperty(nonEnumerable, 'extra', { value: true, enumerable: false });
    expect(invitationTokenAuthenticator(nonEnumerable, keys)).toBeUndefined();

    const hiddenRequired = { ...original };
    Object.defineProperty(hiddenRequired, 'role', { value: original.role, enumerable: false });
    expect(invitationTokenAuthenticator(hiddenRequired, keys)).toBeUndefined();

    const inherited = Object.assign(Object.create({ extra: true }), original);
    expect(invitationTokenAuthenticator(inherited, keys)).toBeUndefined();

    const accessor = { ...original };
    Object.defineProperty(accessor, 'email', { enumerable: true, get: () => original.email });
    expect(invitationTokenAuthenticator(accessor, keys)).toBeUndefined();

    const proxied = new Proxy(original, {});
    expect(invitationTokenAuthenticator(proxied, keys)).toBeUndefined();
  });

  it.each([
    'a@@example.com',
    'a..b@example.com',
    '.a@example.com',
    'a.@example.com',
    'a@example',
    'a@-example.com',
    'a@example-.com',
    ' invited@example.test',
    'invited@example.test ',
    'INVITED@example.test',
    'invited@BÜCHER.example',
  ])('rechaza email no canónico en claims: %s', (email) => {
    expect(invitationTokenAuthenticator({ ...claims(), email }, keys)).toBeUndefined();
  });

  it('acepta únicamente la representación canónica ASCII e IDNA', () => {
    expect(canonicalizeEmail('  Nombre+tag@BÜCHER.example  ')).toBe(
      'nombre+tag@xn--bcher-kva.example',
    );
    expect(
      invitationTokenAuthenticator(
        { ...claims(), email: 'nombre+tag@xn--bcher-kva.example' },
        keys,
      ),
    ).toBeDefined();
  });
});
