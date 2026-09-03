# BenHouse v0.4 — Permisos y Autorización

## Objetivo

Definir el modelo oficial de permisos, autorización y acceso a recursos de BenHouse v0.4.

Este documento debe impedir:

- autorización basada solo en frontend;
- acceso por conocer un ID;
- exposición de datos ajenos;
- roles globales demasiado rígidos;
- escaladas de privilegios;
- acciones administrativas no auditadas;
- acceso excesivo a documentación;
- confundir identidad, capacidad y relación con el recurso.

La autorización debe aplicarse siempre en backend.

---

# 1. Principio maestro de autorización

Una acción se permite únicamente cuando se cumplen de forma conjunta los factores relevantes:

IDENTIDAD
+
CAPACIDAD
+
RELACIÓN CON EL RECURSO
+
ORGANIZACIÓN
+
ESTADO DEL RECURSO
+
REQUISITOS
+
POLÍTICA ESPECÍFICA
=
ACCIÓN PERMITIDA

No todas las acciones necesitan todos los factores, pero ninguna acción crítica debe reducirse simplemente a:

`user.role === X`

---

# 2. Identidad

La identidad del actor debe obtenerse de la sesión autenticada.

Nunca utilizar como fuente autoritativa un identificador enviado libremente por el cliente como:

- userId
- ownerId
- fromUserId
- payerId
- bidderId
- signerId
- createdBy

El frontend puede enviar identificadores de recursos relacionados.

La identidad del actor autenticado la determina el backend.

---

# 3. No usar “un usuario = un rol”

BenHouse permite que un mismo User actúe simultáneamente como:

- comprador;
- inquilino;
- propietario;
- inversor;
- profesional;
- miembro de una organización.

Estas capacidades pueden surgir de:

- relaciones con recursos;
- membresía de organización;
- acciones realizadas;
- estado de verificación;
- permisos explícitos.

No crear cuentas duplicadas para cada contexto.

---

# 4. Contextos funcionales

Los siguientes nombres representan contextos/capacidades, no necesariamente roles globales persistidos:

- USER
- BUYER
- TENANT
- OWNER
- INVESTOR
- PROFESSIONAL
- ORGANIZATION_MEMBER
- ORGANIZATION_ADMIN
- ADMIN

El modelo físico puede utilizar relaciones, scopes o capacidades según la solución más simple y segura.

---

# 5. Autorización por recurso

Toda operación sensible debe comprobar la relación concreta del usuario con el recurso.

Ejemplos:

## Property

Puede editarla:

- propietario autorizado;
- profesional/organización autorizada;
- administrador con permiso específico.

No puede editarla:

- cualquier usuario autenticado;
- usuario que simplemente conoce el propertyId.

## Listing

Puede gestionarlo:

- publisher autorizado;
- owner con relación válida;
- organización gestora;
- admin autorizado.

## Offer

Puede verla/actuar sobre ella:

- creador;
- destinatario/propietario/profesional autorizado;
- participantes autorizados;
- admin con permiso.

## Operation

Solo:

- participantes;
- profesionales autorizados asociados;
- admin con permiso.

## Document

Depende de política específica de acceso.

Participar en Operation no concede acceso automático a todos los documentos.

---

# 6. Acceso público vs privado

Los recursos deben distinguir proyecciones públicas y privadas.

## Público

Ejemplos:

- Listing publicado;
- datos públicos de Property;
- imágenes públicas;
- información básica de zona;
- señales públicas de confianza aprobadas;
- perfil profesional público limitado.

## Privado

Ejemplos:

- email;
- teléfono no autorizado;
- documentos;
- ofertas;
- mensajes;
- operaciones;
- pagos;
- firmas;
- analytics privados;
- leads;
- auditoría;
- señales antifraude.

Nunca devolver directamente entidades completas de Prisma como respuesta pública.

Utilizar DTOs/proyecciones.

---

# 7. Property

`PropertyAuthorization` es la fuente explícita de relación sobre Property. `canManageProperty` requiere OWNER/MANAGER activo o contexto de Organization autorizado; `canPublishListing` requiere OWNER/PUBLISHER/MANAGER vigente y, para Organization, membership activa, capability y policy de cartera. `canChangeListingPrice` vuelve a comprobar esa relación vigente y el estado del Listing. Membership no concede acceso universal.

## Lectura

### Pública

Permitida cuando:

