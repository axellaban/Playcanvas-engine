// Reintentar lo que es barato reintentar.
//
// El worker ya tenía una regla para los reintentos: sólo vale la pena repetir lo que falló
// rápido, porque repetir algo que tardó horas son otras tantas horas para llegar al mismo
// lado. La regla es buena, pero mide lo que no es. No importa cuánto tardó el intento que
// falló: importa cuánto cuesta volver a intentarlo. Subir el archivo terminado tarda
// segundos aunque venga después de ocho horas de entrenamiento, y no reintentarlo tiraba
// esas ocho horas a la basura por un corte de internet de medio minuto.
//
// Acá va la otra mitad de la regla: lo que cuesta segundos se reintenta con paciencia,
// esperando entre una vez y la otra, porque una conexión caída no vuelve en el mismo
// segundo en que se fue. Tres intentos seguidos se consumen en un suspiro y no le dan
// tiempo a nada.

/** Una espera de verdad. Los tests le pasan otra, así no tardan lo que tardaría el worker. */
export const dormir = ms => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

/**
 * Un error que insistir no va a arreglar: el servidor entendió el pedido y lo rechazó. Un 404
 * es un archivo que no está y no va a aparecer solo; un 401, una clave mal puesta. Porfiar
 * con esos es hacer esperar al usuario veinte minutos para darle el mismo error de entrada.
 * El 408 y el 429 quedan afuera a propósito: esos no son "no", son "ahora no, probá después".
 */
export const definitivo = (e) => {
    const codigo = e?.status;
    return typeof codigo === 'number' && codigo >= 400 && codigo < 500 &&
        codigo !== 408 && codigo !== 429;
};

/** Cuánto esperar antes de cada reintento. La cantidad de esperas es la cantidad de reintentos. */
export const ESPERAS = [15_000, 60_000, 120_000, 300_000, 600_000];

/**
 * Corre `queHace` y, si falla, lo vuelve a intentar esperando cada vez un poco más. Devuelve
 * lo que haya devuelto; si se agotan los reintentos, tira el último error que dio.
 */
export async function porfiar(queHace, { esperas = ESPERAS, avisar, esperar = dormir } = {}) {
    for (let intento = 0; ; intento++) {
        try {
            return await queHace();
        } catch (e) {
            if (intento >= esperas.length || definitivo(e)) throw e;
            avisar?.(e, esperas[intento], intento + 1);
            await esperar(esperas[intento]);
        }
    }
}
