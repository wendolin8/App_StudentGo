# Innovación de tarifas individuales con IA

## Problema

El precio que se mostraba para un viaje representaba el recorrido completo. Un pasajero que bajaba antes podía terminar viendo una tarifa que no correspondía a la distancia y al tiempo de su tramo. Esta innovación calcula una cotización para cada pasajero según su punto de bajada.

## Flujo completo

1. El pasajero abre un viaje y elige su punto de bajada con `DropoffPicker`.
2. La aplicación envía el viaje y el punto a la Edge Function `calculate-fare`.
3. La función autentica al usuario y consulta el viaje, la configuración de tarifas y los asientos ocupados.
4. El servidor obtiene con OSRM la ruta completa y la ruta desde el origen hasta el punto de bajada. Comprueba que el punto no se aleje demasiado del recorrido.
5. Calcula la fórmula base y, si Gemini produce una sugerencia válida, limita su ajuste a ±20%.
6. Firma con HMAC una cotización que contiene usuario, viaje, punto de bajada, métricas del tramo, tarifa, fuente, desglose y vencimiento a 10 minutos. La aplicación muestra esa tarifa y conserva el token firmado.
7. Al confirmar, la aplicación manda el token a `request-trip`. Esta función valida firma, usuario y vencimiento, y envía los datos firmados a la RPC `request_trip_with_dropoff`. No vuelve a llamar a Gemini ni recalcula la tarifa.
8. La RPC inserta la solicitud y sus datos individuales; la respuesta devuelve el identificador y la misma tarifa firmada.

Así, la tarifa que se muestra en la cotización oficial es la tarifa que se registra en la solicitud. El token es firmado, no cifrado: su contenido no debe tratarse como secreto.

## Cálculo en dos capas

La primera capa es determinista. `calculateFormulaFare` calcula la parte proporcional de la tarifa base según la distancia del pasajero respecto al recorrido total, y suma distancia, tiempo y gasolina. Aplica los mínimos, máximos y redondeo configurados.

La segunda capa es una sugerencia de Gemini para ajustar la fórmula, no para sustituirla ni calcular un precio libremente. El servidor valida la respuesta y acota el porcentaje a −20%…+20%; después aplica también los límites de tarifa. Si falta la llave, Gemini devuelve un error HTTP, falla la llamada o la respuesta no es válida, se conserva la tarifa de fórmula con `fare_source: 'formula'`. Los errores HTTP de Gemini registran el estado sin registrar la llave.

`calculate-fare` lee la llave compartida `GEMINI_API_KEY` y su modelo propio `FARE_GEMINI_MODEL`, cuyo valor predeterminado es `gemini-3.6-flash`. La función de credenciales `analizar-credencial` también lee `GEMINI_API_KEY`, pero su modelo configurable es `GEMINI_MODEL` y su código usa `gemini-3.8-flash` como valor predeterminado. No configures `GEMINI_MODEL` para controlar tarifas: dejar separados los nombres evita cambiar el modelo de credenciales al ajustar tarifas. Se puede compartir `GEMINI_API_KEY` si se desea usar la misma llave.

## Seguridad

- `calculate-fare` vuelve a calcular en el servidor las rutas del viaje y del pasajero con OSRM; no acepta del navegador las distancias o el precio como autoridad.
- El HMAC usa `FARE_QUOTE_SECRET`, debe tener al menos 32 bytes y solo se configura como secreto de Edge Functions. La cotización está ligada al usuario autenticado y caduca a los 10 minutos.
- `request-trip` autentica la sesión y comprueba que el usuario coincida con el de la cotización antes de usar sus valores.
- La migración `20261109100000_individual_trip_request_fares.sql` define `request_trip_with_dropoff` como `SECURITY DEFINER`, restringe su ejecución a `service_role` y revoca el `INSERT` directo de `anon` y `authenticated` en `trip_requests`.
- La RPC valida campos, disponibilidad y duplicados, pero la firma y la autenticación se comprueban en la Edge Function antes de invocarla.
- La RPC considera duplicada cualquier solicitud previa del mismo pasajero para el mismo viaje, incluso si quedó `CANCELLED` o `REJECTED`. Actualmente no permite volver a solicitar ese viaje con esos estados.
- En `supabase/config.toml`, `calculate-fare` y `request-trip` usan `verify_jwt = false` porque los handlers validan el bearer token con Supabase. `analizar-credencial` no tiene una entrada explícita ahí; su handler también valida el bearer y obtiene el usuario antes de procesar las fotos.
- `public/sw.js` solo cachea recursos estáticos explícitos del app shell. Ignora métodos que no sean GET y orígenes distintos al de la aplicación; las invocaciones POST a funciones de Supabase no entran en ese caché.

## Sin conexión

Si no se puede obtener una cotización del servidor, la interfaz calcula y muestra una estimación local aproximada con fórmula y valores locales. Esa estimación no tiene token firmado y no crea una solicitud. Para continuar, el pasajero necesita conexión: la aplicación pide una cotización oficial; si el importe difiere de la estimación mostrada, debe revisarlo y solicitar de nuevo para aceptar la tarifa actualizada.

## Secretos y configuración

Configura para las funciones de tarifas:

- `GEMINI_API_KEY`: llave de Gemini; puede compartirse con `analizar-credencial`.
- `FARE_GEMINI_MODEL`: modelo para tarifas, por ejemplo `gemini-3.6-flash`; si se omite, ese es el valor predeterminado.
- `FARE_QUOTE_SECRET`: secreto aleatorio de al menos 32 bytes para firmar y validar cotizaciones.

No reemplaces ni reutilices `GEMINI_MODEL` para configurar tarifas: esa variable corresponde a `analizar-credencial`. No pongas estos secretos en variables `VITE_*` ni en archivos versionados con valores reales.

## Orden de despliegue

1. **Pendiente de probar contra Supabase real:** revisar qué migraciones están aplicadas en el proyecto destino y aplicar en orden las que falten, incluida `20261109100000_individual_trip_request_fares.sql`.
2. Registrar `GEMINI_API_KEY`, `FARE_GEMINI_MODEL` y `FARE_QUOTE_SECRET` como secretos de Supabase. Si ya existe `GEMINI_API_KEY` para credenciales, conservarla; no modificar `GEMINI_MODEL`.
3. Desplegar `calculate-fare` y `request-trip` con la configuración versionada en `supabase/config.toml`.
4. **Pendiente de probar contra Supabase real:** validar autenticación, llamadas a OSRM y Gemini, creación con la RPC, permisos, restricciones de duplicados y vencimiento de cotizaciones en el proyecto destino.

## Pruebas y limitaciones

Las pruebas unitarias locales cubren la fórmula y límites del ajuste de IA, además de cotización firmada válida, firma alterada, vencimiento y usuario diferente. Typecheck y lint son comprobaciones estáticas; no prueban servicios desplegados.

**Pendiente de probar contra Supabase real:** que las migraciones estén instaladas y que las funciones desplegadas, los secretos, permisos, autenticación, rutas OSRM, Gemini y RPC se comporten correctamente en el proyecto. Los scripts de integración disponibles no sustituyen esta comprobación si no se ejecutan contra un proyecto de pruebas real.

Las tarifas dependen de la disponibilidad y precisión de OSRM y, para el ajuste opcional, de Gemini. La estimación offline usa datos locales y no equivale a una cotización confirmada. Una vez vencido el token, el pasajero debe solicitar una nueva cotización. El diseño de duplicados actual impide reintentos tras una solicitud cancelada o rechazada.
