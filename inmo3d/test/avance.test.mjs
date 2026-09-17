// Durante el entrenamiento la barra se quedaba clavada en 60% durante horas, que desde afuera
// es idéntico a que se haya colgado. Lo que se prueba acá es que el número que reemplaza a ese
// 60% sea de verdad: que lea bien lo que dice el entrenador, que no confunda una ruta con un
// avance, y que cuando no hay nada que leer igual muestre algo que distinga lo vivo de lo muerto.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comoVa, duracion, estimar, leerAvance } from '../tools/avance.mjs';

test('leer el avance de la salida del entrenador', async (t) => {
    await t.test('el par con los dos números es el que manda', () => {
        assert.deepEqual(leerAvance('training 1234/15000 loss 0.02'), { hechos: 1234, total: 15000 });
        // Así lo escribe COLMAP mientras mira las fotos una por una.
        assert.deepEqual(leerAvance('Processed file [109/275]'), { hechos: 109, total: 275 });
    });

    await t.test('un número suelto sirve si sabemos el total', () => {
        assert.deepEqual(leerAvance('step 5000', 15000), { hechos: 5000, total: 15000 });
        assert.deepEqual(leerAvance('iteration: 7.500', 15000), { hechos: 7500, total: 15000 });
    });

    await t.test('se queda con lo último, que es lo más reciente', () => {
        assert.deepEqual(leerAvance('1/15000\n900/15000\n4200/15000'), { hechos: 4200, total: 15000 });
    });

    await t.test('una ruta no es un avance', () => {
        // El registro está lleno de rutas con números y barras. Si se colara una, el porcentaje
        // saltaría a cualquier lado y el tiempo que falta sería una mentira.
        const ruta = '/var/folders/ds/3lhz8ch529vgb0yf51sszv_m0000gn/T/inmo3d-casa/salida-denso';
        assert.equal(leerAvance(ruta), null);
        assert.equal(leerAvance('+ brush --total-steps 15000 --export-path /tmp/16/20/x'), null);
    });

    await t.test('lo que no tiene sentido se descarta', () => {
        assert.equal(leerAvance('sin numeros por aca'), null);
        assert.equal(leerAvance(''), null);
        // Más pasos hechos que pasos totales es basura, no un 130%.
        assert.equal(leerAvance('20000/15000'), null);
        assert.equal(leerAvance('step 99999', 15000), null);
        // Sin total no se puede convertir un número suelto en porcentaje.
        assert.equal(leerAvance('step 5000'), null);
    });
});

test('estimar cuánto falta', () => {
    const unaHora = 3600e3;
    // A mitad de camino en una hora: falta otra hora.
    const mitad = estimar(7500, 15000, unaHora);
    assert.equal(mitad.fraccion, 0.5);
    assert.ok(Math.abs(mitad.falta - unaHora) < 1000);
    // Recién arrancando: falta mucho más de lo que lleva.
    assert.ok(estimar(1500, 15000, unaHora).falta > unaHora * 8);
    // Terminado: no falta nada, y nunca da negativo.
    assert.equal(estimar(15000, 15000, unaHora).falta, 0);
    // Sin datos no se inventa una estimación.
    assert.equal(estimar(0, 15000, unaHora), null);
    assert.equal(estimar(100, 0, unaHora), null);
    assert.equal(estimar(100, 15000, 0), null);
});

test('los ratos se dicen como los diría una persona', () => {
    assert.equal(duracion(20e3), 'menos de un minuto');
    assert.equal(duracion(45 * 60e3), '45 min');
    assert.equal(duracion(130 * 60e3), '2 h 10 min');
    // Ni "0 h 45 min" ni "2 h 0 min": eso no lo dice nadie.
    assert.equal(duracion(120 * 60e3), '2 h');
});

test('lo que se ve mientras espera', async (t) => {
    const tramo = { desde: 60, hasta: 90 };

    await t.test('con avance real muestra el porcentaje y lo que falta', () => {
        const v = comoVa({ etapa: 'entrenando',
            transcurrido: 3600e3,
            leido: { hechos: 7500, total: 15000 },
            ...tramo });
        assert.equal(v.progress, 75, 'a mitad del entrenamiento, a mitad del tramo de la barra');
        assert.match(v.step, /50%/);
        assert.match(v.step, /faltan 1 h/);
    });

    await t.test('sin avance, al menos dice hace cuánto está', () => {
        // Hay entrenadores callados. Igual hay que poder distinguir lo vivo de lo colgado.
        const v = comoVa({ etapa: 'entrenando', transcurrido: 130 * 60e3, leido: null, ...tramo });
        assert.equal(v.progress, 60, 'la barra no miente: se queda donde empieza la etapa');
        assert.match(v.step, /2 h 10 min/);
    });

    await t.test('la barra nunca se pasa del tramo de su etapa', () => {
        const v = comoVa({ etapa: 'entrenando',
            transcurrido: 1000,
            leido: { hechos: 15000, total: 15000 },
            ...tramo });
        assert.equal(v.progress, 90, 'entrenar al 100% es 90 en la barra, no 100');
    });
});
