# C1.2 — Correcciones para nueva auditoría independiente

Ejecución nueva: 14–15 de octubre de 2026. **C1.2 continúa bloqueada para commit
hasta la nueva auditoría independiente.** No hay staging, commit, push ni C1.3.
Este informe sustituye los resultados vigentes de C1-MEDIA-VALIDATION.md; aquel
documento se conserva como registro histórico, con sus omisiones y fallos.

## Punto de partida conservado

Se leyeron AGENTS.md, los contratos aplicables de docs, AUDITORIA-C1.2.md y
REVISION-C1.2-BLOQUEADA.md. Antes de editar se verificaron remoto, rama main,
HEAD y origin/main `43d250bf0918925a9b3b790426d6b74473b5e149`, staging vacío y
los 32 archivos del diff auditado, idénticos a su inventario SHA-256. Se conservaron
esos archivos; la sustitución autorizada modifica su implementación, no elimina
el trabajo de dominio. Se verificaron identidades de ambas bases, huellas y
recursos Docker antes de crear ningún recurso propio.

La decisión previa está en [C1-MEDIA-OBJECTS-DECISION.md](C1-MEDIA-OBJECTS-DECISION.md).
Se consultaron licencia, release y requisitos oficiales de RustFS 1.0.1,
Apache-2.0. No exige compra para este uso. Imagen y cliente S3 están fijados;
no se guarda ninguna excepción a la política de antigüedad de dependencias.

## Correcciones sometidas a auditoría

**P1 de animación.** El fixture APNG sintético reproduce `metadata.pages ===
undefined` con Sharp 0.34.5. Se inspeccionan chunks PNG reales y se rechazan acTL,
fcTL y fdAT, además de decodificar completamente las imágenes estáticas. WebP
rechaza ANIM/ANMF y el bit de animación VP8X; también se comprueba pages cuando
existe. GIF está fuera de la lista permitida y se rechaza incluso camuflado como
PNG. Regresiones: APNG válido, APNG con segundo frame inválido, WebP animado y
GIF animado; JPEG/PNG/WebP estáticos siguen funcionando.

HTTP comprueba cada fixture animado en PUT y confirmación: rechazo, ninguna fila
READY, objeto ausente tras el PUT rechazado. También inyecta los bytes inválidos
directamente en S3 para acreditar que confirmación vuelve a inspeccionar el
contenido y no confía en el paso anterior. Los tres formatos estáticos completan
el flujo y su descarga privada conserva exactamente los bytes originales.

**P1 de rutas públicas y carreras.** Se elimina LocalStorageProvider. No se
presenta realpath ni una comprobación de junctions como solución. API/worker
solo intercambian bucket/key mediante S3 autenticado en loopback. RustFS usa un
volumen Docker Linux nuevo y exclusivo, sin bind mounts y sin montaje en web,
API ni worker. STORAGE_PROVIDER=local falla cerrado.

La regresión Windows crea una junction real `private-alias → public` y sustituye
un directorio antecesor por otra junction justo al enviar PUT: el objeto se
almacena en S3 y las carpetas públicas/retiradas siguen vacías. La seguridad
depende de haber eliminado esas rutas del flujo de escritura, no de ganar la
carrera. Se comprueban el montaje exclusivo, puerto solo 127.0.0.1, consola
desactivada, falta de acceso por interfaces no-loopback, GET/PUT/DELETE/listado
anónimos 403 y firmas incorrectas 403. Desde sondas en otras redes Docker no se
pueden leer, sustituir ni borrar objetos sin credenciales.

Se preservan PROPERTY_EDIT, sesión/CSRF, TTL con reloj PostgreSQL, revocación,
idempotencia, validación de bytes/tamaño/MIME/digest/recurso, auditoría, posiciones
y versión, archivo y limpieza durable. PUT S3 condicional evita sobrescrituras:
16 consumidores/2 instancias con cuerpos distintos producen un único ganador y
15 conflictos; reintentos de bytes idénticos funcionan. PUT interrumpido produce
AbortError, no deja objeto visible y admite reintento. Un rollback SQL y los
reintentos de limpieza se ejercitan con PostgreSQL y S3 reales.

**Worker recuperado.** Su runner crea y migra dos bases efímeras distintas,
verifica nombre/OID/system identifier y conserva esos datos para limpiar sin
FORCE. PENDING_FUTURE, PROCESSING_LEASE e INSERTED_LATER vuelven a ejecutarse sin
filtros. Conservan las aserciones de fila completa y xmin; verifican identidad
antes de escribir y antes de limpiar la sonda ajena. Una prueba adicional
ejercita el ciclo real que procesa limpieza Media e invitaciones conjuntamente.

## Resultados nuevos sobre el código final

No se atribuyen a esta versión los 304 unitarios, 218 API ni 22 worker con tres
omisiones de la entrega anterior. Los registros de esta ejecución están en el
directorio local de evidencias `c12-objects-final` indicado al final.

