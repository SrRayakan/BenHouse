# C1.2 — Corrección de fixtures HTTP y diagnóstico de conexiones

Registro histórico del intento detenido. La reanudación autorizada y su cadena
completa están en [C1-MEDIA-REAUDIT-VALIDATION.md](C1-MEDIA-REAUDIT-VALIDATION.md).

Ejecución propia del 16 de octubre de 2026, reanudada por autorización del usuario
desde [C1-MEDIA-SHARP-REVALIDATION.md](C1-MEDIA-SHARP-REVALIDATION.md).
**Bloqueada por un fallo unitario nuevo; no está lista para reauditoría de cierre
ni commit.** Se conserva el fallo y no se repite la etapa.

## Estado recibido

Se leyeron AGENTS.md, el informe anterior y los contratos de Media, aislamiento
y pruebas. Los 53 archivos recibidos coinciden byte a byte con el manifiesto de
la entrega anterior; copia en `source-before/`. Rama `main`, HEAD, origin/main y
consulta remota en `43d250bf0918925a9b3b790426d6b74473b5e149`; staging vacío.
Remoto: `https://github.com/SrRayakan/BenHouse.git`.

Se conservan Sharp 0.35.5, su lockfile, la barrera previa al parser y el observador
corregido. No se cambia la validación productiva, `failOn`, permisos, respuestas
esperadas ni límites temporales. No hay staging, commit, push ni C1.3.

## PNG válido, preparado antes de utilizarlo

Se generó un PNG sintético RGB 1×1 de 90 bytes con Sharp 0.35.5 y se comprobó de
forma independiente el CRC de cada bloque antes de sustituir el literal de los
helpers de Media. IHDR, pHYs, IDAT e IEND coinciden; IDAT almacenado y calculado:
`636217875`. La decodificación real con `failOn: warning` devuelve 1×1, tres
canales y tres bytes raw. Evidencia: `prepare-png.cjs` y `valid-png.json`.

Se sustituye el literal corrupto en `media.integration.test.ts`. Su `beforeAll`
verifica además todos los CRC y decodifica mediante `inspectImage` antes de
crear el servidor y efectuar cargas HTTP. Las aserciones de las diez pruebas
afectadas permanecen iguales. **Todavía no se han ejecutado esas diez pruebas
sobre el cambio**, por la condición de parada descrita más abajo.

## Diagnóstico de expiración anterior a la edición

Se instrumentó el código original en memoria mediante un plugin de transformación
de Vitest, sin editar todavía el fixture de expiración. Se ejecutaron únicamente
las variantes `idle` y `absoluta`, con sus 5.000 ms originales, en una base API
efímera verificada. La sonda registra conexión, solicitud y comienzo de
transacción, solicitud y adquisición de lock, petición de sesión, bloqueo real
en PostgreSQL y liberación. Observa el rechazo de la promesa del bloqueador para
registrarlo; no cambia el resultado esperado de la sesión.

Resultado diagnóstico: `idle` agota 5.000 ms; `absoluta` pasa; ocho casos no se
seleccionan. No es una validación aprobada ni una reproducción exacta del caso
absoluto fallido anterior. Es una reproducción acotada de la demora en la misma
familia de fixtures. La consulta adicional para inspeccionar locks abre otra
conexión y aporta latencia a esa sonda; queda registrado este efecto.

Mediciones de `auth-timing.jsonl`:

- Conectar el bloqueador tarda aproximadamente 2.042 y 2.033 ms.
- Tras conectar, el comienzo de transacción tarda unos 6 y 3 ms.
- Adquirir el lock tarda unos 6 y 4 ms.
- PostgreSQL muestra la petición de sesión esperando `transactionid`, bloqueada
  por el PID del bloqueador. No se deduce bloqueo a partir de un sleep solamente.
- La primera consulta de inspección de locks consume otros aproximadamente dos
  segundos al requerir una conexión adicional. El siguiente caso ya dispone de
  esa conexión y su inspección es rápida.

Se hicieron después dos comparaciones acotadas, de lectura y sin AuthService,
con nuevas bases propias verificadas y sin cambiar los timeouts:

| Comparación | `localhost` | `127.0.0.1` |
| --- | --- | --- |
| `$connect`, primera medida | 2.047 ms | 17 ms |
| `$connect`, segunda medida | 2.030 ms | 18 ms |
| Comienzo de transacción con conexión disponible | 2–3 ms | 2–3 ms |
| Segunda transacción mientras una conexión está ocupada | P2028 a los 2.004 ms | Comienza a los 16 ms; termina a los 22 ms |

La última comparación reproduce exactamente el código y mensaje anteriores:
`P2028: Unable to start a transaction in the given time`. Mantiene los límites
por defecto y observa ambos resultados, sin rechazos no manejados. Los datos
están en `connection-timing.json` y `pool-timing.json`.

