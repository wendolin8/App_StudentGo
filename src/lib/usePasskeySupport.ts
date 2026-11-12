import { useEffect, useState } from 'react';
import { getPasskeySupport, type PasskeySupport } from './passkeys';

export function usePasskeySupport() {
  const [support, setSupport] = useState<PasskeySupport | null>(null);
  useEffect(() => {
    let active = true;
    void getPasskeySupport().then((result) => { if (active) setSupport(result); });
    return () => { active = false; };
  }, []);
  return support;
}
