# Característica 8: notificaciones push de StudentGo

Estado: implementación preparada y probada localmente. Falta desplegarla y comprobar la recepción real en un dispositivo. No se marca como comprobada solo por ver los botones o usar el botón Push de DevTools.

## Qué hace

En Avisos agrega controles para activar, desactivar y solicitar una prueba. El permiso se pide al pulsar Activar. La prueba sale del servidor tras unos 15 segundos, para poder cerrar la pestaña. Al crear una fila nueva en public.notifications, un Database Webhook envía un aviso a los dispositivos suscritos de su destinatario. Los avisos antiguos no se reenvían.

El aviso del sistema es genérico; los datos del viaje y de la credencial permanecen dentro de StudentGo. Pulsarlo abre Avisos. La suscripción se retira al cerrar sesión desde la app. Es por navegador/dispositivo, con un máximo de diez por cuenta y una prueba por minuto.

## 1. Aplicar y revisar el cambio

Desde CMD, en C:\StudentGoRepo\App_StudentGo. Si git status muestra cambios propios, guárdalos antes de cambiar de rama; no los borres.

```bat
git status --short
git switch main
git pull --ff-only origin main
git switch -c feature/notificaciones-push
```

Extrae StudentGo-notificaciones-push.patch del ZIP y cópialo a la carpeta del repositorio. El parche se preparó sobre main 7353908 (incluye los iconos corregidos). Si falla --check, no fuerces la aplicación: comparte el error para adaptar el parche a la versión actual.

```bat
git apply --check StudentGo-notificaciones-push.patch
git apply StudentGo-notificaciones-push.patch
npm ci
npm run typecheck
npm test
npm run build
```

No requiere agregar dependencias de producción al frontend. La función de Supabase importa web-push 4.0.0 y supabase-js 2.119.0. El aviso existente de Vite sobre un archivo de más de 500 kB no impide compilar; la optimización general corresponde a la característica 11.

## 2. Elegir el Supabase correcto

La app publicada y tus pruebas pueden apuntar a proyectos distintos. En Vercel, revisa el valor de VITE_SUPABASE_URL de Production; debe coincidir con la Project URL del proyecto que vas a modificar. Copia únicamente el Project Reference, no claves ni contraseñas.

Los comandos siguientes son para Supabase CLI 3, incluida por este repositorio. Sustituye TU_PROJECT_REF por la referencia correcta. Todos los comandos remotos la indican expresamente para evitar usar por accidente el proyecto de pruebas enlazado.

```bat
npx supabase --version
npx supabase login
set "STUDENTGO_PUSH_REF=TU_PROJECT_REF"
npx supabase db push --remote=%STUDENTGO_PUSH_REF% --dry-run
```

El cambio nuevo es 20261114040000_web_push.sql. Si aparecen migraciones anteriores inesperadas o un error de historial, detente y revisa esa salida antes de aplicar; no uses --include-all ni migration repair para saltar el problema.

Cuando el listado sea el esperado:

```bat
npx supabase db push --remote=%STUDENTGO_PUSH_REF%
```

Crea dos tablas privadas y dos funciones para registrar dispositivos y limitar las pruebas. No modifica las filas existentes de viajes, usuarios ni credenciales.

## 3. Generar claves y publicar la función

```bat
node scripts/generar-claves-push.mjs
npx supabase secrets set --remote=%STUDENTGO_PUSH_REF% --env-file .env.push.local
npx supabase functions deploy notificaciones-push --remote=%STUDENTGO_PUSH_REF% --no-verify-jwt --use-api
```

.env.push.local queda excluido de Git por *.local. Guárdalo en privado y no lo compartas en capturas. El generador no sobrescribe claves existentes: cambiar la clave VAPID invalidaría las suscripciones previas. Las claves privadas no llevan prefijo VITE_ y no van en Vercel ni en el navegador.

Aunque el verificador JWT del gateway se desactiva, la función valida cada usuario con auth.getUser. La ruta del webhook usa un secreto independiente y vuelve a consultar el destinatario en la base de datos. SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son variables propias del entorno de Edge Functions; no copies service_role al frontend.

## 4. Conectar los avisos reales (Database Webhook)

En el mismo proyecto de Supabase, abre Database > Webhooks y habilita la función si se solicita. Crea un webhook llamado studentgo_web_push:

- Tabla: public.notifications.
- Evento: INSERT únicamente.
- Tipo: solicitud HTTP POST.
- URL: https://TU_PROJECT_REF.supabase.co/functions/v1/notificaciones-push.
- Cabecera Content-Type: application/json.
- Cabecera x-push-hook-secret: el valor de PUSH_WEBHOOK_SECRET de .env.push.local, sin el nombre ni el signo igual.
- Si permite configurar timeout, usa 15000 ms.

Deja el cuerpo automático del Database Webhook, que contiene type, schema, table y record. No pegues una service_role como cabecera. No crees dos webhooks iguales: producirían envíos duplicados.

La prueba del botón usa la misma función pero no necesita este webhook. Por eso recibir la prueba no basta para dar por comprobado el envío automático de avisos reales.

## 5. Publicar frontend con PR

Revisa git diff y confirma solo los archivos de esta característica:

```bat
git add public/sw.js src/App.tsx src/components/NotificationsView.tsx src/components/PushSettings.tsx src/lib/push.ts scripts/generar-claves-push.mjs supabase/config.toml supabase/functions/notificaciones-push supabase/migrations/20261114040000_web_push.sql docs/PUSH.md
git diff --cached --stat
git commit -m "Agrega notificaciones web push con suscripcion por dispositivo"
git push -u origin feature/notificaciones-push
```

