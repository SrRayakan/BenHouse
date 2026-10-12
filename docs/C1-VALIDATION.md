# C1.1 — Evidencia para auditoría independiente

Fecha: 11 de octubre de 2026. Base verificada antes de editar: rama `main`, HEAD/main/origin/main en `8fa544729f93a773431c4b439a90da45cad5f427`; árbol y staging limpios.

**Estado actual:** listo para auditoría independiente tras la corrección acotada de aislamiento autorizada. La nueva ejecución confirma cero filas previas modificadas o eliminadas. Inventario, resultados y fallos completos en [C1-ISOLATION-VALIDATION.md](C1-ISOLATION-VALIDATION.md). No se implementan C1.2/C1.3. No se ha hecho staging, commit ni push.

El contenido siguiente conserva la evidencia de la **ejecución anterior**, que quedó bloqueada por el P1; sus 15 filas afectadas no se han restaurado ni sus residuos se han borrado.

## Resultados

| Validación                                  | Resultado                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:generate`, `pnpm db:validate`      | Correctos, Prisma 6.19.1.                                                                                                                                                                                                       |
| Migración en `benhouse_test`                | Cinco migraciones aplicadas; ninguna pendiente.                                                                                                                                                                                 |
| Migración sobre datos previos               | En una base efímera propia: aplicar las cuatro migraciones anteriores, insertar User/Property/Listing sintéticos y aplicar C1.1. Todos los campos previos de Property y Listing permanecen iguales; ubicación nula y versión 0. |
| Drift: base efímera migrada → schema        | `No difference detected`, exit 0.                                                                                                                                                                                               |
| Drift: historial de migraciones → schema    | `No difference detected`, exit 0, usando solo la base efímera propia como shadow.                                                                                                                                               |
| Drift: `benhouse_test` → schema             | `No difference detected`, exit 0.                                                                                                                                                                                               |
| `pnpm test`                                 | 254 pruebas: web 1, config 38, database/scripts 19, API 190, worker 6.                                                                                                                                                          |
| `pnpm test:integration`                     | 341 pruebas: PostgreSQL 120, API/HTTP 201, worker 20.                                                                                                                                                                           |
| C1.1 focalizado                             | 19 pruebas PostgreSQL y 12 HTTP, todas correctas; incluidas también en la ejecución completa.                                                                                                                                   |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | Correctos en todo el monorepo.                                                                                                                                                                                                  |
| Revisión del diff                           | Allowlist de entradas/salidas, SQL parametrizado, permisos por recurso, privacidad, orden de locks, CAS y rollback de auditoría revisados. Sin cambio funcional web, medios, publicación o búsqueda.                            |

Los comandos Prisma de drift usan `migrate diff --exit-code` con `--from-schema-datasource ... --to-schema-datamodel ...`, y `--from-migrations ... --to-schema-datamodel ... --shadow-database-url ...`. No se ejecutó `migrate reset` ni se eliminó ninguna base preexistente. La comprobación temporal creó `benhouse_c11_3a353b70cf2a43878f4128806d140490_test` y eliminó exclusivamente esa base al terminar, tras verificar su nombre/destino. El runner del worker creó y limpió su propia base efímera.

Prisma no representa todos los CHECKs SQL: su comprobación se complementa con las pruebas adversariales PostgreSQL de la nueva migración.

## Estado de las bases

`benhouse` conserva `default_transaction_read_only=on`. El intento de `migrate deploy` fue rechazado por PostgreSQL sin aplicar C1.1; no se desactivó la protección. `migrate status` devuelve la migración C1.1 pendiente. Las huellas de todas sus tablas de aplicación permanecen iguales. Antes de ejecutar la API con el schema nuevo contra esa base será necesario aplicar la migración mediante el procedimiento autorizado para ese entorno.

`benhouse_test` tiene la migración aplicada. Se capturaron recuentos y huellas agregadas de filas antes de las pruebas. Para distinguir inserciones nuevas de filas históricas se compararon las filas anteriores al XID de finalización de la migración. Coinciden las huellas previas de 12 de las 13 tablas de aplicación, incluidos los 2.799 usuarios y 2.404 eventos de auditoría anteriores. La excepción es `auth_rate_limit`, detallada abajo.

Las suites heredadas añaden residuos: usuarios 2.799 → 2.917, auditorías 2.404 → 2.503; también nuevos tokens, sesiones, organizaciones y credenciales. No se han eliminado estos residuos. C1.1 termina con cero Location y cero auditorías `PROPERTY_LOCATION_SET`, y su cleanup comprueba IDs exactos de la ejecución.

## P1 heredado: aislamiento de las suites de identidad

La huella de `auth_rate_limit` no permite certificar preservación total: de 7.197 filas anteriores, 7.182 permanecen como versiones de fila anteriores a la migración; 15 fueron modificadas o eliminadas durante la ejecución de las suites existentes. El total final es 7.407. No se atribuye con certeza cada fila afectada a una única prueba.

Evidencia de riesgo en código preexistente: `apps/api/src/auth/account-lifecycle.integration.test.ts`, beforeAll/afterAll, borra buckets de cinco acciones por `action`, sin limitarse a IDs de fixtures. Otras suites consumen límites con claves compartidas. No se modificó ese código en C1.1 ni se intentó reconstruir contadores antiguos a partir de huellas, que no son un backup.

Se detuvieron las pruebas y los cambios de código al detectar esta incidencia. **Decisión necesaria para cerrar la validación:** autorizar un bloque separado de aislamiento de las suites heredadas (base efímera por ejecución y/o fixtures con cleanup por IDs), manteniendo los residuos históricos. No debe repetirse la suite completa contra la base compartida hasta resolverlo. Los tests C1.1 y el cambio de dominio no presentan este fallo, pero no se declara satisfecho el requisito global de preservación de todos los datos de pruebas.

## Límites de revisión y entrega

- No se detectaron P0 ni P1 en el código funcional C1.1; el P1 anterior bloquea el cierre global de validación.
- La revisión de seguridad fue local, no una auditoría independiente.
- El catálogo queda vacío deliberadamente; su carga real exige una tarea de datos autorizada. No se inventan direcciones reales.
- No se añaden claves ni proveedores. No se cambian permisos base ni transiciones de Listing.
- El build regeneró `apps/web/next-env.d.ts`; se restituyó su contenido previo para excluir cambios ajenos al alcance.
- Los procesos nativos de Prisma/Vitest y Docker necesitaron ejecución fuera del sandbox por restricciones EPERM; no hubo rechazo del revisor automático de aprobación.
