# Acceso con huella, rostro o PIN

## Qué está implementado

- Acceso sin escribir correo ni contraseña mediante una passkey previamente registrada.
- Invitación para activar una clave después del primer acceso con una cuenta confirmada.
- Alta, cambio de nombre y eliminación de claves desde Perfil; los administradores
  las administran en Configuración.
- Comprobación de compatibilidad, cancelación y mensajes de error en español.
- Contraseña disponible como método alternativo.

El usuario pulsa **Activar en este dispositivo** y acepta la solicitud del sistema.
En accesos posteriores pulsa **Entrar con huella, rostro o PIN**. No se pide permiso
de cámara ni acceso a imágenes o plantillas biométricas.

La invitación se ofrece si el navegador es compatible, Supabase permite consultar
las claves y la cuenta todavía no tiene ninguna. Elegir «Ahora no» guarda una
preferencia local; siempre puede activarse después desde el perfil. Si la cuenta
necesita confirmar correo, primero debe hacerlo e iniciar sesión.

## 1. Activar Supabase para localhost

En el proyecto **student-go-pruebas**, abre **Authentication → Passkeys**:

| Campo | Valor |
| --- | --- |
| Enable Passkey authentication | Activado |
| Relying Party Display Name | `Student Go` |
| Relying Party ID | `localhost` |
| Relying Party Origins | `http://localhost:5173` |

Guarda los cambios. Para estas pruebas abre la app usando exactamente
`http://localhost:5173`, sin sustituirlo por `127.0.0.1` ni la IP de la computadora.
El RP ID no lleva protocolo, puerto ni ruta; Origins sí incluye el puerto.

En **Authentication → URL Configuration**, configura Site URL como
`http://localhost:5173` y autoriza esa dirección para confirmaciones de correo.

```powershell
npm run check:passkeys
npm run dev:pruebas
```

Si Vite ya está ejecutándose, no necesitas iniciar una segunda instancia.
`check:passkeys` consulta la configuración pública y, si está habilitada, pide un
reto descartable para comprobar el RP ID. No crea usuarios, sesiones ni claves.
La lista de Origins no es pública: revísala en el panel.

La clave `VITE_SUPABASE_PUBLISHABLE_KEY` permite usar la aplicación pero no cambiar
la configuración de autenticación. Esa activación requiere acceso al panel de
Supabase. El archivo `supabase/config.toml` solo aplica a una instancia local;
no modifica automáticamente el proyecto hospedado.

## 2. Probar desde Samsung, iPhone u otra computadora por HTTPS

