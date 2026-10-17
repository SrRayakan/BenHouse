# C1.2 — Entrega para auditoría independiente

**Resultados históricos de la primera entrega, no certificación vigente.**
La auditoría confirmó dos P1. La nueva ejecución y sus límites se documentarán
en C1-MEDIA-OBJECTS-VALIDATION.md; los verdes y omisiones de este registro no se
atribuyen a la corrección posterior.

Ejecución: 13–14 de octubre de 2026. Implementación terminada, pendiente de
auditoría independiente. No se ha hecho staging, commit ni push.

## Punto de partida y alcance entregado

Remoto `https://github.com/SrRayakan/BenHouse.git`, rama `main`, árbol y staging
inicialmente limpios. HEAD, origin/main y `git ls-remote origin refs/heads/main`
coincidían en `43d250bf0918925a9b3b790426d6b74473b5e149`. HEAD y origin/main se
conservan al entregar. AGENTS.md y los contratos aplicables se revisaron antes
de editar; [la decisión técnica](C1-MEDIA-DECISION.md) se escribió antes del código.

- Media de Property y migración aditiva `20261013000000_property_media`.
- StorageProvider local real compartido, archivos fuera de PostgreSQL, validación
  completa de imagen y escritura inmutable.
- Intención idempotente, PUT acotado, confirmación verificada, colección privada,
  ordenación con versión y archivo/cancelación. Sesión, CSRF, PROPERTY_EDIT,
  caducidad y revalidación dentro de transacciones.
- Auditoría atómica, outbox y limpieza del worker con reintentos y conservación
  de fotos confirmadas/archivadas. No hay fotos públicas.
- Tests aislados, verificación de upgrade y [documentación de uso](C1-MEDIA-API.md).

Sin C1.3, documentos privados, vídeos, editor web ni cambios a migraciones antiguas.
Solo se exportan cuatro helpers existentes de Marketplace para reutilizar su
orden de locks; su lógica no cambia. Se añade el observador MEDIA_ACCESS para
la prueba causal. CORS incorpora DELETE y X-Upload-Token. El worker y API requieren
las dos variables de storage explícitas; `.env` no se modifica.

## Resultados de validación

| Comprobación                                                                  | Resultado                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                                                   | Correcto en todo el monorepo.                                                                                 |
| `pnpm typecheck`                                                              | Correcto en todo el monorepo.                                                                                 |
| `pnpm build`                                                                  | Correcto: web, API, worker y paquetes.                                                                        |
| `pnpm test`, versión final                                                    | 304/304: web 1, config 38, storage 7, database/scripts 40, API 212, worker 6.                                 |
| Suite API completa oficial                                                    | 218/218 en 13 archivos; 315,61 s.                                                                             |
| Media HTTP final tras endurecer abortos de carga                              | 16/16; 30,74 s, PostgreSQL y filesystem reales.                                                               |
| Worker con exclusión explícita de sondas compartidas                          | 22/22 ejecutadas en 2 archivos; 3 omitidas; 64,71 s. Incluye las 5 de Media.                                  |
| `pnpm db:generate`, `pnpm db:validate`                                        | Correctos.                                                                                                    |
| Upgrade reproducible `validate-media-upgrade.mjs`                             | Cinco migraciones y cuatro filas sintéticas conservan contenido y xmin; mediaVersion=0, Media vacía, drift=0. |
| Migraciones desde cero                                                        | Las seis se aplican en bases exclusivas API y worker.                                                         |
| Drift de C1.2 en base exclusiva                                               | `No difference detected`, salida 0.                                                                           |
| Drift histórico de ambas bases respecto al schema del HEAD inicial            | `No difference detected`, salida 0; conexiones forzadas a solo lectura.                                       |
| ESLint explícito de scripts añadidos/modificados y formato de archivos nuevos | Correctos.                                                                                                    |
| `git diff --check` y staging                                                  | Sin errores de whitespace; staging vacío.                                                                     |

Las 16 pruebas de Media cubren flujo HTTP completo, idempotencia de intención y
confirmación, no exposición de claves, ausencia de acceso público, recurso ajeno,
PUBLISHER sin PROPERTY_EDIT, membership sin delegación y revocada, CSRF/origen,
credencial de otro objeto, MIME inválido, archivo inválido, tamaño, objeto ausente,
caducidad, logout, revocación de Property, ordenación CAS/conjunto exacto, carreras
de confirmación/archivo y de intenciones, rollback de intención y confirmación,
fallo posterior a escritura de bytes, caducidad durante I/O, invariantes SQL y
revocación concurrente comprobada mediante pid, transacción y bloqueo PostgreSQL.

La suite de storage prueba decodificación JPEG/PNG/WebP, truncamiento, SVG/texto,
límites de bytes/píxeles, repetición y overwrite concurrentes, temporales, traversal,
junctions y configuración ausente. Cuatro pruebas de stream cubren cuerpos
incorrectos, conexión destruida, aborto seguido de ECONNRESET y timeout. El worker
cubre dos consumidores, fotos históricas, TTL, cancelación, objeto inexistente,
fallos durables de storage y recuperación de rollback SQL después del borrado.

## Preservación de históricos y residuos

Se consultaron exclusivamente en modo read-only las 15 tablas de aplicación y
migraciones de cada base, excluyendo `spatial_ref_sys` de la extensión. Para cada
tabla se comparó SHA-256 de filas completas ordenadas junto a xmin, además de
conteos, lista de tablas, checksums de migraciones, OIDs, system identifier,
configuración persistente e inventario completo de bases.

