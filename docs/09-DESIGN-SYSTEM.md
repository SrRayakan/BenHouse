# BenHouse v0.4 — Sistema de Diseño

## Objetivo

Definir el lenguaje visual oficial de BenHouse v0.4 para asegurar coherencia entre:

- Home;
- Search;
- Map;
- Property;
- Intelligence;
- Mi BenHouse;
- Operation;
- CRM profesional;
- Admin;
- estados de sistema.

Este documento debe impedir:

- estilos distintos por módulo;
- exceso de colores;
- interfaces genéricas tipo SaaS;
- exceso de tarjetas;
- jerarquía visual confusa;
- abuso de badges;
- dashboards demasiado densos;
- inconsistencias entre desktop y móvil.

BenHouse debe sentirse:

- inmobiliario;
- premium;
- tecnológico;
- humano;
- moderno;
- claro;
- confiable.

---

# 1. Principio visual maestro

La vivienda debe ser la protagonista.

La interfaz existe para:

- organizar;
- explicar;
- guiar;
- facilitar decisiones.

No debe competir visualmente con las propiedades.

La tecnología debe sentirse avanzada sin parecer un panel técnico.

---

# 2. Filosofía de marca visual

BenHouse combina:

### Inmobiliario
Fotografía, espacio, ubicación, arquitectura y vivienda.

### Premium
Jerarquía clara, espacio blanco, tipografía cuidada, imágenes de calidad y pocas decisiones visuales fuertes.

### Tecnológico
Interacción rápida, mapas, Intelligence, datos claros y estados precisos.

### Humano
Lenguaje comprensible, confianza, acompañamiento y ausencia de tecnicismos innecesarios.

---

# 3. Paleta principal

## Fondo

Color dominante:

WHITE
`#FFFFFF`

BenHouse utiliza fondo predominantemente blanco.

No utilizar fondos oscuros como identidad principal de v0.4.

---

## Verde BenHouse

Color funcional principal:

`#10B981`

Usos recomendados:

- acciones positivas;
- CTA principal cuando corresponda;
- estados completados;
- elementos de confianza;
- highlights importantes;
- elementos de marca.

No utilizar verde en todos los componentes.

---

## Azul BenHouse

Color funcional secundario:

`#2563EB`

Usos:

- navegación;
- links;
- información;
- mapas;
- Intelligence;
- acciones secundarias;
- elementos de interacción.

---

## Amarillo BenHouse

Acento:

`#F59E0B`

Uso limitado.

Puede utilizarse para:

- atención;
- señal relevante;
- oportunidad;
- aviso no crítico;
- detalle visual.

No utilizar amarillo como fondo dominante.

No combinar constantemente verde + azul + amarillo en el mismo componente.

---

# 4. Neutros

Necesitamos una escala neutral coherente.

Valores orientativos:

- Neutral 950: `#0F172A`
- Neutral 900: `#111827`
- Neutral 700: `#374151`
- Neutral 600: `#4B5563`
- Neutral 500: `#6B7280`
- Neutral 400: `#9CA3AF`
- Neutral 300: `#D1D5DB`
- Neutral 200: `#E5E7EB`
- Neutral 100: `#F3F4F6`
- Neutral 50: `#F8FAFC`
- White: `#FFFFFF`

La implementación puede ajustar ligeramente los valores si se mantiene coherencia visual.

No introducir nuevas gamas arbitrarias por página.

---

# 5. Colores semánticos

Definir tokens semánticos.

## Success

Basado en verde.

Ejemplos:

- validado;
- completado;
- confirmado.

## Information

Basado en azul.

Ejemplos:

- información contextual;
- Intelligence;
- elementos de navegación.

## Warning

Basado en amarillo/ámbar.

Ejemplos:

- pendiente;
- requiere atención;
- vencimiento próximo.

## Error

Utilizar rojo funcional únicamente para:

- error;
- rechazo;
- cancelación crítica;
- acción destructiva.

Rojo no es color corporativo.

