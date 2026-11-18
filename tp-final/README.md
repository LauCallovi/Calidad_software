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
| 1 | 10% | 5 min | Thresholds del split: `http_req_failed` < 1%, `err_canary` < 1%, `lat_canary` p95 < 300 ms, `assets_rotos` < 1%. **Y** 0 pantallas en blanco. **Y** p95 del HTML canary ≤ p95 HTML stable + 10% (o diferencia < 5 ms) | **Rollback**: peso 0 y canary a 0 réplicas; se mide el tiempo hasta que ni un usuario nuevo ni uno pegado al canary reciben la versión canary, se registra y se corta |
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

**Tolerancia de 5 ms.** En Minikube los tiempos son de pocos milisegundos: un 10% de 4 ms es ruido.

**Corrección del criterio de latencia (después de la primera corrida).** El plan original comparaba el
p95 de *página* (HTML + assets). La v1.0.0 trae el CSS y el JS embebidos (1 request) y la v1.1.0 los
pide aparte (3 requests seguidos), así que esa comparación mide trabajos distintos. En la primera
corrida la etapa 10% hizo **rollback** por eso: página canary 10,42 ms contra 5,21 ms (diferencia
5,21 ms, apenas por encima de la tolerancia), aunque el HTML del canary era **más rápido**
(4,69 contra 5,21 ms), con 0 errores, 0 assets rotos y 0 pantallas en blanco. Se cambió el criterio
a p95 del HTML (misma carga en ambas versiones) y se repitió el rollout completo. La corrida 1 queda
como evidencia en `evidencias/reportes/rollout-corrida1-falso-positivo/` y
`evidencias/capturas/rollout-corrida1-falso-positivo/`. Lección: el propio gate es software y hay que
validarlo; ante la duda, falló hacia el lado seguro (rollback en 1,8 s).

El costo de los assets externos no se ignora: lo mide la hipótesis de estrés A/B (sección 3), que sí
compara carga de página completa a 200 cargas/s.

### 2.2 Bitácora

Generada por `rollout.sh` en `evidencias/reportes/bitacora.csv`. Cambios de peso con hora en
`evidencias/reportes/cambios-de-peso.log`.

| Inicio | Fin | Etapa | Versión | Peso | % observado | Visitas | p95 canary (ms) | p95 stable (ms) | Err. canary | Assets rotos | Pant. blancas | Decisión | Motivo |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 01:18:39 | 01:18:58 | etapa-0 *(corrida 1)* | 1.1.0 | 0 | — | 3 | — | — | — | — | 0 | AVANZA | 3/3 visitas forzadas OK |
| 01:18:59 | 01:24:07 | peso-10 *(corrida 1)* | 1.1.0 | 10 | 9,83 | 6001 | 10,42 *(página)* | 5,21 *(página)* | 0 | 0 | 0 | ROLLBACK | Falso positivo del criterio de página (ver 2.1); rollback en 1,8 s |
| 01:27:33 | 01:27:52 | etapa-0 | 1.1.0 | 0 | — | 3 | — | — | — | — | 0 | AVANZA | 3/3 visitas forzadas OK |
| 01:27:52 | 01:32:58 | peso-10 | 1.1.0 | 10 | 10,31 | 6001 | 5,09 | 4,23 | 0 | 0 | 0 | AVANZA | Criterios cumplidos (+0,86 ms, dentro de la tolerancia de 5 ms) |
| 01:32:59 | 01:38:05 | peso-25 | 1.1.0 | 25 | 24,86 | 6001 | 4,50 | 4,46 | 0 | 0 | 0 | AVANZA | Criterios cumplidos |
| 01:38:05 | 01:43:11 | peso-50 | 1.1.0 | 50 | 49,93 | 6001 | 5,67 | 5,58 | 0 | 0 | 0 | AVANZA | Criterios cumplidos |
| 01:43:12 | 01:48:18 | peso-100 | 1.1.0 | 100 | 100 | 6001 | 5,51 | 5,58 *(ref. etapa 50)* | 0 | 0 | 0 | AVANZA | Criterios cumplidos |
| 02:14:13 | 02:14:36 | etapa-0 *(demo A)* | 1.2.0 | 0 | — | 3 | — | — | — | — | 3 | ROLLBACK (esperado) | 3 de 3 visitas con pantalla en blanco; ningún usuario real expuesto |
| 02:26:49 | 02:29:01 | peso-25 *(demo B)* | 1.2.0 | 25 | 23,03 | 2401 | 4,16 | 3,83 | 0 | 0 | 3 | ROLLBACK (esperado) | 3 pantallas en blanco; tiempo de rollback: **6,1 s** (usuarios nuevos y pegados) |
| 02:30:57 | 02:31:13 | promocion | 1.1.0 | 0 | — | — | — | — | — | — | — | PROMOCION | Stable sirve 1.1.0; canary a 0 réplicas. Como demostración del procedimiento: el veredicto es NO-GO (sección 6.1) |

