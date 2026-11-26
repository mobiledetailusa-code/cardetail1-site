# Cardetail1 — Recuperação comercial, fase 2 (25/11/2026)

Esta fase continua a auditoria de `local-seo-ads-audit-2026-11-25.md` e mantém os baselines daquele documento e de `gbp-ads-baseline-2026-11-25.md`.
Todas as ações foram feitas direto nos painéis. O Adspirer **não foi usado** nesta fase; restam 2 consultas.

## 1. Alterações efetivamente realizadas

| # | Onde | Antes | Depois | Rollback |
|---|---|---|---|---|
| 1 | Ads › Cardetail1-search › Mobile Detailing | 4 palavras-chave de frase **pausadas** (pausadas em 22/11 junto com as outras 105) | **Enabled / Eligible**: "auto detailing near me", "inside car cleaning", "auto interior detailing", "interior detailing near me" | Pausar as 4 de novo |
| 2 | Ads › lista compartilhada "negative word" | `"spray"` (frase) | Removida. Entraram `"detailer spray"`, `"detailing spray"` e `"quick detailer"` (frase) | Remover as 3 e adicionar `"spray"` de volta |
| 3 | GBP › serviços | Exhaust tip polishing, Interior scenting, Paint repair | Removidos: não existem no catálogo de carros (Chrome/Stainless Polish existe só para barcos; não há aromatização; o site faz paint correction, não reparo de pintura) | Readicionar pelos serviços sugeridos do GBP |
| 4 | GBP › Engine detailing | Sem descrição | "Engine bay top clean: top-view cleaning of the visible engine bay surfaces. Not mechanical service. Included with Premium Full Detail and Exterior Refresh & Protect, and available as an add-on with other car packages." (texto do catálogo canônico) | Apagar a descrição |
| 5 | GBP › serviços novos | — | Ceramic coating, Pet hair removal, Odor treatment (todos existem no catálogo e no site) | Excluir os 3 |
| 6 | Repositório (draft PR #426, commit `aabbd2e1`) | 8 páginas de cidade em Bergen | +3 páginas piloto: Franklin Lakes, Mahwah, Tenafly. Também: hub, grid da home, sitemap, redirects, llms.txt e inventários de testes | Reverter o commit |

**Não foram alterados:** orçamento, CPC máximo ($3), estratégia de lances, programação ou status das campanhas, metas de conversão, segmentação, categorias/endereço/verificação do GBP, booking, preços, functions, banco e variáveis de ambiente. Nada foi mergeado nem publicado.

**Status das edições anteriores do GBP:**
- Descrição em inglês do "Auto detailing": **publicada**.
- UTM do website: **publicada**.
- UTM do link de agendamento: **salva** (`https://cardetail1.com/?utm_source=google&utm_medium=organic&utm_campaign=gbp_booking`).

**Nota sobre a lista de negativas:**
- O contador marcava 21 termos no baseline, mas só 20 nomes eram visíveis. Hoje a lista tem 26 termos e as 20 originais estão presentes.
- O Change History ainda não mostra as alterações de hoje, só a última (atraso de relatório). Reconfirmar em 24h.

## 2. D2 — palavras-chave reativadas

**Análise das 105 pausadas (histórico completo):**
- Quase todas têm 0–5 impressões desde a criação.
- As frases ativas `"car detailing"`, `"mobile detailing"` e `"mobile car detailing"` já cobrem as variantes "near me", "interior car detailing", "full car detailing", "car detailing bergen county", "mobile detailing bergen county" e "mobile auto detailing". O Ad Preview confirmou.
- Reativar essas variantes só criaria duplicidade. **O limite é Ad Rank e orçamento (IS de 14%), não cobertura de palavras-chave.**

**Volumes do Keyword Planner (Bergen County, média mensal, top-of-page low–high):**

| Termo | Volume | Top-of-page |
|---|---|---|
| auto / vehicle detailing near me | 880 | $1,55–6,01 |
| mobile detailing near me | 110 | $1,74–7,43 |
| inside car cleaning | 110 | $0,80–4,83 |
| mobile car detailing / mobile auto detailing | 70 | $2,40–8,03 |
| mobile detailing | 70 | $2,23–4,47 |
| auto interior detailing / car interior detailing | 50 | $1,39–4,20 |
| car detailing bergen county | 50 | $1,67–3,99 |
| interior car detailing near me | 40 | $1,49–3,77 |
| interior detailing near me | 20 | — |
| full car detailing | 10 | — |

**Reativadas (4, todas de frase):**

| Palavra-chave | Por que entrou |
|---|---|
| "auto detailing near me" | Maior volume do grupo (880/mês). Não é coberta por "car detailing" (palavra diferente). Teve 2 cliques como search term, sem conversão. O lance baixo ($1,55) cabe no CPC de $3 |
| "inside car cleaning" | 110/mês, lance de $0,80–4,83. Intenção de interior, que é o serviço de inverno. Não é coberta pelas frases ativas. Os termos DIY já são negativos ("how to", "diy", "kit", "products") |
| "auto interior detailing" | 50/mês. Interior de inverno. Sem "car", por isso não é coberta |
| "interior detailing near me" | 20/mês. Interior, intenção local. Não é coberta |

**Não reativadas:**
- "car detailer": $50,83 gastos, 0 conversões.
- "car detailing near me": já coberta e QS 3.
- "car cleaning and waxing near me": intenção de lavagem/cera barata.
- Variantes de cerâmica: fora da sazonalidade.
- As outras ~95: volume histórico zero.

**Limitação:** a Winter foi copiada só com as 7 ativas, então essas 4 não existem nela. Elas param em 1/12 junto com a Search. Ver a decisão N2.

## 3. D3 — "mobile hand car wash" (investigação, sem implementação)

- Keyword Planner (Bergen): "mobile hand car wash" ~10/mês; "mobile car wash near me" 30/mês, top-of-page $2,31–5,43.
- Ads, 30 dias: "mobile car wash near me" teve 17 impr., 1 clique, $3,10, 0 conversões; "mobile car wash" teve 4 impr., 1 clique.
- **Conclusão:** demanda pequena com CPC próximo ou acima do limite de $3. Um teste exato teria no máximo ~40 buscas/mês em Bergen. **Manter a negativa** `"car wash"` até haver orçamento livre.

**Desenho preparado para o futuro, não aplicado:**
- substituir `"car wash"` por `[car wash near me]`, `"car wash prices"`, `"automatic car wash"`, `"touchless"`, `"tunnel"` e `"hand car wash near me"`;
- adicionar `[mobile car wash]`, `[mobile car wash near me]` e `[mobile hand car wash]` em um grupo próprio, apontando para a home com o pacote Exterior Hand Wash ($125);
- duração de 14 dias, teto de $15.

## 4. D4 — negativas de marca: recomendação **manter**

- **Foram intencionais.** Estão na lista compartilhada junto com nomes de concorrentes ("ace mobile detailing", "jh mobile detailers", "dr detail"), o mesmo padrão de exclusão.
- **Volume:** o Keyword Planner mostra "cardetail1" abaixo de 10 buscas/mês em Bergen.
- **SERP "Cardetail1":** sem anúncios. cardetail1.com aparece em 1º com sitelinks (Palisades Park, Fort Lee, Paramus, Hackensack) e o painel do GBP com 13 avaliações 5,0.
- **SERP "cardetail1 reviews":** sem anúncios; a página /reviews do site aparece em 1º.
- **SERP "car detail 1 nj":** uma leitura mostrou 2 rótulos "Sponsored"; a leitura seguinte, nenhum. O anunciante não foi identificável. O site aparece em 1º e 2º orgânico; um listing antigo da MapQuest ("Car Detail 1 – Ridgefield Park") também aparece.
- **Custo de uma estratégia de marca:** menos de 10 buscas × ~30% de CTR × ~$0,50–1,00 = **menos de $3/mês**. O ganho também seria quase nulo, porque o orgânico e o GBP já capturam a marca.
- **Reavaliar** se o Auction Insights mostrar concorrentes na marca ou se as buscas de marca passarem de ~30/mês.
- **Ação recomendada fora do Ads:** corrigir os listings da MapQuest e do Yelp ("Car Detail 1 – Ridgefield Park"), que confundem quem busca a marca.

## 5. D5 — serviços do GBP contra o catálogo em produção

Fontes: `netlify/lib/canonical-addon-catalog.js`, `booking-price-catalog.js` e `assets/addon-rules.js`.

| Serviço no GBP | Catálogo | Ação |
|---|---|---|
| Auto detailing | Pacotes Interior, Full, Refresh, Maintenance e Wash | Mantido (descrição em inglês) |
| Auto interior vacuuming | Incluso no Interior Detail | Mantido |
| Car waxing | Carnauba Wax (add-on); paste wax incluso no Full | Mantido |
| Clay bar treatment | Add-on de $45; incluso no Full e no Refresh | Mantido |
| Engine detailing | Engine Bay Detail ($125) **aposentado**; Engine Bay Top Clean ($45) **ativo**; incluso no Full, Refresh e Signature | Mantido, com descrição exata |
| Exhaust tip polishing | Não existe para carros | **Removido** |
| Full body wash | Exterior Hand Wash | Mantido |
| Headlight polishing | Headlight Restoration ($90) | Mantido |
| Interior scenting | Não existe (há odor treatment, que não é aromatização) | **Removido** |
| Paint repair | Não existe (o site faz paint correction) | **Removido** |
| Seat shampooing / Steam cleaning / Wheel washing | Inclusos nos pacotes | Mantidos |
| boat detailing / motorcycle detailing | Categorias de barcos e powersports | Mantidos |
| — | Ceramic coating, Pet hair removal, Odor treatment | **Adicionados** |

## 6. Conversion tracking (P0)

### 6.1 PRs existentes

| PR | Escopo | Status | Dependências e sobreposição | Riscos | Testes | Bloqueio para publicar |
|---|---|---|---|---|---|---|
| #387 `fix/analytics-public-config-v1` | Recria `analytics-public-config` como função v1, depois que o deploy 6aeb3120 quebrou as v2 | Draft, **CONFLICTING**, 32 commits atrás | Nenhuma | Desnecessário: produção responde `200 {"configured":{"ga4":true}}` desde o deploy 6aec9beb (05/11) | CI verde no head antigo | **Recomendo fechar como obsoleto** |
| #388 `fix/ads-url-passthrough` | `url_passthrough: true` no gtag, para o GCLID sobreviver com consentimento negado | Draft, mergeável, 32 atrás | Toca `assets/revenue-events.js`, o mesmo arquivo do #389. merge-tree contra o master e com o #389: **sem conflito** | Muda URLs internas (parâmetros gclid/gbraid). Testar com booking, portal e hub bridge | CI verde no head; precisa rebase + CI | Aprovação do owner (afeta consentimento/privacidade) |
| #389 `fix/ads-drop-removed-page-view` | Torna opt-in a conversão "Page view" (ação **removida** no Ads, mas ainda disparada em toda página) | Draft, mergeável, 32 atrás | Mesmo arquivo do #388; merge limpo nas duas ordens | Baixo: elimina ruído | CI verde no head; precisa rebase + CI | Aprovação |

Já entregues antes (sem PR aberto):
- #411: conversões "Website phone tap" e "Quote request", secundárias.
- #416: tracking nas páginas de cidade.
- #406/#407: atribuição a IA.

### 6.2 Reconciliação read-only (store de produção `cd1-bookings`; nenhum dado pessoal no relatório)

**Desde 01/10 há 8 registros:**
- 6 testes arquivados ou drafts (`archived_test`): 10/01, 10/08, 10/09 (2), 10/17 e 11/13. O de 11/13 foi pago em dinheiro, mas está marcado como teste.
- **2 reservas reais:**

| Reserva | Data | Origem | Pacote | Situação |
|---|---|---|---|---|
| CD1-MVJLFEUS | 22/10 | **Não é Ads** | $440 | Confirmada; job "confirmed"; pagou $440 em cartão no local |
| **CD1-MWO9IOEB** | 20/11 | **Ads** | Full $250 + add-ons $65 = $315 | **Confirmada → concluída → paga $315** (cartão no local, `completed_paid`, serviço concluído em 20/11 às 15:10 UTC); sem desconto; taxa de deslocamento $0 |

**A solicitação de $315 atribuída ao Ads virou venda real e receita recebida.**

**Os 6 estágios separados:**
- solicitação de reserva: a conversão "Book appointment" (valor = cotação);
- reserva confirmada: `confirmedAt`;
- reserva cancelada: `appointmentStatus=canceled`;
- serviço concluído: `serviceStatus=service_completed`;
- cliente pagante e receita: `amountPaid` / `paymentStatus`;
- teste: `status=archived_test`.

Panorama histórico do store: ver a seção 7.2.

**CAC e ROAS (Ads, 26/10 a 24/11):**

| Escopo | Gasto | Clientes pagantes verificados | Receita | CAC | ROAS |
|---|---|---|---|---|---|
| Conta inteira | $300,05 (Search $231,63 + Smart $61,50 + zone2 $6,92) | 1 | $315 | $300 | 1,05× |
| Só Search | $231,63 | 1 | $315 | $232 | 1,36× |

- **Margem de contribuição:** não calculável, falta o custo de mão de obra e materiais por serviço.
- **Conversões não rastreadas:** no sistema, 0 de 1 reserva paga no período. Reservas por telefone ou fora do sistema não são visíveis.
- **Amostra:** um único cliente. Qualquer CAC ou ROAS aqui é indicativo, não estatístico.

### 6.3 Lacuna P0 encontrada

**O registro da reserva não guarda gclid, gbraid, wbraid nem UTM.**
- O adaptador de importação offline (`netlify/lib/google-ads-export.js`) existe, mas está desligado (`GOOGLE_ADS_EXPORT_ENABLED`) e não teria ID de clique para enviar.
- Hoje o vínculo clique → reserva só existe nos eventos `revenue-events`.
- Sem isso, o Ads nunca aprende quais cliques viram **receita**, só quais viram **solicitação**.
- Proposta (PR futuro, não implementado):
  1. copiar o `attribution` capturado no browser (gclid/gbraid/wbraid, utm_*) para o registro da reserva em `submit-booking`;
  2. na conclusão com pagamento (`completed_paid`), enfileirar um "Paid booking" offline com `orderId` = ID da reserva e valor = `amountPaid`.

### 6.4 Proposta de configuração das conversion actions (não aplicada)

| Papel | Ação | Contagem / valor | Primária? |
|---|---|---|---|
| **Resultado comercial** | "Paid booking (offline import)", nova, via 6.3 | Uma por clique; valor = receita recebida | **Primária** (quando houver volume) |
| Proxy atual | Book appointment (solicitação) | Uma; valor = cotação | Primária até a importação offline existir |
| Lead qualificado | Quote request (website), Calls from ads (60s+) | Uma | Secundária |
| Auxiliar | Website phone tap, Clicks to call (GBP) | Uma | Secundária (hoje "Clicks to call" é **primária** com $1 fixo e muitas por clique) |
| Ruído | Local actions – Directions, Smart campaign map directions | — | **Rebaixar para secundária**: negócio sem endereço físico |
| Legado | Smart campaign ad/map clicks to call, Calls from Smart Campaign Ads | — | Secundária (as Smart estão pausadas) |
| Legado | Purchase, GA4 purchase (oculta) | — | Manter secundária ou remover |

Primárias de cada meta e estratégia de lances: **inalteradas nesta etapa**, conforme instruído.

## 7. Geografia

### 7.1 Evidências por cidade

| Cidade | Keyword Planner (Bergen, "car detailing <cidade> nj"/mês) | GSC 90 dias | Ads search terms | SERP orgânica (mobile/desktop, logado) | Distância / taxa | Situação do Cardetail1 |
|---|---|---|---|---|---|---|
| Franklin Lakes | < 10 | 0 | 0 | Avanti Car Care, Starshine, RideShine, detail.com com **páginas por cidade** no topo; **Cardetail1 ausente** | 16 mi / $0 | Sem página → **piloto criado** |
| Mahwah | 10 | 0 | 0 | Starshine, Avanti, RPMFX, detail.com, RideShine com páginas por cidade; **ausente** | 16 mi / $0 | **Piloto criado** |
| Tenafly | < 10 | 0 | 0 | AutoXentra, APX, Starshine, detail.com, RideShine; **ausente** | 3 mi / $0 | **Piloto criado** |
| Wyckoff | < 10 | 0 | 0 | RideShine, Starshine, GoShine, Avanti; **o hub de NJ do Cardetail1 aparece em 3º** | 13 mi / $0 | Hub regional (sem página) |
| Saddle River / USR | — | 0 | 0 | Details by Jack, saddlerivermobiledetailing.com, RideShine, Avanti, APX; ausente | 13 mi / $0 | Hub regional. Candidata ao próximo lote |
| Oakland | — | 0 | 0 | não verificado | 18 mi / $0 | Hub regional |
| Englewood | 10 | 79 impr. | 0 | **Página do Cardetail1 em 2º** | 3 mi / $0 | Manter |
| Ridgewood | 10 | 130 impr. | 0 | **Página do Cardetail1 em 3º** | 9 mi / $0 | Manter |
| Paramus | 10 | 118 impr., pos. 12,7 | 1 ("car detailing paramus") | não verificado | $0 | Manter |
| Hackensack | 30 | 167 impr. | 1 | não verificado | 0 mi | Manter; melhorar conteúdo depois |
| Fair Lawn | 10 | 0 | 1 | não verificado | $0 | Hub regional |
| Alpine | — | 41 impr. | 0 | não verificado | 6 mi / $0 | Hub regional |

**Ausência de visibilidade ≠ ausência de demanda.** Nas cidades sem página, o Cardetail1 simplesmente não aparece, enquanto concorrentes com páginas genéricas por cidade ocupam o topo. Onde o Cardetail1 tem página, ele já chega ao top 3. A demanda por cidade é pequena (≤ 10/mês cada), mas o público é de alto valor (serviços premium, cerâmica) e o deslocamento é gratuito.

**Limitação:** as SERPs foram verificadas com a conta logada; as posições podem estar personalizadas. Confirmar no GSC em 14 e 30 dias.

### 7.2 Histórico de reservas por ZIP

Leitura read-only de todo o store `cd1-bookings` (499 registros desde jun/2026), só com contagens:
- 378 testes, 96 drafts, 9 "Pending Review", 11 sem status de job;
- **5 reservas reais pagas ou concluídas, $1.421 de receita no total**.

ZIPs das 5 reservas reais:

| ZIP | Local |
|---|---|
| 10014 | Manhattan |
| 12550 | Newburgh, NY |
| 07456 | Ringwood, Passaic |
| **07458** | **Saddle River/Upper Saddle River, noroeste de Bergen** |
| 07307 | Jersey City, Hudson |

O volume é baixo demais para ranquear cidades por histórico. Ainda assim, **uma das 5 vendas reais veio do noroeste de Bergen**, o que reforça o piloto nessa região e põe Saddle River/USR como candidata ao próximo lote.

### 7.3 Ranking de oportunidades

| # | Oportunidade | Potencial | Demanda | Concorrência | Viabilidade | Cobertura | Página? | Confiança |
|---|---|---|---|---|---|---|---|---|
| 1 | Franklin Lakes | Alto (renda alta, cerâmica) | Baixa (< 10) | Média (páginas genéricas) | Alta ($0) | Nenhuma | **Sim, piloto** | Média |
| 2 | Tenafly | Alto | Baixa | Média | Muito alta (3 mi) | Nenhuma | **Sim, piloto** | Média |
| 3 | Mahwah | Médio-alto | Baixa (10) | Média | Alta ($0) | Nenhuma | **Sim, piloto** | Média |
| 4 | Saddle River / USR | Alto | Muito baixa | Média | Alta | Hub | Próximo lote, se o piloto indexar em 30 dias | Baixa |
| 5 | Wyckoff | Médio | Muito baixa | Média | Alta | Hub de NJ em 3º | Não por enquanto | Baixa |
| 6 | Hackensack (melhorar) | Médio | 30/mês | Alta | Muito alta | Página fraca (pos. 19,9) | Melhorar existente | Média |

## 8. Páginas criadas ou melhoradas (draft PR #426)

- **Novas:** `/franklin-lakes-mobile-detailing`, `/mahwah-mobile-detailing`, `/tenafly-mobile-detailing`.
  - Feitas pelo gerador existente, com preços do catálogo canônico via tokens.
  - CTAs para `/?book=cars&zip=…`, FAQ e breadcrumb em JSON-LD.
  - Texto próprio: sobreposição máxima de 8,4% de 5-gramas com qualquer página existente.
  - Sem experiências ou endereços inventados; só afirmações verificáveis no catálogo e no módulo de deslocamento.
- **Melhoradas:**
  - Hub de Bergen: grid com 11 cidades, texto por região com links.
  - Grid da home: +3 links.
  - Englewood e Ridgewood: os blocos "nearby" ganharam as cidades piloto.
  - Palisades Park: o engine-bay top clean agora diz que já está incluso no Full e no Refresh.
  - Todas as páginas de cidade: o rodapé lista as 11.
- **Registros:** `sitemap.xml` (38 → 41), redirects 301 de `.html`, `llms.txt`.

## 9. D7 — título da homepage: **não alterar**

- Para consultas "bergen", a home é a página que ranqueia melhor (posição 20,9, contra 37,2 do hub). Ela também carrega o desempenho geral: 21 dos 47 cliques em 90 dias, posição 11,2.
- **Diferenciação semântica após o PR:**
  - home = marca + Bergen County (genérico, carro);
  - hub = "por cidade" (navegação regional);
  - páginas de cidade = intenção "<cidade> nj";
  - páginas de serviço = cerâmica, RV, barcos, frota.
- Não há evidência de que a semelhança dos títulos esteja prejudicando. Mudar o título da página mais forte arrisca perder a posição em "mobile detailing" (328 impr., pos. 16,6).
- **Reavaliar em 30 dias:** se o hub passar a ranquear para "bergen" sem perda na home, manter tudo como está.

## 10. Campanha Winter — riscos da ativação programada

**Configuração conferida:**
- **Datas:** 2/12/2026 a 28/02/2027. Status Enabled/Pending.
- **Orçamento:** total de $291, ~$3,27/dia. Lances Maximize clicks; CPC máximo de $3 (herdado).
- **Rede e segmentação:** só Google Search; 4 counties (Presence).
- **Recursos:** ativos automáticos desligados; broad match desligado; DSA com o domínio configurado, mas sem alvos ativos.
- **Palavras-chave:** as mesmas 7 ativas da Search. As 4 reativadas hoje **não** estão nela.
- **Negativas:** as mesmas da Search, mais a lista compartilhada.
- **Metas:** próprias da campanha, "Book appointments, Contacts e +2" (as mesmas da Search).
- **Sobreposição com a Search:** nenhuma. A Search termina em 1/12 e a Winter começa em 2/12, então não há disputa de leilão nem soma de orçamento.

**Anúncios (4 RSAs):**
- Mobile Detailing → `/`
- Ceramic Coating → `/ceramic-coating`
- RV Detailing → `/rv-detailing`
- RSA "Edgewater" → `/edgewater-mobile-detailing`

**Riscos:**
1. **Atribuição:** o final URL suffix da Winter ainda diz `utm_campaign=cardetail1-search`. Reservas de dezembro a fevereiro vão aparecer como "search" no RevOps. Correção: `utm_campaign=cardetail1-winter` (tracking apenas, reversível). **Preparada, aguarda OK.**
2. **Landing page:** o RSA "Edgewater" leva usuários dos 4 counties para a página de Edgewater (QS de landing page "Average"). Proposta: trocar o destino para `/` ou `/bergen-county-hub`.
3. **Copy:** os RSAs de cerâmica e RV prometem "Free estimates". A página de cerâmica não menciona estimativa; a de RV diz "Estimate — final scope confirmed before service". Alinhar o texto ou a página.
4. **Cobertura:** as 4 palavras-chave reativadas acabam em 1/12 se não forem adicionadas à Winter.
5. **Orçamento:** um orçamento total não ultrapassa $291. Não há risco de gasto acima do aprovado.
6. **Metas:** "Contacts" inclui ações de $1 fixo, como na Search. Irrelevante enquanto o lance for Maximize clicks.

## 11. Revisão das negativas novas (item 7)

| Negativa | Conflito possível | Decisão |
|---|---|---|
| `"spray"` | Bloqueava buscas comerciais como "ceramic spray coating service", "spray sealant" e "spray wax detail" | **Substituída** por `"detailer spray"`, `"detailing spray"` e `"quick detailer"` (os produtos de varejo que apareceram nos search terms) |
| `"supplies"` | Só intenção de compra de produto ("detailing supplies") | Mantida |
| `"website"` / `"websites"` | Navegacional ou B2B ("detailing websites"). Nenhum serviço do catálogo usa a palavra | Mantidas |

## 12. Testes e validações

| Verificação | Resultado |
|---|---|
| Suíte completa local (Windows, sem Postgres) contra o master `bdc38b22`, comparada por nome | Master: 5.196 testes, 70 falhas, 75 canceladas. Branch: 5.208 testes (+12 de inventário). **Nenhuma falha nova**: duas regressões de inventário encontradas e corrigidas (contagem do sitemap 38 → 41 em dois arquivos de teste). As 70 restantes são as mesmas do master (Postgres / ambiente) |
| `generate-bergen-city-pages --check` e `align-public-pages-with-home --check` | Aprovados |
| Build de produção local (dry run, CLI pinada, `BRANCH=master`, contexto production) | **Aprovado** em 4m54s: `customerPayments=false`, 83 functions, v2 `analytics-public-config` e `upload` com `invocationMode: stream`. O arquivo gerado foi restaurado. Sem deploy |
| Sitemap | 41 URLs. Todas as rotas existem em disco (teste `every sitemap route file exists`) |
| Canonical | As 11 páginas de cidade e o hub têm canonical limpo para `https://cardetail1.com/<slug>`. O `.html` faz 301 via `netlify.toml` |
| Structured data | 16 blocos JSON-LD em 13 páginas alteradas, todos com JSON válido. Cidades: LocalBusiness/AutomotiveBusiness + Service + FAQPage + BreadcrumbList |
| Links internos | Todos os `href` internos das 13 páginas alteradas resolvem para um arquivo ou redirect |
| Mobile (375 px) | Página de Tenafly e grid da home sem overflow horizontal. FAQ e "nearby" legíveis |
| Booking (servidor estático isolado) | O CTA da página leva a `/?book=cars&pkg=full&zip=07417`, que abre o modal no passo Vehicle com o ZIP preenchido. O estimador do browser (`CD1Travel`) calcula 16, 16 e 3 mi, igual ao servidor ($0) |
| Duplicidade de conteúdo | 5-gramas: no máximo 8,4% de sobreposição com outra página de cidade |

**Não verificado:**
- envio real de reserva (as functions não rodam no servidor estático, e criar reserva em produção é proibido);
- comportamento em um deploy preview do Netlify;
- CI do GitHub para os novos commits (roda no push).

## 13. Rollback

- **Ads:** pausar as 4 palavras-chave reativadas; na lista "negative word", remover as 3 negativas novas e adicionar `"spray"` de volta.
- **GBP:** readicionar Exhaust tip polishing, Interior scenting e Paint repair (aparecem como sugestões); excluir Ceramic coating, Pet hair removal e Odor treatment; apagar a descrição do Engine detailing. Os textos anteriores estão nos dois docs de baseline.
- **Código:** reverter `aabbd2e1` (piloto) e/ou `669d4f5b` (hub). Nada está em produção.

## 14. Próximas decisões que exigem autorização

- **N1:** corrigir o URL suffix da Winter para `utm_campaign=cardetail1-winter`, antes de 2/12.
- **N2:** adicionar à Winter as 4 palavras-chave reativadas.
- **N3:** trocar o destino do RSA "Edgewater" e alinhar "Free estimates" com as landing pages.
- **N4:** fechar o #387; rebasear e publicar o #389, que é de baixo risco; avaliar o #388 (privacidade e consentimento).
- **N5:** PR para persistir gclid/gbraid/wbraid/UTM no registro da reserva e habilitar a importação offline de "Paid booking" (§6.3).
- **N6:** rebaixar "Directions" e "Clicks to call" para secundárias (§6.4).
- **N7:** merge e deploy do #426 (hub + 3 páginas piloto).
- **N8:** corrigir os listings da MapQuest e do Yelp ("Car Detail 1 – Ridgefield Park").