Debe utilizarse solo semánticamente.

---

# 6. Jerarquía cromática

Orden de importancia visual:

1. blanco;
2. fotografía;
3. texto oscuro;
4. verde o azul funcional;
5. amarillo excepcional;
6. colores de estado cuando sean necesarios.

No diseñar interfaces multicolor.

---

# 7. Tipografía

Tipografía principal:

**Inter**

Alternativa compatible si fuera necesario:

sans-serif moderna equivalente.

Inter debe utilizarse inicialmente para mantener consistencia.

---

# 8. Escala tipográfica

La implementación debe utilizar tokens.

Valores orientativos:

## Display

48–64 px desktop.

Uso:

- Home hero;
- mensajes de alto impacto.

No abusar.

## H1

36–44 px.

## H2

28–34 px.

## H3

22–26 px.

## H4

18–20 px.

## Body Large

18 px.

## Body

16 px.

## Body Small

14 px.

## Caption

12–13 px.

Responsive debe ajustar tamaños cuando sea necesario.

---

# 9. Pesos tipográficos

Preferencia:

- Regular 400
- Medium 500
- Semibold 600
- Bold 700 solo cuando sea necesario

Evitar interfaces donde todo sea bold.

La jerarquía debe construirse mediante:

- tamaño;
- peso;
- espacio;
- color.

---

# 10. Texto

Color principal:

Neutral 900/950.

Texto secundario:

Neutral 600/700.

Metadata:

Neutral 500.

Texto deshabilitado:

Neutral 400.

Evitar gris demasiado claro que reduzca accesibilidad.

---

# 11. Espaciado

Utilizar escala consistente basada aproximadamente en múltiplos de 4.

Ejemplo:

- 4
- 8
- 12
- 16
- 20
- 24
- 32
- 40
- 48
- 64
- 80

No utilizar valores aleatorios constantemente.

---

# 12. Layout

Contenido principal debe tener ancho máximo coherente.

Ejemplo desktop:

aproximadamente 1200–1440 px según vista.

Search + Map puede utilizar más anchura.

Páginas editoriales/lectura deben ser más estrechas.

---

# 13. Grid

Utilizar grid responsive.

Desktop:

12 columnas cuando aporte valor.

Tablet:

8 columnas aproximadas.

Mobile:

4 columnas conceptuales o layout fluido.

No forzar grid complejo si flex/grid simple resuelve mejor.

---

# 14. Border radius

BenHouse utiliza esquinas suaves.

Escala orientativa:

- small: 8 px;
- medium: 12 px;
- large: 16 px;
- extra large: 20–24 px.

Cards principales:

aproximadamente 12–16 px.

No convertir toda la interfaz en cápsulas.

---

# 15. Sombras

Sombras suaves y discretas.

Uso:

- cards flotantes;
- dropdowns;
- modals;
- overlays;
- paneles sobre mapa.

Evitar sombras oscuras o exageradas.

Preferir:

- borde sutil;
- sombra ligera;
- espacio.

---

# 16. Bordes

Bordes:

Neutral 200/300.

Uso:

- inputs;
- cards;
- separadores;
- tablas.

No utilizar bordes gruesos salvo estado excepcional.

---

# 17. Buttons

Tipos principales:

## Primary

Acción principal.

Fondo:

verde BenHouse por defecto.

Texto:

blanco.

Ejemplos:

- Buscar viviendas
- Solicitar visita
- Hacer oferta
- Continuar
- Publicar

## Secondary

Acciones secundarias.

Puede utilizar:

- fondo blanco;
- borde;
- azul/verde según contexto.

## Tertiary / Ghost

Acciones de baja prioridad.

Sin fondo fuerte.

## Destructive

Rojo semántico.

Solo:

- eliminar;
- cancelar;
- retirar cuando sea destructivo.

---

# 18. Reglas de botones

Una pantalla debe tener una jerarquía clara.

Evitar cinco botones primarios simultáneos.

CTA principal debe identificarse inmediatamente.

