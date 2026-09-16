// Captura también fallos de importación del motor, anteriores a ejecutar tour-ui.
import('./tour-ui.mjs').catch((error) => {
    document.querySelector('#loader .spin')?.remove();
    const message = document.querySelector('#loader-text');
    if (message) {
        message.textContent = `No se pudo abrir el tour: ${error.message}`;
        const back = document.createElement('a');
        back.href = '/';
        back.textContent = ' Volver al panel';
        message.append(back);
    }
});
