# C1.2 — Sustitución del filesystem por objetos locales

Decisión previa a la integración, 2026-10-14. Sustituye la elección de filesystem
de C1-MEDIA-DECISION.md, conservando sus reglas de dominio. Autorizada expresamente
por el usuario después de reproducir el escape mediante junction y la carrera.

Se elige **RustFS 1.0.1**, servicio S3 autohospedado, en un único nodo Docker Linux.
La [release oficial](https://github.com/rustfs/rustfs/releases/tag/1.0.1) está
publicada y el proyecto mantiene actividad. Su
[licencia en ese tag](https://github.com/rustfs/rustfs/blob/1.0.1/LICENSE) es
Apache-2.0; este uso local del servicio no requiere compra ni servicio Connect.
Se preservan los avisos de la imagen; no se modifica ni redistribuye su source.
No se elige una imagen `latest`: se fijará también el digest descargado.

Requisitos consultados: [Docker oficial](https://docs.rustfs.com/en/installation/container/docker)
y [referencia CLI](https://docs.rustfs.com/en/reference/cli). Contenedor Linux,
volumen escribible por UID/GID 10001, endpoint S3 y credenciales explícitas.
Docker local verificado: Linux amd64, 16 CPUs, aproximadamente 7,5 GiB de RAM.
Las pruebas comprobarán arranque y funcionamiento real; no constituyen sizing de
producción. Consola deshabilitada, capacidades eliminadas, root filesystem de
solo lectura, volumen Docker nuevo sin bind mounts y red exclusiva.

En desarrollo Windows, solo S3 se publica en `127.0.0.1` con puerto asignado por
Docker y credenciales aleatorias generadas para cada ejecución. API/worker usan
el SDK S3 por HTTP de loopback. Ningún objeto se escribe a través de una ruta del
host, ni se entrega su URL al navegador. Web no recibe volumen ni credenciales.
No se modifica `.env`, compose de PostgreSQL ni el volumen histórico.

Se conserva StorageProvider. PUT único (sin multipart), tamaño acotado y
`If-None-Match: *`: existe -> leer y comparar bytes; diferentes -> conflicto.
Se verificará la exclusión concurrente en este único endpoint; no se certifica
un cluster distribuido. GET acotado y verificado en confirmación; DELETE
idempotente solo para intenciones incompletas autorizadas por el worker.
Los restos internos de un PUT interrumpido pertenecen al servicio, nunca son
objetos READY; se comprobarán interrupción, ausencia de objetos parciales y
reintento. Se conserva archivo sin destrucción de fotos confirmadas.

Modelo de amenazas: clientes sin credenciales, permisos revocados y procesos
que sustituyen rutas/junctions del host no acceden al volumen. Administrador de
Docker/Windows, credenciales de backend comprometidas y acceso a memoria del
proceso son fronteras de confianza; pueden controlar el servicio. No se afirma
aislamiento frente al administrador. HTTP solo es admisible en loopback local;
un despliegue remoto requerirá TLS y una política de red propia.

La aceptación exige comprobar autenticación, puerto/red, volumen exclusivo,
carreras, APNG/WebP animados y HTTP sin READY. Se ensayará copia/restauración con
objetos sintéticos entre dos servicios/volúmenes efímeros, verificando bytes y
SHA-256. Ningún backup ni dato histórico será utilizado. Todos los recursos
de pruebas tendrán identidad y etiqueta propias, comprobadas antes de borrar.

Siguen abiertos los P2 de C1.1: detección .tsx/.jsx y geometría inválida de
Property.location_point. No se implementa C1.3.
