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

/** Una opción que ffmpeg no conoce: pasa con las que cambiaron de nombre entre versiones. */
export const opcionDesconocida = mensaje => /Unrecognized option|Option not found|Unknown option/i.test(mensaje || '');

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

/** Extrae en alta resolución sólo los cuadros elegidos. */
export async function extraer(video, indices, destino, { fps = 6, ancho = 1800 } = {}) {
    if (!indices.length) throw new Error('El video no dejó ningún cuadro utilizable.');
    const seleccion = indices.map(i => `eq(n\\,${i})`).join('+');
    const base = [
        '-hide_banner', '-loglevel', 'error', '-i', video,
        '-vf', `fps=${fps},select='${seleccion}',scale='min(${ancho},iw)':-2`
    ];
    const salida = ['-q:v', '2', `${destino}/cuadro-%04d.jpg`];

    // Sin esto ffmpeg rellena los huecos que deja `select` duplicando cuadros. La opción
    // cambió de nombre: `-vsync` en las versiones viejas, `-fps_mode` desde la 5.1, y las
    // nuevas ya ni reconocen la vieja. Probamos la actual y caemos a la anterior.
    try {
        await correr([...base, '-fps_mode', 'passthrough', ...salida], () => {});
    } catch (e) {
        if (!opcionDesconocida(e.salida)) throw e;
        await correr([...base, '-vsync', '0', ...salida], () => {});
    }
    return indices.length;
}

/** Todo junto: del video a una carpeta con las mejores fotos. */
export async function desdeVideo(video, destino, { objetivo = 80, fps = 6, alAvanzar } = {}) {
    alAvanzar?.('midiendo nitidez de los cuadros');
    const puntajes = await medir(video, fps);
    if (!puntajes.length) throw new Error('No pude leer el video. ¿Está completo?');
    const elegidos = elegir(puntajes, objetivo);
    alAvanzar?.(`${elegidos.length} cuadros elegidos de ${puntajes.length}`);
    await extraer(video, elegidos, destino, { fps });
    return { total: puntajes.length, elegidos: elegidos.length };
}
