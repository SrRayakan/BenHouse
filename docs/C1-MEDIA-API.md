# C1.2 — Fotografías privadas de Property

Implementa únicamente fotografías de Property. La decisión previa está en
[C1-MEDIA-OBJECTS-DECISION.md](C1-MEDIA-OBJECTS-DECISION.md). No incorpora publicación C1.3,
documentos, vídeos ni editor web.

## Configuración y almacenamiento

API y worker requieren `STORAGE_PROVIDER=s3-local`, endpoint S3 en loopback,
bucket privado y credenciales explícitas. RustFS guarda objetos en un volumen
Docker exclusivo sin bind mounts. No existe escritura de objetos mediante rutas
Windows. [Configuración, aislamiento y copia/restauración](C1-MEDIA-OBJECTS-OPERATIONS.md).
No se inicia un escritor en las bases protegidas.

`packages/storage` comparte el proveedor y validación de contenido entre API y
worker. La autorización pertenece a `MediaService`: el provider no ofrece
operaciones públicas ni URLs de filesystem, y solamente recibe claves generadas
por backend después de autorizar. La metadata se obtiene decodificando los bytes
reales y analizando chunks PNG/WebP para excluir animaciones, nunca confiando
en extensión, nombre, cabeceras ni solamente metadata.pages. Se conservan
los bytes originales privados, sin publicar EXIF ni transformaciones en C1.2.

Límites defensivos: 10 MiB, 40 millones de píxeles, JPEG/PNG/WebP estáticos,
100 intenciones por actor/hora y 100 fotos PENDING/READY por Property; máximo
4 recepciones simultáneas por proceso y 15 segundos para recibir un cuerpo.
Límite de admisión persistente bajo lock de User y Property. El buffer se acota
por el tamaño autorizado antes de decodificar y antes de enviar el objeto a S3.

## Flujo HTTP

Todos los endpoints requieren una sesión verificada vigente. Mutaciones: Origin
permitido y `X-CSRF-Token`. Identidad siempre derivada de la cookie HttpOnly.
PROPERTY_EDIT se comprueba en **cada** acceso, también a bytes; PUBLISHER por sí
solo no lo concede. Propiedad ARCHIVED, Organization inactiva, membership revocada,
PropertyAuthorization revocada/caducada o sesión revocada bloquean el acceso.

1. El cliente calcula SHA-256 del archivo y genera `intentKey` (UUID v4) y
   `uploadToken` (32 bytes aleatorios, hexadecimal). Conserva estos dos valores
   para reintentar la misma intención si se pierde la respuesta.
2. `POST /media/upload-intent` con JSON:

   ```json
   {
     "propertyId": "UUID de la Property",
     "intentKey": "UUID v4 aleatorio",
     "uploadToken": "64 caracteres hexadecimales aleatorios",
     "mime": "image/jpeg",
     "size": 123456,
     "sha256": "SHA-256 hexadecimal de los bytes completos"
   }
   ```

   Devuelve `media` y `upload` (`method`, `url` relativa, `tokenHeader`, `expiresAt`).
   La misma clave con distinto contenido/sesión/recurso devuelve 409. La repetición
   válida no amplía TTL, no duplica fila ni tarea. Solo persiste el hash del token.

3. `PUT /media/:id/object`: bytes crudos, Content-Type exacto, Content-Length exacto,
   `X-Upload-Token`, cookie y CSRF. No multipart, compresión ni token en query.
   La URL no es bearer: compartirla no concede acceso. El token solo sirve para
   la sesión que creó esa intención. TTL de 15 minutos con reloj PostgreSQL.
   Preflight antes de recibir, nueva autorización bajo locks antes de escribir.
4. `POST /media/:id/complete-upload` con `{}`. Comprueba objeto existente,
   decodificación completa, MIME, tamaño y digest exactos de esa intención.
   La clave y Property son inmutables. Confirmación, posición, versión y auditoría
   se confirman en una única transacción. Repetición READY es idempotente.
