// La casa de ejemplo, hecha a mano.
//
// El ejemplo que se le muestra a un cliente no puede depender de una reconstrucción: el
// archivo que había antes era un escaneo fallido —una nube de ruido sin paredes ni piso— y se
// veía como una mancha borrosa. Y tampoco puede depender del almacenamiento: justo el día que
// el store se suspendió, el botón "Ver un ejemplo" dejó de andar, que es exactamente cuando
// más lo necesitás.
//
// Así que la casa se dibuja acá, en código: 10 x 8 metros con cocina, estar, comedor y
// dormitorio. Siempre se ve igual, siempre entra, no depende de nada. Además sirve de prueba
// de que el visor anda: si esta casa se ve mal, el problema es del visor y no del escaneo.
//
// Este módulo no toca disco ni red: devuelve los bytes y quien llama decide qué hacer.

const SH_C0 = 0.28209479177387814;
const logit = a => Math.log(a / (1 - a));
const rnd = (a = 1) => (Math.random() * 2 - 1) * a;

/**
 * Arma la casa y devuelve el .ply listo para escribir, con las paradas del recorrido.
 * @param {object} [opciones] - Ajustes.
 * @param {number} [opciones.densidad] - Cuántos gaussians por metro cuadrado, como factor.
 * @returns {{ply: Buffer, puntos: number, tour: object[], hotspots: object[], escena: object}} La casa.
 */
