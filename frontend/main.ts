/**
 * Punto de entrada del frontend: decide qué página mostrar según la URL.
 *   /c/:consultorio               → reserva pública
 *   /c/:consultorio/cita/:token   → gestión de cita del paciente
 *   /c/:consultorio/pago/:token   → resultado del pago con Wompi
 *   /plataforma                   → panel del dueño (página aparte: plataforma.html)
 *   /app (y cualquier otra)       → panel del consultorio
 */
import { startAdminApp } from './admin/shell.js';
import { renderBookingPage } from './public/booking.js';
import { renderManagePage } from './public/manage.js';
import { renderPaymentResultPage } from './public/paymentResult.js';
import { renderSubscriptionPaymentReturn } from './admin/subscription.js';

const root = document.getElementById('root') as HTMLElement;
const pathSegments = window.location.pathname.split('/').filter(Boolean).map(decodeURIComponent);

if (pathSegments[0] === 'c' && pathSegments[1] && pathSegments[2] === 'pago' && pathSegments[3]) {
  void renderPaymentResultPage(root, pathSegments[3]);
} else if (pathSegments[0] === 'c' && pathSegments[1] && pathSegments[2] === 'cita' && pathSegments[3]) {
  void renderManagePage(root, pathSegments[3]);
} else if (pathSegments[0] === 'c' && pathSegments[1]) {
  void renderBookingPage(root, pathSegments[1]);
} else if (pathSegments[0] === 'suscripcion' && pathSegments[1] === 'pago') {
  void renderSubscriptionPaymentReturn(root);
} else if (pathSegments[0] === 'plataforma') {
  // El panel del dueño es una aplicación aparte (plataforma.html).
  window.location.replace('/plataforma.html');
} else {
  void startAdminApp(root);
}
