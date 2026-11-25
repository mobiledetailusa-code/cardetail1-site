# Cardetail1 — Google Ads, GBP e Local SEO: auditoria de 25/11/2026

Fontes: painéis do Google Ads (conta 531-119-6117), Google Business Profile, Search Console (`sc-domain:cardetail1.com`) e o repositório no master `bdc38b22`. O Adspirer foi usado só 2 vezes: para as ações de conversão e para os IDs geográficos. Restam 2 consultas de 15.
Datas do Ads em horário do Pacífico. "30d" significa de 26/10 a 24/11/2026.

## 1. Resumo executivo

- **Queda de ~80% nas impressões: são duas quedas diferentes.**
  - **Conta inteira, −81% entre as semanas de 2/11 e 9/11.** A Smart "CarDetail1" (Search + Partners + Display) parou de veicular. Foram 4.334 e 4.308 impr./semana e depois 0. Ela respondia por 8.642 das 11.089 impressões em 30 dias, quase tudo Display/partners de baixa intenção.
  - **Cardetail1-search, −75% por dia depois de 22/11 às 19:46–19:49.** A média caiu de 168 para ~41 impr./dia. Na mesma janela foram aplicadas três mudanças:
    - orçamento total de $370 para $291 (~$4/dia até 1/12);
    - CPC máximo de $6 para $3;
    - **105 das 112 palavras-chave pausadas** (78 + 17 + 10).
  - Em 23/11 entraram 9 negativas, entre elas `"car wash"`. Só "car wash near me" teve 256 impr. em 30 dias, com CTR de 0,39%.
  - **A Winter não causou nada.** Está *Pending* até 2/12, com 0 impressões. Na semana de 23/11, a Search perdeu 53% de IS por rank e 40,5% por orçamento.
- **A queda foi uma escolha deliberada (modo inverno) e é coerente com a economia.** Em 30 dias a Search gastou $231,63 e gerou 1 solicitação de reserva ($315). Bergen recebeu $171 sem nenhuma conversão. A única conversão veio de Hudson.
- **Franklin Lakes e as outras 11 cidades estão elegíveis.** A segmentação é Presence em Bergen. O anúncio aparece de forma intermitente por Ad Rank baixo e IS de 14%, não por bloqueio geográfico.
- **SEO local:**
  - **Não há demanda orgânica demonstrada** para Franklin Lakes, Wyckoff, Mahwah, Oakland, Ridgewood, Saddle River, Tenafly ou Englewood. Nenhuma dessas cidades aparece entre as 500 principais consultas em 90 dias.
  - **Há canibalização** entre a home e o hub de Bergen nas consultas "bergen" (home na posição 20,9, hub na 37,2).
  - **Decisão: nenhuma página nova.** O hub de Bergen foi melhorado.

## 2. Evidências do Google Ads

| Campanha | Status | 30d impr. | Cliques | Custo | Conv. |
|---|---|---|---|---|---|
| Cardetail1-search | Eligible (Limited), "Missing enough relevant keywords"; total de $291 até 1/12; Maximize clicks; só Google Search | 2.400 | 110 | $231,63 | 1 |
| CarDetail1 (Smart) | Pausada; $20/dia; Search + Partners + Display | 8.642 | 353 | $61,50 | 1 |
| Cardetail1-zone2 | Pausada pelo app mobile em 16/11 10:11; total de $85; Westchester/Morris/Orange/Fairfield/Essex | 46 | 4 | $6,92 | 0 |
| Cardetail1-winter | Pending de 2/12 a 28/02; total de $291 | 0 | 0 | $0 | 0 |
| Mobile Auto Detailing Service (Smart) | Pausada; $2,10/dia | 1 | 0 | $0 | 0 |

**Search por semana** (impr. / cliques / custo / IS / perda por rank / perda por orçamento):