Desktop y mobile deben mantener prioridad.

Estados:

- default;
- hover;
- focus;
- active;
- disabled;
- loading.

---

# 19. Iconografía

Estilo:

- minimalista;
- lineal;
- limpio;
- esquinas suaves;
- peso consistente.

Evitar:

- iconos 3D;
- ilustraciones infantiles;
- iconos de estilos mezclados.

Utilizar una librería consistente si es compatible con el stack.

No introducir varias librerías de iconos sin necesidad.

---

# 20. Fotografía inmobiliaria

Las fotografías son el elemento visual más importante.

Requisitos:

- alta calidad;
- proporciones consistentes;
- carga optimizada;
- cropping correcto;
- placeholders elegantes;
- sin distorsión.

No utilizar imágenes aleatorias de baja calidad para demo premium.

---

# 21. Property Card

Composición recomendada:

FOTOGRAFÍA

precio

ubicación

datos principales

señal contextual opcional

favorite

Datos principales:

- habitaciones;
- baños;
- superficie.

No convertir Property Card en ficha completa.

---

# 22. Property Card — Intelligence

Máximo una señal destacada inicialmente.

Ejemplos:

- Alta demanda
- Precio competitivo
- Oportunidad

Si no existe insight relevante:

no mostrar badge vacío.

No mostrar:

- score de precio;
- score de demanda;
- score de rentabilidad;
- score de confianza;

todos simultáneamente.

---

# 23. Cards generales

Antes de crear una Card:

preguntar si realmente necesita contenedor visual.

No envolver cada texto en una tarjeta.

Usar cards principalmente para:

- propiedades;
- módulos de acción;
- bloques destacables;
- datos agrupados;
- paneles funcionales.

---

# 24. Badges

Uso limitado.

Categorías:

- estado;
- verificación;
- insight importante.

No crear badge para cada atributo.

Ejemplo correcto:

✓ Verificado

Ejemplo excesivo:

Premium
IA
Top
Seguro
Recomendado
Alta demanda
Mejor precio

simultáneamente.

---

# 25. Status indicators

Combinar:

- icono;
- texto;
- color.

Ejemplo:

✓ Validado

● En revisión

! Requiere acción

× Rechazado

No depender únicamente del color.

---

# 26. Inputs

Inputs deben ser:

- claros;
- grandes suficiente;
- labels persistentes;
- errores visibles;
- focus claro.

No utilizar placeholder como sustituto único de label.

Altura orientativa:

44–48 px mínimo para controles principales.

---

# 27. Search bar

Uno de los componentes de marca más importantes.

Debe sentirse:

- premium;
- claro;
- rápido.

Desktop puede agrupar:

- operación;
- ubicación;
- CTA.

Mobile simplifica.

No llenar Home con un buscador excesivamente técnico.

---

# 28. Filters

Filtros frecuentes visibles.

Filtros secundarios:

panel “Más filtros”.

Chips pueden representar filtros activos.

Debe ser fácil:

- aplicar;
- modificar;
- eliminar;
- resetear.

---

# 29. Map markers

Markers deben ser claros y legibles.

Preferencia:

- precio;
- estado seleccionado;
- clustering.

Estados:

- default;
- hover;
- selected.

No utilizar demasiados colores.

---

# 30. Map panels

Paneles sobre mapa:

- blancos;
- sombra ligera;
- border radius;
- jerarquía clara.

No cubrir mapa innecesariamente.

---

# 31. Intelligence visual

Intelligence debe utilizar:

- texto;
- barras discretas;
- comparaciones;
- indicadores;
- gráficos simples cuando aporten valor.

No parecer Bloomberg inmobiliario.

---

# 32. Gráficos

Reglas:

- pocos;
- comprensibles;
- una pregunta por gráfico;
- labels claros;
- unidades;
- periodo.

Evitar:

- charts decorativos;
- 3D;
- exceso de colores;
- dashboards de 12 gráficos.

---

# 33. Demand indicator