**Verificación independiente del reparto** (`conteo-curl.sh`, 100 requests por etapa):

| Peso | curl → 1.0.0 | curl → 1.1.0 | Logs Ingress: esos curl → front-canary | k6 % observado (visitas) | Navegador (20 visitas) → canary |
|---|---|---|---|---|---|
| 10 | 94 | 6 | 6 | 10,31 | 0 |
| 25 | 72 | 28 | 28 | 24,86 | 4 |
| 50 | 55 | 45 | 45 | 49,93 | 10 |
| 100 | 0 | 100 | 100 | 100 | 20 |

Los 100 curl son una muestra chica: el desvío respecto del peso (por ejemplo, 6 en vez de 10) está
dentro de lo esperable para n = 100 (con p = 0,10 el desvío estándar es ±3). El dato fuerte es el de
k6, con 6001 visitas por etapa: desvío máximo de 0,31 puntos.

El lado servidor se cuenta por la IP del pod que respondió. La primera versión de `conteo-curl.sh`
contaba por nombre de upstream, pero cada línea del log del Ingress trae los dos nombres (principal y
alternativo) sin importar adónde fue el request, y daba lo mismo para ambos. Se corrigió el script y
se recalcularon los valores desde los logs rotados del controller (detalle en
`evidencias/reportes/conteo-peso-*.txt`).

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
| 50 | 3,65 | 6,68 | +83% | 0% | 0% |
| 100 | 3,16 | 5,33 | +69% | 0% | 0% |
| **200** | **2,60** | **3,16** | **+22%** | **0%** | **0%** |
| 400 | 1,76 | 3,82 | +117% | 0% | 0% |
| 800 | 1,30 | 181,68 | +13.864% | 0% | 0% |

| Dato | v1.0.0 | v1.1.0 |
|---|---|---|
| Bytes por página (promedio) | 2713 | 4668 (+72%) |
| Requests por página | 1 | 3 (HTML + CSS + JS) |
| Iteraciones descartadas | 0 | 780 (todas en el escalón 800) |
| Thresholds (escalón 200) | OK | OK |

Corridas del 2026-11-18, 01:50–02:10, consecutivas en la misma máquina (Minikube con 2 CPU y 3 GB,
y k6 en el mismo host de 4 CPU y 3,8 GB).

### 3.5 Conclusión

**Se rechaza H.** En la meseta de 200 cargas/s, p95(v1.1.0) = 3,16 ms > 1,10 × 2,60 = 2,86 ms
(+22%). La segunda parte de H sí se cumple: las dos versiones sostienen 200 cargas/s con 0% de
errores. El criterio de rechazo se fijó antes de medir y no se modifica.

**Lectura del resultado:**
- **En términos absolutos, la diferencia a 200 cargas/s es de 0,56 ms.** Para un usuario es
  imperceptible. La hipótesis estaba escrita en términos relativos, y con tiempos de 2–3 ms un 10% es
  menos de un tercio de milisegundo, un margen que el propio ruido del entorno puede cubrir (ver la
  tolerancia de 5 ms del plan de rollout, sección 2.1). Una hipótesis mejor planteada combinaría el %
  con un mínimo absoluto. Queda como lección, no como excusa: con el criterio escrito, H se rechaza.
- **La diferencia se explica por los requests extra.** La v1.1.0 pide 3 requests por página
  (el tiempo de página es HTML + el asset más lento) y transfiere un 72% más de bytes. A igual
  cantidad de cargas/s, el front canary atiende el triple de requests: a 800 cargas/s son ~2400 req/s
  contra 800 de la stable.
