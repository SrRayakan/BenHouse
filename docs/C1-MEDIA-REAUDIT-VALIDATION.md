# C1.2 — Validación final para reauditoría independiente

Ejecución propia del 16 y 17 de octubre de 2026, autorizada desde
[C1-MEDIA-HTTP-REVALIDATION.md](C1-MEDIA-HTTP-REVALIDATION.md).
**Cadena solicitada en verde; lista únicamente para nueva auditoría independiente.**
No constituye aprobación de C1.2 ni autorización de commit. No hay staging,
commit, push, despliegue sobre históricos ni avance a C1.3.

## Punto de partida y cambio limitado

Se leyeron AGENTS.md, el informe de partida y los contratos aplicables. Se
verificaron los 55 archivos recibidos contra su manifiesto SHA-256 y se conservó
una copia byte a byte. Rama `main`, HEAD, origin/main y referencia consultada en
el remoto `https://github.com/SrRayakan/BenHouse.git`:
`43d250bf0918925a9b3b790426d6b74473b5e149`. Staging vacío.

La única modificación de código de esta reanudación está en
`packages/database/scripts/with-ephemeral-test-database.test.mjs`:

- El control positivo usa `localhost` y `127.0.0.1`, ambos ya permitidos, y exige
  que la URL efímera tenga host `127.0.0.1`. Conserva las comprobaciones de
  identidad, URL administrativa y entorno original sin mutaciones.
- Un control negativo independiente usa `db.example.test` y exige la excepción
  exacta de la política antes de consultar identidad, abrir administrador,
  ejecutar procesos o emitir DDL.

El fallo anterior de 44/45 se debía a esperar éxito con un host prohibido. Se
corrige esa expectativa de fixture; no se modifica la política, su lista de
hosts, la guarda, el runner ni código productivo. Los 46 unitarios de database
pasan desde cero. No fueron necesarias otras correcciones en esta reanudación.

Se conservan todas las correcciones previas: Sharp 0.35.5 y lockfile, barrera de
cabeceras previa al parser, recorrido de chunks contra animación, observador
con controles positivos reales, PNG válido con CRC y decode comprobados,
endpoint IPv4 exclusivamente efímero y observación causal del fixture de
expiración. No se relajan `failOn`, timeouts, aserciones ni estados HTTP.

## Resultados propios sobre el código final

Las etapas de integración se ejecutaron el 16 de octubre. Antes de las
comprobaciones generales hubo una interrupción: la revisión automática de
permisos no pudo completarse por el límite de uso de la herramienta; el comando
de Prisma/build **no se ejecutó**. No fue un fallo de validación ni un rechazo
por inseguridad. Tras la orden de reanudación del día 17 se verificó otra vez
el diff: solo estaba la corrección unitaria descrita, con los otros 54 archivos
idénticos a los recibidos. Las huellas históricas seguían idénticas. Se completó
entonces la cadena pendiente sobre ese mismo código, sin reutilizar verdes de
las reanudaciones anteriores a esta entrega.

| Etapa                                        | Resultado nuevo                       | Evidencia                            |
| -------------------------------------------- | ------------------------------------- | ------------------------------------ |
| Unitarios database desde cero                | 46/46                                 | `database-unit.log`                  |
| Diez regresiones HTTP Media                  | 10/10 seleccionadas                   | `media-directed.log`                 |
| Expiración `idle` y absoluta                 | 2/2 seleccionadas                     | `auth-directed.log`                  |
| Integración API completa                     | 229/229, 13 archivos, sin omisiones   | `api-full.log`                       |
| Worker completo                              | 26/26, 2 archivos, sin omisiones      | `worker-full.log`                    |
| Persistencia en clúster separado             | 120/120, 4 archivos                   | `persistence-isolated.log`           |
| Almacenamiento unitario desde cero           | 26/26                                 | `storage-unit.log`                   |
| Objetos reales y junction Windows            | 4/4, sin omisiones                    | `storage-integration.log`            |
| Acceso anónimo/red y copia/restauración      | Todas las comprobaciones pasan        | `storage-integration.log`            |
| Upgrade C1.1 → C1.2 y drift nuevo            | Conservación de filas y xmin; drift 0 | `upgrade.log`                        |
| Drift de históricos contra esquema HEAD C1.1 | 0 en ambas bases, solo lectura        | `historical-drift.log`               |
| Prisma generate y validate                   | Código 0, esquema válido              | `db-generate.log`, `db-validate.log` |
| Build completo                               | Código 0                              | `build.log`                          |
| Lint y tipos completos                       | Código 0 en ambos                     | `lint.log`, `typecheck.log`          |
| Unitarios generales finales                  | 329/329                               | `test.log`                           |

