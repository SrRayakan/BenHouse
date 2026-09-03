# BenHouse v0.4 — Integraciones Externas y Providers

## Objetivo

Definir cómo BenHouse v0.4 debe integrarse con servicios externos sin acoplar el dominio a proveedores concretos.

Este documento debe impedir:

- lógica de negocio dependiente de un proveedor;
- secretos hardcodeados;
- confirmaciones críticas basadas en frontend;
- mezcla de sandbox y producción;
- URLs públicas inseguras;
- webhooks sin verificación;
- dependencia innecesaria de IA generativa;
- reemplazos costosos de arquitectura al cambiar de proveedor.

Principio general:

El dominio de BenHouse utiliza contratos internos.

Los proveedores externos son adaptadores sustituibles.

---

# 1. Providers oficiales

BenHouse v0.4 debe abstraer como mínimo:

- MapsProvider
- PaymentProvider
- SignatureProvider
- IdentityProvider
- StorageProvider
- EmailProvider
- AIProvider

Cada provider debe exponer únicamente las capacidades que BenHouse realmente necesita.

No diseñar interfaces gigantes “por si acaso”.

---

# 2. Regla de dependencia

La dirección de dependencia debe ser:

DOMINIO BENHOUSE
→ INTERFAZ INTERNA
→ ADAPTADOR
→ PROVEEDOR EXTERNO

Nunca:

DOMINIO
→ SDK DEL PROVEEDOR DIRECTAMENTE

Ejemplo:

OperationService
→ PaymentProvider
→ StripePaymentAdapter

No:

OperationService
→ Stripe SDK

---

# 3. MapsProvider

Proveedor visual oficial de v0.4:

Google Maps.

Responsabilidades:

- render de mapa;
- markers;
- clustering;
- viewport;
- geocoding cuando corresponda;
- interacción de dibujo/selección de zona;
- información cartográfica necesaria para UX.

PostGIS sigue siendo autoridad backend para consultas geoespaciales.

Google Maps no sustituye PostGIS.

---

# 4. Google Maps

Integración real en v0.4.

Debe soportar:

- mapa;
- markers;
- clusters;
- selección;
- movimiento;
- zoom;
- bounds;
- dibujo de zona cuando sea compatible;
- sincronización con resultados.

La integración debe cargar solo librerías necesarias.

Evitar costes/API calls innecesarios.

---

# 5. Google Maps Keys

Las claves deben estar en variables de entorno.

Nunca en repositorio.

Aplicar restricciones cuando corresponda:

- dominio/referrer;
- APIs autorizadas;
- entorno.

Separar claves entre:

- local;
- staging;
- production.

No reutilizar una única clave irrestricta.

---

# 6. Geocoding

Cuando se utilice geocoding:

- validar resultados;
- normalizar datos;
- asociar Location interna;
- no depender exclusivamente del texto del proveedor.

BenHouse debe conservar estructura geográfica propia.

---

# 7. PostGIS + Maps

Separación:

## PostGIS

Responsable de:

- bbox;
- polygon;
- radius;
- spatial indexes;
- contains/intersects;
- relaciones geográficas.

## MapsProvider

Responsable de:

- visualización;
- interacción;
- experiencia.

No trasladar búsquedas críticas a Google Maps si PostgreSQL/PostGIS puede resolverlas.

---

# 8. PaymentProvider

PaymentProvider opera exclusivamente a nivel de `PaymentAttempt`: crea/inicia el intento externo, devuelve `providerReference`, aporta datos de sesión, verifica webhooks, consulta estado, ejecuta refund y normaliza errores. PaymentService conoce la obligación `Payment`; el adapter no decide lógica económica ni de Operation.

Flujo: Operation → Payment obligation → PaymentAttempt → PaymentProvider → providerReference → hosted payment → webhook → Attempt → reevaluación de Payment, Commission y Operation. Retry crea un Attempt nuevo; no revive FAILED. Timeout puede mantener PROCESSING hasta webhook, consulta o reconciliación. MockPaymentProvider simula Attempts y no cambia Payment directamente. Sandbox mantiene intentos históricos e idempotencia, sin dinero real.

v0.4 necesita pago en sandbox/test.

Debe abstraer:

