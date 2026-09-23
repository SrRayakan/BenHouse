# Orden de locks B1

Los conjuntos se bloquean siempre por UUID cuando una operación toma más de una fila del mismo tipo.

1. Identity: `User → PasswordCredential → Session → AccountToken`.
2. Organization: `Organization → OrganizationMember → OrganizationInvitation`.
3. Las operaciones mixtas B1.5 mantienen Identity antes de Organization. `AccountToken` de invitación precede a `OrganizationInvitation` aun cuando la relación física apunta a esta última: primero se localiza el ID, después se bloquea el token, y al final se relee la invitación bajo lock. Las filas de cada tipo se bloquean por UUID.

La creación B1.4 bloquea `User → Session` y revalida ambos antes de crear Organization y su primer OrganizationMember, que todavía no pueden estar bloqueados por otra transacción.

La edición bloquea y relee `User → Session → Organization → OrganizationMember`. Ningún dato mutable obtenido por la autenticación preliminar se usa como autorización final. Cada retry Serializable abre una transacción nueva y repite todos los locks y relecturas.

B1.5 usa `User → Session → AccountToken → Organization → OrganizationMember → OrganizationInvitation` cuando necesita los seis tipos. Accept usa `User → AccountToken → Organization → OrganizationMember → OrganizationInvitation`; reject usa `AccountToken → Organization → OrganizationMember → OrganizationInvitation`. Las lecturas preliminares localizan IDs y pueden evitar consumir el rate limit para actores sin permiso, pero no conceden autorización. El reloj PostgreSQL, las capabilities, la generación del token y los estados se comprueban de nuevo dentro de cada intento Serializable, después de los locks. Una invitación nueva crea filas que todavía no pueden ser bloqueadas por otra transacción.

## Relación histórica en endpoints B1.4

Una membership `REVOKED` o `LEFT` concede cero capabilities y cero acceso mediante los endpoints B1.4, aunque la Organization esté `SUSPENDED` o `ARCHIVED`. Solo una membership `ACTIVE` permite la proyección mínima de una organización no activa. El histórico podrá exponerse en el futuro mediante un endpoint administrativo o de auditoría diseñado expresamente.
