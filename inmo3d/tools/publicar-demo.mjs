#!/usr/bin/env node
// Deja la casa de ejemplo como archivo fijo dentro de public/, para que el botón "Ver un
// ejemplo" no dependa de nada: ni de una reconstrucción, ni del almacenamiento, ni de tener
// sesión iniciada. Se corre cuando cambia la casa, y lo que genera se sube al repositorio.
//
//   npm run demo:publicar
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { construirCasa } from './casa-demo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESTINO = path.join(ROOT, 'public', 'ejemplo');

// Con esta densidad la casa entra en unos pocos MB. Es lo que se le puede mandar por el
// teléfono a alguien que está parado en la puerta de un departamento con señal de 4G.
const casa = construirCasa({ densidad: 0.3 });

await fs.mkdir(DESTINO, { recursive: true });
await fs.writeFile(path.join(DESTINO, 'casa.ply'), casa.ply);

// La ficha tiene la forma de una propiedad de verdad: así el tour la abre sin saber que es
// un ejemplo, y no hay dos caminos distintos que puedan desincronizarse.
const ficha = {
    id: 'ejemplo',
    meta: {
        title: 'Casa del Parque',
        address: 'Av. del Libertador 3200',
        city: 'CABA',
        operation: 'venta',
        type: 'departamento',
        price: 289000,
        currency: 'USD',
        bedrooms: 2,
        bathrooms: 1,
        areaCovered: 80,
        areaTotal: 120,
        language: 'es',
        notes: ''
    },
    photos: [],
    video: null,
    scene: { ...casa.escena, splat: 'ejemplo/casa.ply', splatUrl: '/ejemplo/casa.ply' },
    tour: casa.tour,
    hotspots: casa.hotspots,
    measures: [],
    ai: { audit: null, listing: null, rooms: null, staged: [] },
    job: { status: 'listo', step: 'listo', progress: 100 }
};
await fs.writeFile(path.join(DESTINO, 'casa.json'), `${JSON.stringify(ficha, null, 2)}\n`);

console.log(`Casa de ejemplo: ${casa.puntos.toLocaleString('es')} gaussians, ` +
    `${(casa.ply.length / 1e6).toFixed(1)} MB -> public/ejemplo/casa.ply`);
