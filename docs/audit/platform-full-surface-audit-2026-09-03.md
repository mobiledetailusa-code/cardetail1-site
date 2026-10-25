# Auditoria geral da plataforma Cardetail1

**Data:** 2026-09-03  
**HEAD lido:** `cc93999` (`feat(sms): standardize operational booking SMS with View links`)  
**Postura:** somente leitura. Nenhum HTML, JS, CSS, função Netlify, schema ou config operacional foi alterado. Este arquivo é o único artefato intencional.

**Escopo pedido:** SEO, design, admin portal, customer, cada função clicável do site, previsão de quebra ou confusão no book, todos os elementos e configurações que a plataforma cobre.

---

## 1. Como o agente “conhece” o site de ponta a ponta

O agente **não** tem uma memória permanente do Cardetail1. A cada execução ele lê o repositório como um sistema:

1. **Inventário de arquivos** — HTML na raiz, `assets/`, `netlify/functions/`, `prisma/`, `shared/`, `docs/`, testes e configs.
2. **Contratos canônicos** — o que o próprio projeto declara como verdade: `tests/fixtures/booking-copy.canonical.json` (semântica do book), `shared/universal-customer-strategy-config.json` (roteamento de cliente), `prisma/schema.prisma` (modelo de dados), `netlify.toml` (rotas e headers).
3. **Código de runtime** — o book em `index.html`, o portal em `assets/my-garage.js`, o console em `admin-ops.html`, as 73 functions.
4. **Docs de auditoria anteriores** — `docs/audit/*` descreve riscos históricos (paridade de portais, dinheiro, Twilio). Esta leitura verifica o estado **atual** do código, não assume que aqueles findings já foram todos fechados.
5. **O que esta leitura não substitui** — clique real em produção, Stripe live, Twilio live, e o estado dos Netlify Blobs. Quebra prevista abaixo é **risco de código/contrato**, não um bug reproduzido no browser nesta sessão.

Em resumo: o agente conhece o site porque o site **está no Git**. Páginas, CTAs, preços de marketing, APIs e flags estão no disco. O que o cliente vê no momento do book é o DOM de `index.html#bk-ov`. O que o operador vê é `admin-ops.html`. O que o servidor persiste hoje ainda é o Blob `cd1-bookings`.

---

## 2. Mapa da plataforma (o que ela cobre)

```
Marketing público
  index.html                    ← book autoritativo (#bk-ov, 6 passos)
  especialidade                 ← boats / rv / powersports / fleet / multi-vehicle
  hubs de estado                ← NJ, NY Metro, CT, PA  (~510–523 KB cada)
  hubs de condado               ← Bergen, Hudson, Essex, Passaic (~412 KB)
  cidades leves Bergen (8)      ← ~22 KB; deep-link para index.html?book=
  cidades pesadas               ← Newark, Trenton, Westchester (clone do template)
  blog + 3 guias + legal

Operações do cliente (noindex)
  my-garage.html                ← portal real (pay, change requests, receipts)
  customer.html                 ← redirect legado → my-garage
  receipt.html / authorize.html / resume.html
  /a  e  /appointment-access    ← magic link SMS → sessão do portal

Operações internas
  admin.html                    ← login
  admin-ops.html                ← console do dia a dia (~4500 linhas inline)
  admin-owner-studio.html       ← control plane (só Catalog é navegável)
  admin-owner-studio-catalog.html
  technician.html               ← jobs, bids, completion
  bid.html                      ← leilão do técnico
  prototype/                    ← UI paralela, não é autoridade

Backend
  73 Netlify functions
  Netlify Blobs cd1-bookings    ← autoridade viva do booking (Release A)
  Prisma/Postgres               ← dual-write / Owner Studio / identity
  Stripe + Twilio outbox fail-closed
```

**Regra de ouro do book (já codificada no fixture canônico):**

- Superfície autoritativa: **somente** `index.html`.
- Hubs/cidades gerados têm `#bk-ov` escondido por `assets/hub-booking-bridge.js` e abrem o book da home em iframe.
- Páginas de especialidade usam `assets/specialty-booking-bridge.js`.
- Cidades leves de Bergen navegam de verdade para `index.html?book=&zip=&pkg=`.
- Submit **não cobra cartão**. Request ≠ appointment confirmado. SMS só com opt-in.

