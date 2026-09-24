# Consigna 4
**Total de hallazgos:** 31 · **Verdaderos positivos:** 20 · **Falsos positivos:** 11

---

### 1. `server/modules/tlsClient.ts:2` — HS-JAVASCRIPT-3 (CRITICAL)
- **Clasificación:** verdadero positivo
- **Justificación:** desactiva la validación de certificados TLS a nivel global del proceso, aceptando certificados autofirmados o inválidos.
- **Activo afectado:** todas las conexiones TLS salientes del backend (APIs externas, DB remota, etc.).
- **Consecuencia:** ataque man-in-the-middle, interceptación/alteración de tráfico cifrado.
- **Corrección:** eliminar `NODE_TLS_REJECT_UNAUTHORIZED=0`; si se necesita una CA propia, cargarla explícitamente con `ca:` en las opciones TLS.

### 2. `src/services/riskSimulator.ts:4` — HS-JAVASCRIPT-2 (CRITICAL)
- **Clasificación:** verdadero positivo
- **Justificación:** `eval(expression)` ejecuta código arbitrario a partir de un input que llega a un simulador expuesto al usuario.
- **Activo afectado:** proceso Node completo.
- **Consecuencia:** ejecución remota de código (RCE), compromiso total del servidor.
- **Corrección:** reemplazar `eval` por un parser de expresiones seguro (ej. `mathjs` en modo restringido) o whitelist de operaciones.

### 3. `server/support/etag.ts:5` — HS-JAVASCRIPT-5 (HIGH)
- **Clasificación:** falso positivo
- **Justificación:** SHA1 se usa solo para generar un ETag de caché HTTP sobre contenido público; no protege contraseñas ni datos confidenciales.
- **Activo afectado:** ninguno sensible.
- **Consecuencia:** ninguna relevante para seguridad.
- **Corrección:** no requiere cambio (opcional: migrar a SHA-256 para evitar el ruido del scanner).

### 4. `server/modules/staticFiles.ts:2` — HS-JAVASCRIPT-17 (HIGH)
- **Clasificación:** verdadero positivo
- **Justificación:** `dotfiles: 'allow'` permite servir archivos ocultos (`.env`, `.git`, `.htpasswd`) desde el servidor de estáticos.
- **Activo afectado:** archivos de configuración/secretos del repositorio.
- **Consecuencia:** exposición de credenciales y código fuente de control de versiones.
- **Corrección:** cambiar a `dotfiles: 'ignore'` o `'deny'`.

### 5. `server/support/cacheHash.ts:5` — HS-JAVASCRIPT-4 (HIGH)
- **Clasificación:** falso positivo
- **Justificación:** MD5 se usa solo para invalidar caché de CSS público, no para proteger información sensible.
- **Activo afectado:** ninguno sensible.
- **Consecuencia:** ninguna relevante para seguridad.
- **Corrección:** no requiere cambio (opcional: SHA-256 para el hash de caché).

### 6. `server/modules/maintenanceCli.ts:1` — HS-JAVASCRIPT-21 (HIGH)
- **Clasificación:** verdadero positivo
- **Justificación:** se importa `child_process.exec` en un CLI de mantenimiento (confianza HIGH); si los argumentos de línea de comandos llegan sin sanitizar a `exec`, se habilita inyección de comandos del SO.
- **Activo afectado:** sistema operativo/shell del servidor.
- **Consecuencia:** ejecución de comandos arbitrarios en el host.
- **Corrección:** sanear estrictamente los argumentos o usar `execFile` con arreglo de argumentos (sin shell).

### 7. `server/modules/navigation.ts:2` — HS-JAVASCRIPT-22 (HIGH)
- **Clasificación:** verdadero positivo
- **Justificación:** `res.redirect(next)` redirige a una URL controlada por el usuario sin validarla contra una whitelist.
- **Activo afectado:** usuarios de la aplicación.
- **Consecuencia:** open redirect, usable en phishing y cadenas de ataque (ej. OAuth).
- **Corrección:** validar que `next` sea una ruta relativa interna o esté en una lista blanca de dominios permitidos.

