## ¿Cómo funciona?

Este repositorio implementa un pipeline de calidad automatizado usando **GitHub Actions**, 
que actúa como *gate* obligatorio antes de poder mergear cualquier Pull Request a `main`.

### Qué dispara el Action
El workflow se ejecuta automáticamente ante los siguientes eventos:
- `pull_request` dirigido a la rama `main` (en cada push a la PR)
- [Opcional: `push` a otras ramas / `workflow_dispatch` manual]

### Arquitectura del workflow
1. **Checkout del código**: se clona el repositorio en el runner (`actions/checkout`).
2. **Setup del entorno**: se instala la versión de python necesaria (`actions/setup-[node/python/java]`).
3. **Instalación de dependencias**: se instalan el linter y sus configuraciones (`[ESLint/Ruff/Pylint/Checkstyle/PMD/SpotBugs]`).
4. **Ejecución del linter**: se corre el linter sobre el código fuente, usando la configuración 
   definida en `[.eslintrc / ruff.toml / pylintrc / checkstyle.xml / etc.]`.
5. **Resultado como gate**: si el linter detecta errores (exit code ≠ 0), el job falla y 
   GitHub marca el check como X. Esto bloquea el botón de merge de la PR.

### Qué valida
El linter analiza el código en busca de:
- Errores de estilo y formato (indentación, naming conventions, imports no usados, etc.)
- Problemas de calidad estructural (complejidad ciclomática, código duplicado, funciones muy largas)
- [Si aplica: posibles bugs / code smells detectados estáticamente, ej. SpotBugs/PMD/Pylint]

### Protección de rama
Se configuró la protección de la rama `main` para:
- Bloquear commits directos (`push` directo prohibido).
- Requerir que la PR tenga el check del workflow en verde antes de habilitar el merge.
- [Si aplica: requerir al menos 1 aprobación de revisión]

## Área de calidad (ISO 25000)

Este TP trabaja principalmente sobre la característica de **Mantenibilidad** 
del modelo de calidad de producto de software definido en la norma **ISO/IEC 25010** (parte del 
proyecto ISO 25000 - SQuaRE), específicamente en las siguientes subcaracterísticas:

- **Analizabilidad**: el linteo automático facilita detectar rápidamente 
  partes del código con problemas de estilo o estructura, sin necesidad de revisión manual línea 
  por línea.
- **Modificabilidad**: al forzar un estilo de código consistente y libre de 
  code smells, se reduce el riesgo de introducir efectos secundarios no deseados al modificar el código.
- **Facilidad de prueba**: código más simple y consistente (menor complejidad 
  ciclomática, funciones cortas) resulta más sencillo de testear.

[Si el/los linter/s usados detectan además posibles bugs — como SpotBugs, PMD o Pylint —
podés sumar también:]
- **Fiabilidad → Madurez**: estos linters no solo verifican estilo, sino que 
  también detectan patrones de código propensos a errores en tiempo de ejecución (ej. null 
  pointer dereferences, recursos no cerrados), contribuyendo a prevenir fallos.

El uso del linter como *quality gate* automatizado en el pipeline de CI garantiza que estos 
atributos de calidad se verifiquen de forma consistente y objetiva en cada cambio propuesto, 
en lugar de depender exclusivamente de revisión manual.