---

## 3. O book — cada clique e o que pode confundir

### 3.1 Entradas que abrem o mesmo modal

Quase todos os CTAs da home chamam `openBooking(null)` e **recomeçam no passo 1 (Category)**, sem pré-selecionar o pacote que o cliente acabou de olhar:

| Clique | Handler | Efeito real |
|--------|---------|-------------|
| Nav **Services** | `openBooking(null)` | Abre o book vazio. “Services” não vai a um catálogo. |
| Nav **Check Price** | `openBooking(null)` | Idem |
| Hero **Check Price & Availability** | `openBooking(null)` | Idem |
| Hero ZIP **Check ZIP** | `onHeroZipSubmit()` | Se o ZIP cair num hub, **sai da home** e redireciona. Senão, feedback no hero. |
| **Book Multiple Vehicles** | força `ST._forceMultiVehicle` + `openBooking(null)` | Abre o book e tenta destacar “Add Another Vehicle” |
| Cards Interior / Full / Exterior **Book this package** | `openBooking(null)` | **Não pré-seleciona o pacote do card** |
| **See what's included** → modal → **Book this package** | `openBookingCarPkg(pkgId)` | **Este sim** pré-seleciona (`ST._prefillPkgId`) e tenta ir ao passo veículo |
| Sticky mobile **Check price** | `openBooking(null)` | Book vazio |
| Sticky **Your booking** | `openPortal()` | Vai a `my-garage.html#lookup` — **não** é o book |
| Chat “book” | `cdAsk` / chip `act:'book'` | Abre o book |
| Add-on chips da home | `openBooking(null)` | Também não carrega o add-on clicado |
| Fleet via book | `openBooking('fleet')` | **Não entra no funil de 6 passos** — abre inquiry comercial |

Função existente e subutilizada: `openBookingCarPkg(pkgId)` / `openBookingPkg(cat, pkgId)`. Os CTAs visíveis dos cards ignoram isso.

### 3.2 Os 6 passos do modal `#bk-ov`

Comentário no código: `BK_VISIBLE_STEPS = 6` — “restored from proven 117484e UX”.  
Copy da home: **“Book in five steps”** (Category → Package → Vehicle → Info → Review & Submit). O 6º passo é **Request Sent**. Isso já é uma fissura de copy vs UI.

**Passo 1 — Category (`#bs1`)**  
ZIP `#bk-zip` (obrigatório). Cards: cars / boats / rvs / powersports. Sem ZIP, a categoria fica “pending” — o clique parece morto. Fleet não é um card aqui; `openBooking('fleet')` sai do funil.

**Passo 2 — Package (`#bs2`)**  
Grid dinâmico de `PRICING[cat].packages`. Continue: `bkContinueFromPackage`. RV mostra nota `#bs2-rv-note`. Preços “from” de RV ficam escondidos até haver length.

**Passo 3 — Vehicle (`#bs3`)**  
Make/model/year (cars), length (boats/RVs), tipo RV + living quarters, add-ons, cart multi-veículo, **Add Another Vehicle**.  
Risco: RV `specialty` (cargo/horse) zera pacotes interior (`interior:0`, `full:0`). Cliente pode escolher um pacote e cair em $0 / caminho bloqueado.

**Passo 4 — Info (`#bs4`)**  
Nome, telefone, e-mail, SMS opt-in, endereço, data, janela de 3h vs anytime, data alternativa, água/luz, notas. Continue: `bkContinueFromContact` (alias legado `goToPayment` — o nome mente: **não há pagamento neste passo**).

**Passo 5 — Review (`#bs5`)** — único submit  
Welcome offer (`checkout-offer.js`): Apply / Continue without. Preferência de pagamento posterior (`online_after_service` | `card_onsite` | `cash_onsite`). Terms. **Submit Booking Request** → `submit-booking`.

**Passo 6 — Success (`#bs6`)**  
**View in My Garage** vs **Done**. O cliente acabou de “bookar” e é mandado a um portal que exige lookup/OTP. Se ele achar que já tem uma conta, trava.

### 3.3 Caminhos paralelos que **não** são o book