### 8. `server/support/validatedRedirect.ts:5` — HS-JAVASCRIPT-22 (HIGH)
- **Clasificación:** falso positivo
- **Justificación:** a diferencia de `navigation.ts`, esta función ya valida `next` antes de la línea reportada; el motor solo analiza la línea del redirect y no ve la validación previa del mismo archivo.
- **Activo afectado:** N/A (mitigado).
- **Consecuencia:** ninguna, dado el control ya existente.
- **Corrección:** no aplica; cubrir con test unitario que garantice que la validación no se pierda en refactors.

### 9. `server/modules/tokenDigest.ts:4` — HS-JAVASCRIPT-5 (HIGH)
- **Clasificación:** verdadero positivo
- **Justificación:** SHA1 se usa para generar el digest de un token de seguridad (sesión/recuperación), sin salt, uso donde la debilidad criptográfica sí importa.
- **Activo afectado:** tokens de sesión/autenticación.
- **Consecuencia:** ataques de colisión/fuerza bruta sobre tokens, suplantación de sesión.
- **Corrección:** usar HMAC-SHA256 con clave secreta en lugar de SHA1 plano.

### 10. `server/modules/passwordDigest.ts:4` — HS-JAVASCRIPT-4 (HIGH)
- **Clasificación:** verdadero positivo
- **Justificación:** MD5 se usa para hashear contraseñas de usuario sin salt, algoritmo roto para esta finalidad.
- **Activo afectado:** contraseñas de usuarios.
- **Consecuencia:** cracking masivo vía rainbow tables ante una fuga de la base de datos.
- **Corrección:** migrar a bcrypt/scrypt/argon2 con salt individual por usuario.

### 11. `src/services/recoveryDialog.ts:2` — HS-JAVASCRIPT-16 (HIGH)
- **Clasificación:** verdadero positivo
- **Justificación:** se muestra un código crítico de recuperación mediante `prompt()`, visible/registrable por extensiones y herramientas de automatización.
- **Activo afectado:** código de recuperación de cuenta.
- **Consecuencia:** robo del código y toma de control de la cuenta.
- **Corrección:** mostrar el código en un componente de UI propio, nunca vía `prompt`/`alert`/`confirm` nativos.

### 12. `server/modules/weakTls.ts:2` — HS-JAVASCRIPT-12 (HIGH)
- **Clasificación:** verdadero positivo
- **Justificación:** se fuerza `TLSv1.1`, protocolo obsoleto y vulnerable.
- **Activo afectado:** confidencialidad/integridad del canal de comunicación.
- **Consecuencia:** ataques como POODLE/BEAST, degradación del cifrado.
- **Corrección:** eliminar el protocolo fijo o establecer mínimo TLSv1.2 (idealmente TLSv1.3) vía `minVersion`.

### 13. `server/modules/profileRenderer.ts:2` — HS-JAVASCRIPT-23 (HIGH)
- **Clasificación:** verdadero positivo
- **Justificación:** `req.body` completo se pasa a la plantilla sin filtrar campos, permitiendo inyectar propiedades interpretadas por el motor de vistas.
- **Activo afectado:** motor de plantillas/servidor.
- **Consecuencia:** Server-Side Template Injection, potencial RCE o lectura de archivos locales.
- **Corrección:** construir explícitamente el objeto de datos pasado a `render` con solo los campos esperados y validados.

### 14. `src/services/frameBridge.ts:5` — HS-JAVASCRIPT-11 (HIGH)
- **Clasificación:** verdadero positivo
- **Justificación:** `postMessage` se envía con `"*"` como origen destino; cualquier ventana/iframe puede recibir el payload.
- **Activo afectado:** datos del `record` transmitidos entre ventanas.
- **Consecuencia:** fuga de información hacia orígenes no confiables.
- **Corrección:** especificar el origen exacto de destino y validar el origen también del lado receptor.

### 15. `src/services/riskSimulator.ts:10` — HS-JAVASCRIPT-6 (HIGH)
- **Clasificación:** verdadero positivo
- **Justificación:** el identificador de registro de riesgo se genera con `Math.random()`, predecible; si se usa para referenciar/recuperar el registro (ej. en una URL), es enumerable.
- **Activo afectado:** identificadores de registros de riesgo (riesgo de IDOR).
- **Consecuencia:** un atacante podría enumerar o predecir IDs y acceder a registros ajenos.
- **Corrección:** generar el identificador con `crypto.randomUUID()` o `crypto.randomBytes()`.

