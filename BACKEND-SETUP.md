# Cardetail1 — Backend Setup (Netlify + Square)

Backend **additivo e sem dependências npm**. As funções usam só o `fetch` nativo do Node 18 da Netlify, então o deploy não precisa de `npm install` nem `node_modules`.

## 1. Subir o site na Netlify

**Opção rápida (sem Git):** entre em https://app.netlify.com/drop e arraste a pasta do projeto inteira. Pronto — site no ar com um endereço `*.netlify.app`.

**Opção Git:** no painel da Netlify → *Add new site* → *Import from Git* → conecte este repositório. O `netlify.toml` já configura tudo (publish na raiz, functions em `netlify/functions`, URLs limpas `/customer`, `/technician`, `/admin`).

## 2. Variáveis de ambiente

No painel: **Site settings → Environment variables**. Nenhuma fica no código público.

### E-mail dos bookings (Resend — grátis até 3k/mês)
| Variável | Valor |
|---|---|
| `ADMIN_EMAIL` | o e-mail que recebe os bookings (você vai me passar) |
| `RESEND_API_KEY` | crie em https://resend.com → API Keys |
| `RESEND_FROM` | `Cardetail1 <bookings@seudominio.com>` (domínio verificado no Resend) — ou deixe sem para usar `onboarding@resend.dev` em testes |

### SMS de aviso (Twilio — opcional)
| Variável | Valor |
|---|---|
| `TWILIO_SID` / `TWILIO_TOKEN` | console.twilio.com |
| `TWILIO_FROM` | seu número Twilio, ex: `+1XXXXXXXXXX` |
| `ADMIN_SMS` | número que recebe o aviso, ex: `+1XXXXXXXXXX` |

### Pagamento (Square)
| Variável | Valor |
|---|---|
| `SQUARE_ACCESS_TOKEN` | https://developer.squareup.com/apps → seu app → Credentials |
| `SQUARE_LOCATION_ID` | mesmo painel → Locations |
| `SQUARE_ENV` | `sandbox` para testar, `production` para valer |

## 3. Ligar o front-end ao backend

No arquivo `index.html`, no bloco CONFIG (topo do `<script>`):

```js
const BACKEND_URL   = '/.netlify/functions/submit-booking';  // ← liga o envio real
const SQUARE_APP_ID = 'sandbox-sq0idb-...';   // Application ID (público, pode ficar no HTML)
const SQUARE_LOC_ID = 'L...';                 // Location ID (público)
```

> Importante: `SQUARE_APP_ID` e `SQUARE_LOC_ID` são **públicos** por design (Web Payments SDK) — ok ficarem no HTML. O `SQUARE_ACCESS_TOKEN` é **secreto** e fica SÓ na Netlify (variável de ambiente), nunca no HTML.

Com `BACKEND_URL` apontando para `/.netlify/...` (mesma origem), o site faz um fetch **real** e mostra confirmação de verdade — diferente do webhook externo, que é "cego" (`no-cors`).

## 3b. (Opção) Pagamento via Stripe — também no Netlify

Funções **aditivas**, sem dependências npm: `create-payment-intent.js` e `stripe-webhook.js`.

### Variáveis de ambiente (Netlify)
| Variável | Onde fica | Valor |
|---|---|---|
| `STRIPE_SECRET_KEY` | **só servidor** | `sk_test_…` (testes) → `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | **só servidor** | `whsec_…` (gerado ao criar o webhook) |
| Publishable key | **pode no HTML** | `pk_test_…` / `pk_live_…` |

### Registrar o webhook
Stripe → *Developers → Webhooks → Add endpoint*:
- **URL:** `https://SEU-SITE.netlify.app/.netlify/functions/stripe-webhook`
- **Eventos:** `payment_intent.succeeded`, `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`
- Copie o *Signing secret* (`whsec_…`) → variável `STRIPE_WEBHOOK_SECRET`.

### Modelo de cobrança (preço por pé variável de barco/RV)
`create-payment-intent` usa `capture_method: 'manual'` por padrão → **autoriza** (segura) o valor no cartão; depois do serviço você **captura o valor final** no painel do Stripe. Para cobrar na hora, mande `capture: 'auto'` no body.

### Ligar no front-end (step 6 — substitui o Square)
> ⚠️ Ainda **não** trocado no HTML. Quando confirmar, o step de cartão passa do `sqCard` (Square) para o Stripe Payment Element:
```js
const stripe = Stripe('pk_live_…');                         // chave pública
const r = await fetch('/.netlify/functions/create-payment-intent', {
  method:'POST', body: JSON.stringify({ amountCents: total*100, bookingId: b.id, email: b.email })
});
const { clientSecret } = await r.json();
const elements = stripe.elements({ clientSecret });
elements.create('payment').mount('#card-container');
// no submit: await stripe.confirmPayment({ elements, confirmParams:{ return_url } })
```

## 3c. Chat com IA + dúvidas do cliente (NOVO)

Duas funções, sem deps npm: `ai-chat.js` (assistente) e `submit-inquiry.js` (handoff).

**O chat já funciona SEM configurar nada** — sem chave de IA, ele usa um assistente local (base de conhecimento com os dados reais do site: preços, áreas NJ·NY·CT·PA, pacotes, add-ons, booking, pagamento, horários). Configure abaixo só para ativar a **IA de verdade** e o **envio das dúvidas** por e-mail/SMS.

