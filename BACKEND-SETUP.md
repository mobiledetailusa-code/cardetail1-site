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

No arquivo `cardetail1-mobile-detailing-pro-v6-images-checkout.html`, no bloco CONFIG (topo do `<script>`):

```js
const BACKEND_URL   = '/.netlify/functions/submit-booking';  // ← liga o envio real
const SQUARE_APP_ID = 'sandbox-sq0idb-...';   // Application ID (público, pode ficar no HTML)
const SQUARE_LOC_ID = 'L...';                 // Location ID (público)
```

> Importante: `SQUARE_APP_ID` e `SQUARE_LOC_ID` são **públicos** por design (Web Payments SDK) — ok ficarem no HTML. O `SQUARE_ACCESS_TOKEN` é **secreto** e fica SÓ na Netlify (variável de ambiente), nunca no HTML.

Com `BACKEND_URL` apontando para `/.netlify/...` (mesma origem), o site faz um fetch **real** e mostra confirmação de verdade — diferente do webhook externo, que é "cego" (`no-cors`).

## 4. Testar

1. Abra o site publicado, faça um booking de teste.
2. Confira o e-mail em `ADMIN_EMAIL`.
3. Logs das funções: Netlify → *Logs* → *Functions* → `submit-booking`.

## ⚠️ Segurança — antes de produção
- `squarespace_backup_codes_*.txt` está no repositório. **Remova do Git** (`git rm --cached`) e guarde offline.
- As credenciais demo dos portais (`admin@cardetail1.com` / `cd1admin2026`, `tech@cardetail1.com` / `tech2026`) são client-side. Para produção real, mover auth para backend (Netlify Identity ou similar).