| Comprobación                                | Resultado nuevo                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                 | 313 aprobados: web 1, config 38, storage 13, database 43, API 212, worker 6                                 |
| Storage real, aislamiento y restore         | 4/4 pruebas más sondas de privacidad y copia/restauración aprobadas                                         |
| API HTTP completa                           | 225/225 aprobados en 13 suites, incluidos los 23 casos HTTP de Media; api-release.log                       |
| Worker completo                             | 26/26 aprobados, sin omisiones; las tres recuperadas constan individualmente en worker-release.log          |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | Aprobados en esta revisión                                                                                  |
| `pnpm db:generate`, `pnpm db:validate`      | Prisma 6.19.1 generado y esquema válido                                                                     |
| Migraciones desde vacío                     | Las seis aplicadas en cada base efímera de API y worker                                                     |
| Upgrade                                     | Cinco migraciones previas y cuatro filas sintéticas conservan contenido y xmin; mediaVersion=0, Media vacía |
| Drift C1.2                                  | 0 en la base efímera de upgrade                                                                             |
| Drift histórico y huellas finales           | Drift 0 frente a HEAD; snapshots antes/después idénticos byte a byte                                        |

El comando global antiguo `test:integration` no se ejecuta porque su primer paso
migra la base histórica compartida. Se utilizan las suites completas de API y
worker mediante los runners aislados, además de storage y upgrade. No se aplica
la migración C1.2 a `benhouse` ni `benhouse_test` históricos.

Además, **120/120 pruebas de persistencia** pasan en un segundo servidor
PostgreSQL efímero, sin cambiar sus aserciones. Las suites antiguas exigen el
nombre literal `benhouse_test`; se usa ese nombre únicamente dentro del servidor
nuevo. La identidad física comprobada es system identifier `7696785085307568166`,
OID 16384, puerto loopback 53611, distinta del histórico
`7681450735968391207`/79967/5432. Se usó la imagen PostGIS local ya instalada por
su ID, un volumen nuevo exclusivo y credenciales aleatorias en memoria. Las seis
migraciones, migrate status y drift=0 pasan allí. El script
`database-cluster-validation.mjs` y `database-cluster.log` acreditan la creación,
identidades y eliminación de contenedor/red/volumen. No se cambia la barrera de
esas suites ni se dan por resueltos los dos P2 de C1.1.

Los logs `*-release.log` corresponden a la última cadena completa, repetida tras
el ajuste final del runner. Los logs sin ese sufijo y los `*-final.log` anteriores
se conservan y se distinguen; no se sobreescriben los fallos.

## Históricos, limpieza y diff final

Las 15 tablas públicas de aplicación/migraciones se compararon mediante SHA-256
de filas completas ordenadas y xmin, además de inventario de bases, identidades,
checksums de migraciones y protección persistente. Las lecturas de auditoría
usaron sesiones de solo lectura. Los snapshots `before.json` y `after.json` son
idénticos byte a byte y coinciden con [C1-MEDIA-HISTORY.json](C1-MEDIA-HISTORY.json):
`83dd062abcfc165c6f737da8a9c49091f0ccb24aaa9c1f0e4f36b339bdc71cf9`.

| Base histórica | OID   | Filas incluidas | Migraciones | Resultado                                                      |
| -------------- | ----- | --------------- | ----------- | -------------------------------------------------------------- |
| benhouse       | 16384 | 6               | 5           | Sin C1.2; default_transaction_read_only=on persistente intacto |
| benhouse_test  | 79967 | 20282           | 5           | Sin C1.2; contenido y xmin intactos                            |

System identifier histórico: `7681450735968391207`. La última API usó la base
propia `benhouse_api_24103843db7f402c91b10f666be551ef_test`, OID 265070; el worker
usó `benhouse_worker_da509299bba643808bc682405a21a9c4_test`, OID 261663, y
`benhouse_worker_b415a7046bba4ea5b80d4d129d6cb770_test`, OID 263366. Upgrade usó
OID 259960. Todas se eliminaron tras verificar identidad, sin FORCE ni conexiones
residuales. El inventario PostgreSQL final coincide con el inicial.

Docker vuelve al inventario inicial: únicamente `init-postgres-1` y su volumen
`init_benhouse-postgres-data`, con los mismos ID/montaje; redes bridge, host, none
e init_default. Cero contenedores, redes o volúmenes propios pendientes, incluidos
el backup y el PostgreSQL separado. No quedan directorios temporales de junctions
ni upgrade. No se borra el directorio preexistente benhouse-a1-pnpm.

Residuos deliberados: imagen RustFS fijada en la caché Docker (111133450 bytes),
dependencias y artefactos normales de build, scripts y logs locales de auditoría.
No contienen credenciales nuevas persistidas ni fotografías reales. Next regeneró
next-env.d.ts; se repuso exactamente su contenido de HEAD. `.env`, compose,
AGENTS.md y las cinco migraciones previas no se modificaron. No se tocaron backups
históricos ni se cambió la protección de benhouse.