| Caminho | O que o cliente pensa | O que realmente é |
|---------|------------------------|-------------------|
| Fleet quote `#fleet-quote-form` | “Check Price” no nav da página fleet aponta para `index.html` (cars) | Quote B2B separado |
| Garage Plan `garage-plan.js` | Plano da casa / vários carros | Modal + `garage-plan-submit`, paralelo ao “Add Another Vehicle” |
| `resume.html` | Continuar o pedido abandonado | Valida token, manda para `index.html?resume=1&step=N`. **Index não restaura step, cart nem campos.** `booking-routing-gate.js` só avalia o query `resume=1`. |
| `authorize.html` | Pagar | Autorização on-site + assinatura, valor livre |
| `receipt.html` | Recibo | Pode pedir telefone de novo (`needsPhonePrompt`) |
| `/a?t=` | Abrir o agendamento | Minta sessão do My Garage |

**Três intenções quase iguais:** Garage Plan vs Add Another Vehicle vs Fleet (7+ / commercial). O routing gate (`universal-customer-strategy`) pode **bloquear** o book padrão no meio do fluxo e mandar para quote / manual review / security. Para o cliente isso parece o botão ter quebrado.

### 3.4 Confusão de nomes e preços no book

| Tema | Marketing (home / schema / `llms.txt`) | Catálogo vivo `PRICING.cars` |
|------|----------------------------------------|------------------------------|
| Pacote exterior | **Exterior Detail & Paint Enhancement** | id `refresh`: **Exterior Refresh & Protect** |
| Quantos pacotes | Home mostra **3** (Interior, Premium Full, Exterior) | Catálogo tem **6** (Hand Wash, Maintenance, Interior, Full, Refresh, Signature Restoration) |
| “From” cars | $190 / $240–270 / $320 | Bate com `tiers` dos 3 pacotes de marketing |
| Boats | Página vende 3 mins | Catálogo tem **Essential Marine** extra, pouco ou não mercadejado |
| RV vs car add-ons | Super Interior $135 / Sanitize $75 (RV) vs $125 / $65 (cars) | Correto por categoria; confunde se o cliente compara abas |
| Chat da home | Lista **todos** os nomes do catálogo (`pkgNames('cars')`) | Cliente ouve 6 pacotes no chat e vê 3 na página |

`bookingHasProgress()` em `index.html` (e clones de hub) ainda consulta IDs mortos `f-name` / `f-address`. Os campos reais são `f-first` / `f-addr`. Fechar o modal **pode não avisar** se o cliente só preencheu contato — perda silenciosa.

`multi-vehicle-detailing.html` aponta para `index.html?multi=1#book`. **Não existe `id="book"` na home.** O hash não ancora nada.

Nav do portal: home diz **My Garage**, sticky diz **Your booking**, hubs gerados dizem **My Booking**, sucesso diz **View in My Garage**. Três nomes para a mesma superfície.

---

## 4. Customer portal (My Garage)

`customer.html` é um casco de 32 linhas. A aplicação real é `my-garage.html` + `assets/my-garage.js` (~4100 linhas) + `my-garage-dashboard.js`.

**Pré-auth (clicável):** lookup booking ID + telefone; magic link por e-mail.

**Pós-auth (clicável):**

- Calendário / lista de appointments
- `reschedule_request`, `addon_request`, `package_change_request`
- `vehicle_add` / `vehicle_replace`
- `address_update`, `cancellation_request`
- `approve_completion`, `leave_review`, `report_issue`
- Pay Stripe (embedded + sticky **Pay securely**)
- Perfil, endereços, veículos, receipts, sign out

**Confusão prevista**

1. Depois do book, “View in My Garage” pede autenticação. O cliente acabou de enviar um request, não criou senha.
2. Preferências de comunicação ainda podem aparecer incompletas (“coming soon” em auditorias anteriores) — controle visível que não faz o que o rótulo sugere.
3. Change requests não são instantâneos: o admin precisa aplicar. O cliente pode clicar de novo e achar que o primeiro clique falhou.
4. Catalogo de mudança de pacote no portal historicamente **não era o mesmo** catálogo do book (`docs/audit/cross-portal-parity-matrix.md`). Se ainda divergir, o cliente vê um preço no book e outro no pedido de troca.
5. Authorize (valor livre + canvas) vs Pay no Garage (PaymentIntent de saldo) vs preferência “card on site” no review — três “pagar” diferentes.