### 16. `src/tooling/uiDiagnostics.ts:17` — HS-JAVASCRIPT-15 (HIGH)
- **Clasificación:** falso positivo
- **Justificación:** el `debugger;` está dentro de un módulo de diagnóstico de UI pensado para desarrollo, no incluido en el bundle de producción.
- **Activo afectado:** N/A.
- **Consecuencia:** ninguna si el módulo se excluye del build productivo.
- **Corrección:** confirmar por configuración de build que el módulo no se incluya en producción; documentar su uso exclusivo de dev.

### 17. `src/tooling/uiDiagnostics.ts:23` — HS-JAVASCRIPT-16 (HIGH)
- **Clasificación:** falso positivo
- **Justificación:** el `prompt` solicita una "etiqueta de demo" genérica sin información sensible, en el mismo módulo de diagnóstico.
- **Activo afectado:** ninguno sensible.
- **Consecuencia:** ninguna relevante para seguridad.
- **Corrección:** sin cambios obligatorios.

### 18. `src/tooling/uiDiagnostics.ts:7` — HS-JAVASCRIPT-6 (HIGH)
- **Clasificación:** falso positivo
- **Justificación:** `Math.random()*12` genera un valor decorativo/de prueba sin ningún uso de seguridad (no es token, ID ni clave).
- **Activo afectado:** ninguno.
- **Consecuencia:** ninguna.
- **Corrección:** sin cambios.

### 19. `src/services/legacyClientDb.ts:9` — HS-JAVASCRIPT-13 (HIGH)
- **Clasificación:** verdadero positivo
- **Justificación:** usa Web SQL Database (API deprecada), accesible por cualquier script con solo conocer el nombre de la base (`aegis-audit`).
- **Activo afectado:** caché local de auditoría.
- **Consecuencia:** un script inyectado (ej. vía XSS) puede leer/alterar los datos de auditoría en cliente.
- **Corrección:** reemplazar por IndexedDB (o storage cifrado) y revisar si esos datos deben persistir en cliente.

### 20. `server/support/escapedEcho.ts:11` — HS-JAVASCRIPT-23 (HIGH)
- **Clasificación:** falso positivo
- **Justificación:** el mensaje se sanitiza explícitamente con `escapeHtml()` antes de enviarse; no hay renderizado de plantilla ni stack trace expuesto.
- **Activo afectado:** N/A.
- **Consecuencia:** ninguna, XSS mitigado por el escape.
- **Corrección:** no obligatoria (opcional: header `Content-Type: text/plain`).

### 21. `src/services/productionProbe.ts:2` — HS-JAVASCRIPT-15 (HIGH)
- **Clasificación:** verdadero positivo
- **Justificación:** a diferencia de `uiDiagnostics.ts`, este `debugger;` está en un módulo de producción (`productionProbe`), pudiendo pausar el proceso ante un debugger remoto adjunto.
- **Activo afectado:** disponibilidad del proceso Node en producción.
- **Consecuencia:** denegación de servicio o exposición de estado interno.
- **Corrección:** eliminar la sentencia y agregar la regla `no-debugger` al lint de CI.

### 22. `server/modules/xmlImport.ts:8` — HS-JAVASCRIPT-10 (MEDIUM)
- **Clasificación:** verdadero positivo
- **Justificación:** se parsea XML del body de la request sin deshabilitar explícitamente entidades externas/DTD.
- **Activo afectado:** sistema de archivos del servidor y servicios internos.
- **Consecuencia:** XXE — lectura de archivos locales, SSRF, DoS por expansión de entidades.
- **Corrección:** deshabilitar DTD y entidades externas en la configuración del parser.

### 23. `server/modules/errorResponder.ts:2` — HS-JAVASCRIPT-25 (MEDIUM)
- **Clasificación:** verdadero positivo
- **Justificación:** `err.stack` se envía directamente al cliente como respuesta de error.
- **Activo afectado:** detalles internos de implementación.
- **Consecuencia:** fuga de información que facilita reconocimiento para ataques posteriores.
- **Corrección:** loguear el stack solo en servidor y devolver al cliente un mensaje genérico.

