// Dónde está la casa de verdad.
//
// El bounding box que da el motor es exacto, y por eso mismo no sirve para encuadrar: toda
// reconstrucción deja basura suelta —pedazos de cielo, manchas de lo que se ve por la ventana,
// puntos perdidos a decenas de metros— y el box, para ser exacto, tiene que contenerla toda.
// En el departamento de ejemplo eso daba una caja de 65 unidades para una casa de 7: la cámara
// arrancaba a diez cuadras y se veía una mancha borrosa en el medio de la nada.
//
// Y no era sólo la cámara. De ese mismo número salían el piso (treinta unidades bajo tierra,
// así que caminar era imposible), la velocidad al caminar, el límite del zoom y el plano del
// panel. Un solo punto perdido rompía las cinco cosas a la vez.
//
// Así que el encuadre no sale de los extremos sino de dónde está la masa: se tira el 2% más
// lejano de cada punta y se arma la caja con el resto. La basura se sigue dibujando —sacarla
// es otro problema— pero deja de mandar en la cámara.
//
// Va aparte del visor y sin importar nada, que es lo que permite probarlo sin navegador.

/** Del 2% más lejano de cada punta para afuera, no cuenta. */
export const BASURA = 0.02;
/** Con esta muestra los percentiles ya no se mueven, y el costo no crece con la casa. */
export const MUESTRA = 120_000;

/**
 * Recibe las posiciones de los gaussians (x,y,z seguidos, como las entrega el motor) y
 * devuelve la caja donde está la casa, o null si no hay material suficiente para decidir.
 * @param {Float32Array|number[]|null} centers - Posiciones, de a tres por gaussian.
 * @returns {{min: number[], max: number[]}|null} La caja, o null.
 */
export function cajaRobusta(centers) {
    const n = centers ? Math.floor(centers.length / 3) : 0;
    if (n < 100) return null;
    // Con casas grandes se mira uno de cada tantos: el percentil da igual y el costo no sube.
    const paso = Math.max(1, Math.floor(n / MUESTRA));
    const largo = Math.ceil(n / paso);
    const ejes = [new Float64Array(largo), new Float64Array(largo), new Float64Array(largo)];
    let k = 0;
    for (let i = 0; i < n; i += paso) {
        const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
        // Una sola coordenada rota ensucia el percentil de su eje: se descarta el punto entero.
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        ejes[0][k] = x;
        ejes[1][k] = y;
        ejes[2][k] = z;
        k++;
    }
    if (k < 100) return null;
    const min = [], max = [];
    for (const eje of ejes) {
        // Las listas de números se ordenan por valor; las comunes lo harían alfabéticamente.
        const v = eje.subarray(0, k).sort();
        min.push(v[Math.floor(k * BASURA)]);
        max.push(v[Math.min(k - 1, Math.ceil(k * (1 - BASURA)))]);
    }
    // Una casa no puede tener lado cero: pasa con una pared plana escaneada de frente, y un
    // lado en cero deja el radio en cero y la cámara clavada adentro de la pared.
    for (let e = 0; e < 3; e++) {
        if (max[e] - min[e] < 1e-6) {
            min[e] -= 0.5;
            max[e] += 0.5;
        }
    }
    return { min, max };
}