Los 329 unitarios son config 1, domain 38, storage 26, database 46, API 212 y
worker 6. El paquete web no tiene archivos de pruebas y usa su configuración
existente `passWithNoTests`; no se contabiliza como cobertura. Las selecciones
dirigidas dejaron 17 y 8 casos sin seleccionar, respectivamente; después la API
completa ejecutó todos, sin exclusiones. Los 46 y 26 unitarios dirigidos se
incluyen otra vez en los 329, no se suman como casos distintos.

Las diez pruebas de Media alcanzan sus aserciones de E2E privado/idempotencia,
revocación organizativa, logout/revocación de Property, ordenación y archivo,
cancelación frente a confirmación, rollback y reintento, caducidad durante
lectura, fallo posterior a escritura, revocación concurrente y constraints de
identidad/estado. El `beforeAll` comprueba CRC de todos los chunks del PNG y
decodificación real antes de cargarlo.

Las expiraciones dirigidas tardan 1.011 ms (`idle`) y 982 ms (absoluta), sin
aumentar el timeout de 5.000 ms ni los 700 ms de caducidad. API completa termina
en 92,67 s. Se revisaron los logs de regresiones e integración: **sin P2028 ni
rechazos/errores no manejados**. Las trazas P2010/40001 de carreras de organización
son conflictos de serialización esperados y reintentados, con aserciones finales
aprobadas; no son errores no manejados.

El worker ejecuta expresamente `PENDING_FUTURE`, `PROCESSING_LEASE` e
`INSERTED_LATER`, conservando sus aserciones de contenido y xmin. Utiliza dos
bases propias con OID distintos, nunca `benhouse_test`. También pasan limpieza
concurrente, conservación de READY/ARCHIVED, cancelación, reintentos y rollback.

## Almacenamiento y migraciones

Los controles positivos observan las llamadas reales a Sharp para JPEG, PNG y
WebP; los negativos SVG, GIF, TIFF y AVIF no lo invocan. También se rechazan
APNG, APNG con segundo frame inválido y WebP/GIF animados. La API completa
incluye sus rechazos por HTTP sin READY, y los tres formatos estáticos válidos.
No se utilizaron exploits ni se afirma explotación o RCE.

Comprobación nueva del binario cargado por storage y Next: misma resolución de
Sharp 0.35.5, libvips 8.18.7, librsvg 2.63.2 y libheif 1.23.5 en Windows x64,
Node 24.19.0 (`native-versions.json`). La investigación de avisos y compatibilidad
previa permanece en [C1-MEDIA-SHARP-VALIDATION.md](C1-MEDIA-SHARP-VALIDATION.md);
no se presenta como una nueva auditoría completa de dependencias.

El ensayo real verifica GET/PUT/DELETE/listado anónimos y firma incorrecta
rechazados, puerto inaccesible desde interfaces no-loopback, volumen exclusivo
sin web, PUT interrumpido sin objeto parcial, inmutabilidad concurrente y la
junction `private-alias → public` y su sustitución durante PUT sin bytes en
carpetas públicas. La copia persiste en un tercer volumen propio y restaura
cuatro objetos en otro servicio nuevo: conjunto, bytes y SHA-256 idénticos.
Una copia corrupta se rechaza antes de escribir.

