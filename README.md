# Student Go

Aplicación React + TypeScript + Vite. Usa Supabase para autenticación,
base de datos y archivos. Clonar el repositorio no copia la configuración
local, las cuentas de usuario ni los datos de Supabase.

## Requisitos

- Node.js 22.12+ (requerido por las versiones actuales de Vite y Supabase).
- npm y acceso al proyecto Supabase de pruebas.
- Internet para Supabase, mapas y rutas.

## Ejecutar el entorno de pruebas

Desde la carpeta del proyecto, instala las versiones del archivo de bloqueo:

```powershell
npm ci
```

Si todavía no existe `.env.pruebas.local`, créalo a partir del ejemplo:

```powershell
Copy-Item .env.pruebas.example .env.pruebas.local
```

Completa ese archivo con los valores del proyecto **student-go-pruebas**:

```dotenv
STUDENT_GO_TEST_PROJECT_REF=identificador_del_proyecto
VITE_SUPABASE_URL=https://identificador_del_proyecto.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=clave_publica_del_proyecto
```

El identificador es la parte de la URL anterior a `.supabase.co`. La URL y la
clave pública se obtienen desde Connect o Settings → API Keys en Supabase.
También se admite `VITE_SUPABASE_ANON_KEY` para proyectos con la clave `anon`
anterior. Usa únicamente claves públicas en variables `VITE_`; los secretos
de servidor y las claves `service_role` no pertenecen al frontend.

```powershell
npm run dev:pruebas
```

Abre **http://localhost:5173**. El puerto está fijado para que coincida con el
origen autorizado de las passkeys. Si está ocupado, usa el servidor existente
o detén esa instancia antes de iniciar otra.
Para detener el servidor, pulsa `Ctrl+C`.

`dev:pruebas` valida el archivo antes de arrancar y rechaza el identificador de
producción conocido por el repositorio. Para validar sin iniciar el servidor:

```powershell
node scripts/verify-test-supabase.mjs
```

### Si usas `npm run dev`

Este comando utiliza el modo `development`, por lo que no lee
`.env.pruebas.local`. Configura los mismos valores en `.env.local`, o usa
`npm run dev:pruebas`.

En esta copia de trabajo se configuraron ambos archivos locales para permitir
los dos comandos. Si cambias de proyecto o rotas la clave, actualiza ambos.
Los archivos `*.local` están excluidos de Git. Reinicia Vite después de cambiar
las variables. Para evitar una configuración distinta a la esperada, no
sobrescribas estas variables desde la terminal.

## Verificaciones

```powershell
npm run typecheck
npm run lint
npm test
npm run build:pruebas
```

Las pruebas unitarias no requieren credenciales ni escriben en Supabase.
`npm run preview` permite revisar el último build generado.

## Huella, rostro y claves de acceso

La pantalla de acceso permite entrar con una passkey, sin escribir correo ni
contraseña. Después de iniciar sesión se ofrece activarla; también puede hacerse
en **Perfil → Acceso con huella o rostro** (administradores: **Configuración**).
La contraseña continúa disponible como alternativa.

Antes de probar, habilita Passkeys en el proyecto remoto. Cambiar
`supabase/config.toml` solo configura Supabase local.

```powershell
npm run check:passkeys
```

La [guía de passkeys](docs/PASSKEYS.md) incluye la configuración exacta para
localhost, una dirección HTTPS estable para celulares, la asociación con las
cuentas de Supabase, pruebas manuales y los límites de la biometría y la IA.

## Qué se necesita para las pruebas funcionales

- Una cuenta existente en **Authentication → Users** del proyecto de pruebas,
  o registrarse desde la aplicación. Las cuentas de producción no se copian al
  proyecto de pruebas. Si está activada la confirmación de correo, hay que
  confirmar la cuenta para entrar.
- El esquema de `supabase/migrations` debe estar aplicado en ese proyecto.
  El repositorio contiene tablas, funciones, permisos y configuración de
  almacenamiento. Si creas un Supabase nuevo, verifica y aplica sus migraciones
  antes de probar viajes, documentos o perfiles; la clave pública no crea el
  esquema automáticamente.
- El panel administrativo requiere un perfil con rol `ADMIN`. Los flujos de
  conductor requieren la aprobación que establece la aplicación.
- WhatsApp requiere configurar y desplegar por separado las funciones
  `whatsapp-send`, `whatsapp-dispatch` y `whatsapp-webhook`, sus secretos y el
  programador de `supabase/whatsapp/setup-scheduler.sql`. La configuración del
  frontend no configura estos servicios. No es necesario para mostrar el login.
- Cámara y ubicación requieren permisos del navegador. Prueba en `localhost`
  o en una dirección HTTPS.

Los scripts `scripts/provision-test-*.mjs` y los de integración pueden crear o
modificar datos. No se ejecutan automáticamente al arrancar la aplicación.

## Pantalla en blanco después de clonar

El cliente de Supabase se crea al cargar los módulos de la aplicación. Si faltan
las variables, ese proceso falla antes de montar la interfaz. El arranque ahora
captura ese fallo y muestra un mensaje; en desarrollo incluye los pasos de
configuración. Si el mensaje menciona los valores de ejemplo, reemplázalos por
los datos reales y reinicia Vite.

Si Authentication responde pero las tablas devuelven `permission denied` antes
de iniciar sesión, comprueba primero el acceso con una cuenta válida: las
migraciones restringen los datos privados a usuarios autenticados.

Referencias: [variables y modos de Vite](https://vite.dev/guide/env-and-mode.html)
y [claves API de Supabase](https://supabase.com/docs/guides/getting-started/api-keys).

Consulta la [innovación de tarifas con IA](docs/innovacion-tarifas-ia.md) para conocer su cálculo, seguridad, despliegue y limitaciones.
