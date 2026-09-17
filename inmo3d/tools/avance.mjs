// Cuánto falta, de verdad.
//
// El entrenamiento son horas y la barra se quedaba clavada en 60% todo ese tiempo. Desde
// afuera es idéntico a que se haya colgado: no hay forma de distinguir "faltan tres horas" de
// "esto se murió y nadie avisó". Estar a ciegas media jornada es un problema del producto, no
// un detalle.
//
// El entrenador va contando sus pasos en la salida. Con eso y con cuánto tardó hasta acá sale
// el porcentaje y cuánto falta. Y cuando no dice nada —hay entrenadores callados— por lo menos
// se muestra hace cuánto viene trabajando, que ya distingue lo vivo de lo muerto.

/**
 * Busca en la salida del entrenador cuántos pasos lleva hechos.
 *
 * Se queda con la última aparición, que es la más reciente. Primero busca el par "1234/15000",
 * que es el más confiable porque trae los dos números; si no, un número suelto detrás de la
 * palabra paso, y ahí el total lo tiene que poner quien llama.
 * @param {string} texto - Lo que escribió el entrenador.
 * @param {number} [total] - Cuántos pasos se le pidieron, para cuando la salida no lo diga.
 * @returns {{hechos: number, total: number}|null} Lo leído, o null si no había nada.
 */
export function leerAvance(texto, total) {
    const numero = t => Number(String(t).replace(/[.,\s]/g, ''));
    // Los bordes son para no confundirse con una ruta: en /var/folders/ds/3lh... hay dígitos
    // alrededor de una barra y no son el avance de nada.
    const par = [...String(texto).matchAll(/(?<![\w/.])(\d[\d.,]*)\s*\/\s*(\d[\d.,]*)(?![\w/.])/g)].pop();
    if (par) {
        const hechos = numero(par[1]), suTotal = numero(par[2]);
        if (suTotal > 0 && hechos >= 0 && hechos <= suTotal) return { hechos, total: suTotal };
    }
    const suelto = [...String(texto).matchAll(/(?:step|iter|iteration|paso)\w*\W{0,3}(\d[\d.,]*)/gi)].pop();
    if (suelto && total > 0) {
        const hechos = numero(suelto[1]);
        if (hechos >= 0 && hechos <= total) return { hechos, total };
    }
    return null;
}

/**
 * Con cuánto lleva hecho y cuánto tardó, cuánto falta. Se asume que el resto va a ir al mismo
 * ritmo que lo que ya pasó, que para un entrenamiento es una suposición razonable.
 * @param {number} hechos - Pasos hechos.
 * @param {number} total - Pasos en total.
 * @param {number} transcurrido - Milisegundos desde que empezó esta etapa.
 * @returns {{fraccion: number, falta: number}|null} Cuánto va y cuánto falta, o null.
 */
export function estimar(hechos, total, transcurrido) {
    if (!(total > 0) || !(hechos > 0) || !(transcurrido > 0)) return null;
    const fraccion = Math.min(1, hechos / total);
    return { fraccion, falta: Math.max(0, transcurrido / fraccion - transcurrido) };
}

/**
 * Un rato, dicho como lo diría una persona. Nunca en segundos cuando son horas, ni "0 h 4 min".
 * @param {number} ms - Milisegundos.
 * @returns {string} El rato, en castellano.
 */
export function duracion(ms) {
    const minutos = Math.round(ms / 60000);
    if (minutos < 1) return 'menos de un minuto';
    if (minutos < 60) return `${minutos} min`;
    const horas = Math.floor(minutos / 60), resto = minutos % 60;
    return resto ? `${horas} h ${resto} min` : `${horas} h`;
}

/**
 * El texto que ve quien está esperando, y el número para la barra.
 * @param {object} d - Datos.
 * @param {string} d.etapa - En qué anda.
 * @param {number} d.transcurrido - Hace cuánto está en esa etapa, en milisegundos.
 * @param {{hechos: number, total: number}|null} [d.leido] - Lo que dijo el entrenador.
 * @param {number} d.desde - Con cuánto por ciento arranca esta etapa.
 * @param {number} d.hasta - Con cuánto termina.
 * @returns {{step: string, progress: number}} Qué mostrar.
 */
export function comoVa({ etapa, transcurrido, leido, desde, hasta }) {
    const est = leido && estimar(leido.hechos, leido.total, transcurrido);
    if (!est) return { step: `${etapa} · ${duracion(transcurrido)}`, progress: desde };
    return {
        step: `${etapa} ${Math.round(est.fraccion * 100)}% · faltan ${duracion(est.falta)}`,
        progress: Math.round(desde + (hasta - desde) * est.fraccion)
    };
}
