-- Migración 0010: ícono de la pestaña del navegador por consultorio (opcional).
-- Se guarda como imagen PNG de 64×64 px en formato data URL (unos pocos KB):
-- el navegador del consultorio la recorta y redimensiona antes de enviarla,
-- y el servidor verifica que sea un PNG válido y pequeño.
ALTER TABLE tenants ADD COLUMN favicon TEXT;
