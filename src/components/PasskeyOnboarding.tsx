import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { usePasskeySupport } from '@/lib/usePasskeySupport';
import PasskeySettings from './PasskeySettings';

export default function PasskeyOnboarding({ userId }: { userId: string }) {
  const support = usePasskeySupport();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const preferenceKey = `student-go.passkey-onboarding.${userId}`;

  useEffect(() => {
    if (!support?.supported) return;
    try { if (localStorage.getItem(preferenceKey)) return; } catch { /* Storage can be unavailable in private mode. */ }
    let active = true;
    void supabase.auth.passkey.list().then(({ data, error }) => {
      if (active && !error && data?.length === 0) setOpen(true);
    }).catch(() => { /* The profile still offers enrollment after a network failure. */ });
    return () => { active = false; };
  }, [support, preferenceKey]);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  function dismiss() {
    // This is only a presentation preference, never proof of authentication.
    try { localStorage.setItem(preferenceKey, 'seen'); } catch { /* Optional preference. */ }
    setOpen(false);
  }

  return <dialog ref={dialog} className="passkey-onboarding" aria-labelledby="passkey-welcome" onCancel={dismiss}>
    {open && <>
      <h1 id="passkey-welcome">La próxima vez, entra más fácil</h1>
      <p>Ya tienes tu cuenta. Si este es un dispositivo personal, puedes activar el acceso rápido.</p>
      <PasskeySettings userId={userId} onRegistered={dismiss} />
      <button type="button" className="passkey-link" onClick={dismiss}>Ahora no, continuar a Student Go</button>
    </>}
  </dialog>;
}