**Robots:** a página tem `noindex,nofollow`, mas `robots.txt` **não** lista `/my-garage` nem `my-garage.html`. Portais admin/resume/receipt estão no disallow; o garage depende só da meta tag.

---

## 5. Admin portal, Owner Studio, Technician

### 5.1 Admin Ops (`admin-ops.html`) — o console real

Abas clicáveis: Schedule, Jobs Board, Requests, Payments, Settings, Overview, Technician Management, Assignments, Completed/Review, Issues, Auctions, Subscriptions, Maintenance, Homepage reviews, Event Log, Revenue Ops, links para Owner Studio.

Mutations de job em `admin-ops-jobs.js` incluem ciclo de vida (`confirm_booking`, `create_appointment`, `cancel_booking`, `reschedule`, `approve_completion`, `reopen_*`, auction) e dinheiro (`mark_cash_received`, `mark_card_on_site`, `generate_stripe_pay_link`, `reconcile_with_stripe`, `record_refund_request`, `mark_refunded`, `price_adjustment`, welcome offer, etc.).

**Riscos de clique / verdade dupla**

- Aba **Payments** deriva dos jobs já carregados em memória. Refresh falhou → painel parece “sem pagamentos”.
- `mark_refunded` registra estado operacional; **não prova** refund no Stripe.
- Link manual de pagamento pode guardar URL sem amarrar o valor aprovado.
- Vários campos de dinheiro no mesmo booking: `approvedFinalAmount`, `amountPaid`, `balanceDue`, `totalPrice`, amount do link, ajuste de completion do técnico.
- Lifecycle: admin/tech escrevem `jobStatus`; customer classifica por `appointmentStatus`. Um job “in progress” ainda pode aceitar mudança estrutural no Garage.

### 5.2 Owner Studio

| Módulo na UI | Estado |
|--------------|--------|
| Catalog (draft, revisão, preview) | Implementado |
| Publish / rollback como autoridade pública | Flags default **off** (`PUBLIC_CONTENT_SOURCE=legacy`) |
| Pricing & Travel, Content & Media, Service Areas | Placeholders, **não navegáveis** |

Preview autenticado **substitui** `PRICING` / `LENGTH_PRICING` no index e bloqueia submit. Se um flag de preview vazar para o público, o book mostra preços de rascunho.

Editar o catálogo no Studio **não muda** o storefront até publish + cutover. Operador pode achar que já publicou.

### 5.3 Technician

Login, onboarding, jobs, bids (`bid.html` + auctions), fotos before/after, completion com proposta de valor e canal cash/card. É um **terceiro writer** de dinheiro no mesmo Blob.

Prototype em `/portal-prototype` duplica UX. Testar o prototype e achar que é produção é um erro operacional fácil.

---

## 6. SEO

### 6.1 Inventário

- `sitemap.xml`: **31 URLs**, todas existem no disco.
- HTML na raiz: **43**. Os 12 de fora do sitemap são portais/template (`noindex`) — correto.
- Cidades planejadas e **ausentes** (`city-expansion-map.md`): Tenafly, Alpine, Saddle River, Franklin Lakes, Danbury. A tabela de status do doc está **stale** (Englewood, Fort Lee, Edgewater, Paramus, Ridgewood marcados pendentes e já estão no sitemap).

### 6.2 Dívida grande: clones de 410–523 KB

| Família | Tamanho | Padrão |
|---------|---------|--------|
| Cidades leves Bergen (8) | ~22 KB | Saudável; deep-link para o book da home |
| Especialidade / blog | ~10–40 KB | Saudável |
| Hubs de condado + Newark/Trenton/Westchester + `template-city.html` | ~410 KB | Jaccard ~0.99 vs template; ~55% JS inline do book |
| Hubs de estado | ~512–523 KB | Quase o mesmo clone + acordeão |
| `index.html` | ~489 KB | Autoridade + marketing + book |

Google recebe dezenas de URLs quase idênticas, pesadas, com JSON-LD de **Palisades Park** reutilizado em Newark/Trenton/Westchester. Sinal local diluído. Crawl budget e LCP mobile sofrem.