- creación de sesión/intención;
- estado;
- provider reference;
- webhook verification;
- refund cuando corresponda;
- errores;
- metadata mínima;
- idempotencia.

El dominio utiliza Payment interno.

---

# 9. PSP inicial

La implementación puede utilizar Stripe o un PSP equivalente compatible con marketplace/test mode.

La elección concreta debe priorizar:

- sandbox estable;
- webhooks;
- idempotencia;
- documentación;
- soporte europeo;
- evolución futura hacia marketplace.

No acoplar el dominio a “StripeIntent” como entidad central.

---

# 10. Pagos en v0.4

Solo test/sandbox.

Nunca realizar:

- cargos reales;
- transferencias reales;
- custodia real de dinero.

La UI debe indicar entorno demo cuando proceda.

---

# 11. Creación de Payment

Flujo:

1. Operation determina necesidad.
2. Backend calcula amount.
3. Backend calcula contexto de Commission.
4. Payment se crea internamente.
5. Application layer crea PaymentAttempt.
6. PaymentProvider recibe el contexto del Attempt y crea/inicia la operación externa.
7. El providerReference devuelto se persiste en PaymentAttempt.providerReference.
8. frontend recibe datos necesarios para interacción.
9. proveedor procesa.
10. webhook confirma el Attempt y provoca la reevaluación de Payment.

El frontend nunca envía amount final como fuente autoritativa.

---

# 12. Confirmación de pago

Fuente fiable:

webhook verificado / consulta fiable del Provider.

No:

redirect del navegador.

Flujo:

PROVIDER
→ WEBHOOK
→ VERIFY
→ IDEMPOTENCY
→ APPLICATION SERVICE
→ PAYMENT STATE
→ OUTBOX
→ OPERATION

---

# 13. Payment webhook

Debe verificar:

- raw body cuando sea necesario;
- signature;
- provider event id;
- timestamp/replay si disponible;
- idempotencia.

No aceptar:

“signature header existe”

como validación suficiente.

---

# 14. PaymentProvider failure

Si PSP falla temporalmente:

- Payment permanece recuperable;
- Operation no se cancela automáticamente;
- usuario puede reintentar cuando proceda;
- error se registra;
- no duplicar intentos/cargos.

---

# 15. Commission

Commission no depende del PSP concreto.

El cálculo es BenHouse.

PaymentProvider ejecuta procesos externos.

La comisión del 2% inicial es configuración de negocio.

No hardcodear dentro del adaptador del PSP.

---

# 16. SignatureProvider

Debe abstraer:

- creación de solicitud;
- firmantes;
- sesión/link autorizado;
- provider reference;
- estados;
- webhook;
- cancelación/expiración;
- errores.

Signature y Contract son entidades BenHouse.

---

# 17. Firma en v0.4

Aceptado:

- sandbox;
- mock contractual;
- proveedor real de test.

No se afirma validez jurídica definitiva.

La arquitectura debe permitir sustituir provider sin rehacer Operation.

---

# 18. Signature mock

Si se utiliza mock:

debe comportarse como provider real conceptualmente.

Debe soportar:

- request;
- pending;
- signed;
- failed;
- declined;
- expired;
- webhook/event simulation;
- idempotencia.

No crear un botón que simplemente haga:

`status = SIGNED`

sin pasar por el flujo aprobado.

---

# 19. Signature webhook

Flujo:

provider
→ verify
→ normalize
→ SignatureService
→ Signature state
→ Contract reevaluation
→ outbox
→ Operation reevaluation

No actualizar Contract directamente desde controller de webhook sin pasar por reglas.

---

# 20. IdentityProvider

Responsable de:

- iniciar verificación;
- crear sesión KYC;
- provider reference;
- estado;
- resultado;
- expiración;
- webhook/callback;
- metadata mínima.

Verification interna pertenece a BenHouse.

---

# 21. KYC en v0.4

Puede utilizar:

- MockIdentityProvider;
- sandbox real.

No bloquear el MVP esperando proveedor comercial definitivo.

La arquitectura debe permitir sustituirlo.

---

# 22. MockIdentityProvider

Debe permitir escenarios de test:

- VERIFIED;
- FAILED;
- EXPIRED;
- REVOKED cuando corresponda.