- existe Listing público válido;
- la información solicitada forma parte de la proyección pública.

### Privada

Información interna puede ser accesible para:

- owner;
- organización gestora;
- profesionales autorizados;
- admin.

## Escritura

Crear Property:

- usuario autenticado autorizado para publicar;
- profesional autorizado.

Editar:

- owner válido;
- organización/profesional con delegación válida;
- admin autorizado.

Nunca permitir asignar ownership mediante `ownerId` arbitrario enviado por frontend sin comprobar relación.

---

# 8. Listing

## Crear

Requiere:

- autenticación;
- relación válida con Property;
- capacidad de publicar;
- requisitos mínimos.

## Publicar

Requiere:

- actor autorizado;
- Listing en estado permitido;
- requisitos de publicación satisfechos.

## Cambiar precio

Solo:

- publisher/owner autorizado;
- profesional autorizado;
- admin con permiso excepcional.

Genera:

- PriceHistory;
- DomainEvent;
- AuditEvent cuando corresponda.

## Pausar/reactivar/cerrar

Siempre mediante comandos explícitos y autorización.

---

# 9. Organization

## Crear

Usuario autenticado.

Puede requerir verificación adicional según funcionalidad activada.

## Gestionar

Solo:

- OrganizationAdmin;
- miembros con capability específica;
- admin de plataforma autorizado.

## Miembros

Añadir/eliminar miembros requiere capacidad organizativa correspondiente.

Un miembro no adquiere automáticamente acceso a todos los recursos históricos de la organización.

El acceso puede depender de:

- membership activa;
- asignación;
- relación con recurso;
- política.

---

# 10. OrganizationMember

Permisos mínimos iniciales recomendados:

## ORGANIZATION_ADMIN

Puede:

- gestionar organización;
- gestionar miembros esenciales;
- acceder a cartera;
- asignar leads;
- gestionar operaciones autorizadas.

## PROFESSIONAL_MEMBER

Puede:

- acceder a recursos asignados/autorizados;
- gestionar leads;
- visitas;
- mensajes;
- ofertas;
- operaciones según asignación.

No construir RBAC enterprise.

Si durante implementación aparece necesidad de granularidad adicional, clasificarla como P1 solo si es necesaria para una funcionalidad ya aprobada.

---

# 11. Favorite

Solo el usuario propietario del Favorite puede:

- listar;
- crear;
- eliminar.

No se expone públicamente quién ha guardado un Listing.

Owner/agency solo puede recibir métricas agregadas.

---

# 12. SavedSearch

Solo el usuario propietario puede:

- crear;
- leer;
- modificar;
- eliminar.

Profesionales no acceden a búsquedas privadas individuales salvo consentimiento/relación válida.

Intelligence puede utilizar señales agregadas/anónimas respetando privacidad.

---

# 13. DemandSignal

No debe exponerse directamente como información individual a terceros.

Uso permitido:

- Intelligence;
- agregaciones;
- Match;
- analytics.

Un profesional puede ver:

- demanda agregada;
- leads propios/autorizados.

No puede descubrir identidades individuales a partir de señales anónimas sin una relación legítima.

---

# 14. Intelligence

## Público

Puede mostrar:

- contexto de zona;
- demanda agregada;
- comparables;
- indicadores no sensibles.

## Privado profesional

Puede incluir:

- rendimiento de cartera;
- leads propios;
- Match con clientes autorizados;
- demanda relevante agregada.

No exponer:

- datos personales de usuarios;
- búsquedas privadas;
- favoritos individuales;
- señales antifraude.

---

# 15. Conversation

Puede leer Conversation únicamente:

- participante activo;
- admin con permiso específico de soporte/investigación cuando esté permitido.

Enviar Message requiere:

- membership activa en conversación;
- estado de conversación permitido.

No permitir enumeración por IDs.

---

# 16. Message

Sender se obtiene de la sesión.

No aceptar `senderId` autoritativo desde frontend.

No permitir modificar mensajes de otros usuarios.

Si se habilita edición:

- solo autor;
- ventana/regla definida;
- conservar trazabilidad cuando sea necesario.

---

# 17. Visit

## Crear

Usuario autenticado interesado en Listing válido.

No permitir al cliente elegir arbitrariamente `requestedBy`.

## Confirmar

Solo:

- host;
- owner/profesional autorizado;
- workflow automatizado autorizado cuando corresponda.

## Cancelar

Puede cancelar:

- solicitante;
- host autorizado;
- admin en casos permitidos.

Siempre respetando reglas de estado.

## Completar / No-show

Solo actores autorizados.

No cualquier participante.

---

# 18. Offer

## Crear

Usuario autenticado autorizado a ofertar.

No permitir ofertar sobre su propio Listing salvo escenario explícito de test/admin.

## Leer

- creador;
- owner/publisher/profesional autorizado;
- participantes posteriores de Operation cuando corresponda;
- admin autorizado.

## Revisar

Solo partes autorizadas.

## Aceptar/rechazar

Solo parte receptora autorizada.

Aceptar debe verificar nuevamente:

- ownership;
- Listing;
- estado;
- Offer;
- concurrencia.

## Retirar

Solo creador autorizado mientras el estado lo permita.

---

# 19. OfferRevision

Solo partes autorizadas pueden verla.

El actor que crea revisión se obtiene de sesión.

No modificar revisiones históricas.

---

# 20. Auction

## Crear/configurar

Solo:

- owner/publisher/profesional autorizado.

## Ver

Información pública limitada cuando Auction está activa.

## Administrar

Solo actores autorizados.

## Cancelar

Requiere permiso específico, estado permitido y auditoría.

---

# 21. Bid

## Crear

Usuario autenticado autorizado y validado según requisitos de Auction.

`bidderId` se obtiene de sesión.

No se envía autoritativamente desde frontend.

## Exposición

Público puede ver:

- información agregada necesaria;
- importe/reglas cuando corresponda;
- número de participantes si está aprobado.

No mostrar identidades de bidders.

## Histórico interno

Accesible solo a:

- bidder sobre sus propias bids;
- owner/profesional autorizado en la medida necesaria;
- admin autorizado.

---

# 22. Operation

OperationParticipant concede acceso contextual limitado. AGENCY requiere participación de Organization, membership activa, capability y policy. ParticipantRole no es bypass de DocumentAccess ni permisos actuales.

Operation debe tener control de acceso por participante.

Puede acceder:

- OperationParticipant activo;
- organización/profesional autorizado;
- admin con permiso.

No cualquier User relacionado con Listing.

## Acciones

Cada comando verifica además:

- participantRole;
- estado;
- Requirement;
- política específica.

Ejemplo:

comprador puede subir su documentación.

No necesariamente puede validar documentación del vendedor.

---

# 23. OperationParticipant

Añadir/eliminar participantes no debe ser una operación libre.

Solo mediante:

- creación controlada de Operation;
- acción autorizada;
- workflow administrativo auditado.

No permitir que un usuario se añada a sí mismo arbitrariamente a una Operation existente.

---

# 24. Requirement

Lectura:

- participante al que afecta;
- otros participantes cuando la información sea necesaria y esté permitida;
- profesional autorizado;
- admin.

Completar:

- mediante cumplimiento real;
- provider;
- backend;
- actor autorizado según tipo.

No permitir “marcar como completado” si la condición real no está satisfecha.

---

# 25. Document

`canAccessDocument(actor, document, purpose)` evalúa owner, visibilidad, relación de Operation, DocumentAccessGrant, membership, capability, estado y propósito. Ser OperationParticipant no concede acceso universal; un DNI de Buyer no se comparte automáticamente con Seller.

Este recurso necesita autorización especialmente estricta.

## Principio

Acceso:

RELACIÓN
+
PROPÓSITO
+
AUTORIZACIÓN
+
TIPO DE DOCUMENTO
+
ESTADO
=
PERMITIDO

## Document ownership

Puede pertenecer a:

- User;
- Organization;
- Property;
- Operation.

## Visibilidad conceptual

- PRIVATE
- SHARED_AUTHORIZED
- OPERATIONAL

### PRIVATE

Solo owner y procesos internos autorizados.

### SHARED_AUTHORIZED

Acceso explícitamente autorizado para un propósito.

### OPERATIONAL

Accesible a participantes concretos necesarios para completar la Operation.

No significa “todos los participantes”.

## Acceso

Cada descarga debe:

- verificar permiso;
- generar acceso temporal;
- no exponer storageKey directamente;
- auditar cuando sea sensible.

## Validación

Solo:

- proceso/provider autorizado;
- profesional interno autorizado;
- admin con capability correspondiente.

El uploader no puede autovalidar su documento.

---

# 26. Verification

## Crear/iniciar

