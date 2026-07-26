# Auditoria — Portal do Cliente não comunica com o Admin

**Data:** 2026-07-26
**Branch:** `claude/customer-admin-communication-audit-muuvjf`
**Sintoma relatado (produção):** após alguns *book tests*, o Admin **não recebeu nenhuma
solicitação de agendamento (appointment)**. Os únicos e-mails que chegaram foram sobre
**cartão salvo (Stripe / card-on-file)** — nunca sobre o *agendamento feito*.

---

## 1. Resumo executivo (em linguagem simples)

O agendamento no site tem **duas fases**:

1. **Salvar o cartão** (SetupIntent do Stripe — "No charge today").
2. **Enviar o pedido** (o botão final **"Submit Booking Request ✓"** no passo *Review & Submit*).

O Admin **só vê o agendamento depois da FASE 2** (finalização). Antes disso, o registro é
apenas um **rascunho (draft) invisível** — de propósito, para não mostrar carrinhos
incompletos no painel.

O sintoma observado — **e-mail de cartão salvo sim, agendamento não** — significa que os
*book tests* **pararam na Fase 1**: o cartão foi salvo, mas a **finalização (Fase 2) não foi
concluída**. Por isso:

- o painel do Admin fica **vazio** (o rascunho não é "booking visível");
- **não** chega o e-mail *"New Cardetail1 Booking…"* (só é enviado na finalização);
- **não** chega o e-mail do cliente *"We received your detailing request"* (idem);
- o **único** e-mail relacionado é o de **cartão salvo**, que é disparado na Fase 1
  (pelo webhook `setup_intent.succeeded` **ou** pelo próprio Stripe).

> **Conclusão central:** não é o Admin que "não recebe" — é a **finalização do agendamento
> que não está sendo concluída**, deixando o pedido preso como rascunho invisível.
> Isso é, ao mesmo tempo, um problema de **configuração de produção** (mais provável) e uma
> **fragilidade de arquitetura** (perda silenciosa de rascunhos com cartão salvo).

---

## 2. Como o fluxo realmente funciona (arquitetura)

```
Cliente (index.html — modal de booking)
  │
  │ Passo 5 "Lock Your Slot"
  ├─(1) POST /submit-booking  {isDraft:true}
  │        → grava rascunho em Blobs "cd1-bookings"
  │          (isDraft:true, cardOnFileStatus:"pending")
  │        → devolve draftSaveToken (validade 2h)
  │
  ├─(2) POST /create-setup-intent {bookingId, draftSaveToken}
  │        → cria Stripe Customer + SetupIntent (usage off_session)
  │        → grava setupIntentId no rascunho
  │        → devolve clientSecret
  │
  ├─(3) stripe.confirmSetup(...)  [no navegador]
  │        → cartão salvo no Stripe (nenhuma cobrança)
  │        → Stripe dispara webhook setup_intent.succeeded
  │
  │   [webhook]  POST /stripe-webhook  (setup_intent.succeeded)
  │        → cardOnFileStatus:"saved" no rascunho
  │        → e-mail ao Admin: "card on file saved · <id>"   ◀── e-mail de CARTÃO
  │
  │ Passo 6 "Review & Submit"  ← precisa clicar aqui!
  └─(4) POST /submit-booking {draftBookingId, draftSaveToken}   ◀── FINALIZAÇÃO
           → exige cardOnFileStatus==="saved" (reconcilia do Stripe se o webhook atrasar)
           → valida preferência de pagamento, termos, data/hora, e conflito de horário
           → status:"Pending Review", bookingVersion:1, finalizedAt, portalReleasedAt
           → AGORA vira "booking visível" (isVisibleSubmittedBooking)
           → e-mail ao Admin: "New Cardetail1 Booking <id>"    ◀── e-mail de AGENDAMENTO
           → e-mail ao cliente: "We received your detailing request"

Admin (admin-ops.html)
  └─ GET /admin-ops-jobs  → listJobs()
        → filtra por isVisibleSubmittedBooking  →  RASCUNHOS SÃO EXCLUÍDOS
```

Arquivos-chave:
- `netlify/functions/submit-booking.js` — cria o rascunho **e** finaliza (Fase 1 e Fase 2).
- `netlify/functions/create-setup-intent.js` — cria o SetupIntent, grava `setupIntentId`.
- `netlify/functions/stripe-webhook.js` — `setup_intent.succeeded` → `cardOnFileStatus:"saved"` + e-mail de cartão.
- `netlify/lib/card-on-file.js` — `reconcileCardOnFileFromStripe()` (fallback quando o webhook atrasa).
- `netlify/lib/booking-visibility.js` — `isVisibleSubmittedBooking()` (rascunho = invisível).
- `netlify/functions/admin-ops-jobs.js` (`listJobs`) e `netlify/functions/list-bookings.js` — leitura do Admin.
- `index.html` — `initCardOnFile()`, `confirmSetupIntent()`, `goToConfirmFromTerms()`, `submitBooking()`.