Puede representarse mediante:

- Baja
- Media
- Alta

y una representación visual sutil.

No depender de:

“83/100”

como información primaria.

---

# 34. Confidence

Cuando Intelligence use confidence:

mostrar de forma comprensible.

Ejemplo:

Confianza media

con opción:

“Cómo se calcula”.

No dar falsa precisión.

---

# 35. Navigation desktop

Header limpio.

Puede incluir:

- logo;
- Buscar;
- Intelligence;
- Publicar;
- Actividad;
- Mensajes;
- Mi BenHouse/perfil.

Evitar menú con demasiados elementos.

---

# 36. Navigation mobile

Navegación prioritaria.

Puede incluir:

- Inicio;
- Buscar;
- Actividad;
- Mi BenHouse.

Otros accesos mediante menú/contexto.

Mantener máximo razonable de elementos visibles.

---

# 37. Logo

El logo BenHouse debe disponer de espacio suficiente.

No modificar proporciones.

La construcción puede utilizar placeholder textual/logotipo existente hasta disponer del asset definitivo.

No inventar un nuevo logotipo durante Codex sin instrucción explícita.

---

# 38. Mi BenHouse

Debe sentirse como parte del mismo producto público.

No cambiar a estética SaaS completamente distinta.

Puede aumentar densidad ligeramente.

Mantener:

- tipografía;
- colores;
- radios;
- iconografía;
- jerarquía.

---

# 39. Professional UI

Puede tener:

- sidebar;
- tablas;
- KPIs;
- filtros.

Pero debe seguir sintiéndose BenHouse.

Evitar dashboards genéricos de plantilla admin.

Cada KPI debe ser útil.

---

# 40. Admin UI

Prioridad:

claridad funcional.

Puede ser visualmente más sobrio.

No dedicar excesivo esfuerzo premium.

Aun así:

- consistente;
- legible;
- accesible;
- seguro.

---

# 41. Operation UI

Componente principal:

Progress Stepper.

Debe mostrar:

- pasos;
- estado;
- siguiente acción.

Utilizar blanco dominante.

Completado:

verde.

Actual:

azul/énfasis.

Pendiente:

neutral.

Warning:

amarillo.

Error:

rojo.

---

# 42. Stepper

Estados:

- completed;
- current;
- pending;
- requires-action;
- failed cuando corresponda.

No utilizar elementos animados excesivos.

En móvil:

versión vertical/compacta.

---

# 43. Document cards

Mostrar:

- icono tipo documento;
- nombre;
- descripción;
- estado;
- CTA.

Ejemplo:

Documento de identidad

Necesario para verificar tu identidad.

En revisión

No mostrar storage information.

---

# 44. Payment UI

Debe transmitir seguridad.

Elementos:

- concepto;
- importe;
- desglose;
- método;
- estado.

No añadir estética bancaria compleja.

No wallet visible.

---

# 45. Contract UI

Visual:

- título;
- versión;
- participantes;
- estado;
- CTA Ver;
- CTA Firmar cuando corresponda.

No mostrar contenido contractual completo dentro de una card.

---

# 46. Trust UI

Indicadores:

✓ Identidad verificada
✓ Inmueble verificado
✓ Agencia verificada

CTA:

Ver por qué

Utilizar iconografía simple.

No crear medallas premium exageradas.

---

# 47. Modals

Usar para:

- acciones cortas;
- confirmaciones;
- filtros;
- pequeños formularios.

No usar modal para flujos complejos.

Ejemplo:

solicitar visita puede ser modal/drawer si funciona bien.

Publicar inmueble no.

---

# 48. Drawers

Especialmente útiles en móvil:

- filters;
- map preview;
- contextual actions.

Deben ser accesibles.

---

# 49. Toasts

Solo feedback breve.

Ejemplos:

“Guardado en favoritos.”

“Búsqueda guardada.”

No utilizar toast como única confirmación de acciones críticas.

Offer, Payment, Signature requieren estado persistente visible.