Crea el PR hacia main, revisa los checks y fusiona cuando corresponda. Espera el despliegue de producción de Vercel. Cierra todas las pestañas de StudentGo y vuelve a abrir la URL para activar la nueva versión del service worker. No uses Bypass for network ni Offline durante la prueba push.

Descripción sugerida del PR:

Agrega en Avisos la activación y desactivación de notificaciones por dispositivo y una prueba enviada desde Supabase tras 15 segundos. Un Database Webhook de notifications envía avisos genéricos al destinatario; pulsarlos abre Avisos. Incluye tablas privadas, validación de sesión y límites de dispositivos y pruebas. Requiere desplegar la migración y función, configurar secretos VAPID y crear el webhook según docs/PUSH.md. Validación local: TypeScript, 15 pruebas existentes, compilación y 10 pruebas de la función; recepción real pendiente de prueba en el entorno publicado.

## 6. Evidencias para comprobar la característica 8

1. Abre la app publicada, inicia sesión y entra en Avisos.
2. Pulsa Activar notificaciones y acepta el permiso. Debe indicar Activadas en este navegador.
3. Pulsa Enviar prueba en 15 segundos. Cierra la pestaña de StudentGo y deja el navegador abierto. Comprueba que el sistema muestra el aviso. Puede tardar más por la red o el dispositivo.
4. Pulsa el aviso: debe abrir StudentGo en Avisos; si la sesión terminó, primero inicia sesión.
5. Desde otra cuenta de pruebas, provoca una acción normal de la app que cree un aviso para tu cuenta, por ejemplo una solicitud de viaje. Confirma la fila en Avisos y el aviso del sistema. Usa cuentas y viajes de prueba.
6. Desactiva las notificaciones y repite el evento. El aviso debe seguir en la app, pero no llegar por push a ese navegador. Al cerrar sesión también debe retirarse la suscripción.
7. Prueba un permiso bloqueado: la app debe explicar cómo permitirlo sin impedir el resto de la navegación.

Guarda evidencia del permiso, el aviso recibido con la pestaña cerrada y el regreso a Avisos. Cuando el envío real del paso 5 también funcione, podemos documentar la 8 como comprobada.

## Si no llega

- En Avisos: revisa el mensaje de error. Un 503 puede indicar secretos o migración pendientes; un 401 pide iniciar sesión de nuevo; un 429 significa esperar un minuto.
- En Supabase > Edge Functions > notificaciones-push > Logs, busca push-test-result: accepted indica aceptación por el proveedor, no garantiza que el dispositivo lo haya mostrado. failed indica fallo de envío; expired elimina una suscripción caducada.
- Si la prueba llega y los avisos reales no, verifica que existe una fila nueva en public.notifications, que user_id corresponde al destinatario y que el webhook apunta al proyecto correcto. Revisa el historial HTTP del webhook.
- Confirma que el sistema y el navegador permiten notificaciones y que No molestar está apagado.
- En iPhone/iPad compatibles, prueba desde la web añadida a la pantalla de inicio. Esto se relaciona con la característica 9; no obliga a distribuir la app en una tienda.
- Si cambiaste claves VAPID, desactiva y vuelve a activar las notificaciones en cada dispositivo.

## Alcance y límites

No se garantiza entrega si el navegador o el sistema están detenidos, el dispositivo no tiene conexión o bloquea las notificaciones. El envío tiene TTL de 5 minutos. La prueba de 15 segundos usa una tarea en segundo plano de Edge Functions y no una cola persistente. El webhook no incorpora una cola propia de reintentos: un envío fallido se diagnostica y el aviso sigue disponible dentro de StudentGo. No se sustituyen canales de emergencia ni se envían fotos, matrículas o rutas en el payload.

Se admiten endpoints HTTPS de los servicios push de Google, Mozilla, Apple y Windows. Otros proveedores requieren ampliar explícitamente la validación. Las suscripciones caducadas se eliminan ante respuestas 404/410; se recrean al volver a activar el dispositivo.

## Validación técnica realizada

- TypeScript sin errores; 15 pruebas existentes pasaron; build de producción correcto.
- Diez pruebas Deno: sesión obligatoria, aislamiento por usuario, rechazo de destinos privados y de secretos incorrectos, límite de pruebas, baja de suscripción, destinatario consultado en BD, limpieza de endpoints vencidos, manejo de errores y cifrado/VAPID real con transporte simulado.
- Migración ejecutada en PostgreSQL embebido: propiedad de suscripción, máximo de dispositivos, cooldown, acceso privado y borrado en cascada.
- Chromium: permiso solo por clic, activar, programar prueba y desactivar con backend simulado; controles sin desbordamiento a 390 px.
- Worker: contenido genérico y URL fija al abrir un aviso; recarga offline e iconos conservados.
- No se enviaron notificaciones reales ni se modificó Supabase o Vercel durante estas pruebas.

Pruebas de función, con Deno instalado y resolución npm habilitada:

```bat
deno test --allow-env --node-modules-dir=auto supabase/functions/notificaciones-push/handler_test.ts supabase/functions/notificaciones-push/send_test.ts
```

## Deshacer

Deshabilita primero el webhook para detener los avisos automáticos. Revierte el PR mediante otro PR si se requiere. Las tablas nuevas pueden quedarse sin uso; no borres datos o claves durante un diagnóstico. Las suscripciones del dispositivo se pueden retirar con Desactivar antes de quitar la interfaz.