---

## 3. Ponto exato da falha

O e-mail do Admin *"New Cardetail1 Booking…"* (`sendEmail` em `submit-booking.js`) e o e-mail
do cliente *"We received your detailing request"* (`emitRequestReceived`) **só existem dentro
da finalização (Fase 2)**. Ambos usam a **mesma** configuração do Resend que o e-mail de
"cartão salvo" — portanto **não é falta de Resend/ADMIN_EMAIL** (senão o e-mail de cartão
também não chegaria).

Logo, **a finalização não rodou até o fim**. O painel vazio confirma: sem finalização, o
registro continua rascunho e é filtrado por `isVisibleSubmittedBooking`.

---

## 4. Causas-raiz (ordenadas por probabilidade)

### C1 — A finalização (Fase 2) não é concluída  ⟵ causa direta do sintoma
O rascunho fica preso e invisível. Sub-causas possíveis:

- **C1a (comportamental/UX):** o testador **salvou o cartão** e parou. Depois de salvar, o
  botão vira **"✓ Card saved"** — é fácil achar que o agendamento acabou. Mas ainda é
  preciso avançar para o passo **6 (Review & Submit)** e clicar **"Submit Booking Request ✓"**.
- **C1b (portão card-on-file):** a finalização exige `cardOnFileStatus==="saved"`. Se o
  webhook não marcou "saved" **e** a reconciliação com o Stripe (`reconcileCardOnFileFromStripe`)
  não confirmou, a finalização é rejeitada com **409 `card_on_file_not_saved`** e o cliente vê
  *"Your card is still being verified…"*. Fatores que contribuem: webhook Stripe ausente
  (ver C2) combinado com `setupIntentId` não persistido, ou SetupIntent ainda em processamento.
- **C1c (outros portões):** token de rascunho expirado (>2h), preferência de pagamento
  divergente, termos não aceitos, ou **conflito de horário** (`booking_slot_unavailable`, 409)
  — provável em *book tests* que reusam a mesma data/horário.

### C2 — Webhook do Stripe mal configurado  ⟵ amplifica C1b e explica o e-mail "pelo Stripe"
Se o endpoint `…/.netlify/functions/stripe-webhook` **não** existe, está desativado, **não**
inclui o evento **`setup_intent.succeeded`**, ou o **`STRIPE_WEBHOOK_SECRET`** não bate com o
*signing secret* do Stripe, então:

- o app **nunca** marca `cardOnFileStatus:"saved"` pelo webhook (fica dependendo 100% da
  reconciliação no momento da finalização);
- o app **nunca** envia o e-mail *"card on file saved · <id>"*;
- o cliente recebe apenas o **e-mail nativo do Stripe** sobre o cartão salvo — que é
  exatamente o "veio pelo stripe de cartão salvo" relatado.

### C3 — Arquitetura de perda silenciosa  ⟵ o defeito estrutural por trás do relato
Mesmo com tudo configurado, **um rascunho com cartão salvo que não finaliza fica invisível
para o Admin — sem lead, sem alerta, sem recuperação.** O cliente se engajou (salvou cartão),
mas o negócio nunca fica sabendo. É literalmente "o portal do cliente não se comunica com o
Admin" para esses casos.

### O que foi *descartado* na análise (com evidência)
- **Resend/ADMIN_EMAIL ausente:** descartado — o e-mail de cartão usa a mesma config.
- **Inconsistência de Blobs (write num store, read noutro):** descartado — o
  `create-setup-intent` **lê com sucesso** o rascunho gravado pelo `submit-booking`, provando
  que ambos apontam para o mesmo store. (Obs.: já houve incidente de *PAT inválido* — ver C-checklist.)
- **Guard de modo Stripe bloqueando produção:** descartado — o cartão **foi salvo**, então a
  chave e o contexto de produção permitem chamadas ao Stripe (a reconciliação usa o mesmo guard).
- **Bookings marcados como `isTest` e filtrados:** descartado — `isTest` só é setado por ação
  explícita do Admin (arquivar/tag), nunca automaticamente numa submissão nova.

---

## 5. Checklist de verificação e correção em produção

> Faça **1 book test completo** e siga os passos abaixo em paralelo. Eles isolam a causa em minutos.

### A. Webhook do Stripe (Dashboard → Developers → Webhooks)
1. Existe o endpoint `https://cardetail1.com/.netlify/functions/stripe-webhook` **habilitado**?
2. A lista de eventos inclui **`setup_intent.succeeded`** e `setup_intent.setup_failed`,
   `checkout.session.completed`, `customer.subscription.deleted` (e os `payment_intent.*` legados)?