### 24. `server/support/safeReportReader.ts:8` — HS-JAVASCRIPT-7 (MEDIUM)
- **Clasificación:** falso positivo
- **Justificación:** el path se construye con `path.basename(req.query.report)` unido a un directorio fijo `SAFE_REPORTS`, neutralizando el path traversal.
- **Activo afectado:** N/A (mitigado).
- **Consecuencia:** ninguna, el acceso queda confinado a `SAFE_REPORTS`.
- **Corrección:** no obligatoria (opcional: whitelist de extensiones).

### 25. `server/modules/reportReader.ts:4` — HS-JAVASCRIPT-7 (MEDIUM)
- **Clasificación:** verdadero positivo
- **Justificación:** `req.query.report` se usa directamente como ruta de archivo sin sanitización ni confinamiento a directorio base.
- **Activo afectado:** archivos del sistema de archivos del servidor.
- **Consecuencia:** path traversal, lectura arbitraria de archivos.
- **Corrección:** resolver la ruta dentro de un directorio base con `path.basename`/`path.resolve` y verificar que quede contenida en él.

### 26. `server/modules/reportStream.ts:4` — HS-JAVASCRIPT-8 (MEDIUM)
- **Clasificación:** verdadero positivo
- **Justificación:** `req.params.file` se usa directamente para crear un stream de lectura sin sanitización.
- **Activo afectado:** archivos del sistema de archivos del servidor.
- **Consecuencia:** path traversal, lectura arbitraria de archivos.
- **Corrección:** sanear el nombre de archivo y confinarlo a un directorio permitido antes de crear el stream.

### 27. `server/modules/corsPolicy.ts:1` — HS-JAVASCRIPT-19 (LOW)
- **Clasificación:** falso positivo
- **Justificación:** es solo una declaración de tipos para TypeScript (`declare function cors(): unknown;`), sin lógica ni configuración real.
- **Activo afectado:** N/A.
- **Consecuencia:** ninguna.
- **Corrección:** ninguna, es un artefacto de tipado.

### 28. `server/modules/corsPolicy.ts:4` — HS-JAVASCRIPT-19 (LOW)
- **Clasificación:** verdadero positivo
- **Justificación:** se invoca `cors()` sin configuración de `origin`, lo que en la librería estándar habilita por defecto `Access-Control-Allow-Origin: *`.
- **Activo afectado:** endpoints de la API expuestos vía CORS.
- **Consecuencia:** cualquier sitio puede hacer solicitudes cross-origin y leer respuestas, ampliando la superficie de ataque.
- **Corrección:** configurar `cors({ origin: [...] })` con whitelist explícita de orígenes.

### 29. `src/services/sensitiveCache.ts:5` — HS-JAVASCRIPT-14 (INFO)
- **Clasificación:** verdadero positivo
- **Justificación:** se guarda explícitamente un "registro sensible" en `localStorage`, accesible sin cifrado por cualquier script del mismo origen.
- **Activo afectado:** datos sensibles del usuario en el navegador.
- **Consecuencia:** exposición de datos ante XSS o acceso físico/extensiones maliciosas.
- **Corrección:** no almacenar datos sensibles en `localStorage`; usar sesión de servidor o cifrar el dato en cliente.

### 30. `src/tooling/uiDiagnostics.ts:12` — HS-JAVASCRIPT-14 (INFO)
- **Clasificación:** falso positivo
- **Justificación:** solo se guarda una preferencia de interfaz no sensible (`ui-theme`) en `localStorage`.
- **Activo afectado:** ninguno sensible.
- **Consecuencia:** ninguna.
- **Corrección:** sin cambios.

### 31. `src/tooling/uiDiagnostics.ts:2` — HS-JAVASCRIPT-1 (INFO)
- **Clasificación:** falso positivo
- **Justificación:** el mensaje logueado ("Aegis Vault UI ready") es informativo de estado, sin datos sensibles ni credenciales.
- **Activo afectado:** ninguno.
- **Consecuencia:** ninguna.
- **Corrección:** sin cambios.

