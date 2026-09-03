# BenHouse v0.4 — Alcance

## Objetivo

Definir de forma estricta el alcance funcional de BenHouse v0.4, diferenciando:

- lo que debe construirse;
- lo que debe funcionar de extremo a extremo;
- lo que puede operar en sandbox/mock;
- lo que queda expresamente fuera del MVP.

El objetivo es evitar expansión de alcance durante la construcción.

## Principio de alcance

BenHouse v0.4 no pretende replicar todo Idealista o Fotocasa. Debe alcanzar un nivel competitivo en las funciones esenciales de portal inmobiliario y demostrar los diferenciales centrales de BenHouse:

- Intelligence integrada;
- confianza verificable;
- gestión de visitas y ofertas;
- operación inmobiliaria conectada;
- experiencia profesional conectada con demanda y Match.

Toda funcionalidad debe justificar su inclusión porque es necesaria para competir en la experiencia básica, completar el journey principal, demostrar un diferencial estratégico o garantizar seguridad, integridad o testabilidad. Si no cumple uno de estos criterios, queda fuera de v0.4.

## Alcance funcional incluido

### 1. Acceso y cuenta

- registro; login; logout; sesión segura; recuperación de contraseña;
- verificación de email y de teléfono cuando aplique;
- perfil; capacidades de usuario; organización/agencia; miembros de organización; permisos esenciales.

### 2. Propiedades y publicaciones

- creación y edición de inmueble; publicación; pausa; reactivación; cierre;
- fotografías; vídeo y planos cuando corresponda; ubicación; características; precio; historial de precio;
- modalidad de operación; modalidades de alquiler; disponibilidad;
- publicación por propietario o profesional autorizado.

### 3. Venta y alquiler

**Venta:** publicación, búsqueda, contacto, visita, oferta, negociación y operación.

**Alquiler larga duración:** precio mensual, disponible desde, duración/condiciones esenciales, visita, oferta/solicitud cuando corresponda y operación.

**Alquiler de temporada:** fechas, condiciones, disponibilidad y operación.

**Vacacional:** calendario, disponibilidad por fechas, precio y reserva/operación sandbox cuando corresponda.

**Habitaciones:** unidades/habitaciones dentro de una propiedad, disponibilidad individual, precio e información de vivienda compartida.

### 4. Búsqueda

- comprar; alquilar; invertir; ubicación; precio; habitaciones; baños; superficie; tipo de inmueble; características; modalidad de alquiler;
- ordenación; paginación; filtros sincronizados; búsqueda por viewport; dibujo de zona;
- multizona cuando sea técnicamente viable dentro del diseño aprobado.

La búsqueda debe compartir estado entre resultados y mapa.

### 5. Mapa

- Google Maps; marcadores; agrupación/clustering; precio; viewport;
- actualización por movimiento del mapa; selección/dibujo de zona; sincronización con búsqueda;
- acceso contextual a Intelligence.

### 6. Intelligence

- datos estructurados y deterministas; comparables; contexto de precio, demanda y zona;
- snapshots de mercado e inmueble; rankings contextuales cuando los datos lo permitan;
- oportunidades calculadas; Match; explicación opcional mediante IA generativa;
- Intelligence Map con una capa principal activa cada vez.

Intelligence no puede depender de IA generativa para producir sus métricas.

### 7. Zonas

- ficha de zona; contexto de mercado; demanda; oferta; precios; propiedades destacadas;
- rankings/oportunidades contextualizados según calidad de datos.

No existe obligación de mostrar siempre un Top 10.

### 8. Favoritos y alertas

- guardar/quitar favorito; listado de favoritos; búsqueda guardada; alertas de búsqueda; aviso por bajada de precio;
- conservación de favoritos aunque el anuncio cambie de estado;
- reactivación de alerta si un inmueble vuelve al mercado cuando corresponda.

### 9. Mensajería

- conversaciones; participantes; mensajes; contexto de propiedad/operación; permisos por relación; histórico.

No se pretende construir una plataforma de mensajería generalista.

### 10. Visitas

- solicitud; confirmación; cancelación; completada; no-show; agenda; recordatorios;
- relación con propiedad/publicación; resultado de visita.

### 11. Ofertas y negociación

- crear oferta; importe; condiciones; expiración; revisión/contraoferta; aceptación; rechazo; retirada; histórico completo;
- creación de operación tras aceptación válida.

Una oferta aceptada no equivale a operación completada.

### 12. Pujas

- creación/configuración; inicio; pujas; finalización; candidato ganador; validación posterior;
- creación de operación cuando proceda.

La UX no debe tener apariencia de juego/apuestas.

### 13. Operaciones

- creación; participantes; requisitos; estados; documentación; contrato; firma; pago; cancelación; finalización; historial; trazabilidad.

