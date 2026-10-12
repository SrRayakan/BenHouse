# C1.1 — Corrección del P1 de bypass de la barrera API

**Listo para reauditoría independiente de esta corrección.** La auditoría debe reanudarse y completar también la revisión funcional de Location que quedó interrumpida. No se declara C1.1 aprobado por esa auditoría ni se avanza a C1.2/C1.3. No hay staging, commit ni push.

## Punto de partida y alcance

Antes de editar: rama `main`, HEAD y origin/main `8fa544729f93a773431c4b439a90da45cad5f427`, staging vacío. Se inventariaron los 31 archivos modificados/nuevos recibidos y se preservaron copias y SHA-256 de los 167 archivos versionados o no ignorados del checkout. El delta de este informe se calcula contra ese árbol recibido, no contra main.

La auditoría confirmó que `setupFiles` solo protegía la configuración habitual. Ejecutar una suite directamente podía registrar hooks de Account Lifecycle que borran buckets por acción. Se corrige la infraestructura de pruebas. Los servicios, DTO, permisos, schema, migración C1.1, pruebas PostgreSQL y lógica productiva recibidos conservan exactamente su contenido. Los runners API, común, worker y antiguo tampoco cambian en esta corrección.

## Delta exacto: 20 archivos

Los siguientes 11 archivos existentes incorporan como primera instrucción el import de la barrera. En los ocho que cargaban `.env` después se elimina esa carga y su import; no cambia el cuerpo funcional de las pruebas:

1. `apps/api/src/auth/account-lifecycle.integration.test.ts`
2. `apps/api/src/auth/auth-persistence.integration.test.ts`
3. `apps/api/src/auth/auth-rate-limit-http.integration.test.ts`
4. `apps/api/src/auth/auth.integration.test.ts`
5. `apps/api/src/marketplace/location.integration.test.ts`
6. `apps/api/src/marketplace/marketplace.integration.test.ts`
7. `apps/api/src/organizations/organization-administration-test-cleanup.integration.test.ts`
8. `apps/api/src/organizations/organization-administration.integration.test.ts`
9. `apps/api/src/organizations/organizations.integration.test.ts`
10. `apps/api/src/organizations/postgres-test-fixtures.integration.test.ts`
11. `apps/api/src/ready.integration.test.ts`

