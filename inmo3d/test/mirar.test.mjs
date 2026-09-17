// Medir la reconstrucción es lo que evita probar a ciegas: cada corrida cuesta horas, y "se ve
// mal" puede querer decir cosas opuestas. Si esta lectura se equivoca, el diagnóstico manda a
// arreglar lo que no era y se pierde otro día.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afuera, leerPly, mapa } from '../tools/mirar.mjs';

/** Un .ply de gaussians como los que escriben los entrenadores, con las columnas de siempre. */
function ply(puntos, propiedades = ['x', 'y', 'z', 'f_dc_0', 'opacity']) {
    const cabecera = `ply\nformat binary_little_endian 1.0\nelement vertex ${puntos.length}\n${
        propiedades.map(p => `property float ${p}`).join('\n')}\nend_header\n`;
    const datos = Buffer.alloc(puntos.length * propiedades.length * 4);
    puntos.forEach((p, i) => {
        propiedades.forEach((_, k) => datos.writeFloatLE(p[k] ?? 0, (i * propiedades.length + k) * 4));
    });
    return Buffer.concat([Buffer.from(cabecera, 'ascii'), datos]);
}

test('leer las posiciones de un .ply', async (t) => {
    await t.test('saca x, y, z salteando el resto de las columnas', () => {
        const { centers, n } = leerPly(ply([[1, 2, 3, 9, 9], [4, 5, 6, 9, 9]]));
        assert.equal(n, 2);
        assert.deepEqual([...centers], [1, 2, 3, 4, 5, 6]);
    });

    await t.test('no se casa con el orden de las columnas', () => {
        // Cada entrenador escribe las suyas en el orden que quiere. Si diéramos por hecho que
        // x, y, z van primero, con otro entrenador leeríamos colores como si fueran posiciones.
        const { centers } = leerPly(ply([[7, 8, 1, 2, 3]], ['opacity', 'f_dc_0', 'x', 'y', 'z']));
        assert.deepEqual([...centers], [1, 2, 3]);
    });

    await t.test('un archivo que no es lo que esperamos lo dice, no devuelve basura', () => {
        assert.throws(() => leerPly(Buffer.from('cualquier cosa')), /encabezado/);
        assert.throws(() => leerPly(Buffer.from('ply\nformat ascii 1.0\nend_header\n')), /binario/);
        assert.throws(() => leerPly(ply([[1, 2, 3]], ['f_dc_0', 'opacity', 'scale_0'])), /posiciones/);
    });
});

test('cuánta basura quedó afuera de la casa', () => {
    const caja = { min: [0, 0, 0], max: [10, 3, 8] };
    const dentro = [[1, 1, 1], [5, 2, 4], [9, 1, 7]];
    assert.equal(afuera(leerPly(ply(dentro)).centers, caja), 0);
    // Uno lejos de cuatro es el 25%, y alcanza con que se vaya por un solo eje.
    const conBasura = leerPly(ply([...dentro, [5, 40, 4]])).centers;
    assert.equal(afuera(conBasura, caja), 0.25);
});

test('el mapa muestra dónde está la masa', () => {
    // Todo apilado en una esquina: el mapa tiene que mostrarlo en una esquina y no repartido.
    const esquina = Array.from({ length: 500 }, () => [0.1, 1, 0.1]);
    const dibujo = mapa(leerPly(ply(esquina)).centers, { min: [0, 0, 0], max: [10, 3, 8] });
    const filas = dibujo.split('\n');
    assert.notEqual(filas[0][0], ' ', 'la esquina de arriba a la izquierda tiene que estar marcada');
    assert.equal(filas.at(-1).trim(), '', 'y el resto del mapa, vacío');
});