# Consigna 5

## 1. ¿Cuántos findings totales obtuviste?

**31 findings**: 2 CRITICAL, 19 HIGH, 5 MEDIUM, 2 LOW y 3 INFO.

El mensaje final de la CLI dice *"28 vulnerabilities were found"* porque ese conteo excluye los 3 findings de severidad INFO. Esto muestra que el resumen de la herramienta ya filtra información que después resulta relevante (ver pregunta 7).

---

## 2. ¿Cuáles corresponden a los 20 verdaderos positivos?

| # | Archivo:línea | Regla | Severidad | Código |
|---|---|---|---|---|
| 1 | `src/services/riskSimulator.ts:4` | HS-JAVASCRIPT-2 | CRITICAL | `eval(expression)` |
| 2 | `server/modules/tlsClient.ts:2` | HS-JAVASCRIPT-3 | CRITICAL | `NODE_TLS_REJECT_UNAUTHORIZED = "0"` |
| 3 | `src/services/legacyClientDb.ts:9` | HS-JAVASCRIPT-13 | HIGH | `window.openDatabase(...)` (WebSQL) |
| 4 | `src/services/productionProbe.ts:2` | HS-JAVASCRIPT-15 | HIGH | `debugger` |
| 5 | `src/services/frameBridge.ts:5` | HS-JAVASCRIPT-11 | HIGH | `postMessage(..., "*")` |
| 6 | `server/modules/passwordDigest.ts:4` | HS-JAVASCRIPT-4 | HIGH | MD5 sobre contraseñas |
| 7 | `server/modules/tokenDigest.ts:4` | HS-JAVASCRIPT-5 | HIGH | SHA-1 sobre tokens |
| 8 | `server/modules/navigation.ts:2` | HS-JAVASCRIPT-22 | HIGH | `res.redirect(next)` sin validar |
| 9 | `server/modules/maintenanceCli.ts:1` | HS-JAVASCRIPT-21 | HIGH | `exec` con argumentos de CLI |
| 10 | `src/services/recoveryDialog.ts:2` | HS-JAVASCRIPT-16 | HIGH | `prompt()` que muestra el código de recuperación |
| 11 | `server/modules/weakTls.ts:2` | HS-JAVASCRIPT-12 | HIGH | `secureProtocol: 'TLSv1.1'` |
| 12 | `server/modules/profileRenderer.ts:2` | HS-JAVASCRIPT-23 | HIGH | `res.render('profile', req.body)` |
| 13 | `src/services/riskSimulator.ts:10` | HS-JAVASCRIPT-6 | HIGH | ID de recuperación con `Math.random()` |
| 14 | `server/modules/staticFiles.ts:2` | HS-JAVASCRIPT-17 | HIGH | `dotfiles: 'allow'` |
| 15 | `server/modules/xmlImport.ts:8` | HS-JAVASCRIPT-10 | MEDIUM | Parseo de XML del request (XXE) |
| 16 | `server/modules/errorResponder.ts:2` | HS-JAVASCRIPT-25 | MEDIUM | `res.send(err.stack)` |
| 17 | `server/modules/reportStream.ts:4` | HS-JAVASCRIPT-8 | MEDIUM | `createReadStream(req.params.file)` |
| 18 | `server/modules/reportReader.ts:4` | HS-JAVASCRIPT-7 | MEDIUM | `readFileSync(req.query.report)` |
| 19 | `server/modules/corsPolicy.ts:4` | HS-JAVASCRIPT-19 | LOW | `cors()` sin configurar (`Access-Control-Allow-Origin: *`) |
| 20 | `src/services/sensitiveCache.ts:5` | HS-JAVASCRIPT-14 | INFO | Registro sensible en `localStorage` |

---

## 3. ¿Qué categorías de vulnerabilidad diferentes encontraste?

