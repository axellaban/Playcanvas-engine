// Con qué dirección se llega a esta máquina desde otra de la misma red.
//
// Hace falta para el primer paso del producto: el video se graba con el celular, y el celular
// no entiende "localhost" —para él, localhost es él mismo—. Necesita la dirección de la Mac
// adentro de la wifi, y esa dirección la tiene que poder leer alguien, así que se imprime al
// arrancar en vez de hacer que la vaya a buscar a la configuración del sistema.
import os from 'node:os';

/**
 * Las direcciones de red con las que otro aparato de la misma wifi llega hasta acá.
 * @param {object} [interfaces] - Las placas de red; se las pasan los tests.
 * @returns {string[]} Las direcciones, sin las internas ni las IPv6.
 */
export const enLaRed = (interfaces = os.networkInterfaces()) => Object.values(interfaces)
.flat()
// Las internas son la propia máquina, y una IPv6 no se la tipea nadie a mano en un teléfono.
.filter(i => i && i.family === 'IPv4' && !i.internal)
.map(i => i.address);
