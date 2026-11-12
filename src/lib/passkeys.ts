export type PasskeySupport = {
  supported: boolean;
  platformAvailable: boolean;
  reason: string;
};

export async function getPasskeySupport(): Promise<PasskeySupport> {
  if (typeof window === 'undefined' || !window.isSecureContext) {
    return { supported: false, platformAvailable: false, reason: 'Abre Student Go por HTTPS o desde localhost para usar una clave de acceso.' };
  }
  if (!window.PublicKeyCredential || !navigator.credentials?.create || !navigator.credentials?.get) {
    return { supported: false, platformAvailable: false, reason: 'Este navegador no admite claves de acceso. Puedes entrar con tu contraseña.' };
  }
  let platformAvailable = false;
  try {
    platformAvailable = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { /* A security key or another device may still be available. */ }
  return { supported: true, platformAvailable, reason: '' };
}

export function passkeyErrorMessage(error: unknown): string {
  const detail = error && typeof error === 'object' ? error as { code?: string; name?: string; status?: number } : {};
  if (detail.name === 'AbortError' || detail.code === 'ERROR_CEREMONY_ABORTED') return 'Verificación cancelada. Puedes intentarlo de nuevo.';
  if (detail.name === 'NotAllowedError') return 'La verificación se canceló o terminó el tiempo de espera. Intenta otra vez o usa tu contraseña.';
  if (detail.name === 'SecurityError' || ['ERROR_INVALID_RP_ID', 'ERROR_INVALID_DOMAIN'].includes(detail.code ?? '')) {
    return 'Esta dirección no está habilitada para claves de acceso. Abre la dirección configurada por el administrador.';
  }
  switch (detail.code) {
    case 'passkey_disabled':
      return 'El acceso con huella, rostro o PIN aún no está habilitado por el administrador. Puedes entrar con tu contraseña.';
    case 'email_not_confirmed':
    case 'phone_not_confirmed':
      return 'Confirma tu cuenta antes de activar una clave de acceso.';
    case 'webauthn_credential_exists':
    case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
      return 'Esta clave de acceso ya está registrada. Puedes usarla para entrar.';
    case 'webauthn_credential_not_found':
      return 'Esta clave ya no está registrada. Entra con tu contraseña y agrega una desde tu perfil.';
    case 'webauthn_challenge_expired':
    case 'webauthn_challenge_not_found':
      return 'La solicitud venció o ya fue utilizada. Vuelve a intentarlo para iniciar una nueva verificación.';
    case 'webauthn_verification_failed':
      return 'No se pudo verificar la clave de acceso. Intenta de nuevo o usa tu contraseña.';
    case 'too_many_passkeys':
      return 'Alcanzaste el límite de claves de acceso. Quita una que ya no uses antes de agregar otra.';
    case 'user_banned':
      return 'Tu cuenta no tiene permitido iniciar sesión. Contacta al administrador.';
    case 'session_not_found':
    case 'session_expired':
      return 'Inicia sesión nuevamente antes de administrar tus claves de acceso.';
    case 'insufficient_aal':
      return 'Tu cuenta requiere completar la verificación adicional antes de administrar claves de acceso.';
    case 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT':
    case 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT':
      return 'Configura el bloqueo de pantalla del dispositivo o prueba con otro dispositivo compatible.';
  }
  if (detail.status === 429) return 'Hubo demasiados intentos. Espera un momento antes de volver a intentar.';
  return 'No se pudo completar la operación. Revisa tu conexión y vuelve a intentar. Tu contraseña sigue disponible.';
}
