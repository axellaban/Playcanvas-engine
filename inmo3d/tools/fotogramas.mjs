// De video a fotos para reconstruir.
//
// Un video es mucho más cómodo de grabar que 50 fotos, pero trae un problema que las
// fotos no tienen: la mitad de los cuadros están movidos. Un cuadro borroso no sólo no
// aporta, ensucia la reconstrucción. Así que no alcanza con extraer cuadros cada tanto:
// hay que elegir los nítidos.
//
// Eso se mide, no se opina: la varianza del laplaciano sube con el detalle y se desploma
// con el movimiento. Se calcula sobre una versión chiquita en gris, que es barato y da
// igual de bien. Después se extrae en alta sólo lo elegido.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ANCHO = 160;
const ALTO = 120;

/** Varianza del laplaciano: cuánto detalle real tiene el cuadro. */
export function nitidez(gris, ancho = ANCHO, alto = ALTO) {
    let suma = 0;
    let sumaCuadrados = 0;
    let n = 0;
    for (let y = 1; y < alto - 1; y++) {
        for (let x = 1; x < ancho - 1; x++) {
            const i = y * ancho + x;
            const lap = 4 * gris[i] - gris[i - 1] - gris[i + 1] - gris[i - ancho] - gris[i + ancho];
            suma += lap;
            sumaCuadrados += lap * lap;
            n++;
        }
    }
    const media = suma / n;
    return sumaCuadrados / n - media * media;
}

/**
 * Elige los cuadros a conservar: el más nítido de cada ventana, y descarta los que
 * están muy por debajo del resto (esos son movimiento, no ambiente).
 */
export function elegir(puntajes, objetivo = 80) {
    if (!puntajes.length) return [];
    const ventana = Math.max(1, Math.floor(puntajes.length / objetivo));
    const elegidos = [];
    for (let inicio = 0; inicio < puntajes.length; inicio += ventana) {
        let mejor = inicio;
        for (let i = inicio + 1; i < Math.min(inicio + ventana, puntajes.length); i++) {
            if (puntajes[i] > puntajes[mejor]) mejor = i;
        }
        elegidos.push(mejor);
    }
    // Un cuadro que no llega ni a un tercio de la nitidez típica está movido: afuera.
    const ordenados = [...elegidos.map(i => puntajes[i])].sort((a, b) => a - b);
    const mediana = ordenados[Math.floor(ordenados.length / 2)] || 0;
    const piso = mediana / 3;
    const limpios = elegidos.filter(i => puntajes[i] >= piso);
    // Salvo que el video entero sea malo: ahí es mejor devolver algo que nada.
    return limpios.length >= Math.min(20, elegidos.length) ? limpios : elegidos;
}

/**
 * Cuántos cuadros sacarle a este video. Lo que rompe una reconstrucción no es que un cuadro
 * salga mediocre: es el salto entre uno y el siguiente. Si la cámara se movió de más entre
 * los dos no comparten nada, la cadena se corta ahí y todo lo que venía después queda suelto.
 * Por eso el número sale de cuánto dura el video y no de una cifra fija: apuntamos a unos dos
 * y medio por segundo, que aguanta que se camine rápido. El techo es porque comparar tomas
 * entre sí crece al cuadrado; el piso, porque con menos no hay reconstrucción que valga.
 */
export function cuantosCuadros(muestras, fps = 6) {
    return Math.max(60, Math.min(200, Math.round(muestras / fps * 2.5)));
}

const correr = (args, alSalir) => new Promise((resolve, reject) => {
    const hijo = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    hijo.stderr.on('data', b => (error += b.toString().slice(-2000)));
    hijo.stdout.on('data', alSalir);
    hijo.on('error', e => reject(new Error(e.code === 'ENOENT' ?
        'Falta ffmpeg. En Mac: brew install ffmpeg' : e.message)));
    hijo.on('close', code => (code === 0 ? resolve() :
        reject(Object.assign(new Error(`ffmpeg falló: ${error.slice(-500)}`), { salida: error }))));
});

/** Mide la nitidez de todos los cuadros del video, a `fps` por segundo. */
export async function medir(video, fps = 6) {
    const tamano = ANCHO * ALTO;
    let resto = Buffer.alloc(0);
    const puntajes = [];
    await correr([
        '-hide_banner', '-loglevel', 'error', '-i', video,
        '-vf', `fps=${fps},scale=${ANCHO}:${ALTO}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'
    ], (trozo) => {
        resto = resto.length ? Buffer.concat([resto, trozo]) : trozo;
        while (resto.length >= tamano) {
            puntajes.push(nitidez(resto.subarray(0, tamano)));
            resto = resto.subarray(tamano);
        }
    });
    return puntajes;
}

/**
 * Los argumentos para sacar los cuadros. Lo importante es que son fijos: no crecen ni un
 * carácter con la cantidad de cuadros que queramos.
 */
export const argumentosExtraer = (video, destino, { fps = 6, ancho = 1800 } = {}) => [
    '-hide_banner', '-loglevel', 'error', '-i', video,
    '-vf', `fps=${fps},scale='min(${ancho},iw)':-2`,
    '-q:v', '2', `${destino}/cuadro-%04d.jpg`
];

/** Borra los cuadros que no quedaron elegidos. Devuelve cuántos sobrevivieron. */
export async function depurar(destino, indices) {
    const queremos = new Set(indices);
    let quedan = 0;
    for (const archivo of await fs.readdir(destino)) {
        const m = /^cuadro-(\d+)\.jpg$/.exec(archivo);
        if (!m) continue;
        // ffmpeg numera desde 1; la nitidez se midió desde 0.
        if (queremos.has(Number(m[1]) - 1)) quedan++;
        else await fs.unlink(path.join(destino, archivo));
    }
    return quedan;
}

/** Extrae en alta resolución y se queda sólo con los cuadros elegidos. */
export async function extraer(video, indices, destino, opciones = {}) {
    if (!indices.length) throw new Error('El video no dejó ningún cuadro utilizable.');
    // Sacamos todos y después borramos. Pedirle a ffmpeg nada más que los elegidos parece más
    // prolijo, pero esa lista lleva un término por cuadro: con noventa entraba y con ciento
    // cincuenta el filtro se volvía tan largo que ffmpeg no lo podía ni construir, y el trabajo
    // moría recién después de haber medido el video entero. Sobran unos segundos de escritura.
    await correr(argumentosExtraer(video, destino, opciones), () => {});
    return depurar(destino, indices);
}

/** Todo junto: del video a una carpeta con las mejores fotos. */
export async function desdeVideo(video, destino, { objetivo, fps = 6, alAvanzar } = {}) {
    alAvanzar?.('midiendo nitidez de los cuadros');
    const puntajes = await medir(video, fps);
    if (!puntajes.length) throw new Error('No pude leer el video. ¿Está completo?');
    const elegidos = elegir(puntajes, objetivo ?? cuantosCuadros(puntajes.length, fps));
    alAvanzar?.(`${elegidos.length} cuadros elegidos de ${puntajes.length}`);
    const quedaron = await extraer(video, elegidos, destino, { fps });
    return { total: puntajes.length, elegidos: quedaron };
}