3. O *Signing secret* (`whsec_…`) é **idêntico** ao `STRIPE_WEBHOOK_SECRET` no Netlify?
4. Em **Recent deliveries**, procure `setup_intent.succeeded`:
   - **200 OK** → webhook ok; a causa está em C1 (finalização).
   - **400 "Invalid signature"** → segredo errado → corrija `STRIPE_WEBHOOK_SECRET` e **redeploy**.
   - **Evento ausente** → adicione `setup_intent.succeeded` ao endpoint.

### B. Variáveis de ambiente no Netlify (Site settings → Environment variables) — **redeploy após mudar**
- `STRIPE_SECRET_KEY` (`sk_live_…` em produção), `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`.
- `RESEND_API_KEY`, `ADMIN_EMAIL`, `RESEND_FROM` (domínio verificado).
- `DRAFT_TOKEN_SECRET` (32+ caracteres) — **obrigatória em produção**; sem ela, `submit-booking`
  e `create-setup-intent` retornam **503** e o fluxo nem começa.
- `ADMIN_DASH_PASSWORD`, `ADMIN_SESSION_SECRET` (32+).
- `NETLIFY_SITE_ID` / `NETLIFY_AUTH_TOKEN`: **se estiverem setadas, o token precisa ser válido.**
  Um PAT inválido já *estrangulou* leituras/escritas de Blobs neste site (commit
  `fix(booking): recover draft registration when Blobs PAT is invalid`). Recomendação: se o site
  usa Blobs por contexto de runtime, **deixe estas duas desmarcadas** para todas as funções
  usarem o mesmo contexto. Se mantê-las, **rotacione e valide o token**.

### C. Logs das funções (Netlify → Logs → Functions) — para o mesmo book test
- **`submit-booking`**: procure `finalize ok` (sucesso) vs.
  `finalize rejected card_on_file_not_saved`, `finalize draft_token_invalid`,
  `booking_slot_unavailable`. **Esta é a evidência decisiva** de qual portão falhou.
- **`create-setup-intent`**: `SetupIntent created` e `draft updated … setupIntentIdPrefix`.
- **`stripe-webhook`**: `setup_intent.succeeded` e `updateBookingPayment result: … "updated":true`.
- **`booking-card-status`**: tentativas de `reconcile`.

### D. Reproduza o fluxo COMPLETO
Salvar o cartão **não** é o passo final. Avance ao passo **6 (Review & Submit)**, marque os
**Termos**, e clique **"Submit Booking Request ✓"**. Confirme se aparece a tela verde
*"BOOKING REQUEST RECEIVED"*. Só então o Admin recebe o agendamento e o e-mail.

---

## 6. Correções de código

### Aplicada nesta auditoria (segura, baixo risco)
- **`index.html` — `waitForVerifiedCardSave`:** removida a referência a `draftSessionToken`,
  que estava **fora de escopo** (declarada dentro de `initCardOnFile`). Quando `ST.draftSaveToken`
  estivesse vazio (ex.: após limpar o estado do rascunho), essa referência lançava
  `ReferenceError`, quebrando a verificação do cartão no caminho de finalização. Agora usa o
  valor canônico `ST.draftSaveToken`. (Testes `booking-flow.test.js` seguem 15/15 verdes,
  incluindo *"inline browser scripts compile"*.)

### Recomendadas (follow-up — não aplicadas para respeitar o controle de mudanças do repo)
1. **Visibilidade de "agendamentos incompletos" no Admin** *(maior valor)*: uma lista, protegida
   por login do Admin, dos rascunhos com **cartão salvo / SetupIntent** que **não** finalizaram —
   com nome, telefone, e-mail, veículo, pacote, data preferida e `cardOnFileStatus`. Assim **nenhum
   interesse de cliente é perdido em silêncio**, independentemente da causa (abandono, erro de
   finalização, webhook). Resolve diretamente "o portal não se comunica com o Admin".
2. **UX do passo 5:** deixar explícito que **o agendamento ainda NÃO foi enviado** após salvar o
   cartão (ex.: rótulo do botão "✓ Cartão salvo — falta enviar o pedido" e destaque no
   "Review & Submit →").
3. **`create-setup-intent`:** repetir/validar a persistência do `setupIntentId` (hoje é
   *best-effort* com `catch → warn`); se não persistir, a reconciliação na finalização fica cega
   quando o webhook está ausente.

---

## 7. O que muda para o dono, na prática

- **Provável correção imediata (produção):** garantir o webhook `setup_intent.succeeded` +
  `STRIPE_WEBHOOK_SECRET` corretos, e **sempre concluir o passo 6** no teste. Os logs de
  `submit-booking` dizem em segundos qual portão está barrando.
- **Correção estrutural (código, follow-up):** a lista de "incompletos" no Admin acaba com a
  perda silenciosa — o dono passa a **ver todo cliente que salvou cartão**, mesmo sem finalizar.

> Posso implementar a lista de "agendamentos incompletos" no painel e/ou investigar os logs de
> produção junto com você — é só pedir.
