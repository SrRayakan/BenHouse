# Aislamiento de integración del worker

Ejecutar `pnpm --filter @benhouse/worker test:integration`. El runner necesita
permiso local para crear y eliminar **su propia base efímera**, además de aplicar
las migraciones. No es configuración ni permiso del worker productivo.

La selección productiva es global: apartar una foto inicial de eventos elegibles
no protege frente a availableAt/leases que vencen después ni frente a nuevas filas.
Por eso la suite usa una base `benhouse_worker_<UUID>_test` exclusiva por ejecución.
No reprograma, bloquea ni restaura eventos históricos de `benhouse_test`.

El runner común valida host, sufijo y aislamiento físico antes de crear recursos.
El wrapper verifica que la base nueva tiene OID diferente tanto de dev como de
test compartida, aplica las migraciones versionadas y ejecuta Vitest a través del
runner endurecido. Las fixtures comprueban nombre y OID antes de escribir.
Cada worker usa conexiones reales a esa misma base exclusiva; el SQL de selección,
los locks, leases, transporte y confirmación son los de producción, sin mocks de
Prisma, filtros por ID ni ramas productivas exclusivas para tests.

Las regresiones crean eventos sintéticos ajenos al worker en `benhouse_test`:
PENDING futuro, lease vigente y evento insertado después de preparar el fixture.
Las dos primeras comprueban no elegibilidad tras preparar y esperan la condición
del reloj PostgreSQL antes de procesar, sin sleeps. Comparan todas las columnas y
xmin después de dos invocaciones. Una barrera en el transporte mantiene al primer
worker en vuelo mientras el segundo intenta reclamar el mismo evento propio.

Las pruebas CAS de timestamps, lockToken, xmin/ABA y cleanup siguen existiendo,
pero solo sobre un ID sintético propio: no son el mecanismo de aislamiento.
La limpieza intenta todos los pasos y desconexiones incluso ante fallos. El
wrapper elimina solo el nombre que creó, tras comprobar su OID original y sin
FORCE; conexiones residuales o una identidad distinta hacen fallar el cierre.
Nunca elimina bases preexistentes, eventos históricos ni leases de terceros.

Una base exclusiva evita introducir un selector alternativo en código productivo
o interceptar/reconstruir SQL en tests. El límite de visibilidad es físico, no una
ventana temporal: un evento de otra base no puede ser seleccionado aunque venza
o aparezca después de la preparación.