No dejar endpoint público:

“mark verified”.

Los escenarios mock deben estar restringidos a:

- local;
- test;
- staging/demo autorizado.

Nunca production real.

---

# 23. Metadata KYC

No almacenar más información sensible de la necesaria.

Preferir:

- provider reference;
- status;
- verification type;
- timestamps;
- metadata segura.

No copiar automáticamente documentos completos del proveedor.

---

# 24. StorageProvider

Debe abstraer:

- upload authorization;
- download authorization;
- object metadata;
- object existence;
- delete/archive cuando corresponda;
- public/private policies.

---

# 25. Tipos de storage

Separar lógicamente:

## Public Media

- fotografías;
- vídeos;
- planos públicos autorizados.

## Private Documents

- identidad;
- contratos;
- documentación de propiedad;
- documentos operativos.

No compartir políticas de acceso.

---

# 26. Public media

Puede utilizar:

- CDN;
- public object;
- optimized delivery.

Pero debe poder controlarse:

- ownership;
- upload;
- deletion;
- metadata.

---

# 27. Private documents

No utilizar URLs públicas permanentes.

Descarga:

1. request a BenHouse;
2. authenticate;
3. authorize;
4. validate policy;
5. generate temporary signed URL;
6. audit si corresponde.

---

# 28. Upload flow

Flujo recomendado:

frontend
→ request upload-intent
→ backend validates
→ StorageProvider creates signed upload
→ frontend uploads directly
→ complete-upload
→ backend verifies object
→ resource state changes

Esto evita enviar archivos grandes innecesariamente a través de API.

---

# 29. Upload security

Validar:

- MIME;
- size;
- extension cuando sea útil;
- expected resource;
- ownership;
- path/key;
- expiry.

Para documentos sensibles considerar:

- malware scanning futuro o básico si la infraestructura elegida lo permite.

No ampliar v0.4 con sistema antivirus complejo si no es necesario.

---

# 30. Storage keys

StorageKey es interno.

No debe exponerse como URL directamente.

Utilizar estructura consistente.

Ejemplo conceptual:

public/properties/{propertyId}/...
private/users/{userId}/...
private/operations/{operationId}/...

La estructura concreta no debe revelar información sensible innecesaria.

---

# 31. EmailProvider

Responsabilidades:

- envío;
- templates;
- status;
- provider reference opcional;
- error normalization.

No mezclar templates con controllers.

---

# 32. Email en desarrollo

Utilizar:

- mail catcher;
- local SMTP;
- servicio dev equivalente.

No enviar accidentalmente emails reales a usuarios externos.

---

# 33. Email en staging

Puede utilizar proveedor real con dominio/configuración de pruebas.

Debe permitir demostrar:

- verify email;
- reset password;
- visit reminder;
- offer update;
- document status;
- signature;
- payment;
- operation.

---

# 34. Email en production

Proveedor se decidirá/configurará antes de lanzamiento real.

Arquitectura ya preparada.

---

# 35. Email failure

Email es efecto secundario.

Si falla:

- evento original permanece;
- handler reintenta;
- error observable;
- dominio no hace rollback.

---

# 36. Email templates

Templates en español para v0.4.

Deben ser:

- claros;
- breves;
- branding consistente;
- responsive.

No marketing automation.

---

# 37. AIProvider

AIProvider es opcional.

Puede utilizar OpenAI u otro proveedor compatible.

No forma parte de la fuente de verdad del dominio.

---

# 38. Uso aprobado de IA

Puede ayudar a:

- explicar Intelligence;
- resumir comparables;
- generar descripción comprensible de métricas;
- asistir en copy contextual aprobado.

No debe:

- inventar precios;
- fabricar demanda;
- decidir confianza;
- aceptar ofertas;
- cambiar operaciones;
- calcular comisiones;
- autorizar pagos;
- determinar identidad;
- tomar decisiones legales.

---

# 39. Intelligence + AI

Flujo:

DATA
→ INTELLIGENCE ENGINE
→ STRUCTURED RESULT
→ OPTIONAL AI EXPLANATION

No:

DATA
→ LLM
→ METRIC

---

# 40. AI failure

Si AIProvider:

- timeout;
- quota;
- error;
- no configured;