---

# 50. Tables

Uso:

- CRM;
- Admin;
- Professional portfolio.

Tablas deben:

- responder;
- paginar;
- permitir filtros;
- mantener legibilidad.

En móvil pueden transformarse en cards/listas.

---

# 51. Skeletons

Utilizar skeletons coherentes para:

- PropertyCard;
- PropertyDetail;
- Search Results;
- Activity;
- dashboards.

No usar spinners gigantes para toda página salvo necesidad.

---

# 52. Empty states

Visualmente:

- simples;
- iconografía ligera;
- título;
- explicación;
- CTA opcional.

No ilustraciones infantiles.

---

# 53. Error visual

Error debe usar rojo moderado.

Ejemplo:

“No hemos podido completar el pago.”

CTA:

“Volver a intentar”

No:

pantalla roja completa.

---

# 54. Destructive confirmation

Acciones destructivas deben pedir confirmación cuando tengan consecuencias relevantes.

Ejemplos:

- retirar anuncio;
- cancelar operación;
- eliminar miembro;
- borrar draft.

Explicar consecuencia.

---

# 55. Motion

Duraciones cortas y naturales.

Orientativamente:

150–250 ms.

No introducir librerías de animación complejas si CSS/transitions resuelven.

---

# 56. Hover

Solo donde existe puntero.

No depender de hover para funcionalidad esencial.

Mobile siempre debe poder acceder a la misma acción.

---

# 57. Focus

Focus visible y consistente.

No eliminar outline sin reemplazo accesible.

---

# 58. Breakpoints

Utilizar breakpoints coherentes con Tailwind/configuración elegida.

No introducir breakpoints distintos por módulo.

Ajustar layouts según contenido, no solo dispositivos concretos.

---

# 59. Image ratios

Property cards:

ratio consistente, aproximadamente 4:3 o 3:2 según decisión final.

Hero/gallery puede utilizar ratios más amplios.

No deformar imágenes.

---

# 60. Gallery

Property detail debe tener una galería premium.

Desktop:

composición visual potente.

Mobile:

carousel/swipe.

Debe soportar:

- contador;
- fullscreen/lightbox;
- navegación.

Sin introducir complejidad excesiva.

---

# 61. Avatar

Uso limitado.

Principalmente:

- users;
- professionals;
- conversations.

No convertir cada card en red social.

---

# 62. Dividers

Preferir:

- whitespace;
- border ligero.

No separar cada bloque con líneas oscuras.

---

# 63. Background sections

Fondo principal blanco.

Puede utilizarse Neutral 50 para separar secciones secundarias.

No alternar muchos fondos.

---

# 64. Hero Home

Debe ser inmobiliario.

Fotografía premium.

Título breve.

Buscador protagonista.

Ejemplo de orientación conceptual:

“Encuentra una vivienda. Entiende el mercado. Avanza con confianza.”

El copy final puede ajustarse durante implementación UX.

No utilizar claims exagerados sin evidencia.

---

# 65. CTA hierarchy Home

Primary:

Buscar viviendas

Secondary:

Publicar inmueble

Intelligence puede aparecer contextual, no competir con Search como CTA principal.

---

# 66. Copy de Intelligence

Correcto:

“Precio competitivo respecto a viviendas similares.”

“Demanda alta en esta zona.”

“12 propiedades comparables.”

Incorrecto:

“Nuestra IA revolucionaria predice que debes comprar esta vivienda.”

---

# 67. Copy de confianza

Correcto:

“Identidad verificada.”

“Inmueble verificado.”

“Ver por qué.”

Incorrecto:

“100% seguro.”

No prometer seguridad absoluta.

---

# 68. Copy transaccional

Debe ser precisa.

Ejemplo:

“Oferta enviada.”

“Tu oferta ha sido aceptada.”

“Pago confirmado.”

“Contrato pendiente de una firma.”

No utilizar lenguaje ambiguo.

---

# 69. Sistema de tokens

Crear tokens semánticos en la implementación.

