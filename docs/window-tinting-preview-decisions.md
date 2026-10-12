# Window tint — decisões pendentes da preview

Preview comercial em `/window-tinting`. Não reserva, não cobra e não envia orçamento. A página está com `noindex`, fora do sitemap e fora da navegação de produção.

Não há tabela comercial de window tint no repositório. Os valores não foram inventados. O total da demonstração fica visível como **Not priced**.

## Decisões para habilitar preço e agenda reais

1. Publicar uma tabela em centavos, por linha de película e cobertura, sem reutilizar preço de ceramic coating e sem multiplicador de tamanho do detailing.
2. Definir quais vidros entram no cardápio. Para-brisa e teto ficam em avaliação específica. Vidros dianteiros não são permitidos em qualquer escurecimento.
3. Definir se a remoção de película antiga tem preço e como ela é avaliada.
4. Definir se a taxa de deslocamento do detailing se aplica a window tint.
5. Medir a duração real com o instalador de película. Sem essa duração, a agenda não pode reservar horário.
6. Identificar o recurso responsável (quem instala e quantos trabalhos cabem no dia). A capacidade atual é um número de vaga do detailing, não um instalador de película.
7. Decidir marcas, garantia, prazo, local de instalação e se a visita é móvel. Nada disso está confirmado e a preview não promete.
8. Decidir se, no futuro, window tint pode dividir um appointment com detailing. Nesta versão os serviços ficam separados, e a lógica de múltiplos serviços não foi alterada.

## Como o catálogo atual poderia representar window tint

O site público ainda precifica por `netlify/lib/booking-price-catalog.js`. O contrato do Owner Studio (`docs/owner-studio-catalog-contract.md`) descreve o formato futuro, com a flag pública ainda em `legacy`.

| Necessidade | Onde caberia | O que impede usar hoje |
| --- | --- | --- |
| Linha de película | Dois pacotes novos, categoria própria, IDs `wt_film_carbon` e `wt_film_ceramic`. Família `window_tint`. | As colunas de `PRICING.cars` são pacotes de detailing. Ceramic coating usa `ceramic_1yr` / `ceramic_3yr` e `serviceFamily: ceramic_coating`. Esses IDs não servem para película. |
| Cobertura exata | Configuração da linha, não add-on genérico. Add-on hoje é um extra com preço fechado. Para-brisa e teto precisam existir sem serem compráveis. | Não há entidade de cobertura. Um add-on seria confirmado como item pago. |
| Configuração dos vidros | Lista de posições + estado de registro + remoção. O estado de registro não é o ZIP. | O booking guarda veículo, ZIP e endereço. Não guarda estado de registro nem película existente. |
| Preço | `PackagePrice.amountCents`, modelo `flat`, sem `vehicleClassId` de sedan/SUV. | O grid atual muda o preço por classe de veículo. Aplicar isso automaticamente seria o multiplicador de tamanho do detailing. |
| Duração | `PackageRevision.durationMinutes`, só depois de medida. | Ceramic coating tem `baseMinutes` de 480 e 600. A agenda transforma duração em vagas de 2 horas. Duração ausente ocupa uma vaga. Inventar um número reservaria a agenda errada. |
| Instalador | Recurso com habilidade de película, separado da capacidade numérica do slot. | `capacityForSlot` devolve um número (padrão 1). Não há fila de instalador de película. O campo `installer` do ceramic coating é texto interno daquele serviço. |

A preview guarda essa forma em `assets/window-tinting-demo-catalog.js`. Nenhum módulo de produção importa esse arquivo.

## O que a preview reutiliza

- ZIP: `assets/travel-fee-client.js` só para reconhecer o CEP. A taxa de deslocamento não entra no total.
- Veículo: catálogo de carros já usado no agendamento (marca, modelo, ano). A classe de tamanho aparece na tela e é ignorada no preço.
- Contato: nome, telefone, e-mail e preferência de contato, no mesmo papel do passo de dados do detailing.
- Endereço: campo de endereço do serviço. A sugestão automática não foi ligada porque `booking-address-suggest.js` está preso aos IDs do modal de produção e consulta a rede.
- Pagamento: as três escolhas do formulário atual (cartão online depois do serviço, cartão no serviço, dinheiro). Stripe não carrega, cartão não é salvo e nada é cobrado.

O que ainda falta perguntar, além do veículo já preenchido: estado de registro e se existe película para remover.

Parâmetros de URL como `price`, `total`, `pkg` e `duration` são ignorados. `film` só pré-seleciona Carbon, Ceramic ou Help me choose.

## O que não entra nesta versão

- Envio do formulário, `submit-booking`, PaymentIntent ou vaga na agenda.
- Fotos do cliente. O upload existente é o do técnico, em trabalho já atribuído.
- Checkbox de responsabilidade do cliente no lugar da avaliação de para-brisa, teto ou vidro dianteiro.
- Combinação com detailing no mesmo appointment.
- Homepage, sitemap, navegação pública, preços e duração de ceramic coating.

## Pendências operacionais sem resposta comercial

- Onde a película é instalada e em quanto tempo.
- Se a visita é móvel e em quais endereços.
- Garantia, marca, certificação e aprovação em inspeção.
- Preço de remoção e regra legal por estado e por vidro.
- Quem executa o serviço e qual a capacidade real do dia.