- **Punto de quiebre.** La v1.0.0 no mostró quiebre hasta 800 cargas/s (p95 1,3 ms, 0 errores).
  La v1.1.0 se quiebra en el escalón 800: el p95 sube de 3,8 a 181,7 ms, sin errores pero con 780
  iteraciones descartadas.
- **¿Límite de la app o del generador?** No se puede separar del todo, porque k6 y Minikube
  comparten la máquina. Las iteraciones descartadas no se deben al tope de VUs (se usaron 242 de
  1500): k6 no llegó a lanzarlas a tiempo, lo que indica CPU del host saturada. El límite observado es
  el de **la máquina completa** a ~2400 req/s, y la v1.1.0 llega antes porque genera el triple de
  requests. Para atribuirlo a la app habría que usar un generador en otra máquina.
- **p95 que baja al subir la carga en la v1.0.0** (3,65 → 1,30 ms): es un efecto del entorno, no de
  la app. Con más carga, las conexiones se reutilizan más y la CPU sube de frecuencia. Por eso las
  comparaciones se hacen escalón por escalón entre versiones, nunca entre escalones.

**Implicancia para la liberación:** la v1.1.0 es funcionalmente correcta (rollout sin errores, sin
assets rotos ni pantallas en blanco), pero **cuesta más por visita**. No hay riesgo a la carga actual,
pero conviene embeber o concatenar los assets (volver a 1 request por página) antes de esperar picos
cercanos a 800 cargas/s.

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
| `evidencias/capturas/01-deploy-kubectl-navegador.png` | Despliegue completo: stable y canary conviviendo, la v1.0.0 en el navegador |
| `evidencias/reportes/tp3-smoke.txt`, `tp3-load.txt` + `capturas/02-smoke.png`, `02-load.png` | El back cumple los SLOs a carga nominal (67 req/s) |
| `evidencias/reportes/tp3-stress.txt` + `videos/02-stress-hpa.mkv` | Punto de quiebre del back (~600–650 req/s) y reacción del HPA (2 → 8) |
| `evidencias/reportes/tp3-e1.txt` + `videos/03-e1-pod-eliminado.mkv` + `capturas/e1-ux-*.png` | Ventana de errores y recuperación al eliminar un pod; lo que ve el usuario |
| `evidencias/reportes/tp3-spike-cpu.txt`, `tp3-spike-cpu-hpa.txt` | Pico de CPU: reinicios en cascada por liveness y reacción del HPA |
| `evidencias/reportes/tp3-spike-oom.txt`, `tp3-spike-oom-describe.txt` + `videos/04-e2-oom.mkv` + `capturas/04-oomkilled.png` | OOMKilled (exit 137), CrashLoopBackOff y recuperación |
| `evidencias/capturas/etapa-0-visita-*-v1.1.0.png`, `evidencias/reportes/etapa-0-browser.recuperado.log` | El canary se valida con peso 0, sin exponer usuarios |
| `evidencias/capturas/03-afinidad-gana-a-cookie-canary.png` | Hallazgo: con afinidad *sticky*, la cookie `canary=always` no alcanza (sección 7) |
| `evidencias/reportes/peso-*-split.json`, `peso-*-browser.json`, `peso-25.recuperado.log`, `capturas/peso-*-visita-*.png` | Reparto observado, latencia, errores y UI en cada etapa |
| `evidencias/reportes/conteo-peso-*.txt` | Verificación independiente del reparto (curl + logs del Ingress, con la corrección del conteo) |
| `evidencias/reportes/cambios-de-peso.log` | Hora exacta de cada cambio de peso |
| `evidencias/reportes/bitacora.csv`, `rollout.log` | Decisión y motivo de cada etapa, tiempo de rollback |
| `evidencias/reportes/rollout-corrida1-falso-positivo/`, `capturas/rollout-corrida1-falso-positivo/` | Primera corrida: rollback por el criterio de página (sección 2.1) |
| `evidencias/videos/05-rollout-1.1.0.mkv` | Rollout completo avanzando por criterios |
| `evidencias/reportes/demo-a-1.2.0/` + `capturas/demo-a-1.2.0/*-BLANCA.png` | La etapa 0 frena la v1.2.0 sin exponer usuarios |
| `evidencias/videos/06-rollback-1.2.0.mkv` + `reportes/demo-b-1.2.0/` + `capturas/demo-b-1.2.0/` | La v1.2.0 llega al 25%, se detecta y se revierte en 6,1 s |
| `evidencias/capturas/06-consola-typeerror.png`, `06-network-200.png` | La v1.2.0 responde 200 en todo y aun así la página queda en blanco |
| `evidencias/reportes/estres-front-stable.json`, `estres-front-canary.json` (+ `.txt`) | Contraste de la hipótesis de estrés |
| `evidencias/reportes/promocion.log` + `capturas/07-promocion.png` | Promoción de la v1.1.0 a la stable |
| `evidencias/reportes/capacidad-333-estable*.txt`, `capacidad-333-arranque-frio*.txt` | Capacidad para 10.000 sensores (sección 6.2) |
| `evidencias/capturas/07-ci-rojo.png`, `07-ci-verde.png` + reportes de Horusec | La quality gate de CI bloquea y después habilita el build (capturas aportadas por otro integrante del grupo) |
| `ci/HALLAZGOS-HORUSEC.md` | Análisis y decisión de cada hallazgo de SAST |