Para conservar las mismas passkeys entre sesiones de pruebas, usa el dominio de
desarrollo estable de una cuenta de **ngrok**. Instala el agente para Windows desde
[la guía oficial](https://ngrok.com/docs/start) y configura su authtoken según esa
guía. El authtoken se configura en ngrok, no en las variables `VITE_`.

Obtén el dominio asignado desde tu panel ngrok. En este ejemplo se representa
como `tu-dominio-asignado.ngrok-free.dev`; reemplázalo por el dominio real.

En una terminal PowerShell, desde el proyecto, permite únicamente ese hostname:

```powershell
$env:__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = 'tu-dominio-asignado.ngrok-free.dev'
npm run dev:pruebas
```

Si había un Vite iniciado, detenlo con `Ctrl+C` antes de este comando para que
reciba la variable. En otra terminal inicia el túnel:

```powershell
ngrok http 5173
```

Usa la URL HTTPS que muestre ngrok. Mantén ambas terminales abiertas. Si ngrok
muestra una pantalla intermedia de visita, continúa hacia la aplicación.

Actualiza **Authentication → Passkeys** en Supabase:

| Campo | Ejemplo; sustituir por el dominio asignado |
| --- | --- |
| Relying Party Display Name | `Student Go` |
| Relying Party ID | `tu-dominio-asignado.ngrok-free.dev` |
| Relying Party Origins | `https://tu-dominio-asignado.ngrok-free.dev` |

Configura también esa URL HTTPS en **Authentication → URL Configuration → Site
URL** y Redirect URLs para los correos de confirmación. La PWA sigue conectándose
al mismo proyecto mediante las variables de `.env.pruebas.local`.

Ahora abre **esa misma URL HTTPS en el teléfono y en la computadora**. Si deseas,
instala la PWA desde el navegador y activa una clave desde el dispositivo.

```powershell
npm run check:passkeys -- https://tu-dominio-asignado.ngrok-free.dev
```

**El RP ID debe mantenerse estable.** Pasar de `localhost` al dominio HTTPS hace
que las claves registradas para localhost no sirvan en el nuevo dominio. Las
cuentas permanecen: entra con contraseña y registra una nueva clave. Un mismo
RP ID no puede cubrir a la vez localhost y un dominio ajeno; al usar el túnel,
prueba las passkeys siempre desde su URL HTTPS. No uses dominios temporales que
cambien cada vez que reinicias el túnel para pruebas persistentes.

La cuenta ngrok y el dominio aún deben ser configurados por el propietario; este
cambio no publica la aplicación ni abre automáticamente un túnel.

## 3. Asociación con cuentas y prueba funcional

Supabase guarda la credencial pública asociada al usuario autenticado. Al entrar,
el dispositivo firma un reto nuevo y Supabase verifica la firma y establece la
sesión de esa cuenta. La app usa esa sesión con las mismas políticas y roles
existentes. No se guardan contraseñas ni tokens como sustituto de la passkey.

1. Entra con una cuenta confirmada del entorno de pruebas.
2. Acepta la invitación o abre Perfil → Acceso con huella o rostro.
3. Pulsa Activar en este dispositivo y completa la solicitud del sistema.
4. Cierra sesión y pulsa Entrar con huella, rostro o PIN, dejando vacíos correo
   y contraseña. Debe abrirse la misma cuenta.
5. Cancela una solicitud: debes permanecer fuera de la cuenta y poder usar la contraseña.
6. Quita una clave desde Perfil, cierra sesión e intenta reutilizarla. Debe fallar.
7. Repite en cada dispositivo real y en la PWA instalada. Una clave puede
   sincronizarse mediante el gestor del usuario; no equivale necesariamente a un
   único aparato físico.

El sistema puede ofrecer huella, Face ID/Touch ID, Windows Hello, PIN, una llave
o un teléfono cercano. La PWA no selecciona obligatoriamente rostro o huella ni
puede garantizar que el reconocimiento facial de todos los modelos Samsung sea
admitido. Se requiere configurar el bloqueo del dispositivo y usar un navegador
compatible. Una visita a `http://192.168.x.x:5173` desde el celular no sustituye HTTPS.

## Biometría, IA y rendimiento

Las plantillas de rostro y huella pertenecen al autenticador del sistema y no se
entregan a JavaScript. Por eso no se entrenó un modelo biométrico ni se recolectan
rostros o huellas. El aprendizaje y la velocidad del sensor dependen del sistema
operativo, su hardware y las condiciones de uso; entrenar una IA de la aplicación
no permite acelerar ese reconocimiento.

La mejora implementada elimina escribir credenciales y usa la verificación del
dispositivo. No se reducen verificaciones con el uso ni se reutilizan retos para
intentar acelerar el acceso. Un modelo separado para analizar tiempos requeriría
datos de rendimiento y una finalidad definida; no reemplazaría la autenticación.

## Detalles de implementación y límites

- `src/lib/passkeyClient.ts` usa retos y verificación de Supabase, y SimpleWebAuthn
  para comunicarse con el navegador. Solicita `userVerification: required` en alta
  y acceso; el PIN del sistema también satisface esa verificación.
- La sesión solo se acepta después de la respuesta del servidor. La preferencia
  de mostrar la invitación en localStorage no otorga acceso.
- El servidor estándar de Supabase consultado usa `preferred` como política
  predeterminada de WebAuthn. El requisito `required` que añadimos corresponde a
  este cliente; no es una política global de MFA ni garantiza una modalidad
  biométrica específica frente a otros clientes de la API. Exigirlo globalmente
  requeriría soporte o cambios en el servidor de autenticación.
- No se solicitan permisos biométricos al cargar la página: la ceremonia empieza
  mediante una acción explícita, compatible con los requisitos de los navegadores.
- Las pruebas unitarias no se conectan a Supabase. La activación remota y las
  comprobaciones con sensores físicos son necesarias para validar cada plataforma.

## Verificación realizada

- TypeScript, ESLint y compilación del entorno de pruebas: correctos.
- 15 pruebas unitarias: correctas, incluidas cancelaciones, retos nuevos y rechazo
  de respuestas de autenticación incompletas o fallidas.
- Chrome con autenticador virtual: alta, cambio de nombre, cierre de sesión,
  acceso sin contraseña, revocación y cancelación comprobados. Estas pruebas
  usaron respuestas de cuenta aisladas y verificación criptográfica de las firmas;
  no crearon cuentas ni credenciales en el Supabase remoto.
- Navegador sin WebAuthn y vista móvil: alternativa de contraseña disponible.
- Proyecto remoto consultado: `passkeys_enabled=false`. Es necesario activarlo
  con los pasos anteriores. No se ha validado todavía una ceremonia completa
  contra ese proyecto ni con sensores físicos Samsung, Apple o Windows Hello.

Referencias: [Supabase Passkeys](https://supabase.com/docs/guides/auth/passkeys),
[WebAuthn](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API),
[dominios de ngrok](https://ngrok.com/docs/gateway/domains) y
[política del servidor Supabase](https://github.com/supabase/auth/blob/master/internal/api/passkey_webauthn.go).
