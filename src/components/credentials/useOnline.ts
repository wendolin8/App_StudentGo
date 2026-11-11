import { useSyncExternalStore } from 'react';

function subscribe(notify: () => void) {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
}

export const offlineNotice = 'Sin conexión. Tus fotos se conservan mientras mantengas este formulario abierto. Podrás continuar cuando vuelva internet.';

export function useOnline() {
  return useSyncExternalStore(subscribe, () => navigator.onLine);
}