---

## 6. Veredicto go / no-go

### 6.1 Release de la v1.1.0

| Criterio | Umbral | Resultado |
|---|---|---|
| CI (lint + horusec + build) | verde | ✅ run #44008882096 |
| Etapa 0 (navegador, peso 0) | 0 pantallas en blanco, 3/3 en canary | ✅ 0 en blanco, 3/3 en canary |
| Etapas 10 / 25 / 50 / 100 | Thresholds del split OK, 0 pantallas en blanco, p95 HTML ≤ stable + 10% (o < 5 ms) | ✅ Las 4 etapas AVANZA (corrida 2; la corrida 1 hizo rollback por el criterio de página, ver 2.1) |
| % observado vs peso | ± 3 puntos | ✅ 10,31 / 24,86 / 49,93 / 100 (desvío máximo 0,31) |
| Hipótesis de estrés | No rechazada en el escalón 200 | ❌ Rechazada: p95 +22% (3,16 contra 2,60 ms, +0,56 ms absolutos); 0% de errores en ambas (ver 3.5) |
| Control negativo: v1.2.0 detenida | Rollback automático | ✅ Demo A: frenada en la etapa 0 (3/3 en blanco, peso 0). Demo B: rollback automático en el 25% (tiempo: **6,1 s**) |

**Lo que mostró el control negativo (demo B):**
- **Las métricas HTTP no lo detectan.** Con la v1.2.0 al 25%, el split dio thresholds OK: 0% de errores
  y 0 assets rotos sobre 2401 visitas, porque todo responde 200 (`capturas/06-network-200.png`). Solo
  el navegador real vio el `TypeError` y la pantalla vacía (`capturas/06-consola-typeerror.png`).
- **Costo de exposición:** 553 visitas (23,03%) recibieron la versión rota antes del rollback. La
  primera pantalla en blanco la vio el navegador a las 02:27:18, pero el script decide al **final** de
  la etapa (02:28:55), así que pasaron ~1,6 min entre la detección y el corte. **Mejora propuesta:**
  hacer rollback ante la primera pantalla en blanco, sin esperar el fin de la etapa (con tolerancia
  cero, esperar no agrega información).
- **El rollback incluye a los usuarios pegados al canary** (ver sección 7): en el video, el Chrome
  forzado a la v1.2.0 muestra la página normal al recargar después del rollback.

**Veredicto v1.1.0: NO-GO.** La regla, fijada antes de medir, es GO solo si se cumplen todos los
criterios, y la hipótesis de estrés se rechazó (+22% de p95 a 200 cargas/s). No se reinterpreta el
criterio después de ver el resultado, aunque la diferencia absoluta (0,56 ms) sea imperceptible para
un usuario.

Lo que sí quedó demostrado: la v1.1.0 es funcionalmente correcta (rollout completo sin errores, sin
assets rotos ni pantallas en blanco, con el reparto de tráfico respetando el peso), y su costo extra
viene de pedir CSS y JS en archivos aparte (3 requests por página contra 1).

