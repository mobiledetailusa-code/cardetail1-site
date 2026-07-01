# Stripe Subscription Price IDs — Cardetail1

Referência para criar **Products + recurring Prices** no Stripe Dashboard e mapear para variáveis Netlify.

**Fonte de verdade dos valores:** `netlify/lib/customer-catalog.js` + `netlify/lib/subscription-checkout.js`  
**Desconto assinante:** 10% sobre preço walk-in · **Fleet 2:** +8% off · **Fleet 3+:** +12% off

> Se uma variável `STRIPE_PRICE_SUB_*` **não** existir no Netlify, o checkout usa preço dinâmico (`price_data`) com o mesmo valor — o sistema continua funcionando.

---

## Passo a passo no Stripe Dashboard

1. **Stripe Dashboard** → **Product catalog** → **Add product**
2. Para cada linha da tabela abaixo:
   - **Name:** coluna *Stripe product name*
   - **Description:** `Monthly maintenance subscription — max 1 detail/month. 10% subscriber discount.`
   - **Pricing:** **Recurring** · **Monthly** · **USD** · valor da coluna *Amount*
3. Após salvar, copie o **Price ID** (`price_…`) → Netlify **Environment variables**
4. Nome da variável = coluna *Netlify env var* (exatamente como escrito)
5. **Redeploy** o site Netlify após adicionar/alterar variáveis

### Validação automática
Ao checkout, se o Price ID estiver configurado, o servidor compara `unit_amount` no Stripe com o catálogo. Mismatch → erro `stripe_price_mismatch` (checkout bloqueado até corrigir).

---

## 1 vehicle (single)

| Netlify env var | Stripe product name | Amount (USD/mo) | unit_amount (cents) |
|---|---|---:|---:|
| `STRIPE_PRICE_SUB_MAINT` | Cardetail1 Maintenance Detail · Monthly | $157.50 | 15750 |
| `STRIPE_PRICE_SUB_INTERIOR` | Cardetail1 Interior Detail · Monthly | $202.50 | 20250 |
| `STRIPE_PRICE_SUB_FULL` | Cardetail1 Premium Detail · Monthly | $270.00 | 27000 |
| `STRIPE_PRICE_SUB_REFRESH` | Cardetail1 Exterior Refresh & Protect · Monthly | $337.50 | 33750 |
| `STRIPE_PRICE_SUB_PREMIUM` | Cardetail1 Signature Restoration · Monthly | $405.00 | 40500 |

---

## 2-Vehicle Fleet (same address)

| Netlify env var | Stripe product name | Amount (USD/mo) | unit_amount (cents) |
|---|---|---:|---:|
| `STRIPE_PRICE_SUB_FLEET_2_MAINT` | Cardetail1 2-Vehicle Fleet · Maintenance · Monthly | $289.80 | 28980 |
| `STRIPE_PRICE_SUB_FLEET_2_INTERIOR` | Cardetail1 2-Vehicle Fleet · Interior · Monthly | $372.60 | 37260 |
| `STRIPE_PRICE_SUB_FLEET_2_FULL` | Cardetail1 2-Vehicle Fleet · Premium · Monthly | $496.80 | 49680 |
| `STRIPE_PRICE_SUB_FLEET_2_REFRESH` | Cardetail1 2-Vehicle Fleet · Exterior Refresh · Monthly | $621.00 | 62100 |
| `STRIPE_PRICE_SUB_FLEET_2_PREMIUM` | Cardetail1 2-Vehicle Fleet · Signature · Monthly | $745.20 | 74520 |

---

## 3+ Vehicle Fleet (same address)

| Netlify env var | Stripe product name | Amount (USD/mo) | unit_amount (cents) |
|---|---|---:|---:|
| `STRIPE_PRICE_SUB_FLEET_3_MAINT` | Cardetail1 3+ Vehicle Fleet · Maintenance · Monthly | $415.80 | 41580 |
| `STRIPE_PRICE_SUB_FLEET_3_INTERIOR` | Cardetail1 3+ Vehicle Fleet · Interior · Monthly | $534.60 | 53460 |
| `STRIPE_PRICE_SUB_FLEET_3_FULL` | Cardetail1 3+ Vehicle Fleet · Premium · Monthly | $712.80 | 71280 |
| `STRIPE_PRICE_SUB_FLEET_3_REFRESH` | Cardetail1 3+ Vehicle Fleet · Exterior Refresh · Monthly | $891.00 | 89100 |
| `STRIPE_PRICE_SUB_FLEET_3_PREMIUM` | Cardetail1 3+ Vehicle Fleet · Signature · Monthly | $1069.20 | 106920 |

---

## Checklist Netlify (copiar/colar)

Após criar no Stripe, preencha no painel **Site settings → Environment variables**:

```
STRIPE_PRICE_SUB_MAINT=price_...
STRIPE_PRICE_SUB_INTERIOR=price_...
STRIPE_PRICE_SUB_FULL=price_...
STRIPE_PRICE_SUB_REFRESH=price_...
STRIPE_PRICE_SUB_PREMIUM=price_...
STRIPE_PRICE_SUB_FLEET_2_MAINT=price_...
STRIPE_PRICE_SUB_FLEET_2_INTERIOR=price_...
STRIPE_PRICE_SUB_FLEET_2_FULL=price_...
STRIPE_PRICE_SUB_FLEET_2_REFRESH=price_...
STRIPE_PRICE_SUB_FLEET_2_PREMIUM=price_...
STRIPE_PRICE_SUB_FLEET_3_MAINT=price_...
STRIPE_PRICE_SUB_FLEET_3_INTERIOR=price_...
STRIPE_PRICE_SUB_FLEET_3_FULL=price_...
STRIPE_PRICE_SUB_FLEET_3_REFRESH=price_...
STRIPE_PRICE_SUB_FLEET_3_PREMIUM=price_...
```

**Mínimo para começar:** configure só `STRIPE_PRICE_SUB_MAINT` (plano mais comum). Os demais podem ficar em modo dinâmico até você criar no Stripe.

---

## Webhook (obrigatório para assinatura aparecer no portal)

**URL:** `https://cardetail1.com/.netlify/functions/stripe-webhook`

Eventos necessários para assinaturas:

- `checkout.session.completed`
- `customer.subscription.deleted`

(+ card-on-file: `setup_intent.succeeded`, `setup_intent.setup_failed`)

**Netlify:** `STRIPE_WEBHOOK_SECRET=whsec_...`

---

## Verificação pós-configuração

1. `customer.html` → booking lookup → **Subscribe via Stripe** (Maintenance)
2. Resposta da API inclui `"stripePriceMode":"env_price_id"` (se Price ID configurado) ou `"dynamic_price_data"` (se não)
3. Após pagamento teste: Stripe → **Subscriptions** → ativa
4. Stripe → **Webhooks** → `checkout.session.completed` → **200**
5. `customer.html` → banner **✓ Active: Maintenance Detail**
6. `admin-ops.html` → tab **Subscriptions** → registro visível

---

## Test vs Live

- Crie Products/Prices separados em **Test mode** e **Live mode** no Stripe.
- Use `sk_test_` / `pk_test_` + Price IDs de teste no ambiente local (`.env` + `netlify dev`).
- Use `sk_live_` / `pk_live_` + Price IDs live no Netlify production.
