# C1.1 — Delta autorizado de aislamiento y validación final

11 de octubre de 2026. **Informe histórico; conclusión sustituida por la reauditoría.** La auditoría independiente confirmó un P1: omitir la configuración de Vitest evitaba `setupFiles` y permitía alcanzar hooks heredados. La base exclusiva del comando oficial era insuficiente. Se conserva este informe como evidencia de aquella ejecución; la corrección de la barrera y su nueva validación están en [C1-GUARD-VALIDATION.md](C1-GUARD-VALIDATION.md). No se han restaurado las 15 filas afectadas anteriormente ni borrado residuos históricos. No se implementan C1.2/C1.3.

## Punto de partida e inventario C1.1 preservado

Antes de editar se confirmaron `main`, HEAD y origin/main en `8fa544729f93a773431c4b439a90da45cad5f427`, staging vacío y estos 16 archivos ya modificados/nuevos. Se guardaron copias y SHA-256 del contenido para comparar el delta:

1. `apps/api/src/main.ts`
2. `apps/api/src/marketplace/marketplace-transaction-observer.ts`
3. `apps/api/src/marketplace/marketplace.controller.ts`
4. `apps/api/src/marketplace/marketplace.dto.ts`
5. `apps/api/src/marketplace/marketplace.module.ts`
6. `apps/api/src/marketplace/marketplace.service.ts`
7. `apps/api/src/marketplace/location.input.ts`
8. `apps/api/src/marketplace/location.input.test.ts`
9. `apps/api/src/marketplace/location.integration.test.ts`
10. `packages/database/prisma/schema.prisma`
11. `packages/database/prisma/migrations/20261011000000_location_core/migration.sql`
12. `packages/database/src/location-persistence.integration.test.ts`
13. `docs/04-STATE-MACHINES.md`
14. `docs/06-API-CONTRACTS.md`
15. `docs/C1-LOCATION-CORE.md`
16. `docs/C1-VALIDATION.md`

No se ha cambiado código productivo C1.1, schema, migración o pruebas unitarias/PostgreSQL. Trece de esos archivos conservan exactamente su SHA-256 inicial. En `location.integration.test.ts` solo se adaptaron dos referencias al nombre de la base; los otros dos archivos actualizados son los documentos de estado C1.

## Inventario exacto del delta de aislamiento

