# Veredictos de Jeremías

Conclusiones personales a partir de **mis corridas** del 17 y 18/11/2026 (evidencias en esta carpeta,
`evidencias/jere/`). El veredicto del grupo va en el README (§3.5 y §6); este documento es mi aporte
para esa discusión.

**Entorno:** HP OmniBook X Flip 14 (AMD Ryzen AI 5 430, 4 núcleos / 8 hilos, 16 GB de RAM), Ubuntu
26.04.1 nativo, sin VM. Minikube 1.39 con 4 CPU y 6 GB de RAM; k6 2.4.0 en la misma notebook, así que
la carga y el cluster comparten la CPU.

## Conclusión de la prueba de estrés A/B

**H se rechaza en su parte relativa y se confirma en su parte de capacidad.**

- **Rendimiento relativo (rechazado):** en el escalón de referencia (200 cargas/s) el p95 de la v1.1.0 es un
  **16 % mayor** que el de la v1.0.0 (1,60 vs 1,39 ms), por encima del +10 % que fijamos. En todos los escalones la
  v1.1.0 es más lenta. La diferencia se explica por el tamaño: la v1.1.0 pesa **+72 % de bytes por página**
  (4.668 vs 2.713) y pide un asset más (el CSS), así que cada carga de página hace un request extra.
- **Capacidad (confirmada):** ninguna versión tiene punto de quiebre dentro del rango probado. Las dos sostienen
  **800 cargas/s (4× el objetivo de 200) con 0 % de errores**, 0 versiones inesperadas y 0 iteraciones
  descartadas: el límite no lo puso ni la app ni el generador.
- **Magnitud:** la regresión es de **0,2 ms** en términos absolutos. Un +10 % sobre tiempos de 1–2 ms es menor que
  el ruido de la medición: el p95 *baja* al subir la carga en las dos versiones (efecto de calentamiento de
  NGINX y del escalado de frecuencia de la CPU de la notebook), algo que no esperaríamos en producción.

**Implicancia para la promoción.** La regresión es real pero no bloquea: la hipótesis estaba formulada en
términos relativos, y para tiempos tan chicos el criterio relativo es demasiado estricto. Es la misma razón
por la que el plan de rollout (fijado antes de ejecutar) acepta una diferencia de hasta 5 ms. La v1.1.0 queda
**apta para promover**, con una deuda técnica registrada: reducir el peso de la página (minificar CSS/JS,
inlinear el CSS o servir con compresión) y, para la próxima hipótesis, combinar umbral relativo y absoluto
(«+10 % o +5 ms, lo que sea mayor»).

## Veredicto: release de la v1.1.0

**Veredicto v1.1.0: GO, con una observación.** Cumple todos los criterios de release salvo la parte relativa
de la hipótesis de estrés: la v1.1.0 es un 16 % más lenta por pesar un 72 % más, pero son 0,2 ms y la capacidad
no cambia (ambas versiones sostienen 4× la carga objetivo). Se promueve y se registra como deuda técnica la
reducción del peso de la página.

## Veredicto: ampliación a 10.000 sensores

**Veredicto 10.000 sensores: GO condicionado.** La carga nominal de 10.000 sensores (333 req/s) se atiende con
holgura: p95 de 4 ms, 0 % de errores y ~5 de las 8 réplicas posibles. Lo que no está resuelto es la
**resistencia a picos**: el HPA llega a 8 réplicas a ~700 req/s (2× la carga nominal) y ante un pico vertical
con requests costosos el back colapsa antes de que el HPA reaccione. Condiciones para ampliar:

1. Más margen de escalado: subir `maxReplicas` y los recursos del nodo (el tope de 8 lo pone la notebook).
2. Liveness más tolerante y separada de la readiness, para no reiniciar pods que solo están saturados.
3. HPA más agresivo al subir (`behavior.scaleUp`) o un umbral de CPU menor que 60 %.
4. Repetir el stress y el spike en el entorno productivo: estos números valen para una notebook donde el
   cluster y el generador de carga comparten CPU (la misma prueba dio p95 de 4, 15 y 53 ms según la corrida
   y la máquina).
