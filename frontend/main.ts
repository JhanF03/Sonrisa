/**
 * Punto de entrada del frontend: decide qué página mostrar según la URL.
 *   /c/:consultorio               → reserva pública
 *   /c/:consultorio/cita/:token   → gestión de cita del paciente
 *   /c/:consultorio/pago/:token   → resultado del pago con Wompi
 *   /plataforma                   → modo vitrina (proveedor)
 *   /app (y cualquier otra)       → panel del consultorio
 */
import { startAdminApp } from './admin/shell.js';
import { renderBookingPage } from './public/booking.js';
import { renderManagePage } from './public/manage.js';
import { renderPaymentResultPage } from './public/paymentResult.js';
import { renderPlatformPage } from './public/platform.js';

const root = document.getElementById('root') as HTMLElement;
const pathSegments = window.location.pathname.split('/').filter(Boolean).map(decodeURIComponent);

if (pathSegments[0] === 'c' && pathSegments[1] && pathSegments[2] === 'pago' && pathSegments[3]) {
  void renderPaymentResultPage(root, pathSegments[3]);
} else if (pathSegments[0] === 'c' && pathSegments[1] && pathSegments[2] === 'cita' && pathSegments[3]) {
  void renderManagePage(root, pathSegments[3]);
} else if (pathSegments[0] === 'c' && pathSegments[1]) {
  void renderBookingPage(root, pathSegments[1]);
} else if (pathSegments[0] === 'plataforma') {
  renderPlatformPage(root);
} else {
  void startAdminApp(root);
}