La operación es el contenedor principal de la fase transaccional.

### 14. Documentación

- subida; almacenamiento privado; estado; validación; rechazo; motivo de rechazo; permisos;
- relación con persona/inmueble/operación; expiración cuando aplique; acceso temporal/autorizado.

### 15. Verificación y confianza

- verificación progresiva de persona, inmueble y organización; evidencias de confianza;
- explicación básica de por qué está verificado; señales derivadas de comportamiento verificable.

No utilizar un score arbitrario como única representación pública de confianza.

### 16. Contratos y firma

- generación de contrato demo; versionado; participantes; envío a firma; estados;
- firma mediante sandbox/mock/proveedor cuando esté disponible;
- confirmación mediante webhook/evento fiable; almacenamiento privado; histórico.

v0.4 no implica validez jurídica definitiva para contratación real.

### 17. Pagos y comisión

- PaymentProvider; PSP en sandbox/test; creación de pago; estados; reintento; webhooks verificados; idempotencia;
- comisión BenHouse configurada; seguimiento interno de comisión.

La comisión de trabajo de v0.4 puede configurarse inicialmente al 2%. No procesar dinero real en v0.4.

### 18. Actividad, tareas y notificaciones

- centro de actividad; pendientes; tareas accionables; recordatorios; notificaciones in-app; email; eventos relevantes;
- resolución automática de tareas cuando el requisito se completa.

### 19. Propietario

- propiedades; publicaciones; visitas; ofertas; operaciones; rendimiento privado; visualizaciones; favoritos; contactos.

Estas métricas no son públicas.

### 20. Profesional / Agencia

- organización; miembros; cartera; leads; clientes autorizados; agenda; mensajes; visitas; ofertas; operaciones;
- Intelligence; Match; rendimiento.

El CRM debe reutilizar las entidades reales de BenHouse. No duplicar usuarios, propiedades, visitas u ofertas.

### 21. Inversor

- búsqueda; zonas; Intelligence; oportunidades; favoritos; comparativas esenciales.

No incluir gestión avanzada de cartera, fiscalidad o productos financieros.

### 22. Administración

- usuarios; publicaciones; verificaciones; documentación; incidencias; operaciones; pagos; auditoría;
- acciones administrativas esenciales.

No construir un ERP interno.

### 23. Analytics y auditoría

- eventos analíticos y de backend; métricas básicas; actividad de propiedades; audit trail;
- eventos críticos inmutables; trazabilidad.

### 24. Responsive y UX

- escritorio; tablet; móvil web; loading; error; success; empty; permission denied;
- accesibilidad básica; navegación contextual.

## Integraciones por nivel

### Reales

- frontend; backend; PostgreSQL; Prisma; PostGIS; autenticación; búsqueda; mapa; Intelligence Engine;
- favoritos; visitas; ofertas; operaciones; mensajería; CRM; activity/events; storage.

### Reales en sandbox/test

- Google Maps; email; pagos; almacenamiento externo cuando se configure.

### Sandbox/mock aceptado

- firma; KYC/identidad; contrato jurídico demo; datos de mercado iniciales.

### Opcional

- IA generativa.

El producto debe seguir funcionando si la IA generativa no está disponible.

## Fuera de alcance de v0.4

Quedan expresamente fuera:

- aplicación móvil nativa; BenPoints; wallet visible al usuario; criptomonedas; sistema bancario propio; custodia directa de dinero por BenHouse;
- productos financieros avanzados; seguros; fiscalidad avanzada; contabilidad avanzada; ERP completo; marketplace masivo de profesionales;
- reformas/remodelaciones; abogados como marketplace profesional; marketing automation avanzado; CRM enterprise;
- estructuras complejas de permisos empresariales; microservicios; Kubernetes obligatorio; Kafka;
- internacionalización comercial completa; app nativa; web push como requisito;
- IA autónoma tomando decisiones legales/económicas; dinero real; firma jurídica definitiva;
- contratación comercial real sin validación legal previa.

## Regla de no expansión

Durante la construcción, cualquier propuesta se clasificará:

### P0

Necesaria para seguridad, integridad, pérdida de datos o bloqueo técnico. Se corrige inmediatamente.

### P1

Necesaria para completar correctamente una funcionalidad ya aprobada. Se integra dentro del bloque correspondiente.

### P2

Mejora importante pero no necesaria para completar v0.4. Va a backlog.

### Nueva funcionalidad

Va a backlog post-v0.4.

## Criterio de cierre

El alcance de v0.4 se considera satisfecho cuando las dos historias principales definidas en `00-VISION.md` pueden ejecutarse de extremo a extremo, los diferenciales centrales son demostrables y todos los criterios de `14-DEFINITION-OF-DONE.md` están satisfechos.