| Semana | Impr. | Cliques | Custo | IS | Perda rank | Perda orçamento |
|---|---|---|---|---|---|---|
| 26/10 | 262 | 20 | $43,37 | <10% | 36% | 59% |
| 2/11 | 68 | 3 | $7,53 | 14% | 40% | 46% |
| 9/11 | 808 | 25 | $77,69 | 19% | 29% | 52% |
| 16/11 | 1.179 | 56 | $95,73 | 13,5% | 57% | 29% |
| 23/11 (2 dias) | 83 | 6 | $7,31 | <10% | 53% | 41% |

**Search em 30 dias:**
- Search IS 13,91%; Top IS e Abs. Top IS abaixo de 10%.
- Perda de IS: 47,99% por rank e 38,10% por orçamento.
- Exact match IS: 19,65%.

**Quality Score** (Expected CTR / Landing page):

| Palavra-chave | QS | Expected CTR | Landing page |
|---|---|---|---|
| "car detailing" | 5 | abaixo da média | média |
| "mobile detailing" | 5 | abaixo da média | média |
| "mobile car detailing" | 5 | abaixo da média | média |
| "mobile detailing near me" | 3 | abaixo da média | média |
| "car interior cleaning" | 3 | abaixo da média | média |

**Geografia** (Presence, 30d; impr. / cliques / custo / conversões):

| County | Impr. | Cliques | Custo | Conv. |
|---|---|---|---|---|
| Bergen | 1.573 | 75 | $171,45 | 0 |
| Hudson | 355 | 20 | $34,77 | 1 |
| Passaic | 236 | 10 | $18,36 | 0 |
| Rockland | 216 | 3 | $4,96 | 0 |

**Ad Preview** (mobile, inglês):
- **Franklin Lakes:**
  - "mobile detailing" e "mobile detailing near me": anúncio aparece.
  - "car detailing near me", "interior car detailing", "mobile auto detailing" e "mobile detailing bergen county": "probably shown at times" ou deduplicação dentro do mesmo grupo de anúncios.
  - "mobile car wash" e "mobile car wash near me": nenhuma palavra-chave corresponde.
- **As outras 11 cidades** (consulta "mobile detailing near me"):
  - Aparece: Mahwah, Alpine, Englewood, Hackensack.
  - "Shown at times" ou Ad Rank baixo: Wyckoff, Oakland, Ridgewood, Upper Saddle River, Saddle River, Tenafly, Paramus.
  - Não há bloqueio geográfico em nenhuma.

**`"car wash"`:**
- É frase em nível de campanha, na Search e na Winter. Foi adicionada em 23/11 às 19:59 PT e não foi removida nem reinserida nos 30 dias.
- Não está na lista compartilhada.
- Em 30 dias, as consultas com "wash" custaram ~$20, com 0 conversões. "mobile car wash near me" teve 17 impr. e 1 clique.
- **Recomendação: manter.** O teste controlado está na seção 9.

**Lista compartilhada "negative word"** (Search, Winter e Zone2) bloqueia a própria marca: "cardetail1", "cardetail 1", "car detail 1", "car detail1". Ver a decisão D4.

**Outros:**
- Search partners e Display estão desligados. Broad match e AI Max também.
- A configuração de DSA existe, mas as inclusões de URL estão pausadas.
- Houve 4 recomendações aplicadas automaticamente entre 9/11 e 15/11. Não verificadas individualmente.

## 3. Integridade das conversões

- **Primárias (8):**
  - Book appointment: webpage, uma por clique, DDA, 90 dias, valor dinâmico.
  - Calls from Smart Campaign Ads.
  - Clicks to call: hospedada pelo Google, muitas por clique, $1 fixo.
  - Lead form – Submit.
  - Local actions – Directions: muitas por clique, $1 fixo. Para um negócio sem endereço, não tem valor comercial.
  - 3 ações Smart de call e directions.
- **Secundárias:** Calls from ads, Purchase, Quote request (website), Website phone tap. GA4 purchase está oculta.
- **A Search usa metas próprias da campanha:** "Book appointments, Contacts e +2". "Contacts" mistura ações de valor fixo de $1. Um lance por conversões leria esse total como sinal.
- **No código:**
  - A conversão de reserva dispara na *solicitação* criada (`ok`, `bookingCreated`, não draft), com `transaction_id` deduplicado e o valor do booking. Não é receita realizada.
  - O rótulo "Page view" ainda dispara a cada página para uma ação removida. O draft #389 corrige.
  - `url_passthrough` não está ativo. O draft #388 ativa.
  - O GA4 fica quase cego com consentimento opt-in (auditoria de 20/11).