| Categoría | CWE | Findings |
|---|---|---|
| Inyección de código / comandos | CWE-94, CWE-78/88 | eval, exec |
| Server-side template injection / control de opciones del render | CWE-73 / CWE-1336 | profileRenderer |
| Path traversal | CWE-22 / CWE-35 | reportReader, reportStream |
| XML External Entities (XXE) | CWE-611 / CWE-827 | xmlImport |
| Criptografía débil para hashing | CWE-327 / CWE-328 | MD5 en contraseñas, SHA-1 en tokens |
| Aleatoriedad insegura | CWE-338 | ID de recuperación con `Math.random` |
| Transporte inseguro / validación de certificados | CWE-295, CWE-326 | TLS reject deshabilitado, TLSv1.1 |
| Open redirect | CWE-601 | navigation |
| Exposición de información en mensajes de error | CWE-209 | `err.stack` |
| Mala configuración de seguridad | CWE-538, CWE-942 | dotfiles, CORS permisivo |
| Exposición de datos sensibles en el cliente | CWE-922, CWE-359 | localStorage, WebSQL, `postMessage` a `*`, `prompt` con código |
| Código de depuración en producción | CWE-489 | `debugger` |

En total son unas **12 categorías**, que cubren inyección, criptografía, configuración, exposición de datos y código de debug.

---

## 4. Cinco verdaderos positivos con escenario de impacto realista

### a) Contraseñas con MD5 — `server/modules/passwordDigest.ts:4`

- **Escenario:** un atacante obtiene un dump de la base de usuarios, por ejemplo a través del path traversal o de un backup filtrado. Como MD5 es muy rápido y no tiene salt, con una GPU y diccionarios recupera la mayoría de las contraseñas en horas. Como muchos usuarios reutilizan contraseñas, el impacto se extiende a otros servicios.
- **Activo afectado:** credenciales de usuarios.
- **Corrección:** usar bcrypt, scrypt o Argon2id con salt por usuario y factor de costo; rehashear en el próximo login.

### b) Path traversal — `server/modules/reportReader.ts:4`

- **Escenario:** un usuario autenticado pide `?report=../../.env` o `?report=/etc/passwd`. El servidor devuelve el archivo con los permisos del proceso Node, lo que expone credenciales de base de datos, claves de API y secretos de firma de tokens. Con esos secretos se pueden falsificar sesiones y acceder a toda la información protegida.
- **Activo afectado:** secretos del servidor y, por extensión, todos los datos del sistema.
- **Corrección:** confinar las rutas a un directorio base (`path.resolve` + verificar el prefijo), o mapear IDs de reporte a archivos del lado del servidor.

### c) `postMessage` a `"*"` — `src/services/frameBridge.ts:5`

- **Escenario:** un sitio malicioso embebe Aegis Vault en un iframe. Cada vez que el usuario selecciona un registro, la app envía el payload completo a la ventana padre, que ahora es el atacante. La víctima no nota nada y el atacante recolecta registros sensibles uno por uno.
- **Activo afectado:** registros sensibles mostrados en la UI.
- **Corrección:** especificar el origin exacto del destinatario, validar `event.origin` en el receptor y agregar `frame-ancestors` en la CSP.

### d) Validación TLS deshabilitada — `server/modules/tlsClient.ts:2`

- **Escenario:** la variable `NODE_TLS_REJECT_UNAUTHORIZED` es global, así que todas las conexiones salientes del proceso aceptan cualquier certificado. Alguien en la misma red (WiFi compartida, proxy comprometido) hace un ataque MITM a las llamadas del servidor hacia la base de datos o APIs externas, y puede leer y modificar los datos en tránsito.
- **Activo afectado:** confidencialidad e integridad de la comunicación servidor–servicios.
- **Corrección:** eliminar la línea. Si hay una CA interna, configurarla con la opción `ca` en el agente HTTPS específico.

### e) Código de recuperación predecible — `src/services/riskSimulator.ts:10`

- **Escenario:** el ID `REC-…` combina `Math.random()` con `Date.now()`. El estado interno de `Math.random()` (xorshift128+ en V8) puede reconstruirse a partir de pocas salidas observadas, y `Date.now()` es fácil de estimar. Un atacante que genera varios códigos propios puede predecir los ajenos y usarlos para tomar control de cuentas por el flujo de recuperación.
- **Activo afectado:** cuentas de usuario (flujo de recuperación).
- **Corrección:** usar `crypto.randomUUID()` o `crypto.getRandomValues()`, con expiración y uso único del código.