Entrega: **49 archivos** cambiados/nuevos, 32 archivos auditados previamente
conservados, staging vacío. `c12-final.patch` contiene el diff completo frente a
HEAD, incluidos los nuevos; `tree.json` registra tamaño/SHA-256 por archivo y
`git.json` registra el hash del parche. Se comprueba también el parche con
`git apply --reverse --check`, sin aplicarlo ni tocar el índice. La rama y el
remoto siguen en el commit base; no se hizo commit ni push.

## Incidencias conservadas

- La red Docker `--internal` no publicó el puerto requerido por procesos Windows;
  se descartó ese arranque y se limpiaron sus recursos propios. Una primera
  comprobación de montajes/puertos detectó también bindings vacíos y falló cerrado.
- GetBucketAcl de RustFS devuelve una respuesta de compatibilidad. Se sustituyó
  esa comprobación por ausencia de política de bucket y IsPublic=false. No se
  interpreta una ACL incompleta como prueba de privacidad.
- Dos ensayos de red fallaron al exigir bloqueo TCP entre contenedores pese a
  enable_icc=false. Se conserva el hallazgo: Docker Desktop permite llegar a la
  IP interna desde un contenedor creado por el administrador. La prueba final
  acredita denegación de datos por autenticación, no aislamiento TCP inexistente.
- La instalación inicial escogió una versión del SDK demasiado reciente para la
  política local. Se retiró la excepción añadida por pnpm y se fijó 3.1149.0, sin
  rebajar minimumReleaseAge. pnpm exec prettier no resolvió el ejecutable en un
  intento; se ejecutó el binario local de Prettier directamente.
- Las primeras ejecuciones completas de API/worker abarcaron una interrupción de
  unas nueve horas: duraciones 32687,56 s y 32455,86 s. API terminó con 2 fallos de
  timeout y 223 aprobados; worker con 2 timeouts, un fallo de conexión PostgreSQL
  y 23 aprobados. **Son ejecuciones fallidas**, conservadas como api.log y
  worker.log. Las repeticiones completas se registran por separado en
  api-final.log y worker-final.log. No se cambiaron aserciones, timeouts ni filtros
  para obtener los resultados finales.
- Se usa `pnpm_config_verify_deps_before_run=false` en el proceso de validación
  para evitar reinstalaciones automáticas, sin modificar configuración guardada.
  Las operaciones que requerían Docker/subprocesos se ejecutaron con autorización
  del entorno. No queda ningún rechazo de aprobación automática pendiente.
- La comprobación adicional de scripts encontró `no-unsafe-finally` en el runner
  de objetos. Se extrajo la comprobación de propiedad a una función manteniendo
  la misma condición y propagación de errores; el lint del paquete ahora incluye
  scripts. Se repitió toda la cadena después de ese cambio.
- El primer intento adicional de persistencia en una base `benhouse_api_*_test`
  falló en las dos barreras que exigen `benhouse_test`: 91 aprobadas y 29 sin
  ejecutar. Se conserva como fallo en database-final.log. La ejecución posterior
  del servidor PostgreSQL separado pasó las 120 sin omitir ni rebajar aserciones.

## Límites y pendientes

El servicio es local de un nodo; no se certifica clúster ni producción. La cuenta
raíz solo se utiliza en su servicio de desarrollo exclusivo. Se confía en el
backend, sus credenciales y el administrador de Windows/Docker: quien controla
el daemon puede montar volúmenes o leer secretos. HTTP solo se admite en loopback;
un destino remoto exigiría TLS y una política de red específica. No se afirma
aislamiento frente al administrador ni frente a un backend comprometido.

Se probó una copia lógica en un tercer volumen exclusivo y restauración en otro
servicio/volumen: cuatro objetos, bytes y SHA-256 idénticos; una copia corrupta se
rechaza antes de escribir. El [procedimiento](C1-MEDIA-OBJECTS-OPERATIONS.md)
requiere detener escritores, limita la copia a 64 MiB y no acredita recuperación
completa de PostgreSQL/BenHouse ni protección ante pérdida del host. No se tocan
backups históricos. Los restos internos de PUT abortado son responsabilidad de
RustFS; se acredita ausencia de objetos parciales visibles, no un plazo de GC
interno. READY/ARCHIVED nunca se destruyen mediante la limpieza de incompletos.

No se despliega almacenamiento persistente ni se habilitan escritores de
aplicación sobre las bases históricas. Los recursos usados son efímeros.

- **P2 C1.1 abierto:** detección de suites `.tsx`/`.jsx`.
- **P2 C1.1 abierto:** regresión de geometría inválida de `Property.location_point`.

Los P1 se entregan con implementación y regresiones para revisión independiente;
este informe no levanta el bloqueo de commit.

## Evidencias locales

Directorio:
`C:/Users/Benja/.codex/visualizations/2026/10/13/01a13719-7eb0-70d2-adca-0227d9c8a4b6/c12-objects-final`.
Contiene logs separados, snapshots sin credenciales ni filas en claro, inventario
de archivos SHA-256 y diff completo incluyendo archivos nuevos. La entrega final
enlaza esos artefactos. El informe de auditoría y la reproducción bloqueada
anteriores se conservan sin cambios.
