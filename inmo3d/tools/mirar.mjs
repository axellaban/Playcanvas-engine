#!/usr/bin/env node
// Qué hay adentro de una reconstrucción.
//
// "Se ve cualquier cosa" no alcanza para arreglar nada, y mirar la pantalla tampoco: una nube
// de gaussians puede verse mal por razones opuestas —poca casa reconstruida, basura lejana que
// desencuadra, gaussians gigantes que tapan todo— y cada una se arregla distinto.
//
// Esto abre el archivo y lo mide: cuántos puntos hay, dónde está la casa de verdad, cuánta
// basura quedó suelta, y un mapa visto desde arriba. Con eso se decide qué tocar en vez de
// probar a ciegas ocho horas por intento.
//
//   npm run mirar                      el último .ply que haya dejado el worker
//   npm run mirar -- /ruta/model.ply   uno en particular
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cajaRobusta } from '../public/src/encuadre.mjs';
import { buscar, donde } from './rescatar.mjs';

/**
 * Lee las posiciones de un .ply de gaussians. Sólo saca x, y, z: el resto de las columnas se
 * saltean sin mirarlas, que es lo que permite abrir un archivo de cien megas sin cargarlo entero
 * en memoria como objetos.
 * @param {Buffer} buf - El archivo.
 * @returns {{centers: Float32Array, n: number, propiedades: string[]}} Las posiciones.
 */
export function leerPly(buf) {
    const fin = buf.indexOf('end_header\n');
    if (fin < 0) throw new Error('No parece un .ply: no encontré el encabezado.');
    const cabecera = buf.subarray(0, fin).toString('ascii');
    if (!/format binary_little_endian/.test(cabecera)) {
        throw new Error('Sólo leo .ply binario little endian, que es el que generan los entrenadores.');
    }
    const n = Number(cabecera.match(/element vertex (\d+)/)?.[1] ?? 0);
    const propiedades = [...cabecera.matchAll(/property float (\w+)/g)].map(m => m[1]);
    const i = { x: propiedades.indexOf('x'), y: propiedades.indexOf('y'), z: propiedades.indexOf('z') };
    if (i.x < 0 || i.y < 0 || i.z < 0) throw new Error('El .ply no trae las posiciones (x, y, z).');

    const ancho = propiedades.length * 4;
    const datos = buf.subarray(fin + 'end_header\n'.length);
    const centers = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
        const o = k * ancho;
        centers[k * 3] = datos.readFloatLE(o + i.x * 4);
        centers[k * 3 + 1] = datos.readFloatLE(o + i.y * 4);
        centers[k * 3 + 2] = datos.readFloatLE(o + i.z * 4);
    }
    return { centers, n, propiedades };
}

/**
 * Qué proporción de los puntos quedó afuera de donde está la casa. Mucha basura lejana no
 * arruina la escena —el visor ya la ignora para encuadrar— pero dice que la reconstrucción
 * tuvo problemas para decidir dónde estaban las cosas.
 * @param {Float32Array} centers - Las posiciones.
 * @param {{min: number[], max: number[]}} caja - Dónde está la casa.
 * @returns {number} La proporción, de 0 a 1.
 */
export function afuera(centers, caja) {
    const n = Math.floor(centers.length / 3);
    let fuera = 0;
    for (let k = 0; k < n; k++) {
        for (let e = 0; e < 3; e++) {
            const v = centers[k * 3 + e];
            if (v < caja.min[e] || v > caja.max[e]) {
                fuera++;
                break;
            }
        }
    }
    return n ? fuera / n : 0;
}

/**
 * Un mapa de la escena visto desde arriba, en caracteres. Si hay una casa, se ven las paredes
 * como líneas y los ambientes como huecos. Si es una sopa pareja, no hay casa.
 * @param {Float32Array} centers - Las posiciones.
 * @param {{min: number[], max: number[]}} caja - El recorte a dibujar.
 * @param {number} [ejeA] - Eje horizontal.
 * @param {number} [ejeB] - Eje vertical del dibujo.
 * @returns {string} El mapa.
 */
export function mapa(centers, caja, ejeA = 0, ejeB = 2) {
    const ANCHO = 68, ALTO = 24;
    const g = Array.from({ length: ALTO }, () => new Array(ANCHO).fill(0));
    const n = Math.floor(centers.length / 3);
    for (let k = 0; k < n; k++) {
        const u = (centers[k * 3 + ejeA] - caja.min[ejeA]) / (caja.max[ejeA] - caja.min[ejeA]);
        const v = (centers[k * 3 + ejeB] - caja.min[ejeB]) / (caja.max[ejeB] - caja.min[ejeB]);
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        g[Math.floor(v * ALTO)][Math.floor(u * ANCHO)]++;
    }
    const mx = Math.max(1, ...g.flat());
    const esc = ' .:-=+*#%@';
    return g.map(f => f.map(c => esc[Math.min(9, Math.round(Math.log10(1 + c) / Math.log10(1 + mx) * 9))]).join('')).join('\n');
}

async function principal() {
    let archivo = process.argv[2];
    if (!archivo) {
        const plys = (await Promise.all(donde().map(d => buscar(d)))).flat()
        .filter(f => f.archivo.endsWith('.ply') && f.bytes > 1e6);
        if (!plys.length) {
            console.error('No encontré ningún .ply. Pasame la ruta:  npm run mirar -- /ruta/model.ply');
            process.exit(1);
        }
        archivo = plys.reduce((a, b) => (b.cuando > a.cuando ? b : a)).archivo;
    }
    if (archivo.endsWith('.sog')) {
        console.error('Del .sog no puedo leer las posiciones sin el navegador. Pasame el model.ply,\n' +
            'que está en la misma carpeta y es el paso anterior.');
        process.exit(1);
    }

    console.log(`Mirando ${archivo}\n`);
    const { centers, n } = leerPly(await fs.readFile(archivo));
    const caja = cajaRobusta(centers);
    if (!caja) {
        console.error('El archivo tiene muy pocos puntos para decir nada.');
        process.exit(1);
    }
    const lado = e => caja.max[e] - caja.min[e];
    console.log(`Gaussians:       ${n.toLocaleString('es')}`);
    console.log(`La casa mide:    ${lado(0).toFixed(1)} x ${lado(2).toFixed(1)} de planta, ${lado(1).toFixed(1)} de alto`);
    console.log(`Basura afuera:   ${(afuera(centers, caja) * 100).toFixed(1)}% de los puntos`);
    console.log(`Densidad:        ${Math.round(n / (lado(0) * lado(2)))} gaussians por unidad cuadrada de planta`);
    console.log('\nVisto desde arriba (si hay casa, se ven las paredes):\n');
    console.log(mapa(centers, caja));
    console.log('\nDe costado:\n');
    console.log(mapa(centers, caja, 0, 1));
}

// Sólo actúa cuando se lo corre de verdad; importarlo desde un test no hace nada.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await principal();
}