BenHouse sigue mostrando:

- métricas;
- comparables;
- demanda;
- contexto.

La IA nunca bloquea el journey principal.

---

# 41. AI prompts

Prompts deben:

- trabajar sobre datos estructurados;
- limitar afirmaciones;
- evitar inventar;
- solicitar lenguaje español;
- indicar incertidumbre;
- no exponer datos privados.

Prompts importantes deben versionarse cuando corresponda.

---

# 42. AI output

Cuando la salida influya en UI:

validar estructura.

Preferir structured output.

No renderizar texto arbitrario sin control en contextos sensibles.

---

# 43. MapsProvider failure

Si Google Maps no carga:

Search list debe seguir funcionando.

Mostrar error contextual:

“No hemos podido cargar el mapa.”

No bloquear búsqueda completa.

---

# 44. StorageProvider failure

Si falla upload:

- no marcar recurso como UPLOADED;
- permitir reintento;
- no perder metadata necesaria.

Si falla download:

- error controlado;
- no cambiar estado de documento.

---

# 45. IdentityProvider failure

Verification:

- PENDING / FAILED según naturaleza;
- reintento cuando proceda;
- Operation permanece pendiente si requisito es obligatorio.

No cancelar automáticamente.

---

# 46. SignatureProvider failure

Signature:

- FAILED o pendiente recuperable;
- Operation no se completa;
- Task puede pedir reintento.

---

# 47. PaymentProvider failure

Si el proveedor falla de forma confirmada:

PaymentAttempt:

- FAILED.

Payment:

- PENDING si puede reintentarse.

Operation:

- PAYMENT_PENDING.

Si el resultado externo es incierto o sigue en proceso:

PaymentAttempt:

- PROCESSING.

Payment:

- IN_PROGRESS.

Operation:

- PAYMENT_PROCESSING.

No completar ni cancelar Operation automáticamente; mantener trazabilidad.

---

# 48. Provider normalization

Cada adapter traduce estados externos a estados internos.

Ejemplo:

Stripe status X
→ PaymentAttempt.PROCESSING → Payment.IN_PROGRESS

BenHouse no expone directamente todos los estados del provider.

Esto permite cambiar proveedor.

---

# 49. Provider references

Guardar referencias externas necesarias.

Ejemplos:

- payment provider transaction id;
- signature envelope id;
- identity verification id;
- email message id.

No utilizarlas como primary key de dominio.

---

# 50. Provider configuration

Cada provider debe configurarse por entorno.

Variables conceptuales:

MAPS_API_KEY
PAYMENT_PROVIDER
PAYMENT_SECRET
PAYMENT_WEBHOOK_SECRET
SIGNATURE_PROVIDER
SIGNATURE_SECRET
IDENTITY_PROVIDER
IDENTITY_SECRET
STORAGE_PROVIDER
STORAGE_BUCKET_PUBLIC
STORAGE_BUCKET_PRIVATE
EMAIL_PROVIDER
EMAIL_SECRET
AI_PROVIDER
AI_API_KEY

Los nombres finales pueden ajustarse.

---

# 51. Config validation

Al iniciar:

validar configuración.

Si feature está habilitada y falta secreto crítico:

fail fast.

Ejemplo:

PAYMENTS_ENABLED=true
pero falta payment secret
→ aplicación no arranca en entorno donde es obligatorio.

---

# 52. Feature flags

Providers opcionales deben poder controlarse.

Ejemplo:

FEATURE_AI_EXPLANATIONS=false
FEATURE_AUCTIONS=true
FEATURE_SIGNATURE_SANDBOX=true
FEATURE_KYC_SANDBOX=true

No esconder fallos de configuración detrás de flags mal utilizadas.

---

# 53. Sandbox isolation

Sandbox y production deben estar separados.

Nunca:

- claves sandbox en production;
- webhook sandbox actualizando DB production;
- storage demo mezclado con documentos reales;
- datasets synthetic en métricas reales.

---

# 54. Demo environment

Staging/demo puede usar:

- Google Maps real;
- Payment sandbox;
- Signature sandbox/mock;
- Identity sandbox/mock;
- Email test;
- synthetic market data;
- private storage real de demo.

Debe existir indicación interna y UX cuando la acción pueda confundirse con real.