| Base          | OID   | Filas incluidas, con migraciones | Migraciones | Diferencias |
| ------------- | ----- | -------------------------------- | ----------- | ----------- |
| benhouse      | 16384 | 6                                | 5           | Ninguna.    |
| benhouse_test | 79967 | 20282                            | 5           | Ninguna.    |

Los snapshots anterior y posterior son **idénticos byte a byte**; SHA-256:
`83dd062abcfc165c6f737da8a9c49091f0ccb24aaa9c1f0e4f36b339bdc71cf9`.
Se entrega [el snapshot de huellas](C1-MEDIA-HISTORY.json), sin contenido de filas
ni credenciales. Sistema PostgreSQL: `7681450735968391207`.
`benhouse` mantiene `default_transaction_read_only=on`. No se habilitan escritores,
no se cambia protección ni se aplica C1.2 a ninguna base histórica.

Bases de validación principales, todas eliminadas sin FORCE y sin conexiones
residuales:

| Ejecución               | Base                                                  | OID    |
| ----------------------- | ----------------------------------------------------- | ------ |
| Worker Media dirigido   | benhouse_worker_bcd40427ff7048ab94fd831645a5b58f_test | 223836 |
| Upgrade con datos       | benhouse_api_632cd047536a407b85d0045a7fc34eb2_test    | 228939 |
| API completa            | benhouse_api_7400bbe2224d4cfaa3d2e0a44185eb38_test    | 230633 |
| Worker aislado ampliado | benhouse_worker_f5bac59961424cffbd8456a59f4bdc1b_test | 232344 |
| Media HTTP final        | benhouse_api_87581137d95a41a18c3518a1cab136a8_test    | 234137 |

Las bases de intentos fallidos también se eliminaron: OIDs 223830, 223831, 223832,
223833, 223834, 223835 y 227234. El inventario final coincide con el inicial.
No quedan directorios `benhouse-api-media-*`, `benhouse-c12-http-*`,
`benhouse-c12-worker-*` ni `benhouse-c12-upgrade-*` en el temporal del sistema.
Permanecen archivos auxiliares de auditoría en `%TEMP%` (`benhouse-c12-audit.mjs`,
`benhouse-c12-drift.mjs`, baseline Prisma y snapshots before/after), además de los
artefactos locales normales de instalación/build; no contienen credenciales ni
bytes de fotografías. Se conserva el paquete storage, código, tests y documentos
como archivos nuevos sin staging. `next-env.d.ts`, regenerado por Next, se repuso
al contenido original para excluir cambios ajenos.

## Fallos observados y alcance de la validación

- La red/procesos del sandbox bloquearon inicialmente Git remoto, pnpm/Prisma y
  dos regresiones de barrera que lanzan Vitest. Se verificó el remoto y se usaron
  las capacidades de ejecución autorizadas. Ningún rechazo automático de
  autorización quedó pendiente. Las bases creadas durante esos intentos se limpiaron.
- `pnpm install --offline --ignore-scripts` intentó consultar políticas del
  registro y se interrumpió; la instalación autorizada posterior completó los
  enlaces workspace. No cambian versiones previas del lockfile: sharp 0.34.5 ya
  existía transitivamente y ahora es dependencia directa del nuevo paquete.
- pnpm intentaba reinstalar módulos al lanzar scripts bajo otro contexto local;
  se usó `pnpm_config_verify_deps_before_run=false` en las ejecuciones, sin guardar
  esta opción en el repositorio. Se ejecutaron todos los comandos de validación.
- Prisma necesitó restaurar su motor oficial. Una generación mientras tests
  mantenían cargada la DLL falló por EPERM de Windows; se completó al cerrar las
  conexiones, sin cambiar versiones ni migraciones.
- La primera suite Media falló por createdAt/lastActivityAt incoherentes en una
  sesión sintética. La siguiente detectó fixtures de revocación sin endedAt y
  revocationReason. Se corrigieron los fixtures; las suites finales completas
  pasan. Los primeros errores de tipos/importación de sharp se corrigieron y
  lint/typecheck/build finales son correctos.
- No se ejecuta el comando global antiguo `test:integration`: la suite database
  apunta a `benhouse_test`. La validación de persistencia/migraciones de C1.2 usa
  base exclusiva y upgrade con datos. En worker se excluyen **solo** las tres
  pruebas cuyo nombre contiene `aislamiento temporal:` porque escriben sondas en
  la base histórica compartida. Las otras 22 se ejecutan. No se presentan las
  omitidas como aprobadas.
- El último cambio posterior a la suite API completa es el tratamiento de
  conexiones abortadas: se validó con las 304 unitarias finales y las 16 pruebas
  HTTP de Media. No se repitieron las otras 202 pruebas API ya verdes.

## Pendientes visibles

- **P2 C1.1 abierto:** detección de suites `.tsx`/`.jsx` en la barrera de integración.
- **P2 C1.1 abierto:** regresión de geometría inválida de `Property.location_point`.

No se atribuye a C1.2 la resolución de ninguno. La auditoría independiente queda
pendiente; no se detectaron P0/P1 abiertos en la revisión local de este cambio.
Aplicar C1.2 a entornos históricos/publicar fotografías requiere otra actuación;
esta entrega conserva `benhouse` en solo lectura.