export function construirCasa({ densidad = 1 } = {}) {
    // Medidas del ambiente. Van arriba porque las usa el cálculo de luz.
    const W = 10, D = 8, H = 2.7;                      // 10 x 8 m, 2.70 m de altura

    /**
     * Cuánta luz recibe un punto. Sin esto la casa son cajas de color plano, todas igual de
     * iluminadas, y el ojo no lee volumen: no distingue dónde termina una pared y empieza el piso.
     *
     * No hay que simular la física: alcanza con dos cosas que el ojo reconoce solo. Los rincones
     * están más oscuros, porque ahí la luz rebota menos; y cerca de la ventana está más claro y
     * más cálido. Se calcula sobre la posición del punto y se aplica a su color, así que no cuesta
     * ni un byte más en el archivo.
     * @param {number[]} p - Dónde está el punto.
     * @returns {number} Por cuánto multiplicar su color.
     */
    function luz(p) {
    // Qué tan adentro del cuarto está, mirando cada par de paredes opuestas.
        const d = [Math.min(p[0], W - p[0]), Math.min(p[1], H - p[1]), Math.min(p[2], D - p[2])]
        .sort((a, b) => a - b);
        // El punto está apoyado sobre alguna superficie, así que el primero siempre da casi cero.
        // El que importa es el segundo: dice si además está pegado a otra, o sea, en un rincón.
        const rincon = 0.62 + 0.38 * Math.min(1, d[1] / 0.9);
        // La ventana del fondo: ilumina lo que tiene cerca, y con caída suave.
        const aLaVentana = Math.hypot(p[0] - 4.4, p[1] - 1.7, p[2] - D);
        return rincon * (1 + 0.30 / (1 + (aLaVentana / 2.6) ** 2));
    }

    const pts = [];
    /**
     * Siembra una superficie rectangular de gaussians con un poco de ruido de color y de posición.
     * @param root0
     * @param root0.origin
     * @param root0.u
     * @param root0.v
     * @param root0.density
     * @param root0.color
     * @param root0.rough
     * @param root0.scale
     * @param root0.holes
     */
    function surface({ origin, u, v, density = 620, color, rough = 0.010, scale = 0.026, holes = [], veta }) {
        // El eje contra el que hay que aplastar es el que ni u ni v recorren: la normal.
        const plano = [0, 1, 2].find(k => Math.abs(u[k]) < 1e-9 && Math.abs(v[k]) < 1e-9) ?? -1;
        const area = Math.hypot(...u) * Math.hypot(...v);
        const n = Math.max(1, Math.round(area * density * densidad));
        for (let i = 0; i < n; i++) {
            const a = Math.random(), b = Math.random();
            if (holes.some(hh => a > hh[0] && a < hh[1] && b > hh[2] && b < hh[3])) continue;
            const p = [0, 1, 2].map(k => origin[k] + u[k] * a + v[k] * b + rnd(rough));
            const shade = (1 + rnd(0.09)) * luz(p) * (veta ? veta(p) : 1);
            // Con menos gaussians hay que hacerlos más grandes o la pared queda con agujeros:
            // al bajar la densidad a la mitad, la distancia entre uno y otro crece por raíz.
            // Se solapan a propósito: un disco que apenas toca al de al lado deja ver el fondo
            // entre medio y la pared queda con puntitos negros. Al ser planos, agrandarlos no
            // los vuelve una nube, sólo tapa las juntas.
            const ancho = scale / Math.sqrt(densidad) * 1.7 * (1 + rnd(0.25));
            pts.push({
                p,
                c: color.map(c => Math.min(1, Math.max(0, c * shade))),
                // Aplastados contra su propia superficie, no bolitas. Una pared hecha de esferas
                // se ve como una nube; hecha de discos pegados a la pared se ve como una pared.
                // Sale gratis: ocupa exactamente lo mismo y se ve mucho más nítido.
                s: [0, 1, 2].map(k => (k === plano ? ancho * 0.16 : ancho))
            });
        }
    }

    /**
     * Caja maciza: seis caras. Con esto armamos muebles y mesadas.
     * @param min
     * @param size
     * @param color
     * @param density
     */
    function box(min, size, color, density = 700) {
        const [w, hgt, d] = size;
        const faces = [
            [[0, hgt, 0], [w, 0, 0], [0, 0, d]],      // arriba
            [[0, 0, 0], [w, 0, 0], [0, 0, d]],        // abajo
            [[0, 0, 0], [w, 0, 0], [0, hgt, 0]],      // frente
            [[0, 0, d], [w, 0, 0], [0, hgt, 0]],      // fondo
            [[0, 0, 0], [0, 0, d], [0, hgt, 0]],      // izquierda
            [[w, 0, 0], [0, 0, d], [0, hgt, 0]]       // derecha
        ];
        for (const [o, u, v] of faces) {
            surface({ origin: [min[0] + o[0], min[1] + o[1], min[2] + o[2]], u, v, color, density });
        }
    }

    // ----------------------------------------------------------------- la casa
    const piso = [0.62, 0.45, 0.30];
    const pared = [0.88, 0.87, 0.84];
    const techo = [0.95, 0.95, 0.94];

    // El piso lleva vetas: una tabla cada 18 cm, con la junta más oscura. Es lo que hace que
    // se lea "madera" y no "una mancha marrón".
    surface({ origin: [0, 0, 0],
        u: [W, 0, 0],
        v: [0, 0, D],
        color: piso,
        density: 700,
        scale: 0.028,
        veta: q => (Math.abs((q[2] / 0.18) % 1 - 0.5) > 0.42 ? 0.72 : 1 + rnd(0.05)) });
    surface({ origin: [0, H, 0], u: [W, 0, 0], v: [0, 0, D], color: techo, density: 480 });

    // Paredes perimetrales. Los "holes" son la puerta y las ventanas (fracción u,v de cada pared).
    surface({ origin: [0, 0, 0], u: [W, 0, 0], v: [0, H, 0], color: pared, holes: [[0.05, 0.16, 0, 0.78]] });
    surface({ origin: [0, 0, D], u: [W, 0, 0], v: [0, H, 0], color: pared, holes: [[0.30, 0.62, 0.30, 0.85]] });
    surface({ origin: [0, 0, 0], u: [0, 0, D], v: [0, H, 0], color: pared, holes: [[0.55, 0.9, 0.3, 0.85]] });
    surface({ origin: [W, 0, 0], u: [0, 0, D], v: [0, H, 0], color: pared, holes: [[0.15, 0.45, 0.32, 0.8]] });

    // Pared interior: separa el estar del dormitorio, con su puerta.
    surface({ origin: [6.2, 0, 0], u: [0, 0, D], v: [0, H, 0], color: pared, holes: [[0.62, 0.74, 0, 0.78]] });

    // Cocina: mesada en L y alacena.
    box([0.35, 0, 0.35], [0.65, 0.92, 3.0], [0.30, 0.32, 0.36]);
    box([0.35, 0.92, 0.35], [0.68, 0.05, 3.05], [0.12, 0.12, 0.14], 600);
    box([0.35, 1.65, 0.35], [0.38, 0.75, 1.9], [0.86, 0.85, 0.82]);

    // Estar: sofá, mesa ratona y alfombra.
    box([2.2, 0, 5.4], [2.3, 0.42, 0.95], [0.28, 0.34, 0.42]);
    box([2.2, 0.42, 6.15], [2.3, 0.45, 0.22], [0.24, 0.30, 0.38]);
    box([2.7, 0, 4.0], [1.2, 0.42, 0.6], [0.45, 0.30, 0.18]);
    surface({ origin: [2.0, 0.006, 3.6], u: [2.8, 0, 0], v: [0, 0, 2.9], color: [0.55, 0.20, 0.18], density: 800, rough: 0.003 });

    // Comedor: mesa y cuatro sillas.
    box([3.9, 0.7, 1.0], [1.7, 0.07, 0.95], [0.52, 0.34, 0.20], 600);
    for (const [x, z] of [[4.0, 0.55], [5.1, 0.55], [4.0, 2.05], [5.1, 2.05]]) {
        box([x, 0, z], [0.45, 0.45, 0.45], [0.40, 0.26, 0.16]);
        box([x, 0.45, z], [0.45, 0.45, 0.06], [0.40, 0.26, 0.16]);
    }

    // Dormitorio: cama, respaldo y mesa de luz.
    box([7.0, 0.1, 2.2], [1.6, 0.45, 2.0], [0.90, 0.89, 0.86]);
    box([7.0, 0, 2.2], [1.6, 0.12, 2.0], [0.35, 0.25, 0.18]);
    box([6.85, 0.1, 2.2], [0.12, 0.95, 2.0], [0.42, 0.28, 0.18]);
    box([7.1, 0, 4.4], [0.45, 0.5, 0.45], [0.45, 0.30, 0.18]);

    // Luz que entra por la ventana del fondo: una mancha cálida sobre el piso.
    surface({ origin: [3.2, 0.004, 6.4], u: [2.2, 0, 0], v: [0, 0, 1.2], color: [1, 0.93, 0.72], density: 420, rough: 0.04, scale: 0.06 });

    // ----------------------------------------------------------------- escritura del .ply
    const header = `ply
format binary_little_endian 1.0
element vertex ${pts.length}
property float x
property float y
property float z
property float f_dc_0
property float f_dc_1
property float f_dc_2
property float opacity
property float scale_0
property float scale_1
property float scale_2
property float rot_0
property float rot_1
property float rot_2
property float rot_3
end_header
`;
    const buf = Buffer.alloc(pts.length * 14 * 4);
    pts.forEach((pt, i) => {
        const o = i * 14 * 4;
        // Y hacia arriba, que es como trabaja el motor. Los escaneos reales suelen venir
        // con otra orientación: para eso está el enderezado del visor (yaw/pitch/roll).
        pt.p.forEach((v, k) => buf.writeFloatLE(v, o + k * 4));
        pt.c.forEach((c, k) => buf.writeFloatLE((c - 0.5) / SH_C0, o + (3 + k) * 4));
        buf.writeFloatLE(logit(0.96), o + 6 * 4);
        for (let k = 0; k < 3; k++) buf.writeFloatLE(Math.log(pt.s[k]), o + (7 + k) * 4);
        [1, 0, 0, 0].forEach((q, k) => buf.writeFloatLE(q, o + (10 + k) * 4));
    });


    return { ply: Buffer.concat([Buffer.from(header, 'ascii'), buf]),
        puntos: pts.length,
        escena: { floorY: 0.02, eyeHeight: 1.62, metersPerUnit: 1, yaw: 0, pitch: 0, roll: 0, scale: 1 },
        ...(() => {
            const tour = [
                { id: 'wp0',
                    name: 'Entrada',
                    desc: 'Se entra directo al estar-comedor: 10 x 8 m sin columnas en el medio.',
                    pos: [1.2, 1.62, 1.2],
                    look: [5, 1.5, 4.5] },
                { id: 'wp1',
                    name: 'Cocina',
                    desc: 'Mesada en L de 3 metros con alacena. Da al comedor sin muro de por medio.',
                    pos: [2.3, 1.62, 2.0],
                    look: [0.6, 1.3, 1.9] },
                { id: 'wp2',
                    name: 'Estar',
                    desc: 'El ventanal del fondo entra con sol de tarde sobre la alfombra.',
                    pos: [4.6, 1.62, 4.6],
                    look: [3.2, 1.4, 6.6] },
                { id: 'wp3',
                    name: 'Dormitorio',
                    desc: 'Dormitorio principal con ventana al lateral y placard a estrenar.',
                    pos: [7.8, 1.62, 4.6],
                    look: [7.8, 1.4, 2.4] }
            ];
            const hotspots = [
                { id: 'hs0', title: 'Ventanal 3,2 m', body: 'DVH con perfilería de aluminio, orientación noroeste.', pos: [4.4, 1.6, 7.9] },
                { id: 'hs1', title: 'Mesada de granito', body: 'Bajo mesada con horno incluido en la operación.', pos: [0.7, 1.1, 1.9] }
            ];
            return { tour, hotspots };
        })() };
}