**Acción antes de liberar:** volver a embeber o concatenar los assets de la v1.1.0, o justificar
formalmente un criterio de latencia con mínimo absoluto, y repetir el estrés A/B.

La promoción (sección 2.1, paso 6 de la guía) se ejecuta igual, **como demostración del procedimiento** (orden
seguro: stable → peso 0 → canary a 0). En producción, con este veredicto, no se promovería.

### 6.2 Capacidad para 10.000 sensores

10.000 sensores × 1 reporte / 30 s ≈ **333 req/s** de escritura sobre el back.

El stress del back solo daba un p95 global de toda la rampa, así que se agregó una prueba dedicada a
333 req/s (`k6 run -e RATE=333 [-e RAMP=2m] k6/load.js`), en dos variantes:

| Criterio | Umbral | Régimen estable (rampa de 2 min + 5 min a 333 req/s) | Arranque en frío (333 req/s de golpe, 5 min) |
|---|---|---|---|
| p95 `POST /api/sensores` | < 300 ms a ≥ 333 req/s | ❌ **1,15 s** | ❌ 16,95 s |
| Tasa de errores | < 1% a ≥ 333 req/s | ✅ **0,10%** (123 de 119.213) | ❌ 37,08% |
| Réplicas del HPA a esa carga | < 8 (margen para picos) | ❌ **8** (el máximo), CPU 93–101% del objetivo | ❌ 7, con pods sin pasar readiness |
| Recuperación ante pico (E2) | Vuelve a SLO sin intervención manual | ⚠️ Sí, pero con reinicios en cascada por liveness (CPU) y CrashLoopBackOff (OOM) | ⚠️ ~5 min sin pods listos; se recupera solo al final |

Fuentes: `evidencias/reportes/capacidad-333-estable.txt` y `capacidad-333-arranque-frio.txt`, cada
uno con su registro del HPA cada 5 s (`*-hpa.txt`). 2026-11-18, 02:31–02:49.

**Veredicto 10.000 sensores: NO cumple en este entorno.**

- **En régimen estable el throughput alcanza** (desde el minuto 3, ~20.000 requests por minuto con
  pocos VUs en vuelo, 0,10% de errores), **pero sin margen**: el HPA queda en 8 de 8 réplicas y el
  p95 de la corrida es de 1,15 s. La mayor parte de esa latencia se acumuló en la transición
  (minutos 1:40 a 2:40, CPU al 200% mientras el HPA escalaba de 2 a 7). El resumen de k6 no separa
  fases, así que el criterio se evalúa sobre la corrida completa y no se cumple.
- **El arranque en frío colapsa.** Con 333 req/s desde el segundo cero, 2 pods se saturan, fallan
  readiness y liveness, y los reinicios en cascada (igual que en el spike de CPU) dejan el servicio
  ~5 min con 0–3 pods listos. Un corte de red o un reinicio de la flota de sensores produciría
  exactamente esta situación.
- **Cuello de botella: CPU del nodo.** 8 réplicas × 250m de límite = 2 CPU, que es **todo** el nodo de
  Minikube, compartido además con PostgreSQL, el Ingress y el front. Subir `maxReplicas` no ayuda
  sin más CPU.

**Acciones propuestas:** más CPU o más nodos (y recién ahí subir `maxReplicas`); liveness más
tolerante o separada del event loop (la cascada aparece en el spike y en el arranque en frío);
*jitter* y *backoff* en los sensores para que no arranquen todos juntos; cola de ingesta con inserts
por lotes para desacoplar la escritura en PostgreSQL. Aclaración: el resultado vale para este entorno
(4 CPU y 3,8 GB de RAM para todo, con k6 en la misma máquina); en producción hay que repetir la prueba
allí.

---

## 7. Aprendizaje: problemas y soluciones

