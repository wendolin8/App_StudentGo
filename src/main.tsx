import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import StartupError from './components/StartupError';
import './index.css';

const root = createRoot(document.getElementById('root')!);

root.render(
  <main className="startup-screen" role="status">
    <p>Cargando Student Go…</p>
  </main>
);

// Supabase is initialized while App's modules load. Catch configuration errors
// here, before they can prevent React from displaying anything.
void import('./App.tsx').then(({ default: App }) => {
  root.render(<StrictMode><App /></StrictMode>);
}).catch((error: unknown) => {
  console.error('No se pudo iniciar Student Go:', error);
  root.render(<StartupError error={error} />);
});
