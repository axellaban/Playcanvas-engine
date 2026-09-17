// El encuadre es el core del visor: de este número salen la distancia de la cámara, la altura
// del piso, la velocidad al caminar, el límite del zoom y el plano del panel. Cuando se calculó
// mal, el departamento de ejemplo se veía como una mancha borrosa en el medio de la nada y
// caminar te dejaba treinta unidades bajo tierra. Un solo punto perdido rompía las cinco cosas,
// así que acá se prueba justamente que los puntos perdidos no manden.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cajaRobusta } from '../public/src/encuadre.mjs';

/** Una nube pareja dentro de la caja pedida, para no depender del azar. */
function nube(n, [x0, y0, z0], [x1, y1, z1]) {
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        // Tres pasos distintos: si los tres ejes avanzaran igual sería una diagonal, no un volumen.
        p[i * 3] = x0 + (x1 - x0) * t;
        p[i * 3 + 1] = y0 + (y1 - y0) * ((i * 7) % n) / (n - 1);
        p[i * 3 + 2] = z0 + (z1 - z0) * ((i * 13) % n) / (n - 1);
    }
    return p;
}

const lado = (c, e) => c.max[e] - c.min[e];

test('encuadre', async (t) => {
    await t.test('una casa limpia da su propia caja', () => {
        const c = cajaRobusta(nube(5000, [0, 0, 0], [10, 3, 8]));
        assert.ok(Math.abs(lado(c, 0) - 10) < 0.5, `ancho ${lado(c, 0)}`);
        assert.ok(Math.abs(lado(c, 1) - 3) < 0.3, `alto ${lado(c, 1)}`);
        assert.ok(Math.abs(lado(c, 2) - 8) < 0.5, `fondo ${lado(c, 2)}`);
    });

    await t.test('un puñado de basura lejana no agranda la casa', () => {
        // El caso real: casa de 10 unidades y treinta puntos perdidos a cuarenta de distancia.
        // Con el box exacto del motor el radio pasaba de 6 a 46 y la cámara se iba al descampado.
        const casa = nube(5000, [0, 0, 0], [10, 3, 8]);
        const todo = new Float32Array(casa.length + 30 * 3);
        todo.set(casa);
        for (let i = 0; i < 30; i++) {
            todo[casa.length + i * 3] = i % 2 ? 40 : -40;
            todo[casa.length + i * 3 + 1] = 35;
            todo[casa.length + i * 3 + 2] = -38;
        }
        const c = cajaRobusta(todo);
        assert.ok(lado(c, 0) < 12, `la basura estiró el ancho a ${lado(c, 0)}`);
        assert.ok(c.max[1] < 6, `la basura levantó el techo a ${c.max[1]}`);
        assert.ok(c.min[2] > -6, `la basura corrió el fondo a ${c.min[2]}`);
    });

    await t.test('una coordenada rota no ensucia su eje', () => {
        const casa = nube(5000, [0, 0, 0], [10, 3, 8]);
        casa[0] = NaN;
        casa[3 * 7 + 1] = Infinity;
        casa[3 * 9 + 2] = -Infinity;
        const c = cajaRobusta(casa);
        for (let e = 0; e < 3; e++) {
            assert.ok(Number.isFinite(c.min[e]) && Number.isFinite(c.max[e]),
                `el eje ${e} quedó en ${c.min[e]}..${c.max[e]}`);
        }
        assert.ok(lado(c, 1) < 4, 'un infinito no puede levantar el techo');
    });

    await t.test('sin material suficiente no inventa una caja', () => {
        // Devolver null es lo correcto: el visor cae a la caja del motor, que será fea pero
        // es real. Inventar una acá dejaría la cámara mirando un lugar donde no hay nada.
        assert.equal(cajaRobusta(null), null);
        assert.equal(cajaRobusta(new Float32Array(0)), null);
        assert.equal(cajaRobusta(nube(20, [0, 0, 0], [1, 1, 1])), null);
    });

    await t.test('una pared plana no deja un lado en cero', () => {
        // Escanear una pared de frente da espesor cero, y de un lado en cero sale radio cero:
        // la cámara queda clavada adentro de la pared sin poder alejarse.
        const c = cajaRobusta(nube(2000, [0, 0, 5], [10, 3, 5]));
        assert.ok(lado(c, 2) > 0, 'el lado plano tiene que recibir un espesor mínimo');
    });

    await t.test('una casa enorme no cuesta más que una chica', () => {
        // Se mira una muestra, no las cinco millones: el resultado es el mismo y el visor no
        // se queda dos segundos congelado justo cuando termina de cargar.
        const desde = Date.now();
        const c = cajaRobusta(nube(2_000_000, [0, 0, 0], [10, 3, 8]));
        assert.ok(Math.abs(lado(c, 0) - 10) < 0.5, `ancho ${lado(c, 0)}`);
        assert.ok(Date.now() - desde < 2000, 'tardó de más para lo que es');
    });
});
