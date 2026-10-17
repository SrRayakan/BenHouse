# Integración API en base exclusiva

Ejecutar `pnpm --filter @benhouse/api test:integration`. Para una prueba dirigida:

```text
pnpm --filter @benhouse/api test:integration src/marketplace/location.integration.test.ts
```

El wrapper API y el wrapper worker reutilizan `packages/database/scripts/with-ephemeral-test-database.mjs`. La API crea `benhouse_api_<UUID interno>_test` sobre el servidor local autorizado. No acepta el nombre desde variables o argumentos. Verifica nombre, OID y system identifier de `benhouse`, `benhouse_test` y la base creada; ninguna identidad puede coincidir. La conexión a las dos bases protegidas se utiliza solo para comprobación y administración del recurso nuevo, sin modificar sus tablas.

Tras verificar el OID generado, aplica todas las migraciones versionadas, revalida la identidad y ejecuta Vitest. `DATABASE_URL` y `TEST_DATABASE_URL` del proceso hijo apuntan exclusivamente a esa base. Las expectativas `API_TEST_DATABASE_NAME`, `API_TEST_DATABASE_OID` y `API_TEST_DATABASE_SYSTEM` las establece el runner. Ambas URLs deben coincidir y se comprueban sus identidades físicas. Las comprobaciones de nombre y las consultas de bloqueo de los fixtures usan esta identidad verificada.

Cada suite tiene como primera instrucción un import de `test/verified-database.mjs`. Su evaluación asíncrona debe terminar antes de evaluar el cuerpo de la suite o registrar hooks. Es obligatorio también al invocar Vitest sin configuración; `setupFiles` conserva una defensa adicional, pero no es la barrera principal. Sin identidad exacta (nombre UUID del runner, OID y sistema), se lanza `API_TEST_DATABASE_GUARD`. Un sufijo `_test` nunca basta. Los errores no muestran URLs ni errores crudos del driver.

El runner carga `.env` antes de verificar; las suites no vuelven a cargar entorno. La barrera detecta además cambios de las variables protegidas durante sus consultas. Los ajustes explícitos de parámetros de conexión para fixtures y los destinos inalcanzables de pruebas adversariales conservan su comportamiento. No se cambian los servicios productivos.

`pnpm --filter @benhouse/api test` incluye una comprobación AST que descubre suites `*.integration.test/spec.ts/js/mts/mjs/cts/cjs` en `src` y `test`: exige el primer import y rechaza cargas de entorno y APIs de hoisting/mocking que puedan adelantarse a él. La regresión ejecuta todas las suites reales sin `--config`, con destino TCP sintético propio, y exige fallo de identidad, cero tests registrados y cero conexiones. La suite `integration-database-guard.integration.test.ts` ejecuta realmente el runner antiguo contra la base efímera en modo solo lectura, sin expectativas de identidad, y exige el mismo rechazo de Account Lifecycle antes de hooks.

No hay fallback. Creación, identidad o migración fallidas impiden ejecutar las pruebas. La limpieza se intenta también si fallan las pruebas: reconfirma la identidad del administrador, el nombre y el OID original; elimina exclusivamente la base propia, sin `FORCE`, y comprueba su ausencia. Un OID desconocido durante preparación parcial, un reemplazo de la base, conexiones residuales o un fallo de DROP hacen fallar la ejecución e identifican el recurso pendiente. No se adopta una base tras un CREATE de resultado incierto. Se intenta desconectar al administrador y se conservan conjuntamente errores de ejecución y limpieza.

Los errores del driver se sustituyen por fases y nombres seguros; no se imprimen URLs con credenciales. No se modifican las policies, servicios ni consultas productivas de C1.1.

Regresiones unitarias: identidad incorrecta (nombre/OID/sistema), alias de bases protegidas, preparación parcial sin OID, migración fallida, pruebas fallidas, limpieza fallida, DROP inefectivo, cambio de administrador, OID reemplazado, fallo de desconexión y combinaciones. El worker reutiliza el flujo para dos bases efímeras; sus sondas ajenas ya no reciben la URL compartida histórica.

Las limpiezas globales heredadas de identidad quedan contenidas físicamente en la base efímera. No se han borrado ni reconstruido los residuos históricos de `benhouse_test`. El runner genérico antiguo de database conserva su contrato; al lanzar Vitest API sin las expectativas del runner exclusivo, la propia suite rechaza la ejecución. La validación y las limitaciones de la corrección están en `docs/C1-GUARD-VALIDATION.md`.