---

# 55. Synthetic data

Los datos de mercado demo deben incluir:

- demoSynthetic=true;
- source;
- datasetVersion.

Intelligence debe propagar esa condición.

La UI demo puede mostrar:

“Datos de demostración”.

Nunca afirmar:

“Demanda real de BenHouse”

si procede de seed.

---

# 56. Webhook normalization

Todo webhook externo se transforma en un ProviderEvent interno normalizado.

Ejemplo conceptual:

{
  provider: "...",
  providerEventId: "...",
  type: "...",
  resourceReference: "...",
  occurredAt: "...",
  verified: true
}

Después pasa a Application Service.

---

# 57. Raw webhook payload

Guardar solo cuando sea necesario y permitido.

Preferir:

- event id;
- hash;
- tipo;
- timestamps;
- metadata mínima.

Evitar almacenar datos sensibles completos por comodidad.

---

# 58. Replay protection

Cuando el provider lo soporte:

- timestamp;
- nonce/event id;
- signature;
- tolerancia temporal.

Siempre usar providerEventId/idempotencia.

---

# 59. Timeouts

Toda llamada externa debe tener timeout.

No permitir request HTTP colgado indefinidamente.

Definir por provider.

---

# 60. Retries

Retries solo cuando sean seguros.

Ejemplos:

GET provider status
→ puede reintentarse.

Create payment
→ requiere idempotency key.

Send email
→ handler idempotente.

No reintentar POST externos ciegamente.

---

# 61. Circuit breaking

No es obligatorio introducir librería de circuit breaker en v0.4.

Pero los adapters deben:

- manejar timeout;
- clasificar errores;
- evitar cascadas.

Si métricas futuras muestran necesidad:

backlog.

---

# 62. Provider errors

Normalizar errores a tipos internos.

Ejemplos:

ProviderUnavailable
ProviderTimeout
ProviderInvalidRequest
ProviderAuthenticationError
ProviderRateLimited

No filtrar raw error completo a UI.

---

# 63. Observabilidad de providers

Medir:

- calls;
- latency;
- errors;
- timeouts;
- webhook failures;
- retries.

No registrar secretos ni payload sensible.

---

# 64. Request correlation

Propagar requestId/correlationId cuando sea útil hacia provider metadata.

Esto facilita debugging.

No enviar datos personales innecesarios.

---

# 65. Provider abstraction anti-overengineering

No crear:

`AbstractProviderFactoryStrategyManager`

o arquitectura excesiva.

Interfaces simples.

Ejemplo conceptual:

interface PaymentProvider {
  createPaymentSession(...)
  verifyWebhook(...)
  refund(...)
}

Implementaciones:

MockPaymentProvider
StripePaymentProvider

Suficiente.

---

# 66. Dependency injection

NestJS debe inyectar provider mediante token/interface compatible.

Ejemplo conceptual:

PAYMENT_PROVIDER

La selección depende de configuración.

No importar adapter concreto desde Domain Service.

---

# 67. Mock providers

Mocks deben existir cuando permitan:

- desarrollo sin credenciales;
- tests;
- escenarios de fallo;
- demo.

Deben ser deterministas.

No simular únicamente éxito.

Casos:

- success;
- failed;
- timeout;
- expired.

---

# 68. Test providers

Integration tests no deben depender siempre de servicios externos reales.

Utilizar:

- mock adapter;
- fixtures;
- webhook fixtures verificadas;
- sandbox E2E separado.

---

# 69. Contract tests

Cada adapter real debe cumplir contrato del provider interno.

Ejemplo PaymentProvider:

mismo comportamiento esperado para:

- Mock;
- Stripe;
- futuro PSP.

Crear contract tests cuando aporte valor.

---

# 70. Google Maps testing

No depender de llamadas reales para todos los tests.

Separar:

- geospatial backend tests PostGIS;
- UI map component;
- integration manual/E2E con Google Maps en staging.

---

# 71. AI testing

AI explanation no debe basar tests en texto literal exacto.

Testear:

- estructura;
- grounding;
- presencia de datos;
- ausencia de claims prohibidos;
- fallback.

No hacer tests frágiles de redacción.

---

# 72. Storage testing

Testear:

