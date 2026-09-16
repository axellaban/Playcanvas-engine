// Reintentar mal es peor que no reintentar: o se rinde antes de que vuelva la conexión, o hace
// esperar veinte minutos por un error que nunca iba a cambiar. Los dos casos se pagan en horas
// de trabajo tirado, así que se prueban los dos. Las esperas se falsean —el worker espera
// minutos de verdad— pero se comprueba que sean exactamente las que tienen que ser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definitivo, porfiar } from '../tools/reintentar.mjs';

const reloj = () => {
    const esperas = [];
    const esperar = (ms) => {
        esperas.push(ms);
    };
    return { esperas, esperar };
};

test('reintentos', async (t) => {
    await t.test('lo que sale bien a la primera no se reintenta', async () => {
        const { esperas, esperar } = reloj();
        let veces = 0;
        const r = await porfiar(() => {
            veces++;
            return 'listo';
        }, { esperar });
        assert.equal(r, 'listo');
        assert.equal(veces, 1);
        assert.deepEqual(esperas, []);
    });

    await t.test('insiste hasta que sale, esperando antes de cada reintento', async () => {
        const { esperas, esperar } = reloj();
        let veces = 0;
        const r = await porfiar(() => {
            if (++veces < 3) throw new Error('se cayó internet');
            return veces;
        }, { esperas: [10, 20, 30], esperar });
        assert.equal(r, 3);
        assert.deepEqual(esperas, [10, 20], 'espera antes de reintentar, no después del que salió bien');
    });

    await t.test('se rinde recién cuando agotó las esperas, y tira el último error', async () => {
        const { esperas, esperar } = reloj();
        let veces = 0;
        await assert.rejects(porfiar(() => {
            throw new Error(`falla ${++veces}`);
        }, { esperas: [1, 2], esperar }), /falla 3/);
        assert.equal(veces, 3, 'el intento original más un reintento por cada espera');
        assert.deepEqual(esperas, [1, 2]);
    });

    await t.test('no porfía con lo que nunca va a andar', async () => {
        // Un 404 es un archivo que no está y no va a aparecer solo. Insistir es hacer esperar
        // al pedo para terminar dando el mismo error veinte minutos más tarde.
        const { esperas, esperar } = reloj();
        let veces = 0;
        await assert.rejects(porfiar(() => {
            veces++;
            throw Object.assign(new Error('No pude bajar el video (HTTP 404)'), { status: 404 });
        }, { esperas: [1, 2, 3], esperar }), /404/);
        assert.equal(veces, 1, 'un solo intento');
        assert.deepEqual(esperas, []);
    });

    await t.test('un "ahora no" sí se reintenta', async () => {
        for (const status of [408, 429, 500, 502, 503]) {
            const { esperar } = reloj();
            let veces = 0;
            await porfiar(() => {
                if (++veces < 2) throw Object.assign(new Error('esperá'), { status });
                return 'ok';
            }, { esperas: [1], esperar });
            assert.equal(veces, 2, `HTTP ${status} es temporal: tiene que reintentarse`);
        }
    });

    await t.test('cuenta cada reintento para que se vea en el registro', async () => {
        // Un reintento silencioso parece un cuelgue: quien mira el registro tiene que poder
        // distinguir "está esperando para volver a probar" de "se murió".
        const { esperar } = reloj();
        const avisos = [];
        let veces = 0;
        await porfiar(() => {
            if (++veces < 3) throw new Error('nada');
            return 'ok';
        }, { esperas: [5, 6], esperar, avisar: (e, espera, n) => avisos.push([e.message, espera, n]) });
        assert.deepEqual(avisos, [['nada', 5, 1], ['nada', 6, 2]]);
    });
});

test('anda con lo que realmente se reintenta: una promesa', async () => {
    // Arriba las funciones de prueba son sincrónicas por comodidad, pero en el worker lo que se
    // reintenta es siempre una llamada a la red. Que ande con una promesa no lo prueba aquello.
    const { esperas, esperar } = reloj();
    let veces = 0;
    const r = await porfiar(async () => {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
        if (++veces < 2) throw new Error('se cortó la conexión');
        return 'bajado';
    }, { esperas: [7], esperar });
    assert.equal(r, 'bajado');
    assert.equal(veces, 2);
    assert.deepEqual(esperas, [7]);
});

test('se distingue el "no" del "ahora no"', () => {
    const con = status => Object.assign(new Error(''), { status });
    assert.equal(definitivo(con(404)), true, 'no está y no va a estar');
    assert.equal(definitivo(con(401)), true, 'la clave está mal: insistir no la arregla');
    assert.equal(definitivo(con(429)), false, 'pidió que espere');
    assert.equal(definitivo(con(408)), false, 'se le acabó el tiempo');
    assert.equal(definitivo(con(503)), false, 'el servidor está caído, puede volver');
    // Sin código de estado la conexión ni llegó a destino: eso es exactamente lo que se reintenta.
    assert.equal(definitivo(new Error('fetch failed')), false);
});
