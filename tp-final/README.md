# TP Final — Canary del frontend de TerraSense

**Gestión de la Calidad del Software — FCEFyN, UNC**

Despliegue canary del frontend de TerraSense con NGINX Ingress en Minikube, prueba de estrés con
hipótesis, pipeline de CI como primera quality gate y mapa de las pruebas a ISO/IEC 25000 (SQuaRE).
Integra el TP3 (Kubernetes + HPA + k6) como **línea base**.

> Los campos marcados **_completar_** se llenan con los datos de la ejecución
> (`evidencias/reportes/`). El orden para correr todo está en [`GUIA_EJECUCION.md`](GUIA_EJECUCION.md).

## Contenido

0. [Contexto y arquitectura](#0-contexto-y-arquitectura)
1. [Despliegue en un Minikube limpio](#1-despliegue-en-un-minikube-limpio)
2. [Plan de rollout y bitácora](#2-plan-de-rollout-y-bitácora)
3. [Prueba de estrés: hipótesis y fundamentación](#3-prueba-de-estrés-hipótesis-y-fundamentación)
4. [Mapa ISO/IEC 25000](#4-mapa-isoiec-25000)
5. [Índice de evidencia](#5-índice-de-evidencia)
6. [Veredicto go / no-go](#6-veredicto-go--no-go)
7. [Aprendizaje: problemas y soluciones](#7-aprendizaje-problemas-y-soluciones)

---

## 0. Contexto y arquitectura

TerraSense recibe lecturas de una flota de sensores ESP32 (temperatura y humedad) y las muestra en
un panel web. Durante una madrugada de helada, un release del front dejó la **pantalla en blanco**
mientras el monitoreo reportaba el servicio como sano (HTTP 200). El objetivo del TP es un proceso
de release que detecte ese tipo de falla y limite su impacto.

```
                         terrasense.local                      api.terrasense.local
Navegador / k6 ───────────────┬──────────────────────────────────────────┬──────────────
                              ▼                                          ▼
              ┌──────────── NGINX Ingress Controller (addon de Minikube) ─────────────┐
              │ terrasense-ingress (afinidad cookie)      terrasense-ingress-api      │
              │ terrasense-ingress-canary (peso/cookie/header)   (sin afinidad)       │
              └──────────┬───────────────────┬─────────────────────┬──────────────────┘
                         ▼                   ▼                     ▼
               Service front-stable  Service front-canary     Service back
                ├ pod front 1.0.0     └ pod front 1.1.0        ├ pod back 1.0.0 ┐ HPA 2..8
                └ pod front 1.0.0                              └ pod back 1.0.0 ┘ (CPU 60%)
                                                                       ▼
                                                              StatefulSet db (PostgreSQL + PVC)
```

| Componente | Ubicación | Descripción |
|---|---|---|
| Back | `app/back/` | Node/Express + pg. Header `X-App-Version`, probes `/readyz` y `/healthz`, endpoints de laboratorio `/api/debug/*` |
| Front | `app/front/` | Un Dockerfile (nginx-unprivileged) para las 3 versiones: `v1.0.0/` stable, `v1.1.0/` canary, `v1.2.0/` rota a propósito |
| Base K8s | `k8s/base/` | Namespace, ConfigMap, PostgreSQL, back, HPA (la línea base del TP3) |
| Canary | `k8s/stable/`, `k8s/canary/`, `k8s/ingress.yaml` | Deployments y Services por track, Ingress principal, de API y canary |
| Pruebas | `k6/` | Línea base del back (TP3) y pruebas del canary y del estrés del front |
| Automatización | `scripts/` | `deploy.sh`, `peso.sh`, `conteo-curl.sh`, `rollout.sh` |
| CI | `../.github/workflows/tp-final-ci.yml`, `ci/` | Linters + Horusec → build |

**Marcas de versión del front.** Cada versión se identifica en tres lugares, porque cada uno responde
a una pregunta distinta:

| Marca | Pregunta | Quién la usa |
|---|---|---|
| Header `X-App-Version` (en toda respuesta, incluso 404) | ¿Qué versión respondió **este request**? | k6 HTTP: detectar assets de otra versión |
| `<meta name="app-version">` | ¿Qué versión **renderizó** el navegador? | k6 browser |
| `/version.txt` | ¿Qué versión tiene este pod? | Probes, `conteo-curl.sh`, `rollout.sh` |

---

## 1. Despliegue en un Minikube limpio

**Requisitos (Ubuntu):** Docker, Minikube, kubectl, k6 (≥ 1.0, incluye el módulo browser), Chromium,
python3 y curl. Instalación detallada en [`GUIA_EJECUCION.md`](GUIA_EJECUCION.md#0-preparación-de-ubuntu).

```bash
cd tp-final
./scripts/deploy.sh
```

`deploy.sh` ejecuta, en orden:

1. `minikube start --driver=docker` y los addons `ingress` (ingress-nginx) y `metrics-server` (métricas de CPU para el HPA).
2. `eval $(minikube docker-env)` y build de las 4 imágenes **dentro** de Minikube, con tags explícitos:
   `terrasense-back:1.0.0` y `terrasense-front:1.0.0`, `1.1.0`, `1.2.0`. Los Deployments usan
   `imagePullPolicy: IfNotPresent`, así que no hace falta un registry.
3. Espera a que el Ingress controller esté listo.
4. Aplica la base: namespace → ConfigMap → **Secret de la DB generado en el momento**, con contraseña
   aleatoria, fuera del repo y sin regenerarlo si ya existe → PostgreSQL → back + HPA → front stable +
   canary (peso 0).
5. Aplica los Ingress con reintentos (el webhook de validación de ingress-nginx tarda unos segundos más que el pod).
6. Agrega `terrasense.local` y `api.terrasense.local` a `/etc/hosts` con la IP de Minikube.

Verificación:
```bash
kubectl -n terrasense get pods,svc,ingress,hpa -L track,version
curl -s http://terrasense.local/version.txt          # 1.0.0 (peso 0)
curl -s -H 'X-Canary: always' http://terrasense.local/version.txt   # 1.1.0
curl -s http://api.terrasense.local/api/stats
```

**Endurecimiento.** Back y front corren con `runAsNonRoot`, UID/GID > 10000,
`allowPrivilegeEscalation: false` y `capabilities: drop ALL`. El front monta `emptyDir` en
`/var/cache/nginx` y `/tmp`. PostgreSQL bloquea la escalada de privilegios, y el arranque como root
queda como riesgo aceptado (ver [`ci/HALLAZGOS-HORUSEC.md`](ci/HALLAZGOS-HORUSEC.md)).

### CI: primera quality gate

`.github/workflows/tp-final-ci.yml` corre en cada push o PR que toque `tp-final/**`:

```
lint (htmlhint, ESLint, hadolint) ─┐
                                   ├─► build: 4 imágenes + arranque con UID no root
horusec (SAST, -s LOW, -e true) ───┘   (solo si las dos gates pasan)
```

| Run | Commit | Resultado | Motivo |
|---|---|---|---|
| #43995990963 | `e00a083` | ❌ horusec, build skipped | 22 hallazgos: contenedores sin `securityContext` (Trivy) y `Math.random()` |
| #44003617085 | `6e0af9f` | ❌ horusec, build skipped | 1 hallazgo nuevo en un comentario (limitación del SAST por patrones) |
| #44008882096 | `7dd88a8` | ✅ todo verde | 14 corregidos, 5 falsos positivos y 3 riesgos aceptados, registrados por hash |

Reutiliza las herramientas de TP1 (linters como gate) y TP2 (Horusec compilado desde el fuente). Las
copias originales de esos workflows están en [`ci/`](ci/README.md).

---

## 2. Plan de rollout y bitácora

### 2.1 Plan (definido antes de ejecutar)

Automatizado en `scripts/rollout.sh`. Cada etapa con peso corre en paralelo `k6/front-canary-split.js`
(tráfico HTTP sin cookie ni header, 20 visitas/s × 5 min) y `k6/browser-canary.js` (20 visitas con
Chromium, cada una en un contexto nuevo).

| Etapa | Peso | Duración | Criterio para avanzar (todos) | Si falla |
|---|---|---|---|---|
| 0 | 0% + cookie `canary=always` | 3 visitas con navegador (~1 min) | 0 pantallas en blanco; 3/3 visitas renderizan la versión canary | Se corta. Ningún usuario real expuesto (peso 0) |
| 1 | 10% | 5 min | Thresholds del split: `http_req_failed` < 1%, `err_canary` < 1%, `lat_canary` p95 < 300 ms, `assets_rotos` < 1%. **Y** 0 pantallas en blanco. **Y** p95 de página canary ≤ p95 stable + 10% (o diferencia < 5 ms) | **Rollback**: peso 0, se mide el tiempo hasta que ningún request llega al canary, se registra y se corta |
| 2 | 25% | 5 min | Ídem | Ídem |
| 3 | 50% | 5 min | Ídem | Ídem |
| 4 | 100% | 5 min | Ídem. El p95 stable de referencia es el de la etapa 3 (con peso 100 no hay visitas a la stable) | Ídem |
| Promoción | — | `rollout status` | La stable responde la versión nueva con `X-Canary: never` | `kubectl rollout undo deployment/front-stable` |

**Peso 100 no es promoción.** Con peso 100 la stable sigue declarada en 1.0.0, todo el tráfico cae en
un único pod canary, y quitar el Ingress canary devolvería la versión vieja. La promoción
(`SOLO_PROMOVER=1` o `PROMOVER=1`) sigue este orden:
1. `front-stable` pasa a la imagen nueva (sed en el YAML + apply + `rollout status`);
2. peso 0;
3. `front-canary` a 0 réplicas.

Invertir el orden devolvería el tráfico a la versión vieja durante unos segundos.

**Tolerancia de 5 ms.** En Minikube los tiempos de página son de pocos milisegundos: un 10% de 4 ms
es ruido. Además, la v1.1.0 pide 2 assets externos que la v1.0.0 no pide, así que su tiempo de página
incluye un request más.

### 2.2 Bitácora

Generada por `rollout.sh` en `evidencias/reportes/bitacora.csv`. Cambios de peso con hora en
`evidencias/reportes/cambios-de-peso.log`.

Ejecución del 18/11/2026 (Ubuntu, Minikube con driver Docker). Horas en ART (UTC−3).

| Inicio | Fin | Etapa | Versión | Peso | % observado | Visitas | p95 canary (ms) | p95 stable (ms) | Err. canary | Assets rotos | Pant. blancas | Decisión | Motivo |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 15:24:48 | 15:25:04 | etapa-0 | 1.1.0 | 0 | — | 3 | — | — | — | — | 0 | AVANZA | 3/3 visitas forzadas OK |
| 15:25:04 | 15:30:10 | peso-10 | 1.1.0 | 10 | 9,42 | 6001 | 2,54 | 1,39 | 0 % | 0 | 0 | AVANZA | criterios cumplidos |
| 15:30:10 | 15:35:16 | peso-25 | 1.1.0 | 25 | 25,58 | 6001 | 2,45 | 1,39 | 0 % | 0 | 0 | AVANZA | criterios cumplidos |
| 15:35:17 | 15:40:23 | peso-50 | 1.1.0 | 50 | 50,82 | 6001 | 2,49 | 1,41 | 0 % | 0 | 0 | AVANZA | criterios cumplidos |
| 15:40:23 | 15:45:29 | peso-100 | 1.1.0 | 100 | 100 | 6000 | 2,47 | 1,41 | 0 % | 0 | 0 | AVANZA | criterios cumplidos |
| 17:53:47 | 17:54:03 | etapa-0 | 1.2.0 | 0 | — | 3 | — | — | — | — | 3 | ROLLBACK (esperado) | 3 de 3 visitas con pantalla en blanco; ningún usuario real expuesto |
| 18:20:44 | 18:22:52 | peso-25 | 1.2.0 | 25 | 25,5 | 2400 | 2,54 | 1,46 | 0 % | 0 | 6 | ROLLBACK (esperado) | 6 pantallas en blanco con thresholds HTTP OK; tiempo de rollback: **1,9 s** |
| 18:45:40 | 18:45:53 | promocion | 1.1.0 | 0 | — | — | — | — | — | — | — | PROMOCION | stable → 1.1.0 (2/2 pods), canary a 0 réplicas, `version.txt` = 1.1.0 |

En las etapas de la 1.1.0 el p95 de página del canary supera en más de un 10 % al de la stable
(≈ +80 %), pero la diferencia absoluta es de ≈ 1,1 ms, por debajo de la tolerancia de 5 ms: por eso
avanza. La diferencia es el request extra de los assets externos (ver 3.5).

> En `bitacora.csv` el tiempo de la demo B figura como `1;9 s`: con locale `es_AR`, `awk` imprimió
> `1,9` y la coma se reemplazó para no romper el CSV. Se corrigió en `rollout.sh` (`LC_ALL=C`).

**Verificación independiente del reparto** (`conteo-curl.sh`, 100 requests por etapa):

| Peso | curl → 1.0.0 | curl → 1.1.0 | Logs Ingress → front-canary | k6 % observado |
|---|---|---|---|---|
| 10 | 90 | 10 | 34 (de 193 líneas) | 9,42 % |
| 25 | 70 | 30 | 93 (de 236) | 25,58 % |
| 50 | 53 | 47 | 176 (de 266) | 50,82 % |
| 100 | 0 | 100 | 313 (de 313, stable 0) | 100 % |

- curl (100 requests sin cookies) cae dentro del error de muestreo esperable con n = 100
  (±6 puntos aprox. para p = 25 %).
- Los logs del Ingress cuentan **todos** los requests al front en ese período, incluido el tráfico
  de k6 que corre en paralelo y los assets: una página de la 1.1.0 son 3 requests (HTML + CSS + JS) y
  una de la 1.0.0 es 1. Por eso el % del lado servidor no coincide con el peso; sirve para confirmar
  que el upstream canary efectivamente recibe tráfico (y que con peso 100 la stable recibe 0).
- **Corrección durante la ejecución:** en una línea atendida por el canary, el log de ingress-nginx
  trae los dos upstreams (`[front-stable-8080] [front-canary-8080]`), así que el `grep` original
  contaba esas líneas también como stable. El total "de N líneas" de las primeras 3 filas es
  stable + canary. Se corrigió `conteo-curl.sh`; la fila de peso 100 ya usa el conteo corregido.

---

## 3. Prueba de estrés: hipótesis y fundamentación

### 3.1 Hipótesis (escrita antes de ejecutar)

> **H:** la v1.1.0 no empeora el p95 de carga de página más de un 10% respecto de la v1.0.0, y
> ambas sostienen **200 cargas de página por segundo** con **menos de 1% de errores**.

- **Carga de página**: GET del HTML + todos los `/assets/` que referencia, pedidos en la misma
  iteración (`k6/front-common.js`). Tiempo = HTML + asset más lento.
- **Error de carga**: HTML distinto de 200 o algún asset roto (404, o de una versión distinta a la del HTML).
- H se **rechaza** si, en la meseta de 200 cargas/s, p95(v1.1.0) > 1,10 × p95(v1.0.0), o si alguna
  versión supera el 1% de errores.

### 3.2 Por qué estresar el front en A/B

- El canary compara las versiones con **poco tráfico**: sirve para detectar errores, no para saber
  si la versión nueva **aguanta la carga**. Un cambio de front (más assets, más bytes) puede degradar la
  capacidad sin generar errores con tráfico bajo.
- **A/B**: la misma carga contra cada versión **por separado** (`TARGET=stable` y `TARGET=canary`) y
  se comparan los resultados. Con el peso del canary, cada versión recibiría una fracción distinta de
  la carga y no serían comparables.
- El back no participa (el front es estático), así que se mide solo el cambio que se va a liberar.

### 3.3 Condiciones comparables

| Condición | Cómo se garantiza |
|---|---|
| Misma cantidad de pods | `kubectl -n terrasense scale deploy front-canary --replicas=2` (la stable tiene 2) |
| Mismos recursos y probes | Deployments idénticos (50m/64Mi – 250m/128Mi) |
| Sin usuarios reales en el canary | `./scripts/peso.sh 0` |
| Cada corrida mide una sola versión | Header `X-Canary: never` (stable) / `always` (canary); threshold `version_inesperada == 0` |
| Visitantes nuevos | Cookies borradas en cada iteración: la afinidad no concentra la carga en un pod |
| Misma carga | `ramping-arrival-rate` (modelo abierto) con mesetas 50/100/200/400/800 cargas/s (1 min las dos primeras, 2 min el resto, 10 s de subida) |
| Mismo entorno | Corridas consecutivas en la misma máquina, sin otras cargas; se registran las iteraciones descartadas (`dropped_iterations`) |

### 3.4 Resultados

Fuente: `evidencias/reportes/estres-front-stable.json` y `estres-front-canary.json`.

| Escalón (cargas/s) | p95 v1.0.0 (ms) | p95 v1.1.0 (ms) | Δ % | Errores v1.0.0 | Errores v1.1.0 |
|---|---|---|---|---|---|
| 50 | 1,29 | 2,12 | +64 % | 0 % | 0 % |
| 100 | 1,13 | 1,77 | +57 % | 0 % | 0 % |
| **200** | **0,91** | **1,54** | **+70 %** | **0 %** | **0 %** |
| 400 | 0,68 | 1,34 | +96 % | 0 % | 0 % |
| 800 | 0,64 | 1,48 | +131 % | 0 % | 0 % |

| Dato | v1.0.0 | v1.1.0 |
|---|---|---|
| Bytes por página (promedio) | 2713 | 4668 (+72 %) |
| Iteraciones descartadas | 0 | 0 |
| Thresholds (escalón 200) | OK | OK |

### 3.5 Conclusión

- **H se rechaza en su parte relativa y se cumple en la de capacidad.** En la meseta de 200 cargas/s,
  p95(v1.1.0) = 1,54 ms > 1,10 × 0,91 ms = 1,00 ms (+70 %). Las dos versiones sostienen 200 cargas/s
  (y hasta 800) con 0 % de errores.
- **No hay punto de quiebre** en ninguna de las dos versiones hasta 800 cargas/s: 0 errores en todos
  los escalones y el p95 se mantiene por debajo de 2,2 ms. El p95 de la stable incluso baja al subir
  la carga (conexiones reutilizadas y nginx en régimen).
- **La diferencia es constante en valor absoluto** (+0,6 a +0,8 ms en todos los escalones), no crece
  con la carga: se explica por el diseño de la v1.1.0 (2 requests extra por página para CSS y JS, y
  +72 % de bytes), no por una degradación bajo estrés. Con tiempos base menores a 1 ms, un umbral
  solo relativo (+10 %) es más estricto que el ruido de medición; la lección es fijar H con una
  tolerancia absoluta, como la de 5 ms que ya usa el plan de rollout.
- **El límite no lo puso el generador:** 0 iteraciones descartadas en las dos corridas, así que k6
  entregó la carga pedida en cada escalón.

---

## 4. Mapa ISO/IEC 25000

### 4.1 Etapa → característica de calidad (ISO/IEC 25010:2023)

| Etapa / prueba | Característica → subcaracterística | Métrica / evidencia | Qué no cubre |
|---|---|---|---|
| **Linters** (htmlhint, ESLint, hadolint) | Mantenibilidad → analizabilidad, modificabilidad. Seguridad → resistencia (`no-eval`, Dockerfile sin root) | Hallazgos por job = 0 (run #44008882096) | Diseño y arquitectura; comportamiento en ejecución; ESLint no analiza el JS del front |
| **Horusec + Trivy** (SAST + configuración K8s) | Seguridad → confidencialidad (credenciales fuera del código y del repo), integridad, resistencia (no root, sin escalada) | 22 hallazgos → 0 bloqueantes; `ci/HALLAZGOS-HORUSEC.md`, reportes del CI | Vulnerabilidades en ejecución (DAST); dependencias de terceros (sin `package-lock.json`, NpmAudit no corre); falsos positivos por patrones |
| **K8s + probes** | Fiabilidad → disponibilidad, tolerancia a fallos. Flexibilidad → instalabilidad (`deploy.sh` reproducible en un Minikube limpio) | Pods `Ready`; reinicios por liveness; tiempo de despliegue | Fallas de nodo, red o almacenamiento; un solo nodo |
| **HPA** | Eficiencia de desempeño → utilización de recursos, capacidad. Flexibilidad → escalabilidad | Réplicas en el tiempo vs carga (`kubectl get hpa -w`), CPU por pod | Escala solo por CPU; PostgreSQL no escala; tope de 8 réplicas por el nodo |
| **k6 carga / estrés** (línea base TP3 + estrés A/B del front) | Eficiencia de desempeño → comportamiento temporal (p95), capacidad (punto de quiebre) | p95 y tasa de errores por escalón; req/s sostenidos | Entorno local (Minikube y generador en la misma máquina) distinto de producción; red real |
| **Pruebas de fallas** (E1 pod eliminado, E2 spike CPU/OOM) | Fiabilidad → tolerancia a fallos, recuperabilidad, disponibilidad | Ventana de errores en E1; tiempo hasta `Ready` tras OOMKilled; capturas del navegador | Caída de la DB, del Ingress controller o del nodo; fallas parciales de red |
| **Canary** (split + navegador + rollback) | Fiabilidad → ausencia de fallos (*faultlessness*) y recuperabilidad (tiempo de rollback). Adecuación funcional → corrección (pantalla en blanco = función no entregada). Compatibilidad → coexistencia (dos versiones en paralelo, assets sin mezclar) | % observado vs peso; p95 y errores por versión; pantallas en blanco; tiempo de rollback; `bitacora.csv` | Usabilidad y accesibilidad; regresiones funcionales que no dejan la pantalla en blanco; usuarios reales (se simulan) |

### 4.2 Ubicación en las divisiones SQuaRE

| División | Norma | Dónde aparece en el TP |
|---|---|---|
| 2501n — Modelo de calidad | 25010 (producto), 25019 (calidad en uso) | El mapa 4.1: qué característica evidencia cada prueba |
| **2503n — Requisitos de calidad** | 25030 | Los **SLOs y umbrales**, fijados antes de medir: p95 < 300 ms, errores < 1%, 0 pantallas en blanco, ≤ +10% de p95, 200 cargas/s, 333 req/s para 10.000 sensores. En el código son los `thresholds` de k6 |
| **2502n — Medición** | 25023 (producto), 25022 (calidad en uso) | Las **medidas**: p95, tasas de error, % observado, bytes por página, réplicas, tiempo de rollback. Las producen k6, kubectl y los scripts, con salida en `evidencias/reportes/` |
| **2504n — Evaluación** | 25040 (proceso de evaluación) | **Comparar medidas contra requisitos y decidir**: `rollout.sh` (avanza / rollback), la hipótesis de estrés, el veredicto go/no-go |
| | **25045** (módulo de evaluación de recuperabilidad) | Las pruebas de **inyección de fallas** y la recuperación medida: E1 (pod eliminado), E2 (OOMKilled → reinicio), rollback del canary con v1.2.0 |

### 4.3 ISO/IEC 25010 vs ISO/IEC 25019

- **25010** (calidad del **producto**): propiedades del sistema medidas sobre el propio sistema,
  independientes de quién lo use. Ejemplos: p95 de un endpoint, réplicas del HPA, hallazgos de SAST.
- **25019** (calidad **en uso**): el efecto del sistema sobre **usuarios concretos en un contexto de
  uso**. Características: beneficio, ausencia de riesgo y aceptabilidad.
- En el TP, la calidad en uso aparece en dos lugares:
  1. **k6/browser** mide lo que **ve** un usuario: la v1.2.0 tiene una calidad de producto "aceptable"
     para las probes y k6 HTTP (todo 200), pero su calidad en uso es nula (pantalla en blanco). Es la
     diferencia entre las dos normas mostrada con un caso concreto.
  2. **El canary ante usuarios reales**: exponer el 10% del tráfico es evaluar la calidad en uso con
     usuarios reales en su contexto, acotando el riesgo (ausencia de riesgo) a ese porcentaje.
- Límite: los usuarios del TP son **simulados**. La calidad en uso real requeriría métricas de usuarios
  reales (RUM: errores de JS y tiempos de carga reportados por el navegador) o encuestas de satisfacción.

### 4.4 Características sin cubrir y propuestas

| Característica (25010:2023) | Situación | Propuesta |
|---|---|---|
| **Capacidad de interacción** → accesibilidad / inclusividad, operabilidad | No se mide. La v1.1.0 tiene un contraste extremo (verde #39ff14) que podría fallar criterios de accesibilidad | **Lighthouse CI** y **axe-core** en el pipeline sobre las 3 versiones, con umbral (ej. score de accesibilidad ≥ 90) como gate, y como criterio adicional del canary |
| **Compatibilidad** → interoperabilidad | El contrato front ↔ API (`/api/sensores`, `/api/stats`) no se verifica: un cambio en el JSON del back rompería el front sin que nada lo detecte | **Contract testing** (Pact) o validación de esquema JSON de las respuestas en el CI |
| **Seguridad** en ejecución → resistencia, autenticidad | El SAST no ve vulnerabilidades en ejecución, y los endpoints `/api/debug/*` son accesibles sin autenticación | **DAST** con OWASP ZAP (baseline scan) contra `terrasense.local` / `api.terrasense.local` en un entorno efímero; deshabilitar `/api/debug/*` fuera del laboratorio |
| **Seguridad** → dependencias (resistencia) | Sin `package-lock.json`, NpmAudit no corre | Versionar el lockfile, `npm ci` en el Dockerfile y SCA (npm audit o Trivy fs) en el job horusec |
| **Fiabilidad** → recuperabilidad de datos | No se prueba la pérdida del PVC ni el backup/restore de PostgreSQL | Backup periódico (pg_dump o operador) y prueba de restauración con tiempo medido (25045) |

---

## 5. Índice de evidencia

| Archivo | Qué demuestra |
|---|---|
| `evidencias/reportes/tp3-smoke.txt`, `tp3-load.txt` | El back cumple los SLOs a carga nominal (67 req/s) |
| `evidencias/reportes/tp3-stress.txt` + `capturas/02-stresss-pilar.png` | Punto de quiebre del back y reacción del HPA |
| `evidencias/reportes/tp3-e1.txt` + `capturas/03-e1.png` + `capturas/e1-ux-*.png` | Ventana de errores y recuperación al eliminar un pod; lo que ve el usuario |
| `evidencias/reportes/tp3-spike-cpu.txt`, `tp3-spike-oom.txt` + `capturas/04-spike-cpu-pilar.png`, `04-e2-oom-*.png` | Recuperación ante pico de CPU y OOMKilled |
| `evidencias/capturas/01-deploy-*.png` | Despliegue completo: stable y canary conviviendo |
| `evidencias/capturas/etapa-0-visita-*.png`, `evidencias/reportes/etapa-0-browser.json` | El canary se valida con peso 0, sin exponer usuarios |
| `evidencias/reportes/peso-*-split.json`, `peso-*-browser.json`, `capturas/peso-*-visita-*.png` | Reparto observado, latencia, errores y UI en cada etapa |
| `evidencias/reportes/conteo-*.txt` | Verificación independiente del reparto (curl + logs del Ingress) |
| `evidencias/reportes/cambios-de-peso.log` | Hora exacta de cada cambio de peso |
| `evidencias/reportes/bitacora.csv` | Decisión y motivo de cada etapa, tiempo de rollback |
| `evidencias/capturas/03-etapa0-cookie.png`, `05-conteo-peso-*.png`, `05-rollout-fin.png`, `05-bitacora.png` | Etapa 0 con cookie y rollout completo avanzando por criterios |
| `evidencias/capturas/06-demoA-etapa0-falla.png`, `06-demoB-peso25-falla.png`, `06-rollback-1.2.0.png`, `06-network-200.png` + `capturas/*-v1.2.0-BLANCA.png` + `capturas/06-consola-typeerror.png` | La v1.2.0 (HTTP 200, pantalla en blanco) se detecta y se revierte |
| `evidencias/reportes/estres-front-stable.json`, `estres-front-canary.json` | Contraste de la hipótesis de estrés |
| `evidencias/capturas/07-ci-rojo.png`, `07-ci-rojo-2.png`, `07-ci-verde.png` (tomadas por Jeremías) + reportes de Horusec | La quality gate de CI bloquea y después habilita el build |
| `evidencias/capturas/07-promocion.png`, `07-ci-lista.png` | Promoción de la 1.1.0 (stable 2/2 en 1.1.0, canary a 0) y lista de runs de CI |
| `ci/HALLAZGOS-HORUSEC.md` | Análisis y decisión de cada hallazgo de SAST |

---

## 6. Veredicto go / no-go

### 6.1 Release de la v1.1.0

| Criterio | Umbral | Resultado |
|---|---|---|
| CI (lint + horusec + build) | verde | ✅ run #44008882096 |
| Etapa 0 (navegador, peso 0) | 0 pantallas en blanco, 3/3 en canary | ✅ 3/3 en canary, 0 en blanco |
| Etapas 10 / 25 / 50 / 100 | Thresholds del split OK, 0 pantallas en blanco, p95 ≤ stable + 10% (o < 5 ms) | ✅ las 4 AVANZA; 0 errores, 0 assets rotos, 0 en blanco; p95 +≈1,1 ms (< 5 ms) |
| % observado vs peso | ± 3 puntos | ✅ 9,42 / 25,58 / 50,82 / 100 (máx. desvío 0,82 puntos) |
| Hipótesis de estrés | No rechazada en el escalón 200 | ⚠️ rechazada en lo relativo (+70 %, +0,63 ms); capacidad y errores OK (ver 3.5) |
| Control negativo: v1.2.0 detenida | Rollback automático | ✅ etapa 0 la frena; con tráfico real (peso 25) rollback automático (tiempo: 1,9 s) |

**Veredicto v1.1.0: GO con observación.** Se cumplen todos los criterios salvo la parte relativa de
la hipótesis de estrés (+70 % de p95 a 200 cargas/s). Se acepta el desvío porque es de 0,63 ms en valor
absoluto, constante en todos los escalones (no crece con la carga), explicado por el diseño de la
v1.1.0 (2 requests más y +72 % de bytes por página) y sin errores hasta 800 cargas/s. Observación para
el próximo ciclo: formular la hipótesis con una tolerancia absoluta, como los 5 ms del plan de rollout.

### 6.2 Capacidad para 10.000 sensores

10.000 sensores × 1 reporte / 30 s ≈ **333 req/s** de escritura sobre el back.

| Criterio | Umbral | Dato (stress del back, escalones 200 y 400 req/s) |
|---|---|---|
| p95 `POST /api/sensores` | < 300 ms a ≥ 333 req/s | ✅ 53 ms en toda la corrida (rampa hasta 1200 req/s, media 477 req/s) |
| Tasa de errores | < 1% a ≥ 333 req/s | ✅ 0,05 % (157 de 286.499) en toda la corrida |
| Réplicas del HPA a esa carga | < 8 (margen para picos) | ⚠️ no medido por escalón: el HPA escaló 2 → 4 → 6 → 7 → 8 durante la rampa y llegó al máximo (8) en los escalones altos (800–1200 req/s) |
| Recuperación ante pico (E2) | Vuelve a SLO sin intervención manual | ✅ tras el spike de CPU y el OOMKilled el back volvió solo a 2/2 Running (reinicio por kubelet + HPA) |

Notas de la ejecución: el spike de CPU de E2 se bajó de 1500 a 600 req/s porque a 1500 el generador
saturó la máquina (miles de warnings de k6 y la terminal colgada); los warnings se mandan a archivo
con `--log-output`.

**Veredicto 10.000 sensores: GO en este entorno.** El back sostuvo la rampa hasta 1200 req/s
(3,6 × los 333 req/s necesarios) con p95 de 53 ms y 0,05 % de errores, y se recuperó solo del pico de
CPU y del OOMKilled. Salvedades: el HPA llegó a su máximo (8 réplicas) en los escalones altos, así que el
margen para picos mayores depende de los recursos del nodo; y no se midió la cantidad de réplicas
exactamente a 333 req/s (próximo paso: un escalón fijo de 333 req/s registrando `kubectl get hpa -w`).
El resultado vale para este entorno (Minikube); en producción hay que repetir la prueba allí.

---

## 7. Aprendizaje: problemas y soluciones

| Problema | Causa | Solución |
|---|---|---|
| **Assets mezclados** (HTML 1.1.0 + CSS pedido a un pod 1.0.0 → 404) | El Ingress sortea cada request por separado | Afinidad por cookie en el Ingress principal **y** en el canary (el canary ignora las demás anotaciones, pero no las de afinidad); `/assets/` sin fallback a `index.html` para que el error sea visible; métrica `assets_rotos` |
| **Peso 100 ≠ promoción** | El peso solo redirige tráfico; la stable sigue declarando la versión vieja | Promoción explícita: imagen nueva en la stable → peso 0 → canary a 0 réplicas, en ese orden |
| **El peso no sabe cuántos pods hay** | El peso reparte entre Services, no entre pods: con peso 50, 1 pod canary recibe lo mismo que 2 pods stable | Para el estrés A/B, canary escalado a 2 réplicas; en el rollout, se tiene en cuenta al leer la latencia |
| **Selector inmutable** | `spec.selector` de un Deployment no se puede cambiar | Selector solo con `app` + `track`; `version` como label informativo |
| **200 OK ≠ página funcionando** | Probes y k6 HTTP no ejecutan JavaScript | k6/browser con detección de `body.innerText` vacío y tolerancia cero |
| **k6 reutiliza cookies por VU** | Con afinidad, un VU quedaba pegado a la primera versión y el % observado no reflejaba el peso | Borrar el cookie jar al inicio de cada iteración (visitante nuevo); la cookie sí se mantiene entre HTML y assets |
| **La afinidad le gana a `canary=always`** | La primera visita deja la cookie de afinidad `terrasense-front` atada a la stable, y el Ingress la respeta antes que la cookie de canary | Para la etapa 0 manual, borrar `terrasense-front` (DevTools → Application → Cookies) antes de recargar; k6 no lo sufre porque arranca cada iteración sin cookies |
| **Conteo del lado servidor duplicado** | En los logs de ingress-nginx, una línea atendida por el canary trae los dos upstreams (`[stable] [canary]`) | `conteo-curl.sh` cuenta por posición del upstream, no por nombre suelto |
| **Decimales con coma en la bitácora** | Con locale `es_AR`, `awk printf "%.1f"` imprime `1,9` y rompe el CSV | `LC_ALL=C` en el cálculo del tiempo de rollback |
| **El generador colgaba la máquina** | Spike de E2 a 1500 req/s: k6 saturaba la CPU local y la terminal con warnings | Pico bajado a 600 req/s y warnings a archivo (`--log-output=file=...`) |
| **Contraseña en el repo** | Default en `server.js` y Secret versionado | Sin default (fail fast); Secret generado por `deploy.sh`, que no se regenera porque PostgreSQL fija la contraseña al inicializar el volumen |
| **SAST: contenedores sin restricciones** | Las imágenes no corren como root, pero los manifiestos no lo exigían | `securityContext` en los manifiestos; `emptyDir` para nginx; prueba de arranque con UID no root en el CI |
| **SAST por patrones marca comentarios** | La regla de Horusec es una regex sobre el texto | Reescribir el comentario; revisión humana de cada hallazgo; falsos positivos y riesgos aceptados registrados por hash |
| **Sin análisis de dependencias** | Falta `package-lock.json` | Documentado como limitación, con propuesta (sección 4.4) |
| **ingress-nginx retirado (marzo de 2026)** | El proyecto dejó de recibir mantenimiento | Se usa porque es el addon de Minikube de la consigna. La migración natural es **Gateway API**: `HTTPRoute` con `backendRefs` ponderados (peso) y `matches` por header/cookie |
| _completar tras la ejecución_ | | |
