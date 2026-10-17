# Aislamiento de integración del worker

Ejecutar `pnpm --filter @benhouse/worker test:integration`. El runner necesita
permiso local para crear y eliminar **dos bases efímeras propias**, además de
aplicar las migraciones, y Docker para objetos efímeros. No es configuración ni
permiso del worker productivo.

La selección productiva es global: apartar una foto inicial de eventos elegibles
no protege frente a availableAt/leases que vencen después ni frente a nuevas filas.
Por eso la suite usa una base `benhouse_worker_<UUID>_test` exclusiva por ejecución.
No reprograma, bloquea ni restaura eventos históricos de `benhouse_test`.

El runner común `with-ephemeral-test-database.mjs`, compartido con API, valida
host, sufijo e identidades físicas antes de crear recursos. El wrapper verifica
nombre, sistema PostgreSQL y OID de la base nueva frente a dev y test compartida,
aplica las migraciones versionadas, revalida identidad y ejecuta Vitest con ambas
variables de conexión apuntando a la base propia. Las fixtures comprueban nombre
y OID antes de escribir. `WORKER_SHARED_TEST_DATABASE_URL` queda anulada. El
runner entrega `WORKER_FOREIGN_TEST_DATABASE_URL/NAME/OID/SYSTEM` exclusivamente
para la segunda base efímera. Verifica identidad física y distinción de ambas
respecto de los históricos y entre sí antes de ejecutar fixtures.
Cada worker usa conexiones reales a esa misma base exclusiva; el SQL de selección,
los locks, leases, transporte y confirmación son los de producción, sin mocks de
Prisma, filtros por ID ni ramas productivas exclusivas para tests.

Las regresiones crean eventos sintéticos ajenos al worker en esa segunda base:
PENDING futuro, lease vigente y evento insertado después de preparar el fixture.
Las dos primeras comprueban no elegibilidad tras preparar y esperan la condición
del reloj PostgreSQL antes de procesar, sin sleeps. Comparan todas las columnas y
xmin después de dos invocaciones. Una barrera en el transporte mantiene al primer
worker en vuelo mientras el segundo intenta reclamar el mismo evento propio.
Las tres se ejecutan, sin filtros por nombre. Antes de limpiar su fila vuelven a
verificar nombre/OID/system identifier de la segunda base.

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