| Archivo                                                                                   | Cambio respecto al árbol recibido                                                             |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/database/scripts/with-ephemeral-test-database.mjs`                              | Nuevo runner común API/worker, verificación física y cleanup por identidad original.          |
| `packages/database/scripts/with-ephemeral-test-database.test.mjs`                         | 21 regresiones nuevas de flujo, identidad y fallos.                                           |
| `packages/database/scripts/with-api-test-database.mjs`                                    | Nueva entrada CLI API.                                                                        |
| `packages/database/scripts/with-worker-test-database.mjs`                                 | Wrapper sobre runner común; conserva sus exports y contrato de variables.                     |
| `apps/api/package.json`                                                                   | `test:integration` usa el wrapper API exclusivo.                                              |
| `apps/api/vitest.integration.config.mts`                                                  | Setup obligatorio de identidad antes de importar las suites.                                  |
| `apps/api/test/verified-database.mjs`                                                     | Nueva guarda de ambas conexiones: nombre/OID/system identifier.                               |
| `apps/api/src/marketplace/location.integration.test.ts`                                   | Dos referencias al nombre verificado en lugar de `benhouse_test`.                             |
| `apps/api/src/marketplace/marketplace.integration.test.ts`                                | Expectativa de nombre y destino de la prueba de conexión inalcanzable.                        |
| `apps/api/src/organizations/organization-administration-test-cleanup.integration.test.ts` | Expectativa de nombre verificado.                                                             |
| `apps/api/src/organizations/organization-administration.integration.test.ts`              | Expectativa de nombre, tres observadores de bloqueos y comprobación del destino inalcanzable. |
| `apps/api/src/organizations/organizations.integration.test.ts`                            | Expectativa de nombre, destino inalcanzable y filtro de pg_stat_activity parametrizado.       |
| `apps/api/src/organizations/postgres-test-fixtures.integration.test.ts`                   | Expectativa de nombre y dos observadores de bloqueos.                                         |
| `apps/api/TEST_ISOLATION.md`                                                              | Nuevo contrato operativo del aislamiento API.                                                 |
| `apps/worker/TEST_ISOLATION.md`                                                           | Documenta la reutilización del runner y las sondas propias.                                   |
| `docs/C1-LOCATION-CORE.md`                                                                | Actualiza el estado del P1 de validación.                                                     |
| `docs/C1-VALIDATION.md`                                                                   | Conserva evidencia anterior y enlaza el cierre actual.                                        |
| `docs/C1-ISOLATION-VALIDATION.md`                                                         | Este inventario e informe final.                                                              |

Son 18 archivos del delta (6 nuevos y 12 modificados respecto al árbol recibido). La limpieza global heredada B1.3 no se alteró: ahora queda físicamente contenida en la base efímera. No hay cambios en lógica productiva, CORS, permisos o Location durante esta continuación.

## Garantías y revisión

El nombre contiene un UUID generado internamente. Antes de DDL se verifica que los destinos protegidos son `benhouse` y `benhouse_test` y que no comparten identidad física. Tras CREATE se captura el OID desde el catálogo del administrador; la conexión nueva debe devolver exactamente ese OID, nombre y system identifier, distintos de ambas bases protegidas. Se aplican las cinco migraciones y se revalida identidad antes de Vitest.

Ambas variables DATABASE_URL/TEST_DATABASE_URL de API apuntan a su base nueva. Su setup verifica ambas conexiones antes de importar cada archivo, impidiendo hooks de limpieza en una base no validada. No se acepta un nombre arbitrario como sustitución de la identidad.

Si falla preparación o migración no se ejecutan pruebas ni se usa fallback. Cleanup valida nuevamente administrador y OID propio, hace DROP sin FORCE y comprueba ausencia. Si CREATE no se confirma, falta el OID, cambia la identidad o quedan conexiones, no se fuerza ni adopta el recurso: la ejecución falla e informa su nombre. Se acumulan fallos de pruebas, cleanup y desconexión. Los errores del driver no se imprimen con credenciales.

La revisión local comprobó que no hay SQL de borrado amplio ni nuevos cambios productivos. Las regresiones del runner cubren también OID reemplazado, sistema incorrecto, migración parcial, DROP inefectivo y fallos simultáneos. La suite real del worker verifica que su aislamiento y sondas siguen funcionando.

## Ejecuciones observadas sobre el código final

| Comprobación                                         | Resultado                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Regresiones de database/scripts dirigidas            | 40/40, incluidas 21 nuevas y las previas del worker.                               |
| API C1.1 dirigida, runner exclusivo                  | 12/12.                                                                             |
| API completa, runner exclusivo                       | 201/201 en 11 archivos; una sola ejecución completa, 258,69 s.                     |
| Worker completo, runner exclusivo                    | 20/20; una sola ejecución completa, 91,91 s.                                       |
| PostgreSQL C1.1 dirigido                             | 19/19; todas las escrituras en fixtures nuevos dentro de transacciones revertidas. |
| `pnpm test`                                          | 275/275: web 1, config 38, database/scripts 40, API 190, worker 6.                 |
| `pnpm lint`, `pnpm typecheck`, `pnpm build`          | Correctos.                                                                         |
| ESLint explícito de los runners y setup `.mjs`       | Correcto tras la corrección descrita abajo.                                        |
| `pnpm db:validate`                                   | Correcto.                                                                          |
| `pnpm db:generate`                                   | Correcto tras cerrar los procesos que bloqueaban la DLL.                           |
| Drift shared DB → schema, `migrate diff --exit-code` | `No difference detected`, exit 0; solo lectura.                                    |
| `git diff --check` y formato de nuevos runners       | Correctos.                                                                         |

Las cinco migraciones se aplicaron desde cero en cada base API y worker. No se modificó ninguna migración durante esta continuación. Se mantiene la evidencia previa de replay y upgrade con Property/Listing poblados, recogida en `C1-VALIDATION.md`.

## Recursos e históricos

| Ejecución       | Base exclusiva                                          | OID    | Resultado de cleanup |
| --------------- | ------------------------------------------------------- | ------ | -------------------- |
| API dirigida    | `benhouse_api_2db82c35336a4a7293c5f68820450bb8_test`    | 212526 | Eliminada sin FORCE. |
| API completa    | `benhouse_api_6ae802b20ad74c0794bf46df9bdca26c_test`    | 214196 | Eliminada sin FORCE. |
| Worker completo | `benhouse_worker_952af943445a4fb19297aff489d93696_test` | 215866 | Eliminada sin FORCE. |

Sistema PostgreSQL verificado: `7681450735968391207`. `benhouse` conserva OID `16384`, cuatro migraciones y `default_transaction_read_only=on`; no se intentó aplicar C1.1 allí. `benhouse_test` conserva OID `79967` y cinco migraciones. La lista final completa de bases y OIDs coincide con la inicial: no hay bases nuevas residuales. DROP confirmó ausencia de conexiones en las bases propias.

Antes de ejecutar pruebas se capturó para cada fila de todas las tablas de aplicación y `_prisma_migrations` su clave, hash del contenido completo y xmin. Se compararon individualmente al finalizar, y se calcularon SHA-256 agregados antes/después. **Resultado: cero filas previas modificadas o eliminadas y cero filas nuevas residuales** en ambas bases protegidas. No se compararon solamente los recuentos.

Recuentos conservados en `benhouse_test`: `account_token` 856, `audit_event` 2503, `auth_rate_limit` 7407, `organization` 963, `organization_invitation` 31, `organization_member` 1227, `outbox_event` 760, `password_credential` 1248, `session` 2365, `user` 2917. Property, Listing, PropertyAuthorization y Location continúan vacíos. Las cinco filas de `_prisma_migrations` también conservan contenido y xmin. En desarrollo se conserva incluso el bucket de rate limit preexistente.

## Fallos y limitaciones registrados

- La primera consulta de inventario asumía una columna `id` en todas las tablas y falló en la tabla de credenciales. Se corrigió a su clave `user_id` antes de ejecutar pruebas; no hubo escrituras.
- ESLint detectó `no-unsafe-finally` en la primera implementación del cleanup. Se sustituyó ese throw por acumulación de error y se verificó el runner final con todas sus regresiones.
- La revisión automática rechazó `pnpm test:integration` antes de ejecutarlo por incluir la suite database contra la base compartida. No se eludió ejecutando ese comando indirectamente. Se ejecutaron API y worker exclusivos y las 19 pruebas PostgreSQL C1.1 revisadas, con rollback. La suite database completa no se repitió en esta continuación.
- El primer `prisma generate` dio EPERM porque las pruebas activas tenían cargada la DLL. Tras finalizar esos procesos, la generación pasó. No hubo reintentos selectivos para ocultar pruebas fallidas: ninguna prueba ejecutada falló.
- El build regeneró `apps/web/next-env.d.ts`; se devolvió a su contenido previo para excluir un cambio ajeno al alcance.
- El antiguo runner de database no se generalizó: el alcance autorizado es la suite API y la compatibilidad del worker. Los comandos dirigidos usados aquí y su evidencia se distinguen del comando global rechazado.
- La revisión es local; la conclusión significa listo para revisión independiente, no despliegue. El incidente previo de 15 filas no se revierte ni se oculta; este informe prueba la conservación durante esta ejecución nueva.

Git final: rama main y HEAD originales, staging vacío, cambios sin commit ni push. El diff total y el diff exclusivo de aislamiento se entregan por separado.