### Variáveis de ambiente (Netlify)
| Variável | Para quê | Valor |
|---|---|---|
| `ANTHROPIC_API_KEY` | liga a IA real (Claude) | `sk-ant-...` em https://console.anthropic.com → API Keys. Sem ela, cai no assistente local automaticamente. |
| `CHAT_MODEL` | (opcional) modelo | padrão `claude-haiku-4-5` (rápido/barato p/ FAQ público). Use `claude-opus-4-8` p/ respostas mais ricas. |

As **dúvidas** (botão "Talk to a human") já são salvas localmente e aparecem em **Admin → 💬 Inquiries**. Para também **receber por e-mail/SMS**, `submit-inquiry.js` reaproveita as MESMAS variáveis do booking: `ADMIN_EMAIL`, `RESEND_API_KEY`, `RESEND_FROM`, `TWILIO_*`, `ADMIN_SMS` (seção 2).

### Testar
1. No site, abra o chat (botão 💬 no canto) e pergunte "How much does a car detail cost?".
2. Sem `ANTHROPIC_API_KEY` → resposta do assistente local. Com a chave → resposta da IA.
3. Clique "Talk to a human", preencha e envie → aparece em Admin → Inquiries (e chega no seu e-mail/SMS se Resend/Twilio estiverem configurados).
4. Logs: Netlify → *Logs → Functions → ai-chat* / *submit-inquiry*.

## 3d. Painel Admin central (Netlify Blobs) — tira o "demo" (NOVO)

Antes, o admin só via os agendamentos feitos **no mesmo navegador**. Agora **todo** booking é salvo na nuvem (Netlify Blobs) e o admin puxa todos com **☁️ Load from cloud**.

- **Não precisa de conta externa.** O `package.json` declara `@netlify/blobs`; a Netlify instala no build automaticamente. O `submit-booking.js` grava cada booking; o `list-bookings.js` lista (protegido por senha).
- **Variável de ambiente (Netlify):** `ADMIN_DASH_PASSWORD` = **a mesma senha do seu login de admin**. Sem ela, o "Load from cloud" responde "não configurado".
- **Senha do admin:** agora é **uma só**, no topo do `<script>` do `index.html` — constante `ADMIN_PASSWORD` (troque pela sua). O portal de login mostra só **Admin** (senha) e **Cliente** (consulta sem senha); as senhas **não** aparecem mais na tela.

### Opções de pagamento no checkout
No fim do agendamento o cliente escolhe: **depósito no cartão agora** (Stripe), **link de pagamento**, **pagar com cartão no local** ou **dinheiro (cash)**. As duas últimas não exigem cartão e seguem como *request* até sua confirmação. O método aparece no admin e no e-mail/SMS.

## 4. Testar

1. Abra o site publicado, faça um booking de teste.
2. Confira o e-mail em `ADMIN_EMAIL`.
3. Logs das funções: Netlify → *Logs* → *Functions* → `submit-booking` (ou `stripe-webhook`).
4. Stripe em modo teste: use o cartão `4242 4242 4242 4242`, qualquer data futura e CVC.

## 4b. Desenvolvimento local (card save / Netlify Functions)

**Salvar cartão no checkout não funciona com um servidor estático simples** (Python `http.server`, Live Server, `serve.ps1`, etc.). Esses servidores só entregam HTML/CSS/JS — não executam `/.netlify/functions/*` (`stripe-config`, `submit-booking`, `create-setup-intent`).

### Card save local (recomendado)

1. Instale a CLI: `npm i -g netlify-cli` (ou use `npx netlify dev`).
2. Copie `.env.example` → `.env` na raiz do projeto.
3. Preencha **par de chaves de teste do mesmo account Stripe**:
   - `STRIPE_PUBLISHABLE_KEY=pk_test_...`
   - `STRIPE_SECRET_KEY=sk_test_...`
4. Na pasta do projeto: `npx netlify dev`
5. Abra **http://localhost:8888** (porta padrão no `netlify.toml`).
6. No step 5 do booking, use cartão `4242 4242 4242 4242`.

O front-end em `127.0.0.1` / `localhost` usa fallback `pk_test_...` embutido só se a função `stripe-config` não responder; com `netlify dev` a função devolve a chave do `.env` (preferível — garante par pk/sk do mesmo account).

### Preview estático (sem card save)

Se você só precisa ver layout/copy, pode usar qualquer servidor estático. Ao tentar salvar cartão, a UI mostra instruções para rodar `netlify dev` em vez da mensagem genérica “temporarily unavailable”.

### Verificar funções

```bash
curl http://localhost:8888/.netlify/functions/stripe-config
# esperado: {"ok":true,"publishableKey":"pk_test_...","mode":"test"}
```

## ⚠️ Segurança — antes de produção
- `squarespace_backup_codes_*.txt` está no repositório. **Remova do Git** (`git rm --cached`) e guarde offline.
- As credenciais demo dos portais (`admin@cardetail1.com` / `cd1admin2026`, `tech@cardetail1.com` / `tech2026`) são client-side. Para produção real, mover auth para backend (Netlify Identity ou similar).