### 6.3 Órfãos internos

Com `href` **zero** a partir de outras páginas públicas (só entram via sitemap):

- `hudson-county-hub.html`, `essex-county-hub.html`, `passaic-county-hub.html`
- `newark-mobile-detailing.html`, `trenton-mobile-detailing.html`, `westchester-mobile-detailing.html`

O hero ZIP da home **não** manda NJ para hubs de condado: `resolveHubPageForHero()` empurra ZIP3 de NJ para `new-jersey-hub.html`. `hubs-config.md` ainda descreve roteamento por condado como “implementado”. Doc e código divergem.

### 6.4 Meta / OG / schema

- Home: o melhor bloco (LocalBusiness + FAQ + breadcrumb + OG).
- Hubs de condado: **sem `og:image`**, JSON-LD só LocalBusiness.
- Cidades pesadas: OG fraco, endereço de Palisades Park no schema.
- Fleet: sem OG; schema Service fino; JSON-LD “from $65” vs UX só-quote.
- Specialty: OG irregular (boats tem imagem; fleet/powersports/RV/multi falham em pontos).
- Tokens de template ainda visíveis em páginas pesadas: `{FIREBASE_AUTH_TOKEN}`, `{FIREBASE_DB_URL}`, `{ADMIN_SMS}`, `{TRAVEL_MAX_MILES}`.
- `llms.txt` cobre Bergen + especialidade e **omite** hubs de estado, blog, multi-vehicle, Newark/Trenton/Westchester.
- `robots.txt` não bloqueia `/prototype/` nem `/my-garage`.
- Pretty URL: `/terms-conditions` tem rewrite explícito; `/privacy-policy` depende de pretty URLs da Netlify. Canonical da privacy aponta para `/privacy-policy`. Risco baixo se pretty URLs estiverem on; inconsistência mesmo assim. Páginas de hub/cidade **não** têm URL extensionless.

---

## 7. Design

Três sistemas visuais convivem:

| Superfície | CSS | Fonte | Paleta |
|------------|-----|-------|--------|
| Home / hubs de estado | `luxury-theme` + booking | Bebas Neue + DM Sans | `#12181f`, `--blue:#4d8fd9` |
| Condados / cidades pesadas | `hub-styles` + booking, **sem** luxury-theme | mesma | clone do template |
| Cidades leves / especialidade | `specialty-*` + `city-landing` | mesma | `--sp-blue:#4da3ff`, fundo `#0a1018` |
| Fleet / multi | só `specialty-page-ui` | mesma | terceira paleta `#02040a` |
| My Garage | `my-garage-dashboard` | **Inter** | `#0a0a0f` / `#4da3ff` |

O cliente sai de um “luxury dark book” e cai num portal Inter. Os hubs de condado não recebem o mesmo chrome dos hubs de estado. Fleet/multi perdem nav/footer de especialidade.

Acessibilidade: home/hubs têm skip link e muitos `aria-*`; cidades leves quase não. Index tem ~9 labels para ~43 inputs (o book). Muitos `<button>` sem `type` nos clones pesados. Portal não tem skip link.

Performance de design: embutir o book inteiro em todo hub pesado vs deep-link das landings leves. O padrão Bergen leve é o que deveria escalar.

---

## 8. Configurações que entram nesta auditoria

| Config | Controla | Drift / risco |
|--------|----------|----------------|
| `shared/universal-customer-strategy-config.json` | Segmentos e path (standard / garage plan / specialty / fleet / manual review / offers) | Copiado para `netlify/lib/…` e gerado em `assets/universal-customer-strategy.generated.js` |
| `PRICING` / `LENGTH_PRICING` em `index.html` | Preço e pacotes do book público | Owner Studio ainda **não** é a fonte pública |
| `hubs-config.md` | Estratégia ZIP→hub | Texto diz condado; código manda NJ para hub estadual |
| `city-expansion-map.md` | Roadmap de cidades | Status table stale |
| `STRIPE-SUBSCRIPTION-PRICE-IDS.md` | `STRIPE_PRICE_SUB_*` | Fallback `price_data` se env vazio |
| `netlify.toml` | Redirects, CSP (`unsafe-inline`), no-store em portais, schedule Twilio `*/2`, offer env só em branch de QA | Sem rewrite `/privacy-policy`; hubs sem URL limpa |
| `.env.example` | DB, sessions, Twilio fail-closed, Owner Studio | Omite vários secrets Stripe/admin que o código exige; `OWNER_STUDIO_PUBLISH_ENABLED` vive nos flags e é fácil de perder |
| `robots.txt` / `sitemap.xml` / `llms.txt` | Descoberta | Gaps listados na §6 |
| `tests/fixtures/booking-copy.canonical.json` | Semântica de apresentação do book | **Não** é autoridade de preço nem de persistência |
| Prisma | Identity, ledger futuro, Owner Studio | Comentário do schema: ops ainda vive em Blobs |
| Flags Owner Studio | `OWNER_STUDIO_ENABLED`, `PUBLIC_CONTENT_SOURCE`, publish flags | Default preserva legado |