---

## 5. Falsos positivos y el contexto que los invalida

| Archivo:línea | Regla | Por qué la regla no aplica |
|---|---|---|
| `server/support/etag.ts:5` | SHA-1 | El hash se calcula sobre un payload público para generar un ETag. Detecta cambios de caché; no es una protección criptográfica. Una colisión solo causaría un cache hit/miss incorrecto. |
| `server/support/cacheHash.ts:5` | MD5 | Fingerprint de CSS público para cache-busting. No protege secretos ni integridad frente a un atacante. |
| `server/support/validatedRedirect.ts:5` | Redirect | `next` se valida contra una lista de destinos permitidos antes del redirect. Horusec analiza la línea aislada y no ve el control previo. |
| `server/support/escapedEcho.ts:11` | Render + stack trace | Es un `res.send` de texto escapado con `escapeHtml`, no un template engine, y no contiene ningún stack trace. La regla matchea por el patrón `req.body` dentro de una respuesta. |
| `server/support/safeReportReader.ts:8` | Read file | `path.basename()` descarta cualquier componente de directorio (`../`), así que el archivo siempre se resuelve dentro de `SAFE_REPORTS`. |
| `server/modules/corsPolicy.ts:1` | CORS | Es un `declare function cors()`: una declaración de tipo de TypeScript que desaparece al compilar y no ejecuta nada. El uso real ya está reportado en la línea 4. |
| `src/tooling/uiDiagnostics.ts:2` | console.log | Loguea un string literal fijo, sin datos del usuario ni secretos. |
| `src/tooling/uiDiagnostics.ts:7` | Math.random | Genera un número cosmético para la demo; no es un token, ID ni valor del que dependa la seguridad. |
| `src/tooling/uiDiagnostics.ts:12` | localStorage | Guarda solo la preferencia de tema visual, que no es información sensible. |
| `src/tooling/uiDiagnostics.ts:17` | debugger | Código de diagnóstico para desarrollo en `src/tooling/`; no forma parte del flujo productivo. |
| `src/tooling/uiDiagnostics.ts:23` | prompt | Pide una etiqueta de demo con valor por defecto `'muestra'`; no muestra ni captura información sensible. |

---

## 6. Dos falsos positivos: qué tendría que cambiar para que sean verdaderos positivos

### `server/support/safeReportReader.ts`

Pasaría a ser VP si se elimina `path.basename()`:

```ts
fs.readFileSync(path.join(SAFE_REPORTS, req.query.report), 'utf8');
```

`path.join` normaliza los `../` y permite salir del directorio. También sería VP si se usa `path.resolve` sin verificar después que el resultado empiece con `SAFE_REPORTS`.

### `server/support/etag.ts`

Pasaría a ser VP si el mismo `createHash("sha1")` se aplicara a datos que un atacante tenga incentivo en atacar: contraseñas, tokens, o una firma de integridad de un documento que el servidor después acepta como auténtico. En ese contexto sí importan la resistencia a colisiones y la velocidad del algoritmo.

---

## 7. ¿Qué riesgo existe si un equipo ignora automáticamente los findings de severidad baja o informativa?

La severidad de Horusec se asigna **por regla**, no por contexto: la herramienta no sabe qué dato se está manipulando. En este mismo análisis:

- `sensitiveCache.ts` guarda un **registro sensible en claro en `localStorage`** y Horusec lo marcó como **INFO**. Combinado con cualquier XSS, es una fuga directa de datos.
- `corsPolicy.ts:4` deja la API abierta a cualquier origen y quedó en **LOW**.

Filtrar LOW e INFO habría descartado **2 de los 20 verdaderos positivos (10%)**, incluido uno que expone exactamente el tipo de información que el sistema protege. A la inversa, varios findings HIGH resultaron falsos positivos (`etag.ts`, `cacheHash.ts`).

La severidad reportada es un punto de partida para priorizar, no un veredicto. Lo razonable es bajar la prioridad de LOW/INFO pero no suprimirlos sin revisión, y mantener una lista de falsos positivos justificados y versionados en lugar de un filtro ciego.