| Problema | Causa | Solución |
|---|---|---|
| **Assets mezclados** (HTML 1.1.0 + CSS pedido a un pod 1.0.0 → 404) | El Ingress sortea cada request por separado | Afinidad por cookie en el Ingress principal **y** en el canary (el canary ignora las demás anotaciones, pero no las de afinidad); `/assets/` sin fallback a `index.html` para que el error sea visible; métrica `assets_rotos` |
| **Peso 100 ≠ promoción** | El peso solo redirige tráfico; la stable sigue declarando la versión vieja | Promoción explícita: imagen nueva en la stable → peso 0 → canary a 0 réplicas, en ese orden |
| **El peso no sabe cuántos pods hay** | El peso reparte entre Services, no entre pods: con peso 50, 1 pod canary recibe lo mismo que 2 pods stable | Para el estrés A/B, canary escalado a 2 réplicas; en el rollout, se tiene en cuenta al leer la latencia |
| **Selector inmutable** | `spec.selector` de un Deployment no se puede cambiar | Selector solo con `app` + `track`; `version` como label informativo |
| **Peso 0 ≠ rollback completo** (hallado en la ejecución) | Con `affinity-canary-behavior: sticky`, un usuario con la cookie de afinidad del canary sigue en el canary aunque el peso sea 0, hasta que vence la cookie (1 h). La primera versión del rollback solo ponía peso 0 y medía con curl sin cookies, así que el tiempo informado era optimista | El rollback pone peso 0 **y** baja el canary a 0 réplicas: sin pods, el Ingress manda a los usuarios pegados a la stable (~1 s, sin errores). El tiempo se mide hasta que un usuario nuevo **y** uno pegado ven la stable |
| **La afinidad le gana a la cookie/header del canary** (hallado en la ejecución) | Un navegador que ya tiene la cookie de afinidad de la stable no va al canary aunque mande `canary=always` o `X-Canary: always` | Para forzar el canary a mano hay que borrar la cookie `terrasense-front`. Los scripts no tienen el problema: cada visita usa un contexto limpio |
| **Conteo del lado servidor duplicado** (hallado en la ejecución) | Cada línea del log del Ingress trae los dos nombres de upstream (principal y alternativo), sin importar adónde fue el request | `conteo-curl.sh` cuenta por la IP del pod que respondió |
| **Las demos pisaron reportes del rollout** (hallado en la ejecución) | `rollout.sh` nombra los reportes por etapa (`peso-25-split.json`) sin la versión, así que la demo B con la 1.2.0 sobrescribió los de la 1.1.0 | Bitácora intacta (se agrega, no se reescribe); logs reconstruidos desde `rollout.log` (`*.recuperado.log`); demos movidas a `demo-a-1.2.0/` y `demo-b-1.2.0/`. Mejora: incluir la versión en el nombre del reporte |
| **Criterio de latencia que comparaba trabajos distintos** (hallado en la ejecución) | p95 de página: la v1.0.0 hace 1 request y la v1.1.0, 3 | Criterio sobre el p95 del HTML; la corrida 1 quedó como evidencia del falso positivo (sección 2.1) |
| **200 OK ≠ página funcionando** | Probes y k6 HTTP no ejecutan JavaScript | k6/browser con detección de `body.innerText` vacío y tolerancia cero |
| **k6 reutiliza cookies por VU** | Con afinidad, un VU quedaba pegado a la primera versión y el % observado no reflejaba el peso | Borrar el cookie jar al inicio de cada iteración (visitante nuevo); la cookie sí se mantiene entre HTML y assets |
| **Contraseña en el repo** | Default en `server.js` y Secret versionado | Sin default (fail fast); Secret generado por `deploy.sh`, que no se regenera porque PostgreSQL fija la contraseña al inicializar el volumen |
| **SAST: contenedores sin restricciones** | Las imágenes no corren como root, pero los manifiestos no lo exigían | `securityContext` en los manifiestos; `emptyDir` para nginx; prueba de arranque con UID no root en el CI |
| **SAST por patrones marca comentarios** | La regla de Horusec es una regex sobre el texto | Reescribir el comentario; revisión humana de cada hallazgo; falsos positivos y riesgos aceptados registrados por hash |
| **Sin análisis de dependencias** | Falta `package-lock.json` | Documentado como limitación, con propuesta (sección 4.4) |
| **ingress-nginx retirado (marzo de 2026)** | El proyecto dejó de recibir mantenimiento | Se usa porque es el addon de Minikube de la consigna. La migración natural es **Gateway API**: `HTTPRoute` con `backendRefs` ponderados (peso) y `matches` por header/cookie |
| _completar tras la ejecución_ | | |
