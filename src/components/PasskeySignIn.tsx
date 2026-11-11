import { useEffect, useRef, useState } from 'react';
import { Fingerprint } from 'lucide-react';
import { signInWithDevicePasskey } from '@/lib/passkeyClient';
import { passkeyErrorMessage } from '@/lib/passkeys';
import { usePasskeySupport } from '@/lib/usePasskeySupport';
import './passkeys.css';

export default function PasskeySignIn({ disabled, onBusyChange, onError }: {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string) => void;
}) {
  const support = usePasskeySupport();
  const controller = useRef<AbortController | null>(null);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => () => controller.current?.abort(), []);

  async function signIn() {
    if (disabled || controller.current || !support?.supported) return;
    const attempt = new AbortController();
    controller.current = attempt;
    setVerifying(true);
    onBusyChange(true);
    onError('');
    try {
      await signInWithDevicePasskey(attempt.signal);
      // Supabase stores the verified session and emits SIGNED_IN for App.
    } catch (error) {
      onError(passkeyErrorMessage(error));
    } finally {
      controller.current = null;
      setVerifying(false);
      onBusyChange(false);
    }
  }

  return <div className="passkey-login">
    <button type="button" className="passkey-button" disabled={disabled || !support?.supported} onClick={() => { void signIn(); }}>
      <Fingerprint size={21} aria-hidden="true" />
      {verifying ? 'Verificando identidad…' : 'Entrar con huella, rostro o PIN'}
    </button>
    {verifying && <button type="button" className="passkey-link" onClick={() => controller.current?.abort()}>Cancelar verificación</button>}
    <p className="passkey-help">{support?.reason || 'Usa una clave de acceso que ya hayas activado. Tu dispositivo elige cómo verificarte.'}</p>
    <div className="passkey-divider"><span>o usa tu contraseña</span></div>
  </div>;
}