**Functions (73)** — grupos: admin/ops, owner-studio, technician, customer portal, booking público, Stripe, Twilio, media/QA. QA endpoints (`qa-*`) devem permanecer unset em produção.

---

## 9. Previsão de quebra e confusão (priorizada)

Severidade aqui = impacto no cliente ou no operador se o clique for levado ao pé da letra. Não é um ranking de “já crashou em produção hoje”.

### P0 — o book mente ou perde o cliente

1. **Resume não restaura progresso.** SMS/e-mail de retomar abre a home fria. O cliente acha o link quebrado.
2. **“Book this package” nos cards não booka aquele pacote.** Só o modal “See what's included” pré-seleciona. Dois botões com o mesmo rótulo, dois comportamentos.
3. **Nome duplo do pacote exterior** (Paint Enhancement vs Refresh & Protect). No review o cliente pode achar que pediu o serviço errado.
4. **Home mostra 3 pacotes, o passo 2 do book mostra 6.** “Cadê o que eu cliquei?” / “Por que apareceu Hand Wash?”
5. **ZIP obrigatório no passo 1** + deep-link de especialidade: clique em RV/Boat parece falhar até o ZIP.
6. **Request Sent ≠ confirmed.** FAQ de cidade ainda pode dizer “we text or call to confirm” sem a cláusula de opt-in / under review. Expectativa de “já está marcado”.

### P1 — caminhos que se cruzam e quebram a história

7. Três entradas multi/fleet (Garage Plan, Add Another Vehicle, Fleet quote) + strategy gate no meio do book.
8. Hash morto `#book` na página multi-vehicle.
9. `bookingHasProgress()` ignora `f-first`/`f-addr` — fechar o overlay perde dados sem confirm.
10. Iframe do hub/specialty: se o bridge falhar, o fallback local já foi escondido. Só erro + telefone.
11. Hero ZIP tira o usuário da home para um hub de 500 KB em vez de abrir o book.
12. Nav **Services** = book na home, mas = `/` ou `/#services` em especialidade. Mesmo rótulo, outro destino.
13. Fleet nav **Check Price** abre book de carro.

### P2 — SEO / design / ops que corroem confiança

14. Hubs/cidades clone de 410 KB+ com schema de Palisades Park.
15. Órfãos de condado/cidade pesada no grafo interno.
16. Três design systems (luxury / specialty / Inter).
17. Portal vs book: catálogo, saldo, status de job.
18. Owner Studio edit ≠ live. Payments tab stale. `mark_refunded` ≠ Stripe.
19. `robots.txt` incompleto para garage/prototype.
20. Tokens `{FIREBASE_*}` em HTML servido.

### P3 — higiene

21. `city-expansion-map.md` / `hubs-config.md` desatualizados (os próprios docs viram “book” interno errado).
22. `llms.txt` incompleto.
23. Botões sem `type`, labels do book, skip links ausentes nas landings leves.
24. Prototype ainda servido em `/portal-prototype`.

---

## 10. Melhorias sugeridas (não implementadas nesta auditoria)

Nada abaixo foi feito. É um backlog proposto, na ordem em que reduz confusão no book e dívida estrutural.

### Book / customer (maior ROI de clareza)

