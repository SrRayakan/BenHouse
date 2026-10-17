# C1.2 — Operación local de objetos privados

Decisión y licencia: [C1-MEDIA-OBJECTS-DECISION.md](C1-MEDIA-OBJECTS-DECISION.md).
RustFS 1.0.1, imagen fijada al digest
`sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c`.
Cliente oficial S3 `@aws-sdk/client-s3` 3.1149.0 (Apache-2.0), fijado en lockfile.
Se escogió una publicación con antigüedad suficiente; no se conserva ninguna
excepción `minimumReleaseAgeExclude`.

## Frontera y requisitos

API/worker en Windows hablan HTTP exclusivamente con `127.0.0.1:puerto` usando
firmas SigV4. El provider rechaza rutas, endpoints remotos, credenciales ausentes
y buckets con políticas. El servicio exige credenciales; la consola está
deshabilitada. RustFS utiliza políticas IAM/bucket; GetBucketAcl devuelve una
respuesta de compatibilidad y no se utiliza como prueba de privacidad.

El volumen Docker Linux solo se monta en el contenedor de objetos, nunca en web,
API o worker, y no es un bind mount. No existe `LocalStorageProvider` ni escritura
de objetos mediante `node:fs`. Sustituir rutas, junctions o symlinks del host no
afecta al destino S3. La variable antigua STORAGE_LOCAL_ROOT no configura ningún
destino y STORAGE_PROVIDER=local falla cerrado.

La red bridge tiene nombre exclusivo y `enable_icc=false`, pero la prueba en
Docker Desktop 29.7.2 demostró acceso TCP a la IP interna desde un contenedor de
sonda creado por el administrador del daemon. Por tanto **no se afirma que ICC
sea una frontera de seguridad**. Las peticiones de esa sonda GET/PUT/DELETE son
rechazadas por credenciales, sin modificar el objeto. Desde interfaces del host
distintas de loopback el puerto publicado no es accesible. El administrador de
Docker puede conectar contenedores, montar el volumen o leer la configuración:
queda fuera del modelo de adversario. También se confía en el proceso backend y
sus credenciales. La cuenta raíz del servicio está limitada operacionalmente a
este único servicio/bucket de desarrollo; no se presenta como IAM de producción.

No hay TLS en loopback local, CDN, acceso público, URLs S3 entregadas al cliente,
replicación ni alta disponibilidad. No se activa Connect, telemetría comercial
ni una compra. El root filesystem del contenedor es de solo lectura, sin
capacidades y con no-new-privileges; /tmp y /logs son tmpfs, /data es el volumen
privado de UID/GID 10001. No se modifica ninguna ACL de Windows.

## Configuración y arranque

Variables explícitas para ambos procesos:

```text
STORAGE_PROVIDER=s3-local
STORAGE_S3_ENDPOINT=http://127.0.0.1:PUERTO
STORAGE_S3_BUCKET=property-media
STORAGE_S3_ACCESS_KEY=<aleatoria, mínimo 16 caracteres>
STORAGE_S3_SECRET_KEY=<aleatoria, mínimo 32 caracteres>
```

Las pruebas oficiales aprovisionan todo automáticamente mediante
`packages/storage/scripts/local-object-service.mjs`, sin leer ni escribir secretos
en `.env`. Cada llamada genera credenciales en memoria, red/contenedor/volumen con
UUID y etiqueta `benhouse.c12.owner`, verifica montaje y publicación, crea un
bucket privado y entrega la configuración únicamente al proceso hijo. Verifica
ID/etiqueta/fecha de creación antes de limpiar. No usa prune, compose down, FORCE
de PostgreSQL ni el volumen `init_benhouse-postgres-data`.

Estos runners son **efímeros**: eliminan su almacenamiento al finalizar. No deben
usarse para datos que se quieran conservar. Para una instalación persistente,
el operador debe crear un volumen Docker nuevo exclusivo (con nombre e identidad
registrados), ejecutar la misma imagen y restricciones, generar credenciales
fuera de Git y aprovisionar un bucket privado. El provider no crea ni adopta
buckets al arrancar. No se ha desplegado un servicio persistente ni se han
arrancado API/worker contra las bases históricas. Antes de hacerlo se necesita
un destino de aplicación autorizado distinto del `benhouse` protegido.

## Copia y restauración verificable

`packages/storage/scripts/object-backup.mjs` implementa copia lógica local:

1. Detener escritores y limpieza para obtener un conjunto estable. Para datos
   reales se coordinaría también un punto consistente de PostgreSQL; esta prueba
   solo acredita objetos sintéticos, no un restore completo de BenHouse.
2. Listar objetos S3 autenticados, obtener bytes y generar manifiesto JSON con
   key, tamaño, SHA-256 y base64. No incluir credenciales. Límites explícitos:
   10 MiB por objeto y 64 MiB por copia; falla antes de guardar si se superan.
3. Persistir el manifiesto en **otro volumen Docker nuevo**, usando un helper sin
   red, sin bind mount y sin acceso al volumen de datos. Leerlo de vuelta y
   comparar hash de la copia persistida.
4. Arrancar un segundo servicio con volumen y credenciales nuevos. Validar todo
   el manifiesto antes de escribir, exigir bucket vacío y usar PUT condicional.
5. Descargar de nuevo cada objeto restaurado y comparar bytes/tamaño/SHA-256 y
   conjunto completo de claves. Una copia con hash alterado debe rechazarse sin
   escribir ningún objeto.
6. Eliminar solo los recursos del ensayo tras verificar sus identidades. No se
   utilizan copias históricas, rutas de backup del host ni datos reales.

La copia en un volumen del mismo Docker demuestra restaurabilidad, **no**
protección ante pérdida del disco/host. Para datos valiosos se requiere copia
externa protegida y conservación aprobada; no se presupone contratada. Si falla
una restauración durante I/O, el destino nuevo puede quedar parcial: conservar
el error y repetir sobre otro destino vacío; nunca borrar el origen ni adoptar
ese parcial como restauración completa.

## Validación reproducible

Desde la raíz, con Docker activo y las credenciales PostgreSQL locales existentes:

```text
pnpm --filter @benhouse/storage build
pnpm --filter @benhouse/storage test:integration
pnpm --filter @benhouse/api test:integration
pnpm --filter @benhouse/worker test:integration
node packages/database/scripts/validate-media-upgrade.mjs
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:generate
pnpm db:validate
```

No hay filtros de omisión del worker. Su runner crea dos bases efímeras, migra y
verifica nombre/OID/system identifier de ambas y su distinción respecto de los
históricos. Los tres escenarios antiguos conservan fila completa y xmin; vuelven
a verificar identidad antes de limpiar su sonda. Cada base se elimina por su
identidad propia, nunca por un nombre compartido ni mediante FORCE.

No ejecutar el antiguo `pnpm test:integration` global: su primera etapa de
database apunta a la base compartida histórica. La cadena indicada usa los
runners aislados; migraciones, upgrade y drift se comprueban allí. Los dos P2
de C1.1 (.tsx/.jsx y geometría inválida) permanecen abiertos.
