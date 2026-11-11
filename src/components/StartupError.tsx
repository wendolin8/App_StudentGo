import './StartupError.css';

export default function StartupError({ error }: { error: unknown }) {
  return (
    <main className="startup-screen">
      <section className="startup-card" role="alert" aria-labelledby="startup-title">
        <p className="startup-brand">Student Go</p>
        <h1 id="startup-title">No se pudo iniciar la aplicación</h1>
        <p>Revisa la conexión y vuelve a cargar la página. Si el problema continúa, contacta al administrador.</p>
        {import.meta.env.DEV && (
          <div className="startup-details">
            <h2>Información para desarrollo</h2>
            <p>{error instanceof Error ? error.message : 'Ocurrió un error al cargar la aplicación.'}</p>
            <p>Para conectar el entorno de pruebas:</p>
            <ol>
              <li>Copia <code>.env.pruebas.example</code> a <code>.env.pruebas.local</code>.</li>
              <li>Completa el identificador, la URL y la clave pública del proyecto Supabase de pruebas.</li>
              <li>Detén el servidor y ejecuta <code>npm run dev:pruebas</code>.</li>
            </ol>
            <p>Si usas <code>npm run dev</code>, configura las variables en <code>.env.local</code>. Consulta <code>README.md</code> para los pasos completos.</p>
          </div>
        )}
        <button className="primary-button" onClick={() => window.location.reload()}>Volver a cargar</button>
      </section>
    </main>
  );
}