- **Reconciliação:** a única conversão "Book appointment" registrada é CD1-MWO9IOEB-364K ($315, 19/11). Não li a base de reservas de produção nesta auditoria.
- **Economia em 30 dias (Search):**
  - CAC de ~$232 por solicitação de reserva.
  - ROAS bruto ~1,36, se o trabalho de $315 tiver sido concluído.
  - Margem de contribuição não calculável: não há dados de custo do serviço.
  - Considerando o phone tap de 20/11, o custo por lead qualificado fica em ~$77–116.
  - O volume é baixo demais para Maximize Conversions. **Não altere o lance.**

## 4. Google Business Profile

**Estado:**
- Perfil verificado, como negócio de área de serviço (SAB) sem endereço. Categorias: Car detailing (primária), RV detailing e Boat detailing.
- Área de atendimento: Bergen, Hudson, Passaic e Rockland. Horário: seg–sáb, 7h–17h.
- Telefone (551) 389-3986.
- 13 avaliações, nota 5,0. Últimas fotos há 68 dias.
- Há uma edição anterior ainda em revisão.

**Problemas encontrados:**
1. A descrição do serviço "Auto detailing" estava **em português** e prometia durabilidade de "até 1 ano". **Corrigido.**
2. O website e o link de agendamento não tinham atribuição, e o link de agendamento usava `http://`. **Corrigido** com UTMs `utm_source=google&utm_medium=organic&utm_campaign=gbp_website|gbp_booking`. O site classifica isso como orgânico, e a home responde 200.
3. Três serviços listados não existem no catálogo: Exhaust tip polishing, Interior scenting e Paint repair (o site faz paint correction). "Engine detailing" é ambíguo: o Engine Bay Detail de $125 foi aposentado, mas o Top Clean de $45 continua. **Preparado, não aplicado** (D5).
4. O domingo aparece como fechado. As regras supervisionadas de domingo só valem a partir de 27/12. Revisar perto da data.

## 5. Search Console

**Totais:**

| Período | Cliques | Impressões | CTR | Posição média |
|---|---|---|---|---|
| 28 dias | 11 | 2,32 mil | 0,5% | 17,1 |
| 90 dias (= 180 dias; dados desde ~24/08) | 47 | 7,84 mil | 0,6% | 17,8 |

**Dispositivos:** mobile 29 cliques, 3.504 impr., posição 12,4. Desktop 18 cliques, 4.298 impr., posição 22,2.

**Indexação:**
- 42 páginas indexadas e 21 não indexadas: 8 redirecionamentos (esperados), 5 com canonical alternativo, 4 com 404, 2 noindex, 1 com 401, 1 em que o Google escolheu outro canonical, mais "Discovered – not indexed".
- Sitemap lido com sucesso (38 URLs).
- Sem ações manuais e sem problemas de segurança. CWV sem dados suficientes.

**Posição 8–20 com muitas impressões e 0 cliques:**

| Consulta | Impressões | Posição |
|---|---|---|
| mobile detailing | 328 | 16,6 |
| mobile detailing near me | 134 | 10,8 |
| mobile car detailing near me | 118 | 11,5 |
| car detailing essex county | 65 | 12,2 |
| mobile auto detailing near me | 55 | 10,9 |
| car detailing near me | 51 | 11,2 |
| mobile car wash | 45 | 18,5 |
| mobile detailing essex county | 36 | 12,1 |

**Canibalização "bergen"** (90 dias, 324 impr., 0 cliques):

| Página | Impressões | Posição |
|---|---|---|
| `/` | 259 | 20,9 |
| `/bergen-county-hub` | 96 | 37,2 |
| `/new-jersey-hub` | 86 | 51,8 |
| `/ridgewood-mobile-detailing` | 79 | 68,2 |

