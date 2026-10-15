# Película residencial — o que configurar antes de ligar

A preview em `/residential-window-film` está fora do sitemap e da navegação. O serviço continua desligado. O catálogo e a duração ficam em arquivo próprio, separados do window tint automotivo.

Arquivo: `assets/residential-window-film-catalog.js`.

| Decisão | Onde configurar | Estado agora |
| --- | --- | --- |
| Serviço aceita reserva e pagamento | `COMMERCIAL.enabled` | `false`. Com `false`, ou sem o restante pronto, `netlify/lib/residential-window-film-guard.js` responde 403. |
| Preço aprovado, em centavos | `COMMERCIAL_PRICE_ROWS` | Lista vazia. A preview não tem preço demonstrativo. Ela só soma a área. |
| Duração comercial | `COMMERCIAL.durationMinutes` | `null`. `DEMO.demoDurationMinutes` também é `null`. Não reutilize os 180 minutos do window tint. |
| Recurso que instala | `COMMERCIAL.installerResourceId` | `null`. O id preparado, `DEMO.preparedResourceId`, não é vaga de detailing nem recurso automotivo. |
| Onde a película é instalada | `COMMERCIAL.installLocation` | `null`. |
| Compatibilidade com o vidro | Ainda sem regra | A preview grava o tipo, inclusive “I don't know”, e não diz se a película serve. |
| Privacidade à noite | Texto fixo de limitação | Permanece enquanto a película de privacidade existir. Não é garantia nem proteção contra invasão. |

`commercialReady()` ignora argumentos. O servidor usa a cópia deste arquivo. JavaScript alterado no navegador, parâmetros de URL e campos do payload não ligam serviço, preço, agenda ou pagamento.

Não copie preço, duração ou ID de `assets/window-tinting-demo-catalog.js`. Não anuncie marca, garantia, obra realizada ou proteção contra invasão sem comprovação.