- autorización;
- upload intent;
- complete upload;
- private download;
- expired signed URL;
- unauthorized access;
- MIME invalid;
- oversized file.

---

# 73. Webhook testing

Para Payment/Signature/Identity:

testear:

- valid signature;
- invalid signature;
- repeated event;
- unknown resource;
- old event;
- incompatible state;
- retry;
- provider timeout where relevant.

---

# 74. Secret handling

Secretos jamás:

- commit;
- frontend bundle;
- logs;
- error response;
- analytics.

Utilizar:

- environment;
- secret manager futuro/hosting.

NEXT_PUBLIC_* solo para valores que realmente pueden ser públicos.

---

# 75. Frontend environment

Una variable expuesta al navegador debe asumirse pública.

Nunca colocar:

- PSP secret;
- webhook secret;
- AI secret;
- private storage secret;
- JWT/session secrets

en variables públicas.

---

# 76. Backend-only providers

Estos providers deben ejecutarse principalmente en backend:

- PaymentProvider;
- IdentityProvider;
- SignatureProvider;
- EmailProvider;
- AIProvider con secret;
- private StorageProvider operations.

Frontend puede usar SDK público del provider solo cuando el flujo lo requiera, utilizando tokens/sessions efímeros generados por backend.

---

# 77. Provider direct browser flows

Ejemplos permitidos:

- Google Maps JS;
- payment hosted element/session;
- signature hosted session;
- direct signed upload.

Siempre iniciados/configurados de forma segura por backend cuando hay datos sensibles.

---

# 78. Legal boundary

La integración técnica no implica aprobación legal.

Antes de production real deben validarse:

- KYC;
- firma;
- contratos;
- pagos;
- comisión;
- privacidad;
- retención;
- obligaciones regulatorias.

v0.4 sandbox no bloquea esa validación futura.

---

# 79. Vendor lock-in

No intentar eliminar todo vendor lock-in.

Google Maps puede ser decisión explícita de producto.

El objetivo es evitar lock-in crítico donde afectaría:

- dominio;
- estados;
- dinero;
- documentos;
- identidad;
- IA.

Pragmatismo sobre abstracción total.

---

# 80. Fallbacks

## Maps
list search sigue funcionando.

## AI
structured Intelligence sigue funcionando.

## Email
in-app Activity/Notification permanece.

## Payment
Operation queda pendiente.

## Signature
Operation queda pendiente.

## Identity
Verification queda pendiente.

## Storage
upload/download falla controladamente.

---

# 81. No silent fallback inseguro

Nunca sustituir secret faltante por:

`secret`

Nunca usar:

mock provider automáticamente en production

porque falló configuración.

Mocks requieren configuración explícita y entorno permitido.

---

# 82. Provider health

Puede existir health check técnico cuando sea útil.

No hacer llamadas externas costosas en cada `/health`.

Separar:

- app health;
- readiness;
- provider diagnostics cuando corresponda.

---

# 83. Rate limits externos

Adapters deben manejar:

- 429;
- Retry-After;
- backoff cuando corresponda.

No generar loops agresivos.

---

# 84. Cost awareness

Google Maps, AI y otros proveedores pueden generar coste.

La implementación debe evitar:

- requests duplicadas;
- geocoding repetido;
- AI calls innecesarias;
- recálculos globales por acción trivial.

Cachear de forma segura cuando tenga sentido.

---

# 85. AI call policy

No ejecutar AI automáticamente para cada Property render.

Preferir:

- snapshots;
- pre-generation;
- on-demand explanation;
- caching/versioning.

Esto protege coste y rendimiento.

---

# 86. Geocoding policy

No geocodificar la misma dirección cada vez que se renderiza.

Geocoding ocurre:

- al crear/modificar ubicación;
- cuando sea necesario.

Resultado normalizado se persiste.

---

# 87. Media optimization

Storage/CDN debe permitir:

- thumbnails;
- responsive images;
- WebP/AVIF cuando infraestructura lo permita.

No bloquear v0.4 por pipeline de imágenes excesivamente avanzado.

Next.js Image puede ayudar en frontend.

---

# 88. Provider audit

Acciones críticas externas deben poder correlacionarse.

Ejemplo:

Payment:
- internal paymentId;
- requestId;
- AuditEvent.