| Archivo adicional                                             | Delta respecto al árbol recibido                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/api/test/verified-database.mjs`                         | Ejecuta y espera la verificación compartida antes de evaluar la suite.                                  |
| `apps/api/test/api-test-database.mjs`                         | Nuevo verificador de entorno, URLs e identidad física; fallo cerrado y mensajes sin secretos.           |
| `apps/api/test/integration-guard.test.mjs`                    | 15 regresiones, cobertura AST de suites y ejecución real sin configuración en dos pools.                |
| `apps/api/src/integration-database-guard.integration.test.ts` | Nueva regresión del CLI antiguo contra la base efímera, sin configuración ni expectativas de identidad. |
| `apps/api/package.json`                                       | Incluye las regresiones de `test/` en el comando unitario y excluye explícitamente `dist`.              |
| `apps/api/TEST_ISOLATION.md`                                  | Contrato actualizado de imports, entorno y regresiones.                                                 |
| `docs/C1-ISOLATION-VALIDATION.md`                             | Marca la conclusión anterior como sustituida por el P1 confirmado; conserva la evidencia histórica.     |
| `docs/C1-LOCATION-CORE.md`                                    | Registra el bypass y la revisión funcional independiente pendiente.                                     |
| `docs/C1-GUARD-VALIDATION.md`                                 | Este inventario y resultados.                                                                           |

Son 16 archivos modificados y 4 nuevos respecto al checkout recibido. El diff total acumulado C1.1 se entrega separado del diff exclusivo de esta corrección.

## Barrera y evidencia adversarial

Cada suite depende de la evaluación asíncrona de `verified-database.mjs` antes de ejecutar su cuerpo y registrar hooks. Se conserva además el setup anterior como defensa adicional. El verificador exige `NODE_ENV=test`, nombre `benhouse_api_<UUID>_test`, OID y system identifier exactos, URLs PostgreSQL coincidentes y ambas identidades físicas. Un sufijo `_test` no basta. Sin expectativas válidas se falla antes de abrir una conexión; ante discrepancia física, antes de registrar hooks. Comprueba que el entorno no cambie durante las lecturas y no propaga errores crudos del driver.

El runner carga el entorno antes de verificar. Se eliminan todas las cargas posteriores de `.env` en las suites. Los cambios explícitos de parámetros de conexión de fixtures y destinos inalcanzables adversariales se conservan. No se bloquea globalmente `process.env` ni se modifica código de producción.

La comprobación AST descubre las suites de integración de `src` y `test`, exige su primer import y rechaza cargas de entorno y APIs de hoisting/mocking que podrían adelantarse a él. Incluye casos que demuestran que una suite nueva sin protección, un import tardío y una carga posterior fallan esta comprobación.

La regresión negativa resuelve y ejecuta las 12 suites reales sin `--config`, tanto con el pool predeterminado de Vitest como con `vmThreads`. Ambas URLs apuntan a un servidor TCP sintético creado por la propia prueba, sin PostgreSQL ni acceso a bases históricas. Cada archivo debe aparecer en el informe JSON con error `API_TEST_DATABASE_GUARD`, cero tests registrados y cero assertions; el servidor debe observar cero conexiones. Así se comprueba también la ausencia de escrituras, borrados y cleanup.

La regresión PostgreSQL lanza realmente `with-test-database.mjs vitest run src/auth/account-lifecycle.integration.test.ts` sin configuración ni variables de identidad. El runner antiguo lee las identidades de desarrollo y de la base efímera propia; ambas conexiones se fuerzan a solo lectura. Vitest debe generar su informe y rechazar Account Lifecycle en la barrera con cero tests registrados. Nunca se usa `benhouse_test` como destino de esta prueba negativa.

## Validación observada

| Comprobación                                                  | Resultado                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Regresiones dirigidas de barrera, primera versión             | 14/14. Posteriormente se añade el pool predeterminado: 15/15 en la cadena final.            |
| API dirigida: Location + runner antiguo                       | 13/13 en 2 archivos; 24,01 s.                                                               |
| API completa por comando oficial                              | 202/202 en 12 archivos; 265,44 s; una ejecución completa.                                   |
| Worker completo                                               | 20/20; 91,99 s; una ejecución completa.                                                     |
| Cadena unitaria final `pnpm test`                             | 290/290: web 1, config 38, database/scripts 40, API 205, worker 6.                          |
| `pnpm lint`, `pnpm typecheck`, `pnpm build`                   | Correctos.                                                                                  |
| ESLint y formato explícitos de los nuevos helpers/regresiones | Correctos sobre la versión final.                                                           |
| `pnpm db:validate`                                            | Correcto.                                                                                   |
| Migraciones                                                   | Las cinco migraciones se aplican desde cero en las tres bases efímeras indicadas abajo.     |
| Drift contra `benhouse_test`, conexión forzada a solo lectura | `No difference detected`, exit 0.                                                           |
| Diff y revisión local de seguridad/efectos colaterales        | Sin errores de whitespace; sin delta productivo ni de migraciones; sin nuevos borrados SQL. |

Las 40 regresiones de database/scripts, incluidas las de identidad, preparación parcial, errores de pruebas y errores de cleanup, permanecen verdes. El runner y el aislamiento del worker no cambian.

## Históricos y recursos

| Ejecución       | Base exclusiva                                          | OID    | Cierre                                          |
| --------------- | ------------------------------------------------------- | ------ | ----------------------------------------------- |
| API dirigida    | `benhouse_api_59302ae9e3344796a8f5fe9bc3c16ef4_test`    | 217614 | Eliminada sin FORCE; sin conexiones residuales. |
| API completa    | `benhouse_api_aa68d14ac8334091946973c955448abf_test`    | 219275 | Eliminada sin FORCE; sin conexiones residuales. |
| Worker completo | `benhouse_worker_fb018084a3444942a2bdbaccd21ea371_test` | 220946 | Eliminada sin FORCE; sin conexiones residuales. |

Antes y después de las ejecuciones se consultaron exclusivamente en modo solo lectura todas las tablas de aplicación y `_prisma_migrations`. Por cada fila se compararon clave primaria, hash del contenido completo y xmin; se calcularon también SHA-256 agregados por tabla. Se verificaron identidad física, conjunto de tablas e inventario completo de bases y OIDs. `spatial_ref_sys`, catálogo de la extensión, no forma parte de la comparación de filas de aplicación.

| Base            | Filas comparadas   | Modificadas | Eliminadas | Nuevas residuales |
| --------------- | ------------------ | ----------- | ---------- | ----------------- |
| `benhouse`      | 5 en 14 tablas     | 0           | 0          | 0                 |
| `benhouse_test` | 20282 en 15 tablas | 0           | 0          | 0                 |

`benhouse` conserva OID 16384, cuatro migraciones y el ajuste persistente `default_transaction_read_only=on`; C1.1 no se aplica allí. `benhouse_test` conserva OID 79967 y cinco migraciones. Sistema: `7681450735968391207`. Sus 7407 filas previas de `auth_rate_limit`, y todas las demás filas, mantienen contenido y xmin. No se restauran las 15 filas afectadas en la ejecución histórica anterior.

El inventario final de bases coincide exactamente con el inicial: `benhouse`, `benhouse_test`, `postgres`, `template0`, `template1`, `template_postgis`, con sus OIDs originales. No hay bases nuevas residuales ni directorios temporales de las regresiones negativas. Se conservan únicamente copias de auditoría, huellas y diffs como evidencia.

## Fallos observados y límites pendientes

- El primer intento de inventario desde Node no pudo lanzar Git por EPERM del sandbox; se completó con Git desde PowerShell antes de editar.
- El primer `pnpm test` tras añadir el directorio de regresiones usaba el filtro posicional `test`, que también seleccionó 29 archivos compilados de `dist`. Fallaron durante importación/registro por incompatibilidad CommonJS con Vitest, con cero tests registrados en esos archivos; los 204 tests fuente pasaron. Se corrigió a `test/` con exclusión explícita de `dist` y se repitió la cadena completa: primero 289/289 y, al añadir el caso del pool predeterminado, 290/290. No se ocultaron fallos mediante repeticiones selectivas.
- El build regeneró `apps/web/next-env.d.ts`; se repuso byte a byte el contenido inicial para excluir un cambio ajeno.
- No se repite la suite PostgreSQL independiente de database ni el comando global `test:integration`: su runner compartido y la expectativa literal `benhouse_test` de la prueba C1.1 están fuera de esta corrección. La evidencia anterior de sus 19 casos se conserva; esta ejecución valida el cambio mediante API/PostgreSQL real exclusivo, unitarias, migraciones, drift y worker. No hubo hooks API contra bases históricas.
- La comprobación estática previene omisiones y patrones conocidos en nuevas suites; no sustituye la revisión de código de nuevos helpers. No se pretende aislar código de pruebas deliberadamente malicioso que altere o evite la propia barrera.
- La corrección no modifica ni rehabilita residuos históricos. La auditoría independiente de Location sigue pendiente y debe completarse antes de aprobar C1.1.

Git final conserva rama, HEAD y origin/main originales; staging vacío y todo el trabajo sin commit ni push.