Usuario puede iniciar sus verificaciones permitidas.

Property/Organization verification requiere relación válida.

## Resultado

Solo:

- IdentityProvider;
- proceso de BenHouse;
- admin autorizado.

Frontend no establece VERIFIED.

## Ver

Información pública solo en forma de proyección aprobada:

- “Identidad verificada”
- “Inmueble verificado”

No exponer metadata KYC.

---

# 27. TrustEvidence

La mayor parte de TrustEvidence es interna.

Públicamente se expone una proyección segura.

No exponer:

- incidentes sensibles;
- señales antifraude;
- pesos;
- lógica interna;
- datos personales.

Admin puede acceder según permiso.

El subject puede ver determinadas evidencias propias cuando sea apropiado.

---

# 28. Contract

Puede acceder:

- participantes requeridos;
- profesional autorizado;
- admin con permiso.

No cualquier participante de Operation tiene necesariamente derecho a todas las versiones si existen restricciones.

Generar Contract:

- backend/workflow autorizado;
- requisitos previos satisfechos.

No aceptar Contract arbitrario subido por cualquier usuario como contrato oficial sin workflow aprobado.

---

# 29. Signature

Solo signer correspondiente puede iniciar/completar su sesión de firma.

Un participante no puede firmar por otro.

Estado final lo determina:

- SignatureProvider confirmado;
- backend.

Admin no puede marcar SIGNED arbitrariamente.

---

# 30. Payment

## Crear/iniciar

Solo payer autorizado o backend dentro del workflow.

`payerId` se obtiene/valida por relación.

Importe viene de backend.

## Leer

- payer;
- participantes con derecho económico correspondiente;
- profesional autorizado;
- admin con permiso.

No exponer datos sensibles del método de pago.

## Confirmar

Solo:

- webhook verificado;
- PaymentProvider;
- proceso backend autorizado.

Nunca frontend.

---

# 31. Commission

No es recurso público.

Accesible:

- sistema;
- usuarios/profesionales autorizados cuando deban ver el desglose correspondiente;
- admin financiero autorizado.

El cliente no puede definir:

- rate;
- amount;
- status.

---

# 32. Task

Solo:

- user asignado;
- profesionales autorizados cuando sea tarea de organización;
- admin autorizado.

Completar manualmente solo cuando el tipo de Task lo permita.

Si depende de un Requirement, el backend decide la resolución.

---

# 33. Notification

Solo pertenece a su usuario destinatario.

Un usuario no puede leer notificaciones de otro.

Mark as read:

- solo destinatario.

No utilizar Notification como canal para filtrar datos sensibles no autorizados.

---

# 34. Activity

Activity se proyecta específicamente para el usuario.

Debe filtrar eventos según permisos actuales y reglas de exposición.

No asumir que porque un DomainEvent existe puede mostrarse íntegro al usuario.

Payload debe ser seguro.

---

# 35. Lead

Pertenece a Organization.

Puede acceder:

- miembro autorizado;
- assigned professional;
- OrganizationAdmin;
- admin plataforma cuando corresponda.

No compartir Leads entre organizaciones.

User asociado no implica que todos sus datos sean visibles.

---

# 36. CRMNote

Acceso:

- organización propietaria;
- miembros autorizados.

No visible al cliente salvo funcionalidad futura explícita.

---

# 37. Issue

Puede ser visible según tipo a:

- reporter;
- participantes afectados;
- profesional autorizado;
- admin.

Detalles internos/moderación pueden tener visibilidad restringida.

Severity no implica exposición pública.

---

# 38. Analytics privado

Owner/Professional puede ver únicamente analytics de recursos que gestiona legítimamente.

Ejemplo:

owner de Listing A puede ver:

- views de A;
- favorites agregados de A;
- contacts de A;
- visits de A;
- offers de A.

No puede ver:

- identidad de usuarios que solo visualizaron;
- favoritos individuales;
- búsquedas privadas;
- analytics de Listing B ajeno.

---

# 39. Admin

Admin no debe ser un bypass universal sin límites.

v0.4 puede comenzar con un modelo administrativo sencillo, pero debe distinguir conceptualmente capacidades como:

- USER_MODERATION
- LISTING_MODERATION
- VERIFICATION_REVIEW
- DOCUMENT_REVIEW
- OPERATION_SUPPORT
- PAYMENT_SUPPORT
- AUDIT_READ

