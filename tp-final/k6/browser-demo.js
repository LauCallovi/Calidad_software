import { browser } from 'k6/browser';

// Demo VISIBLE para las capturas de consola y red (guía, paso 5.1).
// Abre un Chrome con perfil limpio, le pone la cookie canary=always ANTES de
// la primera visita y deja la ventana abierta para inspeccionarla.
//
// Por qué no hacerlo a mano en Firefox: el Ingress usa afinidad "sticky" y la
// primera visita (sin la cookie) deja la cookie de afinidad de la stable, que
// le gana a canary=always. Acá el contexto arranca sin cookies.
//
// Uso (desde tp-final/):
//   K6_BROWSER_HEADLESS=false K6_BROWSER_ARGS='auto-open-devtools-for-tabs' \
//     k6 run k6/browser-demo.js
// Variables: ESPERA_S (default 180), FORZAR_CANARY (default 1).
export const options = {
  scenarios: {
    demo: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '15m',
      options: { browser: { type: 'chromium' } },
    },
  },
};

const FRONT = __ENV.FRONT_URL || 'http://terrasense.local';
const ESPERA_S = Number(__ENV.ESPERA_S || 180);
const FORZAR = (__ENV.FORZAR_CANARY || '1') === '1';

export default async function () {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (FORZAR) {
    await context.addCookies([{ name: 'canary', value: 'always', url: FRONT }]);
  }
  const page = await context.newPage();
  try {
    await page.goto(FRONT, { waitUntil: 'load' });
    console.log(`Página abierta (cookie canary=${FORZAR ? 'always' : 'no'}). La ventana queda abierta ${ESPERA_S} s.`);
    console.log('Si DevTools no está abierto: F12. Para ver la Red con datos, recargar con F5 con la pestaña Red abierta.');
    await page.waitForTimeout(ESPERA_S * 1000);
  } finally {
    await page.close();
    await context.close();
  }
}