Ejemplo conceptual:

color.background.default
color.background.subtle
color.text.primary
color.text.secondary
color.brand.green
color.brand.blue
color.brand.yellow
color.status.success
color.status.warning
color.status.error
color.border.default

spacing.*
radius.*
shadow.*
typography.*

Evitar hardcodear valores repetidos en componentes.

---

# 70. Tailwind

El sistema visual debe reflejarse en la configuración/tokens utilizados con Tailwind.

Evitar clases con colores arbitrarios como:

bg-[#17A673]

repetidas por toda la aplicación.

Usar tokens/variables.

---

# 71. CSS variables

Preferir una capa de CSS variables/tokens para colores semánticos importantes.

Esto facilita:

- consistencia;
- evolución;
- theming futuro.

v0.4 no requiere dark mode.

No introducirlo ahora salvo necesidad futura.

---

# 72. Componentes base

Candidatos iniciales:

- Button
- Input
- Select
- Checkbox
- Radio
- Textarea
- Badge
- Card
- Modal
- Drawer
- Tabs
- Tooltip
- Dropdown
- Avatar
- Skeleton
- EmptyState
- ErrorState
- Status
- Stepper
- PropertyCard
- Price
- TrustIndicator

No construir 100 componentes antes de necesitarlos.

Crear progresivamente.

---

# 73. Component composition

Preferir componentes composables.

No crear componentes monolíticos de miles de líneas.

Ejemplo:

PropertyCard
├── PropertyImage
├── PropertyPrice
├── PropertyMeta
└── FavoriteButton

Solo extraer cuando exista beneficio real.

---

# 74. Design System vs producto

El sistema de diseño sirve a BenHouse.

No construir una librería de componentes universal para terceros.

Prioridad:

entregar producto.

---

# 75. Consistencia de estados

Todos los componentes interactivos deben cubrir:

- default;
- hover;
- focus;
- active;
- disabled;
- loading;
- error cuando corresponda.

No implementar únicamente happy state visual.

---

# 76. Responsive components

PropertyCard, Search, Filters, Stepper, Navigation, Tables y Modals deben tener comportamiento responsive explícito.

No confiar en que “se adapten solos”.

---

# 77. Accessibility tokens

Contrastes deben cumplir buenas prácticas.

No utilizar amarillo claro sobre blanco para texto.

No utilizar verde claro con texto blanco si contraste insuficiente.

Verificar estados críticos.

---

# 78. Demo quality gate

Una pantalla no se considera lista para demo si contiene:

- Lorem Ipsum;
- imágenes rotas;
- placeholders técnicos;
- textos en inglés no justificados;
- “TODO” visible;
- botones sin función;
- datos absurdos;
- cards sin estados;
- errores de responsive.

---

# 79. Anti-template rule

Codex no debe utilizar una plantilla genérica SaaS/admin como resultado final sin adaptarla profundamente.

Señales prohibidas:

- sidebar negra genérica;
- dashboard lleno de cards KPI sin contexto;
- gráficos decorativos;
- fondos grises dominantes;
- estética fintech para búsqueda inmobiliaria;
- múltiples gradientes;
- exceso de glassmorphism.

BenHouse debe tener identidad propia.

---

# 80. Anti-AI aesthetic

No utilizar como identidad principal:

- gradientes morado/azul típicos de IA;
- estrellas mágicas constantes;
- iconos de robot;
- “AI” en todos los botones.

La inteligencia debe sentirse integrada y útil.

---

# 81. Property-first rule

En cualquier pantalla de descubrimiento:

la vivienda o información inmobiliaria debe tener mayor prioridad que la tecnología.

Ejemplo:

foto + precio + ubicación

antes que:

AI score + analytics + badges.

---

# 82. Mobile touch targets

Controles esenciales deben tener área táctil suficiente.

Objetivo aproximado:

44x44 px.

Especialmente:

- favorite;
- navigation;
- map controls;
- CTAs;
- close buttons.

---

# 83. Professional density

Professional UI puede ser más densa que consumer UI.

Pero mantener:

- whitespace;
- claridad;
- jerarquía.

No mostrar toda la base de datos en una sola pantalla.

---

# 84. Data formatting

Definir formato consistente:

### Precio

`295.000 €`

### Alquiler

`1.250 €/mes`

### Superficie

`120 m²`

### Fecha

formato español legible.

### Porcentaje

usar precisión razonable.

No mostrar:

`5.283749 %`

cuando:

`5,3 %`

es suficiente.

---

# 85. Localización visual

Idioma base:

español.

Separadores numéricos y formatos compatibles con España.

Arquitectura futura puede soportar otros locales.

v0.4 no requiere traducir toda UI a nueve idiomas.

---

# 86. Map + list visual hierarchy

Desktop split view:

lista y mapa deben compartir protagonismo según modo.

No hacer mapa tan pequeño que pierda utilidad.

Permitir cambiar énfasis cuando corresponda.

---

# 87. Intelligence colors

No crear heatmap multicolor arbitrario.

La escala debe:

- ser comprensible;
- accesible;
- usar pocas variaciones.

Mapa Intelligence puede usar una escala específica coherente con la métrica, manteniendo diseño BenHouse.

---

# 88. Opportunity visualization

“Oportunidad” debe expresarse con moderación.

Puede utilizar acento amarillo.

Nunca:

- flashing;
- fuego;
- urgency falsa;
- “COMPRA YA”.

BenHouse no debe utilizar dark patterns.

---

# 89. Urgency

Solo mostrar urgencia basada en hechos.

Correcto:

“La oferta vence mañana.”

“La puja finaliza en 2 h.”

Incorrecto:

“¡5 personas están mirando esto!” si no existe dato real y útil.

No fabricar presión.

---

# 90. Dark patterns prohibidos

No utilizar:

- contadores falsos;
- demanda inventada;
- scarcity falsa;
- botones engañosos;
- opt-out oculto;
- fees escondidas;
- preselecciones manipulativas.

Transparencia forma parte de la filosofía BenHouse.

---

# 91. Fees

Cuando exista coste BenHouse:

mostrar de forma clara en el momento adecuado.

No saturar toda la UX con porcentajes.

No ocultarlos justo antes de pagar.

---

# 92. Sandbox visual

En staging/demo, cuando una acción sea sandbox:

debe existir una indicación discreta pero clara.

Ejemplo:

“Entorno de demostración — no se realizará ningún cargo real.”

No hacer creer a usuario de demo que ejecutó una transacción real.

---

# 93. Admin vs demo

La demo principal no debe comenzar en Admin.

La experiencia comercial debe centrarse en:

- consumer;
- owner;
- professional.

Admin es soporte operativo.

---

# 94. Quality bar

Antes de aprobar una pantalla:

evaluar:

1. ¿parece inmobiliaria?
2. ¿parece BenHouse?
3. ¿se entiende en 5 segundos?
4. ¿el CTA principal es evidente?
5. ¿hay información innecesaria?
6. ¿la fotografía tiene protagonismo?
7. ¿funciona responsive?
8. ¿los estados están cubiertos?
9. ¿cumple accesibilidad básica?
10. ¿podría confundirse con una plantilla SaaS?

Si la respuesta 10 es sí:

revisar.

---

# 95. Criterio de cierre

El sistema de diseño se considera correctamente aplicado cuando:

- todas las pantallas usan tokens comunes;
- blanco domina;
- verde/azul tienen roles claros;
- amarillo se utiliza como acento;
- fotografía es protagonista;
- tipografía es consistente;
- no existen estilos arbitrarios por módulo;
- consumer y professional se sienten parte de BenHouse;
- Intelligence no parece producto aparte;
- Operation mantiene la misma identidad;
- responsive conserva la jerarquía;
- estados y accesibilidad están contemplados;
- la demo parece un producto inmobiliario real y no una plantilla técnica.