---

## 8. ¿Por qué un análisis "sin alertas" no demuestra que el sistema sea seguro?

- **SAST solo detecta lo que tiene reglas.** Horusec trabaja con patrones sobre líneas de código. No detecta fallas de lógica de negocio, como control de acceso roto, IDOR o un usuario que ve registros de otro, porque no hay un patrón sintáctico que las delate.
- **Análisis de flujo limitado.** Si el input viaja por varias funciones o archivos antes de llegar al sink, una regla por línea puede no verlo.
- **Configuración acotada.** En este laboratorio, `horusec-config.json` deshabilita a propósito los analizadores externos: no se analizaron dependencias (SCA), secretos ni infraestructura.
- **No ve el entorno de ejecución.** Headers HTTP, configuración del servidor, TLS real, permisos en la nube y secretos en variables de entorno quedan fuera del código fuente.
- **Falsos negativos.** Es fácil escribir código vulnerable que no matchee ninguna regla, por ejemplo invocando `eval` indirectamente o usando un parser XML que la regla no conoce.

"Sin alertas" significa "ninguna de las reglas activas encontró su patrón". **La ausencia de evidencia no es evidencia de ausencia.**

---

## 9. ¿Qué controles complementarían a SAST en un pipeline DevSecOps?

- **SCA (análisis de dependencias):** `npm audit`, Dependabot, OWASP Dependency-Check o Trivy, para detectar CVEs en paquetes de terceros.
- **Detección de secretos:** Gitleaks o TruffleHog en pre-commit y en CI.
- **DAST:** OWASP ZAP contra un entorno de staging, para detectar problemas que solo aparecen en ejecución (headers, CORS real, redirects, errores expuestos).
- **Escaneo de IaC y contenedores:** Checkov, tfsec o Trivy sobre Dockerfiles, Terraform y manifests.
- **Code review humano** con checklist de seguridad, especialmente para control de acceso y lógica de negocio.
- **Linters con reglas de seguridad:** `eslint-plugin-security` y el modo estricto de TypeScript.
- **Pruebas de seguridad automatizadas:** tests unitarios o de integración para casos de abuso (path traversal, redirect a dominio externo, etc.).
- **SBOM y firma de artefactos**, para trazabilidad de la cadena de suministro.
- **Controles en runtime:** CSP, WAF, logging y monitoreo.
- **Pentesting periódico y threat modeling** en la etapa de diseño.

---

## 10. Si Horusec se ejecutara en GitHub Actions, ¿qué severidades usarías como Quality Gate y por qué?

| Severidad | Acción en el pipeline | Justificación |
|---|---|---|
| **CRITICAL** | Bloquea el merge | Riesgo de RCE o bypass de TLS. No hay escenario aceptable para mergear sin resolver o justificar. |
| **HIGH** | Bloquea el merge | Incluye inyección, criptografía débil y exposición de datos. Los falsos positivos se resuelven marcándolos explícitamente (hash en `false_positive_hashes` del config) con justificación en el PR. |
| **MEDIUM** | Bloquea en `main` / release; advierte en ramas de feature | En este laboratorio, los MEDIUM incluían path traversal y XXE, que son graves. Bloquear en la rama principal evita que lleguen a producción sin frenar el desarrollo diario. |
| **LOW / INFO** | No bloquean, pero se reportan (SARIF a GitHub Code Scanning) y requieren triage | Como se vio en la pregunta 7, no se pueden ignorar: se revisan en el PR o en un triage periódico. |

Consideraciones adicionales:

- **El gate no debe depender solo de la severidad.** Tiene que ir acompañado de un proceso de triage: cada falso positivo se marca por su `ReferenceHash` con una justificación versionada en el repositorio, para que no se convierta en un "ignorar todo".
- **Adopción gradual.** Un gate muy estricto sobre código heredado genera fatiga y lleva a desactivarlo. Una estrategia común es bloquear solo los findings nuevos (diff contra la rama base) y trabajar la deuda existente por separado.
- **Evidencia auditable.** Publicar el SARIF como artefacto o en la pestaña Security de GitHub deja registro de cada ejecución.
