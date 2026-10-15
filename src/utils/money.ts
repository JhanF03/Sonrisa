/** "$ 119.000" (pesos colombianos, sin decimales). */
export const formatCop = (value: number): string => `$ ${Math.round(value).toLocaleString('es-CO')}`;