La resolución de `localhost` devuelve `::1` y `127.0.0.1`. La conexión TCP a
`::1` es rechazada; IPv4 conecta. La demora de dos segundos corresponde a abrir
conexiones Prisma mediante ese hostname en este entorno, no a adquirir el lock
una vez abierta la conexión. No se ha inspeccionado la implementación interna
del driver para atribuir el detalle exacto del retraso a un algoritmo concreto.
La comparación controla host, base, credenciales y código; solo cambia el host.
No se declara intermitencia ni se ha demostrado un defecto de semántica de
AuthService. No se acepta un 503 como resultado correcto.

## Correcciones limitadas a entorno y fixture

Después del diagnóstico se normaliza `localhost` a `127.0.0.1` exclusivamente
en la URL de la base efímera del runner API/worker. Las referencias históricas,
la conexión administrativa y `.env` se conservan. El runner sigue comprobando
nombre, OID y sistema PostgreSQL antes de migrar y después de migrar: si IPv4
resolviera a otro cluster, debe fallar sin migrarlo. No se añade fallback.

En el fixture de expiración se usa el `CausalWorkScope` existente: el rechazo
del bloqueador se observa inmediatamente y se propaga al esperar `locked`.
La limpieza libera la señal, espera los trabajos y desconecta. Esto evita el
rechazo huérfano y la espera de una señal imposible cuando la transacción no
llega a comenzar. Se conservan 700 ms de caducidad, las esperas originales,
las aserciones de sesión no autenticada, cookie y datos persistidos, y el
timeout de 5.000 ms. **La regresión dirigida posterior está pendiente.**

## Fallo formal que detiene la cadena

Antes de ejecutar HTTP se ejecutó desde cero:
`pnpm --filter @benhouse/database test`.

Resultado: **44 pasan / 1 falla**, 45 pruebas en tres archivos, código 1.
Falla el caso nuevo
`elige endpoint efímero sin alterar las referencias históricas: db.example.test`.
La política existente rechaza su `TEST_DATABASE_URL` con:
`TEST_DATABASE_URL apunta a un host no permitido por la política de pruebas.`
La excepción se produce en `with-test-database.mjs:73`, antes de crear una base.

El caso nuevo se construyó con un hostname sintético fuera de la lista permitida,
pero esperaba éxito. Es un error del fixture unitario añadido en esta ejecución;
la protección actuó correctamente. No se corrige ni se repite después del fallo,
conforme a la instrucción de parada. No se desactiva la política ni se presenta
el runner modificado como validado. Evidencia íntegra: `database-unit.log`.

El ejecutor secuencial se detuvo antes de lanzar Media y Auth. No ejecutados sobre
el código final: los diez casos Media, las regresiones de expiración corregidas,
API completa sin errores no manejados, worker sin exclusiones, persistencia en
cluster separado, integración y aislamiento de objetos, copia/restauración,
upgrade, drift, unitarias completas, lint, tipos y build. Las tres pruebas
recuperadas del worker siguen presentes, pero no se dan por ejecutadas aquí.
Ningún verde anterior cubre estas etapas.

## Huellas, limpieza y residuos

Las huellas antes/después son byte a byte idénticas:
`83dd062abcfc165c6f737da8a9c49091f0ccb24aaa9c1f0e4f36b339bdc71cf9`.
Incluyen inventario, identidad, protección, migraciones y checksums, hashes de
filas de aplicación y xmin. `benhouse` conserva OID 16384 y protección persistente
`default_transaction_read_only=on`; `benhouse_test` conserva OID 79967. Ambas
mantienen cinco migraciones, sistema `7681450735968391207`.

Las tres bases de diagnóstico fueron propias, distintas de las históricas,
verificadas y eliminadas:

- `benhouse_api_771a4e71423b4738809dac144a3ab864_test`.
- `benhouse_api_6a16aaeb50204c69967543bd59e259b2_test`.
- `benhouse_api_26ee710d1a1049adab369e1a1395c7e2_test`.

Sus servicios, redes y volúmenes RustFS también se eliminaron. El inventario
final solo contiene `init-postgres-1` (`e7b0e84a2d9b…`) y el volumen histórico
`init_benhouse-postgres-data`; no se borraron ni recrearon. `.env` conserva su
huella. No se tocan backups históricos ni se habilitan escritores de aplicación.

Permanecen los cambios sin staging y los artefactos de evidencia. No se purgan
caches ni recursos ajenos. Siguen abiertos los P2 de C1.1: detección `.tsx`/`.jsx`
y regresión de geometría inválida de `Property.location_point`.

Evidencia local:
`C:/Users/Benja/.codex/visualizations/2026/10/13/01a13719-7eb0-70d2-adca-0227d9c8a4b6/c12-http-final/`.
Incluye diagnósticos reproducibles, logs, huellas, manifiestos y copia anterior.
`c12-final.patch` entrega el diff completo contra HEAD; `resume.patch` entrega
solo esta reanudación contra los 53 archivos recibidos. C1.2 permanece bloqueada.
