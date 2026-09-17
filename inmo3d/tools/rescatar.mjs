#!/usr/bin/env node
// Rescata un 3D terminado que no se pudo subir.
//
// El entrenamiento son horas. La subida son segundos, pero puede fallar por cosas que no
// tienen nada que ver: se cortó internet, el almacenamiento se quedó sin cuota, venció la
// clave. El archivo terminado queda en el disco igual —el worker avisa dónde— pero encontrarlo
// a mano entre carpetas temporales no es tarea para nadie.
//
// Esto lo busca solo, agarra el más nuevo y lo carga como propiedad en la app local, que no
// depende de ningún servicio de afuera.
//
//   npm run rescatar              busca y carga el último 3D terminado
//   npm run rescatar -- --lista   sólo muestra qué encontró, sin tocar nada
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProperty, getProperty, putMedia, saveProperty, slug } from '../server/store.mjs';

/** Dónde deja el worker su material. Se miran los dos: el de ahora y el de las corridas viejas. */
export const donde = () => [
    process.env.INMO3D_TRABAJOS || path.join(os.homedir(), '.inmo3d', 'trabajos'),
    os.tmpdir()
];

/**
 * Busca modelos terminados debajo de una carpeta. No recorre el disco entero: sólo baja unos
 * pocos niveles, que es donde el worker los deja, y no sigue enlaces.
 * @param {string} raiz - Desde dónde buscar.
 * @param {number} [hondo] - Cuántos niveles bajar.
 * @returns {Promise<{archivo: string, bytes: number, cuando: Date}[]>} Lo encontrado.
 */
export async function buscar(raiz, hondo = 5) {
    if (hondo < 0) return [];
    const entradas = await fs.readdir(raiz, { withFileTypes: true }).catch(() => []);
    const salida = [];
    for (const e of entradas) {
        const completo = path.join(raiz, e.name);
        if (e.isDirectory()) {
            // En el temporal hay miles de carpetas ajenas: sólo entramos a las nuestras.
            if (raiz === os.tmpdir() && !e.name.startsWith('inmo3d-')) continue;
            salida.push(...await buscar(completo, hondo - 1));
        } else if (e.name === 'model.sog' || e.name === 'model.ply') {
            const st = await fs.stat(completo).catch(() => null);
            if (st?.size) salida.push({ archivo: completo, bytes: st.size, cuando: st.mtime });
        }
    }
    return salida;
}

/**
 * De todo lo encontrado, con cuál quedarse. El .sog es el formato que el visor carga liviano;
 * el .ply es el paso anterior y sirve igual, así que se acepta cuando no hay .sog. Entre
 * varios del mismo tipo, el más nuevo.
 * @param {{archivo: string, cuando: Date}[]} encontrados - Los candidatos.
 * @returns {{archivo: string, cuando: Date}|null} El elegido, o null.
 */
export function elegir(encontrados) {
    const nuevo = (a, b) => (b.cuando > a.cuando ? b : a);
    const sog = encontrados.filter(f => f.archivo.endsWith('.sog'));
    const lista = sog.length ? sog : encontrados;
    return lista.length ? lista.reduce(nuevo) : null;
}

/**
 * Saca el nombre de la propiedad de la ruta donde quedó el archivo. La carpeta del trabajo lo
 * lleva puesto, con un sello al final: al azar en las corridas viejas, la fecha del pedido en
 * las nuevas. Se parte por guiones en vez de con una expresión regular, que con nombres largos
 * puede quedarse pensando un rato largo.
 * @param {string} archivo - La ruta completa del modelo encontrado.
 * @returns {string} El nombre, listo para usar de título.
 */
export function tituloDesde(archivo) {
    const partes = archivo.split(path.sep);
    const carpeta = partes.find(t => t.startsWith('inmo3d-')) ??
        partes[partes.indexOf('trabajos') + 1] ?? '';
    const sin = carpeta.startsWith('inmo3d-') ? carpeta.slice('inmo3d-'.length) : carpeta;
    const trozos = sin.split('-').filter(Boolean);
    // El último trozo es el sello, no parte del nombre. Salvo que sea lo único que haya.
    if (trozos.length > 1) trozos.pop();
    return trozos.join(' ') || 'rescatada';
}

const mb = b => `${(b / 1e6).toFixed(1)} MB`;

async function principal() {
    const encontrados = (await Promise.all(donde().map(d => buscar(d)))).flat();
    if (!encontrados.length) {
        console.error('No encontré ningún 3D terminado. Si el entrenamiento sigue corriendo, esperá a\n' +
            'que el registro diga "SOG generado" y volvé a probar:  tail -f ~/Library/Logs/inmo3d-worker.log');
        process.exit(1);
    }

    console.log('Encontré:');
    for (const f of encontrados.sort((a, b) => b.cuando - a.cuando)) {
        console.log(`  ${f.cuando.toLocaleString('es-AR')}  ${mb(f.bytes).padStart(9)}  ${f.archivo}`);
    }
    if (process.argv.includes('--lista')) process.exit(0);

    const elegido = elegir(encontrados);
    const titulo = process.env.INMO3D_TITULO || tituloDesde(elegido.archivo);

    const id = slug(titulo, 'rescatada');
    const prop = await getProperty(id) ?? await createProperty({ title: titulo });
    const nombre = path.basename(elegido.archivo);
    const subido = await putMedia(prop.id, 'splat', nombre, await fs.readFile(elegido.archivo),
        'application/octet-stream');

    prop.scene = { ...prop.scene, splat: subido.key, splatUrl: subido.url };
    prop.job = { status: 'listo', step: 'listo', progress: 100, error: null };
    await saveProperty(prop);

    console.log(`\nRescatado: ${nombre} (${mb(elegido.bytes)}) -> propiedad "${prop.meta.title}"`);
    console.log('Prendé la app con  npm start  y abrilo en:');
    console.log(`  http://localhost:${process.env.PORT || 3113}/tour.html?id=${prop.id}`);
}

// Sólo actúa cuando se lo corre de verdad; importarlo desde un test no hace nada.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await principal();
}