Os títulos da home e do hub eram quase idênticos.

**A divisão entre `.html` e URLs limpas é histórica.** Em produção, os `.html` já fazem 301 para as URLs limpas. Não é um problema atual.

## 6. Inventário geográfico (24 páginas)

Todas as páginas têm canonical limpo, estão no sitemap e não têm `robots` restritivo.

| Página | Template | Links internos | Impr. 90d / posição | Decisão |
|---|---|---|---|---|
| bergen-county-hub | T1, 2,9 mil palavras | 36 | 234 + 105 (.html) / ~23 | **Melhorada** |
| palisades-park | gerada | 10 | 66 / 9,7 (2 cliques) | Manter |
| fort-lee | gerada | 10 | 73 / 9,2 | Manter |
| edgewater | gerada | 10 | 129 / 9,1 | Manter |
| teaneck | gerada | 10 | 75 / 10,6 (1 clique) | Manter |
| paramus | gerada | 10 + hub | 118 / 12,7 | Manter (agora com link contextual do hub) |
| hackensack | gerada | 10 + hub | 167 / 19,9 | Melhorar depois (conteúdo) |
| englewood | gerada | 10 + hub | 79 / 19,5 | Manter |
| ridgewood | gerada | 10 + hub | 130 / 47,9 | Melhorar depois; sem demanda própria demonstrada |
| hudson / passaic / essex hubs | T1 | 26–28 | 165 / 294 / 307 | Manter. Essex tem demanda orgânica, mas está fora do Ads e do GBP (D6) |
| union / morris / rockland / fairfield hubs | T3 | 26 | 11–97 | Manter |
| NJ / NY / CT / PA hubs | T1/T2 | 24–26 | 488 / 2.039 / 225 + 130 / 378 + 138 | Manter |
| newark / trenton / westchester | T1 | 1 / 0 / 26 | 65 / 39 / 32 | Manter. Trenton está órfã (0 links) |

**Cidades investigadas:**
- **Atender pela página regional (o hub de Bergen):** Franklin Lakes, Wyckoff, Mahwah, Oakland, Upper Saddle River, Saddle River, Alpine e Tenafly. Nenhuma tem consultas no GSC, nenhuma conversão no Ads e cada uma tem 17–103 mil de alcance.
- **Já têm página:** Ridgewood, Englewood, Paramus e Hackensack.
- **Não implementado:** páginas individuais e uma página "Northwestern Bergen". Os dados não justificam, e uma URL nova sem demanda dilui o hub.

## 7. Alterações aplicadas

| Onde | Antes | Depois | Rollback |
|---|---|---|---|
| Ads: lista "negative word" | 21 termos | +`"spray"`, `"supplies"`, `"website"`, `"websites"` (25). Origem: "car detailer spray", "detailing websites" e fornecedores; sem conflito com as 7 palavras-chave ativas | Remover os 4 termos da lista |
| GBP: serviço Auto detailing | Texto em pt-BR (salvo em `gbp-ads-baseline-2026-11-25.md`) | Descrição em inglês alinhada ao catálogo (295 caracteres) | Colar o texto original |
| GBP: website | `https://cardetail1.com/` | `…/?utm_source=google&utm_medium=organic&utm_campaign=gbp_website` (pendente de revisão do Google) | Voltar à URL anterior |
| GBP: link de agendamento | `http://cardetail1.com/` | `https://cardetail1.com/?utm_source=google&utm_medium=organic&utm_campaign=gbp_booking` | Voltar à URL anterior |
| Repositório (draft PR) | Hub de Bergen com title/meta quase iguais aos da home e 8 links | Title "Bergen County Mobile Car Detailing by Town \| Cardetail1"; nova meta; seção por região com os municípios de Bergen e 10 links contextuais; spec do `apply-onpage-seo.mjs` atualizado | Reverter o commit |

**Nada foi alterado** em orçamento, lances, CPC, status das campanhas, metas, segmentação, categoria ou endereço do GBP, booking, preços, functions, banco ou variáveis de ambiente. Produção não foi publicada.

