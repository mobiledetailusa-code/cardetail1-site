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

## 4. Testar

1. Abra o site publicado, faça um booking de teste.
2. Confira o e-mail em `ADMIN_EMAIL`.
3. Logs das funções: Netlify → *Logs* → *Functions* → `submit-booking` (ou `stripe-webhook`).
4. Stripe em modo teste: use o cartão `4242 4242 4242 4242`, qualquer data futura e CVC.

## ⚠️ Segurança — antes de produção
- `squarespace_backup_codes_*.txt` está no repositório. **Remova do Git** (`git rm --cached`) e guarde offline.
- As credenciais demo dos portais (`admin@cardetail1.com` / `cd1admin2026`, `tech@cardetail1.com` / `tech2026`) são client-side. Para produção real, mover auth para backend (Netlify Identity ou similar).