5. `GET /properties/:id/media`: `{version, items}` de fotos READY exclusivamente.
   DTO sin claves, digest del token, sesión creadora ni rutas internas.
6. `GET /media/:id/content`: lectura privada con autorización actual, `no-store`,
   `nosniff`, CSP sandbox y disposición attachment. No hay URL pública ni CDN.
7. `PUT /properties/:id/media/order` con `{version, ids}`: conjunto exacto de IDs
   READY sin duplicados. Versión obsoleta/conjunto distinto: 409. Posiciones únicas
   protegidas por constraint diferida; las permutaciones son atómicas. La primera
   posición sirve como primera foto, sin introducir una portada independiente.
8. `DELETE /media/:id`: READY → ARCHIVED conservando bytes, metadata y auditoría;
   PENDING → CANCELLED con limpieza solicitada. Repetición terminal es idempotente.
   No existe restauración ni borrado físico de fotos confirmadas en este bloque.

Errores: 400 solicitud/imagen inválida, 401 sesión, 403 CSRF/origen, 404 recurso
no accesible, 409 conflicto/objeto ausente, 410 intención caducada o terminada,
429 admisión/concurrencia, 503 dependencia. No se propagan errores de Prisma,
storage, rutas internas o tokens. No registrar bodies ni X-Upload-Token en
un proxy exterior. Las respuestas de Media usan `Cache-Control: no-store`.

## Limpieza y recuperación

La creación persiste un evento `MEDIA_UPLOAD_CLEANUP` con `availableAt=expiresAt`.
Cancelar crea otro evento inmediato. El worker existente procesa este tipo y
conserva el flujo de invitaciones. No requiere un cron externo ni un servicio
contratado. Reintentos persistentes con backoff de 30 segundos hasta una hora,
`attemptCount` y `lastErrorCode`. Un error SQL revierte la tarea y se informa por
el loop; el borrado idempotente permite recuperarla en otra ejecución.

Worker: lock Property → outbox, relee Media, comprueba reloj PostgreSQL; PENDING
caducada → EXPIRED, CANCELLED conserva estado, elimina el objeto S3 y escribe
cleanedAt/auditoría. Los restos internos de cargas interrumpidas pertenecen al
servicio de objetos. READY/ARCHIVED → tarea OBSOLETE sin borrar.
Dos workers o una confirmación concurrente se serializan por Property.

Un fallo entre S3 y commit SQL deja únicamente un objeto PENDING: nunca
visible. Puede repetirse la misma carga o esperar a limpieza. Las cargas con
contenido diferente no sobrescriben el primer objeto. Si el worker está detenido,
la cola y los objetos pendientes permanecen hasta reanudarlo. Las fotos archivadas
se retienen: ninguna política de destrucción histórica ha sido aprobada.

El proveedor local requiere respaldo operativo si se utiliza con datos valiosos;
C1.2 no implementa replicación de disco, antivirus externo ni publicación.

## Pruebas reproducibles

Desde la raíz (las credenciales locales existentes deben permitir al runner crear
y eliminar sus propias bases efímeras):

```text
pnpm --filter @benhouse/api test:integration
pnpm --filter @benhouse/worker test:integration
pnpm --filter @benhouse/storage test:integration
node packages/database/scripts/validate-media-upgrade.mjs
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:validate
```

Los runners API y worker crean servicios de objetos y volúmenes propios,
verificados y eliminados al terminar. El worker utiliza dos bases efímeras.
No ejecutar `db:migrate:deploy` sobre
`benhouse` ni `benhouse_test` para reproducir estas pruebas. El comando global
antiguo `test:integration` todavía incluye suites sobre la base compartida.

Los tres tests antiguos del worker usan ahora una segunda base efímera verificada,
conservando las aserciones de contenido y xmin. No hay exclusiones por nombre.
Los dos P2 heredados permanecen abiertos: detección `.tsx`/`.jsx` de suites y
regresión de geometría inválida de `Property.location_point`.