Aunque inicialmente un mismo admin posea varias, el código debe evitar depender de:

`if admin => allow everything`

---

# 40. Principio de mínimo privilegio

Toda cuenta recibe el mínimo acceso necesario.

Aplicar a:

- usuarios;
- organizaciones;
- admin;
- providers;
- workers;
- base de datos;
- storage;
- CI/CD.

No otorgar permisos globales por comodidad.

---

# 41. Acciones administrativas críticas

Ejemplos:

- revocar Verification;
- resolver Issue;
- bloquear User;
- retirar Listing;
- revisar Document;
- intervenir en Operation.

Requieren:

- capability;
- motivo cuando corresponda;
- AuditEvent;
- estado permitido.

Admin no puede:

- firmar por partes;
- inventar pago confirmado;
- reescribir histórico económico;
- borrar auditoría;
- modificar Bid histórica.

---

# 42. Ownership y delegación

La relación se materializa mediante `PropertyAuthorization`; crear Property, Listing, media o participar en Operation no demuestra ownership. La revocación quita permisos futuros sin reescribir publisher histórico ni participantes legítimos de Operation.

Ownership y management son distintos.

Ejemplo:

Property pertenece a User A.

Organization B puede estar autorizada a comercializarla.

Esto no convierte automáticamente a Organization B en propietaria.

El modelo debe distinguir:

- owner;
- publisher;
- manager;
- organization;
- participant.

No inferir ownership a partir de quién creó el Listing.

---

# 43. Consentimiento y autorización documental

Cuando una acción implique compartir documentación o información sensible:

- debe existir propósito válido;
- permiso;
- consentimiento cuando corresponda;
- trazabilidad.

No implementar una UX de consentimiento jurídico avanzada si no es necesaria para sandbox.

Pero la arquitectura debe impedir acceso automático indiscriminado.

---

# 44. Revocación

Cuando se revoca:

- membership;
- delegación;
- autorización;
- sesión;
- verificación;

los permisos derivados deben dejar de aplicarse.

El histórico permanece.

Ejemplo:

un agente abandona Organization.

No debe seguir accediendo automáticamente a cartera actual.

El acceso histórico se mantiene solo cuando exista razón autorizada.

---

# 45. Sessions

Las sesiones deben poder:

- expirar;
- renovarse de forma segura;
- revocarse;
- cerrarse mediante logout.

Acciones sensibles pueden requerir sesión reciente/verificación adicional en el futuro.

No guardar tokens sensibles en localStorage si la estrategia oficial utiliza cookies HttpOnly.

---

# 46. Protección contra IDOR/BOLA

Todos los endpoints que reciben resource IDs deben revalidar autorización.

Casos obligatorios de test:

- leer Operation ajena;
- leer Contract ajeno;
- descargar Document ajeno;
- leer Conversation ajena;
- modificar Listing ajeno;
- aceptar Offer ajena;
- firmar Contract ajeno;
- consultar Payment ajeno;
- leer Lead de otra Organization.

Conocer un ID nunca concede acceso.

---

# 47. Mass assignment

DTOs deben permitir únicamente campos editables explícitos.

Nunca pasar directamente body completo a Prisma update/create en recursos sensibles.

Ejemplo prohibido:

`prisma.user.update({ data: body })`

si body puede contener:

- status;
- admin flags;
- verification;
- ownership;
- financial state.

Utilizar DTOs específicos por caso de uso.

---

# 48. API projections

Definir respuestas según contexto.

Ejemplo Listing público:

- title;
- price;
- location;
- media;
- features;
- public trust indicators.

No incluir automáticamente:

- owner internal id;
- documents;
- private analytics;
- internal notes;
- audit data.

La capa API controla exposición.

---

# 49. Permissions Service / Policy Layer

Las reglas complejas deben centralizarse mediante servicios/policies reutilizables.

Ejemplos conceptuales:

- canManageProperty()
- canPublishListing()
- canViewOperation()
- canAcceptOffer()
- canAccessDocument()
- canManageOrganization()
- canReviewVerification()

No dispersar la misma lógica de permisos en diez controllers.

Evitar también un único `PermissionService` gigantesco e inmantenible.

Organizar policies por dominio.

---

# 50. Backend y frontend

Frontend puede usar permisos para:

- ocultar;
- deshabilitar;
- orientar UX.

Pero siempre como conveniencia.

Backend es autoridad.

Ejemplo:

Botón “Aceptar oferta” puede ocultarse.

Aun así:

POST /offers/:id/accept

debe volver a comprobar permisos.

---

# 51. Webhooks

Endpoints de webhook no utilizan sesión de usuario.

Autorización mediante:

- firma criptográfica;
- secret/provider verification;
- timestamp/replay protection cuando el proveedor lo soporte;
- idempotencia.

Un header presente no equivale a webhook válido.

---

# 52. Worker

El worker actúa como service principal interno.

Debe tener acceso mínimo.

No necesita permisos administrativos generales.

Cada handler debe poder identificar:

- origen;
- evento;
- aggregate;
- operación.

Acciones críticas siguen reglas del dominio.

---

# 53. Test matrix obligatoria

Para cada recurso sensible probar:

## Positive

usuario autorizado puede realizar acción.

## Negative ownership

usuario autenticado pero ajeno recibe rechazo.

## Anonymous

usuario no autenticado recibe rechazo cuando corresponde.

## Wrong state

actor autorizado pero estado inválido recibe rechazo.

## Organization boundary

miembro de Organization A no accede a recursos privados de Organization B.

## Revoked membership

miembro revocado pierde acceso.

## Admin

admin sin capability adecuada recibe rechazo cuando aplique.

## Enumeration

IDs aleatorios no filtran existencia más allá de lo razonable.

---

# 54. Casos críticos de seguridad

Tests obligatorios:

1. Usuario A intenta editar Property de B.
2. Usuario A intenta crear Listing sobre Property de B.
3. Usuario A intenta consultar Operation de B.
4. Usuario A intenta descargar DNI de B.
5. Usuario A intenta aceptar Offer dirigida a B.
6. Bidder A intenta ver identidad de Bidder B.
7. Usuario modifica payerId en request.
8. Usuario modifica ownerId en request.
9. Usuario intenta firmar como otra persona.
10. Cliente envía amount de Payment manipulado.
11. Profesional de Agency A consulta Leads de Agency B.
12. Exmiembro de Agency intenta acceder tras revocación.
13. Usuario intenta autovalidar Document.
14. Frontend intenta marcar Verification VERIFIED.
15. Frontend intenta marcar Payment CONFIRMED.
16. Usuario intenta cambiar directamente Operation.status.
17. Admin sin permiso financiero intenta alterar Payment.
18. Webhook con firma inválida.
19. Webhook repetido.
20. Usuario intenta acceder por ID a Conversation ajena.

Todos deben fallar de forma segura.

---

# 55. Códigos de error

No filtrar información sensible mediante mensajes.

Diferenciar correctamente cuando sea seguro:

- 401 no autenticado;
- 403 autenticado sin permiso;
- 404 recurso inexistente/no exponible;
- 409 conflicto de estado;
- 422 validación de negocio cuando corresponda.

En recursos sensibles puede utilizarse 404 en lugar de revelar existencia si la política lo requiere.

Definir comportamiento consistente durante implementación.

---

# 56. Auditoría de accesos sensibles

Debe auditarse especialmente cuando corresponda:

- descarga de documentación sensible;
- revisión administrativa;
- modificación de verificación;
- intervención de operación;
- acciones financieras;
- cambios de ownership/delegación;
- administración de Organization.

No registrar contenido sensible innecesario.

---

# 57. Regla de diseño de permisos

Al implementar una nueva acción:

Codex debe responder internamente estas preguntas:

1. ¿quién puede ejecutarla?
2. ¿sobre qué recurso?
3. ¿por qué tiene relación?
4. ¿en qué estado?
5. ¿qué requisito adicional existe?
6. ¿qué información puede recibir?
7. ¿necesita auditoría?
8. ¿qué ocurre si pierde permiso entre lectura y escritura?

Si no existe respuesta clara:

no implementar autorización implícita.

---

# 58. Criterio de cierre

El modelo de permisos se considera válido cuando:

- ninguna acción crítica depende exclusivamente del frontend;
- no existe modelo rígido one-user-one-role;
- ownership se diferencia de management;
- organizaciones están aisladas;
- documentos tienen acceso específico;
- operaciones son privadas;
- pagos y firmas están protegidos;
- admins siguen mínimo privilegio;
- webhooks se autentican correctamente;
- DTOs previenen mass assignment;
- existe protección sistemática contra IDOR/BOLA;
- todas las rutas críticas tienen tests negativos.