PaymentAttempt:
- providerReference.

El mecanismo técnico de ProviderEvent deduplica providerEventId. Un Payment puede tener varios Attempts y cada Attempt puede recibir varios provider events.

Nunca depender solo del dashboard del proveedor para comprender qué ocurrió.

---

# 89. Integración con Activity

Providers no crean Activity directamente.

Ejemplo:

SignatureProvider webhook
→ SignatureService
→ SIGNATURE_CONFIRMED
→ DomainEvent
→ Activity handler.

Mantener separación.

---

# 90. Integración con Tasks

Igual:

PaymentAttempt FAILED
→ DomainEvent
→ Task handler
→ “Reintentar pago”.

No:

StripeAdapter
→ create Task.

---

# 91. Integración con Intelligence

AIProvider no escribe directamente MarketSnapshot.

IntelligenceEngine crea resultados estructurados.

AI solo consume resultados.

---

# 92. Integración con Trust

IdentityProvider VERIFIED
→ Verification cambia
→ DomainEvent
→ TrustEvidence handler.

IdentityProvider no crea score de confianza.

---

# 93. Integración con Operation

Operation nunca depende de nombres específicos del provider.

Incorrecto:

Operation.status = STRIPE_SUCCEEDED

Correcto:

Payment.status = CONFIRMED
→ Operation reevaluation.

---

# 94. Provider replacement checklist

Antes de aceptar una abstracción debe ser posible conceptualmente:

Stripe → otro PSP

sin cambiar:

- Operation;
- Commission;
- Requirement;
- Payment states principales.

Signature Provider A → B

sin cambiar:

- Contract;
- Operation.

Identity Provider A → B

sin cambiar:

- Verification semantics.

---

# 95. Integraciones fuera de alcance

No introducir en v0.4 salvo P0/P1 real:

- Apple Pay específico si PSP no lo resuelve automáticamente;
- crypto;
- Open Banking;
- seguros;
- scoring bancario;
- hipotecas reales integradas;
- notaría digital real;
- firma cualificada definitiva;
- government identity integration;
- WhatsApp Business;
- SMS masivo;
- marketing platforms;
- Salesforce;
- external enterprise CRM sync;
- accounting software;
- ERP;
- advanced BI providers.

---

# 96. Integraciones futuras compatibles

La arquitectura debe permitir añadir en futuro:

- nuevos PSP;
- firma real;
- KYC real;
- web push;
- SMS;
- feeds inmobiliarios;
- Open Banking;
- hipotecas;
- seguros;
- calendarios externos;
- CRM integrations.

Pero no construir ahora.

---

# 97. Configuración mínima para empezar Codex

Durante construcción inicial:

pueden usarse mocks para:

- PaymentProvider;
- SignatureProvider;
- IdentityProvider;
- EmailProvider;
- AIProvider;
- StorageProvider local compatible.

Google Maps puede integrarse cuando exista key.

PostGIS debe funcionar desde Foundation.

No bloquear scaffold por falta de cuentas externas.

---

# 98. Criterio de integración real

Una integración se considera “real” cuando:

- utiliza API/SDK real;
- credenciales del entorno;
- errores gestionados;
- security validada;
- webhooks donde aplique;
- tests sandbox;
- observabilidad mínima.

No llamar integración real a:

botón que cambia estado localmente.

---

# 99. Criterio sandbox

Una integración sandbox es válida cuando:

- utiliza flujo equivalente al real;
- mantiene estados internos;
- respeta webhooks/eventos;
- puede simular éxito/fallo;
- no realiza efectos comerciales reales.

---

# 100. Criterio de cierre

Las integraciones de v0.4 se consideran correctamente diseñadas cuando:

- Domain no depende de vendor SDK;
- Maps utiliza Google Maps + PostGIS correctamente;
- Payment funciona en sandbox;
- Signature puede funcionar sandbox/mock;
- Identity puede funcionar sandbox/mock;
- Storage diferencia público/privado;
- email es asíncrono;
- AI es opcional;
- webhooks son verificados e idempotentes;
- secretos están aislados;
- entornos no se mezclan;
- fallos externos no corrompen Operation;
- mocks no pueden activarse silenciosamente en production.
