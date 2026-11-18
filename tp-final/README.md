# TerraSense S.A. - TP Final (Canary + k6 + ISO 25000)

Acá armamos la entrega del trabajo práctico final de Gestión de la Calidad del Software (FCEFyN, UNC). Agarramos la plataforma de monitoreo rural que ya corría en Minikube desde el TP3 y le pusimos arriba el pipeline de GitHub Actions (`lint` + `horusec`) junto con el rollout gradual en `ingress-nginx` validado con `k6` y Chromium.

## Índice

0. [Escenario y carpetas del repo](#0-escenario-y-carpetas-del-repo)
1. [Instrucciones de despliegue en Minikube limpio](#1-instrucciones-de-despliegue-en-minikube-limpio)
2. [Plan de rollout y bitácora de ejecución](#2-plan-de-rollout-y-bitácora-de-ejecución)
3. [Prueba de estrés A/B con hipótesis](#3-prueba-de-estrés-ab-con-hipótesis)
4. [Mapa de calidad ISO/IEC 25000 (SQuaRE)](#4-mapa-de-calidad-isoiec-25000-square)
5. [Índice de evidencias](#5-índice-de-evidencias)
6. [Veredicto Go / No-Go (`v1.1.0` y 10.000 sensores)](#6-veredicto-go--no-go-v110-y-10000-sensores)
7. [Problemas encontrados y cómo los destrabamos](#7-problemas-encontrados-y-cómo-los-destrabamos)

---

## 0. Escenario y carpetas del repo

La plataforma junta datos de temperatura y humedad que mandan 2.000 placas ESP32 desde los lotes de la Cooperativa Agropecuaria del Centro cada 30 segundos (~67 req/s) y los grafica en una web. Semanas atrás un deploy directo cambió todos los pods del front al mismo tiempo en una noche de helada: un bug de JS dejó la página en blanco 40 minutos mientras nginx seguía contestando `200 OK`. Ahora hay que sacar la `v1.1.0` sin jugarse todo el tráfico de una vez y medir además si el backend aguanta pasar el contrato a **10.000 sensores** (~333 req/s).

```
                         terrasense.local                      api.terrasense.local
Navegador / k6 ───────────────┬──────────────────────────────────────────┬──────────────
                              v                                          v
              +------------ NGINX Ingress Controller (addon de Minikube) -------------+
              | terrasense-ingress (cookie sticky)        terrasense-ingress-api      |
              | terrasense-ingress-canary (peso/cookie/header)   (sin afinidad)       |
              +----------┬-------------------┬---------------------┬------------------+
                         v                   v                     v
               Service front-stable  Service front-canary     Service back
                |- pod front 1.0.0    `- pod front 1.1.0       |- pod back 1.0.0 ] HPA 2..8
                `- pod front 1.0.0                             `- pod back 1.0.0 ] (CPU 60%)
                                                                       v
                                                              StatefulSet db (PostgreSQL + PVC)
```

Cómo están repartidas las carpetas adentro de `tp-final/`:
- **`app/back/` y `app/front/`:** API en Node/Express + `pg` con probes `/readyz` y `/healthz`, y un solo `Dockerfile` (`nginx-unprivileged:1.27-alpine`) que compila las tres variantes del panel (`v1.0.0`, `v1.1.0` y `v1.2.0`).
- **`k8s/`:** en `base/` vive lo heredado del TP3 (`db` en StatefulSet, `back` y HPA); en `stable/`, `canary/` e `ingress.yaml` están los Deployments y Services separados por `track` junto a los tres recursos Ingress.
- **`k6/` y `scripts/`:** pruebas de carga/fallas sobre el back, pruebas de split/browser/estrés sobre el front y los scripts `deploy.sh`, `peso.sh`, `conteo-curl.sh` y `rollout.sh`.
- **`../.github/workflows/tp-final-ci.yml` y `ci/`:** pipeline con `htmlhint`, `ESLint`, `hadolint`, Horusec y Trivy más el detalle de alertas tratadas.

Para distinguir qué versión respondió en cada capa pusimos tres marcas en el build del frontend:
- Header `X-App-Version` en todas las respuestas de nginx (incluidos assets y 404), leído por `k6` HTTP para detectar cruce de archivos entre pods.
- Meta tag `<meta name="app-version">` en el `<head>`, leído desde el DOM por `k6/browser`.
- Archivo `/version.txt`, usado por las `readinessProbe` y por `conteo-curl.sh`.

---

## 1. Instrucciones de despliegue en Minikube limpio

Con Docker, Minikube, `kubectl`, `k6` (>= 1.x con soporte browser), Chromium/Chrome, `python3` y `curl` instalados en Ubuntu (paso a paso de paquetes en [`GUIA_EJECUCION.md`](GUIA_EJECUCION.md)):

```bash
git clone https://github.com/LauCallovi/Calidad_software.git
cd Calidad_software/tp-final
./scripts/deploy.sh
```

Qué hace `deploy.sh` de principio a fin:
1. Levanta `minikube start --driver=docker` y prende los addons `ingress` y `metrics-server`.
2. Apunta el cliente al demonio interno con `eval $(minikube docker-env)` y compila ahí mismo las cuatro imágenes con tags fijos (`terrasense-back:1.0.0` y `terrasense-front:1.0.0`, `1.1.0`, `1.2.0`), evitando depender de un registry externo gracias a `imagePullPolicy: IfNotPresent`.
3. Espera el pod del controlador en `ingress-nginx` y crea el namespace, el ConfigMap y el Secret `db-secret` con clave aleatoria tomada de `/dev/urandom` (si ya existía no lo pisa para no desincronizar el volumen de Postgres).
4. Despliega PostgreSQL, el `back` con su HPA y los dos tracks del front con `canary-weight: "0"`.
5. Aplica los Ingress reintentando hasta que responda el webhook de validación y actualiza `/etc/hosts` con `minikube ip`.

Comandos rápidos para chequear que levantó todo sano:
```bash
kubectl -n terrasense get pods,svc,ingress,hpa -L track,version
curl -s http://terrasense.local/version.txt                        # devuelve 1.0.0
curl -s -H 'X-Canary: always' http://terrasense.local/version.txt  # devuelve 1.1.0
curl -s http://api.terrasense.local/api/stats
```

### Primera compuerta: CI (`.github/workflows/tp-final-ci.yml`)

Cada cambio sobre `tp-final/**` dispara en paralelo `lint` (`htmlhint`, `ESLint`, `hadolint`) y `horusec` (Horusec + Trivy con `-s LOW -e true`). El job `build` tiene `needs: [lint, horusec]`, por lo que no se empaqueta ninguna imagen si antes hay errores estáticos o vulnerabilidades sin tratar.

| Run en GitHub Actions | Commit | Estado | Qué pasó |
|---|---|---|---|
| `#43995990963` | `e00a083` | Falló `horusec` (`build` skipped) | 22 alertas: falta de `securityContext` en K8s y `Math.random()` |
| `#44003617085` | `6e0af9f` | Falló `horusec` (`build` skipped) | 1 alerta nueva por nombrar la función random adentro de un comentario |
| `#44008882096` | `7dd88a8` | Verde en los 3 jobs | 14 corregidos, 5 falsos positivos y 3 riesgos aceptados en `ci/HALLAZGOS-HORUSEC.md` |

---

## 2. Plan de rollout y bitácora de ejecución

### 2.1 Reglas del plan (fijadas antes de correr `scripts/rollout.sh`)

En cada escalón corren al mismo tiempo `k6/front-canary-split.js` (tráfico abierto sin cookies previas a 20 req/s) y `k6/browser-canary.js` (20 aperturas reales en Chromium limpio).

| Etapa | Peso | Ventana | Condición para avanzar | Acción si falla |
|---|---|---|---|---|
| `etapa-0` | `0%` + cookie `canary=always` | 3 visitas browser | 3/3 en versión candidata y 0 pantallas blancas | Corta con peso 0 (0 productores afectados) |
| `peso-10` | `10%` | 2 a 5 min | Split en verde (`err < 1%`, `p95 < 300 ms`, `assets_rotos < 1%`), 0 pantallas blancas y `p95 HTML canary <= p95 stable + 10%` (con margen de 5 ms por ruido local) | Rollback automático: peso a 0 + réplicas canary a 0 |
| `peso-25` | `25%` | 2 a 5 min | Mismas condiciones | Rollback automático medido en segundos |
| `peso-50` | `50%` | 2 a 5 min | Mismas condiciones | Rollback automático medido en segundos |
| `peso-100` | `100%` | 2 a 5 min | Mismas condiciones (usando el `p95 stable` de `peso-50` como referencia) | Rollback automático medido en segundos |
| `promocion` | `0%` tras actualizar stable | `rollout status` | `front-stable` responde `1.1.0` con `X-Canary: never` | `kubectl rollout undo deployment/front-stable` |

Al probar el script contra el cluster aparecieron dos temas prácticos que corregimos en `rollout.sh`:

- **HTML suelto contra página con assets:** la `1.0.0` mete CSS y JS adentro del mismo `index.html` (1 pedido HTTP), pero la `1.1.0` pide además `/assets/app-1.1.0.css` y `/assets/app-1.1.0.js` (3 pedidos). Cuando medíamos tiempo total de página en la Etapa `peso-10`, saltaba un rollback falso por ~5 ms de diferencia aunque el HTML nuevo salía igual de rápido y con cero fallos. Pasamos el control del rollout al `p95` del HTML y dejamos la comparación de carga completa de página para el estrés A/B de la sección 3.
- **Secuencia de promoción y limpieza de sesiones sticky:** poner `canary-weight` en `100` no cambia la imagen declarada en `front-stable`. Para promover sin microcortes actualizamos primero `front-stable` a `1.1.0`, esperamos `rollout status`, bajamos peso a `0` y recién al final llevamos `front-canary` a `0` réplicas. En sentido inverso, cuando `rollback()` corta una versión rota también baja `front-canary` a `0` réplicas porque la cookie `terrasense-front` dura 1 hora y dejaría a esos navegadores pegados al pod viejo si siguiera vivo.

### 2.2 Bitácora registrada (`evidencias/reportes/bitacora.csv`)

Corrida en VM Ubuntu sobre Apple Silicon (4 CPUs y 6144 MB asignados a Minikube):

| Inicio | Fin | Etapa | Versión | Peso | % obs. | Visitas | p95 HTML canary (ms) | p95 HTML stable (ms) | Err. canary | Assets rotos | Pant. blancas | Decisión | Detalle |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 17:20:26 | 17:20:41 | `etapa-0` | `1.1.0` | 0% | - | 3 | - | - | - | - | 0 | **AVANZA** | 3/3 visitas forzadas OK |
| 17:20:41 | 17:22:47 | `peso-10` | `1.1.0` | 10% | 9 | 2401 | 3.38 | 6.18 | 0.00% | 0 | 0 | **AVANZA** | criterios cumplidos |
| 17:22:47 | 17:24:52 | `peso-25` | `1.1.0` | 25% | 25.61 | 2401 | 5.10 | 5.02 | 0.00% | 0 | 0 | **AVANZA** | criterios cumplidos |
| 17:24:52 | 17:26:58 | `peso-50` | `1.1.0` | 50% | 50.48 | 2401 | 6.52 | 6.31 | 0.00% | 0 | 0 | **AVANZA** | criterios cumplidos |
| 17:26:58 | 17:29:04 | `peso-100` | `1.1.0` | 100% | 100 | 2400 | 5.52 | 6.31 | 0.00% | 0 | 0 | **AVANZA** | criterios cumplidos |
| 17:47:51 | 17:48:06 | `etapa-0` | `1.2.0` | 0% | - | 3 | - | - | - | - | 3 | **ROLLBACK** | 3 de 3 visitas con pantalla en blanco |
| 17:48:09 | 17:49:19 | `peso-25` | `1.2.0` | 25% | 23.58 | 1200 | 3.87 | 3.96 | 0.00% | 0 | 5 | **ROLLBACK** | 5 pantallas en blanco; rollback en 3.5 s |
| 17:49:25 | 17:49:37 | `promocion` | `1.1.0` | 0% | - | - | - | - | - | - | - | **PROMOCION** | stable ahora sirve 1.1.0; canary a 0 replicas |

### 2.3 Conteo externo con `curl` y logs de `ingress-nginx`

 En cada escalón tiramos 100 pedidos sin cookies a `/version.txt` (`conteo-curl.sh`) y contamos del lado servidor filtrando por `IP:8080` de cada pod en los logs del controlador (porque cada línea de `ingress-nginx` imprime ambos nombres de upstream `[front-stable]` y `[front-canary]`):

| Peso config. | `curl` -> 1.0.0 | `curl` -> 1.1.0 | Logs Ingress (IP pod canary) | `k6` % obs. (n visitas) | `k6/browser` (de 20) -> canary |
|---|---|---|---|---|---|
| 10% | 84 | 16 | 31 | 9% (2401) | 2 / 20 |
| 25% | 75 | 25 | 67 | 25.61% (2401) | 5 / 20 |
| 50% | 57 | 43 | 175 | 50.48% (2401) | 5 / 20 |
| 100% | 0 | 100 | 284 | 100% (2400) | 20 / 20 |

Con `n = 100` en `curl` hay variación muestral normal (±3 a ±5 puntos), mientras que sobre las miles de iteraciones de `k6` el porcentaje observado queda pegado al peso configurado.

---

## 3. Prueba de estrés A/B con hipótesis

### 3.1 Hipótesis planteada antes de medir

> **Hipótesis H:** a 200 cargas completas de página por segundo (HTML + `/assets/`), la `v1.1.0` mantiene menos de `1%` de errores y su `p95` no supera en más de `10%` al `p95` de `v1.0.0`.

Elegimos estresar el **frontend en modalidad A/B aislada por header** (`TARGET=stable` con `X-Canary: never` y luego `TARGET=canary` con `X-Canary: always`) porque durante el rollout normal a 20 req/s las dos versiones trabajan sobradas y no se nota el costo extra de servir 3 archivos por visita en lugar de 1. Para que la cancha sea pareja escalamos `front-canary` a **2 réplicas** igual que `front-stable` (50m/64Mi request, 250m/128Mi limit), pusimos `canary-weight=0`, limpiamos el cookie jar en cada vuelta de `k6` y corrimos la misma escalera `ramping-arrival-rate` de `50 -> 100 -> 200 -> 400 -> 800` cargas/s.

### 3.2 Resultados medidos (`estres-front-stable.json` y `estres-front-canary.json`)

| Escalón (cargas/s) | p95 `v1.0.0` (ms) | p95 `v1.1.0` (ms) | Diferencia % (abs.) | Errores `v1.0.0` | Errores `v1.1.0` |
|---|---|---|---|---|---|
| 50 | 5.58 | 8.94 | +60.2% (+3.36 ms) | 0.00% | 0.00% |
| 100 | 4.93 | 6.30 | +27.7% (+1.37 ms) | 0.00% | 0.00% |
| **200** | 2.86 | 3.94 | +37.8% (+1.08 ms) | 0.00% | 0.00% |
| 400 | 0.93 | 1.26 | +36.6% (+0.34 ms) | 0.00% | 0.00% |
| 800 | 0.60 | 1.21 | +101.5% (+0.61 ms) | 0.00% | 0.00% |

| Indicador global | `v1.0.0` (`front-stable`) | `v1.1.0` (`front-canary`) |
|---|---|---|
| Bytes promedio por carga completa | 2713 B (1 GET inline) | 4668 B (3 GETs: HTML + CSS + JS) |
| Iteraciones descartadas por `k6` | 0 | 212 |
| Thresholds de SLO en escalón 200 (`p95 < 300 ms`, `err < 1%`) | OK | OK |

### 3.3 Lectura de los números y contraste entre máquinas del grupo

En el escalón de 200 cargas/s ambas versiones sostuvieron `0.00%` de errores y tiempos de respuesta de pocos milisegundos (`2.86 ms` en `v1.0.0` vs `3.94 ms` en `v1.1.0`, muy lejos del tope de `300 ms`). Sin embargo, al aplicar de forma estricta la regla relativa del `+10%`, el incremento porcentual dio `+37.8%` (`+1.08 ms` absolutos) porque `v1.1.0` resuelve 3 pedidos HTTP por página (HTML + CSS + JS externos, `4668 B`) frente a 1 solo pedido inline en `v1.0.0` (`2713 B`). Exactamente el mismo fenómeno se observó en la notebook de 2 CPUs / 3 GB del grupo (donde dio `3.16 ms` vs `2.60 ms`, `+21.5%`). Por apego estricto a la hipótesis predefinida se rechaza H, dejando documentado que la diferencia es de fracciones de milisegundo en loopback y no representa un cuello de botella real para los productores.

---

## 4. Mapa de calidad ISO/IEC 25000 (SQuaRE)

### 4.1 Qué cubre cada etapa según ISO/IEC 25010:2023

- **Linters en CI (`htmlhint`, `ESLint`, `hadolint`):** apuntan a *Mantenibilidad* (analizabilidad, modificabilidad) y *Seguridad* (`no-eval`, usuario no-root en Dockerfile). La evidencia es el job `lint` en 0 errores (`#44008882096`). Límite: miran sintaxis estática archivo por archivo, no ven si el diseño está acoplado ni analizan el JS embebido del front.
- **Horusec + Trivy en CI:** cubren *Seguridad* (confidencialidad al sacar claves del repo, integridad y resistencia con `securityContext`). Bajamos de 22 alertas a 0 bloqueantes en `ci/HALLAZGOS-HORUSEC.md`. Límite: no prueban la app levantada (DAST) y `NpmAudit` no corrió porque falta `package-lock.json`.
- **Despliegue en K8s + probes `/readyz` y `/healthz`:** trabajan *Fiabilidad* (disponibilidad, tolerancia a fallos) y *Flexibilidad* (instalabilidad desde cero con `deploy.sh`). Límite: corre todo sobre un único nodo Minikube local sin cortes reales de red ni caída de disco.
- **HPA sobre `back`:** cubre *Eficiencia de desempeño* (capacidad, uso de recursos) y *Flexibilidad* (escalabilidad horizontal de 2 a 8 pods al pasar 60% de CPU, grabado en `02-stress-hpa.mp4`). Límite: escala únicamente por CPU del backend mientras PostgreSQL sigue en una sola instancia.
- **Pruebas `k6` de carga y estrés:** miden *Eficiencia de desempeño* (comportamiento temporal en `p95` y techo de req/s en `tp3-load.txt`, `tp3-stress.txt` y `front-stress.js`). Límite: el proceso `k6` comparte CPU y memoria con Minikube en la misma computadora.
- **Inyección de fallas (E1 pod borrado y E2 pico CPU/OOM):** verifican *Fiabilidad* (tolerancia a fallos y recuperabilidad, con ventana de error en `tp3-e1.txt` y reinicio automático tras `OOMKilled` en `04-e2-oom.mp4`). Límite: no tumbamos el pod `db-0` ni el controlador Ingress.
- **Rollout Canary + `k6/browser`:** cubren *Fiabilidad* (ausencia de fallos y tiempo de rollback), *Adecuación funcional* (que el panel realmente dibuje datos y no quede blanco) y *Compatibilidad* (coexistencia de `1.0.0` y `1.1.0` con `0` assets mezclados en `bitacora.csv`). Límite: usa navegadores automatizados en vez de productores reales y no mide accesibilidad visual.

### 4.2 Divisiones de SQuaRE aplicadas en el TP

- **2503n (Requisitos de calidad - 25030):** son nuestros umbrales escritos en código antes de lanzar tráfico (`p95 < 300 ms`, tasa de fallo `< 1%`, `0` pantallas blancas, `<= +10%` en A/B y meta de `333 req/s` para los 10.000 sensores).
- **2502n (Medición - 25022 y 25023):** son los contadores y percentiles recolectados por `k6`, `kubectl top/get` y `conteo-curl.sh` guardados en `evidencias/reportes/`.
- **2504n (Evaluación - 25040 y 25045):** es la comparación automática en `rollout.sh` que decide `AVANZA` o `ROLLBACK`, el contraste de la hipótesis A/B y las pruebas de recuperación tras matar un pod o agotar RAM (`25045`).

### 4.3 Producto (`25010`) frente a Calidad en uso (`25019`)

Durante TP1, TP2 y las pruebas HTTP de TP3 medimos propiedades internas o de interfaz del **producto** (`25010`): reglas de código, permisos de contenedores, milisegundos de respuesta y códigos de estado. El límite apareció claro con la `v1.2.0`: para las probes de Kubernetes y para `k6` HTTP el producto luce impecable (`200 OK` en 4 ms), pero para el productor rural la **calidad en uso** (`25019`: efectividad y ausencia de riesgo en su tarea real) es cero porque ve el navegador en blanco. Incorporar `k6/browser` acerca esa medición desde el laboratorio, y abrir el canary al 10% permite validarla con tráfico real acotando el radio de impacto al mínimo.

### 4.4 Huecos sin cubrir y cómo sumarlos al pipeline

1. **Capacidad de interacción (accesibilidad y operabilidad):** el verde brillante `#39ff14` de la `v1.1.0` se pensó para distinguir capturas desde el fondo del aula, pero nadie midió relación de contraste WCAG ni navegación por teclado. Sumaríamos **axe-core / Lighthouse CI** en el workflow con puntaje mínimo de accesibilidad `>= 90`.
2. **Compatibilidad (interoperabilidad front-back):** si alguien renombra un campo JSON en `/api/stats`, los dos builds compilan en verde y recién falla el navegador. Lo cubriríamos con **pruebas de contrato (Pact)** o validación de JSON Schema en el job `lint`.
3. **Seguridad dinámica (DAST) y dependencias (SCA):** agregar `package-lock.json` + `npm ci` para habilitar `NpmAudit` / `trivy fs`, bloquear `/api/debug/*` fuera de entornos de prueba y correr un baseline scan de **OWASP ZAP** contra el Ingress antes de abrir peso.

---

## 5. Índice de evidencias

Todos los archivos generados durante la corrida viven bajo `tp-final/evidencias/` (capturas PNG, videos MP4 acelerados con etiqueta de velocidad y reportes crudos TXT/JSON/CSV):

- **Despliegue inicial:** `capturas/01-deploy-kubectl.png`, `01-deploy-navegador.png` y `01-deploy-kubectl-navegador.png` muestran los pods `stable` y `canary` conviviendo con peso 0 y el panel `v1.0.0` cargando lecturas reales.
- **Línea base TP3 y 10.000 sensores:** `reportes/tp3-smoke.txt`, `tp3-load.txt` y `capturas/02-smoke.png`, `02-load.png` validan los 67 req/s actuales; `reportes/capacidad-333-estable.txt` (`+ hpa`) y `capturas/02-capacidad-333.png` prueban la ingesta sostenida a 333 req/s.
- **Estrés del backend y fallas (E1 / E2):** `videos/02-stress-hpa.mp4` + `reportes/tp3-stress.txt` registran el HPA subiendo réplicas hasta encontrar saturación; `videos/03-e1-pod-eliminado.mp4` + `tp3-e1.txt` + `capturas/e1-ux-*.png` miden el corte al matar un pod vivo; `videos/04-e2-oom.mp4` + `capturas/04-oomkilled.png` + `tp3-spike-*.txt` documentan los reinicios por `OOMKilled` (exit 137).
- **Rollout Canary `v1.1.0`:** `capturas/03-etapa0-cookie.png` valida la Etapa 0 lado a lado; `videos/05-rollout-1.1.0.mp4`, `reportes/peso-*-split.json`, `peso-*-browser.json`, `capturas/05-grilla-20-visitas-peso-25.png`, `05-conteo-peso-*.png` y `05-bitacora.png` respaldan las etapas 10, 25, 50 y 100% más el cruce contra IPs en logs de NGINX.
- **Estrés A/B del frontend:** `reportes/estres-front-stable.json` y `estres-front-canary.json` junto con `capturas/04-estres-stable.png` y `04-estres-canary.png` contrastan la hipótesis entre 50 y 800 cargas/s con 2 pods por track.
- **Freno y rollback de `v1.2.0`:** `capturas/06-consola-typeerror.png` y `06-network-200.png` muestran `200 OK` en red junto al `TypeError` y la pantalla vacía; `reportes/demo-a-1.2.0/` prueba el bloqueo en Etapa 0 y `videos/06-rollback-1.2.0.mp4` + `reportes/demo-b-1.2.0/` miden en segundos el rollback automático desde 25%.
- **Promoción, CI y diapositivas:** `capturas/07-promocion.png` (`reportes/promocion.log`) muestra `front-stable` sirviendo `1.1.0`; `capturas/07-ci-rojo.png` y `07-ci-verde.png` documentan las corridas #43995990963 y #44008882096 en GitHub Actions; `presentacion/Presentacion_TP_Final_TerraSense.pdf` contiene las diapos listas para proyectar sin red en el Aula 102.

---

## 6. Veredicto Go / No-Go (`v1.1.0` y 10.000 sensores)

### 6.1 Lanzamiento del panel `v1.1.0`

- **Pipeline CI (`lint` + `horusec` + `build`):** aprobado en verde en el run `#44008882096` tras corregir 14 alertas de contenedores/código y documentar falsos positivos y riesgos aceptados.
- **Etapa 0 y rollout gradual (`10 -> 25 -> 50 -> 100%`):** las 4 etapas avanzaron sin errores, con `0` pantallas en blanco en Chromium y reparto real medido en `9%, 25.61%, 50.48%, 100%`.
- **Control negativo con `v1.2.0`:** frenada en Etapa 0 con `0` productores afectados (Demo A) y revertida de forma automática en **3.5 s** al inyectarla al 25% (Demo B), liberando incluso sesiones con cookie sticky.
- **Contraste de estrés A/B (200 cargas/s):** `2.86 ms` (`v1.0.0`) frente a `3.94 ms` (`v1.1.0`), variación `+37.8%` y `0.00%` de errores.
- **Dictamen `v1.1.0`:** **NO-GO estricto por regla relativa de estrés A/B (GO técnico condicionado a ajustar el umbral con tolerancia absoluta de 5 ms, igual que en el rollout)**. Ejecutamos además la secuencia real de promoción (`07-promocion.png`) para dejar validado el procedimiento operativo sin corte.

### 6.2 Ampliación del contrato a 10.000 sensores (~333 req/s)

- **En la notebook de 2 CPUs / 3 GB del grupo:** el HPA clavó `8/8` réplicas, el `p95` subió a `1.15 s` (por encima de los `300 ms` pedidos) y el arranque en frío saturó el nodo.
- **En nuestra VM de 4 CPUs / 6 GB (`capacidad-333-estable.txt`):** con rampa de 1 minuto para darle tiempo al HPA, medimos `p95 = 2.44ms` y tasa de fallos `0.00%` sobre `POST /api/sensores`.
- **Dictamen 10.000 sensores:** **GO condicionado a aprovisionar al menos 4 vCPUs dedicados y rampa/pre-escalado**. Incluso cuando 4 CPUs absorben mucho mejor la carga que 2 CPUs, en producción real no ampliaríamos a 10.000 placas sin antes agregar un pooler de conexiones (PgBouncer), separar lectura/escritura o encolar la ingesta para proteger el único pod `db-0` ante reconexiones masivas tras un corte de luz o antena.

---

## 7. Problemas encontrados y cómo los destrabamos

- **Mezcla de CSS/JS entre versiones:** sin afinidad, un navegador bajaba el HTML de `1.1.0` y pedía `/assets/app-1.1.0.css` a un pod `1.0.0` recibiendo `404`. Activamos cookie `terrasense-front` en ambos Ingress del front y separamos la API en `terrasense-ingress-api` sin afinidad para no arruinar el reparto sobre `back`.
- **La cookie sticky sobrevive al `canary-weight=0`:** durante el rollback vimos que poner solo peso 0 deja a los usuarios que ya tenían cookie del canary atrapados en la versión rota por 1 hora. Ajustamos `rollback()` en `rollout.sh` para bajar también `front-canary` a 0 réplicas y verificar con un cliente con cookie que NGINX lo reenvía a `front-stable`.
- **Conteo engañoso por nombre de upstream en logs de NGINX:** cada línea de acceso de `ingress-nginx` imprime tanto `[terrasense-front-stable-8080]` como `[terrasense-front-canary-8080]`. Corregimos `conteo-curl.sh` para cruzar contra la `IP:8080` real de los pods de cada track.
- **Coma decimal según `locale` y hash sensible a líneas en Horusec:** en sistemas con `es_AR` `awk` escribía comas que desarmaban columnas en `bitacora.csv` (resuelto con `export LC_NUMERIC=C`). Además, al parametrizar `k6/spike.js` se desplazó la línea de `Math.random()` e invalidó su hash en `horusec-config.json`; lo reemplazamos por `exec.scenario.iterationInTest % 2 === 0` para no depender del número de línea.
- **Retiro oficial de `ingress-nginx` (marzo de 2026):** para el laboratorio usamos el addon estándar de Minikube pedido por la cátedra, pero en un cluster productivo nuevo migraríamos estas reglas a **Kubernetes Gateway API** (`HTTPRoute` con `backendRefs.weight` y filtros por header/cookie).
