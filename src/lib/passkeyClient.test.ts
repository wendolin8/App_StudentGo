import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerDevicePasskey, signInWithDevicePasskey } from './passkeyClient';

const mocks = vi.hoisted(() => ({
  startRegistration: vi.fn(), verifyRegistration: vi.fn(),
  startAuthentication: vi.fn(), verifyAuthentication: vi.fn(),
  createCredential: vi.fn(), getCredential: vi.fn(), cancel: vi.fn(),
}));
vi.mock('./supabase', () => ({ supabase: { auth: { passkey: {
  startRegistration: mocks.startRegistration, verifyRegistration: mocks.verifyRegistration,
  startAuthentication: mocks.startAuthentication, verifyAuthentication: mocks.verifyAuthentication,
} } } }));
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: mocks.createCredential, startAuthentication: mocks.getCredential,
  WebAuthnAbortService: { cancelCeremony: mocks.cancel },
}));

beforeEach(() => {
  mocks.startRegistration.mockResolvedValue({ data: { challenge_id: 'register-1', options: { challenge: 'server-registration', rp: { id: 'localhost', name: 'Student Go' }, user: { id: 'account-1' }, authenticatorSelection: { userVerification: 'preferred' } } }, error: null });
  mocks.startAuthentication.mockResolvedValue({ data: { challenge_id: 'login-1', options: { challenge: 'server-login', rpId: 'localhost', userVerification: 'preferred' } }, error: null });
  mocks.createCredential.mockResolvedValue({ id: 'credential-1', response: { attestationObject: 'signed-registration' } });
  mocks.getCredential.mockResolvedValue({ id: 'credential-1', response: { signature: 'signed-login' } });
  mocks.verifyRegistration.mockResolvedValue({ data: { id: 'passkey-1' }, error: null });
  mocks.verifyAuthentication.mockResolvedValue({ data: { session: { access_token: 'test-only' }, user: { id: 'account-1' } }, error: null });
});
afterEach(() => vi.resetAllMocks());

describe('passkey authentication boundary', () => {
  it('requests device verification and uses the server challenge when enrolling', async () => {
    await registerDevicePasskey(new AbortController().signal);
    expect(mocks.createCredential).toHaveBeenCalledWith({ optionsJSON: expect.objectContaining({
      challenge: 'server-registration', authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    }) });
    expect(mocks.verifyRegistration).toHaveBeenCalledWith({ challengeId: 'register-1', credential: expect.objectContaining({ id: 'credential-1' }) });
  });

  it('requires user verification without asking for an email or password', async () => {
    const result = await signInWithDevicePasskey(new AbortController().signal);
    expect(mocks.getCredential).toHaveBeenCalledWith({ optionsJSON: { challenge: 'server-login', rpId: 'localhost', userVerification: 'required' } });
    expect(mocks.verifyAuthentication).toHaveBeenCalledWith({ challengeId: 'login-1', credential: expect.objectContaining({ id: 'credential-1' }) });
    expect(result.user.id).toBe('account-1');
  });

  it('does not show a biometric prompt when the server disables passkeys', async () => {
    const error = { code: 'passkey_disabled' };
    mocks.startAuthentication.mockResolvedValue({ data: null, error });
    await expect(signInWithDevicePasskey(new AbortController().signal)).rejects.toEqual(error);
    expect(mocks.getCredential).not.toHaveBeenCalled();
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
  });

  it('does not authenticate a cancelled browser prompt', async () => {
    mocks.getCredential.mockRejectedValue(new DOMException('Cancelled', 'NotAllowedError'));
    await expect(signInWithDevicePasskey(new AbortController().signal)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
  });

  it('does not continue an attempt cancelled while fetching a challenge', async () => {
    const controller = new AbortController();
    mocks.startAuthentication.mockImplementation(async () => {
      controller.abort();
      return { data: { challenge_id: 'cancelled', options: {} }, error: null };
    });
    await expect(signInWithDevicePasskey(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.getCredential).not.toHaveBeenCalled();
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
  });

  it('cancels the active browser ceremony when the component unmounts', async () => {
    const controller = new AbortController();
    mocks.getCredential.mockImplementation(async () => { controller.abort(); return { id: 'late-result' }; });
    await expect(signInWithDevicePasskey(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
  });

  it('requires server verification even when the local authenticator succeeded', async () => {
    const error = { code: 'webauthn_verification_failed' };
    mocks.verifyAuthentication.mockResolvedValue({ data: null, error });
    await expect(signInWithDevicePasskey(new AbortController().signal)).rejects.toEqual(error);
    mocks.verifyRegistration.mockResolvedValue({ data: null, error });
    await expect(registerDevicePasskey(new AbortController().signal)).rejects.toEqual(error);
  });

  it('rejects incomplete session and registration responses', async () => {
    mocks.verifyAuthentication.mockResolvedValue({ data: { session: null, user: null }, error: null });
    await expect(signInWithDevicePasskey(new AbortController().signal)).rejects.toThrow('Missing verified session');
    mocks.verifyRegistration.mockResolvedValue({ data: null, error: null });
    await expect(registerDevicePasskey(new AbortController().signal)).rejects.toThrow('Missing verified credential');
  });

  it('gets a fresh challenge for each retry', async () => {
    mocks.startAuthentication.mockResolvedValueOnce({ data: { challenge_id: 'old', options: { challenge: 'old' } } });
    mocks.verifyAuthentication.mockResolvedValueOnce({ data: null, error: { code: 'webauthn_challenge_expired' } });
    await expect(signInWithDevicePasskey(new AbortController().signal)).rejects.toMatchObject({ code: 'webauthn_challenge_expired' });
    await signInWithDevicePasskey(new AbortController().signal);
    expect(mocks.startAuthentication).toHaveBeenCalledTimes(2);
    expect(mocks.verifyAuthentication).toHaveBeenLastCalledWith({ challengeId: 'login-1', credential: expect.any(Object) });
  });
});