1. Unificar CTAs: cards **Book this package** devem chamar `openBookingCarPkg(id)` como o modal de detalhe já faz.
2. Um nome só para o pacote exterior, em marketing + `PRICING.cars` + schema + `llms.txt`.
3. Ou a home lista os 6 pacotes, ou o passo 2 do book destaca os 3 de marketing e trata Hand Wash / Maintenance / Signature como “more options” — não os dois ao mesmo tempo sem hierarquia.
4. Copy “five steps” → alinhar com as 6 tabs, ou esconder “Request Sent” da régua e manter five.
5. Um rótulo só para o portal: **My Garage** em nav, sticky, hubs e SMS.
6. Implementar restore real em `?resume=1&step=` (cart + campos + passo) ou parar de enviar esse link.
7. Corrigir `bookingHasProgress()` para `f-first`, `f-last`, `f-addr`.
8. Criar `id="book"` **ou** trocar os links multi-vehicle para o opener real (`openBooking` / query que o gate já entende).
9. Deep-link de especialidade: se não houver ZIP, focar `#bk-zip` com mensagem explícita, não “pending” mudo.
10. Rewrite `/privacy-policy` simétrico a `/terms-conditions`.

### SEO

11. Parar de clonar o book de 400 KB em hub/cidade. Adotar o padrão Bergen leve (~22 KB) + bridge/deep-link.
12. Ligar internamente os hubs de Hudson/Essex/Passaic e Newark/Trenton/Westchester, **ou** tirá-los do sitemap até terem conteúdo único.
13. JSON-LD por URL (NAP da cidade, não Palisades Park em Newark).
14. `og:image` em condados, fleet, specialty que faltam.
15. Atualizar `hubs-config.md` e `city-expansion-map.md` para o comportamento real do ZIP (senão o próximo agente/humano opera no mapa errado).
16. Completar `llms.txt` e `robots.txt` (`/my-garage`, `/prototype`).

### Design

17. Tokens compartilhados (cor, tipo, botão) entre luxury, specialty e portal — o portal não precisa ser Inter se o resto é DM Sans/Bebas.
18. Fleet/multi devem reusar chrome de especialidade (nav/footer).
19. Condados devem receber o mesmo `luxury-theme` dos hubs de estado **ou** virar landings leves.

### Admin / ops

20. Payments tab: empty state honesto se a lista de jobs não carregou.
21. Copy de refund: “recorded for Stripe follow-up”, nunca “refunded” sem id Stripe.
22. Owner Studio: desabilitar visualmente Publish até o flag; texto “draft only — live catalog is still index.html”.
23. Não testar em `/portal-prototype`.
24. Continuar o programa de paridade já documentado em `cross-portal-parity-matrix.md` (um `bookingVersion`, um catálogo, ledger = Stripe). Esta auditoria **não** reabre aquele registro defeito a defeito; ele continua válido como risco de fundo.

---

## 11. Relação com auditorias anteriores

`docs/audit/` já tem um corpus forte focado em **pagamentos, paridade Admin/Customer/Tech, Twilio, Release A**. Aqueles docs (jul–ago 2026) tratam invariantes de dinheiro e estado.

Esta leitura (set 2026) completa o outro eixo que estava implícito: **superfície pública, SEO, design, cada CTA do book, configs de conteúdo/hub, e o mapa clicável customer vs admin**.

Onde os dois eixos se encontram: o book promete um pacote/preço; o Blob + portais precisam mostrar a mesma coisa depois. Qualquer rename de pacote, qualquer CTA que não pré-seleciona, qualquer catálogo secundário no Garage, aumenta a chance de o “book” e o “job” divergirem.

---

## 12. Limites desta leitura

- Nenhum browse em `cardetail1.com` produção.
- Nenhum clique em Admin/Technician autenticado.
- Nenhum Stripe/Twilio live.
- Não foi reexecutada a suíte `npm test` (não havia mudança de produto para validar).
- Findings de paridade monetária de jul/2026 foram **cruzados com a forma atual do código** (Blobs ainda autoridade, Owner Studio ainda legado, money mutations ainda múltiplas), não re-testados caso a caso.

Quando houver permissão para alterar, o ponto de partida mais seguro no book é a lista P0 da §9 — CTAs, nomes de pacote, resume, e o ZIP gate — porque são confusões que o cliente encontra **antes** de qualquer job existir no admin.
