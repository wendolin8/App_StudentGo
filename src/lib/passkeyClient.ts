import { startAuthentication, startRegistration, WebAuthnAbortService, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type { VerifyPasskeyRegistrationParams } from '@supabase/supabase-js';
import { supabase } from './supabase';

async function ceremony<T>(signal: AbortSignal, prompt: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const cancel = () => WebAuthnAbortService.cancelCeremony();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const credential = await prompt();
    signal.throwIfAborted();
    return credential;
  } finally { signal.removeEventListener('abort', cancel); }
}

export async function registerDevicePasskey(signal: AbortSignal) {
  signal.throwIfAborted();
  const { data: challenge, error } = await supabase.auth.passkey.startRegistration();
  if (error) throw error;
  if (!challenge) throw new Error('Missing registration challenge');
  const credential = await ceremony(signal, () => startRegistration({
    optionsJSON: {
      ...challenge.options,
      authenticatorSelection: {
        ...challenge.options.authenticatorSelection,
        residentKey: 'required',
        userVerification: 'required',
      },
    } as PublicKeyCredentialCreationOptionsJSON,
  }));
  // Only Supabase can associate the signed credential with the current account.
  // Both SDKs use the WebAuthn JSON format; their optional hint/transport unions differ.
  const result = await supabase.auth.passkey.verifyRegistration({ challengeId: challenge.challenge_id, credential: credential as VerifyPasskeyRegistrationParams['credential'] });
  if (result.error) throw result.error;
  if (!result.data?.id) throw new Error('Missing verified credential');
  return result.data;
}

export async function signInWithDevicePasskey(signal: AbortSignal) {
  signal.throwIfAborted();
  const { data: challenge, error } = await supabase.auth.passkey.startAuthentication();
  if (error) throw error;
  if (!challenge) throw new Error('Missing authentication challenge');
  const credential = await ceremony(signal, () => startAuthentication({
    optionsJSON: { ...challenge.options, userVerification: 'required' } as PublicKeyCredentialRequestOptionsJSON,
  }));
  // Verification establishes a real Supabase session and emits SIGNED_IN.
  const result = await supabase.auth.passkey.verifyAuthentication({ challengeId: challenge.challenge_id, credential });
  if (result.error) throw result.error;
  if (!result.data?.session || !result.data.user) throw new Error('Missing verified session');
  return { ...result.data, user: result.data.user, session: result.data.session };
}