## 8. Prioridades

- **P0:** nenhum problema quebrado ou que esteja gastando dinheiro de forma errada.
- **P1:**
  - (a) Metas da Search misturam "Contacts" de $1 fixo com reservas. Não migrar o lance.
  - (b) QS 3–5 com Expected CTR abaixo da média.
  - (c) Canibalização home × hub.
  - (d) Serviços do GBP fora do catálogo.
- **P2:**
  - (a) Negativas de marca na lista compartilhada.
  - (b) Essex com demanda orgânica, mas fora do Ads e do GBP.
  - (c) "Page view" e `url_passthrough` (drafts #389 e #388).
  - (d) Trenton sem links internos.
- **P3:** fotos do GBP antigas (68 dias); CWV sem dados; páginas de Hackensack e Ridgewood fracas.

## 9. Decisões que exigem autorização

- **D1. Estrutura da Search e da Winter.** Manter separadas: a Search acaba em 1/12 e a Winter começa em 2/12, sem sobreposição nem disputa de leilão. A partir de 1/3 será preciso uma campanha nova (limite de 90 dias). Usar grupos sazonais dentro de uma campanha de orçamento diário seria mais simples.
- **D2. Recuperar volume sem aumentar o orçamento.** Reativar 3–5 palavras-chave de intenção alta (ex.: "mobile car detailing near me" e "auto detailing near me" estão ativas; "interior detailing near me" está pausada) e limitar o ajuste a Hudson e Bergen. Exige autorização (afeta status e lances).
- **D3. Teste de "mobile car wash".** Trocar a negativa de frase `"car wash"` por negativas mais estreitas ([car wash near me], "hand car wash", "car wash prices", "automatic", "touchless", "self service" — esta última já existe) e adicionar [mobile car wash] e [mobile car wash near me] como exatas, por 14 dias, com teto de $15. Aumenta a exposição, por isso exige autorização.
- **D4. Remover as negativas de marca** ("cardetail1" e variantes) para cobrir consultas de marca hoje disputadas por MapQuest e Instagram. Custo esperado: centavos.
- **D5. Remover do GBP** Exhaust tip polishing, Interior scenting e Paint repair. Renomear ou esclarecer "Engine detailing" como engine bay top clean.
- **D6. Essex:** decidir se volta ao Ads ou ao GBP. Há demanda orgânica (181 impr., posição 13,7), mas fica fora da área do raio gratuito.
- **D7. Título da home:** tirar "Bergen County" do título e focar marca + "Mobile Car Detailing NJ". O ganho é potencial, e há risco para a página mais forte. Só com aprovação.
- **D8. Merge e deploy** do draft PR.

## 10. Acompanhamento

Indicadores, em todos os marcos:
- solicitações de reserva com `utm_campaign` = cardetail1-search, cardetail1-winter, gbp_website ou gbp_booking;
- reservas confirmadas e receita no Admin Ops;
- custo por reserva confirmada;
- cliques e posição no GSC para consultas "bergen" e as páginas do hub e das cidades;
- ações do GBP (ligações e cliques no site).

| Marco | O que verificar |
|---|---|
| **7 dias (2/12)** | GBP publicou as 3 edições? A Search encerrou em ~$291? A Winter começou a veicular? Algum termo novo nos search terms? |
| **14 dias (9/12)** | IS e CPC da Winter; primeiros leads com `utm_campaign=gbp_*`; o Google reindexou o title do hub? |
| **30 dias (25/12)** | Posição do hub para "bergen" vs. a home (meta: hub < 25 e home sem perda); custo por reserva confirmada ≤ $150; decidir D2 e D3 com dados. |

## 11. Riscos e limitações

- Não li reservas de produção nem receita: o CAC é uma estimativa.
- A coluna Ad relevance e o relatório de User/Matched locations em nível de cidade não foram capturados pela UI.
- O GSC só mostra as 500 principais consultas (4.555 das 7.840 impressões).
- O Ad Preview é amostral.
- As edições do GBP dependem de revisão do Google.
