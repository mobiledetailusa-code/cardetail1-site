# Window tint — o que configurar antes de ligar

A preview em `/window-tinting` está fora do sitemap e da navegação. O serviço continua desligado. Ligar o serviço é preencher os campos abaixo, testar, e só então mudar `enabled`.

Arquivo: `assets/window-tinting-demo-catalog.js`.

| Decisão | Onde configurar | Estado agora |
| --- | --- | --- |
| Serviço aceita reserva e pagamento | `COMMERCIAL.enabled` | `false`. Com `false`, ou sem o restante pronto, `netlify/lib/window-tint-guard.js` responde 403 em `submit-booking`, `create-setup-intent`, pagamento e consulta de agenda. |
| Preço aprovado, em centavos | `COMMERCIAL_PRICE_ROWS` | `null`. A tabela de dólares da preview está só em `DEMO_PRICE_ROWS`. |
| Duração comercial | `COMMERCIAL.durationMinutes` | `null`. A duração fictícia da preview é `DEMO.demoDurationMinutes` (180) e não ocupa agenda. |
| Recurso que instala | `COMMERCIAL.installerResourceId` | `null`. O id preparado, `DEMO.preparedResourceId`, não é uma vaga de detailing. `usesDetailingCapacity` fica `false`. |
| Onde a película é instalada | `COMMERCIAL.installLocation` | `null`. |
| Deslocamento | `COMMERCIAL.travelFeeCents` e `usesDetailingTravelTable` | Sem taxa. A tabela de milhas do detailing não entra no total. |
| Remoção de película antiga | `COMMERCIAL.removalAmountCents` | `null`, e `removalRequiresEvaluation` é `true`. Remoção não vira $0. |
| Para-brisa, teto e vidros dianteiros | `COMMERCIAL.glassExceptions` | Avaliação pendente, `amountCents: null`. Um checkbox não confirma. |
| Horários reais | Agenda do instalador, depois que a duração e o recurso existirem | A preview só lista `DEMO.fictionalWindows`. |

`commercialReady()` só fica verdadeiro quando `enabled` é `true` e há duração, local, recurso próprio e pelo menos um preço comercial maior que zero. A função ignora argumentos. O servidor chama essa cópia do arquivo e não lê `enabled`, `commercialReady`, preço ou duração vindos do JavaScript do navegador, da URL ou do payload. Até lá a preview mostra “Demo pricing — not available for booking” e o servidor recusa os IDs `wt_film_`, `wt_glass_`, `wt_cov_` e `wt_resource_`.

Não reutilize preço, duração ou ID de ceramic coating. Não aplique o multiplicador de tamanho do detailing: a classe do veículo só escolhe a linha sedan, SUV de duas fileiras ou SUV grande/minivan.