La persistencia corre en un clúster con sistema `7697311030472040486`, diferente
del histórico `7681450735968391207`, puerto loopback 58162 y volumen propio
`benhouse-c12-pg-dcbc539c-9b8b-4c77-aaf1-7fbaf3439d14-data`. Aunque su base se
llama `benhouse_test`, es físicamente distinta; se verifica antes de migrarla.
Se aplican las seis migraciones, status actualizado y drift cero. Se elimina
ese contenedor, red y volumen tras verificar identidad.

El upgrade usa otra base propia y conserva las cinco migraciones previas y
cuatro filas sintéticas con su contenido y xmin; `mediaVersion=0`, Media vacía,
drift cero. Ninguna migración C1.2 se aplica a una base histórica. Los archivos
de las cinco migraciones históricas se comparan con HEAD y no cambian.

## Huellas, residuos y límites

`before.json`, `after-pause.json` y `after.json` coinciden byte a byte. SHA-256:
`83dd062abcfc165c6f737da8a9c49091f0ccb24aaa9c1f0e4f36b339bdc71cf9`.
Incluyen identidad e inventario de bases, protección persistente, migraciones y
checksums, hashes de filas de aplicación y xmin. `benhouse` mantiene OID 16384
y `default_transaction_read_only=on`; `benhouse_test`, OID 79967. Ambas mantienen
cinco migraciones y el sistema histórico. `.env` conserva su hash.

Solo queda el contenedor histórico `init-postgres-1` (`e7b0e84a2d9b…`) con el
volumen `init_benhouse-postgres-data`; no se borraron ni recrearon. No quedan
bases, contenedores, redes ni volúmenes efímeros propios. Se conservan las
imágenes Docker descargadas, caches/artefactos de compilación y evidencia local;
no se purgan recursos ajenos ni backups históricos. El build regeneró la ruta
de tipos en `next-env.d.ts`: se verificó ese único cambio generado y se repuso
la copia byte a byte previa antes de typecheck; no forma parte del diff.

Avisos registrados: Prisma propone una versión mayor, sin actualizarla; el SDK
S3 emite `An error was encountered in a non-retryable streaming request` en la
prueba que aborta intencionadamente PUT. Esa prueba exige AbortError, ausencia
del objeto parcial y reintento correcto; pasa. No se ocultan fallos mediante
timeouts o respuestas HTTP alternativas.

Se mantienen los límites de [operación de objetos](C1-MEDIA-OBJECTS-OPERATIONS.md):
Docker Desktop puede permitir TCP entre contenedores pese a ICC; la protección
de datos comprobada es autenticación. El administrador de Docker/host y el
backend con credenciales son confiables, fuera del adversario cubierto. HTTP
solo en loopback, sin TLS remoto, alta disponibilidad ni réplica. El restore
ensayado es de objetos sintéticos, no recuperación coordinada de toda BenHouse
ni protección frente a pérdida física del host. No se despliega un servicio
persistente ni se habilitan escritores de aplicación sobre históricos.

Siguen **abiertos** los dos P2 de C1.1: detección de suites `.tsx`/`.jsx` y
regresión de geometría inválida de `Property.location_point`. No se amplía el
alcance a C1.3, vídeos, documentos privados ni editor completo.

## Entrega exacta

Evidencia de esta ejecución:
`C:/Users/Benja/.codex/visualizations/2026/10/13/01a13719-7eb0-70d2-adca-0227d9c8a4b6/c12-reaudit-final/`.

- `c12-final.patch`: diff completo contra HEAD, incluidos archivos nuevos.
- `resume.patch`: solo esta corrección unitaria y documentación, frente a los
  55 archivos recibidos, preservados en `source-before/`.
- `tree-before.json`, `tree-after.json` y `git.json`: manifiestos por archivo,
  hashes de los patches, Git y verificación de migraciones históricas.
- Logs de la tabla, helpers reproducibles, huellas y `resources-after.json`.

Los informes de fallos anteriores se conservan como historial. No hay nueva
incidencia de validación productiva ni P0/P1 descubierto en esta ejecución.
El siguiente paso es exclusivamente la auditoría independiente del diff final.
